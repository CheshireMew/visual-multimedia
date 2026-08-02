#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateMediaSources } from "./validate-media-sources.mjs";

const PROTOCOL = "visual-multimedia-media-transcript";
const VERSION = 1;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROOT_FIELDS = new Set([
  "protocol",
  "version",
  "media_sources",
  "source_id",
  "source_sha256",
  "language",
  "input",
  "review",
  "segments",
]);
const INPUT_FIELDS = new Set(["kind", "file", "sha256"]);
const REVIEW_FIELDS = new Set(["status", "listened", "reviewed_at", "notes"]);
const SEGMENT_FIELDS = new Set([
  "id",
  "start_seconds",
  "end_seconds",
  "text",
  "words",
  "uncertain_terms",
]);
const WORD_FIELDS = new Set(["text", "start_seconds", "end_seconds"]);
const UNCERTAIN_TERM_FIELDS = new Set([
  "text",
  "status",
  "resolution",
  "notes",
]);

function usage() {
  console.log(
    "用法：node scripts/validate-media-transcript.mjs <transcript.json>"
      + " [--ffprobe <路径>] [--json]\n"
      + "验证转写与真实音视频、输入字幕、时间范围、待确认词和人工听音状态。"
  );
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(file);
  }
  return hash.digest("hex");
}

function commandPath(override) {
  if (override) {
    const absolute = path.resolve(override);
    if (!fs.existsSync(absolute)) throw new Error(`ffprobe 不存在：${absolute}`);
    return absolute;
  }
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["ffprobe"],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error("找不到 ffprobe；转写必须核对真实媒体时长，脚本不会自动安装。");
  }
  return result.stdout.split(/\r?\n/).find(Boolean).trim();
}

function probeDuration(ffprobe, filePath) {
  const result = spawnSync(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "FFprobe 失败").trim());
  }
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("FFprobe 没有返回有效时长");
  }
  return duration;
}

function addError(errors, location, message) {
  errors.push(`${location}：${message}`);
}

function rejectUnknown(errors, value, allowed, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      addError(errors, `${location}.${key}`, "不是当前合同字段；不接受旧版兼容字段");
    }
  }
}

