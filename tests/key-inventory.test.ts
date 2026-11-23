import { expect, test } from "nsh/test";
import { KeyInventory } from "ferrix/native";

const encode = (text: string) => new TextEncoder().encode(text);

test("Rust key inventory preserves binary identity across growth and deletion", () => {
  const inventory = new KeyInventory();
  const empty = new Uint8Array();
  const binary = Uint8Array.of(0, 255, 128, 0);
  const large = new Uint8Array(70_000).fill(0xfe);
  const keys = Array.from({ length: 600 }, (_, index) =>
    Uint8Array.of(253, index >>> 8, index & 255),
  );
  inventory.appendPage([empty, binary, large, ...keys]);
  expect(inventory.appendPage([empty, binary.slice(), large.slice()])).toEqual([]);
  expect(inventory.length).toBe(603);
  expect(inventory.lookup(binary)?.name).toBe("0x00ff8000");
  expect(inventory.lookup(large)?.key.length).toBe(70_000);
  for (let index = 0; index < keys.length; index += 3)
    expect(inventory.remove(keys[index])).toBe(true);
  for (let index = 0; index < keys.length; index++)
    expect(!!inventory.lookup(keys[index])).toBe(index % 3 !== 0);
  const row = inventory.lookup(binary)!;
  row.key[0] = 0xff;
  expect(inventory.lookup(binary)?.id).toBe("00ff8000");
  expect(inventory.remove(empty)).toBe(true);
  expect(inventory.firstEntry()?.id).toBe("00ff8000");
});

test("Rust key inventory preserves folder order and rejects stale type metadata", () => {
  const inventory = new KeyInventory();
  const first = encode("a:one");
  const other = encode("b:two");
  const later = encode("a:three");
  inventory.appendPage([first, other, later]);
  expect(inventory.rowAt(2)?.label).toBe("three");
  expect(inventory.rowAt(4)?.label).toBe("two");
  inventory.toggleFolder("a:");
  expect(inventory.rowAt(1)?.label).toBe("b");

  expect(inventory.prepareTypes([first, other, later])).toEqual([first, other, later]);
  inventory.appendPage([encode("c:four")]);
  const renamed = encode("b:four");
  expect(inventory.rename(first, renamed)).toBe(true);
  expect(inventory.setTypes([
    { key: first, type: "list" },
    { key: renamed, type: "stream" },
    { key: other, type: "hash" },
    { key: later, type: null },
  ])).toBe(true);
  expect(inventory.lookup(first)).toBeNull();
  expect(inventory.lookup(renamed)?.type).toBeNull();
  expect(inventory.lookup(other)?.type).toBe("hash");
  expect(inventory.prepareTypes([renamed, other, later])).toEqual([renamed]);

  inventory.clear();
  inventory.appendPage([first, other, renamed]);
  expect(inventory.setTypes([{ key: renamed, type: "stream" }])).toBe(false);
  expect(inventory.lookup(renamed)?.type).toBeNull();
  expect(inventory.rowAt(0)?.expanded).toBe(false);
  expect(inventory.rowAt(1)?.label).toBe("b");
  inventory.configure(":", false);
  expect(inventory.rowAt(0)?.label).toBe("a:one");
});
