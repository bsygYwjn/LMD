import assert from "node:assert/strict";
import test from "node:test";
import { uploadGroupKeys } from "./upload-groups.ts";

const files = (...paths) => paths.map(webkitRelativePath => ({ name: webkitRelativePath.split("/").at(-1), webkitRelativePath }));
test("普通文件、阅读和图片冲突不暂停其他文件", () => {
  for (const kind of ["files", "reading", "photos"]) {
    const keys = uploadGroupKeys(kind, files("作品/one.txt", "作品/two.txt"));
    assert.notEqual(keys[0], keys[1]);
  }
});
test("视频目录字幕与字体包一起调整，其他目录独立", () => {
  const keys = uploadGroupKeys("video", files("动画/E01.mkv", "动画/E01.zh.ass", "动画/fonts/a.ttf", "电影/a.mkv"));
  assert.equal(keys[0], keys[1]); assert.equal(keys[0], keys[2]); assert.notEqual(keys[0], keys[3]);
});
test("音乐保留所选父目录封面继承关系", () => {
  const keys = uploadGroupKeys("music", files("专辑/cover.jpg", "专辑/CD1/01.flac", "专辑/CD1/01.lrc", "其他/01.mp3"));
  assert.equal(keys[0], keys[1]); assert.equal(keys[0], keys[2]); assert.notEqual(keys[0], keys[3]);
});