export function validateMediaTranscript(transcriptPath, options = {}) {
  const absolutePath = path.resolve(transcriptPath);
  const errors = [];
  let document;
  try {
    document = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      file: absolutePath,
      segments: [],
      errors: [`${absolutePath}：无法读取 JSON（${error.message}）`],
    };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return {
      ok: false,
      file: absolutePath,
      segments: [],
      errors: [`${absolutePath}：根节点必须是对象`],
    };
  }
  rejectUnknown(errors, document, ROOT_FIELDS, "root");
  if (document.protocol !== PROTOCOL) addError(errors, "protocol", `必须是 ${PROTOCOL}`);
  if (document.version !== VERSION) addError(errors, "version", `必须是 ${VERSION}`);
  const projectRoot = path.dirname(absolutePath);
  const mediaSourcesPath = path.resolve(
    projectRoot,
    typeof document.media_sources === "string" ? document.media_sources : ""
  );
  const sourceValidation = validateMediaSources(mediaSourcesPath, {
    ffprobe: options.ffprobe,
  });
  if (!sourceValidation.ok) {
    sourceValidation.errors.forEach((message) =>
      addError(errors, "media_sources", message)
    );
  }
  let source = null;
  if (sourceValidation.ok) {
    const manifest = JSON.parse(fs.readFileSync(mediaSourcesPath, "utf8"));
    source = manifest.sources.find((item) => item.id === document.source_id) || null;
    if (!source) {
      addError(errors, "source_id", "素材账本中不存在该 source id");
    } else {
      if (!["video", "audio"].includes(source.media_type)) {
        addError(errors, "source_id", "转写只能绑定 video 或 audio");
      }
      if (source.representation?.kind !== "source") {
        addError(errors, "source_id", "转写必须绑定原始 source，不能绑定代理");
      }
      if (document.source_sha256 !== source.integrity?.sha256) {
        addError(errors, "source_sha256", "与素材账本中的真实原片哈希不一致");
      }
    }
  }
  if (typeof document.language !== "string" || document.language.length === 0) {
    addError(errors, "language", "必须是非空字符串");
  }
  const input = document.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    addError(errors, "input", "必须是对象");
  } else {
    rejectUnknown(errors, input, INPUT_FIELDS, "input");
    if (!["user-subtitles", "asr"].includes(input.kind)) {
      addError(errors, "input.kind", "不是允许的输入类型");
    }
    if (typeof input.file !== "string" || input.file.length === 0) {
      addError(errors, "input.file", "必须是非空路径");
    } else {
      const inputPath = path.resolve(projectRoot, input.file);
      if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        addError(errors, "input.file", `文件不存在：${inputPath}`);
      } else if (
        !SHA256_PATTERN.test(input.sha256 || "")
        || sha256File(inputPath) !== input.sha256
      ) {
        addError(errors, "input.sha256", "与实际输入文件不一致");
      }
    }
  }
  const review = document.review;
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    addError(errors, "review", "必须是对象");
  } else {
    rejectUnknown(errors, review, REVIEW_FIELDS, "review");
    if (!["pending", "passed", "failed"].includes(review.status)) {
      addError(errors, "review.status", "必须是 pending、passed 或 failed");
    }
    if (typeof review.listened !== "boolean") {
      addError(errors, "review.listened", "必须是布尔值");
    }
    if (review.reviewed_at !== null && !Number.isFinite(Date.parse(review.reviewed_at))) {
      addError(errors, "review.reviewed_at", "必须是 ISO 日期时间或 null");
    }
    if (typeof review.notes !== "string") {
      addError(errors, "review.notes", "必须是字符串");
    }
    if (
      review.status === "passed"
      && (review.listened !== true || review.reviewed_at === null)
    ) {
      addError(errors, "review", "标记 passed 前必须实际听音并记录审核时间");
    }
  }
  if (!Array.isArray(document.segments)) {
    addError(errors, "segments", "必须是数组");
  }
  const ids = new Set();
  const segments = [];
  let previousEnd = 0;
  let pendingTerms = 0;
  for (const [index, segment] of (document.segments || []).entries()) {
    const location = `segments[${index}]`;
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      addError(errors, location, "必须是对象");
      continue;
    }
    rejectUnknown(errors, segment, SEGMENT_FIELDS, location);
    if (!ID_PATTERN.test(segment.id || "")) {
      addError(errors, `${location}.id`, "格式不合法");
    } else if (ids.has(segment.id)) {
      addError(errors, `${location}.id`, "id 重复");
    } else {
      ids.add(segment.id);
    }
    const start = Number(segment.start_seconds);
    const end = Number(segment.end_seconds);
    if (!Number.isFinite(start) || start < 0) {
      addError(errors, `${location}.start_seconds`, "必须大于或等于 0");
    }
    if (!Number.isFinite(end) || end <= start) {
      addError(errors, `${location}.end_seconds`, "必须大于 start_seconds");
    }
    if (Number.isFinite(start) && start < previousEnd - 0.001) {
      addError(errors, location, "转写片段不能重叠或倒序");
    }
    if (Number.isFinite(end)) previousEnd = end;
    if (typeof segment.text !== "string" || segment.text.trim().length === 0) {
      addError(errors, `${location}.text`, "必须是非空文本");
    }
    if (!Array.isArray(segment.words)) {
      addError(errors, `${location}.words`, "必须是数组");
    } else {
      for (const [wordIndex, word] of segment.words.entries()) {
        const wordLocation = `${location}.words[${wordIndex}]`;
        rejectUnknown(errors, word, WORD_FIELDS, wordLocation);
        if (
          !word
          || typeof word.text !== "string"
          || word.text.length === 0
          || !Number.isFinite(word.start_seconds)
          || !Number.isFinite(word.end_seconds)
          || word.start_seconds < start - 0.001
          || word.end_seconds > end + 0.001
          || word.end_seconds <= word.start_seconds
        ) {
          addError(errors, wordLocation, "文字和时间必须位于所属片段内");
        }
      }
    }
    if (!Array.isArray(segment.uncertain_terms)) {
      addError(errors, `${location}.uncertain_terms`, "必须是数组");
    } else {
      for (const [termIndex, term] of segment.uncertain_terms.entries()) {
        const termLocation = `${location}.uncertain_terms[${termIndex}]`;
        rejectUnknown(errors, term, UNCERTAIN_TERM_FIELDS, termLocation);
        if (!term || typeof term.text !== "string" || term.text.length === 0) {
          addError(errors, `${termLocation}.text`, "必须记录待确认原词");
        }
        if (!["pending", "resolved"].includes(term?.status)) {
          addError(errors, `${termLocation}.status`, "必须是 pending 或 resolved");
        }
        if (term?.status === "pending") pendingTerms += 1;
        if (
          term?.status === "resolved"
          && (typeof term.resolution !== "string" || term.resolution.length === 0)
        ) {
          addError(errors, `${termLocation}.resolution`, "resolved 必须记录确认结果");
        }
        if (typeof term?.notes !== "string") {
          addError(errors, `${termLocation}.notes`, "必须是字符串");
        }
      }
    }
    segments.push({
      id: segment.id,
      start_seconds: start,
      end_seconds: end,
      text: segment.text,
      uncertain_terms: segment.uncertain_terms || [],
    });
  }
  let mediaDuration = null;
  if (source) {
    try {
      const ffprobe = commandPath(options.ffprobe || null);
      mediaDuration = probeDuration(
        ffprobe,
        path.resolve(path.dirname(mediaSourcesPath), source.file)
      );
      if (segments.some((segment) => segment.end_seconds > mediaDuration + 0.03)) {
        addError(errors, "segments", `存在超过真实素材时长 ${mediaDuration}s 的片段`);
      }
    } catch (error) {
      addError(errors, "source_id", error.message);
    }
  }
  if (review?.status === "passed" && pendingTerms > 0) {
    addError(errors, "review.status", "仍有 pending 待确认词时不能标记 passed");
  }
  return {
    ok: errors.length === 0,
    file: absolutePath,
    source_id: document.source_id,
    source_sha256: document.source_sha256,
    media_duration_seconds: mediaDuration,
    review_status: review?.status || null,
    pending_terms: pendingTerms,
    segments,
    errors,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const ffprobeIndex = argv.indexOf("--ffprobe");
  const ffprobe = ffprobeIndex >= 0 ? argv[ffprobeIndex + 1] : null;
  const file = argv.find(
    (value, index) => !value.startsWith("--")
      && (ffprobeIndex < 0 || index !== ffprobeIndex + 1)
  );
  if (!file) throw new Error("必须提供 transcript.json");
  const result = validateMediaTranscript(file, { ffprobe });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `转写合同通过：${result.segments.length} 段，审核=${result.review_status}，`
        + `待确认词=${result.pending_terms}`
    );
  } else {
    result.errors.forEach((message) => console.error(`FAIL ${message}`));
  }
  return result.ok ? 0 : 1;
}

if (
  path.resolve(fileURLToPath(import.meta.url))
  === path.resolve(process.argv[1] || "")
) {
  process.exitCode = main();
}
