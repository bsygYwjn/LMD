import path from "node:path";

const TECHNICAL_NUMBERS = new Set([240, 360, 480, 540, 720, 1080, 1440, 2160, 4320]);
const EXTRA_CONTENT_FOLDER_PATTERNS = [
  /^(?:pvs?|promos?|promotional videos?|previews?|trailers?|teasers?|cms?)(?: \d+)?$/i,
  /^(?:tokuten|omake|bonus(?: features?)?|extras?|web extras?|extra episodes?|special(?: features?|s)?|shorts?)(?: \d+)?$/i,
  /^(?:nc|creditless|clean (?:opening|ending)|(?:(?:nc)?op|(?:nc)?ed)(?:[&+/-](?:(?:nc)?op|(?:nc)?ed))*)(?: \d+)?$/i,
  /^(?:ova|oad|oav|sp|menu|menus)(?: \d+)?$/i,
  /^(?:interviews?|behind the scenes|making of|deleted scenes)(?: \d+)?$/i,
  /^(?:特典(?:映像)?|映像特典|未使用映像|无字幕(?:op|ed|片头|片尾)|预告(?:片)?|宣传片|制作花絮|花絮|幕后|采访|删减片段|特别篇|番外|菜单)(?: ?\d+)?$/iu,
];
const ROMAN_VALUES = new Map([
  ["I", 1], ["II", 2], ["III", 3], ["IV", 4], ["V", 5], ["VI", 6],
  ["VII", 7], ["VIII", 8], ["IX", 9], ["X", 10], ["XI", 11], ["XII", 12],
]);

function episodeNumber(rawValue, { rejectTechnical = false } = {}) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value >= 10000) return null;
  if (rejectTechnical && Number.isInteger(value)) {
    if (TECHNICAL_NUMBERS.has(value)) return null;
    if (value >= 1900 && value <= 2099) return null;
  }
  return value;
}

