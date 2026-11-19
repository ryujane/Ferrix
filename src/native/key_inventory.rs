use super::key_tree::{Cursor, KeyTree, VisibleRow};
use nsh_core::prelude::*;
use std::{
    collections::{HashMap, hash_map::RandomState},
    hash::BuildHasher,
};

const SLAB_SIZE: usize = 64 * 1024;
const UNCERTAIN: u32 = 1 << 31;

#[derive(Clone, Copy, Default, Eq, PartialEq)]
struct Location {
    slab: u32,
    start: u32,
    len: u32,
}

#[derive(Default)]
struct Slab {
    bytes: Vec<u8>,
    references: usize,
}

#[derive(Default)]
struct Record {
    location: Location,
    info: u32,
}

struct Keys {
    slabs: Vec<Slab>,
    records: Vec<Record>,
    table: Vec<u32>,
    count: u32,
    hasher: RandomState,
}

impl Default for Keys {
    fn default() -> Self {
        Self {
            slabs: Vec::new(),
            records: Vec::new(),
            table: vec![0; 256],
            count: 0,
            hasher: RandomState::new(),
        }
    }
}

impl Keys {
    fn bytes(&self, slot: u32) -> Option<&[u8]> {
        let Location { slab, start, len } = self.records.get(slot as usize)?.location;
        let data = &self.slabs.get(slab.checked_sub(1)? as usize)?.bytes;
        Some(&data[start as usize..start as usize + len as usize])
    }

    fn bucket(&self, key: &[u8]) -> usize {
        let mask = self.table.len() - 1;
        let mut at = self.hasher.hash_one(key) as usize & mask;
        while let Some(slot) = self.table[at].checked_sub(1) {
            if self.bytes(slot) == Some(key) {
                break;
            }
            at = (at + 1) & mask;
        }
        at
    }

    fn slot(&self, key: &[u8]) -> Option<u32> {
        self.table[self.bucket(key)].checked_sub(1)
    }

    fn place(&mut self, slot: u32) {
        let bucket = self.bucket(self.bytes(slot).expect("occupied key"));
        self.table[bucket] = slot + 1;
    }

    fn write(&mut self, key: &[u8]) -> Location {
        if self.slabs.last().is_none_or(|slab| {
            slab.references == 0 || slab.bytes.capacity() - slab.bytes.len() < key.len()
        }) {
            self.slabs.push(Slab {
                bytes: Vec::with_capacity(SLAB_SIZE.max(key.len())),
                references: 0,
            });
        }
        let id = self.slabs.len() as u32;
        let slab = self.slabs.last_mut().expect("space allocated");
        let start = slab.bytes.len() as u32;
        slab.bytes.extend_from_slice(key);
        slab.references += 1;
        Location {
            slab: id,
            start,
            len: key.len() as u32,
        }
    }

    fn append(&mut self, key: &[u8]) -> Option<u32> {
        let mut bucket = self.bucket(key);
        if self.table[bucket] != 0 {
            return None;
        }
        if (self.count as usize + 1) * 4 > self.table.len() * 3 {
            let capacity = self.table.len() * 2;
            let previous = std::mem::replace(&mut self.table, vec![0; capacity]);
            for slot in previous.into_iter().filter_map(|slot| slot.checked_sub(1)) {
                self.place(slot);
            }
            bucket = self.bucket(key);
        }
        let slot = self.records.len() as u32;
        let location = self.write(key);
        self.records.push(Record { location, info: 0 });
        self.table[bucket] = slot + 1;
        self.count += 1;
        Some(slot)
    }

    fn take(&mut self, key: &[u8]) -> Option<u32> {
        let mut bucket = self.bucket(key);
        let slot = self.table[bucket].checked_sub(1)?;
        let mask = self.table.len() - 1;
        self.table[bucket] = 0;
        loop {
            bucket = (bucket + 1) & mask;
            let Some(displaced) = self.table[bucket].checked_sub(1) else {
                break;
            };
            self.table[bucket] = 0;
            self.place(displaced);
        }
        Some(slot)
    }

    fn release(&mut self, slot: u32) {
        let location = std::mem::take(&mut self.records[slot as usize].location);
        let slab = &mut self.slabs[location.slab as usize - 1];
        slab.references -= 1;
        if slab.references == 0 {
            slab.bytes = Vec::new();
        }
    }

    fn remove(&mut self, key: &[u8]) -> bool {
        let Some(slot) = self.take(key) else {
            return false;
        };
        self.release(slot);
        self.count -= 1;
        true
    }

