import { cleanup, computed, signal } from "nsh";
import type { RedisSession, RedisSlowlog } from "ferrix/native";
import { safeError } from "../../utils/errors";
import { slowlogBytes, slowlogCommand, slowlogT as s } from "./slowlog-values";

export type SlowlogSession = Pick<
  RedisSession,
  "readSlowLog" | "getInfo" | "close" | "dispose"
>;
export function createSlowlogState(openSession: () => Promise<SlowlogSession>) {
  const snapshot = signal<RedisSlowlog>(),
    count = signal(50),
    query = signal(""),
    busy = signal(false),
    error = signal(""),
    selected = signal<string>();
  let session: SlowlogSession | undefined,
    disposed = false,
    revision = 0;
  const rows = computed(() => {
    const filter = query().trim().toLowerCase();
    return (snapshot()?.entries ?? []).filter(
      (entry) =>
        !filter ||
        [
          entry.id,
          slowlogCommand(entry),
          slowlogBytes(entry.clientAddress),
          slowlogBytes(entry.clientName),
        ]
          .join(" ")
          .toLowerCase()
          .includes(filter),
    );
  });
  function release(value?: SlowlogSession) {
    if (value) {
      value.close();
      value.dispose();
    }
  }
  cleanup(() => {
    disposed = true;
    ++revision;
    release(session);
    session = undefined;
  });
  async function refresh() {
    if (disposed || busy()) return;
    const current = ++revision;
    busy.set(true);
    error.set("");
    try {
      if (!session) {
        const opened = await openSession();
        if (disposed || current !== revision) {
          release(opened);
          return;
        }
        session = opened;
      }
      const result = await session.readSlowLog(count());
      if (disposed || current !== revision) return;
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
        !result.entries.some((entry) => entry.id === selected())
      )
        selected.set(undefined);
    } catch (cause) {
      if (disposed || current !== revision) return;
      const code = (cause as { code?: string })?.code;
      error.set(
        code === "PERMISSION_DENIED"
          ? s("permissionDenied")
          : code === "PAYLOAD_TOO_LARGE"
            ? s("tooLarge")
            : safeError(cause),
      );
      if (code === "SESSION_CLOSED") {
        release(session);
        session = undefined;
      }
    } finally {
      if (!disposed && current === revision) busy.set(false);
    }
  }
  return { snapshot, count, query, busy, error, selected, rows, refresh };
}
