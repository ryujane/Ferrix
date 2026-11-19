import { signal, Scroll, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import { IconButton } from "../../components/icon-button";
import { hubT } from "../../i18n";
import { colors } from "./tag-colors";
import {
  normalizeName,
  organizationError,
  type Group,
  type Tag,
  type TagColor,
} from "../../data/connections/connection-model";
import type { ConnectionHub } from "../../data/connections/connection-state";
import {
  ErrorText,
  compactInputClass as inputClass,
  Segments,
} from "../../components/form-controls";
import { HubAction, Modal } from "./hub-controls";
import { ColorPicker } from "./organization-fields";

export function OrganizationDialog(props: {
  hub: ConnectionHub;
  initial: "group" | "tag";
  initialCreate?: boolean;
  onClose: () => void;
}) {
  const tab = signal<string>(props.initial),
    name = signal(""),
    error = signal(""),
    color = signal<TagColor>("blue");
  const creating = signal(props.initialCreate ?? false),
    search = signal("");
  const deleting = signal<Group>(),
    hub = props.hub;
  const items = () => (tab() === "group" ? hub.data().groups : hub.data().tags);
  const visibleItems = () =>
    items().filter((item) =>
      normalizeName(item.name).includes(normalizeName(search())),
    );
  const count = (id: string) =>
    hub
      .data()
      .connections.filter((c) =>
        tab() === "group" ? (c.groupId ?? "") === id : c.tagIds.includes(id),
      ).length;
  const affected = () =>
    hub
      .data()
      .connections.filter((c) =>
        tab() === "group"
          ? c.groupId === deleting()?.id
          : c.tagIds.includes(deleting()?.id ?? ""),
      );
  async function create() {
    const issue = organizationError(name(), items());
    if (issue) {
      error.set(issue);
      return;
    }
    const id = await hub.createOrganization(
      tab() as "group" | "tag",
      name(),
      color(),
    );
    if (id) {
      name.set("");
      creating.set(false);
      error.set("");
    }
  }
  async function remove() {
    const id = deleting()?.id;
    if (!id) return;
    const ok = await hub.mutate((d) => {
      if (tab() === "group") {
        d.groups = d.groups.filter((g) => g.id !== id);
        d.connections.forEach((c) => {
          if (c.groupId === id) c.groupId = null;
        });
      } else {
        d.tags = d.tags.filter((t) => t.id !== id);
        d.connections.forEach((c) => {
          c.tagIds = c.tagIds.filter((t) => t !== id);
        });
      }
    });
    if (ok) deleting.set(undefined);
  }
  return (
    <Modal
      id="organization-dialog"
      title={hubT("manageOrganization")}
      description={hubT("managerDescription")}
      width={800}
      height={576}
      headerHeight={80}
      headerPaddingTop={16}
      onClose={props.onClose}
    >
      <View class="px-8">
        <Segments
          id="organization-tab"
          variant="line"
          value={tab()}
          items={[
            {
              value: "group",
              title: `${hubT("groups")} ${hub.data().groups.length}`,
            },
            {
              value: "tag",
              title: `${hubT("tags")} ${hub.data().tags.length}`,
            },
          ]}
          onChange={(value) => {
            tab.set(value);
            error.set("");
            name.set("");
            search.set("");
            creating.set(false);
          }}
        />
      </View>
      <View class="mx-8 py-3 flex-row items-center gap-4">
        <View class="flex-1 max-w-[340px] h-9 px-3 flex-row items-center gap-2 rounded bg-inset">
          <Icon name="search" size={16} />
          <Input
            testID="organization-search"
            accessibilityLabel={hubT(
              tab() === "group" ? "searchGroups" : "searchTags",
            )}
            placeholder={hubT(
              tab() === "group" ? "searchGroups" : "searchTags",
            )}
            value={search()}
            onChange={({ value }) => search.set(value)}
            class="flex-1 min-w-0 text-(--text-size-12)/(--line-height-16) text-foreground"
          />
        </View>
        <View class="flex-1" />
        <HubAction
          testID="organization-new"
          primary
          label={hubT(tab() === "group" ? "newGroup" : "newTag")}
          icon="plus"
          onPress={() => {
            creating.set(true);
            name.set("");
            error.set("");
          }}
        />
      </View>
      <View class="mx-8 h-8 px-2.5 flex-row gap-3 items-center border-b border-border">
        <Text class="flex-1 text-(--text-size-12)/(--line-height-16) text-muted-foreground">
          {hubT(tab() === "group" ? "groupName" : "tagName")}
        </Text>
        <Text class="w-[90px] text-(--text-size-12)/(--line-height-16) text-muted-foreground">
          {hubT("connectionNumber")}
        </Text>
        <Text class="w-[146px] text-(--text-size-12)/(--line-height-16) text-muted-foreground">
          {hubT("actions")}
        </Text>
      </View>
      <Scroll class="flex-1 min-h-0 mx-8">
        <View>
          {creating() && (
            <View class="py-3 gap-3 border-b border-border">
              <View class="flex-row items-center gap-3">
                <Input
                  testID="organization-new-name"
                  accessibilityLabel={hubT("name")}
                  placeholder={hubT(tab() === "group" ? "newGroup" : "newTag")}
                  value={name()}
                  onChange={({ value }) => {
                    name.set(value);
                    error.set("");
                  }}
                  onSubmit={() => void create()}
                  maxLength={30}
                  autoFocus
                  class={`flex-1 ${inputClass}`}
                />
                <HubAction
                  label={hubT("cancel")}
                  ghost
                  onPress={() => creating.set(false)}
                />
                <HubAction
                  testID="organization-create"
                  label={hubT("save")}
                  primary
                  disabled={hub.saving()}
                  onPress={() => void create()}
                />
              </View>
              {tab() === "tag" && (
                <ColorPicker value={color()} onChange={color.set} />
              )}
              <ErrorText message={error() || hub.error()} />
            </View>
          )}
          <Each of={visibleItems()} key={(item) => `${tab()}:${item.id}`}>
            {(item) => (
              <OrganizationRow
                item={item()}
                kind={tab() as "group" | "tag"}
                hub={hub}
                onDelete={() => deleting.set(item())}
              />
            )}
          </Each>
          {!visibleItems().length && (
            <View class="py-10 items-center gap-3">
              <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                {hubT(
                  search()
                    ? "noOrganizationResults"
                    : tab() === "group"
                      ? "noGroups"
                      : "noTags",
                )}
              </Text>
            </View>
          )}
          {tab() === "group" &&
            normalizeName(hubT("ungrouped")).includes(
              normalizeName(search()),
            ) && (
              <View class="min-h-14 px-2.5 flex-row gap-3 items-center border-b border-border">
                <View class="flex-1 flex-row gap-[18px] items-center">
                  <Icon name="folder" size={18} />
                  <Text class="text-(--text-size-13) font-medium text-foreground">
                    {hubT("ungrouped")}
                  </Text>
                </View>
                <Text class="w-[90px] text-(--text-size-12)/(--line-height-16) text-foreground">
                  {count("")}
                </Text>
                <Text class="w-[146px] text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                  {hubT("defaultGroup")}
                </Text>
              </View>
            )}
        </View>
      </Scroll>
      <View class="mx-8 pt-2 pb-1 px-0.5">
        <Text class="text-(--text-size-12) leading-(--line-height-18) text-muted-foreground">
          {hubT(tab() === "group" ? "managerGroupHint" : "managerTagHint")}
        </Text>
      </View>
      <View class="mx-8 mt-3 h-16 flex-row items-center gap-3 border-t border-border">
        <Text class="flex-1 text-(--text-size-12)/(--line-height-16) text-muted-foreground">
          {hubT("changesSaved")}
        </Text>
        <HubAction label={hubT("done")} onPress={props.onClose} />
      </View>
      {deleting() && (
        <Modal
          alert
          id="organization-delete"
          title={hubT(tab() === "group" ? "deleteGroup" : "deleteTag")}
          description={hubT(
            tab() === "group" ? "deleteGroupHint" : "deleteTagHint",
          )}
          width={470}
          height={400}
          onClose={() => deleting.set(undefined)}
        >
          <View class="flex-1 p-5 gap-4">
            <Text class="text-(--text-size-13) font-medium text-foreground">
              {deleting()!.name}
            </Text>
            <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
              {hubT("affected", { count: affected().length })}
            </Text>
            <Scroll class="flex-1">
              <View class="gap-2">
                {affected().map((c) => (
                  <Text class="text-(--text-size-12)/(--line-height-16) text-foreground">{c.name}</Text>
                ))}
              </View>
            </Scroll>
            <Text class="text-(--text-size-12)/(--line-height-16) text-faint">{hubT("sessionsUnaffected")}</Text>
          </View>
          <View class="flex-row justify-end gap-2 p-4 border-t border-border">
            <Action
              label={hubT("cancel")}
              onPress={() => deleting.set(undefined)}
            />
            <Action
              testID="confirm-organization-delete"
              label={hubT("delete")}
              primary
              disabled={hub.saving()}
              onPress={() => void remove()}
            />
          </View>
        </Modal>
      )}
    </Modal>
  );
}
function OrganizationRow(props: {
  item: Group | Tag;
  kind: "group" | "tag";
  hub: ConnectionHub;
  onDelete: () => void;
}) {
  const editing = signal(false),
    name = signal(props.item.name),
    color = signal<TagColor>((props.item as Tag).color ?? "coral"),
    error = signal("");
  const count = () =>
    props.hub
      .data()
      .connections.filter((c) =>
        props.kind === "group"
          ? c.groupId === props.item.id
          : c.tagIds.includes(props.item.id),
      ).length;
  async function save() {
    const issue = organizationError(
      name(),
      props.kind === "group" ? props.hub.data().groups : props.hub.data().tags,
      props.item.id,
    );
    if (issue) {
      error.set(issue);
      return;
    }
    const ok = await props.hub.mutate((d) => {
      const item = (props.kind === "group" ? d.groups : d.tags).find(
        (v) => v.id === props.item.id,
      );
      if (item) item.name = name().trim();
      if (props.kind === "tag") {
        const tag = d.tags.find((t) => t.id === props.item.id);
        if (tag) tag.color = color();
      }
    });
    if (ok) editing.set(false);
  }
  return (
    <View class="border-b border-border gap-2">
      <View
        class="px-2.5 flex-row items-center gap-3"
        style={{ minHeight: props.kind === "tag" && !editing() ? 48 : 56 }}
      >
        <View class="flex-1 min-w-0 flex-row items-center gap-[18px]">
          <Icon
            name={props.kind === "group" ? "folder" : "tag"}
            size={16}
            color={
              props.kind === "tag"
                ? colors[(props.item as Tag).color]
                : undefined
            }
          />
          {editing() ? (
            <Input
              testID={`rename-${props.item.id}`}
              accessibilityLabel={hubT("name")}
              value={name()}
              onChange={({ value }) => name.set(value)}
              onSubmit={() => void save()}
              maxLength={30}
              autoFocus
              class={`flex-1 ${inputClass}`}
            />
          ) : (
            <Text class="flex-1 min-w-0 text-(--text-size-13) font-medium text-foreground">
              {props.item.name}
            </Text>
          )}
        </View>
        <Text class="w-[90px] text-(--text-size-12)/(--line-height-16) text-foreground">{count()}</Text>
        <View class="w-[146px] flex-row gap-3 items-center">
          {editing() ? (
            <>
              <HubAction
                label={hubT("cancel")}
                ghost
                onPress={() => editing.set(false)}
              />
              <HubAction
                label={hubT("save")}
                primary
                disabled={props.hub.saving()}
                onPress={() => void save()}
              />
            </>
          ) : (
            <>
              <IconButton
                label={`${hubT("rename")} ${props.item.name}`}
                icon="pencil"
                onPress={() => {
                  name.set(props.item.name);
                  editing.set(true);
                }}
              />
              <IconButton
                label={`${hubT("delete")} ${props.item.name}`}
                icon="trash"
                onPress={props.onDelete}
              />
            </>
          )}
        </View>
      </View>
      {editing() && props.kind === "tag" && (
        <View class="px-3 pb-3">
          <ColorPicker value={color()} onChange={color.set} />
        </View>
      )}
      <ErrorText message={error()} />
    </View>
  );
}
