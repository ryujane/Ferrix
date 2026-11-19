import { safeError } from "../../utils/errors";
import { workspaceT as w } from "./workspace-text";

export type JsonQuery = { path: string; value: string; matches: string };
export type JsonData = {
  pathInput: string;
  query?: JsonQuery;
  loading: boolean;
  error: string;
};
export const newJsonData = (previous?: JsonData): JsonData => ({
  pathInput: previous?.pathInput ?? "$",
  loading: false,
  error: "",
});
export const validJsonPath = (path: string) =>
  path.startsWith("$") && path.length <= 4096 && !path.includes("\0");
export function jsonError(cause: unknown): string {
  switch ((cause as { code?: string })?.code) {
    case "JSON_UNAVAILABLE":
      return w("jsonUnavailable");
    case "JSON_PATH_INVALID":
      return w("jsonPathInvalid");
    case "JSON_PATH_NOT_FOUND":
      return w("jsonPathNotFound");
    case "INVALID_JSON":
      return w("invalidJson");
    case "KEY_NOT_FOUND":
      return w("keyMissing");
    case "PAYLOAD_TOO_LARGE":
      return w("jsonResultTooLarge");
    case "WRITE_OUTCOME_UNKNOWN":
      return w("unknownWrite");
    default:
      return safeError(cause);
  }
}
