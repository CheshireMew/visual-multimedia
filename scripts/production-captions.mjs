#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertJsonSchema } from "./json_schema_contract.mjs";
import { validateMediaTranscript } from "./validate-media-transcript.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptRoot);
const captionSchema = path.join(skillRoot, "schemas", "production-captions.v1.schema.json");
const qcSchema = path.join(skillRoot, "schemas", "caption-qc.v1.schema.json");
const defaultConnectors = [
  "但是", "所以", "因为", "比如", "比如说", "然后", "而且", "不过", "如果", "那么", "以及", "或者",
  "and", "but", "because", "so", "for example", "then", "however", "if",
];

function usage() {
  console.log(
    "用法：node scripts/production-captions.mjs build"
      + " --transcript <transcript.json> --input-srt <字幕.srt> --output-dir <目录>"
      + " [--minimum-duration <秒>] [--minimum-units <数量>]"
      + " [--warning-speed <units/s>] [--maximum-speed <units/s>]"
      + " [--minimum-time-coverage <0..1>] [--connector <文字>]"
      + " [--protected-token <文字>] [--json]\n"
      + "从已复核转写和真实字幕时间码生成唯一字幕时间线、SRT、VTT 与质检报告。"
  );
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function readNumber(value, label, {minimum = null, maximum = null} = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 必须是数字`);
  if (minimum !== null && parsed < minimum) throw new Error(`${label} 不能小于 ${minimum}`);
  if (maximum !== null && parsed > maximum) throw new Error(`${label} 不能大于 ${maximum}`);
  return parsed;
}

function parseTimecode(value) {
  const match = String(value).trim().match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/u);
  if (!match) throw new Error(`无法解析字幕时间：${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function formatTimecode(seconds, separator) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(milliseconds).padStart(3, "0")}`;
}

export function parseSrt(source) {
  const normalized = String(source).replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  if (!normalized) throw new Error("SRT 没有字幕 cue");
  return normalized.split(/\n{2,}/u).map((block, index) => {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) throw new Error(`SRT 第 ${index + 1} 块缺少时间范围`);
    const [startRaw, endRaw] = lines[timeIndex].split("-->").map((item) => item.trim().split(/\s+/u)[0]);
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    if (!text) throw new Error(`SRT 第 ${index + 1} 块缺少文字`);
    return {
      id: `caption-${String(index + 1).padStart(4, "0")}`,
      start_seconds: parseTimecode(startRaw),
      end_seconds: parseTimecode(endRaw),
      text,
    };
  });
}

function readingUnits(text) {
  const graphemes = Array.from(new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(text), (item) => item.segment);
  let units = 0;
  let latinOpen = false;
  for (const grapheme of graphemes) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(grapheme)) {
      units += 1;
      latinOpen = false;
    } else if (/^[\p{Letter}\p{Number}]$/u.test(grapheme)) {
      if (!latinOpen) units += 1;
      latinOpen = true;
    } else if (/^['_+.#/-]$/u.test(grapheme) && latinOpen) {
      // Continue the current ASCII-style token.
    } else {
      latinOpen = false;
    }
  }
  return units;
}

function normalizedConnectorText(value) {
  return String(value).toLocaleLowerCase().replace(/[\p{Punctuation}\p{Separator}\p{Symbol}]+/gu, "");
}

function mergeRanges(ranges) {
  const ordered = ranges
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const range of ordered) {
    const current = merged.at(-1);
    if (!current || range[0] > current[1]) merged.push([...range]);
    else current[1] = Math.max(current[1], range[1]);
  }
  return merged;
}

function rangeDuration(ranges) {
  return mergeRanges(ranges).reduce((total, [start, end]) => total + end - start, 0);
}

function timeCoverage(cues, segments) {
  const transcriptRanges = mergeRanges(segments.map((item) => [item.start_seconds, item.end_seconds]));
  const total = rangeDuration(transcriptRanges);
  if (total <= 0) return 0;
  const overlaps = [];
  for (const cue of cues) {
    for (const [start, end] of transcriptRanges) {
      const overlapStart = Math.max(start, cue.start_seconds);
      const overlapEnd = Math.min(end, cue.end_seconds);
      if (overlapEnd > overlapStart) overlaps.push([overlapStart, overlapEnd]);
    }
  }
  return Math.min(1, rangeDuration(overlaps) / total);
}

function sourceSegments(cue, segments) {
  return segments
    .filter((segment) => Math.min(cue.end_seconds, segment.end_seconds) > Math.max(cue.start_seconds, segment.start_seconds))
    .map((segment) => segment.id);
}

function extractProtectedTokens(transcript, explicit) {
  const discovered = transcript.segments.flatMap((segment) => segment.text.match(/[A-Za-z][A-Za-z0-9_.+/-]{2,}/gu) || []);
  return [...new Set([...discovered, ...explicit].map((item) => String(item).trim()).filter(Boolean))];
}

function splitProtectedToken(left, right, tokens) {
  const leftText = left.text.replace(/\s+$/u, "");
  const rightText = right.text.replace(/^\s+/u, "");
  const joined = `${leftText}${rightText}`.toLocaleLowerCase();
  for (const token of tokens) {
    const normalized = token.toLocaleLowerCase();
    if (!joined.includes(normalized)) continue;
    const boundary = leftText.length;
    const start = joined.indexOf(normalized);
    const end = start + normalized.length;
    if (start < boundary && end > boundary) return token;
  }
  return null;
}

function relativeContractPath(fromDir, target) {
  const relative = path.relative(fromDir, target).split(path.sep).join("/");
  return relative || path.basename(target);
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeSrt(cues) {
  return `${cues.map((cue, index) => [
    index + 1,
    `${formatTimecode(cue.start_seconds, ",")} --> ${formatTimecode(cue.end_seconds, ",")}`,
    cue.text,
  ].join("\n")).join("\n\n")}\n`;
}

function serializeVtt(cues) {
  return `WEBVTT\n\n${cues.map((cue) => [
    cue.id,
    `${formatTimecode(cue.start_seconds, ".")} --> ${formatTimecode(cue.end_seconds, ".")}`,
    cue.text,
  ].join("\n")).join("\n\n")}\n`;
}

function addIssue(issues, severity, code, cueIds, message) {
  issues.push({severity, code, cue_ids: cueIds, message});
}

export function buildProductionCaptions(options) {
  const transcriptPath = path.resolve(options.transcript);
  const inputSrtPath = path.resolve(options.inputSrt);
  const outputDir = path.resolve(options.outputDir);
  const thresholds = {
    minimum_duration_seconds: options.minimumDuration ?? 0.5,
    minimum_reading_units: options.minimumUnits ?? 2,
    warning_reading_units_per_second: options.warningSpeed ?? 9,
    maximum_reading_units_per_second: options.maximumSpeed ?? 12,
    minimum_time_coverage: options.minimumTimeCoverage ?? 0.9,
  };
  if (thresholds.maximum_reading_units_per_second < thresholds.warning_reading_units_per_second) {
    throw new Error("maximum-speed 不能小于 warning-speed");
  }
  const validation = validateMediaTranscript(transcriptPath, {ffprobe: options.ffprobe});
  if (!validation.ok) throw new Error(`转写合同未通过：\n- ${validation.errors.join("\n- ")}`);
  if (validation.review_status !== "passed") throw new Error("生产字幕要求 transcript.json 已通过实际听音复核");
  if (!fs.existsSync(inputSrtPath)) throw new Error(`输入 SRT 不存在：${inputSrtPath}`);
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  const rawCues = parseSrt(fs.readFileSync(inputSrtPath, "utf8"));
  const connectors = [...new Set([...defaultConnectors, ...(options.connectors || [])].map(normalizedConnectorText).filter(Boolean))];
  const protectedTokens = extractProtectedTokens(transcript, options.protectedTokens || []);
  const issues = [];
  let previous = null;
  const cues = rawCues.map((cue) => {
    const duration = cue.end_seconds - cue.start_seconds;
    const units = readingUnits(cue.text);
    const speed = units / Math.max(duration, 0.001);
    const segmentIds = sourceSegments(cue, transcript.segments);
    if (cue.end_seconds <= cue.start_seconds) addIssue(issues, "error", "invalid-duration", [cue.id], "字幕结束时间必须晚于开始时间。");
    if (previous && cue.start_seconds < previous.end_seconds - 0.001) addIssue(issues, "error", "overlap", [previous.id, cue.id], "字幕时间发生重叠或倒序。");
    if (cue.start_seconds < -0.001 || cue.end_seconds > validation.media_duration_seconds + 0.03) addIssue(issues, "error", "outside-source", [cue.id], "字幕超出最终声音的真实时间范围。");
    if (segmentIds.length === 0) addIssue(issues, "error", "outside-transcript", [cue.id], "字幕没有落在已复核转写的时间范围内。");
    if (duration < thresholds.minimum_duration_seconds) addIssue(issues, "error", "short-duration", [cue.id], `字幕时长 ${duration.toFixed(3)} 秒低于当前最小值 ${thresholds.minimum_duration_seconds} 秒。`);
    if (units < thresholds.minimum_reading_units) addIssue(issues, "warning", "isolated-fragment", [cue.id], `字幕只有 ${units} 个阅读单元，请确认它是刻意强调而不是断句碎片。`);
    if (speed > thresholds.maximum_reading_units_per_second) addIssue(issues, "error", "reading-speed", [cue.id], `阅读负担 ${speed.toFixed(2)} units/s 超过当前上限 ${thresholds.maximum_reading_units_per_second}。`);
    else if (speed > thresholds.warning_reading_units_per_second) addIssue(issues, "warning", "reading-speed", [cue.id], `阅读负担 ${speed.toFixed(2)} units/s 高于当前警告值 ${thresholds.warning_reading_units_per_second}。`);
    const normalized = normalizedConnectorText(cue.text);
    const endingConnector = connectors.find((connector) => normalized === connector || normalized.endsWith(connector));
    if (endingConnector) addIssue(issues, "error", "connector-split", [cue.id], `连接词“${endingConnector}”应与它引出的短语一起显示。`);
    if (previous) {
      const token = splitProtectedToken(previous, cue, protectedTokens);
      if (token) addIssue(issues, "error", "protected-token-split", [previous.id, cue.id], `受保护 token“${token}”被拆到两条字幕。`);
    }
    previous = cue;
    return {
      ...cue,
      source_segment_ids: segmentIds,
      reading_units: units,
      reading_units_per_second: Number(speed.toFixed(4)),
    };
  });
  const coverage = timeCoverage(cues, transcript.segments);
  if (coverage < thresholds.minimum_time_coverage) addIssue(issues, "error", "time-coverage", [], `字幕只覆盖 ${(coverage * 100).toFixed(2)}% 的已复核转写时间，低于当前最小值 ${(thresholds.minimum_time_coverage * 100).toFixed(2)}%。`);
  const captions = {
    protocol: "visual-multimedia-production-captions",
    version: 1,
    source: {
      transcript_sha256: sha256File(transcriptPath),
      source_id: transcript.source_id,
      source_sha256: transcript.source_sha256,
      review_status: "passed",
      timing_substrate: transcript.segments.some((segment) => segment.words.length > 0)
        ? "reviewed-word-boundaries"
        : "reviewed-segment-boundaries",
    },
    language: transcript.language,
    cues,
    exports: {srt: "captions.srt", vtt: "captions.vtt"},
    qc: "caption-qc.json",
  };
  assertJsonSchema(captions, captionSchema, "生产字幕时间线");
  const captionsBytes = serializeJson(captions);
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.filter((item) => item.severity === "warning").length;
  const qc = {
    protocol: "visual-multimedia-caption-qc",
    version: 1,
    captions: "captions.json",
    captions_sha256: sha256Buffer(captionsBytes),
    status: errors === 0 ? "passed" : "failed",
    thresholds,
    metrics: {
      cue_count: cues.length,
      duration_seconds: Number(rangeDuration(cues.map((cue) => [cue.start_seconds, cue.end_seconds])).toFixed(4)),
      time_coverage: Number(coverage.toFixed(6)),
      maximum_reading_units_per_second: Number(Math.max(0, ...cues.map((cue) => cue.reading_units_per_second)).toFixed(4)),
      warning_count: warnings,
      error_count: errors,
    },
    issues,
  };
  assertJsonSchema(qc, qcSchema, "生产字幕质检");
  fs.mkdirSync(outputDir, {recursive: true});
  fs.writeFileSync(path.join(outputDir, "captions.json"), captionsBytes, "utf8");
  fs.writeFileSync(path.join(outputDir, "captions.srt"), serializeSrt(cues), "utf8");
  fs.writeFileSync(path.join(outputDir, "captions.vtt"), serializeVtt(cues), "utf8");
  fs.writeFileSync(path.join(outputDir, "caption-qc.json"), serializeJson(qc), "utf8");
  return {
    ok: qc.status === "passed",
    output_dir: outputDir,
    transcript: relativeContractPath(outputDir, transcriptPath),
    input_srt: relativeContractPath(outputDir, inputSrtPath),
    captions,
    qc,
  };
}

function parseArgs(argv) {
  const options = {connectors: [], protectedTokens: []};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") options.json = true;
    else if (value === "--ffprobe") options.ffprobe = argv[++index];
    else if (value === "--transcript") options.transcript = argv[++index];
    else if (value === "--input-srt") options.inputSrt = argv[++index];
    else if (value === "--output-dir") options.outputDir = argv[++index];
    else if (value === "--minimum-duration") options.minimumDuration = readNumber(argv[++index], value, {minimum: 0});
    else if (value === "--minimum-units") options.minimumUnits = readNumber(argv[++index], value, {minimum: 1});
    else if (value === "--warning-speed") options.warningSpeed = readNumber(argv[++index], value, {minimum: 0});
    else if (value === "--maximum-speed") options.maximumSpeed = readNumber(argv[++index], value, {minimum: 0.001});
    else if (value === "--minimum-time-coverage") options.minimumTimeCoverage = readNumber(argv[++index], value, {minimum: 0, maximum: 1});
    else if (value === "--connector") options.connectors.push(argv[++index]);
    else if (value === "--protected-token") options.protectedTokens.push(argv[++index]);
    else throw new Error(`未知参数：${value}`);
  }
  for (const field of ["transcript", "inputSrt", "outputDir"]) {
    if (!options[field]) throw new Error(`缺少 --${field === "inputSrt" ? "input-srt" : field === "outputDir" ? "output-dir" : field}`);
  }
  return options;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const command = argv.shift();
  if (command !== "build") throw new Error(`未知操作：${command}`);
  const options = parseArgs(argv);
  const result = buildProductionCaptions(options);
  if (options.json) console.log(JSON.stringify({ok: result.ok, output_dir: result.output_dir, qc: result.qc}, null, 2));
  else console.log(`生产字幕${result.ok ? "通过" : "未通过"}：${result.captions.cues.length} 条，警告 ${result.qc.metrics.warning_count}，错误 ${result.qc.metrics.error_count}；${result.output_dir}`);
  return result.ok ? 0 : 1;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
