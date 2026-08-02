#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { validateGenerationJobs } from "./validate-generation-jobs.mjs";
import {
  EDITABLE_MEDIA_SOURCES_CONTRACT,
  mediaSourcesContractForVersion,
  validateMediaSources,
} from "./validate-media-sources.mjs";

const PROTOCOL = "visual-multimedia-media-sources";
const VERSION = 3;
const EDITABLE_MEDIA_VERSION = 4;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
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
const METHODS = new Set([
  "user-provided",
  "project-owned",
  "external-download",
  "generated",
  "generated-in-project",
]);
const RIGHTS = new Set(["confirmed", "pending", "not-required"]);

function usage() {
  console.log(`用法：
node scripts/import-media-asset.mjs --project <项目目录> --input <文件> --id <素材 id>
  --media-type <类型> --method <取得方式> --rights-status <状态>
  --license <许可依据> --usage <实际用途> [其它元数据]

必需参数：
  --project          包含 media-sources.json 的项目目录
  --input            要导入的本地文件
  --id               稳定素材 id，只允许小写字母、数字、点、下划线和连字符
  --media-type       photo|screenshot|video|video-frame|audio|subtitle|icon|document|generated
  --method           user-provided|project-owned|external-download|generated|generated-in-project
  --rights-status    confirmed|pending|not-required
  --license          许可或权利依据；confirmed 时不能为空
  --usage            素材在当前项目中的职责

可选参数：
  --source-url --provider --attribution --terms-url --captured-at --notes
  --generation-model --generation-prompt --generation-seed --job-id --created-at
  --capture <任务回执或生成记录文件>
  --voice-id --voice-name --language --speech-text <实际合成输入文本文件>
  --exact-voice
  --subject-x --subject-y --crops-json <JSON 文件>
  --proxy-of <原始 source id> --proxy-tool <工具>
  --proxy-command-arg <参数>  可重复；按真实调用顺序记录
  --duration-tolerance <秒> --frame-rate-tolerance <fps>
  --aspect-ratio-tolerance <比例差>
  --allow-rotation-change --allow-audio-stream-count-change
  --pipeline <browser|native-underlay|native-audio>
  --fit <cover|contain> --playback <hold|repeat>
  --audio <include|exclude> --loop <none|repeat>
  --source-in-ms <毫秒> --gain-db <分贝>
  --move-input  仅供当前任务生成的代理临时文件使用；移动进内容仓库，不保留副本
  --manifest <路径>  默认 <project>/media-sources.json

method=generated 只能由已经通过费用与远程任务合同的 job 本地化，必须提供 --provider、
--job-id 和 --capture；脚本会读取项目唯一的 generation-jobs.json 验证同一成功任务。

普通媒体工程继续使用 media-sources v3，不能传 --pipeline。网页 media-sources v4 素材账本
必须传 --pipeline；browser 由网页绘制，native-underlay 只接受 video，native-audio
只接受 audio。代理自动继承原始 source 的同一管线，不能改绑。

脚本把文件复制到 assets/by-sha256/<前两位>/<sha256><扩展名>，不覆盖同 id 的其它内容，
并且只更新素材账本，不会自动把素材绑定到网页场景、视频时间线或音频项目。`);
}

