import { expect, open, test } from "nsh/test";

const options = {
  width: 1280,
  height: 860,
  platform: "macos" as const,
  colorScheme: "dark" as const,
};

test("workspace folds JSON and preserves state across theme changes", async () => {
  const app = await open("./tests/demo-workspace.acceptance.tsx", options);
  expect(app.texts()).toContain("Ferrix");
  expect(app.texts()).toContain("示例模式");
  expect(app.texts()).toContain("4 个节点已展开");
  await app.press("折叠全部");
  expect(app.texts()).toContain("4 个节点已折叠");
  await app.press("浅色");
  expect(app.texts()).toContain("4 个节点已折叠");
  await app.press("深色");
  expect(app.texts()).toContain("4 个节点已折叠");
  await app.press("展开全部");
  expect(app.texts()).toContain("4 个节点已展开");
});

test("workspace searches keys and restores empty results", async () => {
  const app = await open("./tests/demo-workspace.acceptance.tsx", options);
  await app.keyboard.press("mod+k");
  await app.type("quick-search", "does-not-exist");
  expect(app.texts()).toContain("没有匹配的键");
  await app.press("清除筛选");
  expect(app.texts()).toContain("命名空间");
  await app.press("打开 auth:token:bearer:49210");
  expect(app.texts()).toContain("可编辑");
  await app.press("关闭 auth:token:bearer:49210");
  expect(app.texts()).toContain("4 个节点已展开");
});

test("workspace validates drafts and keeps console interaction independent", async () => {
  const app = await open("./tests/demo-workspace.acceptance.tsx", options);
  await app.press("压缩");
  expect(app.texts()).toContain("有未保存修改");
  await app.press("浅色");
  expect(app.texts()).toContain("有未保存修改");
  await app.press("保存修改");
  expect(app.texts()).toContain("示例修改已保存到当前窗口");
  await app.press("格式化");
  await app.press("重新加载");
  expect(app.texts()).toContain("已恢复为本窗口最近保存的内容");
  await app.press("编辑键值");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("x");
  expect(app.texts()).toContain("JSON 格式有误");
  await app.keyboard.press("mod+s");
  expect(app.texts()).toContain("请修正 JSON 格式后再保存");
  await app.press("重新加载");
  await app.type("console-command", "DBSIZE");
  await app.submit("console-command");
  expect(app.texts()).toContain("(integer) 13");
  await app.keyboard.press("mod+j");
  expect(app.texts()).not.toContain("示例控制台");
  await app.keyboard.press("mod+j");
  expect(app.texts()).toContain("(integer) 13");
});

test("workspace browses the native key tree and dismisses settings", async () => {
  const app = await open("./tests/demo-workspace.acceptance.tsx", options);
  await app.press("984211");
  expect(app.texts()).toContain("users:session:984211");
  await app.press("窗口设置");
  expect(app.texts()).toContain("外观");
  await app.press("使用浅色主题");
  await app.keyboard.press("escape");
  expect(app.texts()).not.toContain("外观");
  expect(app.texts()).toContain("users:session:984211");
  await app.press("连接");
  expect(app.texts()).toContain(
    "当前为本地示例数据，可浏览、编辑和保存到本窗口；尚未建立 Redis 连接。",
  );
  await app.press("返回示例工作区");
  expect(app.texts()).toContain("users:session:984211");
});
