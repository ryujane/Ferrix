import { signal, Scroll, Text, View } from "nsh";
import { Button, Checkbox, Input, Popover } from "nsh/base";
import { Action } from "../../components/action";
import { Icon } from "../../components/icon";
import { colors } from "./tag-colors";
import { hubT } from "../../i18n";
import {
  normalizeName,
  organizationError,
  type Tag,
  type TagColor,
} from "../../data/connections/connection-model";
import type { ConnectionHub } from "../../data/connections/connection-state";
import {
  ErrorText,
  compactInputClass as inputClass,
} from "../../components/form-controls";

const tagFills: Record<TagColor, string> = {
  blue: "bg-steel/15",
  coral: "bg-primary/15",
  violet: "bg-chart-4/15",
  green: "bg-success/15",
  amber: "bg-chart-3/15",
  slate: "bg-faint/15",
};

export function TagChip(props: {
  tag: Tag;
  onRemove?: () => void;
  compact?: boolean;
}) {
  return (
    <View
      class={`flex-row items-center gap-1 rounded px-1.5 ${tagFills[props.tag.color]} ${props.compact ? "py-0.5" : "py-1"}`}
    >
      {!props.compact && (
        <View
          class="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: colors[props.tag.color] }}
        />
      )}
      <Text
        class="min-w-0 line-clamp-1 text-(--text-size-12)/(--line-height-16)"
        style={{ color: colors[props.tag.color] }}
      >
        {props.tag.name}
      </Text>
      {props.onRemove && (
        <Button
          accessibilityLabel={`${hubT("removeTag")} ${props.tag.name}`}
          onPress={props.onRemove}
          class="ml-1 w-4 h-4 items-center justify-center rounded hover:bg-accent active:opacity-60"
        >
          <Icon name="close" size={10} />
        </Button>
      )}
    </View>
  );
}
export function OrganizationFields(props: {
  hub: ConnectionHub;
  groupId: string | null;
  tagIds: string[];
  onChange: (change: { groupId?: string | null; tagIds?: string[] }) => void;
}) {
  return (
    <View
      testID="organization-fields"
      class="gap-3 pt-[13px] border-t border-border"
    >
      <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
        {hubT("organization")}
      </Text>
      <View class="flex-row items-start gap-4">
        <Text class="w-11 pt-2 text-(--text-size-13) font-medium text-foreground">
          {hubT("groupShort")}
        </Text>
        <View class="flex-1 min-w-0">
          <OrganizationPicker {...props} kind="group" inline />
        </View>
      </View>
      <View class="flex-row items-start gap-4">
        <Text class="w-11 pt-2 text-(--text-size-13) font-medium text-foreground">
          {hubT("tags")}
        </Text>
        <View class="flex-1 min-w-0 gap-2">
          <OrganizationPicker {...props} kind="tag" inline />
          {!!props.tagIds.length && (
            <View class="flex-row flex-wrap gap-1">
              {props.tagIds.map((id) => {
                const tag = props.hub.data().tags.find((t) => t.id === id);
                return (
                  tag && (
                    <TagChip
                      tag={tag}
                      compact
                      onRemove={() =>
                        props.onChange({
                          tagIds: props.tagIds.filter((t) => t !== id),
                        })
                      }
                    />
                  )
                );
              })}
            </View>
          )}
        </View>
      </View>
      <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
        {hubT("organizationCreateHint")}
      </Text>
    </View>
  );
}
export function OrganizationPicker(props: {
  hub: ConnectionHub;
  kind: "group" | "tag";
  detail?: boolean;
  inline?: boolean;
  groupId: string | null;
  tagIds: string[];
  onChange: (change: { groupId?: string | null; tagIds?: string[] }) => void;
}) {
  const open = signal(false),
    creating = signal(false),
    search = signal(""),
    name = signal(""),
    error = signal(""),
    busy = signal(false),
    color = signal<TagColor>("blue");
  const items = () =>
    props.kind === "group" ? props.hub.data().groups : props.hub.data().tags;
  const select = (id: string | null) => {
    if (props.kind === "group") {
      props.onChange({ groupId: id });
      open.set(false);
    } else if (id)
      props.onChange({
        tagIds: props.tagIds.includes(id)
          ? props.tagIds.filter((t) => t !== id)
          : [...props.tagIds, id],
      });
  };
  async function create(value: string) {
    const issue = organizationError(value, items());
    if (issue) {
      error.set(issue);
      return;
    }
    if (busy()) return;
    busy.set(true);
    const id = await props.hub.createOrganization(props.kind, value, color());
    busy.set(false);
    if (id) {
      if (props.kind === "group") props.onChange({ groupId: id });
      else props.onChange({ tagIds: [...props.tagIds, id] });
      open.set(false);
      creating.set(false);
      search.set("");
      name.set("");
    } else error.set(props.hub.error());
  }
  return (
    <View
      class={props.inline ? "flex-row flex-wrap items-start gap-3" : "gap-2"}
    >
      <Popover
        open={open()}
        onOpenChange={({ open: next }) => {
          open.set(next);
          search.set("");
          error.set("");
        }}
        align="start"
        margin={12}
        popupClass="w-72 p-3 gap-2 rounded-lg border border-border bg-panel shadow-xl"
        trigger={
          <View
            testID={`pick-${props.kind}`}
            class={`${inputClass} flex-row items-center gap-2`}
            style={{
              width: props.inline
                ? 290
                : props.detail && props.kind === "tag"
                  ? 104
                  : undefined,
              height:
                props.inline || (props.detail && props.kind === "tag")
                  ? 34
                  : undefined,
            }}
          >
            <Icon name={props.kind === "group" ? "folder" : "plus"} size={14} />
            <Text class="flex-1 text-(--text-size-12)/(--line-height-16) text-foreground">
              {props.kind === "group"
                ? (items().find((i) => i.id === props.groupId)?.name ??
                  hubT("ungrouped"))
                : props.detail
                  ? hubT("addTag")
                  : props.tagIds.length
                    ? hubT("tagsSelected", { count: props.tagIds.length })
                    : hubT("selectTags")}
            </Text>
            {!(props.detail && props.kind === "tag") && (
              <Icon name="down" size={12} />
            )}
          </View>
        }
      >
        <Input
          testID={`search-${props.kind}`}
          accessibilityLabel={hubT(
            props.kind === "group" ? "searchGroups" : "searchTags",
          )}
          placeholder={hubT("searchOrCreate")}
          value={search()}
          onChange={({ value }) => {
            search.set(value);
            error.set("");
          }}
          class={inputClass}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Scroll class="max-h-48">
          <View class="gap-1">
            {props.kind === "group" && (
              <Action
                label={hubT("ungrouped")}
                selected={!props.groupId}
                onPress={() => select(null)}
              />
            )}
            {items()
              .filter((i) =>
                normalizeName(i.name).includes(normalizeName(search())),
              )
              .map((i) =>
                props.kind === "group" ? (
                  <Action
                    label={i.name}
                    selected={i.id === props.groupId}
                    onPress={() => select(i.id)}
                  />
                ) : (
                  <Checkbox
                    accessibilityLabel={i.name}
                    checked={props.tagIds.includes(i.id)}
                    onChange={() => select(i.id)}
                    class="flex-row gap-2 px-2 py-2 rounded hover:bg-selected"
                    indicatorClass="w-4 h-4 rounded border border-border-strong checked:bg-primary"
                    indicator={<Icon name="check" size={12} />}
                  >
                    <Text class="text-(--text-size-12)/(--line-height-16) text-foreground">{i.name}</Text>
                  </Checkbox>
                ),
              )}
            {!items().length && (
              <Text class="p-2 text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                {hubT(props.kind === "group" ? "noGroups" : "noTags")}
              </Text>
            )}
          </View>
        </Scroll>
        {!!search().trim() &&
          !items().some(
            (i) => normalizeName(i.name) === normalizeName(search()),
          ) && (
            <Action
              label={hubT("createNamed", { name: search().trim() })}
              icon="plus"
              disabled={busy()}
              onPress={() => void create(search())}
            />
          )}
        <ErrorText message={error()} />
      </Popover>
      {!props.detail && (
        <Popover
          open={creating()}
          onOpenChange={({ open }) => {
            creating.set(open);
            name.set("");
            error.set("");
          }}
          align="start"
          margin={12}
          popupClass="w-72 p-3 gap-3 rounded-lg border border-border bg-panel shadow-xl"
          trigger={
            <View
              testID={`new-${props.kind}`}
              class="h-7 flex-row items-center gap-1"
            >
              <Icon name="plus" size={12} />
              <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
                {hubT(props.kind === "group" ? "newGroup" : "newTag")}
              </Text>
            </View>
          }
        >
          <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
            {hubT(props.kind === "group" ? "newGroup" : "newTag")}
          </Text>
          <Input
            testID={`new-${props.kind}-name`}
            accessibilityLabel={hubT("name")}
            value={name()}
            onChange={({ value }) => {
              name.set(value);
              error.set("");
            }}
            onSubmit={() => void create(name())}
            maxLength={30}
            autoFocus
            class={inputClass}
          />
          {props.kind === "tag" && (
            <ColorPicker value={color()} onChange={color.set} />
          )}
          <ErrorText message={error()} />
          <View class="flex-row justify-end gap-2">
            <Action
              label={hubT("cancel")}
              onPress={() => creating.set(false)}
            />
            <Action
              testID={`create-${props.kind}`}
              label={hubT("create")}
              primary
              disabled={busy()}
              onPress={() => void create(name())}
            />
          </View>
        </Popover>
      )}
    </View>
  );
}
export function ColorPicker(props: {
  value: TagColor;
  onChange: (value: TagColor) => void;
}) {
  return (
    <View class="flex-row gap-2">
      {(Object.keys(colors) as TagColor[]).map((color) => (
        <Button
          accessibilityLabel={hubT(`color-${color}`)}
          selected={props.value === color}
          onPress={() => props.onChange(color)}
          class={`w-7 h-7 rounded-full items-center justify-center active:opacity-60 ${props.value === color ? "border-2 border-foreground" : "border border-transparent"}`}
        >
          <View
            class="w-4 h-4 rounded-full"
            style={{ backgroundColor: colors[color] }}
          />
        </Button>
      ))}
    </View>
  );
}
