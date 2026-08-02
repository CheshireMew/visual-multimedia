#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { validateMediaSources } from "./validate-media-sources.mjs";
import { validateMediaTranscript } from "./validate-media-transcript.mjs";

const PROTOCOL = "visual-multimedia-clip-selections";
const VERSION = 2;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const LEGACY_QUANTITY_FIELDS = [
  "target_count",
  "minimum_clips",
  "selected_count",
  "pad",
  "padding",
];
const ROOT_FIELDS = new Set([
  "protocol",
  "version",
  "media_sources",
  "transcript",
  "maximum_clips",
  "clips",
]);
const CLIP_FIELDS = new Set([
  "id",
  "source_id",
  "start_seconds",
  "end_seconds",
  "purpose",
  "spoken_content",
  "transcript_segment_ids",
  "semantic_boundary_review",
  "intentional_repeat_reason",
]);
const REVIEW_FIELDS = new Set([
  "status",
  "listened",
  "waveform_checked",
  "notes",
]);

function usage() {
  console.log(
    "用法：node scripts/validate-clip-selections.mjs <clip-selections.json>"
      + " [--ffprobe <路径>] [--json]\n"
      + "检查真实源文件范围、已审核转写引用、完整语义审核、最大数量和重复片段。"
  );
}

function parseArgs(argv) {
  const positionals = [];
  let ffprobe = null;
  let jsonOutput = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      jsonOutput = true;
    } else if (token === "--ffprobe") {
      if (index + 1 >= argv.length) throw new Error("--ffprobe 缺少路径");
      ffprobe = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`);
    } else {
      positionals.push(token);
    }
  }
  if (positionals.length !== 1) throw new Error("必须提供一个 clip-selections.json");
  return { file: path.resolve(positionals[0]), ffprobe, jsonOutput };
}

function commandPath(override) {
  if (override) {
    const absolute = path.resolve(override);
    if (!fs.existsSync(absolute)) throw new Error(`ffprobe 不存在：${absolute}`);
    return absolute;
  }
  const probe = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["ffprobe"],
    { encoding: "utf8", windowsHide: true }
  );
  if (probe.status !== 0) {
    throw new Error(
      "找不到 ffprobe。请把已有工具加入 PATH，或使用 --ffprobe；脚本不会自动安装。"
    );
  }
  return probe.stdout.split(/\r?\n/).find(Boolean).trim();
}

function normalizeTranscript(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function transcriptHash(value) {
  return crypto.createHash("sha256").update(normalizeTranscript(value)).digest("hex");
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
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`FFprobe 无法读取 ${filePath}：${detail}`);
  }
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`FFprobe 没有返回有效时长：${filePath}`);
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

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const args = parseArgs(argv);
  const ffprobe = commandPath(args.ffprobe);
  let document;
  try {
    document = JSON.parse(fs.readFileSync(args.file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取片段选择文件：${error.message}`);
  }
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("片段选择文件根节点必须是对象");
  }
  rejectUnknown(errors, document, ROOT_FIELDS, "root");
  if (document.protocol !== PROTOCOL) {
    addError(errors, "protocol", `必须是 ${PROTOCOL}`);
  }
  if (document.version !== VERSION) {
    addError(errors, "version", `必须是 ${VERSION}`);
  }
  for (const field of LEGACY_QUANTITY_FIELDS) {
    if (Object.hasOwn(document, field)) {
      addError(
        errors,
        field,
        "数量只能使用 maximum_clips 表示上限，不能保留目标数、最低数或补齐逻辑"
      );
    }
  }
  if (!Number.isInteger(document.maximum_clips) || document.maximum_clips < 1) {
    addError(errors, "maximum_clips", "必须是大于 0 的整数");
  }
  if (!Array.isArray(document.clips)) {
    addError(errors, "clips", "必须是数组");
  } else if (
    Number.isInteger(document.maximum_clips)
    && document.clips.length > document.maximum_clips
  ) {
    addError(
      errors,
      "clips",
      `选择了 ${document.clips.length} 段，超过 maximum_clips=${document.maximum_clips}`
    );
  }

  const mediaSourcesPath = path.resolve(
    path.dirname(args.file),
    typeof document.media_sources === "string" ? document.media_sources : ""
  );
  const sourceValidation = validateMediaSources(mediaSourcesPath);
  if (!sourceValidation.ok) {
    sourceValidation.errors.forEach((message) =>
      addError(errors, "media_sources", message)
    );
  }
  const sourceRecords = new Map();
  if (sourceValidation.ok) {
    const manifest = JSON.parse(fs.readFileSync(mediaSourcesPath, "utf8"));
    for (const source of manifest.sources) sourceRecords.set(source.id, source);
  }
  let transcriptValidation = null;
  const transcriptById = new Map();
  if (document.transcript !== null) {
    if (typeof document.transcript !== "string" || document.transcript.length === 0) {
      addError(errors, "transcript", "必须是非空路径或 null");
    } else {
      const transcriptPath = path.resolve(path.dirname(args.file), document.transcript);
      transcriptValidation = validateMediaTranscript(transcriptPath, {
        ffprobe,
      });
      if (!transcriptValidation.ok) {
        transcriptValidation.errors.forEach((message) =>
          addError(errors, "transcript", message)
        );
      } else {
        for (const segment of transcriptValidation.segments) {
          transcriptById.set(segment.id, segment);
        }
      }
    }
  }

  const ids = new Set();
  const exactRanges = new Map();
  const transcriptOccurrences = new Map();
  const rangeOccurrences = [];
  const sourceDurations = new Map();
  const results = [];
  for (const [index, clip] of (document.clips || []).entries()) {
    const location = `clips[${index}]`;
    if (!clip || typeof clip !== "object" || Array.isArray(clip)) {
      addError(errors, location, "必须是对象");
      continue;
    }
    rejectUnknown(errors, clip, CLIP_FIELDS, location);
    if (!ID_PATTERN.test(clip.id || "")) {
      addError(errors, `${location}.id`, "格式不合法");
    } else if (ids.has(clip.id)) {
      addError(errors, `${location}.id`, "id 重复");
    } else {
      ids.add(clip.id);
    }
    const source = sourceRecords.get(clip.source_id);
    if (!source) {
      addError(errors, `${location}.source_id`, "素材账本中不存在该 source id");
      continue;
    }
    if (!["video", "audio"].includes(source.media_type)) {
      addError(
        errors,
        `${location}.source_id`,
        `片段只能来自 video 或 audio，当前为 ${source.media_type}`
      );
    }
    if (source.representation?.kind !== "source") {
      addError(
        errors,
        `${location}.source_id`,
        "片段选择必须绑定原始 source；时间线预览再通过表示解析器使用代理"
      );
    }
    const start = Number(clip.start_seconds);
    const end = Number(clip.end_seconds);
    if (!Number.isFinite(start) || start < 0) {
      addError(errors, `${location}.start_seconds`, "必须大于或等于 0");
    }
    if (!Number.isFinite(end) || end <= start) {
      addError(errors, `${location}.end_seconds`, "必须大于 start_seconds");
    }
    if (typeof clip.purpose !== "string" || clip.purpose.trim().length === 0) {
      addError(errors, `${location}.purpose`, "必须说明该片段承担的职责");
    }
    if (typeof clip.spoken_content !== "boolean") {
      addError(errors, `${location}.spoken_content`, "必须是布尔值");
    }
    if (Object.hasOwn(clip, "transcript")) {
      addError(
        errors,
        `${location}.transcript`,
        "v2 不再保存手写转录文本，必须引用 transcript_segment_ids"
      );
    }
    if (
      !Array.isArray(clip.transcript_segment_ids)
      || clip.transcript_segment_ids.some(
        (segmentId) => typeof segmentId !== "string" || segmentId.length === 0
      )
      || new Set(clip.transcript_segment_ids || []).size
        !== (clip.transcript_segment_ids || []).length
    ) {
      addError(
        errors,
        `${location}.transcript_segment_ids`,
        "必须是不重复的非空字符串数组"
      );
    }
    const review = clip.semantic_boundary_review;
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      addError(errors, `${location}.semantic_boundary_review`, "必须是对象");
    } else {
      rejectUnknown(
        errors,
        review,
        REVIEW_FIELDS,
        `${location}.semantic_boundary_review`
      );
      if (!["pending", "passed", "failed"].includes(review.status)) {
        addError(
          errors,
          `${location}.semantic_boundary_review.status`,
          "必须是 pending、passed 或 failed"
        );
      }
      if (typeof review.listened !== "boolean") {
        addError(
          errors,
          `${location}.semantic_boundary_review.listened`,
          "必须是布尔值"
        );
      }
      if (typeof review.waveform_checked !== "boolean") {
        addError(
          errors,
          `${location}.semantic_boundary_review.waveform_checked`,
          "必须是布尔值"
        );
      }
      if (typeof review.notes !== "string") {
        addError(
          errors,
          `${location}.semantic_boundary_review.notes`,
          "必须是字符串"
        );
      }
      if (
        review.status === "passed"
        && review.listened !== true
        && review.waveform_checked !== true
      ) {
        addError(
          errors,
          `${location}.semantic_boundary_review`,
          "标记 passed 前必须实际试听或检查波形"
        );
      }
      if (
        clip.spoken_content === true
        && (review.status !== "passed" || review.listened !== true)
      ) {
        addError(
          errors,
          `${location}.semantic_boundary_review`,
          "含人物表达的片段必须实际听过，并把完整语义边界标为 passed"
        );
      }
      if (
        clip.spoken_content === true
        && (
          !Array.isArray(clip.transcript_segment_ids)
          || clip.transcript_segment_ids.length === 0
        )
      ) {
        addError(
          errors,
          `${location}.transcript_segment_ids`,
          "含人物表达的片段必须引用已审核转写片段"
        );
      }
    }
    if (typeof clip.intentional_repeat_reason !== "string") {
      addError(errors, `${location}.intentional_repeat_reason`, "必须是字符串");
    }

    const sourceFile = path.resolve(path.dirname(mediaSourcesPath), source.file);
    if (!sourceDurations.has(source.id)) {
      try {
        sourceDurations.set(source.id, probeDuration(ffprobe, sourceFile));
      } catch (error) {
        addError(errors, `${location}.source_id`, error.message);
      }
    }
    const sourceDuration = sourceDurations.get(source.id);
    if (Number.isFinite(end) && sourceDuration && end > sourceDuration + 0.03) {
      addError(
        errors,
        `${location}.end_seconds`,
        `结束点 ${end}s 超过真实素材时长 ${sourceDuration}s`
      );
    }

    const rangeKey = `${source.integrity?.sha256 || source.id}:${start.toFixed(3)}:${end.toFixed(3)}`;
    if (exactRanges.has(rangeKey) && !clip.intentional_repeat_reason) {
      addError(
        errors,
        location,
        `与 ${exactRanges.get(rangeKey)} 使用相同文件和时间范围；不能用重复片段补数量`
      );
    } else {
      exactRanges.set(rangeKey, clip.id);
    }
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const currentDuration = end - start;
      for (const previous of rangeOccurrences) {
        if (previous.sourceHash !== (source.integrity?.sha256 || source.id)) continue;
        const overlap = Math.max(
          0,
          Math.min(end, previous.end) - Math.max(start, previous.start)
        );
        const overlapRatio = overlap / Math.min(currentDuration, previous.end - previous.start);
        if (overlapRatio >= 0.9 && !clip.intentional_repeat_reason) {
          addError(
            errors,
            location,
            `与 ${previous.id} 的同一源区间重叠 ${(overlapRatio * 100).toFixed(1)}%；`
              + "如确需重复必须说明 intentional_repeat_reason"
          );
          break;
        }
      }
      rangeOccurrences.push({
        id: clip.id,
        sourceHash: source.integrity?.sha256 || source.id,
        start,
        end,
      });
    }
    const referencedSegments = [];
    for (const segmentId of clip.transcript_segment_ids || []) {
      const segment = transcriptById.get(segmentId);
      if (!segment) {
        addError(
          errors,
          `${location}.transcript_segment_ids`,
          `转写合同中不存在 ${segmentId}`
        );
        continue;
      }
      referencedSegments.push(segment);
      if (
        Number.isFinite(start)
        && Number.isFinite(end)
        && (
          segment.start_seconds < start - 0.03
          || segment.end_seconds > end + 0.03
        )
      ) {
        addError(
          errors,
          `${location}.transcript_segment_ids`,
          `${segmentId} 的完整时间范围不在当前片段内`
        );
      }
      if (
        Array.isArray(segment.uncertain_terms)
        && segment.uncertain_terms.some((term) => term.status === "pending")
      ) {
        addError(
          errors,
          `${location}.transcript_segment_ids`,
          `${segmentId} 仍有待确认词`
        );
      }
    }
    if (
      clip.spoken_content === true
      && (
        !transcriptValidation
        || transcriptValidation.review_status !== "passed"
        || transcriptValidation.source_id !== source.id
      )
    ) {
      addError(
        errors,
        `${location}.transcript_segment_ids`,
        "人物表达必须引用同一原始素材且已经听音通过的转写合同"
      );
    }
    if (clip.spoken_content !== true && referencedSegments.length > 0) {
      addError(
        errors,
        `${location}.transcript_segment_ids`,
        "非人物表达片段不应绑定转写片段"
      );
    }
    const transcriptText = referencedSegments.map((segment) => segment.text).join(" ");
    const normalized = normalizeTranscript(transcriptText);
    const normalizedHash = normalized.length >= 8
      ? transcriptHash(transcriptText)
      : null;
    if (normalizedHash) {
      const previous = transcriptOccurrences.get(normalizedHash);
      if (previous && !clip.intentional_repeat_reason) {
        addError(
          errors,
          `${location}.transcript_segment_ids`,
          `与 ${previous} 的规范化文本相同；如确需重复必须说明 intentional_repeat_reason`
        );
      } else {
        transcriptOccurrences.set(normalizedHash, clip.id);
      }
    }
    results.push({
      id: clip.id,
      source_id: source.id,
      source_file: sourceFile,
      source_duration_seconds: sourceDuration || null,
      start_seconds: start,
      end_seconds: end,
      duration_seconds: Number.isFinite(start) && Number.isFinite(end)
        ? end - start
        : null,
      transcript_sha256: normalizedHash,
      transcript_segment_ids: clip.transcript_segment_ids || [],
    });
  }

  const report = {
    ok: errors.length === 0,
    file: args.file,
    maximum_clips: document.maximum_clips,
    selected_count: Array.isArray(document.clips) ? document.clips.length : null,
    transcript: transcriptValidation
      ? {
        file: transcriptValidation.file,
        source_id: transcriptValidation.source_id,
        review_status: transcriptValidation.review_status,
      }
      : null,
    clips: results,
    errors,
  };
  if (args.jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(
      `片段选择通过：${report.selected_count}/${report.maximum_clips} 段，`
        + "范围来自真实媒体且完整语义审核已记录"
    );
  } else {
    errors.forEach((message) => console.error(`FAIL ${message}`));
    console.error(`片段选择未通过：${errors.length} 个问题`);
  }
  return report.ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
