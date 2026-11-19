//! Shared local lifecycle and bounded reply draining for existing scan kinds.

use super::*;
use scan::{ContinuationControl, ContinuationSlot, RetainedBatch};
use std::{collections::VecDeque, sync::Mutex};

pub(super) struct Buffer<T> {
    pub(super) slot: Option<ContinuationSlot>,
    pub(super) pending: VecDeque<T>,
    pub(super) retained: Option<RetainedBatch>,
    pub(super) failure: Option<&'static str>,
    pub(super) sequence: u64,
}

impl<T> Buffer<T> {
    pub(super) fn new(slot: ContinuationSlot) -> Self {
        Self {
            slot: Some(slot),
            pending: VecDeque::new(),
            retained: None,
            failure: None,
            sequence: 0,
        }
    }

    fn fail(&mut self, code: &'static str) {
        self.failure.get_or_insert(code);
        self.pending.clear();
        self.retained.take();
        self.slot.take();
    }

    pub(super) fn drain(&mut self, budget: usize, size: impl Fn(&T) -> usize) -> Vec<T> {
        let mut items = Vec::new();
        let mut bytes = 0;
        while let Some(item) = self.pending.front() {
            let size = size(item);
            if items.len() == 200 || bytes + size > budget {
                break;
            }
            bytes += size;
            items.push(self.pending.pop_front().unwrap());
        }
        self.sequence += 1;
        if self.pending.is_empty() {
            self.retained.take();
        }
        items
    }
}

pub(super) trait Progress: Send {
    type Item: Send;
    fn buffer(&mut self) -> &mut Buffer<Self::Item>;
    /// Drop command-specific input/topology resources on completion or failure.
    fn release(&mut self);
}

pub(super) struct State<P: Progress> {
    pub(super) session: Arc<SessionState>,
    pub(super) database: u32,
    pub(super) generation: u64,
    pub(super) progress: Mutex<P>,
    busy: AtomicBool,
    cancel: watch::Sender<bool>,
    kind: &'static str,
}

pub(super) struct NextPage<P: Progress> {
    pub(super) state: Arc<State<P>>,
    _admission: Arc<PageAdmission<P>>,
}

impl<P: Progress> Clone for NextPage<P> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            _admission: self._admission.clone(),
        }
    }
}

struct PageAdmission<P: Progress>(Arc<State<P>>);
impl<P: Progress> Drop for PageAdmission<P> {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

impl<P: Progress + 'static> State<P> {
    /// The caller holds Session admission while validating and copying its input.
    pub(super) fn new(
        session: Arc<SessionState>,
        kind: &'static str,
        progress: impl FnOnce(u64, ContinuationSlot) -> P,
    ) -> Result<Arc<Self>, JsError> {
        let database = session.database();
        let generation = session.generation.load(Ordering::Acquire);
        let slot = session.continuations.acquire()?;
        let (cancel, _) = watch::channel(false);
        let state = Arc::new(Self {
            database,
            generation,
            progress: Mutex::new(progress(generation, slot)),
            session,
            busy: AtomicBool::new(false),
            cancel,
            kind,
        });
        state.session.continuations.register(state.clone());
        state.validate()?;
        Ok(state)
    }

    pub(super) fn next_page(self: &Arc<Self>) -> Result<NextPage<P>, JsError> {
        self.validate()?;
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(error(
                "BUSY",
                &format!(
                    "A page request is already pending for this {} scan",
                    self.kind
                ),
            ));
        }
        Ok(NextPage {
            state: self.clone(),
            _admission: Arc::new(PageAdmission(self.clone())),
        })
    }

    pub(super) fn fail(&self, code: &'static str) {
        let mut progress = self.progress.lock().unwrap();
        progress.buffer().fail(code);
        progress.release();
        drop(progress);
        self.cancel.send_replace(true);
    }

    pub(super) fn validate(&self) -> Result<(), JsError> {
        if self.session.closed.load(Ordering::Acquire) {
            return Err(closed());
        }
        if self.session.generation.load(Ordering::Acquire) != self.generation {
            self.fail("CURSOR_INVALIDATED");
        }
        if let Some(code) = self.progress.lock().unwrap().buffer().failure {
            return Err(error(
                code,
                &format!("Redis {} scan is no longer active", self.kind),
            ));
        }
        Ok(())
    }
}

impl<P: Progress + 'static> ContinuationControl for State<P> {
    fn invalidate(&self) {
        self.fail("CURSOR_INVALIDATED");
    }
    fn active(&self) -> bool {
        self.progress.lock().unwrap().buffer().slot.is_some()
    }
    fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancel.subscribe()
    }
    fn validate(&self) -> Result<(), JsError> {
        State::validate(self)
    }
}

/// Hash and Set retain the same one-cursor observation and source metadata.
pub(super) struct CollectionProgress<T> {
    pub(super) buffer: Buffer<T>,
    pub(super) key: Option<Vec<u8>>,
    pub(super) cursor: u64,
    pub(super) started: bool,
    pub(super) exists: bool,
    pub(super) length: u64,
    pub(super) ttl: i64,
}

impl<T: Send> Progress for CollectionProgress<T> {
    type Item = T;
    fn buffer(&mut self) -> &mut Buffer<T> {
        &mut self.buffer
    }
    fn release(&mut self) {
        self.key.take();
    }
}

impl<T: Send + 'static> State<CollectionProgress<T>> {
    pub(super) fn collection(
        session: Arc<SessionState>,
        key: Vec<u8>,
        kind: &'static str,
    ) -> Result<Arc<Self>, JsError> {
        let _gate = session.admit()?;
        strings::check_payload(
            key.len(),
            session.options.max_response_bytes.unwrap_or(262144) as usize,
        )?;
        Self::new(session.clone(), kind, |_, slot| CollectionProgress {
            buffer: Buffer::new(slot),
            key: Some(key),
            cursor: 0,
            started: false,
            exists: false,
            length: 0,
            ttl: -2,
        })
    }
}

impl<T: Send> CollectionProgress<T> {
    pub(super) fn needs_read(&self) -> bool {
        self.buffer.pending.is_empty() && (!self.started || self.cursor != 0)
    }

    pub(super) fn drain(&mut self, budget: usize, size: impl Fn(&T) -> usize) -> (Vec<T>, bool) {
        let items = self.buffer.drain(budget, size);
        let complete = self.started && self.cursor == 0 && self.buffer.pending.is_empty();
        if complete {
            self.buffer.slot.take();
            self.release();
        }
        (items, complete)
    }
}
