import fs from "node:fs";
import path from "node:path";

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} 必须大于 0`);
  return number;
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} 不能为空`);
  return text;
}

function formatSrtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function formatAssTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cents = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cents).padStart(2, "0")}`;
}

function escapeAssText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r?\n/gu, "\\N");
}

export function normalizeBilingualCaptionPairs(rawPairs, options = {}) {
  if (!Array.isArray(rawPairs) || rawPairs.length === 0) throw new Error("双语字幕至少需要一个短语 cue");
  const maximumDuration = options.maximumDuration == null ? null : positiveNumber(options.maximumDuration, "maximumDuration");
  const maximumChineseCharacters = Number(options.maximumChineseCharacters ?? 24);
  const maximumEnglishCharacters = Number(options.maximumEnglishCharacters ?? 72);
  let previousEnd = -Infinity;
  const ids = new Set();
  return rawPairs.map((raw, index) => {
    const id = requiredText(raw.id || `caption-${index + 1}`, `caption ${index + 1} id`);
    if (ids.has(id)) throw new Error(`双语字幕 cue id 重复：${id}`);
    ids.add(id);
    const start = Number(raw.start_seconds);
    const end = Number(raw.end_seconds);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) {
      throw new Error(`双语字幕 ${id} 的时间范围无效`);
    }
    if (start < previousEnd - 0.0005) throw new Error(`双语字幕 ${id} 与前一条 cue 重叠或倒序`);
    if (maximumDuration !== null && end > maximumDuration + 0.001) throw new Error(`双语字幕 ${id} 超出当前声音或镜头时长`);
    previousEnd = end;
    const zh = requiredText(raw.zh, `双语字幕 ${id} 中文`);
    const en = requiredText(raw.en, `双语字幕 ${id} 英文`);
    if (Array.from(zh).length > maximumChineseCharacters) throw new Error(`双语字幕 ${id} 的中文一次显示过多；请拆成不超过 ${maximumChineseCharacters} 个字符的短语 cue`);
    if (Array.from(en).length > maximumEnglishCharacters) throw new Error(`双语字幕 ${id} 的英文一次显示过多；请拆成不超过 ${maximumEnglishCharacters} 个字符的短语 cue`);
    return {
      id,
      start_seconds: start,
      end_seconds: end,
      zh,
      en,
    };
  });
}

export function createBilingualSubtitleStyles(width, height, options = {}) {
  const canvasWidth = positiveNumber(width, "字幕画布宽度");
  const canvasHeight = positiveNumber(height, "字幕画布高度");
  const outline = Math.max(2, Math.round(canvasHeight * 0.003));
  return {
    chinese: {
      id: options.chineseStyleId || "caption-zh",
      font_family: options.chineseFont || "Microsoft YaHei",
      font_size: Math.max(30, Math.round(canvasHeight * 0.045)),
      primary_color: "#FFFFFF",
      outline_color: "#101010",
      outline_width: outline,
      margin_vertical: Math.max(72, Math.round(canvasHeight * 0.1)),
      alignment: 2,
      bold: true,
      italic: false,
    },
    english: {
      id: options.englishStyleId || "caption-en",
      font_family: options.englishFont || "Arial",
      font_size: Math.max(20, Math.round(canvasHeight * 0.029)),
      primary_color: "#E4E4E4",
      outline_color: "#101010",
      outline_width: outline,
      margin_vertical: Math.max(42, Math.round(canvasHeight * 0.057)),
      alignment: 2,
      bold: false,
      italic: false,
    },
  };
}

export function createBilingualTimelineCaptions(rawPairs, options = {}) {
  const pairs = normalizeBilingualCaptionPairs(rawPairs, {maximumDuration: options.maximumDuration});
  const offset = Number(options.timelineOffsetSeconds || 0);
  if (!Number.isFinite(offset) || offset < 0) throw new Error("timelineOffsetSeconds 必须是不小于 0 的数字");
  const styles = createBilingualSubtitleStyles(options.width, options.height, options);
  const prefix = options.idPrefix || "caption";
  return {
    pairs,
    styles: [styles.chinese, styles.english],
    chinese: pairs.map((pair) => ({
      id: `${prefix}-${pair.id}-zh`,
      type: "caption",
      timeline_start_seconds: offset + pair.start_seconds,
      duration_seconds: pair.end_seconds - pair.start_seconds,
      text: pair.zh,
      style_id: styles.chinese.id,
      language: "zh-CN",
    })),
    english: pairs.map((pair) => ({
      id: `${prefix}-${pair.id}-en`,
      type: "caption",
      timeline_start_seconds: offset + pair.start_seconds,
      duration_seconds: pair.end_seconds - pair.start_seconds,
      text: pair.en,
      style_id: styles.english.id,
      language: "en",
    })),
  };
}

export function serializeBilingualAss(rawPairs, options = {}) {
  const pairs = normalizeBilingualCaptionPairs(rawPairs, {maximumDuration: options.maximumDuration});
  const width = positiveNumber(options.width, "字幕画布宽度");
  const height = positiveNumber(options.height, "字幕画布高度");
  const styles = createBilingualSubtitleStyles(width, height, options);
  const chineseHorizontalMargin = Math.max(36, Math.round(width * 0.057));
  const englishHorizontalMargin = Math.max(chineseHorizontalMargin, Math.round(width * 0.068));
  const styleLine = (style, horizontalMargin) => [
    `Style: ${style.id}`,
    style.font_family,
    style.font_size,
    style.primary_color === "#FFFFFF" ? "&H00FFFFFF" : "&H00E4E4E4",
    "&H000000FF",
    "&H00101010",
    "&H50000000",
    style.bold ? -1 : 0,
    0, 0, 0, 100, 100, 0, 0, 1,
    style.outline_width,
    1,
    style.alignment,
    horizontalMargin,
    horizontalMargin,
    style.margin_vertical,
    1,
  ].join(",");
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    styleLine(styles.chinese, chineseHorizontalMargin),
    styleLine(styles.english, englishHorizontalMargin),
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  for (const pair of pairs) {
    lines.push(`Dialogue: 0,${formatAssTime(pair.start_seconds)},${formatAssTime(pair.end_seconds)},${styles.chinese.id},,0,0,0,,${escapeAssText(pair.zh)}`);
    lines.push(`Dialogue: 0,${formatAssTime(pair.start_seconds)},${formatAssTime(pair.end_seconds)},${styles.english.id},,0,0,0,,${escapeAssText(pair.en)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function serializeCaptionSrt(rawPairs, language) {
  const pairs = normalizeBilingualCaptionPairs(rawPairs);
  if (!new Set(["zh", "en"]).has(language)) throw new Error("SRT language 必须是 zh 或 en");
  return `${pairs.map((pair, index) => [
    index + 1,
    `${formatSrtTime(pair.start_seconds)} --> ${formatSrtTime(pair.end_seconds)}`,
    pair[language],
  ].join("\n")).join("\n\n")}\n`;
}

export function writeBilingualCaptionFiles(options) {
  const pairs = normalizeBilingualCaptionPairs(options.pairs, {maximumDuration: options.maximumDuration});
  const ass = path.resolve(options.ass);
  const chineseSrt = path.resolve(options.chineseSrt);
  const englishSrt = path.resolve(options.englishSrt);
  for (const target of [ass, chineseSrt, englishSrt]) fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(ass, serializeBilingualAss(pairs, options), "utf8");
  fs.writeFileSync(chineseSrt, serializeCaptionSrt(pairs, "zh"), "utf8");
  fs.writeFileSync(englishSrt, serializeCaptionSrt(pairs, "en"), "utf8");
  return {pairs, ass, chineseSrt, englishSrt};
}
