import assert from "node:assert/strict";
import path from "node:path";
import { detectedEpisodeNumber, detectedRomanPartNumber, isExtraContentFolderName, quickSelectionForFolder, quickSelectionsForFolder } from "./video-selection.mjs";

const labelsFor = (folderPath, fileNames) => quickSelectionsForFolder(folderPath, fileNames).map((item) => item?.label || null);

const detectedCases = new Map([
  ["Show.S01E02.1080p.mkv", 2],
  ["Show 1x03 WEB-DL.mkv", 3],
  ["Show EP04 10-bit.mkv", 4],
  ["Show Episode 05.mkv", 5],
  ["动画 第06话 1080P.mkv", 6],
  ["[Group][Show][07][1080P][HEVC-10bit].mkv", 7],
  ["[Group][Show](08v2)[BDRip].mkv", 8],
  ["Show - 09 - Title.mkv", 9],
  ["Show E10 WEB-DL.mkv", 10],
  ["动画 第11集 BDRip.mkv", 11],
  ["Show [12.5].mkv", 12.5],
  ["Show #13 WEB-DL.mkv", 13],
  ["Show 14話 BDRip.mkv", 14],
  ["Show 15集 BDRip.mkv", 15],
  ["Show - 1 - Title.mkv", 1],
  ["Show 0002.mkv", 2],
  ["Show S02E03v2.mkv", 3],
  ["Show E04v3.mkv", 4],
  ["Show {05}.mkv", 5],
  ["Show 【06】.mkv", 6],
  ["动画 第07回.mkv", 7],
  ["Anime 08화.mkv", 8],
  ["Show 12.5 WEB-DL.mkv", 12.5],
]);
for (const [fileName, expected] of detectedCases) {
  assert.equal(detectedEpisodeNumber(fileName), expected, `${fileName} 应识别为第 ${expected} 集`);
}

for (const fileName of [
  "Show 3 [1080P] HEVC-10bit.mkv",
  "Movie 2024 1080P 10-bit.mkv",
  "OVA.mkv",
  "Show [01][02].mkv",
  "Show 01-02 Collection.mkv",
]) {
  assert.equal(detectedEpisodeNumber(fileName), null, `${fileName} 不应生成快速集数`);
}

for (const folderName of [
  "PV", "Trailers", "Promos", "特典映像", "未使用映像", "Extra Episode", "Web Extras", "Omake",
  "NC", "NCOP&NCED", "Creditless", "Clean Opening", "menu", "OVA", "Behind the Scenes", "Making Of",
  "预告片", "宣传片", "花絮", "幕后", "采访", "删减片段", "特别篇", "无字幕OP",
]) {
  assert.equal(isExtraContentFolderName(folderName), true, `${folderName} 应识别为附加内容文件夹`);
}
assert.equal(isExtraContentFolderName("[DBD-Raws][作品][01-13TV全集+特典映像][1080P]"), false, "作品总目录不能因包含特典字样而被误判");

assert.deepEqual(
  quickSelectionForFolder(path.join("作品", "正片"), 1),
  { number: 1, label: "第 01 集", kind: "episode" },
);

assert.deepEqual(
  labelsFor(path.join("作品", "正片"), [
    "Show #01.mkv",
    "Show 02話.mkv",
    "Show 03集.mkv",
  ]),
  ["第 01 集", "第 02 集", "第 03 集"],
  "井号和数字后缀话/集属于强标记，应直接识别",
);

assert.deepEqual(
  labelsFor(path.join("追番", "单集更新"), [
    "[Group] Weekly Show - 04 (CR 1920x1080 AVC AAC MKV) [HASH].mkv",
  ]),
  ["第 04 集"],
  "作品名 - 集数 (技术信息) 格式即使目录中暂时只有一集也应识别",
);

assert.deepEqual(
  labelsFor(path.join("作品", "正片"), [
    "Show - 1 - Opening.mkv",
    "Show - 2 - Next.mkv",
    "Show 0003 Finale.mkv",
  ]),
  ["第 01 集", "第 02 集", "第 03 集"],
  "单位数分隔格式和四位零填充编号应在同系列序列中识别",
);

assert.deepEqual(
  labelsFor(path.join("电影", "单片"), [
    "Ed Wood.mkv",
    "Apollo 13.mkv",
    "Catch-22.mkv",
    "Room 237.mkv",
    "Special 26.mkv",
  ]),
  [null, null, null, null, null],
  "电影标题中的 Ed、Special 和裸数字不得误判为附加内容或集数",
);

