import { signal, Text, token, View, type JSX } from "nsh";
import { Button, Input, Select, Tab, Tabs } from "nsh/base";
import { Action } from "./action";
import { Icon, type IconName } from "./icon";
import { hubT } from "../i18n";

export const inputClass =
  "h-10 min-w-0 rounded-md border border-border-strong bg-chrome px-3 text-(--text-size-12)/(--line-height-16) text-foreground focus:border-primary";
export const compactInputClass =
  "h-9 min-w-0 rounded-md border border-border-strong bg-chrome px-3 text-(--text-size-12)/(--line-height-16) text-foreground focus:border-primary";
export function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  password?: boolean;
  multiline?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  maxLength?: number;
}) {
  const visible = signal(false);
  return (
    <View
      class={`min-w-0 ${props.multiline ? "shrink-0" : "flex-1"} ${props.compact ? "gap-1.5" : "gap-2"}`}
    >
      <Text
        class={
          props.compact
            ? "text-(--text-size-13) font-medium text-foreground"
            : "text-(--text-size-12)/(--line-height-16) text-muted-foreground"
        }
      >
        {props.label}
      </Text>
      <View
        class={`flex-row items-center min-w-0 ${props.compact && props.password ? "rounded-md border border-border-strong bg-chrome" : "gap-1"}`}
        style={{
          height:
            props.compact && props.password
              ? props.multiline
                ? 96
                : 34
              : undefined,
        }}
      >
        <Input
          testID={props.id}
          style={{
            height: props.compact ? (props.multiline ? 96 : 34) : undefined,
          }}
          accessibilityLabel={props.label}
          value={props.value}
          onChange={({ value }) => props.onChange(value)}
          placeholder={props.placeholder}
          masked={props.password && !visible()}
          multiline={props.multiline}
          readonly={props.disabled}
          autoFocus={props.autoFocus}
          maxLength={props.maxLength}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={props.password ? "new-password" : "off"}
          class={`flex-1 ${props.compact ? (props.password ? "h-[34px] min-w-0 px-3 text-(--text-size-12)/(--line-height-16) text-foreground" : compactInputClass) : inputClass} ${props.multiline ? "h-24 py-2 font-mono" : ""} ${props.disabled ? "opacity-50" : ""}`}
        />
        {props.password && props.compact && (
          <Button
            accessibilityLabel={`${hubT(visible() ? "hide" : "show")} ${props.label}`}
            onPress={() => visible.set(!visible())}
            class="w-9 h-9 items-center justify-center active:opacity-70"
          >
            <Icon
              name={visible() ? "eyeOff" : "eye"}
              size={16}
              color={token("muted-foreground")}
            />
          </Button>
        )}
        {props.password && !props.compact && (
          <Action
            compact
            label={hubT(visible() ? "hide" : "show")}
            onPress={() => visible.set(!visible())}
          />
        )}
      </View>
    </View>
  );
}
export function Choice(props: {
  label: string;
  value: string;
  items: { value: string; title: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
  id?: string;
}) {
  return (
    <Select
      accessibilityLabel={props.label}
      testID={props.id}
      value={props.value}
      items={props.items}
      onChange={({ value }) => {
        if (value !== null) props.onChange(value);
      }}
      popupClass="rounded-md border border-border bg-panel p-1 shadow-xl"
      itemClass="min-h-9 px-3 py-2 text-(--text-size-12)/(--line-height-16) text-foreground focus:bg-selected selected:bg-selected"
      trigger={
        <View class={`${inputClass} flex-row items-center gap-3`}>
          <Text class="flex-1 text-(--text-size-12)/(--line-height-16) text-foreground">
            {props.items.find((item) => item.value === props.value)?.title ??
              props.value}
          </Text>
          <Icon name="down" size={12} />
        </View>
      }
    />
  );
}
export function Segments(props: {
  value: string;
  items: { value: string; title: string; icon?: IconName }[];
  variant?: "line" | "mode";
  disabled?: boolean;
  onChange: (value: string) => void;
  id?: string;
}) {
  return (
    <Tabs
      testID={props.id}
      class={
        props.variant === "line"
          ? "flex-row gap-6 rounded-md bg-chrome shrink-0"
          : props.variant === "mode"
            ? "flex-row rounded-md bg-chrome shrink-0"
            : "flex-row gap-1 rounded-md bg-chrome p-1 shrink-0"
      }
    >
      {props.items.map((item) => (
        <Tab
          testID={`${props.id ?? "segment"}-${item.value}`}
          accessibilityLabel={item.title}
          disabled={props.disabled}
          selected={props.value === item.value}
          onPress={() => props.onChange(item.value)}
          class={
            props.variant === "line"
              ? `h-11 px-2 rounded items-center justify-center active:opacity-70 focus:ring-1 focus:ring-ring ${props.value === item.value ? "bg-selected" : "hover:bg-accent"}`
              : props.variant === "mode"
                ? `flex-1 h-9 px-3 flex-row gap-2 items-center justify-center rounded active:opacity-70 focus:ring-1 focus:ring-ring ${props.value === item.value ? "bg-selected" : "hover:bg-accent"}`
                : `flex-1 h-9 px-3 rounded items-center justify-center active:opacity-70 focus:ring-1 focus:ring-ring ${props.value === item.value ? "bg-selected" : "hover:bg-accent"}`
          }
        >
          {item.icon && (
            <Icon name={item.icon} size={16} color={token("foreground")} />
          )}
          <Text
            class={`text-(--text-size-12)/(--line-height-16) ${props.value === item.value ? "text-foreground font-semibold" : "text-muted-foreground"}`}
          >
            {item.title}
          </Text>
        </Tab>
      ))}
    </Tabs>
  );
}
export function Hint(props: { children?: JSX.Element }) {
  return <Text class="text-(--text-size-12) leading-(--line-height-18) text-faint">{props.children}</Text>;
}
export function ErrorText(props: { message?: string }) {
  return (
    <If when={!!props.message}>
      <View role="alert">
        <Text class="text-(--text-size-12) text-destructive leading-(--line-height-18)">
          {props.message}
        </Text>
      </View>
    </If>
  );
}
