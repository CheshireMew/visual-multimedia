#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROTOCOL = "visual-multimedia-media-sources";
const VERSION = 3;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_TYPES = new Set([
  "photo",
  "screenshot",
  "video",
  "video-frame",
  "audio",
  "subtitle",
  "icon",
  "document",
  "generated",
]);
const ACQUISITION_METHODS = new Set([
  "user-provided",
  "project-owned",
  "external-download",
  "generated",
  "generated-in-project",
]);
const RIGHTS_STATUSES = new Set(["confirmed", "pending", "not-required"]);
const LEGACY_FIELDS = new Set([
  "type",
  "source_url",
  "license",
  "attribution",
  "crop",
]);
const ROOT_FIELDS = new Set(["protocol", "version", "sources"]);
const SOURCE_FIELDS = new Set([
  "id",
  "media_type",
  "file",
  "representation",
  "acquisition",
  "rights",
  "usage",
  "integrity",
  "generation",
  "speech",
  "provenance_runs",
  "subject",
  "crops",
  "notes",
]);
const ACQUISITION_FIELDS = new Set([
  "method",
  "source_url",
  "captured_at",
]);
const RIGHTS_FIELDS = new Set([
  "status",
  "license",
  "attribution",
  "terms_url",
]);
const INTEGRITY_FIELDS = new Set(["sha256", "bytes", "mime_type"]);
const GENERATION_FIELDS = new Set([
  "provider",
  "model",
  "prompt",
  "seed",
  "created_at",
]);
const SPEECH_FIELDS = new Set([
  "provider_voice_id",
  "voice_name",
  "language",
  "text_sha256",
  "exact_identity",
]);
const PROVENANCE_FIELDS = new Set([
  "recorded_at",
  "provider",
  "job_id",
  "capture",
]);
const CAPTURE_FIELDS = new Set(["file", "sha256"]);
const SUBJECT_FIELDS = new Set(["x", "y"]);
const REPRESENTATION_FIELDS = new Set([
  "kind",
  "source_id",
  "build",
  "verification",
]);

function usage() {
  console.log(
    "用法：node scripts/validate-media-sources.mjs <media-sources.json> [--json]\n"
      + "验证 v3 素材账本的结构、文件存在性和 SHA-256。"
  );
}