function uniqueMatchedNumber(baseName, pattern, options = {}) {
  const candidates = [...baseName.matchAll(pattern)]
    .map((match) => episodeNumber(match[1], options))
    .filter((value) => value !== null);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function hasMatches(baseName, pattern) {
  pattern.lastIndex = 0;
  const matched = pattern.test(baseName);
  pattern.lastIndex = 0;
  return matched;
}

function detectedEpisode(baseName) {
  // 范围通常表示合集而非单集；先排除，避免只截取范围左侧。
  if (/(?:^|[^\d])\d{1,4}\s*[-~～–—]\s*\d{1,4}(?=$|[^\d])/u.test(baseName)) return null;

  const explicitPatterns = [
    { pattern: /(?:^|[^a-z0-9])s\d{1,2}e(\d{1,4}(?:\.\d+)?)(?:v\d+)?(?=$|[^a-z0-9])/gi, source: "season-episode" },
    { pattern: /(?:^|[^a-z0-9])\d{1,2}x(\d{1,4}(?:\.\d+)?)(?:v\d+)?(?=$|[^a-z0-9])/gi, source: "season-cross-episode" },
    { pattern: /(?:^|[\s._\-[\(])(?:episodes?|eps?|e)[\s._-]?(\d{1,4}(?:\.\d+)?)(?:v\d+)?(?=$|[\s._\-\]\)])/gi, source: "episode-token" },
    { pattern: /第\s*(\d{1,4}(?:\.\d+)?)\s*[话話集回]/gu, source: "cjk-prefix" },
    { pattern: /(?:^|[^\d])#\s*(\d{1,4}(?:\.\d+)?)(?=$|[^\d])/g, source: "hash" },
    { pattern: /(?:^|[\s._\-[\(])(\d{1,4}(?:\.\d+)?)\s*[话話集回화](?=$|[\s._\-\]\)])/gu, source: "cjk-suffix" },
    // 发布名中最常见的 “作品名 - 01 [来源]” / “作品名 - 01 (来源)” 格式。
    { pattern: /\s[-–—]\s*(\d{1,4}(?:\.\d+)?)(?:v\d+)?(?=\s*(?:[-–—]|[\[\(【]))/g, source: "title-separated" },
  ];
  for (const { pattern, source } of explicitPatterns) {
    if (!hasMatches(baseName, pattern)) continue;
    const number = uniqueMatchedNumber(baseName, pattern);
    return number === null ? null : { number, source, strong: true, seriesKey: "" };
  }

  const bracketedPattern = /(?:\[|\(|\{|【)(\d{1,4}(?:\.\d+)?)(?:v\d+)?(?:\]|\)|\}|】)/gi;
  if (hasMatches(baseName, bracketedPattern)) {
    const number = uniqueMatchedNumber(baseName, bracketedPattern, { rejectTechnical: true });
    return number === null ? null : { number, source: "bracketed", strong: true, seriesKey: "" };
  }

  const weakPatterns = [
    // 至少两位的普通独立编号，以及 0001 这类四位零填充编号。
    /(?:^|[\s._-])(0\d{1,3}(?:\.\d+)?|[1-9]\d{1,2}(?:\.\d+)?)(?:v\d+)?(?=$|[\s._-])/gi,
    // 其余单位数只接受两侧都有明显分隔符的 “Show - 1 - Title” 形式。
    /(?:^|[\s._])[-–—]\s*(\d)\s*[-–—](?=$|[\s._])/g,
  ];
  const matches = weakPatterns.flatMap((pattern) => [...baseName.matchAll(pattern)]);
  const candidates = matches
    .filter((match) => {
      const tail = baseName.slice((match.index || 0) + match[0].length);
      return !/^[\s._-]*(?:bits?|p|fps|hz|khz|k)\b/i.test(tail);
    })
    .map((match) => ({
      number: episodeNumber(match[1], { rejectTechnical: true }),
      index: (match.index || 0) + Math.max(0, match[0].indexOf(match[1])),
    }))
    .filter((candidate) => candidate.number !== null);
  const unique = [...new Set(candidates.map((candidate) => candidate.number))];
  if (unique.length !== 1) return null;

  const first = candidates.find((candidate) => candidate.number === unique[0]);
  const prefix = baseName.slice(0, first?.index || 0)
    .normalize("NFKC")
    .replace(/^(?:\s*\[[^\]]+\])+\s*/g, "")
    .replace(/[\s._\-–—]+$/g, "")
    .replace(/[\s._\-–—]+/g, " ")
    .trim()
    .toLowerCase();
  return { number: unique[0], source: "separated", strong: false, seriesKey: prefix };
}

export function detectedEpisodeNumber(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  return detectedEpisode(baseName)?.number ?? null;
}

export function detectedRomanPartNumber(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const matches = [...baseName.matchAll(/(?:^|[\s._-])(XII|XI|IX|VIII|VII|VI|IV|III|II|I)(?=$|[\s._-])/gi)]
    .map((match) => ROMAN_VALUES.get(match[1].toUpperCase()))
    .filter((value) => Number.isFinite(value));
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

export function isExtraContentFolderName(folderName) {
  const normalized = String(folderName || "")
    .normalize("NFKC")
    .trim()
    .replace(/[._]+/g, " ")
    .replace(/\s*([&+/-])\s*/g, "$1")
    .replace(/\s+/g, " ");
  return EXTRA_CONTENT_FOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function formattedEpisodeNumber(value) {
  const [integer, fraction] = String(value).split(".");
  return `${integer.padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
}

export function quickSelectionForFolder(folderPath, number) {
  if (!Number.isFinite(number)) return null;
  const folderName = path.basename(folderPath).trim();
  const formattedNumber = formattedEpisodeNumber(number);
  if (isExtraContentFolderName(folderName)) {
    return { number, label: `${folderName} ${formattedNumber}`, kind: "extra" };
  }
  return { number, label: `第 ${formattedNumber} 集`, kind: "episode" };
}

function conflictKey(label) {
  return String(label || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function candidateFromQuickSelection(quickSelection, source, { ordinalizable = false } = {}) {
  return quickSelection
    ? { ...quickSelection, source, ordinalizable, conflictKey: conflictKey(quickSelection.label) }
    : null;
}

function menuCandidate(folderPath, baseName, detectedEpisode) {
  const folderName = path.basename(folderPath).trim();
  const menuContext = /^(?:menu|menus)$/i.test(folderName)
    || /(?:^|[\s._\-[\(])menus?(?=$|[\s._\-\]\)])/i.test(baseName);
  if (!menuContext) return null;

  const special = baseName.match(/(?:^|[\s._\-[\(])sp[\s._-]?(\d{1,3})?(?=$|[\s._\-\]\)])/i);
  if (special) {
    const specialNumber = special[1] ? Number(special[1]) : null;
    const quickNumber = specialNumber === null ? 9000 : 9000 + specialNumber;
    const label = `${folderName} SP${specialNumber === null ? "" : specialNumber}`;
    return candidateFromQuickSelection(
      { number: quickNumber, label, kind: "extra" },
      "menu",
      { ordinalizable: specialNumber === null },
    );
  }

  const disc = baseName.match(/(?:^|[\s._\-[\(])d(?:isc)?[\s._-]?(\d{1,2})(?=$|[\s._\-\]\)])/i);
  if (disc && detectedEpisode !== null) {
    const discNumber = Number(disc[1]);
    return candidateFromQuickSelection({
      number: discNumber * 100 + detectedEpisode,
      label: `${folderName} D${discNumber}-${formattedEpisodeNumber(detectedEpisode)}`,
      kind: "extra",
    }, "menu");
  }
  if (detectedEpisode !== null) {
    return candidateFromQuickSelection({
      number: detectedEpisode,
      label: `${folderName} ${formattedEpisodeNumber(detectedEpisode)}`,
      kind: "extra",
    }, "menu");
  }
  return null;
}

function specialContentMatch(baseName, folderPath) {
  const patterns = [
    /(?:^|[\s._\-[\(])(NCOP|NCED|OP|ED)(?:[\s._-]?(\d{1,3}))?(?=$|[\s._\-\]\)])/i,
    /(?:^|[\s._\-[\(])(OVA|OAD|OAV|SP)(?:[\s._-]?(\d{1,3}))?(?=$|[\s._\-\]\)])/i,
    /(?:^|[\s._\-[\(])(PV|CM|TRAILER|TEASER|PREVIEW)(?:[\s._-]?(\d{1,3}))?(?=$|[\s._\-\]\)])/i,
    /(?:^|[\s._\-[\(])(TOKUTEN|BONUS|EXTRA|SPECIAL|RECAP)(?:[\s._-]?(\d{1,3}))?(?=$|[\s._\-\]\)])/i,
    /(?:^|[\s._\-[\(])(特典映像|映像特典|特典|未使用映像|预告片|预告|宣传片|花絮|番外)(?:[\s._-]?(\d{1,3}))?(?=$|[\s._\-\]\)])/iu,
  ];
  for (const pattern of patterns) {
    const match = baseName.match(pattern);
    if (!match) continue;
    const rawToken = match[1];
    const tokenIndex = (match.index || 0) + Math.max(0, match[0].indexOf(rawToken));
    const preceding = baseName[tokenIndex - 1] || "";
    const bracketed = preceding === "[" || preceding === "(";
    const uppercaseMarker = rawToken === rawToken.toUpperCase();
    const hasSeriesPrefix = baseName.slice(0, tokenIndex).replace(/[\s._\-[\(]+$/g, "").trim().length > 0;
    const extraFolder = isExtraContentFolderName(path.basename(folderPath));
    // 标题开头的 Ed/Special 等普通单词不能仅凭大小写无关匹配触发。
    if (!/[\u3400-\u9fff]/u.test(rawToken) && !uppercaseMarker && !bracketed && !hasSeriesPrefix && !extraFolder) continue;
    return { token: rawToken, number: match[2] ? Number(match[2]) : null };
  }
  return null;
}

function specialContentLabel(token, folderPath) {
  const normalized = token.normalize("NFKC").toUpperCase();
  const folderName = path.basename(folderPath).trim();
  if ((normalized === "TOKUTEN" || normalized.includes("特典")) && isExtraContentFolderName(folderName)) return folderName;
  if (normalized === "RECAP") return "总集篇";
  if (["TRAILER", "TEASER", "PREVIEW"].includes(normalized)) return "预告";
  if (normalized === "TOKUTEN") return "特典";
  if (["NCOP", "NCED", "OP", "ED", "OVA", "OAD", "OAV", "SP", "PV", "CM"].includes(normalized)) return normalized;
  return token.normalize("NFKC");
}

function specialContentCandidate(folderPath, baseName, detectedEpisode) {
  const special = specialContentMatch(baseName, folderPath);
  if (!special) return null;
  const number = special.number ?? detectedEpisode;
  const labelBase = specialContentLabel(special.token, folderPath);
  const label = number === null ? labelBase : `${labelBase} ${formattedEpisodeNumber(number)}`;
  return candidateFromQuickSelection(
    { number: number ?? 1, label, kind: "extra" },
    "special",
    { ordinalizable: number === null },
  );
}

function episodeVariantLabel(baseName) {
  if (/(?:^|[\s._\-[\(])nc[\s._-]*ver(?:sion)?(?=$|[\s._\-\]\)])/i.test(baseName)) return "NC版";
  if (/(?:^|[\s._\-[\(])(?:pre|pre[\s._-]?air)(?=$|[\s._\-\]\)])/i.test(baseName)) return "先行版";
  if (/(?:^|[\s._\-[\(])directors?[\s._-]?cut(?=$|[\s._\-\]\)])/i.test(baseName)) return "导演剪辑版";
  if (/(?:^|[\s._\-[\(])extended(?=$|[\s._\-\]\)])/i.test(baseName)) return "加长版";
  if (/(?:^|[\s._\-[\(])alt(?:ernate)?(?=$|[\s._\-\]\)])/i.test(baseName)) return "另一版本";
  const version = baseName.match(/[\[(]\d{1,4}(?:\.\d+)?v(\d+)[\])]/i)
    || baseName.match(/(?:s\d{1,2}e\d{1,4}|(?:episodes?|eps?|e)[\s._-]?\d{1,4})[\s._-]*v(\d+)/i);
  return version ? `v${version[1]}` : "";
}

function quickSelectionCandidateForFile(folderPath, fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const detection = detectedEpisode(baseName);
  const detectedNumber = detection?.number ?? null;
  const menu = menuCandidate(folderPath, baseName, detectedNumber);
  if (menu) return menu;

  const special = specialContentCandidate(folderPath, baseName, detectedNumber);
  if (special) return special;

  if (detectedNumber !== null) {
    const quickSelection = quickSelectionForFolder(folderPath, detectedNumber);
    const variant = episodeVariantLabel(baseName);
    if (variant) quickSelection.label = `${quickSelection.label} ${variant}`;
    const candidate = candidateFromQuickSelection(quickSelection, "episode");
    candidate.strong = detection.strong;
    candidate.seriesKey = detection.seriesKey;
    return candidate;
  }

  const romanPart = detectedRomanPartNumber(fileName);
  if (romanPart !== null) {
    return candidateFromQuickSelection({
      number: romanPart,
      label: `第 ${formattedEpisodeNumber(romanPart)} 部`,
      kind: "episode",
    }, "roman");
  }
  return null;
}

function publicQuickSelection(candidate) {
  return candidate ? { number: candidate.number, label: candidate.label, kind: candidate.kind } : null;
}

export function quickSelectionsForFolder(folderPath, fileNames) {
  const names = Array.isArray(fileNames) ? fileNames : [];
  const candidates = names.map((fileName) => quickSelectionCandidateForFile(folderPath, fileName));

  // 裸编号只有在同目录形成稳定系列时才可信。显式 E01/[01]/第01话不受此限制。
  const weakGroups = new Map();
  candidates.forEach((candidate, index) => {
    if (!candidate || candidate.source !== "episode" || candidate.strong !== false) return;
    const key = candidate.seriesKey || "__leading-number__";
    if (!weakGroups.has(key)) weakGroups.set(key, []);
    weakGroups.get(key).push(index);
  });
  for (const indexes of weakGroups.values()) {
    const numbers = [...new Set(indexes.map((index) => candidates[index].number))].sort((a, b) => a - b);
    const seriesKey = candidates[indexes[0]].seriesKey;
    const corroboratedBySeriesPeer = Boolean(seriesKey) && names.some((fileName, otherIndex) => {
      if (indexes.includes(otherIndex) || !candidates[otherIndex]) return false;
      const normalizedName = path.basename(fileName, path.extname(fileName))
        .normalize("NFKC")
        .replace(/^(?:\s*\[[^\]]+\])+\s*/g, "")
        .trim()
        .toLowerCase();
      return normalizedName === seriesKey || normalizedName.startsWith(`${seriesKey} `)
        || normalizedName.startsWith(`${seriesKey}-`) || normalizedName.startsWith(`${seriesKey}.`);
    });
    const corroboratedByVariant = indexes.every((index) => candidates.some((other, otherIndex) => (
      otherIndex !== index
      && other
      && other.number === candidates[index].number
      && other.source !== "episode"
    )));
    const coherentLeadingSequence = candidates[indexes[0]].seriesKey
      || (numbers.length >= 2 && numbers[numbers.length - 1] - numbers[0] <= Math.max(4, numbers.length * 2));
    if ((indexes.length >= 2 && numbers.length === indexes.length && coherentLeadingSequence)
      || corroboratedByVariant || corroboratedBySeriesPeer) continue;
    indexes.forEach((index) => { candidates[index] = null; });
  }

  const romanCandidates = candidates.filter((candidate) => candidate?.source === "roman");
  const uniqueRomanNumbers = new Set(romanCandidates.map((candidate) => candidate.number));
  const romanSequenceIsReliable = romanCandidates.length >= 2 && uniqueRomanNumbers.size === romanCandidates.length;
  if (!romanSequenceIsReliable) {
    candidates.forEach((candidate, index) => {
      if (candidate?.source === "roman") candidates[index] = null;
    });
  }

  if (isExtraContentFolderName(path.basename(folderPath))) {
    candidates.forEach((candidate, index) => {
      if (candidate) return;
      candidates[index] = candidateFromQuickSelection(quickSelectionForFolder(folderPath, index + 1), "extra-fallback");
    });
  }

  const initialGroups = new Map();
  candidates.forEach((candidate, index) => {
    if (!candidate) return;
    if (!initialGroups.has(candidate.conflictKey)) initialGroups.set(candidate.conflictKey, []);
    initialGroups.get(candidate.conflictKey).push(index);
  });
  for (const indexes of initialGroups.values()) {
    if (indexes.length < 2 || !indexes.every((index) => candidates[index]?.ordinalizable)) continue;
    indexes.forEach((index, ordinal) => {
      const candidate = candidates[index];
      candidate.number = ordinal + 1;
      candidate.label = `${candidate.label} ${formattedEpisodeNumber(ordinal + 1)}`;
      candidate.conflictKey = conflictKey(candidate.label);
      candidate.ordinalizable = false;
    });
  }

  const counts = new Map();
  for (const candidate of candidates) {
    if (candidate) counts.set(candidate.conflictKey, (counts.get(candidate.conflictKey) || 0) + 1);
  }
  return candidates.map((candidate) => candidate && counts.get(candidate.conflictKey) === 1
    ? publicQuickSelection(candidate)
    : null);
}
