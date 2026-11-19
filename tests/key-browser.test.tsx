import { expect, open, test } from "nsh/test";

const options = { width: 400, height: 650, platform: "macos" as const };

test("key browser keeps folder and key navigation across SCAN pages", async () => {
  const app = await open("./key-browser.fixture.tsx", options);
  await app.press("load-small");
  await app.waitFor("text:beta");
  expect(app.texts()).toContain("2");
  await app.press("text:bucket");
  expect(app.texts()).not.toContain("beta");
  await app.press("load-small");
  await app.waitFor("text:bucket");
  expect(app.texts()).not.toContain("beta");
  await app.press("text:bucket");
  await app.waitFor("text:beta");
  await app.press("workspace-load-more");
  await app.waitFor("text:plain");
  expect(app.texts()).toContain("Keys 4");
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
  await app.waitFor("text:beta");
  await app.press("hold-page");
  await app.press("workspace-load-more");
  await app.waitFor("release-page");
  await app.press("workspace-stop-scan");
  await app.waitFor("text:Loading stopped");
  expect(app.texts()).toContain("Cancelled 1 / disposed 1");
  expect(app.count("workspace-load-more")).toBe(0);

  await app.press("release-page");
  expect(app.texts()).toContain("Keys 2");
  expect(app.texts()).not.toContain("plain");
  await app.press("text:beta");
  expect(app.texts()).toContain("Selected bucket:child:beta");

  await app.press("workspace-restart-scan");
  await app.waitFor("workspace-load-more");
  expect(app.texts()).not.toContain("Loading stopped");
  await app.press("workspace-load-more");
  await app.waitFor("text:Scan complete");
  expect(app.texts()).toContain("Keys 4");
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