function parseArgs(argv) {
  const values = new Map();
  const booleans = new Set([
    "exact-voice",
    "allow-rotation-change",
    "allow-audio-stream-count-change",
    "move-input",
  ]);
  const repeated = new Set(["proxy-command-arg"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    if (booleans.has(key)) {
      values.set(key, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    if (repeated.has(key)) {
      const current = values.get(key) || [];
      current.push(argv[index + 1]);
      values.set(key, current);
    } else {
      values.set(key, argv[index + 1]);
    }
    index += 1;
  }
  return values;
}

function nonNegativeNumber(args, key, fallback) {
  if (!args.has(key)) return fallback;
  const value = Number(args.get(key));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${key} 必须是非负数`);
  }
  return value;
}

function finiteNumber(args, key, fallback) {
  if (!args.has(key)) return fallback;
  const value = Number(args.get(key));
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} 必须是有限数字`);
  }
  return value;
}

function buildRepresentation(args, manifest, mediaType, recordedAt) {
  const sourceId = args.get("proxy-of");
  if (!sourceId) {
    return {
      kind: "source",
      source_id: null,
      build: null,
      verification: null,
    };
  }
  if (!["video", "audio"].includes(mediaType)) {
    throw new Error("--proxy-of 只适用于 video 或 audio");
  }
  const original = manifest.sources.find((source) => source.id === sourceId);
  if (!original) {
    throw new Error(`--proxy-of 指向不存在的 source id：${sourceId}`);
  }
  if (original.representation?.kind !== "source") {
    throw new Error("--proxy-of 必须直接指向 source，不能指向另一份代理");
  }
  if (original.media_type !== mediaType) {
    throw new Error("--proxy-of 指向的素材类型与当前 --media-type 不一致");
  }
  const tool = required(args, "proxy-tool");
  const command = args.get("proxy-command-arg");
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("代理素材必须至少提供一个 --proxy-command-arg");
  }
  return {
    kind: "proxy",
    source_id: sourceId,
    build: {
      tool,
      command,
      created_at: recordedAt,
    },
    verification: {
      duration_tolerance_seconds: nonNegativeNumber(
        args,
        "duration-tolerance",
        0.05
      ),
      frame_rate_tolerance: nonNegativeNumber(
        args,
        "frame-rate-tolerance",
        0.02
      ),
      aspect_ratio_tolerance: nonNegativeNumber(
        args,
        "aspect-ratio-tolerance",
        0.002
      ),
      require_rotation_match: !args.has("allow-rotation-change"),
      require_audio_stream_count_match:
        !args.has("allow-audio-stream-count-change"),
    },
  };
}