assert.deepEqual(
  labelsFor(path.join("作品", "正片"), [
    "Series 01 - Start.mkv",
    "Series 02 - Continue.mkv",
    "Series 03 - End.mkv",
  ]),
  ["第 01 集", "第 02 集", "第 03 集"],
  "同前缀的裸编号序列应可靠识别",
);

assert.deepEqual(
  labelsFor(path.join("作品", "正片"), [
    "Show Recap 01.mkv",
    "Show [sp].mkv",
    "PV 02.mkv",
  ]),
  ["总集篇 01", "SP", "PV 02"],
  "带系列前缀、括号或大写形式的附加标记仍应识别",
);
assert.deepEqual(
  quickSelectionForFolder(path.join("作品", "PV"), 1),
  { number: 1, label: "PV 01", kind: "extra" },
);
assert.deepEqual(
  quickSelectionForFolder(path.join("作品", "未使用映像"), 3),
  { number: 3, label: "未使用映像 03", kind: "extra" },
);

assert.deepEqual(
  labelsFor(path.join("作品", "正片"), [
    "Show [14][1080P].mkv",
    "Show [14][NC.Ver][1080P].mkv",
    "Show [16][1080P].mkv",
    "Show [16][NC Version][1080P].mkv",
    "Show [SP][1080P].mkv",
  ]),
  ["第 14 集", "第 14 集 NC版", "第 16 集", "第 16 集 NC版", "SP"],
  "同集普通版、NC 版和无编号 SP 应生成互不冲突的标题",
);

assert.deepEqual(
  labelsFor(path.join("作品", "menu"), [
    "Show [menu][D1][01][1080P].mkv",
    "Show [menu][D1][02][1080P].mkv",
    "Show [menu][D2][01][1080P].mkv",
    "Show [menu][SP5][1080P].mkv",
    "Show [menu][SP][1080P].mkv",
  ]),
  ["menu D1-01", "menu D1-02", "menu D2-01", "menu SP5", "menu SP"],
  "光盘菜单应组合光盘号、条目号和 SP 标记",
);

assert.deepEqual(
  labelsFor(path.join("作品", "正片"), [
    "Show 01 [BD 1920x1080 HEVC-10bit].mkv",
    "Show NCOP 01 [BD 1920x1080 HEVC-10bit].mkv",
    "Show NCED1 [BD 1920x1080 HEVC-10bit].mkv",
    "Show Recap 01 [BD 1920x1080 HEVC-10bit].mkv",
    "Show [01][Pre][WebRip].mkv",
  ]),
  ["第 01 集", "NCOP 01", "NCED 01", "总集篇 01", "第 01 集 先行版"],
  "NCOP、NCED、总集篇和先行版不得与正片编号冲突",
);

assert.deepEqual(
  labelsFor(path.join("作品", "NCOP&NCED"), [
    "Show [NCOP][1080P].mkv",
    "Show [NCED][1080P].mkv",
    "Show [NCOP2][1080P].mkv",
  ]),
  ["NCOP", "NCED", "NCOP 02"],
  "无编号和紧邻编号的 NCOP/NCED 都应识别",
);

assert.deepEqual(
  labelsFor(path.join("作品", "特典映像"), [
    "Show [Tokuten][1080P].mkv",
    "Show Feature Without Number.mkv",
  ]),
  ["特典映像", "特典映像 02"],
  "附加内容文件夹中的无编号文件应使用内容类型或稳定顺序回退",
);

assert.equal(detectedRomanPartNumber("Kizumonogatari III - Reiketsu-hen.mkv"), 3);
assert.deepEqual(
  labelsFor(path.join("作品", "Kizumonogatari"), [
    "Kizumonogatari I - Tekketsu-hen.mkv",
    "Kizumonogatari II - Nekketsu-hen.mkv",
    "Kizumonogatari III - Reiketsu-hen.mkv",
  ]),
  ["第 01 部", "第 02 部", "第 03 部"],
  "同文件夹内连续且唯一的罗马数字分部应生成快速标题",
);
assert.deepEqual(
  labelsFor(path.join("电影", "单片"), ["Movie II - Title.mkv"]),
  [null],
  "单个电影标题中的罗马数字不能独立触发快速选集",
);
assert.deepEqual(
  labelsFor(path.join("作品", "正片"), ["Encode A [01].mkv", "Encode B [01].mkv"]),
  [null, null],
  "没有版本标记的真正重复编号仍应保护性回退",
);

console.log("视频快速选集正则与附加内容分类测试通过。");