function fail(errors, location, message) {
  errors.push(`${location}：${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDateTime(value) {
  return typeof value === "string"
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

function rejectUnknown(errors, value, allowed, location) {
  if (!isObject(value)) return;
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(errors, `${location}.${field}`, "v3 合同不允许未知字段");
    }
  }
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

function validateRepresentation(errors, representation, location) {
  if (!isObject(representation)) {
    fail(errors, location, "必须是对象");
    return;
  }
  rejectUnknown(errors, representation, REPRESENTATION_FIELDS, location);
  if (!["source", "proxy"].includes(representation.kind)) {
    fail(errors, `${location}.kind`, "必须是 source 或 proxy");
  }
  if (representation.kind === "source") {
    for (const field of ["source_id", "build", "verification"]) {
      if (representation[field] !== null) {
        fail(errors, `${location}.${field}`, "source 表示必须为 null");
      }
    }
  } else if (
    typeof representation.source_id !== "string"
    || representation.source_id.length === 0
  ) {
    fail(errors, `${location}.source_id`, "proxy 必须引用原始 source id");
  }
}

function validateCapture(errors, capture, location, manifestDir) {
  if (capture === null) return;
  if (!isObject(capture)) {
    fail(errors, location, "必须是对象或 null");
    return;
  }
  rejectUnknown(errors, capture, CAPTURE_FIELDS, location);
  if (typeof capture.file !== "string" || capture.file.length === 0) {
    fail(errors, `${location}.file`, "必须是非空路径");
  }
  if (!SHA256_PATTERN.test(capture.sha256 || "")) {
    fail(errors, `${location}.sha256`, "必须是小写 64 位 SHA-256");
  }
  if (typeof capture.file === "string" && capture.file.length > 0) {
    const capturePath = path.resolve(manifestDir, capture.file);
    if (!fs.existsSync(capturePath) || !fs.statSync(capturePath).isFile()) {
      fail(errors, `${location}.file`, `文件不存在：${capturePath}`);
    } else if (
      SHA256_PATTERN.test(capture.sha256 || "")
      && sha256File(capturePath) !== capture.sha256
    ) {
      fail(errors, `${location}.sha256`, "与实际捕获文件不一致");
    }
  }
}

function validateSource(errors, source, index, manifestDir) {
  const location = `sources[${index}]`;
  if (!isObject(source)) {
    fail(errors, location, "必须是对象");
    return null;
  }
  rejectUnknown(errors, source, SOURCE_FIELDS, location);
  for (const field of LEGACY_FIELDS) {
    if (Object.hasOwn(source, field)) {
      fail(errors, `${location}.${field}`, "v3 不允许保留旧字段");
    }
  }
  if (!ID_PATTERN.test(source.id || "")) {
    fail(errors, `${location}.id`, "必须匹配 ^[a-z0-9][a-z0-9._-]*$");
  }
  if (!MEDIA_TYPES.has(source.media_type)) {
    fail(errors, `${location}.media_type`, "不是允许的媒体类型");
  }
  if (typeof source.file !== "string" || source.file.length === 0) {
    fail(errors, `${location}.file`, "必须是非空路径");
  }
  if (typeof source.usage !== "string" || source.usage.length === 0) {
    fail(errors, `${location}.usage`, "必须说明素材用途");
  }
  if (typeof source.notes !== "string") {
    fail(errors, `${location}.notes`, "必须是字符串");
  }
  validateRepresentation(
    errors,
    source.representation,
    `${location}.representation`
  );

  const acquisition = source.acquisition;
  if (!isObject(acquisition)) {
    fail(errors, `${location}.acquisition`, "必须是对象");
  } else {
    rejectUnknown(errors, acquisition, ACQUISITION_FIELDS, `${location}.acquisition`);
    if (!ACQUISITION_METHODS.has(acquisition.method)) {
      fail(errors, `${location}.acquisition.method`, "不是允许的取得方式");
    }
    for (const field of ["source_url"]) {
      if (typeof acquisition[field] !== "string") {
        fail(errors, `${location}.acquisition.${field}`, "必须是字符串");
      }
    }
    if (acquisition.captured_at !== null && !isDateTime(acquisition.captured_at)) {
      fail(errors, `${location}.acquisition.captured_at`, "必须是 ISO 日期时间或 null");
    }
  }

  const rights = source.rights;
  if (!isObject(rights)) {
    fail(errors, `${location}.rights`, "必须是对象");
  } else {
    rejectUnknown(errors, rights, RIGHTS_FIELDS, `${location}.rights`);
    if (!RIGHTS_STATUSES.has(rights.status)) {
      fail(errors, `${location}.rights.status`, "不是允许的权利状态");
    }
    for (const field of ["license", "attribution", "terms_url"]) {
      if (typeof rights[field] !== "string") {
        fail(errors, `${location}.rights.${field}`, "必须是字符串");
      }
    }
    if (rights.status === "confirmed" && rights.license.length === 0) {
      fail(errors, `${location}.rights.license`, "权利已确认时必须记录许可依据");
    }
  }

  const generatedInProject = acquisition?.method === "generated-in-project";
  let resolvedFile = null;
  if (typeof source.file === "string" && source.file.length > 0) {
    const filePart = source.file.split("#", 1)[0];
    resolvedFile = path.resolve(manifestDir, filePart);
    if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
      fail(errors, `${location}.file`, `文件不存在：${resolvedFile}`);
    }
  }

  if (source.integrity === null && !generatedInProject) {
    fail(errors, `${location}.integrity`, "独立素材必须记录完整性");
  } else if (source.integrity !== null && !isObject(source.integrity)) {
    fail(errors, `${location}.integrity`, "必须是对象或 null");
  } else if (isObject(source.integrity)) {
    const integrity = source.integrity;
    rejectUnknown(errors, integrity, INTEGRITY_FIELDS, `${location}.integrity`);
    if (!SHA256_PATTERN.test(integrity.sha256 || "")) {
      fail(errors, `${location}.integrity.sha256`, "必须是小写 64 位 SHA-256");
    }
    if (!Number.isInteger(integrity.bytes) || integrity.bytes < 1) {
      fail(errors, `${location}.integrity.bytes`, "必须是正整数");
    }
    if (typeof integrity.mime_type !== "string" || integrity.mime_type.length === 0) {
      fail(errors, `${location}.integrity.mime_type`, "必须是非空字符串");
    }
    if (resolvedFile && fs.existsSync(resolvedFile)) {
      const actualBytes = fs.statSync(resolvedFile).size;
      if (actualBytes !== integrity.bytes) {
        fail(
          errors,
          `${location}.integrity.bytes`,
          `记录为 ${integrity.bytes}，实际为 ${actualBytes}`
        );
      }
      if (
        SHA256_PATTERN.test(integrity.sha256 || "")
        && sha256File(resolvedFile) !== integrity.sha256
      ) {
        fail(errors, `${location}.integrity.sha256`, "与实际文件不一致");
      }
    }
  }

  if (source.generation !== null) {
    const generation = source.generation;
    if (!isObject(generation)) {
      fail(errors, `${location}.generation`, "必须是对象或 null");
    } else {
      rejectUnknown(errors, generation, GENERATION_FIELDS, `${location}.generation`);
      if (typeof generation.provider !== "string" || generation.provider.length === 0) {
        fail(errors, `${location}.generation.provider`, "必须记录生成入口");
      }
      for (const field of ["model", "prompt"]) {
        if (typeof generation[field] !== "string") {
          fail(errors, `${location}.generation.${field}`, "必须是字符串");
        }
      }
      if (!isDateTime(generation.created_at)) {
        fail(errors, `${location}.generation.created_at`, "必须是 ISO 日期时间");
      }
      if (
        generation.seed !== null
        && typeof generation.seed !== "string"
        && typeof generation.seed !== "number"
      ) {
        fail(
          errors,
          `${location}.generation.seed`,
          "必须是字符串、数字或 null"
        );
      }
    }
  } else if (["generated", "generated-in-project"].includes(acquisition?.method)) {
    fail(
      errors,
      `${location}.generation`,
      "生成素材必须记录 generation；不能只写生成类型而丢失过程"
    );
  }

  if (source.speech !== null) {
    const speech = source.speech;
    if (!isObject(speech)) {
      fail(errors, `${location}.speech`, "必须是对象或 null");
    } else {
      rejectUnknown(errors, speech, SPEECH_FIELDS, `${location}.speech`);
      for (const field of [
        "provider_voice_id",
        "voice_name",
        "language",
        "text_sha256",
      ]) {
        if (typeof speech[field] !== "string") {
          fail(errors, `${location}.speech.${field}`, "必须是字符串");
        }
      }
      if (!SHA256_PATTERN.test(speech.text_sha256 || "")) {
        fail(errors, `${location}.speech.text_sha256`, "必须是小写 64 位 SHA-256");
      }
      if (typeof speech.exact_identity !== "boolean") {
        fail(errors, `${location}.speech.exact_identity`, "必须是布尔值");
      }
      if (
        speech.exact_identity === true
        && (!speech.provider_voice_id || !speech.voice_name)
      ) {
        fail(
          errors,
          `${location}.speech`,
          "精确声音身份必须同时记录 provider_voice_id 与 voice_name"
        );
      }
    }
  }

  if (!Array.isArray(source.provenance_runs) || source.provenance_runs.length === 0) {
    fail(errors, `${location}.provenance_runs`, "至少需要一条取得记录");
  } else {
    source.provenance_runs.forEach((run, runIndex) => {
      const runLocation = `${location}.provenance_runs[${runIndex}]`;
      if (!isObject(run)) {
        fail(errors, runLocation, "必须是对象");
        return;
      }
      rejectUnknown(errors, run, PROVENANCE_FIELDS, runLocation);
      if (!isDateTime(run.recorded_at)) {
        fail(errors, `${runLocation}.recorded_at`, "必须是 ISO 日期时间");
      }
      for (const field of ["provider", "job_id"]) {
        if (typeof run[field] !== "string") {
          fail(errors, `${runLocation}.${field}`, "必须是字符串");
        }
      }
      validateCapture(errors, run.capture, `${runLocation}.capture`, manifestDir);
    });
  }

  if (source.subject !== null) {
    rejectUnknown(errors, source.subject, SUBJECT_FIELDS, `${location}.subject`);
    if (
      !isObject(source.subject)
      || !Number.isFinite(source.subject.x)
      || !Number.isFinite(source.subject.y)
      || source.subject.x < 0
      || source.subject.x > 1
      || source.subject.y < 0
      || source.subject.y > 1
    ) {
      fail(errors, `${location}.subject`, "必须是 0–1 范围的 x/y 坐标或 null");
    }
  }
  if (!isObject(source.crops)) {
    fail(errors, `${location}.crops`, "必须是对象");
  } else {
    for (const [variantId, crop] of Object.entries(source.crops)) {
      const cropLocation = `${location}.crops.${variantId}`;
      if (!isObject(crop)) {
        fail(errors, cropLocation, "必须是对象");
        continue;
      }
      rejectUnknown(
        errors,
        crop,
        new Set(["object_position", "rect"]),
        cropLocation
      );
      if (
        typeof crop.object_position !== "string"
        && !isObject(crop.rect)
      ) {
        fail(errors, cropLocation, "必须提供 object_position 或 rect");
      }
      if (isObject(crop.rect)) {
        rejectUnknown(
          errors,
          crop.rect,
          new Set(["x", "y", "width", "height"]),
          `${cropLocation}.rect`
        );
        const { x, y, width, height } = crop.rect;
        if (
          ![x, y, width, height].every(Number.isFinite)
          || x < 0
          || y < 0
          || width <= 0
          || height <= 0
          || x > 1
          || y > 1
          || width > 1
          || height > 1
          || x + width > 1.000001
          || y + height > 1.000001
        ) {
          fail(errors, `${cropLocation}.rect`, "必须是原素材内有效的 0–1 裁切矩形");
        }
      }
    }
  }

  return {
    id: source.id,
    file: source.file,
    resolved_file: resolvedFile,
    rights_status: rights?.status,
    sha256: source.integrity?.sha256 || null,
  };
}

export function validateMediaSources(manifestPath) {
  const absolutePath = path.resolve(manifestPath);
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      manifest: absolutePath,
      sources: [],
      errors: [`${absolutePath}：JSON 无法读取（${error.message}）`],
    };
  }
  if (!isObject(manifest)) {
    return {
      ok: false,
      manifest: absolutePath,
      sources: [],
      errors: [`${absolutePath}：根节点必须是对象`],
    };
  }
  rejectUnknown(errors, manifest, ROOT_FIELDS, "root");
  if (manifest.protocol !== PROTOCOL) {
    fail(errors, "protocol", `必须是 ${PROTOCOL}`);
  }
  if (manifest.version !== VERSION) {
    fail(errors, "version", `必须是 ${VERSION}；不接受旧版兼容字段`);
  }
  if (!Array.isArray(manifest.sources)) {
    fail(errors, "sources", "必须是数组");
  }
  const manifestDir = path.dirname(absolutePath);
  const sources = Array.isArray(manifest.sources)
    ? manifest.sources
      .map((source, index) => validateSource(errors, source, index, manifestDir))
      .filter(Boolean)
    : [];
  const ids = new Set();
  for (const source of sources) {
    if (ids.has(source.id)) fail(errors, `sources.${source.id}`, "id 重复");
    ids.add(source.id);
  }
  return {
    ok: errors.length === 0,
    manifest: absolutePath,
    source_count: sources.length,
    sources,
    errors,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    return args.length === 0 ? 1 : 0;
  }
  const jsonOutput = args.includes("--json");
  const manifestArg = args.find((arg) => !arg.startsWith("-"));
  if (!manifestArg) {
    usage();
    return 1;
  }
  const result = validateMediaSources(manifestArg);
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `素材账本通过：${result.manifest}（${result.source_count} 项，文件与哈希一致）`
    );
  } else {
    result.errors.forEach((message) => console.error(`FAIL ${message}`));
    console.error(`素材账本未通过：${result.errors.length} 个问题`);
  }
  return result.ok ? 0 : 1;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