function required(args, key) {
  const value = args.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少必需参数 --${key}`);
  }
  return value;
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

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mapping = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".srt": "application/x-subrip",
    ".vtt": "text/vtt",
    ".ass": "text/x-ssa",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
  };
  return mapping[extension] || "application/octet-stream";
}

function toProjectRelative(projectRoot, absolutePath) {
  const relative = path.relative(projectRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`项目记录必须位于项目目录内：${absolutePath}`);
  }
  return relative.split(path.sep).join("/");
}

function contentAddressedCopy(projectRoot, inputPath, folder, moveInput = false) {
  const sha256 = sha256File(inputPath);
  const extension = path.extname(inputPath).toLowerCase();
  const destination = path.join(
    projectRoot,
    folder,
    sha256.slice(0, 2),
    `${sha256}${extension}`
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isFile() || sha256File(destination) !== sha256) {
      throw new Error(`内容寻址目标已存在但内容不一致：${destination}`);
    }
  } else if (moveInput) {
    fs.renameSync(inputPath, destination);
  } else {
    fs.copyFileSync(inputPath, destination, fs.constants.COPYFILE_EXCL);
  }
  return {
    absolutePath: destination,
    file: toProjectRelative(projectRoot, destination),
    sha256,
    bytes: fs.statSync(destination).size,
    mime_type: mimeType(destination),
  };
}

function readManifest(manifestPath, args) {
  if (!fs.existsSync(manifestPath)) {
    return {
      protocol: PROTOCOL,
      version: args.has("pipeline") ? EDITABLE_MEDIA_VERSION : VERSION,
      sources: [],
    };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const contract = mediaSourcesContractForVersion(manifest.version);
  if (contract === "media-sources-v3" && args.has("pipeline")) {
    throw new Error("普通 media-sources v3 素材账本不能声明 editable-media 管线");
  }
  const result = validateMediaSources(manifestPath, { contract });
  if (!result.ok) {
    throw new Error(
      `现有素材账本无效，导入已停止：\n${result.errors.map((item) => `- ${item}`).join("\n")}`
    );
  }
  return manifest;
}

function editableMediaBindingArgs(args) {
  return [
    "pipeline",
    "fit",
    "playback",
    "audio",
    "loop",
    "source-in-ms",
    "gain-db",
  ].filter((key) => args.has(key));
}

function buildEditableMediaBinding(args, manifest, mediaType, representation) {
  const bindingArgs = editableMediaBindingArgs(args);
  if (manifest.version === VERSION) {
    if (bindingArgs.length > 0) {
      throw new Error("普通 media-sources v3 素材账本不能声明 editable-media 管线");
    }
    return null;
  }
  if (manifest.version !== EDITABLE_MEDIA_VERSION) {
    throw new Error(`editable-media 素材账本必须使用 version ${EDITABLE_MEDIA_VERSION}`);
  }
  if (representation.kind === "proxy") {
    const original = manifest.sources.find(
      (source) => source.id === representation.source_id
    );
    if (!original?.binding) {
      throw new Error("media-sources v4 代理找不到原始 source 的管线");
    }
    if (
      args.has("pipeline")
      && args.get("pipeline") !== original.binding.pipeline
    ) {
      throw new Error("media-sources v4 代理不能改变原始 source 的管线");
    }
    const detailArgs = bindingArgs.filter((key) => key !== "pipeline");
    if (detailArgs.length > 0) {
      throw new Error(
        `media-sources v4 代理自动继承管线，不能重复声明：${detailArgs.join(", ")}`
      );
    }
    return structuredClone(original.binding);
  }

  const pipeline = required(args, "pipeline");
  if (pipeline === "browser") {
    const extra = bindingArgs.filter((key) => key !== "pipeline");
    if (extra.length > 0) {
      throw new Error(`browser 管线不接受参数：${extra.join(", ")}`);
    }
    if (mediaType === "audio") {
      throw new Error("audio 素材必须使用 native-audio");
    }
    return { pipeline };
  }
  if (pipeline === "native-audio") {
    if (mediaType !== "audio") {
      throw new Error("只有 audio 素材可以使用 native-audio");
    }
    const loop = args.get("loop") || "none";
    if (!["none", "repeat"].includes(loop)) {
      throw new Error("--loop 必须是 none 或 repeat");
    }
    for (const invalid of ["fit", "playback", "audio"]) {
      if (args.has(invalid)) {
        throw new Error(`native-audio 不接受 --${invalid}`);
      }
    }
    return {
      pipeline,
      loop,
      source_in_ms: nonNegativeNumber(args, "source-in-ms", 0),
      gain_db: finiteNumber(args, "gain-db", 0),
    };
  }
  if (pipeline === "native-underlay") {
    if (mediaType !== "video") {
      throw new Error("只有 video 素材可以使用 native-underlay");
    }
    const fit = args.get("fit") || "cover";
    const playback = args.get("playback") || "hold";
    const audio = args.get("audio") || "exclude";
    if (!["cover", "contain"].includes(fit)) {
      throw new Error("--fit 必须是 cover 或 contain");
    }
    if (!["hold", "repeat"].includes(playback)) {
      throw new Error("--playback 必须是 hold 或 repeat");
    }
    if (!["include", "exclude"].includes(audio)) {
      throw new Error("--audio 必须是 include 或 exclude");
    }
    if (args.has("loop")) {
      throw new Error("native-underlay 不接受 --loop；使用 --playback");
    }
    return {
      pipeline,
      fit,
      playback,
      source_in_ms: nonNegativeNumber(args, "source-in-ms", 0),
      audio,
      gain_db: finiteNumber(args, "gain-db", 0),
    };
  }
  throw new Error("--pipeline 必须是 browser、native-underlay 或 native-audio");
}

function isoDate(value, label) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} 不是有效日期时间`);
  return date.toISOString();
}

function readCrops(args) {
  const cropsPath = args.get("crops-json");
  if (!cropsPath) return {};
  const absolute = path.resolve(cropsPath);
  const value = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--crops-json 根节点必须是对象");
  }
  return value;
}

