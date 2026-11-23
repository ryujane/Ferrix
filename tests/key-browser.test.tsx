import { expect, open, test } from "nsh/test";

const options = { width: 400, height: 650, platform: "macos" as const };

test("key search sends substring and explicit glob patterns", async () => {
  const app = await open("./key-browser.fixture.tsx", options);
  await app.type("live-key-filter", "bucket");
  await app.submit("live-key-filter");
  expect(app.texts()).toContain("SCAN MATCH *bucket*");

  await app.clear("live-key-filter");
  await app.type("live-key-filter", "bucket:*");
  await app.press("workspace-apply-filter");
  expect(app.texts()).toContain("SCAN MATCH bucket:*");

  await app.clear("live-key-filter");
  await app.submit("live-key-filter");
  expect(app.texts()).toContain("SCAN MATCH (all keys)");
});

test("key search reads all cursor pages, including empty batches", async () => {
  const app = await open("./key-browser.fixture.tsx", options);
  await app.type("live-key-filter", "sparse");
  await app.submit("live-key-filter");
  await app.waitFor("text:Scan complete");
  expect(app.texts()).toContain("Keys 10380");
  expect(app.count("workspace-load-more")).toBe(0);
});

test("key browser loads 10000 distinct keys with a SCAN count of 1000", async () => {
  const app = await open("./key-browser.fixture.tsx", options);
  await app.press("load-batch");
  await app.waitFor("text:Load more");
  expect(app.texts()).toContain("SCAN COUNT 1000");
  expect(app.texts()).toContain("Keys 10000");
  await app.press("workspace-load-more");
  await app.waitFor("text:Load more");
  expect(app.texts()).toContain("Keys 20000");
  await app.press("workspace-load-more");
  await app.waitFor("text:Scan complete");
  expect(app.texts()).toContain("Keys 20005");
}, 30_000);

test("key browser keeps folder and key navigation across SCAN pages", async () => {
  // NSH delivers raw key events in headless tests when simulating Linux.
  const app = await open("./key-browser.fixture.tsx", { ...options, platform: "linux" });
  await app.press("load-small");
  await app.waitFor("text:Load more");
  await app.waitFor("text:beta");
  expect(app.texts()).toContain("SCAN COUNT 3000");
  expect(app.texts()).toContain("2");
  await app.press("text:bucket");
  expect(app.texts()).not.toContain("beta");
  await app.press("load-small");
  await app.waitFor("text:bucket");
  expect(app.texts()).not.toContain("beta");
  await app.press("text:bucket");
  await app.waitFor("text:beta");
  await app.press("text:extras");
  await app.waitFor("text:Load more");
  await app.press("workspace-load-more");
  await app.waitFor("text:plain");
  expect(app.texts()).toContain("Keys 10002");
  expect(app.texts()).toContain("3");
  await app.press("text:beta");
  expect(app.texts()).toContain("Selected bucket:child:beta");
  await app.keyboard.press("end");
  expect(app.texts()).toContain("Selected plain");
  await app.keyboard.press("g");
  await app.waitFor("text:Selected bucket:gamma");
  await app.press("workspace-tree-mode");
  await app.waitFor("text:bucket:child:beta");
});

test("key browser reveals the final key beyond the old native tree capacity", async () => {
  const app = await open("./key-browser.fixture.tsx", options);
  await app.press("load-large");
  await app.waitFor("text:Keys 215000", { timeout: 15_000 });
  await app.waitFor("text:000000", { timeout: 15_000 });
  await app.press("text:000001");
  await app.keyboard.press("end");
  await app.waitFor("text:214999");
  expect(app.texts()).toContain("Selected bucket:214999");
}, 30_000);

test("native rows dispatch actions for the key, folder and empty area", async () => {
  const app = await open("./key-browser.fixture.tsx", { ...options, locale: "en-US" });
  await app.rightClick("text:Scanning keys…");
  await app.press("workspace-key-new");
  expect(app.texts()).toContain("New key in root");

  await app.press("load-small");
  await app.waitFor("text:beta");
  await app.rightClick("text:beta");
  await app.waitFor("text:Copy key name");
  await app.press("workspace-key-rename");
  expect(app.texts()).toContain("rename 6275636b65743a6368696c643a62657461");

  await app.rightClick("text:child");
  await app.press("workspace-folder-delete");
  expect(app.texts()).toContain("Delete folder bucket:child:");
});

test("stopping an in-flight page preserves loaded keys and allows a fresh scan", async () => {
  const app = await open("./key-browser.fixture.tsx", options);
  await app.press("load-small");
  await app.waitFor("text:Load more");
  await app.press("hold-page");
  await app.press("workspace-load-more");
  await app.waitFor("release-page");
  await app.press("workspace-stop-scan");
  await app.waitFor("text:Loading stopped");
  expect(app.texts()).toContain("Cancelled 1 / disposed 1");
  expect(app.count("workspace-load-more")).toBe(0);

  await app.press("release-page");
  expect(app.texts()).toContain("Keys 10000");
  expect(app.texts()).not.toContain("plain");
  await app.press("text:beta");
  expect(app.texts()).toContain("Selected bucket:child:beta");

  await app.press("workspace-restart-scan");
  await app.waitFor("text:Load more");
  expect(app.texts()).not.toContain("Loading stopped");
  await app.press("workspace-load-more");
  await app.waitFor("text:Scan complete");
  expect(app.texts()).toContain("Keys 10002");
  expect(app.count("workspace-stop-scan")).toBe(0);
});

test("stopping the first page shows the stopped state with an empty tree", async () => {
  const app = await open("./key-browser.fixture.tsx", options);
  await app.press("hold-page");
  await app.press("load-small");
  await app.waitFor("release-page");
  await app.press("workspace-stop-scan");
  await app.waitFor("text:Loading stopped");
  expect(app.texts()).not.toContain("No matching keys");
  await app.press("release-page");
  expect(app.texts()).toContain("Keys 0");
  await app.press("workspace-restart-scan");
  await app.waitFor("text:beta");
});
