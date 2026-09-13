// Danmaku time-mapping tests.
//
// The mapping has three layers (provider, media version, viewer) and applying
// any of them twice is the failure this suite guards against.
import assert from "node:assert/strict";
import { applyMapping, mappedTime, validateAnchors } from "./danmaku-time.ts";

// 1. No mapping at all keeps the provider timeline, plus the viewer delay.
assert.equal(mappedTime(100, [], 0), 100);
assert.equal(mappedTime(100, [], 2.5), 102.5);
assert.equal(mappedTime(100, [], -3), 97);
console.log("PASS 未校准时保持来源时间并只叠加一次人工偏移");

// 2. A single anchor only affects comments at or after the anchor. This is the
// removed-OP case: the provider keeps its 90s intro, the video dropped it.
const opRemoved = [{ source: 90, target: 20 }];
assert.equal(mappedTime(120, opRemoved, 0), 50, "锚点之后应用偏移");
assert.equal(mappedTime(90, opRemoved, 0), 20, "锚点本身落在视频时间上");
assert.equal(mappedTime(30, opRemoved, 0), 30, "锚点之前的弹幕不被该锚点移动");
assert.equal(mappedTime(89.9, opRemoved, 0), 89.9, "锚点前一瞬间仍保持来源时间");
console.log("PASS 首个锚点之前不误用该锚点偏移");

// 3. Multiple anchors form piecewise offsets; each one starts a new interval.
const segments = [{ source: 90, target: 20 }, { source: 600, target: 540 }];
assert.equal(mappedTime(100, segments, 0), 30);
assert.equal(mappedTime(599, segments, 0), 529);
assert.equal(mappedTime(600, segments, 0), 540);
assert.equal(mappedTime(700, segments, 0), 640);
console.log("PASS 多锚点分段偏移按区间生效");

// 4. The viewer delay is applied exactly once, on top of the segment offset.
assert.equal(mappedTime(120, opRemoved, 1.5), 51.5);
assert.equal(mappedTime(30, opRemoved, 1.5), 31.5);
console.log("PASS 人工偏移与分段映射不重复叠加");

// 5. Removed intervals drop their comments instead of shifting them.
const options = { anchors: [], excludes: [{ from: 90, to: 130 }], delay: 0 };
assert.equal(applyMapping(100, options), null, "删除区间内的弹幕不显示");
assert.equal(applyMapping(89.9, options), 89.9, "区间之前正常显示");
assert.equal(applyMapping(130, options), 130, "区间结束点恢复显示");
assert.equal(applyMapping(100, { anchors: opRemoved, excludes: [], delay: 0 }), 30);
console.log("PASS 删除区间内的弹幕被丢弃而不是平移");

// 6. Anchor validation protects ordering and bounds.
assert.equal(validateAnchors([]), "");
assert.equal(validateAnchors([{ source: 10, target: 5 }, { source: 20, target: 15 }]), "");
assert.match(validateAnchors([{ source: 10, target: 5 }, { source: 10, target: 6 }]), /递增/);
assert.match(validateAnchors([{ source: 10, target: 50 }, { source: 20, target: 40 }]), /不能小于/);
assert.match(validateAnchors(Array.from({ length: 51 }, (_, index) => ({ source: index * 10, target: index * 10 }))), /50/);
console.log("PASS 锚点校验拒绝乱序与越界");

// 7. Provider-calibrated timelines must not be re-offset: no anchors means the
// provider numbers pass through untouched apart from the explicit viewer delay.
const providerCalibrated = 12.345;
assert.equal(applyMapping(providerCalibrated, { anchors: [], excludes: [], delay: 0 }), providerCalibrated);
console.log("PASS 供应方已校准时间轴不被再次叠加");

console.log("danmaku-time 测试全部通过");
