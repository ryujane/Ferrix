import {
  cleanup,
  effect,
  keymap,
  signal,
  Scroll,
  Text,
  token,
  View,
  windowSize,
  type InputRef,
  type ViewRef,
} from "nsh";
import {
  Button,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  Sheet,
} from "nsh/base";
import { Action } from "../../components/action";
import { Icon, type IconName } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { titleBarArea } from "../../utils/window";
import {
  address,
  copyConnection,
  endpoints,
  newConnection,
  normalizeName,
  type SavedConnection,
  type Config,
} from "../../data/connections/connection-model";
import { colors } from "./tag-colors";
import { hubT } from "../../i18n";
import { safeError } from "../../utils/errors";
import { testConnection } from "../../data/connections/connection-client";
import type { ConnectionHub } from "../../data/connections/connection-state";
import { ConnectionDialog } from "./connection-dialog";
import { ErrorText } from "../../components/form-controls";
import { HubAction, HubCount, Modal } from "./hub-controls";
import { OrganizationDialog } from "./organization-dialog";
import { OrganizationPicker, TagChip } from "./organization-fields";
import { SlowlogDialog } from "./slowlog-dialog";
import type { SlowlogSession } from "./slowlog-state";

export function ConnectionHubPage(props: {
  hub: ConnectionHub;
  onOpenWorkspace: () => void;
  openSlowlogSession?: (config: Config) => Promise<SlowlogSession>;
}) {
  const hub = props.hub;
  const search = signal(""),
    filter = signal("all"),
    selected = signal<string>(),
    collapsed = signal<string[]>([]);
  const editor = signal<{ value: SavedConnection; editing: boolean }>(),
    manager = signal<"group" | "tag">(),
    deleting = signal<SavedConnection>(),
    closing = signal<SavedConnection>();
  const slowlogConnection = signal<SavedConnection>();
  const managerCreate = signal(false);
  const detailOpen = signal(false),
    mobileSidebar = signal(false),
    detailTest = signal(""),
    testing = signal(false);
  let searchInput: InputRef | undefined,
    detailCloseButton: ViewRef | undefined,
    testRevision = 0;
  const rowRefs = new Map<string, ViewRef>();
  const rowMenuRefs = new Map<string, ViewRef>();
  const focusedRow = signal<string>();
  cleanup(() => {
    ++testRevision;
  });
  const active = () => hub.data().connections.find((c) => c.id === selected());
  const narrow = () => windowSize().width <= 760;
  const filtered = () =>
    hub.data().connections.filter((c) => {
      const d = hub.data(),
        q = normalizeName(search());
      if (filter() === "favorites" && !c.favorite) return false;
      if (
        filter().startsWith("group:") &&
        c.groupId !== (filter().slice(6) || null)
      )
        return false;
      if (filter().startsWith("tag:") && !c.tagIds.includes(filter().slice(4)))
        return false;
      return normalizeName(
        [
          c.name,
          c.config.mode,
          ...endpoints(c.config).map(address),
          d.groups.find((g) => g.id === c.groupId)?.name ?? "",
          ...c.tagIds.map((id) => d.tags.find((t) => t.id === id)?.name ?? ""),
        ].join(" "),
      ).includes(q);
    });
  const groups = () =>
    [...hub.data().groups, { id: "", name: hubT("ungrouped") }]
      .map((g) => ({
        ...g,
        connections: filtered().filter((c) => (c.groupId ?? "") === g.id),
      }))
      .filter((g) => g.connections.length);
  const scopeName = () =>
    filter().startsWith("group:")
      ? ([...hub.data().groups, { id: "", name: hubT("ungrouped") }].find(
          (g) => g.id === filter().slice(6),
        )?.name ?? hubT("allConnections"))
      : filter().startsWith("tag:")
        ? (hub.data().tags.find((t) => t.id === filter().slice(4))?.name ??
          hubT("allConnections"))
        : hubT(filter() === "favorites" ? "favorites" : "allConnections");
  const choose = (id: string) => {
    selected.set(id);
    detailTest.set("");
    ++testRevision;
    detailOpen.set(true);
  };
  const chooseScope = (id: string) => {
    filter.set(id);
    collapsed.set([]);
    mobileSidebar.set(false);
  };
  effect(() => {
    if (!selected() && hub.data().connections.length)
      selected.set(hub.data().connections[0].id);
  });
  const add = (groupId?: string) =>
    editor.set({
      value: newConnection(
        (groupId ??
          (filter().startsWith("group:") ? filter().slice(6) : null)) ||
          null,
      ),
      editing: false,
    });
  const connect = async (c: SavedConnection) => {
    if (await hub.connect(c)) props.onOpenWorkspace();
  };
  const connected = (id: string) => hub.live().some((item) => item.id === id);
  const dismissClose = () => {
    const id = closing()?.id;
    closing.set(undefined);
    if (detailOpen()) detailCloseButton?.focus();
    else if (id) rowMenuRefs.get(id)?.focus();
  };
  async function runTest(c: SavedConnection) {
    if (testing()) return;
    const current = ++testRevision;
    testing.set(true);
    detailTest.set(hubT("testing"));
    try {
      await testConnection(c.config);
      if (current === testRevision) detailTest.set(hubT("testSuccess"));
    } catch (cause) {
      if (current === testRevision) detailTest.set(safeError(cause));
    } finally {
      testing.set(false);
    }
  }
  const dialogOpen = () =>
    !!editor() ||
    !!manager() ||
    !!deleting() ||
    !!closing() ||
    !!slowlogConnection() ||
    mobileSidebar();
  const modalOpen = () => dialogOpen() || detailOpen();
  keymap.bind("mod+k", () => {
    if (!modalOpen()) searchInput?.focus();
  });
  keymap.bind("mod+n", () => {
    if (!modalOpen() && hub.available()) add();
  });
  for (const [key, delta] of [
    ["down", 1],
    ["up", -1],
  ] as const)
    keymap.bind(
      key,
      () => {
        if (modalOpen() || !focusedRow()) return;
        const rows = groups().flatMap((g) =>
          collapsed().includes(g.id) ? [] : g.connections,
        );
        if (!rows.length) return;
        const index = rows.findIndex((c) => c.id === selected());
        const next =
          rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
        choose(next.id);
        rowRefs.get(next.id)?.focus();
        rowRefs.get(next.id)?.reveal({ animated: false });
      },
      { when: "notEditing", repeat: true, passThrough: true },
    );
  keymap.bind(
    "enter",
    () => {
      if (!modalOpen() && focusedRow() && active())
        void connect(copyConnection(active()!));
    },
    { when: "notEditing", passThrough: true },
  );
  const side = (
    label: string,
    id: string,
    count: number,
    icon: IconName,
    color?: string,
  ) => (
    <Button
      testID={`hub-filter-${id}`}
      accessibilityLabel={label}
      selected={filter() === id}
      onPress={() => chooseScope(id)}
      class={`relative h-10 px-3 flex-row gap-3 items-center rounded active:opacity-70 focus:ring-1 focus:ring-ring ${filter() === id ? "bg-selected" : "hover:bg-accent"}`}
    >
      {filter() === id &&
        (id.startsWith("group:") || id.startsWith("tag:")) && (
          <View
            class="absolute left-0 top-0 bottom-0 w-1 rounded-l bg-primary"
            style={{ pointerEvents: "none" }}
          />
        )}
      <Icon
        name={icon}
        size={16}
        color={color ?? token(filter() === id ? "primary" : "muted-foreground")}
      />
      <Text class="flex-1 text-(--text-size-12)/(--line-height-16) text-foreground">{label}</Text>
      <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">{count}</Text>
    </Button>
  );
  const sidebar = () => (
    <View testID="hub-sidebar" class="flex-1 min-h-0 px-3 pt-5 pb-5">
      <View class="pb-5 border-b border-border gap-1">
        {side(
          hubT("allConnections"),
          "all",
          hub.data().connections.length,
          "database",
        )}
        {side(
          hubT("favorites"),
          "favorites",
          hub.data().connections.filter((c) => c.favorite).length,
          "star",
        )}
      </View>
      <Scroll class="flex-1 min-h-0">
        <View>
          <View class="pt-4 pb-5 border-b border-border">
            <View class="flex-row h-10 items-center pl-1">
              <Text class="flex-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                {hubT("groups")}
              </Text>
              <IconButton
                label={hubT("newGroup")}
                icon="plus"
                size={28}
                onPress={() => {
                  managerCreate.set(true);
                  manager.set("group");
                }}
              />
              <IconButton
                label={hubT("manageGroups")}
                icon="ellipsis"
                size={28}
                onPress={() => manager.set("group")}
              />
            </View>
            {hub
              .data()
              .groups.map((g) =>
                side(
                  g.name,
                  `group:${g.id}`,
                  hub.data().connections.filter((c) => c.groupId === g.id)
                    .length,
                  "folder",
                ),
              )}
            {side(
              hubT("ungrouped"),
              "group:",
              hub.data().connections.filter((c) => !c.groupId).length,
              "folder",
            )}
          </View>
          <View class="pt-4">
            <View class="flex-row h-10 items-center pl-1">
              <Text class="flex-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                {hubT("tags")}
              </Text>
              <IconButton
                label={hubT("newTag")}
                icon="plus"
                size={28}
                onPress={() => {
                  managerCreate.set(true);
                  manager.set("tag");
                }}
              />
              <IconButton
                label={hubT("manageTags")}
                icon="ellipsis"
                size={28}
                onPress={() => manager.set("tag")}
              />
            </View>
            {hub
              .data()
              .tags.map((t) =>
                side(
                  t.name,
                  `tag:${t.id}`,
                  hub.data().connections.filter((c) => c.tagIds.includes(t.id))
                    .length,
                  "tag",
                  colors[t.color],
                ),
              )}
            {!hub.data().tags.length && (
              <Button
                onPress={() => manager.set("tag")}
                class="h-10 px-3 active:opacity-70"
              >
                <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                  {hubT("createFirstTag")}
                </Text>
              </Button>
            )}
          </View>
        </View>
      </Scroll>
      <HubAction
        testID="hub-manage-organization"
        label={hubT("manageOrganization")}
        icon="settings"
        ghost
        onPress={() => manager.set("group")}
      />
    </View>
  );
  const summary = (c: SavedConnection) =>
    c.config.mode === "Cluster"
      ? `${c.config.clusterNodes.length} seeds`
      : c.config.mode === "Sentinel"
        ? `master: ${c.config.master}`
        : address(endpoints(c.config)[0]);
  return (
    <View testID="connection-hub" class="flex-1 min-h-0 bg-workspace font-sans">
      <View
        testID="hub-header"
        class="h-12 shrink-0 px-4 border-b border-border gap-6 flex-row items-center"
      >
        <View class="flex-1 flex-row items-center gap-3">
          <Icon name="network" size={18} color={token("primary")} />
          <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {hubT("title")}
          </Text>
        </View>
        <View class="flex-row items-center gap-6">
          <View
            class={`h-8 flex-row items-center gap-2 px-3 rounded bg-inset ${narrow() ? "flex-1" : "w-92.5"}`}
          >
            <Icon name="search" size={13} />
            <Input
              ref={(node) => {
                searchInput = node;
              }}
              testID="hub-search"
              accessibilityLabel={hubT("search")}
              placeholder={hubT("search")}
              value={search()}
              onChange={({ value }) => search.set(value)}
              autoCapitalize="none"
              autoCorrect={false}
              class="flex-1 min-w-0 text-(--text-size-12)/(--line-height-16) text-foreground"
            />
            {search() ? (
              <IconButton
                label={hubT("clearFilters")}
                icon="close"
                size={24}
                onPress={() => search.set("")}
              />
            ) : (
              <Text class="text-(--text-size-10) font-mono text-faint px-1">⌘K</Text>
            )}
          </View>
          <HubAction
            testID="hub-new-connection"
            label={hubT("newConnection")}
            icon="plus"
            primary
            height={32}
            disabled={hub.loading() || !hub.available()}
            onPress={() => add()}
          />
        </View>
      </View>
      <If when={!!hub.error()}>
        <View class="px-5 py-3 flex-row items-center gap-3 border-b border-border bg-destructive/10">
          <View class="flex-1">
            <ErrorText message={safeError(hub.error())} />
          </View>
          <Action label={hubT("reload")} onPress={() => void hub.reload()} />
          <IconButton
            label={hubT("close")}
            icon="close"
            onPress={hub.clearError}
          />
        </View>
      </If>
      <View class="flex-1 min-h-0 flex-row">
        {windowSize().width > 1000 && (
          <View
            style={{ width: windowSize().width > 1250 ? 228 : 190 }}
            class="shrink-0 border-r border-border"
          >
            {sidebar()}
          </View>
        )}
        <View testID="hub-list" class="flex-1 min-w-0 min-h-0 px-5">
          <View class="h-16 flex-row items-center gap-2 border-b border-border">
            {windowSize().width <= 1000 && (
              <Button
                testID="hub-show-sidebar"
                accessibilityLabel={hubT("organization")}
                onPress={() => mobileSidebar.set(true)}
                class="w-8 h-8 items-center justify-center hover:bg-accent"
              >
                <Icon name="sliders" size={18} />
              </Button>
            )}
            <Text
              testID="hub-scope-title"
              class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground"
            >
              {scopeName()}
            </Text>
            <HubCount count={filtered().length} />
            {filter() !== "all" && (
              <IconButton
                label={hubT("clearFilters")}
                icon="close"
                size={24}
                onPress={() => chooseScope("all")}
              />
            )}
            <View class="flex-1" />
            <Popover
              align="end"
              popupClass="p-2 rounded border border-border bg-panel"
              trigger={
                <View
                  testID="hub-list-options"
                  accessibilityLabel={hubT("listOptions")}
                  class="h-8 w-8 items-center justify-center"
                >
                  <Icon name="sliders" size={18} />
                </View>
              }
            >
              <HubAction
                label={hubT("expandAll")}
                ghost
                onPress={() => collapsed.set([])}
              />
              <HubAction
                label={hubT("collapseAll")}
                ghost
                onPress={() => collapsed.set(groups().map((g) => g.id))}
              />
              <HubAction
                label={hubT("manageOrganization")}
                ghost
                onPress={() => manager.set("group")}
              />
            </Popover>
          </View>
          {hub.loading() ? (
            <View class="flex-1 items-center justify-center">
              <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                {hubT("loading")}
              </Text>
            </View>
          ) : !filtered().length ? (
            <View class="flex-1 items-center justify-center p-8 gap-4">
              <Icon name="network" size={40} />
              <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                {hubT(
                  hub.data().connections.length ? "noResults" : "emptyTitle",
                )}
              </Text>
              <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                {hubT(
                  hub.data().connections.length ? "noResultsHint" : "emptyHint",
                )}
              </Text>
              <HubAction
                label={hubT(
                  hub.data().connections.length
                    ? "clearFilters"
                    : "newConnection",
                )}
                primary
                onPress={() => {
                  if (hub.data().connections.length) {
                    chooseScope("all");
                    search.set("");
                  } else add();
                }}
              />
            </View>
          ) : (
            <Scroll testID="hub-connections-scroll" class="flex-1 min-h-0">
              <View>
                {groups().map((group) => (
                  <View class="mb-3">
                    <View class="h-[57px] flex-row items-center border-b border-border">
                      <Button
                        accessibilityLabel={group.name}
                        onPress={() =>
                          collapsed.set(
                            collapsed().includes(group.id)
                              ? collapsed().filter((id) => id !== group.id)
                              : [...collapsed(), group.id],
                          )
                        }
                        class="flex-1 h-full flex-row items-center gap-2 active:opacity-70"
                      >
                        <Icon
                          name={
                            collapsed().includes(group.id) ? "right" : "down"
                          }
                          size={17}
                          color={token("foreground")}
                        />
                        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                          {group.name}
                        </Text>
                        <HubCount count={group.connections.length} />
                      </Button>
                      <IconButton
                        label={`${hubT("newConnection")} · ${group.name}`}
                        icon="plus"
                        onPress={() => add(group.id)}
                      />
                      <IconButton
                        label={`${hubT("manageGroups")} · ${group.name}`}
                        icon="ellipsis"
                        onPress={() => manager.set("group")}
                      />
                    </View>
                    {!collapsed().includes(group.id) &&
                      group.connections.map((c) => (
                        <View
                          testID={`hub-row-${c.id}`}
                          class={`relative h-[65px] flex-row items-center pl-1 gap-3 ${selected() === c.id ? "bg-selected rounded" : "border-b border-border hover:bg-accent"}`}
                        >
                          {selected() === c.id && (
                            <View
                              class="absolute left-0 top-0 bottom-0 w-1 rounded-l bg-primary"
                              style={{ pointerEvents: "none" }}
                            />
                          )}
                          <Button
                            accessibilityLabel={`${hubT(c.favorite ? "unfavorite" : "favorite")} ${c.name}`}
                            onPress={() => void hub.toggleFavorite(c.id)}
                            class="h-8 w-8 shrink-0 items-center justify-center active:opacity-60"
                          >
                            <Icon
                              name={c.favorite ? "starFilled" : "star"}
                              size={16}
                              color={
                                c.favorite
                                  ? token("chart-3")
                                  : token("muted-foreground")
                              }
                            />
                          </Button>
                          <Icon name="database" size={16} />
                          <View
                            ref={(node) => rowRefs.set(c.id, node)}
                            accessibilityLabel={`${hubT("selectConnection")} ${c.name}`}
                            testID={`connection-row-${c.id}`}
                            role="button"
                            focusable
                            accessibilityState={{
                              selected: selected() === c.id,
                            }}
                            onFocus={() => focusedRow.set(c.id)}
                            onBlur={() => {
                              if (focusedRow() === c.id)
                                focusedRow.set(undefined);
                            }}
                            onPress={({ clickCount }) => {
                              if (clickCount === 2) {
                                void connect(c);
                                return;
                              }
                              choose(c.id);
                              focusedRow.set(c.id);
                              rowRefs.get(c.id)?.focus();
                            }}
                            class="flex-1 min-w-0 h-full justify-center pr-1 active:opacity-80 focus-visible:ring-1 focus-visible:ring-primary"
                          >
                            <View class="flex-row items-center gap-2">
                              <Text class="flex-1 min-w-0 line-clamp-1 text-(--text-size-13) font-medium text-foreground">
                                {c.name}
                              </Text>
                              <Text
                                class={`shrink-0 text-(--text-size-12)/(--line-height-16) ${connected(c.id) ? "text-success" : "text-muted-foreground"}`}
                              >
                                {hubT(
                                  connected(c.id)
                                    ? "connected"
                                    : "disconnected",
                                )}
                              </Text>
                            </View>
                            <View class="flex-row flex-wrap items-center gap-1.5 mt-1">
                              <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                                {c.config.mode} ·
                              </Text>
                              <Text class="text-(--text-size-12)/(--line-height-16) font-mono text-foreground">
                                {summary(c)}
                              </Text>
                              {c.tagIds.slice(0, 2).map((id) => {
                                const tag = hub
                                  .data()
                                  .tags.find((t) => t.id === id);
                                return tag && <TagChip tag={tag} compact />;
                              })}
                              {c.tagIds.length > 2 && (
                                <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                                  +{c.tagIds.length - 2}
                                </Text>
                              )}
                            </View>
                          </View>
                          <View class="shrink-0 pr-2">
                            <Menu
                              align="end"
                              popupClass="min-w-40 rounded-md border border-border-strong bg-popover p-1 shadow-xl font-sans"
                              trigger={
                                <View
                                  ref={(node) => rowMenuRefs.set(c.id, node)}
                                  testID={`hub-row-more-${c.id}`}
                                  accessibilityLabel={`${hubT("moreActions")} · ${c.name}`}
                                  class="h-8 w-8 items-center justify-center rounded hover:bg-accent active:opacity-60 focus:ring-1 focus:ring-ring"
                                >
                                  <Icon name="ellipsis" size={16} />
                                </View>
                              }
                            >
                              <MenuItem
                                testID={`hub-query-slowlog-${c.id}`}
                                class="h-8 px-2.5 flex-row items-center gap-2 rounded text-(--text-size-12)/(--line-height-16) text-foreground hover:bg-accent focus:bg-accent active:bg-selected"
                                onSelect={() =>
                                  slowlogConnection.set(copyConnection(c))
                                }
                              >
                                <Icon name="timer" size={14} />
                                <Text>{hubT("slowlogQuery")}</Text>
                              </MenuItem>
                              <If when={connected(c.id)}>
                                <MenuSeparator class="h-px my-1 bg-border" />
                                <MenuItem
                                  testID={`hub-close-connection-${c.id}`}
                                  disabled={hub.connecting().includes(c.id)}
                                  class="h-8 px-2.5 flex-row items-center gap-2 rounded text-(--text-size-12)/(--line-height-16) text-foreground hover:bg-accent focus:bg-accent active:bg-selected disabled:opacity-40"
                                  onSelect={() => closing.set(c)}
                                >
                                  <Icon name="close" size={14} />
                                  <Text>{hubT("closeConnection")}</Text>
                                </MenuItem>
                              </If>
                            </Menu>
                          </View>
                        </View>
                      ))}
                  </View>
                ))}
              </View>
            </Scroll>
          )}
          <View class="h-[46px] flex-row items-center gap-2">
            <Text class="text-(--text-size-10) text-muted-foreground">
              {hubT("listShortcuts")}
            </Text>
            <View class="flex-1" />
            <Text class="text-(--text-size-10) text-muted-foreground">
              {hubT("connectionCount", { count: filtered().length })}
            </Text>
          </View>
        </View>
      </View>
      {/* Suspend the drawer's overlays while a native dialog owns input. */}
      <View
        style={{
          display: dialogOpen() ? "none" : "flex",
          pointerEvents: "box-none",
        }}
      >
        <Sheet
          open={detailOpen() && !!active()}
          side="right"
          onOpenChange={({ open }) => detailOpen.set(open)}
          onOpen={() => {
            if (!dialogOpen()) detailCloseButton?.focus();
          }}
          onClose={() => {
            if (!modalOpen() && selected()) rowRefs.get(selected()!)?.focus();
          }}
          popupClass="bg-workspace border-l border-border shadow-xl font-sans"
          popupStyle={{
            width: Math.min(480, windowSize().width - 24),
            top: titleBarArea().height,
          }}
          backdropClass="bg-black/35"
          backdropStyle={{ top: titleBarArea().height }}
        >
          <View
            testID="hub-detail"
            role="dialog"
            accessibilityLabel={active()?.name}
            class="flex-1 min-w-0 min-h-0 px-6 pb-6"
          >
            <If when={!!active()}>
              <View class="h-16 shrink-0 flex-row items-center gap-2 border-b border-border">
                <Text class="flex-1 min-w-0 line-clamp-1 text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                  {active()!.name}
                </Text>
                <Text class="rounded bg-selected px-1.5 py-1 text-(--text-size-10) font-mono text-muted-foreground">
                  {active()!.config.mode}
                </Text>
                <IconButton
                  label={hubT("editConnection")}
                  icon="pencil"
                  color={token("muted-foreground")}
                  onPress={() =>
                    editor.set({
                      value: copyConnection(active()!),
                      editing: true,
                    })
                  }
                />
                <IconButton
                  label={hubT("deleteConnection")}
                  icon="trash"
                  size={26}
                  color={token("muted-foreground")}
                  onPress={() => deleting.set(active())}
                />
                <Button
                  ref={(node) => {
                    detailCloseButton = node;
                  }}
                  testID="hub-close-detail"
                  accessibilityLabel={hubT("close")}
                  onPress={() => detailOpen.set(false)}
                  class="h-10 w-10 shrink-0 items-center justify-center rounded hover:bg-accent active:opacity-60 focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Icon name="close" size={18} />
                </Button>
              </View>
              <Scroll class="flex-1 min-h-0">
                <View>
                  {endpoints(active()!.config).map((node, i) => (
                    <Detail
                      label={hubT("address") + (i ? ` ${i + 1}` : "")}
                      value={node.host}
                    />
                  ))}
                  <Detail
                    label={hubT("port")}
                    value={endpoints(active()!.config)
                      .map((n) => n.port)
                      .join(", ")}
                  />
                  {active()!.config.mode === "Sentinel" && (
                    <Detail
                      label={hubT("master")}
                      value={active()!.config.master}
                    />
                  )}
                  <Detail
                    label={hubT("database")}
                    value={`DB ${active()!.config.database}`}
                  />
                  <Detail
                    label={hubT("securityTls")}
                    value={hubT(
                      active()!.config.dataTls?.enabled
                        ? "enabled"
                        : "disabled",
                    )}
                    plain
                  />
                  <Detail
                    label={hubT("access")}
                    value={hubT(
                      active()!.config.ssh?.enabled ? "ssh" : "direct",
                    )}
                    plain
                  />
                  <View class="mt-6 pt-5 pb-5 border-t border-border gap-5">
                    <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
                      {hubT("organization")}
                    </Text>
                    <View class="flex-row items-center gap-4">
                      <Text class="w-[105px] text-(--text-size-13) font-medium text-foreground">
                        {hubT("group")}
                      </Text>
                      <View class="flex-1 min-w-0">
                        <OrganizationPicker
                          hub={hub}
                          kind="group"
                          detail
                          groupId={active()!.groupId}
                          tagIds={active()!.tagIds}
                          onChange={(change) =>
                            void hub.update(active()!.id, change)
                          }
                        />
                      </View>
                    </View>
                    <View class="flex-row items-start gap-4">
                      <Text class="w-[105px] pt-1 text-(--text-size-13) font-medium text-foreground">
                        {hubT("tags")}
                      </Text>
                      <View class="flex-1 min-w-0 gap-2">
                        <View class="flex-row flex-wrap gap-1">
                          {active()!.tagIds.map((id) => {
                            const tag = hub
                              .data()
                              .tags.find((t) => t.id === id);
                            return (
                              tag && (
                                <TagChip
                                  tag={tag}
                                  compact
                                  onRemove={() =>
                                    void hub.update(active()!.id, {
                                      tagIds: active()!.tagIds.filter(
                                        (t) => t !== id,
                                      ),
                                    })
                                  }
                                />
                              )
                            );
                          })}
                        </View>
                        <OrganizationPicker
                          hub={hub}
                          kind="tag"
                          groupId={active()!.groupId}
                          tagIds={active()!.tagIds}
                          onChange={(change) =>
                            void hub.update(active()!.id, change)
                          }
                          detail
                        />
                        <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                          {hubT("organizationHint")}
                        </Text>
                      </View>
                    </View>
                  </View>
                </View>
              </Scroll>
              <View class="pt-4 gap-3 shrink-0">
                <View class="flex-row gap-2">
                  <View class="flex-1 min-w-0">
                    <HubAction
                      testID="hub-open-workspace"
                      primary
                      full
                      height={44}
                      label={hubT(
                        hub.connecting().includes(active()!.id)
                          ? "connecting"
                          : connected(active()!.id)
                            ? "openWorkspace"
                            : "connectOpen",
                      )}
                      disabled={hub.connecting().includes(active()!.id)}
                      onPress={() => void connect(active()!)}
                    />
                  </View>
                </View>
              </View>
            </If>
          </View>
        </Sheet>
      </View>
      {mobileSidebar() && (
        <Modal
          id="hub-sidebar-dialog"
          title={hubT("organization")}
          width={380}
          height={640}
          onClose={() => mobileSidebar.set(false)}
        >
          {sidebar()}
        </Modal>
      )}
      <If when={!!slowlogConnection()}>
        <SlowlogDialog
          connection={slowlogConnection()!}
          openSession={props.openSlowlogSession}
          onClose={() => {
            const id = slowlogConnection()?.id;
            slowlogConnection.set(undefined);
            if (detailOpen()) detailCloseButton?.focus();
            else if (id) rowMenuRefs.get(id)?.focus();
          }}
        />
      </If>
      {editor() && (
        <ConnectionDialog
          hub={hub}
          value={editor()!.value}
          editing={editor()!.editing}
          onClose={() => editor.set(undefined)}
          onConnected={props.onOpenWorkspace}
          onSaved={choose}
        />
      )}
      {manager() && (
        <OrganizationDialog
          hub={hub}
          initial={manager()!}
          initialCreate={managerCreate()}
          onClose={() => {
            manager.set(undefined);
            managerCreate.set(false);
            if (
              !hub.data().groups.some((g) => `group:${g.id}` === filter()) &&
              !hub.data().tags.some((t) => `tag:${t.id}` === filter()) &&
              !["all", "favorites", "group:"].includes(filter())
            )
              filter.set("all");
          }}
        />
      )}
      {deleting() && (
        <Modal
          alert
          id="connection-delete"
          title={hubT("deleteConnection")}
          description={hubT("deleteConnectionHint")}
          width={440}
          height={310}
          onClose={() => deleting.set(undefined)}
        >
          <View class="flex-1 p-5 gap-4">
            <Text class="text-(--text-size-13) font-medium text-foreground">
              {deleting()!.name}
            </Text>
            <Text class="text-(--text-size-12)/(--line-height-16) text-faint">{hubT("sessionsUnaffected")}</Text>
          </View>
          <View class="p-4 flex-row justify-end gap-2 border-t border-border">
            <Action
              label={hubT("cancel")}
              onPress={() => deleting.set(undefined)}
            />
            <Action
              label={hubT("delete")}
              primary
              onPress={() =>
                void hub.remove(deleting()!.id).then((ok) => {
                  if (ok) {
                    detailOpen.set(false);
                    selected.set(undefined);
                    deleting.set(undefined);
                  }
                })
              }
            />
          </View>
        </Modal>
      )}
      {closing() && (
        <Modal
          alert
          id="connection-close"
          title={hubT("closeConnection")}
          width={440}
          height={300}
          onClose={dismissClose}
        >
          <View class="flex-1 px-8 gap-3">
            <Text class="text-(--text-size-13) font-medium text-foreground">
              {closing()!.name}
            </Text>
            <Text class="text-(--text-size-12) leading-(--line-height-20) text-muted-foreground">
              {hubT("closeConnectionHint")}
            </Text>
          </View>
          <View class="p-4 flex-row justify-end gap-2 border-t border-border">
            <Action
              testID="connection-close-cancel"
              label={hubT("cancel")}
              onPress={dismissClose}
            />
            <Action
              testID="connection-close-confirm"
              label={hubT("closeConnection")}
              primary
              onPress={() => {
                hub.disconnect(closing()!.id);
                dismissClose();
              }}
            />
          </View>
        </Modal>
      )}
    </View>
  );
}
function Detail(props: { label: string; value: string; plain?: boolean }) {
  return (
    <View class="min-h-10 py-2 px-1 flex-row items-center gap-[15px] border-b border-border">
      <Text class="w-[125px] text-(--text-size-13) font-medium text-foreground">
        {props.label}
      </Text>
      <Text
        class={`flex-1 min-w-0 text-(--text-size-12)/(--line-height-16) text-foreground ${props.plain ? "" : "font-mono"}`}
      >
        {props.value}
      </Text>
    </View>
  );
}
