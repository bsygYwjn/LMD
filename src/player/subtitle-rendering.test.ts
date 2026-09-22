import assert from "node:assert/strict";
import { assRendererFailureMessage, bitmapPaintPlan, type BitmapCue } from "./subtitle-rendering.ts";

const cues: BitmapCue[] = [
  { start: 1, end: 2, x: 120, y: 800, width: 600, height: 100, canvasWidth: 1920, canvasHeight: 1080, url: "/first.png" },
  { start: 1, end: 2, x: 10, y: 20, width: 80, height: 40, canvasWidth: 1920, canvasHeight: 1080, url: "/second.png" },
];
const plan = bitmapPaintPlan(cues);
assert.deepEqual([plan.canvasWidth, plan.canvasHeight], [1920, 1080]);
assert.deepEqual(plan.pictures[0], { url: "/first.png", x: 120, y: 800, width: 600, height: 100 });
assert.deepEqual(plan.pictures[1], { url: "/second.png", x: 10, y: 20, width: 80, height: 40 });
assert.equal(assRendererFailureMessage(new Error("WebAssembly.Module blocked by Content Security Policy")), "浏览器安全策略阻止了 ASS 特效渲染器");
assert.equal(assRendererFailureMessage(new Error("WebAssembly worker startup timeout")), "ASS 特效渲染器启动失败");
assert.equal(assRendererFailureMessage(new Error("worker failed")), "ASS 特效渲染器启动失败");
console.log("subtitle-rendering 测试全部通过");
