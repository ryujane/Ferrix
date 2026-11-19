import { computed, signal, Text, token, View } from "nsh";
import { Editor, type EditorDecoration } from "nsh/base";
import { Action } from "../../components/action";
import { editorLineHeight, fonts } from "../../fonts";
import { byteLabel, encode, formatJson, isJson } from "./workspace-values";
import { workspaceT as w } from "./workspace-text";

export function NewKeyPayloadEditor(props: {
  value: string;
  label?: string;
  testIDPrefix?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const format = signal<"json" | "text">("json");
  const json = computed(() => isJson(props.value));
  const decorations = computed<EditorDecoration[]>(() =>
    format() !== "json"
      ? []
      : props.value.split("\n").flatMap((line, index) =>
          Array.from(line.matchAll(/"(?:\\.|[^"\\])*"/g), (match) => ({
            range: {
              start: { line: index, column: match.index },
              end: { line: index, column: match.index + match[0].length },
            },
            class: /^\s*:/.test(line.slice(match.index + match[0].length))
              ? "text-steel"
              : "text-code-string",
          })),
        ),
  );
  function transform(compact: boolean) {
    if (props.disabled) return;
    const next = formatJson(props.value, compact);
    if (next !== undefined) {
      props.onChange(next);
      format.set("json");
    }
  }
  return (
    <View class="gap-1.5">
      <View class="flex-row flex-wrap items-center gap-2">
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {props.label ?? w("initialValue")}
        </Text>
        <View class="flex-row p-0.5 rounded bg-background">
          <Action
            testID="workspace-new-key-format-json"
            label="JSON"
            compact
            selected={format() === "json"}
            disabled={props.disabled}
            onPress={() => format.set("json")}
          />
          <Action
            testID="workspace-new-key-format-raw"
            label="RAW"
            compact
            selected={format() === "text"}
            disabled={props.disabled}
            onPress={() => format.set("text")}
          />
        </View>
        <View class="flex-1" />
        <Action
          testID="workspace-new-key-beautify"
          label={w("newKeyBeautify")}
          icon="braces"
          compact
          disabled={props.disabled || !json()}
          onPress={() => transform(false)}
        />
        <Action
          testID="workspace-new-key-compact"
          label={w("compact")}
          icon="collapse"
          compact
          disabled={props.disabled || !json()}
          onPress={() => transform(true)}
        />
      </View>
      <View class="rounded-lg overflow-hidden border border-border bg-chrome">
        <Editor
          testID={(props.testIDPrefix ?? "workspace-new-key") + "-value"}
          accessibilityLabel={props.label ?? w("initialValue")}
          value={props.value}
          onChange={({ value }) => {
            if (!props.disabled) props.onChange(value);
          }}
          readOnly={props.disabled}
          language={format() === "json" ? "json" : "text"}
          highlighting={false}
          decorations={decorations()}
          folding={false}
          autoClose={false}
          autoIndent={format() === "json"}
          fontFamily={fonts.mono}
          fontSize={token("editor-text-size")}
          lineHeight={editorLineHeight()}
          softWrap
          scrollBeyondLastLine={false}
          class="h-40 text-foreground bg-chrome"
          classes={{
            gutter: "bg-background text-faint",
            content: "bg-chrome px-3",
            lineNumber: "text-faint",
            activeLine: "bg-accent/15",
            indentGuide: "bg-border/30",
          }}
        />
        <View class="h-6 px-3 flex-row items-center justify-between gap-2 bg-background">
          <Text class="text-(--text-size-10) font-mono text-faint">UTF-8</Text>
          <Text
            testID="workspace-new-key-value-size"
            class="text-(--text-size-10) font-mono text-success"
          >
            {byteLabel(encode(props.value).length)} ·{" "}
            {w("lines", { count: props.value.split("\n").length })}
          </Text>
        </View>
      </View>
    </View>
  );
}
