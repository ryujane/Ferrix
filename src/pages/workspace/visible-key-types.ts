import type { KeyInventory, RedisSession } from "ferrix/native";

export type VisibleKeys = { layoutRevision: number; keys: Uint8Array[] };

export function createVisibleKeyTypes(
  session: Pick<RedisSession, "getInfo" | "getKeyInfoBatch">,
  inventory: () => KeyInventory,
  publish: (entries: KeyInventory) => void,
  blocked: () => boolean,
) {
  let next: VisibleKeys | undefined;
  let busy = false;
  let lifetime = 0;

  async function load() {
    if (busy || blocked() || !next?.keys.length) return;
    const visible = next;
    next = undefined;
    const entries = inventory();
    if (visible.layoutRevision !== entries.layoutRevision) return;
    const revision = lifetime;
    busy = true;
    let prepared = false;
    try {
      const source = session.getInfo();
      if (source.closed) return;
      const keys = entries.prepareTypes(visible.keys);
      if (!keys.length) return;
      prepared = true;
      const result = await session.getKeyInfoBatch(keys, { keyType: true });
      if (revision !== lifetime) return;
      const current = session.getInfo();
      if (
        !current.closed &&
        current.database === source.database &&
        current.generation === source.generation &&
        result.database === source.database
      ) {
        const changed = entries.setTypes(result.items);
        prepared = false;
        if (changed) publish(entries);
      }
    } catch {
      // A type lookup is best effort. The viewport can request it again when it changes.
    } finally {
      if (prepared) entries.setTypes([]);
      busy = false;
      if (next) void load();
    }
  }

  function setVisibleKeys(visible?: VisibleKeys) {
    next = visible;
    if (visible) void load();
    else ++lifetime;
  }

  return { load, setVisibleKeys };
}
