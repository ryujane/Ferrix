use super::key_inventory::{KeyInventory, KeyInventoryRow};
use nsh_base::{context_menu, menu_item, menu_separator};
use nsh_core::{
    AccessibilityRole, AccessibilityState, Viewability,
    element::{
        Arg, Image, ImageSrc, Instance, JsHost, JsIn, JsOwned, JsValue, KeyEvent, ListLayout,
        PropError, Ret, TsTypes, ViewableItems,
    },
    keymap::When,
    prelude::*,
    t,
    time::Instant,
};
use std::{sync::LazyLock, time::Duration};

/// Binds the same class instance used by the TSX scan controller to a Rust view.
#[derive(Clone, Debug)]
pub struct InventoryHandle(Instance<KeyInventory>);

impl PartialEq for InventoryHandle {
    fn eq(&self, other: &Self) -> bool {
        self.0.ptr_eq(&other.0)
    }
}

impl JsValue for InventoryHandle {
    fn ts_type(types: &mut TsTypes) -> String {
        <Instance<KeyInventory> as Arg>::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        <Instance<KeyInventory> as Arg>::from_js(value).map(Self)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.0.clone().into_js(host)
    }
}

/// Shared inventory handle and workspace state needed to display it.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct KeyTreeInventory {
    pub keys: InventoryHandle,
    pub revision: u32,
    pub selected: Option<String>,
    pub menu_disabled: bool,
    pub locked_keys: Vec<String>,
    pub searching: bool,
    pub stopped: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct ViewState {
    selected: Option<String>,
    menu_disabled: bool,
    locked_keys: Vec<String>,
    searching: bool,
    stopped: bool,
}

#[derive(Clone, PartialEq, Props)]
pub struct KeyRowsProps {
    /// Workspace inventory shared by the scan controller and native tree.
    pub inventory: Prop<Option<KeyTreeInventory>>,
}

#[derive(Clone, PartialEq, Event)]
pub enum KeyRowsEvent {
    /// Opens a key using its original Redis bytes.
    OpenKey { key: Vec<u8> },
    /// Copies the key's display name using the workspace clipboard action.
    CopyName { name: String },
    /// Requests the workspace's rename dialog.
    RenameKey { id: String },
    /// Requests confirmation to delete a key.
    DeleteKey { id: String },
    /// Requests the new-key dialog with a folder's prefix.
    CreateKey { prefix: String },
    /// Requests confirmation to delete keys in a folder.
    DeleteFolder { prefix: String },
    /// Visible keys whose type has yet to be looked up.
    VisibleKeysChanged {
        layout_revision: u32,
        keys: Vec<Vec<u8>>,
    },
}

#[derive(Clone, Copy)]
pub struct KeyRowsApi {
    list: ElementRef,
    visible: Signal<Option<(usize, usize)>>,
}

#[methods]
impl KeyRowsApi {
    /// Brings the row into view, aligning it to the bottom when requested.
    pub fn scroll_to_row(&self, index: u32, at_end: bool) {
        if self
            .visible
            .get_untracked()
            .is_some_and(|(first, last)| (first..=last).contains(&(index as usize)))
        {
            return;
        }
        self.list.scroll_to_index(
            index,
            Percentage(if at_end { 1.0 } else { 0.0 }),
            px(0.0),
            false,
        );
    }
}

#[derive(Clone, PartialEq)]
struct Position {
    inventory: InventoryHandle,
    layout: u32,
    section: u32,
    offset: u32,
}

#[derive(Default)]
struct Typeahead {
    text: String,
    at: Option<Instant>,
    search: Option<Spawned<()>>,
}

#[derive(Clone, Copy)]
struct Tree {
    inventory: Memo<Option<(InventoryHandle, u32)>>,
    expansion: Signal<u32>,
    cx: Scope<KeyRowsEvent>,
    focus: ElementRef,
    focused: Signal<bool>,
    cursor: Signal<Option<Position>>,
    typeahead: Stored<Typeahead>,
    api: KeyRowsApi,
}

impl Tree {
    fn current_index(self) -> Option<u32> {
        let cursor = self.cursor.get()?;
        let (inventory, _) = self.inventory.get()?;
        self.expansion.get();
        if cursor.inventory != inventory {
            return None;
        }
        inventory.0.with(|model| {
            (model.layout_revision() == cursor.layout)
                .then(|| model.row_index(cursor.section, cursor.offset))
                .flatten()
        })
    }

