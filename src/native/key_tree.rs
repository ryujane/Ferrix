use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub(super) struct Cursor {
    pub section: u32,
    pub offset: u32,
}

struct Run {
    first: u32,
    count: u32,
    slots: Vec<u32>,
}

impl Run {
    fn push(&mut self, slot: u32) {
        if self.slots.is_empty() && slot != self.first + self.count {
            self.slots.extend(self.first..self.first + self.count);
        }
        if !self.slots.is_empty() {
            self.slots.push(slot);
        }
        self.count += 1;
    }

    fn slot(&self, offset: u32) -> u32 {
        self.slots
            .get(offset as usize)
            .copied()
            .unwrap_or(self.first + offset)
    }
}

struct Folder {
    prefix: String,
    count: u32,
    children: Vec<u32>,
}

enum Kind {
    Folder(Folder),
    Run(Run),
}

struct Section {
    parent: Option<u32>,
    depth: u8,
    kind: Kind,
}

pub(super) struct VisibleRow<'a> {
    pub cursor: Cursor,
    pub parent: Option<u32>,
    pub depth: u8,
    pub folder: Option<(&'a str, u32, bool)>,
    pub slot: Option<u32>,
    pub prefix_len: usize,
}

pub(super) struct KeyTree {
    separator: String,
    grouped: bool,
    collapsed: HashSet<String>,
    root: Vec<u32>,
    sections: Vec<Section>,
    folders: HashMap<String, u32>,
    spans: Vec<(u32, u32)>,
    starts: Vec<Option<u32>>,
    count: u32,
}

impl Default for KeyTree {
    fn default() -> Self {
        Self {
            separator: ":".into(),
            grouped: true,
            collapsed: HashSet::new(),
            root: Vec::new(),
            sections: Vec::new(),
            folders: HashMap::new(),
            spans: Vec::new(),
            starts: Vec::new(),
            count: 0,
        }
    }
}

impl KeyTree {
    pub fn reset(&mut self) {
        *self = Self {
            separator: std::mem::take(&mut self.separator),
            grouped: self.grouped,
            collapsed: std::mem::take(&mut self.collapsed),
            ..Self::default()
        };
    }

    pub fn configure(&mut self, separator: String, grouped: bool) -> bool {
        if self.separator == separator && self.grouped == grouped {
            return false;
        }
        if self.separator != separator {
            self.collapsed.clear();
            self.separator = separator;
        }
        self.grouped = grouped;
        true
    }

    pub fn clear_index(&mut self) {
        self.root.clear();
        self.sections.clear();
        self.folders.clear();
    }

    fn folder(&self, id: u32) -> &Folder {
        match &self.sections[id as usize].kind {
            Kind::Folder(folder) => folder,
            Kind::Run(_) => unreachable!("only folders contain children"),
        }
    }

    fn folder_mut(&mut self, id: u32) -> &mut Folder {
        match &mut self.sections[id as usize].kind {
            Kind::Folder(folder) => folder,
            Kind::Run(_) => unreachable!("only folders contain children"),
        }
    }

    fn children(&self, parent: Option<u32>) -> &[u32] {
        match parent {
            Some(parent) => &self.folder(parent).children,
            None => &self.root,
        }
    }

    fn push_section(&mut self, parent: Option<u32>, depth: u8, kind: Kind) -> u32 {
        let id = self.sections.len() as u32;
        match parent {
            Some(parent) => self.folder_mut(parent).children.push(id),
            None => self.root.push(id),
        }
        self.sections.push(Section {
            parent,
            depth,
            kind,
        });
        id
    }

