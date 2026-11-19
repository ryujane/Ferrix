import { cleanup, computed, signal } from "nsh";
import type {
  RedisClientInfo,
  RedisClientList,
  RedisSession,
} from "ferrix/native";
import { safeError } from "../../utils/errors";
import { m } from "./monitoring-values";

export type ClientsSession = Pick<RedisSession, "readClients" | "getInfo">;

export function clientText(value?: Uint8Array) {
  if (!value) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      value,
    );
  } catch {
    return Array.from(
      value,
      (byte) => "\\x" + byte.toString(16).padStart(2, "0"),
    ).join("");
  }
}
export const clientField = (client: RedisClientInfo, name: string) =>
  clientText(client.fields.find((field) => field.name === name)?.value);

export function createClientsState(session: ClientsSession) {
  const snapshot = signal<RedisClientList>(),
    query = signal(""),
    busy = signal(false),
    error = signal(""),
    selected = signal<string>();
  let disposed = false;
  cleanup(() => {
    disposed = true;
  });
  const rows = computed(() => {
    const filter = query().trim().toLowerCase();
    return (snapshot()?.clients ?? []).filter(
      (client) =>
        !filter ||
        client.id.includes(filter) ||
        client.fields.some((field) =>
          (field.name + "=" + clientText(field.value))
            .toLowerCase()
            .includes(filter),
        ),
    );
  });
  async function refresh() {
    if (disposed || busy()) return;
    busy.set(true);
    error.set("");
    try {
      const result = await session.readClients();
      if (disposed) return;
      const info = session.getInfo();
      if (
        result.database !== info.database ||
        result.generation !== info.generation
      )
        throw { code: "CONTEXT_CHANGED" };
      const previous = snapshot();
      if (
        previous &&
        (previous.generation !== result.generation ||
          previous.nodeAddress !== result.nodeAddress)
      )
        selected.set(undefined);
      snapshot.set(result);
      if (
        selected() &&
        !result.clients.some((client) => client.id === selected())
      )
        selected.set(undefined);
    } catch (cause) {
      if (disposed) return;
      const code = (cause as { code?: string })?.code;
      error.set(
        code === "PERMISSION_DENIED"
          ? m("clientsPermissionDenied")
          : code === "PAYLOAD_TOO_LARGE"
            ? m("clientsTooLarge")
            : safeError(cause),
      );
    } finally {
      if (!disposed) busy.set(false);
    }
  }
  return { snapshot, query, busy, error, selected, rows, refresh };
}