    fn point_at(self, inventory: &InventoryHandle, row: &KeyInventoryRow) {
        self.cancel_search();
        self.cursor.set(Some(Position {
            inventory: inventory.clone(),
            layout: inventory.0.with(KeyInventory::layout_revision),
            section: row.section,
            offset: row.offset,
        }));
    }

    fn select(self, inventory: &InventoryHandle, index: u32, at_end: bool) {
        let Some(row) = inventory.0.with(|model| model.row_at(index)) else {
            return;
        };
        self.point_at(inventory, &row);
        self.api.scroll_to_row(index, at_end);
        if let Some(entry) = row.entry {
            self.cx.emit(KeyRowsEvent::OpenKey { key: entry.key });
        }
    }

    fn activate(self, inventory: &InventoryHandle, row: &KeyInventoryRow) {
        self.point_at(inventory, row);
        if let Some(prefix) = &row.prefix {
            inventory
                .0
                .with_mut(|model| model.toggle_folder(prefix.clone()));
            self.expansion
                .update(|version| *version = version.wrapping_add(1));
        } else if let Some(entry) = &row.entry {
            self.cx.emit(KeyRowsEvent::OpenKey {
                key: entry.key.clone(),
            });
        }
    }

    fn navigate(self, key: &str) {
        let Some((inventory, _)) = self.inventory.get_untracked() else {
            return;
        };
        let count = inventory.0.with(KeyInventory::row_count);
        if count == 0 {
            return;
        }
        let current = self.current_index();
        let index = current.unwrap_or(0);
        match key {
            "up" => self.select(&inventory, index.checked_sub(1).unwrap_or(count - 1), false),
            "down" => self.select(&inventory, current.map_or(0, |i| (i + 1) % count), true),
            "home" => self.select(&inventory, 0, false),
            "end" => self.select(&inventory, count - 1, true),
            _ => {
                let Some(row) = inventory.0.with(|model| model.row_at(index)) else {
                    return;
                };
                match key {
                    "enter" => self.activate(&inventory, &row),
                    "space" if row.prefix.is_some() => self.activate(&inventory, &row),
                    "left" if row.expanded == Some(true) => self.activate(&inventory, &row),
                    "right" if row.expanded == Some(false) => self.activate(&inventory, &row),
                    "right" if row.prefix.is_some() => self.select(&inventory, index + 1, true),
                    "left" => {
                        if let Some(parent) = row.parent.and_then(|section| {
                            inventory.0.with(|model| model.row_index(section, 0))
                        }) {
                            self.select(&inventory, parent, false);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn cancel_search(self) {
        let search = self.typeahead.with(|state| state.search.take());
        if let Some(search) = search {
            search.cancel();
        }
    }

    fn typeahead(self, event: &KeyEvent) {
        if !self.focused.get_untracked()
            || event.modifiers.ctrl
            || event.modifiers.cmd
            || event.modifiers.alt
            || event.key.chars().count() != 1
            || event.key.trim().is_empty()
        {
            return;
        }
        let Some((inventory, _)) = self.inventory.get_untracked() else {
            return;
        };
        self.cancel_search();
        let prefix = self.typeahead.with(|state| {
            let now = Instant::now();
            let key = event.key.to_lowercase();
            if state
                .at
                .is_none_or(|at| now.duration_since(at) >= Duration::from_millis(700))
                || state.text == key
            {
                state.text.clear();
            }
            state.text.push_str(&key);
            state.at = Some(now);
            state.text.clone()
        });
        let current = self.current_index();
        let start = current.map_or(0, |index| index + 1);
        let (revision, count) = inventory
            .0
            .with(|model| (model.revision(), model.row_count()));
        let search = spawn(async move {
            for offset in (0..count).step_by(8_192) {
                if self
                    .inventory
                    .get_untracked()
                    .is_none_or(|(current, _)| current != inventory)
                    || inventory.0.with(KeyInventory::revision) != revision
                {
                    break;
                }
                let size = 8_192.min(count - offset);
                let index = inventory
                    .0
                    .with(|model| model.find_label(start + offset, size, prefix.clone()));
                if let Some(index) = index {
                    self.typeahead.with(|state| {
                        state.search.take();
                    });
                    self.select(
                        &inventory,
                        index,
                        current.is_none_or(|current| index > current),
                    );
                    return;
                }
                if offset + size < count {
                    next_frame().await;
                }
            }
            self.typeahead.with(|state| {
                state.search.take();
            });
        });
        self.typeahead.with(|state| state.search = Some(search));
    }
}

/// Draws and navigates the workspace key tree with Rust views for the virtualized rows.
#[component(methods = KeyRowsApi)]
pub fn KeyRows(props: KeyRowsProps, cx: Scope<KeyRowsEvent>) -> impl IntoElement {
    let api = KeyRowsApi {
        list: element_ref(),
        visible: signal(None),
    };
    cx.methods(api);
    let inventory = computed(move || {
        props.inventory.with(|source| {
            source
                .as_ref()
                .map(|source| (source.keys.clone(), source.revision))
        })
    });
    let state = computed(move || {
        props.inventory.with(|source| {
            source
                .as_ref()
                .map_or_else(ViewState::default, |source| ViewState {
                    selected: source.selected.clone(),
                    menu_disabled: source.menu_disabled,
                    locked_keys: source.locked_keys.clone(),
                    searching: source.searching,
                    stopped: source.stopped,
                })
        })
    });
    let tree = Tree {
        inventory,
        expansion: signal(0),
        cx,
        focus: element_ref(),
        focused: signal(false),
        cursor: signal(None),
        typeahead: stored(Typeahead::default()),
        api,
    };
    let count = computed(move || {
        tree.expansion.get();
        inventory.get().map_or(0, |(inventory, _)| {
            inventory.0.with(KeyInventory::row_count) as usize
        })
    });
    let visible_keys = computed(move || {
        tree.expansion.get();
        let (Some((inventory, _)), Some((first, last))) = (inventory.get(), api.visible.get())
        else {
            return (0, Vec::new());
        };
        inventory.0.with(|model| {
            (
                model.layout_revision(),
                model.visible_type_keys(first, last),
            )
        })
    });
    effect(move || {
        let (layout_revision, keys) = visible_keys.get();
        cx.emit(KeyRowsEvent::VisibleKeysChanged {
            layout_revision,
            keys,
        });
    });
    let current_index = computed(move || tree.current_index());
    effect(move || {
        if tree.focused.get() {
            for key in [
                "up", "down", "home", "end", "left", "right", "enter", "space",
            ] {
                on_key_with(
                    key,
                    KeyOptions {
                        when: When::NotEditing,
                        repeat: true,
                        for_focus: true,
                        ..Default::default()
                    },
                    move |_| tree.navigate(key),
                );
            }
        }
    });
    view()
        .flex_grow(1.0)
        .min_h(px(0.0))
        .child(when(
            move || count.get() != 0,
            move || {
                api.visible.set(None);
                view()
                    .element_ref(&tree.focus)
                    .role(AccessibilityRole::Tree)
                    .label(|| t!("workspace.keyBrowser"))
                    .focusable(true)
                    .on_focus(move || tree.focused.set(true))
                    .on_blur(move || {
                        tree.focused.set(false);
                        tree.cancel_search();
                    })
                    .on_key_down(move |event: &KeyEvent| tree.typeahead(event))
                    .flex_grow(1.0)
                    .min_h(px(0.0))
                    .child(
                        virtual_list(
                            move || count.get(),
                            move |position| {
                                let row = computed(move || {
                                    let (inventory, _) = inventory.get()?;
                                    tree.expansion.get();
                                    inventory
                                        .0
                                        .with(|model| model.row_at(position.index() as u32))
                                });
                                let at_cursor = move || {
                                    tree.focused.get()
                                        && current_index.get() == Some(position.index() as u32)
                                };
                                row_view(row, state, tree.cx, at_cursor, move || {
                                    let (Some((inventory, _)), Some(row)) =
                                        (inventory.get_untracked(), row.get_untracked())
                                    else {
                                        return;
                                    };
                                    tree.focus.focus();
                                    tree.activate(&inventory, &row);
                                })
                            },
                        )
                        .element_ref(&api.list)
                        .test_id("live-key-tree")
                        .viewability(Viewability {
                            item_visible_threshold: Some(Percentage(0.995)),
                            ..Viewability::default()
                        })
                        .on_viewable_items_change(move |items: &ViewableItems| {
                            api.visible.set(items.viewable);
                        })
                        .estimated_item_size(px(28.0))
                        .content_padding(px(4.0))
                        .flex_grow(1.0)
                        .min_h(px(0.0)),
                    )
            },
        ))
        .child(when(
            move || count.get() == 0,
            move || empty_view(state, tree.cx),
        ))
}

type Row = Memo<Option<KeyInventoryRow>>;

fn row_view(
    row: Row,
    state: Memo<ViewState>,
    cx: Scope<KeyRowsEvent>,
    at_cursor: impl Fn() -> bool + 'static,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    // Keep the viewport's row views mounted as SCAN updates counts and metadata.
    let expanded = computed(move || row.with(|row| row.as_ref().and_then(|row| row.expanded)));
    let folder = computed(move || expanded.get().is_some());
    let selected = computed(move || {
        row.with(|row| {
            row.as_ref()
                .and_then(|row| row.entry.as_ref())
                .is_some_and(|entry| {
                    state.with(|state| state.selected.as_deref() == Some(&entry.id))
                })
        })
    });
    let label = move || {
        row.with(|row| {
            row.as_ref()
                .map_or_else(String::new, |row| row.label.clone())
        })
    };
    let trigger = view()
        .role(AccessibilityRole::TreeItem)
        .label(label)
        .accessibility_state(move || AccessibilityState { selected: selected.get(), expanded: expanded.get(), ..Default::default() })
        .focusable(false)
        .app_class(move || Some(format!(
            "h-7 flex-row items-center gap-1 pr-2 rounded-sm text-foreground hover:bg-accent/60 {} {}",
            if selected.get() { "bg-selected" } else { "" },
            if at_cursor() { "ring-1 ring-ring" } else { "" },
        ).into()))
        .pl(move || px(5.0 + row.with(|row| row.as_ref().map_or(0.0, |row| f32::from(row.depth) * 13.0))))
        .on_press(on_press)
        .child(when(move || folder.get(), move || [
            icon(move || folder_icon(expanded, &DOWN, &RIGHT), 11.0, "muted-foreground"),
            icon(move || folder_icon(expanded, &FOLDER_OPEN, &FOLDER), 14.0, "steel"),
        ]).otherwise(move || [
            view().app_class(move || Some(if selected.get() {
                "h-4 w-0.5 shrink-0 rounded-full bg-primary"
            } else {
                "h-4 w-0.5 shrink-0 rounded-full bg-transparent"
            }.into())).into_element(),
            key_badge(row).into_element(),
        ]))
        .child(text(label).app_class(move || Some(if folder.get() {
            "flex-1 min-w-0 text-(--text-size-11) font-mono text-foreground line-clamp-1 font-semibold"
        } else {
            "flex-1 min-w-0 text-(--text-size-11) font-mono text-foreground line-clamp-1 font-normal"
        }.into())))
        .child(when(move || folder.get(), move || {
            text(move || row.with(|row| row.as_ref().and_then(|row| row.count)
                .map_or_else(String::new, |count| count.to_string())))
                .app_class(Some("text-(--text-size-9) text-faint font-mono".into()))
        }));
    tree_menu(state, Some(row), trigger, cx)
}

fn folder_icon(expanded: Memo<Option<bool>>, open: &ImageSrc, closed: &ImageSrc) -> ImageSrc {
    if expanded.get() == Some(true) {
        open.clone()
    } else {
        closed.clone()
    }
}

fn key_badge(row: Row) -> impl IntoElement {
    let kind = computed(move || {
        row.with(|row| {
            row.as_ref()
                .and_then(|row| row.entry.as_ref()?.r#type.clone())
        })
    });
    let label = move || {
        kind.with(|kind| match kind.as_deref() {
            Some("string") => "STR".into(),
            Some("stream") => "STRM".into(),
            Some(kind) => kind.to_uppercase(),
            None => "KEY".into(),
        })
    };
    let class = move || {
        let colors = kind.with(|kind| match kind.as_deref() {
            Some("string") => "bg-type-string/15 text-type-string",
            Some("json") => "bg-success/15 text-success",
            Some("hash") => "bg-type-hash/15 text-type-hash",
            Some("list") => "bg-type-list/15 text-type-list",
            Some("set") => "bg-type-set/15 text-type-set",
            Some("zset") => "bg-type-zset/15 text-type-zset",
            Some("stream") => "bg-type-stream/15 text-type-stream",
            _ => "bg-selected text-muted-foreground",
        });
        Some(
            format!("text-(--text-size-9) font-mono font-semibold px-1 py-0.5 rounded-sm {colors}")
                .into(),
        )
    };
    view()
        .app_class(Some("shrink-0 rounded-sm px-1 py-0.5".into()))
        .child(text(label).app_class(class))
}

fn empty_view(state: Memo<ViewState>, cx: Scope<KeyRowsEvent>) -> impl IntoElement {
    let trigger = view()
        .app_class(Some("flex-1 items-center justify-center gap-2 p-4".into()))
        .child(dynamic(move || {
            let src = if state.with(|state| state.searching) {
                &REFRESH
            } else {
                &SEARCH
            };
            icon((**src).clone(), 24.0, "muted-foreground")
        }))
        .child(
            text(move || {
                t!(state.with(|state| {
                    if state.stopped {
                        "workspace.scanStopped"
                    } else if state.searching {
                        "workspace.searching"
                    } else {
                        "workspace.nothingFound"
                    }
                }))
            })
            .app_class(Some(
                "text-(--text-size-12)/(--line-height-16) text-muted-foreground".into(),
            )),
        );
    tree_menu(state, None, trigger, cx)
}

fn tree_menu(
    state: Memo<ViewState>,
    row: Option<Row>,
    trigger: impl IntoElement,
    cx: Scope<KeyRowsEvent>,
) -> impl IntoElement {
    let empty = row.is_none();
    let contents = dynamic(move || {
        let row = row.and_then(|row| row.get());
        if let Some(entry) = row.as_ref().and_then(|row| row.entry.as_ref()) {
            let disabled =
                entry.uncertain || state.with(|state| state.locked_keys.contains(&entry.id));
            vec![
                command(
                    "workspace-key-copy-name",
                    "workspace.copyKeyName",
                    &COPY,
                    false,
                    false,
                    cx,
                    KeyRowsEvent::CopyName {
                        name: entry.name.clone(),
                    },
                ),
                command(
                    "workspace-key-rename",
                    "workspace.rename",
                    &PENCIL,
                    false,
                    disabled,
                    cx,
                    KeyRowsEvent::RenameKey {
                        id: entry.id.clone(),
                    },
                ),
                separator(),
                command(
                    "workspace-key-delete",
                    "workspace.delete",
                    &TRASH,
                    true,
                    disabled,
                    cx,
                    KeyRowsEvent::DeleteKey {
                        id: entry.id.clone(),
                    },
                ),
            ]
        } else {
            let prefix = row.as_ref().and_then(|row| row.prefix.clone());
            let mut items = vec![command(
                "workspace-key-new",
                "workspace.newKey",
                &PLUS,
                false,
                false,
                cx,
                KeyRowsEvent::CreateKey {
                    prefix: prefix.clone().unwrap_or_default(),
                },
            )];
            if let Some(prefix) = prefix {
                items.push(separator());
                items.push(command(
                    "workspace-folder-delete",
                    "workspace.deleteFolder",
                    &TRASH,
                    true,
                    false,
                    cx,
                    KeyRowsEvent::DeleteFolder { prefix },
                ));
            }
            items
        }
    });
    // An empty tree's menu covers the flexible empty area.
    context_menu()
        .app_class(Some(if empty { "flex-1 min-h-0" } else { "h-7" }.into()))
        .disabled(move || state.with(|state| state.menu_disabled))
        .popup_class(Some(
            "min-w-40 rounded-md border border-border-strong bg-popover p-1 shadow-xl font-sans"
                .into(),
        ))
        .trigger(trigger)
        .child(contents)
}

fn separator() -> AnyElement {
    menu_separator()
        .app_class(Some("h-px my-1 bg-border".into()))
        .into_element()
}

fn command(
    id: &str,
    label: &'static str,
    glyph: &'static ImageSrc,
    destructive: bool,
    disabled: bool,
    cx: Scope<KeyRowsEvent>,
    event: KeyRowsEvent,
) -> AnyElement {
    let tint = if destructive {
        "destructive"
    } else {
        "muted-foreground"
    };
    menu_item()
        .test_id(id)
        .app_class(Some("h-8 px-2.5 flex-row items-center gap-2 rounded text-(--text-size-12)/(--line-height-16) text-foreground hover:bg-accent focus:bg-accent active:bg-selected disabled:opacity-40".into()))
        .disabled(disabled)
        .on_select(move || cx.emit(event.clone()))
        .child(icon(glyph.clone(), 14.0, tint))
        .child(text(move || t!(label)).app_class(destructive.then(|| "text-destructive".into())))
        .into_element()
}

fn icon(src: impl IntoReactive<ImageSrc>, size: f32, tint: &'static str) -> Image {
    image(src)
        .w(px(size))
        .h(px(size))
        .tint_color(move || tokens().color(tint).unwrap_or_default())
}

macro_rules! icons {
    ($($name:ident => $file:literal),+ $(,)?) => {
        $(static $name: LazyLock<ImageSrc> = LazyLock::new(||
            ImageSrc::svg_markup(include_str!(concat!("../assets/icons/", $file, ".svg")))
        );)+
    };
}
icons! {
    DOWN => "chevron-down",
    RIGHT => "chevron-right",
    FOLDER => "folder",
    FOLDER_OPEN => "folder-open",
    REFRESH => "refresh-cw",
    SEARCH => "search",
    COPY => "copy",
    PENCIL => "pencil",
    TRASH => "trash-2",
    PLUS => "plus",
}