function buildSpeech(args) {
  const keys = ["voice-id", "voice-name", "language", "speech-text"];
  const requested = keys.some((key) => args.has(key)) || args.has("exact-voice");
  if (!requested) return null;
  const textPath = path.resolve(required(args, "speech-text"));
  if (!fs.existsSync(textPath) || !fs.statSync(textPath).isFile()) {
    throw new Error(`合成输入文本不存在：${textPath}`);
  }
  const speech = {
    provider_voice_id: args.get("voice-id") || "",
    voice_name: args.get("voice-name") || "",
    language: args.get("language") || "",
    text_sha256: sha256File(textPath),
    exact_identity: args.has("exact-voice"),
  };
  if (speech.exact_identity && (!speech.provider_voice_id || !speech.voice_name)) {
    throw new Error("--exact-voice 要求同时提供 --voice-id 与 --voice-name");
  }
  return speech;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const args = parseArgs(argv);
  const projectRoot = path.resolve(required(args, "project"));
  const inputPath = path.resolve(required(args, "input"));
  const id = required(args, "id");
  const mediaType = required(args, "media-type");
  const method = required(args, "method");
  const rightsStatus = required(args, "rights-status");
  const license = required(args, "license");
  const usageText = required(args, "usage");
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`项目目录不存在：${projectRoot}`);
  }
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`输入文件不存在：${inputPath}`);
  }
  if (!ID_PATTERN.test(id)) throw new Error(`素材 id 不合法：${id}`);
  if (!MEDIA_TYPES.has(mediaType)) throw new Error(`media-type 不合法：${mediaType}`);
  if (!METHODS.has(method)) throw new Error(`method 不合法：${method}`);
  if (!RIGHTS.has(rightsStatus)) {
    throw new Error(`rights-status 不合法：${rightsStatus}`);
  }
  if (rightsStatus === "confirmed" && license.length === 0) {
    throw new Error("rights-status=confirmed 时 --license 不能为空");
  }
  const recordedAt = isoDate(args.get("captured-at"), "--captured-at");
  const provider = args.get("provider")
    || (method === "generated" ? "unspecified-generator" : "");
  const jobId = args.get("job-id") || "";
  const generationRequested = method === "generated"
    || [
      "generation-model",
      "generation-prompt",
      "generation-seed",
      "created-at",
    ].some((key) => args.has(key));
  const generationCreatedAt = generationRequested
    ? isoDate(args.get("created-at"), "--created-at")
    : null;
  const generation = generationRequested
    ? {
      provider: provider || "unspecified-generator",
      model: args.get("generation-model") || "",
      prompt: args.get("generation-prompt") || "",
      seed: args.has("generation-seed") ? args.get("generation-seed") : null,
      created_at: generationCreatedAt,
    }
    : null;
  const hasSubjectX = args.has("subject-x");
  const hasSubjectY = args.has("subject-y");
  if (hasSubjectX !== hasSubjectY) {
    throw new Error("--subject-x 与 --subject-y 必须同时提供");
  }
  const subject = hasSubjectX
    ? {
      x: Number(args.get("subject-x")),
      y: Number(args.get("subject-y")),
    }
    : null;
  if (
    subject
    && (
      !Number.isFinite(subject.x)
      || !Number.isFinite(subject.y)
      || subject.x < 0
      || subject.x > 1
      || subject.y < 0
      || subject.y > 1
    )
  ) {
    throw new Error("主体坐标必须在 0–1 范围内");
  }
  const crops = readCrops(args);
  const speech = buildSpeech(args);
  const captureInput = args.get("capture")
    ? path.resolve(args.get("capture"))
    : null;
  if (
    captureInput
    && (!fs.existsSync(captureInput) || !fs.statSync(captureInput).isFile())
  ) {
    throw new Error(`生成或取得回执不存在：${captureInput}`);
  }
  if (method === "generated") {
    if (!args.has("provider") || !jobId || !captureInput) {
      throw new Error(
        "method=generated 必须提供 --provider、--job-id 和 --capture，"
          + "并从 generation-jobs.json 的成功任务本地化"
      );
    }
    const jobsPath = path.join(projectRoot, "generation-jobs.json");
    const jobValidation = validateGenerationJobs(jobsPath);
    if (!jobValidation.ok) {
      throw new Error(
        "外部生成任务合同无效，素材导入已停止：\n"
          + jobValidation.errors.map((item) => `- ${item}`).join("\n")
      );
    }
    const generationJob = jobValidation.contract.jobs.find(
      (item) => item.remote.job_id === jobId
    );
    if (!generationJob || generationJob.remote.status !== "succeeded") {
      throw new Error("--job-id 没有对应到同一项目中已经成功的外部生成任务");
    }
    if (
      generationJob.provider !== provider
      || generationJob.remote.status_capture?.sha256 !== sha256File(captureInput)
    ) {
      throw new Error("供应方或成功回执与 generation-jobs.json 不一致");
    }
    if (
      generationJob.imported_source_id !== null
      && generationJob.imported_source_id !== id
    ) {
      throw new Error("外部生成任务已经本地化到另一个 source id");
    }
  }

  const manifestPath = path.resolve(
    args.get("manifest") || path.join(projectRoot, "media-sources.json")
  );
  if (path.dirname(manifestPath) !== projectRoot) {
    throw new Error("--manifest 必须直接位于 --project 目录中");
  }
  const manifest = readManifest(manifestPath, args);
  const representation = buildRepresentation(
    args,
    manifest,
    mediaType,
    recordedAt
  );
  const binding = buildEditableMediaBinding(
    args,
    manifest,
    mediaType,
    representation
  );
  const inputHash = sha256File(inputPath);
  const existing = manifest.sources.find((source) => source.id === id);
  if (existing) {
    if (existing.integrity?.sha256 !== inputHash) {
      throw new Error(
        `素材 id ${id} 已指向其它内容；请使用新的 id，脚本不会覆盖原记录`
      );
    }
    const comparisons = [
      ["media_type", existing.media_type, mediaType],
      ["acquisition.method", existing.acquisition?.method, method],
      ["rights.status", existing.rights?.status, rightsStatus],
      ["rights.license", existing.rights?.license, license],
      ["usage", existing.usage, usageText],
      [
        "representation",
        JSON.stringify(existing.representation),
        JSON.stringify(representation),
      ],
    ];
    if (manifest.version === EDITABLE_MEDIA_VERSION) {
      comparisons.push([
        "binding",
        JSON.stringify(existing.binding),
        JSON.stringify(binding),
      ]);
    }
    for (const [flag, recordPath] of [
      ["source-url", "acquisition.source_url"],
      ["attribution", "rights.attribution"],
      ["terms-url", "rights.terms_url"],
      ["notes", "notes"],
    ]) {
      if (!args.has(flag)) continue;
      const actual = recordPath
        .split(".")
        .reduce((value, key) => value?.[key], existing);
      comparisons.push([recordPath, actual, args.get(flag)]);
    }
    if (args.has("provider")) {
      const actualProvider = existing.generation?.provider
        || existing.provenance_runs?.at(-1)?.provider
        || "";
      comparisons.push(["provider", actualProvider, args.get("provider")]);
    }
    if (args.has("captured-at")) {
      comparisons.push([
        "acquisition.captured_at",
        existing.acquisition?.captured_at,
        recordedAt,
      ]);
    }
    if (args.has("job-id")) {
      comparisons.push([
        "provenance_runs[-1].job_id",
        existing.provenance_runs?.at(-1)?.job_id,
        jobId,
      ]);
    }
    if (args.has("capture")) {
      const requestedCaptureHash = sha256File(captureInput);
      comparisons.push([
        "provenance_runs[-1].capture.sha256",
        existing.provenance_runs?.at(-1)?.capture?.sha256,
        requestedCaptureHash,
      ]);
    }
    if (speech && JSON.stringify(existing.speech) !== JSON.stringify(speech)) {
      comparisons.push(["speech", existing.speech, speech]);
    }
    if (subject && JSON.stringify(existing.subject) !== JSON.stringify(subject)) {
      comparisons.push(["subject", existing.subject, subject]);
    }
    if (
      args.has("crops-json")
      && JSON.stringify(existing.crops) !== JSON.stringify(crops)
    ) {
      comparisons.push(["crops", existing.crops, crops]);
    }
    for (const [flag, field, requested] of [
      ["generation-model", "model", args.get("generation-model")],
      ["generation-prompt", "prompt", args.get("generation-prompt")],
      ["generation-seed", "seed", args.get("generation-seed")],
      ["created-at", "created_at", generationCreatedAt],
    ]) {
      if (args.has(flag)) {
        comparisons.push([
          `generation.${field}`,
          existing.generation?.[field],
          requested,
        ]);
      }
    }
    const mismatches = comparisons
      .filter(([, actual, requested]) => actual !== requested)
      .map(([field, actual, requested]) => ({ field, actual, requested }));
    if (mismatches.length > 0) {
      throw new Error(
        `素材 id ${id} 的文件相同，但请求元数据与现有记录冲突：`
          + `${JSON.stringify(mismatches)}。请先确定唯一正确记录，不会静默改写。`
      );
    }
    console.log(
      JSON.stringify(
        {
          imported: false,
          reused: true,
          reason: "same-id-same-content",
          manifest: manifestPath,
          source: existing,
          binding_changed: false,
        },
        null,
        2
      )
    );
    return 0;
  }

  if (args.has("move-input") && representation.kind !== "proxy") {
    throw new Error("--move-input 只允许与 --proxy-of 一起使用");
  }
  const imported = contentAddressedCopy(
    projectRoot,
    inputPath,
    path.join("assets", "by-sha256"),
    args.has("move-input")
  );
  const capture = captureInput
    ? contentAddressedCopy(
      projectRoot,
      captureInput,
      path.join("provenance", "by-sha256")
    )
    : null;
  const captureRecord = capture
    ? { file: capture.file, sha256: capture.sha256 }
    : null;

  const source = {
    id,
    media_type: mediaType,
    file: imported.file,
    ...(binding ? { binding } : {}),
    representation,
    acquisition: {
      method,
      source_url: args.get("source-url") || "",
      captured_at: recordedAt,
    },
    rights: {
      status: rightsStatus,
      license,
      attribution: args.get("attribution") || "",
      terms_url: args.get("terms-url") || "",
    },
    usage: usageText,
    integrity: {
      sha256: imported.sha256,
      bytes: imported.bytes,
      mime_type: imported.mime_type,
    },
    generation,
    speech,
    provenance_runs: [
      {
        recorded_at: recordedAt,
        provider,
        job_id: jobId,
        capture: captureRecord,
      },
    ],
    subject,
    crops,
    notes: args.get("notes") || "",
  };
  const previousManifest = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, "utf8")
    : null;
  manifest.sources.push(source);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: fs.existsSync(manifestPath) ? "w" : "wx",
  });
  const result = validateMediaSources(manifestPath, {
    contract: mediaSourcesContractForVersion(manifest.version),
  });
  if (!result.ok) {
    if (previousManifest === null) {
      fs.renameSync(
        manifestPath,
        path.join(projectRoot, `invalid-media-sources-${Date.now()}.json`)
      );
    } else {
      fs.writeFileSync(manifestPath, previousManifest, "utf8");
    }
    throw new Error(
      "导入后素材账本未通过验证，活动账本已恢复；导入文件保留供排查：\n"
        + result.errors.map((item) => `- ${item}`).join("\n")
    );
  }
  console.log(
    JSON.stringify(
      {
        imported: true,
        reused: false,
        manifest: manifestPath,
        source,
        deduplicated_file: manifest.sources.some(
          (item) => item.id !== id && item.integrity?.sha256 === imported.sha256
        ),
        binding_changed: false,
        next_action: "在活动网页清单、视频时间线或音频项目中显式引用该 source id。",
      },
      null,
      2
    )
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