    pub fn append(&mut self, slot: u32, bytes: &[u8]) {
        let mut parent = None;
        let mut depth = 0;
        if self.grouped
            && !self.separator.is_empty()
            && let Ok(name) = std::str::from_utf8(bytes)
        {
            let mut start = 0;
            while depth < 4 {
                let Some(next) = name[start..].find(&self.separator) else {
                    break;
                };
                let end = start + next + self.separator.len();
                let prefix = &name[..end];
                let id = if let Some(&id) = self.folders.get(prefix) {
                    id
                } else {
                    let id = self.push_section(
                        parent,
                        depth,
                        Kind::Folder(Folder {
                            prefix: prefix.into(),
                            count: 0,
                            children: Vec::new(),
                        }),
                    );
                    self.folders.insert(prefix.into(), id);
                    id
                };
                self.folder_mut(id).count += 1;
                parent = Some(id);
                depth += 1;
                start = end;
            }
        }

        if let Some(&id) = self.children(parent).last()
            && let Kind::Run(run) = &mut self.sections[id as usize].kind
        {
            run.push(slot);
        } else {
            self.push_section(
                parent,
                depth,
                Kind::Run(Run {
                    first: slot,
                    count: 1,
                    slots: Vec::new(),
                }),
            );
        }
    }

    pub fn reindex(&mut self) {
        fn visit(
            sections: &[Section],
            children: &[u32],
            collapsed: &HashSet<String>,
            spans: &mut Vec<(u32, u32)>,
            starts: &mut [Option<u32>],
            count: &mut u32,
        ) {
            for &id in children {
                starts[id as usize] = Some(*count);
                spans.push((*count, id));
                match &sections[id as usize].kind {
                    Kind::Folder(folder) => {
                        *count += 1;
                        if !collapsed.contains(&folder.prefix) {
                            visit(sections, &folder.children, collapsed, spans, starts, count);
                        }
                    }
                    Kind::Run(run) => *count += run.count,
                }
            }
        }
        self.spans.clear();
        self.starts.clear();
        self.starts.resize(self.sections.len(), None);
        self.count = 0;
        visit(
            &self.sections,
            &self.root,
            &self.collapsed,
            &mut self.spans,
            &mut self.starts,
            &mut self.count,
        );
    }

    pub fn count(&self) -> u32 {
        self.count
    }

    pub fn toggle(&mut self, prefix: &str) -> bool {
        if !self.folders.contains_key(prefix) {
            return false;
        }
        if !self.collapsed.remove(prefix) {
            self.collapsed.insert(prefix.into());
        }
        self.reindex();
        true
    }

    pub fn expand_all(&mut self, expanded: bool) {
        if expanded {
            self.collapsed.clear();
        } else {
            self.collapsed.extend(self.folders.keys().cloned());
        }
        self.reindex();
    }

    pub fn index(&self, mut cursor: Cursor) -> Option<u32> {
        loop {
            let section = self.sections.get(cursor.section as usize)?;
            if let Some(start) = self.starts[cursor.section as usize] {
                let len = match &section.kind {
                    Kind::Folder(_) => 1,
                    Kind::Run(run) => run.count,
                };
                return (cursor.offset < len).then(|| start + cursor.offset);
            }
            cursor = Cursor {
                section: section.parent?,
                offset: 0,
            };
        }
    }

    pub fn row(&self, index: u32) -> Option<VisibleRow<'_>> {
        if index >= self.count {
            return None;
        }
        let at = self.spans.partition_point(|&(start, _)| start <= index) - 1;
        let (start, id) = self.spans[at];
        let Section {
            parent,
            depth,
            kind,
        } = &self.sections[id as usize];
        let parent_folder = parent.map(|id| self.folder(id));
        let mut row = VisibleRow {
            cursor: Cursor {
                section: id,
                offset: index - start,
            },
            parent: *parent,
            depth: *depth,
            folder: None,
            slot: None,
            prefix_len: parent_folder.map_or(0, |folder| folder.prefix.len()),
        };
        match kind {
            Kind::Folder(folder) => {
                row.folder = Some((
                    &folder.prefix,
                    folder.count,
                    !self.collapsed.contains(&folder.prefix),
                ));
            }
            Kind::Run(run) => row.slot = Some(run.slot(row.cursor.offset)),
        }
        Some(row)
    }

    pub fn folder_label<'a>(&self, prefix: &'a str, parent_len: usize) -> &'a str {
        &prefix[parent_len..prefix.len() - self.separator.len()]
    }
}
