import { computed, token, View } from "nsh";
import { Editor, type EditorDecoration, type EditorRef } from "nsh/base";
import { editorLineHeight, fonts } from "../../fonts";

export function PubSubPayload(props: {
  value: string;
  onChange?: (value: string) => void;
  onReady?: (ref: EditorRef) => void;
  readOnly?: boolean;
  json?: boolean;
  testID: string;
}) {
  const decorations = computed<EditorDecoration[]>(() =>
    !props.json
      ? []
      : props.value.split("\n").flatMap((line, index) =>
          Array.from(line.matchAll(/"(?:\\.|[^"\\])*"/g), (match) => ({
            range: {
              start: { line: index, column: match.index },
              end: { line: index, column: match.index + match[0].length },
            },
            class: /^\s*:/.test(line.slice(match.index + match[0].length))
              ? "text-code-string"
              : "text-success",
          })),
        ),
  );
  return (
    <View class="flex-1 min-h-0 overflow-hidden rounded bg-inset">
      <Editor
        ref={(ref) => props.onReady?.(ref)}
        testID={props.testID}
        accessibilityLabel={
          props.testID === "pubsub-payload" ? "Payload" : "Message"
        }
        value={props.value}
        onChange={({ value }) => props.onChange?.(value)}
        readOnly={props.readOnly}
        language={props.json ? "json" : "text"}
        highlighting={false}
        decorations={decorations()}
        folding={false}
        autoClose={false}
        autoIndent={props.json}
        fontFamily={fonts.mono}
        fontSize={token("editor-text-size")}
        lineHeight={editorLineHeight()}
        softWrap
        scrollBeyondLastLine={false}
        lineNumbers={false}
        class="flex-1 min-h-0 text-foreground bg-inset"
        classes={{ content: "bg-inset px-3 py-2", activeLine: "bg-accent/10" }}
      />
    </View>
  );
}