    fn rename(&mut self, from: &[u8], to: &[u8]) -> bool {
        if from == to {
            return false;
        }
        let Some(slot) = self.take(from) else {
            return false;
        };
        // A cached destination may predate an external deletion and RENAMENX.
        self.remove(to);
        self.release(slot);
        self.records[slot as usize].location = self.write(to);
        self.place(slot);
        true
    }
}

/// One key copied out of the inventory for a visible row or an action.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct KeyInventoryEntry {
    pub id: String,
    pub key: Vec<u8>,
    pub name: String,
    pub r#type: Option<String>,
    pub uncertain: bool,
}

/// Position and content of a visible key tree row.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct KeyInventoryRow {
    pub index: u32,
    pub section: u32,
    pub offset: u32,
    pub parent: Option<u32>,
    pub depth: u16,
    pub label: String,
    pub prefix: Option<String>,
    pub count: Option<u32>,
    pub expanded: Option<bool>,
    pub entry: Option<KeyInventoryEntry>,
}

/// Metadata returned for a key in the most recent SCAN page.
#[derive(JsObject)]
pub struct KeyInventoryType {
    pub key: Vec<u8>,
    pub r#type: Option<String>,
}

/// Stores the workspace's loaded keys as packed binary data and indexes the visible tree.
#[class]
#[derive(Default)]
pub struct KeyInventory {
    keys: Keys,
    tree: KeyTree,
    pending: HashMap<u32, Location>,
    type_codes: HashMap<String, u32>,
    types: Vec<String>,
    revision: u32,
    layout_revision: u32,
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut id = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(id, "{byte:02x}");
    }
    id
}

impl KeyInventory {
    fn changed(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    fn rebuild(&mut self) {
        self.tree.clear_index();
        for slot in 0..self.keys.records.len() as u32 {
            if let Some(bytes) = self.keys.bytes(slot) {
                self.tree.append(slot, bytes);
            }
        }
        self.tree.reindex();
        self.layout_revision = self.layout_revision.wrapping_add(1);
        self.changed();
    }

    fn label(&self, row: &VisibleRow, entry: Option<&KeyInventoryEntry>) -> String {
        let value = if let Some((prefix, _, _)) = row.folder {
            self.tree.folder_label(prefix, row.prefix_len).into()
        } else if let Some(entry) = entry {
            entry.name[row.prefix_len..].into()
        } else {
            let key = self
                .keys
                .bytes(row.slot.expect("leaf"))
                .expect("visible key");
            match std::str::from_utf8(key) {
                Ok(name) => name[row.prefix_len..].into(),
                Err(_) => format!("0x{}", hex(key)),
            }
        };
        if value == "" { "∅".into() } else { value }
    }
}

#[class]
impl KeyInventory {
    /// Creates an empty inventory for a workspace scan.
    pub fn new() -> Self {
        Self::default()
    }

    /// Count of distinct loaded keys.
    #[getter]
    pub fn length(&self) -> u32 {
        self.keys.count
    }

    /// Changes when the scan, row metadata, or tree layout changes.
    #[getter]
    pub fn revision(&self) -> u32 {
        self.revision
    }

    /// Changes when section IDs are rebuilt.
    #[getter]
    pub fn layout_revision(&self) -> u32 {
        self.layout_revision
    }

    /// Count of rows including visible folder headings.
    #[getter]
    pub fn row_count(&self) -> u32 {
        self.tree.count()
    }

    /// Releases the current scan data and preserves the view's folder preferences.
    pub fn clear(&mut self) {
        self.keys = Keys::default();
        self.tree.reset();
        self.pending = HashMap::new();
        self.type_codes = HashMap::new();
        self.types = Vec::new();
        self.layout_revision = self.layout_revision.wrapping_add(1);
        self.changed();
    }

    /// Adds distinct binary keys. Returns their indices in the input page.
    pub fn append_page(&mut self, page: Vec<Vec<u8>>) -> Vec<u32> {
        self.pending.clear();
        let mut added = Vec::new();
        for (index, key) in page.iter().enumerate() {
            if let Some(slot) = self.keys.append(key) {
                self.tree.append(slot, key);
                self.pending
                    .insert(slot, self.keys.records[slot as usize].location);
                added.push(index as u32);
            }
        }
        if !added.is_empty() {
            self.tree.reindex();
            self.changed();
        }
        added
    }

