import { cleanup, signal } from "nsh";
import { safeError } from "../../utils/errors";
import {
  createDatabaseAnalysisJob,
  type DatabaseAnalysisSession,
  type DatabaseAnalysisSnapshot,
} from "./database-analysis";

export function createAnalysisState(session: DatabaseAnalysisSession) {
  const limit = signal(10_000),
    snapshot = signal<DatabaseAnalysisSnapshot>(),
    error = signal(""),
    busy = signal(false);
  let current: ReturnType<typeof createDatabaseAnalysisJob> | undefined,
    revision = 0,
    disposed = false;
  function stop() {
    ++revision;
    if (current) {
      current.cancel();
      snapshot.set(current.snapshot());
      current = undefined;
    }
    busy.set(false);
  }
  cleanup(() => {
    disposed = true;
    ++revision;
    current?.cancel();
    current = undefined;
  });
  async function start() {
    if (disposed || busy()) return;
    const request = ++revision;
    error.set("");
    busy.set(true);
    try {
      const job = createDatabaseAnalysisJob(session, limit(), (result) => {
        if (!disposed && request === revision) snapshot.set(result);
      });
      current = job;
      snapshot.set(job.snapshot());
      await job.run();
    } catch (cause) {
      if (!disposed && request === revision) error.set(safeError(cause));
    } finally {
      if (!disposed && request === revision) {
        current = undefined;
        busy.set(false);
      }
    }
  }
  return { limit, snapshot, error, busy, start, stop };
}
