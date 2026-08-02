#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROTOCOL = "visual-multimedia-media-sources";
const VERSION = 3;
const EDITABLE_MEDIA_VERSION = 4;
export const EDITABLE_MEDIA_SOURCES_CONTRACT = "editable-media-v4";

export function mediaSourcesContractForVersion(version) {
  if (version === VERSION) return "media-sources-v3";
  if (version === EDITABLE_MEDIA_VERSION) {
    return EDITABLE_MEDIA_SOURCES_CONTRACT;
  }
  throw new Error(
    `素材账本 version 必须是 ${VERSION} 或 ${EDITABLE_MEDIA_VERSION}`
  );
}
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
const EDITABLE_MEDIA_SOURCE_FIELDS = new Set([
  ...SOURCE_FIELDS,
  "binding",
]);
const BROWSER_BINDING_FIELDS = new Set(["pipeline"]);
const NATIVE_AUDIO_BINDING_FIELDS = new Set([
  "pipeline",
  "loop",
  "source_in_ms",
  "gain_db",
]);
const NATIVE_UNDERLAY_BINDING_FIELDS = new Set([
  "pipeline",
  "fit",
  "playback",
  "source_in_ms",
  "audio",
  "gain_db",
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
const PROXY_BUILD_FIELDS = new Set(["tool", "command", "created_at"]);
const PROXY_VERIFICATION_FIELDS = new Set([
  "duration_tolerance_seconds",
  "frame_rate_tolerance",
  "aspect_ratio_tolerance",
  "require_rotation_match",
  "require_audio_stream_count_match",
]);

function usage() {
  console.log(
    "用法：node scripts/validate-media-sources.mjs <media-sources.json>"
      + " [--ffprobe <路径>] [--json]\n"
      + "验证 v3 素材账本的结构、文件、哈希，以及代理与原始素材的真实等价关系。"
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
      fail(errors, `${location}.${field}`, "当前合同不允许未知字段");
    }
  }
}

function validateEditableMediaBinding(errors, source, location) {
  const binding = source.binding;
  const bindingLocation = `${location}.binding`;
  if (!isObject(binding)) {
    fail(errors, bindingLocation, "media-sources v4 素材必须明确声明渲染管线");
    return null;
  }
  if (binding.pipeline === "browser") {
    rejectUnknown(errors, binding, BROWSER_BINDING_FIELDS, bindingLocation);
  } else if (binding.pipeline === "native-audio") {
    rejectUnknown(errors, binding, NATIVE_AUDIO_BINDING_FIELDS, bindingLocation);
    if (!["none", "repeat"].includes(binding.loop)) {
      fail(errors, `${bindingLocation}.loop`, "必须是 none 或 repeat");
    }
    if (!Number.isInteger(binding.source_in_ms) || binding.source_in_ms < 0) {
      fail(errors, `${bindingLocation}.source_in_ms`, "必须是非负整数");
    }
    if (!Number.isFinite(binding.gain_db)) {
      fail(errors, `${bindingLocation}.gain_db`, "必须是有限数字");
    }
  } else if (binding.pipeline === "native-underlay") {
    rejectUnknown(errors, binding, NATIVE_UNDERLAY_BINDING_FIELDS, bindingLocation);
    if (!["cover", "contain"].includes(binding.fit)) {
      fail(errors, `${bindingLocation}.fit`, "必须是 cover 或 contain");
    }
    if (!["hold", "repeat"].includes(binding.playback)) {
      fail(errors, `${bindingLocation}.playback`, "必须是 hold 或 repeat");
    }
    if (!Number.isInteger(binding.source_in_ms) || binding.source_in_ms < 0) {
      fail(errors, `${bindingLocation}.source_in_ms`, "必须是非负整数");
    }
    if (!["include", "exclude"].includes(binding.audio)) {
      fail(errors, `${bindingLocation}.audio`, "必须是 include 或 exclude");
    }
    if (!Number.isFinite(binding.gain_db)) {
      fail(errors, `${bindingLocation}.gain_db`, "必须是有限数字");
    }
  } else {
    fail(
      errors,
      `${bindingLocation}.pipeline`,
      "必须是 browser、native-underlay 或 native-audio"
    );
  }
  if (source.media_type === "audio" && binding.pipeline !== "native-audio") {
    fail(errors, bindingLocation, "audio 素材必须使用 native-audio");
  }
  if (binding.pipeline === "native-audio" && source.media_type !== "audio") {
    fail(errors, bindingLocation, "只有 audio 素材可以使用 native-audio");
  }
  if (binding.pipeline === "native-underlay" && source.media_type !== "video") {
    fail(errors, bindingLocation, "只有 video 素材可以使用 native-underlay");
  }
  return binding;
}

function commandPath(name, override = null) {
  if (override) {
    const absolute = path.resolve(override);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`${name} 不存在：${absolute}`);
    }
    return absolute;
  }
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [name],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(
      `找不到 ${name}；存在 proxy 表示时必须提供真实媒体验证工具，脚本不会自动安装。`
    );
  }
  return result.stdout.split(/\r?\n/).find(Boolean).trim();
}

