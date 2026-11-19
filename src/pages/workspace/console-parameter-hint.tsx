import { Text, View } from "nsh";
import type { ParameterHint } from "./console-values";
import { workspaceT as w } from "./workspace-text";

const typeLabels: Record<string, string> = {
  key: "consoleParameterKey",
  string: "consoleParameterString",
  integer: "consoleParameterInteger",
  double: "consoleParameterNumber",
  pattern: "consoleParameterPattern",
  "unix-time": "consoleParameterTimestamp",
};
const units: Record<string, string> = {
  seconds: "consoleParameterSeconds",
  milliseconds: "consoleParameterMilliseconds",
  "unix-time-seconds": "consoleParameterTimestampSeconds",
  "unix-time-milliseconds": "consoleParameterTimestampMilliseconds",
};
export function ConsoleParameterHint(props: {
  hint?: ParameterHint;
  loading?: boolean;
}) {
  const hint = () => props.hint;
  const names = () =>
    hint()
      ?.parameters.map((parameter) => parameter.name)
      .join(" / ") ?? "";
  const types = () =>
    [
      ...new Set(
        hint()
          ?.parameters.filter((parameter) => parameter.type !== "pure-token")
          .map((parameter) =>
            w(
              units[parameter.name] ??
                typeLabels[parameter.type] ??
                "consoleParameterValue",
            ),
          ),
      ),
    ].join(" / ");
  return (
    <>
      {hint() && (
        <View testID="workspace-console-parameter-hint" class="gap-1">
          <Text
            testID="workspace-console-syntax"
            style={{ numberOfLines: 2 }}
            class="text-(--text-size-10) font-mono text-muted-foreground"
          >
            {hint()!.syntax.map((part) => (
              <Text
                class={
                  part.active
                    ? "text-primary font-semibold"
                    : "text-muted-foreground"
                }
              >
                {part.text}
              </Text>
            ))}
          </Text>
          {hint()!.mode === "argument" || hint()!.mode === "options" ? (
            <View class="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
              <Text class="text-(--text-size-10) text-faint">
                {w(
                  hint()!.mode === "options"
                    ? "consoleParameterOptions"
                    : "consoleCurrentParameter",
                )}
              </Text>
              <Text
                testID="workspace-console-parameter-name"
                style={{ numberOfLines: 2 }}
                class="text-(--text-size-11) font-mono font-semibold text-primary"
              >
                {names()}
              </Text>
              {!!types() && (
                <Text
                  testID="workspace-console-parameter-type"
                  class="text-(--text-size-10) text-muted-foreground"
                >
                  {types()}
                </Text>
              )}
              <Text
                testID="workspace-console-parameter-required"
                class="text-(--text-size-10) text-faint"
              >
                {w(
                  hint()!.required
                    ? "consoleParameterRequired"
                    : "consoleParameterOptional",
                )}
              </Text>
              {hint()!.parameters.some((parameter) => parameter.repeated) && (
                <Text class="text-(--text-size-10) text-faint">
                  {w("consoleParameterRepeated")}
                </Text>
              )}
            </View>
          ) : (
            <Text
              testID="workspace-console-parameter-status"
              class="text-(--text-size-10) text-faint"
            >
              {w(
                hint()!.mode === "command"
                  ? "consoleParameterSpace"
                  : hint()!.mode === "complete"
                    ? "consoleParametersComplete"
                    : props.loading
                      ? "consoleParametersLoading"
                      : "consoleParameterUnavailable",
              )}
            </Text>
          )}
        </View>
      )}
    </>
  );
}
