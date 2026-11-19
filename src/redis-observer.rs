//! Passive opt-in instrumentation of the real native request path.
//! No callback or file I/O runs on the engine or Redis worker. A full channel
//! increments a loss counter; a measurement with loss must be rejected.
use std::{
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc::SyncSender,
    },
    time::Instant,
};

static SINK: OnceLock<SyncSender<RequestTiming>> = OnceLock::new();
static LOST: AtomicU64 = AtomicU64::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);

/// One real admitted request, ending before native result marshalling/delivery.
pub struct RequestTiming {
    pub id: u64,
    pub operation: &'static str,
    pub admitted: Instant,
    pub completed: Instant,
    /// Includes lane/global execution wait. None when cancelled before execution.
    pub execution_started: Option<Instant>,
    pub success: bool,
}

/// Install once per process. The caller owns a bounded off-engine collector.
pub fn install(sink: SyncSender<RequestTiming>) -> Result<(), SyncSender<RequestTiming>> {
    SINK.set(sink)
}
pub fn lost_samples() -> u64 {
    LOST.load(Ordering::Relaxed)
}

pub(crate) struct Span {
    id: u64,
    operation: &'static str,
    admitted: Instant,
}
impl Span {
    pub(crate) fn new(operation: &'static str) -> Self {
        Self {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            operation,
            admitted: Instant::now(),
        }
    }
    pub(crate) fn finish(self, execution_started: Option<Instant>, success: bool) {
        if let Some(sink) = SINK.get() {
            let sample = RequestTiming {
                id: self.id,
                operation: self.operation,
                admitted: self.admitted,
                completed: Instant::now(),
                execution_started,
                success,
            };
            if sink.try_send(sample).is_err() {
                LOST.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}