function rate(value) {
  if (typeof value !== "string" || value.length === 0 || value === "0/0") {
    return null;
  }
  const [numerator, denominator = "1"] = value.split("/");
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function rotation(stream) {
  const tagRotation = Number(stream?.tags?.rotate);
  if (Number.isFinite(tagRotation)) return tagRotation;
  for (const item of stream?.side_data_list || []) {
    const value = Number(item?.rotation);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function probeMedia(ffprobe, filePath) {
  const result = spawnSync(
    ffprobe,
    [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`FFprobe 无法读取 ${filePath}：${detail}`);
  }
  const payload = JSON.parse(result.stdout);
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video") || null;
  const audioCount = streams.filter((stream) => stream.codec_type === "audio").length;
  const duration = Number(payload?.format?.duration ?? video?.duration);
  return {
    duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    frame_rate: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
    width: Number.isFinite(Number(video?.width)) ? Number(video.width) : null,
    height: Number.isFinite(Number(video?.height)) ? Number(video.height) : null,
    rotation_degrees: rotation(video),
    audio_stream_count: audioCount,
  };
}

function validateRepresentation(errors, source, location) {
  const representation = source.representation;
  if (!isObject(representation)) {
    fail(errors, `${location}.representation`, "必须是对象");
    return null;
  }
  rejectUnknown(
    errors,
    representation,
    REPRESENTATION_FIELDS,
    `${location}.representation`
  );
  if (!["source", "proxy"].includes(representation.kind)) {
    fail(errors, `${location}.representation.kind`, "必须是 source 或 proxy");
  }
  if (representation.kind === "source") {
    for (const field of ["source_id", "build", "verification"]) {
      if (representation[field] !== null) {
        fail(
          errors,
          `${location}.representation.${field}`,
          "source 表示必须为 null"
        );
      }
    }
  }
  if (representation.kind === "proxy") {
    if (
      typeof representation.source_id !== "string"
      || representation.source_id.length === 0
    ) {
      fail(
        errors,
        `${location}.representation.source_id`,
        "proxy 必须指向原始 source id"
      );
    }
    const build = representation.build;
    if (!isObject(build)) {
      fail(errors, `${location}.representation.build`, "proxy 必须记录构建过程");
    } else {
      rejectUnknown(
        errors,
        build,
        PROXY_BUILD_FIELDS,
        `${location}.representation.build`
      );
      if (typeof build.tool !== "string" || build.tool.length === 0) {
        fail(errors, `${location}.representation.build.tool`, "必须记录构建工具");
      }
      if (
        !Array.isArray(build.command)
        || build.command.length === 0
        || build.command.some((item) => typeof item !== "string")
      ) {
        fail(
          errors,
          `${location}.representation.build.command`,
          "必须记录非空参数数组"
        );
      }
      if (!isDateTime(build.created_at)) {
        fail(
          errors,
          `${location}.representation.build.created_at`,
          "必须是 ISO 日期时间"
        );
      }
    }
    const verification = representation.verification;
    if (!isObject(verification)) {
      fail(
        errors,
        `${location}.representation.verification`,
        "proxy 必须记录真实比较阈值"
      );
    } else {
      rejectUnknown(
        errors,
        verification,
        PROXY_VERIFICATION_FIELDS,
        `${location}.representation.verification`
      );
      for (const field of [
        "duration_tolerance_seconds",
        "frame_rate_tolerance",
        "aspect_ratio_tolerance",
      ]) {
        if (
          !Number.isFinite(verification[field])
          || verification[field] < 0
        ) {
          fail(
            errors,
            `${location}.representation.verification.${field}`,
            "必须是非负数"
          );
        }
      }
      for (const field of [
        "require_rotation_match",
        "require_audio_stream_count_match",
      ]) {
        if (typeof verification[field] !== "boolean") {
          fail(
            errors,
            `${location}.representation.verification.${field}`,
            "必须是布尔值"
          );
        }
      }
    }
  }
  return representation;
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

function validateSource(errors, source, index, manifestDir, contract) {
  const location = `sources[${index}]`;
  if (!isObject(source)) {
    fail(errors, location, "必须是对象");
    return null;
  }
  const editableMedia = contract === EDITABLE_MEDIA_SOURCES_CONTRACT;
  rejectUnknown(
    errors,
    source,
    editableMedia ? EDITABLE_MEDIA_SOURCE_FIELDS : SOURCE_FIELDS,
    location
  );
  for (const field of LEGACY_FIELDS) {
    if (Object.hasOwn(source, field)) {
      fail(errors, `${location}.${field}`, "当前合同不允许保留旧字段");
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
  const binding = editableMedia
    ? validateEditableMediaBinding(errors, source, location)
    : null;
  const representation = validateRepresentation(errors, source, location);

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

  const generatedInProject = (
    acquisition?.method === "generated-in-project"
    && source.integrity === null
  );
  let resolvedFile = null;
  if (typeof source.file === "string" && source.file.length > 0) {
    const filePart = source.file.split("#", 1)[0];
    resolvedFile = path.resolve(manifestDir, filePart);
    if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
      fail(errors, `${location}.file`, `文件不存在：${resolvedFile}`);
    }
  }

  if (generatedInProject) {
    if (source.integrity !== null) {
      fail(
        errors,
        `${location}.integrity`,
        "项目内动态生成内容没有独立文件时必须为 null"
      );
    }
  } else if (!isObject(source.integrity)) {
    fail(errors, `${location}.integrity`, "独立素材必须记录完整性");
  } else {
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
  } else if (
    ["generated", "generated-in-project"].includes(acquisition?.method)
    && representation?.kind !== "proxy"
  ) {
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
    media_type: source.media_type,
    file: source.file,
    resolved_file: resolvedFile,
    acquisition_method: acquisition?.method,
    rights_status: rights?.status,
    rights: rights
      ? {
        status: rights.status,
        license: rights.license,
        attribution: rights.attribution,
        terms_url: rights.terms_url,
      }
      : null,
    sha256: source.integrity?.sha256 || null,
    binding,
    representation,
  };
}

export function validateMediaSources(manifestPath, options = {}) {
  const absolutePath = path.resolve(manifestPath);
  const errors = [];
  const contract = options.contract || "media-sources-v3";
  if (
    contract !== "media-sources-v3"
    && contract !== EDITABLE_MEDIA_SOURCES_CONTRACT
  ) {
    throw new Error(`未知素材账本合同：${contract}`);
  }
  const expectedVersion = contract === EDITABLE_MEDIA_SOURCES_CONTRACT
    ? EDITABLE_MEDIA_VERSION
    : VERSION;
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
  if (manifest.version !== expectedVersion) {
    fail(errors, "version", `必须是 ${expectedVersion}；不接受旧版兼容字段`);
  }
  if (!Array.isArray(manifest.sources)) {
    fail(errors, "sources", "必须是数组");
  }
  const manifestDir = path.dirname(absolutePath);
  const sources = Array.isArray(manifest.sources)
    ? manifest.sources
      .map((source, index) =>
        validateSource(errors, source, index, manifestDir, contract)
      )
      .filter(Boolean)
    : [];
  const ids = new Set();
  const files = new Set();
  const byId = new Map();
  for (const source of sources) {
    if (ids.has(source.id)) fail(errors, `sources.${source.id}`, "id 重复");
    ids.add(source.id);
    byId.set(source.id, source);
    if (
      contract === EDITABLE_MEDIA_SOURCES_CONTRACT
      && files.has(source.file)
    ) {
      fail(errors, `sources.${source.id}.file`, "media-sources v4 素材文件重复");
    }
    files.add(source.file);
  }
  const proxyEvidence = [];
  const proxies = sources.filter(
    (source) => source.representation?.kind === "proxy"
  );
  let ffprobe = null;
  if (proxies.length > 0) {
    try {
      ffprobe = commandPath("ffprobe", options.ffprobe || null);
    } catch (error) {
      fail(errors, "proxy", error.message);
    }
  }
  for (const proxy of proxies) {
    const location = `sources.${proxy.id}.representation`;
    const original = byId.get(proxy.representation.source_id);
    if (!original) {
      fail(errors, `${location}.source_id`, "指向的原始 source id 不存在");
      continue;
    }
    if (original.representation?.kind !== "source") {
      fail(errors, `${location}.source_id`, "proxy 只能直接指向 source，不能形成代理链");
    }
    if (original.media_type !== proxy.media_type) {
      fail(errors, `${location}.source_id`, "proxy 与原始素材的 media_type 必须一致");
    }
    if (!["video", "audio"].includes(proxy.media_type)) {
      fail(errors, location, "只有 video 或 audio 可以声明为 proxy");
    }
    if (proxy.acquisition_method !== "generated-in-project") {
      fail(
        errors,
        `sources.${proxy.id}.acquisition.method`,
        "proxy 必须记录为 generated-in-project"
      );
    }
    if (
      JSON.stringify(proxy.rights) !== JSON.stringify(original.rights)
    ) {
      fail(
        errors,
        `sources.${proxy.id}.rights`,
        "proxy 必须完整继承原始 source 的权利记录"
      );
    }
    if (
      contract === EDITABLE_MEDIA_SOURCES_CONTRACT
      && JSON.stringify(proxy.binding) !== JSON.stringify(original.binding)
    ) {
      fail(
        errors,
        `${location}.binding`,
        "media-sources v4 proxy 必须继承原始 source 的渲染管线"
      );
    }
    if (
      !ffprobe
      || !original.resolved_file
      || !proxy.resolved_file
      || !fs.existsSync(original.resolved_file)
      || !fs.existsSync(proxy.resolved_file)
    ) {
      continue;
    }
    try {
      const sourceProbe = probeMedia(ffprobe, original.resolved_file);
      const proxyProbe = probeMedia(ffprobe, proxy.resolved_file);
      const verification = proxy.representation.verification;
      const durationDelta = (
        sourceProbe.duration_seconds !== null
        && proxyProbe.duration_seconds !== null
      )
        ? Math.abs(sourceProbe.duration_seconds - proxyProbe.duration_seconds)
        : null;
      const frameRateDelta = (
        sourceProbe.frame_rate !== null
        && proxyProbe.frame_rate !== null
      )
        ? Math.abs(sourceProbe.frame_rate - proxyProbe.frame_rate)
        : null;
      const sourceAspect = (
        sourceProbe.width !== null
        && sourceProbe.height !== null
        && sourceProbe.height > 0
      )
        ? sourceProbe.width / sourceProbe.height
        : null;
      const proxyAspect = (
        proxyProbe.width !== null
        && proxyProbe.height !== null
        && proxyProbe.height > 0
      )
        ? proxyProbe.width / proxyProbe.height
        : null;
      const aspectRatioDelta = (
        sourceAspect !== null && proxyAspect !== null
      )
        ? Math.abs(sourceAspect - proxyAspect)
        : null;
      const checks = {
        duration: durationDelta !== null
          && durationDelta <= verification.duration_tolerance_seconds,
        frame_rate: proxy.media_type !== "video"
          || (
            frameRateDelta !== null
            && frameRateDelta <= verification.frame_rate_tolerance
          ),
        aspect_ratio: proxy.media_type !== "video"
          || (
            aspectRatioDelta !== null
            && aspectRatioDelta <= verification.aspect_ratio_tolerance
          ),
        rotation: verification.require_rotation_match !== true
          || sourceProbe.rotation_degrees === proxyProbe.rotation_degrees,
        audio_stream_count:
          verification.require_audio_stream_count_match !== true
          || sourceProbe.audio_stream_count === proxyProbe.audio_stream_count,
      };
      for (const [name, passed] of Object.entries(checks)) {
        if (!passed) {
          fail(errors, `${location}.verification.${name}`, "真实媒体比较未通过");
        }
      }
      proxyEvidence.push({
        proxy_id: proxy.id,
        source_id: original.id,
        source: sourceProbe,
        proxy: proxyProbe,
        differences: {
          duration_seconds: durationDelta,
          frame_rate: frameRateDelta,
          aspect_ratio: aspectRatioDelta,
        },
        checks,
        passed: Object.values(checks).every(Boolean),
      });
    } catch (error) {
      fail(errors, `${location}.verification`, error.message);
    }
  }
  return {
    ok: errors.length === 0,
    manifest: absolutePath,
    source_count: sources.length,
    sources,
    proxies: proxyEvidence,
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
  const ffprobeIndex = args.indexOf("--ffprobe");
  const ffprobe = ffprobeIndex >= 0 ? args[ffprobeIndex + 1] : null;
  if (ffprobeIndex >= 0 && !ffprobe) {
    throw new Error("--ffprobe 缺少路径");
  }
  const manifestArg = args.find(
    (arg, index) => !arg.startsWith("-")
      && (ffprobeIndex < 0 || index !== ffprobeIndex + 1)
  );
  if (!manifestArg) {
    usage();
    return 1;
  }
  const result = validateMediaSources(manifestArg, { ffprobe });
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `素材账本通过：${result.manifest}（${result.source_count} 项，`
        + `${result.proxies.length} 个代理已与原始素材真实核对）`
    );
  } else {
    result.errors.forEach((message) => console.error(`FAIL ${message}`));
    console.error(`素材账本未通过：${result.errors.length} 个问题`);
  }
  return result.ok ? 0 : 1;
}

if (
  process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  process.exitCode = main();
}
