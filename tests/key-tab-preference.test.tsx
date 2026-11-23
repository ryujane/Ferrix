import { expect, open, test } from "nsh/test";
import { defaultPreferences, parsePreferencesDocument } from "../src/data/preferences";

test("older settings use new key tabs by default", () => {
  const { keyTabMode, ...previous } = defaultPreferences;
  const document = { version: 1, language: "en", ...previous };
  expect(keyTabMode).toBe("new");
  expect(parsePreferencesDocument(JSON.stringify(document)).keyTabMode).toBe("new");
});

test("saving the key tab mode replaces clean tabs in place and preserves drafts", async () => {
  const app = await open("./key-tab-preference.fixture.tsx", {
    width: 1000,
    height: 700,
    platform: "macos",
    locale: "en-US",
  });
  await app.press("text:Open alpha");
  await app.press("text:Open beta");
  expect(app.texts()).toContain("Tabs alpha, beta");
  await app.press("text:Open alpha");

  await app.press("settings-category-browser");
  expect(app.texts()).toContain("New tab");
  await app.press("settings-keyTabMode");
  await app.press("text:Replace current tab");
  await app.press("settings-save");
  await app.waitFor("text:Preferences saved and applied.");

  await app.press("text:Open gamma");
  await app.waitFor("text:Value value");
  expect(app.texts()).toContain("Tabs gamma, beta");
  expect(app.texts()).toContain("Active gamma");
  await app.press("text:Edit value");
  expect(app.texts()).toContain("Value draft");

  await app.press("text:Open delta");
  expect(app.texts()).toContain("Tabs gamma, beta, delta");
  await app.press("text:Open gamma");
  expect(app.texts()).toContain("Tabs gamma, beta, delta");
  expect(app.texts()).toContain("Active gamma");
  expect(app.texts()).toContain("Value draft");
});
