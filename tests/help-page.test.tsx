import { expect, open, test } from "nsh/test";

test("the Help changelog opens GitHub Releases directly", async () => {
  const app = await open("../app.tsx", {
    width: 1000,
    height: 700,
    platform: "macos",
  });

  await app.press("nav-help");
  await app.press("help-changelog");

  expect(app.openedUrls()).toEqual(["https://github.com/ryujane/Ferrix/releases"]);
});