    /// Applies metadata only to surviving entries from the most recent page.
    pub fn set_types(&mut self, items: Vec<KeyInventoryType>) -> bool {
        let mut changed = false;
        for item in items {
            let Some(slot) = self.keys.slot(&item.key) else {
                continue;
            };
            let record = &mut self.keys.records[slot as usize];
            if self.pending.get(&slot) != Some(&record.location) {
                continue;
            }
            let kind = item.r#type.map_or(0, |kind| {
                *self.type_codes.entry(kind.clone()).or_insert_with(|| {
                    self.types.push(kind);
                    self.types.len() as u32
                })
            });
            let info = (record.info & UNCERTAIN) | kind;
            changed |= record.info != info;
            record.info = info;
        }
        self.pending.clear();
        if changed {
            self.changed();
        }
        changed
    }

    /// Returns a copy of a key for inspection or a workspace action.
    pub fn entry(&self, slot: u32) -> Option<KeyInventoryEntry> {
        let key = self.keys.bytes(slot)?;
        let id = hex(key);
        let name = std::str::from_utf8(key).map_or_else(|_| format!("0x{id}"), str::to_owned);
        let info = self.keys.records[slot as usize].info;
        let kind = (info & !UNCERTAIN)
            .checked_sub(1)
            .and_then(|id| self.types.get(id as usize))
            .cloned();
        Some(KeyInventoryEntry {
            id,
            key: key.to_vec(),
            name,
            r#type: kind,
            uncertain: info & UNCERTAIN != 0,
        })
    }

    /// Returns the first surviving key.
    pub fn first_entry(&self) -> Option<KeyInventoryEntry> {
        (0..self.keys.records.len() as u32).find_map(|slot| self.entry(slot))
    }

    /// Finds a loaded key by its original bytes.
    pub fn lookup(&self, key: Vec<u8>) -> Option<KeyInventoryEntry> {
        self.keys.slot(&key).and_then(|slot| self.entry(slot))
    }

    /// Updates the write-outcome marker on a loaded key.
    pub fn set_uncertain(&mut self, key: Vec<u8>, uncertain: bool) -> bool {
        let Some(slot) = self.keys.slot(&key) else {
            return false;
        };
        let info = &mut self.keys.records[slot as usize].info;
        let next = (*info & !UNCERTAIN) | if uncertain { UNCERTAIN } else { 0 };
        if *info == next {
            return false;
        }
        *info = next;
        self.changed();
        true
    }

    /// Removes a key from the inventory after a confirmed Redis deletion.
    pub fn remove(&mut self, key: Vec<u8>) -> bool {
        if !self.keys.remove(&key) {
            return false;
        }
        self.rebuild();
        true
    }

    /// Replaces an inventory entry after a confirmed Redis rename.
    pub fn rename(&mut self, from: Vec<u8>, to: Vec<u8>) -> bool {
        if !self.keys.rename(&from, &to) {
            return false;
        }
        self.rebuild();
        true
    }

    /// Updates tree grouping while preserving the SCAN order.
    pub fn configure(&mut self, separator: String, grouped: bool) {
        if self.tree.configure(separator, grouped) {
            self.rebuild();
        }
    }

    /// Toggles the expansion of a folder.
    pub fn toggle_folder(&mut self, prefix: String) {
        if self.tree.toggle(&prefix) {
            self.changed();
        }
    }

    /// Expands or collapses the loaded folders.
    pub fn expand_all(&mut self, expanded: bool) {
        self.tree.expand_all(expanded);
        self.changed();
    }

    /// Materializes the indexed visible row.
    pub fn row_at(&self, index: u32) -> Option<KeyInventoryRow> {
        let row = self.tree.row(index)?;
        let entry = row.slot.and_then(|slot| self.entry(slot));
        Some(KeyInventoryRow {
            index,
            section: row.cursor.section,
            offset: row.cursor.offset,
            parent: row.parent,
            depth: u16::from(row.depth),
            label: self.label(&row, entry.as_ref()),
            prefix: row.folder.map(|(prefix, _, _)| prefix.into()),
            count: row.folder.map(|(_, count, _)| count),
            expanded: row.folder.map(|(_, _, expanded)| expanded),
            entry,
        })
    }

    /// Resolves a row position, falling back to a collapsed ancestor.
    pub fn row_index(&self, section: u32, offset: u32) -> Option<u32> {
        self.tree.index(Cursor { section, offset })
    }

    /// Finds a case-insensitive prefix within a bounded number of visible rows.
    pub fn find_label(&self, start: u32, length: u32, prefix: String) -> Option<u32> {
        let count = self.tree.count();
        if count == 0 {
            return None;
        }
        (0..length.min(count))
            .map(|offset| ((u64::from(start) + u64::from(offset)) % u64::from(count)) as u32)
            .find(|&index| {
                self.tree
                    .row(index)
                    .is_some_and(|row| self.label(&row, None).to_lowercase().starts_with(&prefix))
            })
    }
}
