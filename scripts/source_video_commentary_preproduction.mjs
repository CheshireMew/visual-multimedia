import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  commandPath,
  ensureFile,
  nowIso,
  probeMedia,
  projectPath,
  readJson,
  relativeProjectPath,
  run,
  sha256File,
  writeJson,
} from "./interview_explainer_common.mjs";
import {
  inspectLocalMediaCapabilities,
  loadLocalMediaEnvironment,
  mediaFlowProDescribeOperation,
  mediaFlowProExecute,
  resolveVoiceReference,
} from "./local-media-environment.mjs";
import {validateMediaSources} from "./validate-media-sources.mjs";
import {validateMediaTranscript} from "./validate-media-transcript.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROFILE = "source-video-commentary@1.0.0";
const ANALYSIS_RELATIVE = "source-video-commentary-analysis.json";
const AUTHORING_RELATIVE = "source-video-commentary-authoring.json";
const AUTHORING_CONFIRMATION_RELATIVE = "source-video-commentary-authoring-confirmation.json";
const NARRATION_CANDIDATES_RELATIVE = "source-video-commentary-narration-candidates.json";
const NARRATION_BUNDLE_RELATIVE = "narration-bundle.json";
const DRAFT_RELATIVE = "source-video-commentary-draft.json";
const SCRIPT_RELATIVE = "source-video-commentary-script.md";
const IMPORT_ASSET = path.join(SCRIPT_DIR, "import-media-asset.mjs");
const IMPORT_TRANSCRIPT = path.join(SCRIPT_DIR, "import-media-transcript.mjs");
const CONTACT_SHEET = path.join(SCRIPT_DIR, "make-video-contact-sheet.py");
const COMMENTARY_STARTER = path.join(SKILL_ROOT, "assets", "source-video-commentary-starter");
const ANALYSIS_SCHEMA = path.join(SKILL_ROOT, "schemas", "source-video-commentary-analysis.v1.schema.json");
const AUTHORING_SCHEMA = path.join(SKILL_ROOT, "schemas", "source-video-commentary-authoring.v1.schema.json");
const AUTHORING_CONFIRMATION_SCHEMA = path.join(SKILL_ROOT, "schemas", "source-video-commentary-authoring-confirmation.v1.schema.json");
const NARRATION_CANDIDATES_SCHEMA = path.join(SKILL_ROOT, "schemas", "source-video-commentary-narration-candidates.v1.schema.json");
const NARRATION_SCHEMA = path.join(SKILL_ROOT, "schemas", "narration-bundle.v1.schema.json");
const DRAFT_SCHEMA = path.join(SKILL_ROOT, "schemas", "source-video-commentary-draft.v1.schema.json");

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requireId(value, label) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(value || "")) throw new Error(`${label} 格式不合法：${value}`);
  return value;
}

function finite(value, label, fallback = null) {
  if (value == null && fallback != null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} 必须是有限数字`);
  return number;
}

function integer(value, label, fallback = null) {
  const number = finite(value, label, fallback);
  if (!Number.isInteger(number)) throw new Error(`${label} 必须是整数`);
  return number;
}

function projectIdentity(projectRoot) {
  const statePath = path.join(projectRoot, "media-project-state.json");
  ensureFile(statePath, "媒体项目状态");
  const state = readJson(statePath);
  if (state.profile !== PROFILE) throw new Error(`项目 profile 不是 ${PROFILE}`);
  return {projectId: requireId(state.project_id, "project id"), state};
}

function mediaSources(projectRoot, ffprobe = null) {
  const file = path.join(projectRoot, "media-sources.json");
  const validation = validateMediaSources(file, ffprobe ? {ffprobe} : {});
  if (!validation.ok) throw new Error(`素材账本未通过：\n- ${validation.errors.join("\n- ")}`);
  const document = readJson(file);
  return {file, document, byId: new Map(document.sources.map((item) => [item.id, item]))};
}

function writeNewOrSameJson(file, document, schema, label) {
  if (schema) assertJsonSchema(document, schema, label);
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== payload) throw new Error(`${label} 已存在且内容不同，拒绝静默覆盖：${file}`);
    return false;
  }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, payload, {encoding: "utf8", flag: "wx"});
  return true;
}

function isStarterFile(target, starterName) {
  const starter = path.join(COMMENTARY_STARTER, starterName);
  if (fs.existsSync(target) && fs.existsSync(starter) && sha256File(target) === sha256File(starter)) return true;
  if (!fs.existsSync(target)) return false;
  if (starterName === "source-video-commentary-draft.json") {
    try {
      const document = readJson(target);
      return document.protocol === "visual-multimedia-source-video-commentary-draft"
        && /^0{64}$/u.test(document.script?.sha256 || "")
        && document.segments?.length === 1
        && document.segments[0]?.visual?.clip_selection_id === "replace-with-reviewed-clip-id";
    } catch {
      return false;
    }
  }
  if (starterName === "narration-bundle.json") {
    try {
      const document = readJson(target);
      return document.protocol === "visual-multimedia-narration-bundle" && document.segments?.length === 0;
    } catch {
      return false;
    }
  }
  return false;
}

function writeProjectArtifact(target, payload, starterName = null) {
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, "utf8") === payload) return false;
    if (!starterName || !isStarterFile(target, starterName)) {
      throw new Error(`项目产物已存在且不是 starter，拒绝静默覆盖：${target}`);
    }
  }
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, payload, "utf8");
  return true;
}

function binding(projectRoot, file) {
  const absolute = projectPath(projectRoot, file, "artifact binding");
  ensureFile(absolute, "artifact binding");
  return {file: relativeProjectPath(projectRoot, absolute), sha256: sha256File(absolute)};
}

function importAsset(options) {
  const args = [
    IMPORT_ASSET,
    "--project", path.resolve(options.project),
    "--input", path.resolve(options.input),
    "--id", requireId(options.id, "source id"),
    "--media-type", options.mediaType,
    "--method", options.method,
    "--rights-status", options.rightsStatus,
    "--license", options.license,
    "--usage", options.usage,
  ];
  const optional = [
    ["provider", options.provider],
    ["capture", options.capture],
    ["generation-model", options.generationModel],
    ["generation-prompt", options.generationPrompt],
    ["generation-seed", options.generationSeed],
    ["voice-id", options.voiceId],
    ["voice-name", options.voiceName],
    ["language", options.language],
    ["speech-text", options.speechText],
    ["notes", options.notes],
  ];
  for (const [flag, value] of optional) if (value != null && String(value).length) args.push(`--${flag}`, String(value));
  if (options.exactVoice) args.push("--exact-voice");
  const response = run(process.execPath, args, {cwd: SKILL_ROOT});
  return JSON.parse(response.stdout);
}

export function ingestSourceVideo(options) {
  const projectRoot = path.resolve(options.project);
  projectIdentity(projectRoot);
  const input = path.resolve(options.input);
  ensureFile(input, "源视频");
  const result = importAsset({
    project: projectRoot,
    input,
    id: options.sourceId,
    mediaType: "video",
    method: options.method || "user-provided",
    rightsStatus: options.rightsStatus,
    license: options.license,
    usage: options.usage || "素材解说型视频的完整源片",
    notes: options.notes || "由 source-video-commentary prepare 正式入账",
  });
  return {project: projectRoot, source: result.source, imported: result.imported, reused: result.reused};
}

export function importBackgroundMusic(options) {
  const projectRoot = path.resolve(options.project);
  projectIdentity(projectRoot);
  const input = path.resolve(options.input);
  ensureFile(input, "背景音乐");
  const result = importAsset({
    project: projectRoot,
    input,
    id: options.sourceId,
    mediaType: "audio",
    method: options.method || "user-provided",
    rightsStatus: options.rightsStatus,
    license: options.license,
    usage: options.usage || "素材解说型视频背景音乐",
    notes: options.notes || "由 source-video-commentary import-bgm 正式入账",
  });
  return {project: projectRoot, source: result.source, imported: result.imported, reused: result.reused};
}

function parseSceneTransitions(output, threshold, duration) {
  const lines = String(output || "").split(/\r?\n/u);
  const transitions = [];
  let pending = null;
  for (const line of lines) {
    const frame = line.match(/frame:\s*\d+\s+pts:\s*[-\d]+\s+pts_time:\s*([\d.]+)/u);
    if (frame) pending = Number(frame[1]);
    const score = line.match(/lavfi\.scene_score=([\d.]+)/u);
    if (score && Number.isFinite(pending) && pending > 0.001 && pending < duration - 0.001) {
      transitions.push({time: pending, score: Number(score[1])});
      pending = null;
    }
  }
  return transitions.filter((item) => Number.isFinite(item.time) && Number.isFinite(item.score) && item.score >= threshold);
}

function chooseTransitions(transitions, maximumCandidates) {
  const allowed = Math.max(0, maximumCandidates - 1);
  if (transitions.length <= allowed) return transitions.sort((a, b) => a.time - b.time);
  return [...transitions]
    .sort((a, b) => b.score - a.score || a.time - b.time)
    .slice(0, allowed)
    .sort((a, b) => a.time - b.time);
}

function sceneCandidates(ffmpeg, sourcePath, duration, threshold, maximumCandidates) {
  const filter = `select='gt(scene,${threshold})',metadata=print`;
  const response = run(ffmpeg, ["-hide_banner", "-nostats", "-i", sourcePath, "-vf", filter, "-an", "-f", "null", "-"]);
  const transitions = chooseTransitions(parseSceneTransitions(`${response.stdout}\n${response.stderr}`, threshold, duration), maximumCandidates);
  const boundaries = [{time: 0, score: 1}, ...transitions];
  return boundaries.map((item, index) => {
    const end = index + 1 < boundaries.length ? boundaries[index + 1].time : duration;
    const safeEnd = Math.max(item.time + Math.min(0.04, duration), end);
    return {
      id: `scene-${String(index + 1).padStart(4, "0")}`,
      start_seconds: item.time,
      end_seconds: Math.min(duration, safeEnd),
      representative_seconds: Math.min(duration, item.time + Math.max(0, safeEnd - item.time) / 2),
      transition_score: Math.max(0, Math.min(1, item.score)),
      status: "suggestion-only",
    };
  });
}

function authoringPacket(projectRoot, source, media, candidates, transcriptRelative) {
  const lines = [
    "# 素材解说写作包",
    "",
    `- 项目：${projectIdentity(projectRoot).projectId}`,
    `- 源片：${source.file}`,
    `- 时长：${media.duration_seconds.toFixed(3)} 秒`,
    `- 画面：${media.width} × ${media.height}，${media.fps.toFixed(3)} fps`,
    `- 联系表：reports/source-video-commentary-contact-sheet.jpg`,
    `- 转写：${transcriptRelative || "无；不得虚构原声内容"}`,
    "",
    "Agent 必须先查看联系表、候选场景和实际转写，再创建 source-video-commentary-authoring.json。",
    "每个 segment 明确写出解说目的、源片真实范围、画面职责、旁白文本、声音模式与字幕。",
    "候选场景只是检索提示，不是正式选段；最终入点和出点只会由 materialize 写入 clip-selections.json。",
    "",
    "## 候选场景",
    "",
    ...candidates.map((item) => `- ${item.id}: ${item.start_seconds.toFixed(3)}–${item.end_seconds.toFixed(3)}s，代表帧 ${item.representative_seconds.toFixed(3)}s，转场分数 ${item.transition_score.toFixed(4)}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function assertAnalysisReuse(projectRoot, analysisPath, source, expectedOptions) {
  if (!fs.existsSync(analysisPath)) return null;
  const analysis = readJson(analysisPath);
  assertJsonSchema(analysis, ANALYSIS_SCHEMA, "existing source video commentary analysis");
  if (analysis.source.id !== source.id || analysis.source.sha256 !== source.integrity.sha256) {
    throw new Error("现有分析绑定另一份源片；请归档旧项目后重新准备");
  }
  if (JSON.stringify(analysis.options) !== JSON.stringify(expectedOptions)) {
    throw new Error("现有分析使用了不同参数；请归档旧分析后明确重跑");
  }
  for (const item of [analysis.visual_evidence.contact_sheet, analysis.visual_evidence.contact_sheet_metadata, analysis.authoring_packet]) {
    const absolute = projectPath(projectRoot, item.file, "analysis evidence");
    if (sha256File(absolute) !== item.sha256) throw new Error(`现有分析证据已经变化：${item.file}`);
  }
  return analysis;
}

function transcribeSource({projectRoot, source, sourcePath, language, environment}) {
  const existingTranscriptPath = path.join(projectRoot, "transcript.json");
  const existingReceiptPath = projectPath(projectRoot, "reports/source-video-commentary-transcription.json", "transcription receipt");
  if (fs.existsSync(existingTranscriptPath) && fs.existsSync(existingReceiptPath)) {
    const validation = validateMediaTranscript(existingTranscriptPath);
    if (!validation.ok) throw new Error(`既有 transcript 无效：\n- ${validation.errors.join("\n- ")}`);
    const transcript = readJson(existingTranscriptPath);
    const receipt = readJson(existingReceiptPath);
    if (transcript.source_id !== source.id || transcript.source_sha256 !== source.integrity.sha256 || receipt.input_sha256 !== source.integrity.sha256) {
      throw new Error("既有 transcript 或转写回执绑定另一份源片");
    }
    return {
      file: "transcript.json",
      sha256: sha256File(existingTranscriptPath),
      review_status: transcript.review.status,
      language: transcript.language,
      segment_count: transcript.segments.length,
      provider_receipt: binding(projectRoot, relativeProjectPath(projectRoot, existingReceiptPath)),
    };
  }
  const operation = mediaFlowProDescribeOperation(environment, "speech.transcribe");
  if (operation.name !== "speech.transcribe") throw new Error("MediaFlow Pro 没有提供精确转写合同");
  const output = projectPath(projectRoot, "working/source-video-commentary/source-transcript.srt", "transcription output");
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const result = mediaFlowProExecute(environment, null, "speech.transcribe", {
    input_path: sourcePath,
    output_path: output,
    language: language || null,
    model: null,
    device: "auto",
    compute_type: null,
    overwrite: false,
  });
  if (result.input_sha256 !== source.integrity.sha256) throw new Error("转写回执没有绑定当前源片哈希");
  const receiptPath = projectPath(projectRoot, "reports/source-video-commentary-transcription.json", "transcription receipt");
  writeNewOrSameJson(receiptPath, result, null, "transcription receipt");
  const imported = run(process.execPath, [
    IMPORT_TRANSCRIPT,
    "--project", projectRoot,
    "--source-id", source.id,
    "--input", output,
    "--language", result.language,
    "--kind", "asr",
    "--output", "transcript.json",
  ], {cwd: SKILL_ROOT});
  JSON.parse(imported.stdout);
  const transcriptPath = path.join(projectRoot, "transcript.json");
  const transcript = readJson(transcriptPath);
  return {
    file: "transcript.json",
    sha256: sha256File(transcriptPath),
    review_status: transcript.review.status,
    language: transcript.language,
    segment_count: transcript.segments.length,
    provider_receipt: binding(projectRoot, relativeProjectPath(projectRoot, receiptPath)),
  };
}

export function analyzeSourceVideo(options) {
  const projectRoot = path.resolve(options.project);
  const identity = projectIdentity(projectRoot);
  const environment = loadLocalMediaEnvironment(options.localConfig || null);
  const ffmpeg = commandPath("ffmpeg", options.ffmpeg || environment.providers.local.ffmpeg, "FFMPEG_BIN");
  const ffprobe = commandPath("ffprobe", options.ffprobe || environment.providers.local.ffprobe, "FFPROBE_BIN");
  const python = commandPath("python", options.python || process.env.MEDIAFLOW_PYTHON || null, "PYTHON_BIN");
  const sources = mediaSources(projectRoot, ffprobe);
  const source = sources.byId.get(requireId(options.sourceId, "source id"));
  if (!source || source.media_type !== "video" || source.representation?.kind !== "source") {
    throw new Error("analyze 的 source-id 必须指向素材账本中的原始 video source");
  }
  const sourcePath = projectPath(projectRoot, source.file, "source video");
  const media = probeMedia(ffprobe, sourcePath);
  if (!media.has_video || !(media.duration_seconds > 0) || !(media.width > 0) || !(media.height > 0) || !(media.fps > 0)) {
    throw new Error("源片没有可分析的真实视频流、尺寸、帧率或时长");
  }
  const transcriptMode = options.transcriptionMode || "auto";
  if (!["auto", "required", "skip"].includes(transcriptMode)) throw new Error("transcription-mode 必须是 auto、required 或 skip");
  const analysisOptions = {
    scene_threshold: finite(options.sceneThreshold, "scene-threshold", 0.28),
    maximum_candidates: integer(options.maximumCandidates, "maximum-candidates", 60),
    contact_sheet_frames: integer(options.contactSheetFrames, "contact-sheet-frames", 24),
    transcription_mode: transcriptMode,
    requested_language: options.language || null,
  };
  if (analysisOptions.scene_threshold < 0 || analysisOptions.scene_threshold > 1) throw new Error("scene-threshold 必须在 0–1");
  if (analysisOptions.maximum_candidates < 1 || analysisOptions.contact_sheet_frames < 4) throw new Error("候选场景或联系表帧数过小");
  const analysisPath = projectPath(projectRoot, options.output || ANALYSIS_RELATIVE, "analysis output");
  const reused = assertAnalysisReuse(projectRoot, analysisPath, source, analysisOptions);
  if (reused) return {created: false, reused: true, analysis: analysisPath, transcript: reused.transcript, scene_candidates: reused.scene_candidates.length};

  const candidates = sceneCandidates(ffmpeg, sourcePath, media.duration_seconds, analysisOptions.scene_threshold, analysisOptions.maximum_candidates);
  const contactSheetPath = projectPath(projectRoot, "reports/source-video-commentary-contact-sheet.jpg", "contact sheet");
  const contactMetadataPath = projectPath(projectRoot, "reports/source-video-commentary-contact-sheet.json", "contact sheet metadata");
  fs.mkdirSync(path.dirname(contactSheetPath), {recursive: true});
  run(python, [
    CONTACT_SHEET,
    sourcePath,
    contactSheetPath,
    "--frames", String(analysisOptions.contact_sheet_frames),
    "--cols", String(Math.max(2, Math.ceil(Math.sqrt(analysisOptions.contact_sheet_frames)))),
    "--metadata", contactMetadataPath,
    "--ffmpeg", ffmpeg,
    "--ffprobe", ffprobe,
  ], {cwd: SKILL_ROOT});

  let transcript = null;
  if (media.has_audio && transcriptMode !== "skip") {
    const capabilities = inspectLocalMediaCapabilities(environment);
    const available = capabilities.providers.mediaflow?.capabilities?.speech_transcribe === true;
    if (!available && transcriptMode === "required") throw new Error("转写被要求为 required，但 MediaFlow speech.transcribe 当前不可用");
    if (available) transcript = transcribeSource({projectRoot, source, sourcePath, language: options.language || null, environment});
  } else if (transcriptMode === "required") {
    throw new Error("转写被要求为 required，但源片没有音轨");
  }

  const packetPath = projectPath(projectRoot, "source-video-commentary-authoring-packet.md", "authoring packet");
  const packet = authoringPacket(projectRoot, source, media, candidates, transcript?.file || null);
  if (fs.existsSync(packetPath) && fs.readFileSync(packetPath, "utf8") !== packet) throw new Error("写作包已存在且内容不同，拒绝覆盖");
  if (!fs.existsSync(packetPath)) fs.writeFileSync(packetPath, packet, {encoding: "utf8", flag: "wx"});
  const analysis = {
    protocol: "visual-multimedia-source-video-commentary-analysis",
    version: 1,
    project_id: identity.projectId,
    profile: PROFILE,
    created_at: nowIso(),
    source: {
      id: source.id,
      file: source.file,
      sha256: source.integrity.sha256,
      duration_seconds: media.duration_seconds,
      width: media.width,
      height: media.height,
      frame_rate: media.fps,
      has_audio: media.has_audio,
    },
    options: analysisOptions,
    scene_candidates: candidates,
    visual_evidence: {
      contact_sheet: binding(projectRoot, relativeProjectPath(projectRoot, contactSheetPath)),
      contact_sheet_metadata: binding(projectRoot, relativeProjectPath(projectRoot, contactMetadataPath)),
    },
    transcript,
    authoring_packet: binding(projectRoot, relativeProjectPath(projectRoot, packetPath)),
  };
  writeNewOrSameJson(analysisPath, analysis, ANALYSIS_SCHEMA, "source video commentary analysis");
  return {created: true, reused: false, analysis: analysisPath, transcript, scene_candidates: candidates.length, contact_sheet: contactSheetPath};
}

export function confirmSourceTranscript(options) {
  const projectRoot = path.resolve(options.project);
  projectIdentity(projectRoot);
  if (options.confirmedBy !== "user") throw new Error("转写听音确认必须记录 confirmed-by=user");
  if (!options.evidence) throw new Error("转写听音确认必须提供 evidence");
  const authoringPath = projectPath(projectRoot, options.authoring || AUTHORING_RELATIVE, "authoring");
  if (fs.existsSync(authoringPath)) throw new Error("已经存在 authoring；请先归档它，再确认会改变分析哈希的 transcript");
  const transcriptPath = projectPath(projectRoot, options.transcript || "transcript.json", "transcript");
  const transcript = readJson(transcriptPath);
  if (transcript.review.status === "failed") throw new Error("转写已经标记 failed，必须先修订字幕再确认");
  transcript.review = {
    status: "passed",
    listened: true,
    reviewed_at: nowIso(),
    notes: options.evidence,
  };
  writeJson(transcriptPath, transcript);
  const validation = validateMediaTranscript(transcriptPath);
  if (!validation.ok) throw new Error(`确认后的 transcript 未通过：\n- ${validation.errors.join("\n- ")}`);

  const analysisPath = projectPath(projectRoot, options.analysis || ANALYSIS_RELATIVE, "analysis");
  const analysis = readJson(analysisPath);
  assertJsonSchema(analysis, ANALYSIS_SCHEMA, "source video commentary analysis");
  if (!analysis.transcript || analysis.transcript.file !== relativeProjectPath(projectRoot, transcriptPath)) {
    throw new Error("analysis 没有绑定当前 transcript");
  }
  analysis.transcript.sha256 = sha256File(transcriptPath);
  analysis.transcript.review_status = "passed";
  analysis.transcript.segment_count = transcript.segments.length;
  writeJson(analysisPath, analysis);
  assertJsonSchema(readJson(analysisPath), ANALYSIS_SCHEMA, "updated source video commentary analysis");
  return {status: "passed", transcript: transcriptPath, analysis: analysisPath, analysis_sha256: sha256File(analysisPath)};
}

function transcriptContext(projectRoot, analysis) {
  if (!analysis.transcript) return null;
  const file = projectPath(projectRoot, analysis.transcript.file, "analysis transcript");
  const validation = validateMediaTranscript(file);
  if (!validation.ok) throw new Error(`analysis transcript 未通过：\n- ${validation.errors.join("\n- ")}`);
  const document = readJson(file);
  return {file, document, byId: new Map(document.segments.map((item) => [item.id, item]))};
}

export function validateSourceVideoCommentaryAuthoring(options) {
  const projectRoot = path.resolve(options.project);
  const identity = projectIdentity(projectRoot);
  const authoringPath = projectPath(projectRoot, options.authoring || AUTHORING_RELATIVE, "authoring");
  ensureFile(authoringPath, "authoring");
  const authoring = readJson(authoringPath);
  assertJsonSchema(authoring, AUTHORING_SCHEMA, "source video commentary authoring");
  if (authoring.project_id !== identity.projectId || authoring.profile !== PROFILE) throw new Error("authoring 与当前项目身份不一致");
  const analysisPath = projectPath(projectRoot, authoring.analysis.file, "authoring analysis");
  if (sha256File(analysisPath) !== authoring.analysis.sha256) throw new Error("authoring 没有绑定当前 analysis 哈希");
  const analysis = readJson(analysisPath);
  assertJsonSchema(analysis, ANALYSIS_SCHEMA, "authoring analysis");
  const sources = mediaSources(projectRoot, options.ffprobe || null);
  const transcript = transcriptContext(projectRoot, analysis);
  const source = sources.byId.get(analysis.source.id);
  if (!source || source.integrity.sha256 !== analysis.source.sha256) throw new Error("analysis source 与素材账本不一致");

  const ids = new Set();
  const orders = new Set();
  const captionIds = new Set();
  let narrationCount = 0;
  for (const segment of authoring.segments) {
    if (ids.has(segment.id)) throw new Error(`authoring segment id 重复：${segment.id}`);
    if (orders.has(segment.order)) throw new Error(`authoring segment order 重复：${segment.order}`);
    ids.add(segment.id);
    orders.add(segment.order);
    const selection = segment.selection;
    if (selection.source_id !== source.id) throw new Error(`segment ${segment.id} 当前只能引用本轮分析的 source ${source.id}`);
    if (!(selection.end_seconds > selection.start_seconds) || selection.end_seconds > analysis.source.duration_seconds + 0.001) {
      throw new Error(`segment ${segment.id} 的源片范围无效或超出源片`);
    }
    const needsNarration = segment.audio.mode !== "source-only";
    if (needsNarration !== Boolean(segment.narration)) throw new Error(`segment ${segment.id} 的声音模式与 narration 不一致`);
    if (segment.narration) narrationCount += 1;
    if (segment.audio.mode === "narration-only" && segment.audio.source_gain_db !== 0) throw new Error(`segment ${segment.id} narration-only 时 source_gain_db 必须为 0`);
    if (selection.spoken_content && !selection.transcript_segment_ids.length) throw new Error(`segment ${segment.id} 标记 spoken_content 却没有 transcript segment`);
    for (const transcriptId of selection.transcript_segment_ids) {
      const transcriptSegment = transcript?.byId.get(transcriptId);
      if (!transcriptSegment) throw new Error(`segment ${segment.id} 引用了不存在的 transcript segment：${transcriptId}`);
      if (transcriptSegment.end_seconds <= selection.start_seconds || transcriptSegment.start_seconds >= selection.end_seconds) {
        throw new Error(`segment ${segment.id} 的 transcript segment 不在 selection 范围内：${transcriptId}`);
      }
    }
    for (const caption of segment.captions) {
      if (captionIds.has(caption.id)) throw new Error(`caption id 重复：${caption.id}`);
      captionIds.add(caption.id);
      if (!(caption.end_ratio > caption.start_ratio)) throw new Error(`caption ${caption.id} 的比例时间无效`);
      if (caption.source_kind === "narration" && (!segment.narration || caption.source_segment_ids.length !== 0)) {
        throw new Error(`caption ${caption.id} 的 narration 来源由 materialize 绑定，authoring 中 source_segment_ids 必须为空`);
      }
      if (caption.source_kind === "transcript") {
        if (!caption.source_segment_ids.length) throw new Error(`caption ${caption.id} 缺少 transcript 来源`);
        for (const id of caption.source_segment_ids) if (!selection.transcript_segment_ids.includes(id)) throw new Error(`caption ${caption.id} 引用 selection 外 transcript：${id}`);
      }
    }
  }
  const ordered = [...authoring.segments].sort((a, b) => a.order - b.order);
  ordered.forEach((segment, index) => { if (segment.order !== index + 1) throw new Error("authoring segment order 必须从 1 连续递增"); });
  if (narrationCount < 1) throw new Error("素材解说型视频至少需要一个实际旁白片段");
  for (const id of authoring.integrated_sample.segment_ids) if (!ids.has(id)) throw new Error(`integrated sample 引用了未知 segment：${id}`);
  if (options.requireReviewedTranscript && ordered.some((item) => item.selection.spoken_content || item.audio.mode === "source-only")) {
    if (!transcript || transcript.document.review.status !== "passed" || transcript.document.review.listened !== true) {
      throw new Error("采用人物原声或 spoken selection 前，transcript 必须由用户完整听音确认");
    }
  }
  let music = null;
  if (authoring.background_music) {
    music = sources.byId.get(authoring.background_music.source_id);
    if (!music || music.media_type !== "audio") throw new Error("background_music.source_id 必须指向 audio source");
    if (!["confirmed", "not-required"].includes(music.rights?.status)) throw new Error("背景音乐权利状态尚未收口");
    if (options.ffprobe) {
      const probe = probeMedia(options.ffprobe, projectPath(projectRoot, music.file, "background music"));
      if (!probe.has_audio || !(probe.duration_seconds > 0)) throw new Error("背景音乐没有可解码音轨");
      music = {...music, duration_seconds: probe.duration_seconds};
    }
  }
  let voice = null;
  if (options.environment) {
    voice = resolveVoiceReference(options.environment, authoring.voice.voice_id);
    if (voice.validation?.manual_voice_review !== "passed") throw new Error(`声音 ${voice.id} 尚未完成人工声音审核`);
  }
  return {projectRoot, authoringPath, authoring, analysisPath, analysis, sources, transcript, source, music, voice};
}

export function confirmSourceVideoCommentaryAuthoring(options) {
  if (options.confirmedBy !== "user") throw new Error("完整解说稿、选段和声音选择必须记录 confirmed-by=user");
  if (!options.evidence) throw new Error("authoring 确认必须提供 evidence");
  const environment = loadLocalMediaEnvironment(options.localConfig || null);
  const ffprobe = commandPath("ffprobe", options.ffprobe || environment.providers.local.ffprobe, "FFPROBE_BIN");
  const context = validateSourceVideoCommentaryAuthoring({...options, environment, ffprobe, requireReviewedTranscript: true});
  const confirmation = {
    protocol: "visual-multimedia-source-video-commentary-authoring-confirmation",
    version: 1,
    project_id: context.authoring.project_id,
    profile: PROFILE,
    authoring: relativeProjectPath(context.projectRoot, context.authoringPath),
    authoring_sha256: sha256File(context.authoringPath),
    confirmed_by: "user",
    confirmed_at: nowIso(),
    evidence: options.evidence,
  };
  const output = projectPath(context.projectRoot, options.confirmation || AUTHORING_CONFIRMATION_RELATIVE, "authoring confirmation");
  writeNewOrSameJson(output, confirmation, AUTHORING_CONFIRMATION_SCHEMA, "source video commentary authoring confirmation");
  return {status: "approved", confirmation: output, authoring_sha256: confirmation.authoring_sha256, voice: context.voice.id};
}

function assertAuthoringConfirmation(projectRoot, authoringRelative = AUTHORING_RELATIVE, confirmationRelative = AUTHORING_CONFIRMATION_RELATIVE, options = {}) {
  const authoringPath = projectPath(projectRoot, authoringRelative, "authoring");
  const confirmationPath = projectPath(projectRoot, confirmationRelative, "authoring confirmation");
  ensureFile(confirmationPath, "authoring confirmation");
  const confirmation = readJson(confirmationPath);
  assertJsonSchema(confirmation, AUTHORING_CONFIRMATION_SCHEMA, "authoring confirmation");
  if (confirmation.authoring !== relativeProjectPath(projectRoot, authoringPath) || confirmation.authoring_sha256 !== sha256File(authoringPath)) {
    throw new Error("authoring confirmation 没有绑定当前 authoring");
  }
  const context = validateSourceVideoCommentaryAuthoring({project: projectRoot, authoring: authoringRelative, ...options});
  return {...context, confirmationPath, confirmation};
}

function vttTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function narrationCandidateReuse(projectRoot, candidatesPath, authoringSha) {
  if (!fs.existsSync(candidatesPath)) return null;
  const document = readJson(candidatesPath);
  assertJsonSchema(document, NARRATION_CANDIDATES_SCHEMA, "existing narration candidates");
  if (document.authoring_sha256 !== authoringSha) throw new Error("现有 narration candidates 绑定另一版 authoring");
  const sources = mediaSources(projectRoot);
  for (const item of document.segments) {
    const source = sources.byId.get(item.audio_source_id);
    if (!source || source.integrity.sha256 !== item.audio_sha256) throw new Error(`现有 narration candidate 素材失效：${item.id}`);
    if (sha256File(projectPath(projectRoot, item.timing_file, "narration timing")) !== item.timing_sha256) throw new Error(`现有 narration timing 失效：${item.id}`);
  }
  return document;
}

export function synthesizeSourceVideoCommentaryNarration(options) {
  const projectRoot = path.resolve(options.project);
  const environment = loadLocalMediaEnvironment(options.localConfig || null);
  const ffprobe = commandPath("ffprobe", options.ffprobe || environment.providers.local.ffprobe, "FFPROBE_BIN");
  const context = assertAuthoringConfirmation(projectRoot, options.authoring || AUTHORING_RELATIVE, options.confirmation || AUTHORING_CONFIRMATION_RELATIVE, {environment, ffprobe, requireReviewedTranscript: true});
  const candidatesPath = projectPath(projectRoot, options.output || NARRATION_CANDIDATES_RELATIVE, "narration candidates");
  const reused = narrationCandidateReuse(projectRoot, candidatesPath, context.confirmation.authoring_sha256);
  if (reused) return {created: false, reused: true, candidates: candidatesPath, segments: reused.segments.length};

  const operation = mediaFlowProDescribeOperation(environment, "speech.synthesize");
  if (operation.name !== "speech.synthesize") throw new Error("MediaFlow Pro 没有提供精确语音合成合同");
  const runtime = mediaFlowProExecute(environment, null, "runtime.inspect", {});
  const capability = (runtime.capabilities || []).find((item) => item.id === "gpt-sovits-v2pro");
  if (capability?.status !== "ready") throw new Error(`GPT-SoVITS v2Pro 未就绪：${capability?.reason || "没有运行时状态"}`);
  const voice = context.voice || resolveVoiceReference(environment, context.authoring.voice.voice_id);
  if (voice.validation?.manual_voice_review !== "passed") throw new Error(`声音 ${voice.id} 尚未完成人工声音审核`);
  const narrationSegments = context.authoring.segments.filter((item) => item.narration);
  const candidateSegments = [];
  for (const segment of narrationSegments) {
    const narrationId = `narration-${segment.id}`;
    const text = segment.narration.text.trim();
    const textSha = sha256Text(text);
    const key = sha256Text(`${context.confirmation.authoring_sha256}\0${voice.reference_audio_sha256}\0${context.authoring.voice.speed_factor}\0${narrationId}`).slice(0, 20);
    const textPath = projectPath(projectRoot, `working/source-video-commentary/narration/${narrationId}.${key}.txt`, "narration text");
    const wavPath = projectPath(projectRoot, `working/source-video-commentary/narration/${narrationId}.${key}.wav`, "narration wav");
    const receiptPath = projectPath(projectRoot, `reports/source-video-commentary-speech/${narrationId}.${key}.json`, "narration receipt");
    const timingPath = projectPath(projectRoot, `timings/source-video-commentary/${narrationId}.${key}.vtt`, "narration timing");
    fs.mkdirSync(path.dirname(textPath), {recursive: true});
    fs.mkdirSync(path.dirname(receiptPath), {recursive: true});
    fs.mkdirSync(path.dirname(timingPath), {recursive: true});
    if (fs.existsSync(textPath) && fs.readFileSync(textPath, "utf8") !== `${text}\n`) throw new Error(`旁白文本路径发生内容冲突：${textPath}`);
    if (!fs.existsSync(textPath)) fs.writeFileSync(textPath, `${text}\n`, {encoding: "utf8", flag: "wx"});

    let result;
    if (fs.existsSync(receiptPath)) {
      result = readJson(receiptPath);
      ensureFile(wavPath, "reused narration wav");
      if (result.output_sha256 !== sha256File(wavPath)) throw new Error(`旁白回执与 WAV 不一致：${narrationId}`);
    } else {
      result = mediaFlowProExecute(environment, null, "speech.synthesize", {
        text,
        text_language: context.authoring.voice.language,
        reference_audio: voice.reference_audio,
        reference_text: voice.reference_text,
        reference_language: voice.reference_language,
        output_path: wavPath,
        auxiliary_reference_audio: [],
        speed_factor: context.authoring.voice.speed_factor,
        seed: -1,
        timeout_seconds: integer(options.timeoutSeconds, "timeout-seconds", 900),
        overwrite: false,
      });
      if (result.reference_audio_sha256 !== voice.reference_audio_sha256) throw new Error(`旁白 ${narrationId} 使用了错误参考声音`);
      writeJson(receiptPath, result);
    }
    const actual = probeMedia(ffprobe, wavPath);
    if (!actual.has_audio || Math.abs(actual.duration_seconds - result.duration_seconds) > 0.08) throw new Error(`旁白 ${narrationId} 的真实时长与合成回执不一致`);
    const vtt = `WEBVTT\n\n${vttTime(0)} --> ${vttTime(result.duration_seconds)}\n${text}\n`;
    if (fs.existsSync(timingPath) && fs.readFileSync(timingPath, "utf8") !== vtt) throw new Error(`旁白 timing 已存在且不同：${narrationId}`);
    if (!fs.existsSync(timingPath)) fs.writeFileSync(timingPath, vtt, {encoding: "utf8", flag: "wx"});
    const audioSourceId = `${narrationId}-${result.output_sha256.slice(0, 12)}`;
    importAsset({
      project: projectRoot,
      input: wavPath,
      id: audioSourceId,
      mediaType: "audio",
      method: "generated-in-project",
      rightsStatus: "confirmed",
      license: `用户确认采用本机注册声音 ${voice.id}；${context.confirmation.evidence}`,
      usage: `素材解说旁白 ${narrationId}`,
      provider: "mediaflow-gpt-sovits-v2pro",
      capture: receiptPath,
      generationModel: result.engine_version,
      generationPrompt: `confirmed narration text sha256=${textSha}`,
      generationSeed: "-1",
      voiceId: voice.id,
      voiceName: voice.display_name,
      language: context.authoring.voice.language,
      speechText: textPath,
      exactVoice: true,
      notes: `speed_factor=${context.authoring.voice.speed_factor}; device=${result.device}`,
    });
    candidateSegments.push({
      id: narrationId,
      title: segment.narration.title,
      text,
      text_sha256: textSha,
      audio_source_id: audioSourceId,
      audio_sha256: result.output_sha256,
      timing_file: relativeProjectPath(projectRoot, timingPath),
      timing_sha256: sha256File(timingPath),
      duration_seconds: result.duration_seconds,
      provider_receipt: binding(projectRoot, relativeProjectPath(projectRoot, receiptPath)),
    });
  }
  const candidates = {
    protocol: "visual-multimedia-source-video-commentary-narration-candidates",
    version: 1,
    project_id: context.authoring.project_id,
    profile: PROFILE,
    authoring: relativeProjectPath(projectRoot, context.authoringPath),
    authoring_sha256: context.confirmation.authoring_sha256,
    media_sources: "media-sources.json",
    language: context.authoring.voice.language,
    voice: {
      kind: "synthetic",
      provider: "mediaflow-gpt-sovits-v2pro",
      provider_voice_id: voice.id,
      voice_name: voice.display_name,
      parameters: {speed_factor: context.authoring.voice.speed_factor, engine: "gpt-sovits-v2pro"},
      reference_audio_sha256: voice.reference_audio_sha256,
    },
    segments: candidateSegments,
    created_at: nowIso(),
  };
  writeNewOrSameJson(candidatesPath, candidates, NARRATION_CANDIDATES_SCHEMA, "source video commentary narration candidates");
  return {created: true, reused: false, candidates: candidatesPath, segments: candidateSegments.length, voice: voice.id};
}

export function confirmSourceVideoCommentaryNarration(options) {
  const projectRoot = path.resolve(options.project);
  if (options.confirmedBy !== "user") throw new Error("旁白完整试听必须记录 confirmed-by=user");
  if (!options.evidence) throw new Error("旁白完整试听必须提供 evidence");
  const candidatesPath = projectPath(projectRoot, options.candidates || NARRATION_CANDIDATES_RELATIVE, "narration candidates");
  const candidates = readJson(candidatesPath);
  assertJsonSchema(candidates, NARRATION_CANDIDATES_SCHEMA, "narration candidates");
  const context = assertAuthoringConfirmation(projectRoot, candidates.authoring, options.confirmation || AUTHORING_CONFIRMATION_RELATIVE);
  if (candidates.authoring_sha256 !== context.confirmation.authoring_sha256) throw new Error("narration candidates 没有绑定当前 authoring");
  const sources = mediaSources(projectRoot);
  const bundle = {
    protocol: "visual-multimedia-narration-bundle",
    version: 1,
    media_sources: candidates.media_sources,
    language: candidates.language,
    segments: candidates.segments.map((item) => {
      const source = sources.byId.get(item.audio_source_id);
      if (!source || source.integrity.sha256 !== item.audio_sha256) throw new Error(`旁白素材账本失效：${item.id}`);
      if (sha256File(projectPath(projectRoot, item.timing_file, "narration timing")) !== item.timing_sha256) throw new Error(`旁白 timing 失效：${item.id}`);
      return {
        id: item.id,
        title: item.title,
        text: item.text,
        text_sha256: item.text_sha256,
        audio_source_id: item.audio_source_id,
        audio_sha256: item.audio_sha256,
        timing_file: item.timing_file,
        timing_sha256: item.timing_sha256,
        duration_seconds: item.duration_seconds,
        voice: {
          kind: candidates.voice.kind,
          provider: candidates.voice.provider,
          provider_voice_id: candidates.voice.provider_voice_id,
          voice_name: candidates.voice.voice_name,
          parameters: {...candidates.voice.parameters, reference_audio_sha256: candidates.voice.reference_audio_sha256},
        },
        review: {listened: true, text_matches_audio: true, natural_speed: true, notes: options.evidence},
      };
    }),
  };
  const output = projectPath(projectRoot, options.output || NARRATION_BUNDLE_RELATIVE, "narration bundle");
  assertJsonSchema(bundle, NARRATION_SCHEMA, "reviewed narration bundle");
  writeProjectArtifact(output, `${JSON.stringify(bundle, null, 2)}\n`, "narration-bundle.json");
  return {status: "passed", narration_bundle: output, segments: bundle.segments.length, sha256: sha256File(output)};
}

function captionsForSegment(authoringSegment, narration, transcript, duration, language) {
  if (authoringSegment.captions.length) {
    return authoringSegment.captions.map((caption) => ({
      id: caption.id,
      start_offset_seconds: caption.start_ratio * duration,
      end_offset_seconds: caption.end_ratio * duration,
      text: caption.text,
      language: caption.language,
      source_kind: caption.source_kind,
      source_segment_ids: caption.source_kind === "narration" ? [narration.id] : caption.source_segment_ids,
    }));
  }
  if (narration) {
    return [{
      id: `${authoringSegment.id}-caption-01`,
      start_offset_seconds: 0,
      end_offset_seconds: duration,
      text: narration.text,
      language,
      source_kind: "narration",
      source_segment_ids: [narration.id],
    }];
  }
  const selection = authoringSegment.selection;
  return selection.transcript_segment_ids.map((id, index) => {
    const source = transcript.byId.get(id);
    const start = Math.max(selection.start_seconds, source.start_seconds) - selection.start_seconds;
    const end = Math.min(selection.end_seconds, source.end_seconds) - selection.start_seconds;
    return {
      id: `${authoringSegment.id}-caption-${String(index + 1).padStart(2, "0")}`,
      start_offset_seconds: start,
      end_offset_seconds: end,
      text: source.text,
      language: transcript.document.language,
      source_kind: "transcript",
      source_segment_ids: [id],
    };
  });
}

export function materializeSourceVideoCommentary(options) {
  const projectRoot = path.resolve(options.project);
  const environment = loadLocalMediaEnvironment(options.localConfig || null);
  const ffprobe = commandPath("ffprobe", options.ffprobe || environment.providers.local.ffprobe, "FFPROBE_BIN");
  const context = assertAuthoringConfirmation(projectRoot, options.authoring || AUTHORING_RELATIVE, options.confirmation || AUTHORING_CONFIRMATION_RELATIVE, {environment, ffprobe, requireReviewedTranscript: true});
  const bundlePath = projectPath(projectRoot, options.narrationBundle || NARRATION_BUNDLE_RELATIVE, "narration bundle");
  const bundle = readJson(bundlePath);
  assertJsonSchema(bundle, NARRATION_SCHEMA, "reviewed narration bundle");
  const narrationByText = new Map(bundle.segments.map((item) => [item.text_sha256, item]));
  const transcript = context.transcript;

  const scriptLines = [
    "# 素材解说完整稿",
    "",
    `目标观众：${context.authoring.target.audience}`,
    `解说角度：${context.authoring.target.editorial_angle}`,
    `观看结果：${context.authoring.target.audience_outcome}`,
    "",
    ...context.authoring.segments.flatMap((segment) => [
      `## ${segment.order}. ${segment.purpose}`,
      "",
      segment.narration ? segment.narration.text.trim() : "（本段保留已经复核的源片原声，不添加旁白。）",
      "",
    ]),
  ];
  const scriptPath = projectPath(projectRoot, options.script || SCRIPT_RELATIVE, "commentary script");
  writeProjectArtifact(scriptPath, `${scriptLines.join("\n")}\n`, "source-video-commentary-script.md");

  const clips = {
    protocol: "visual-multimedia-clip-selections",
    version: 2,
    media_sources: "media-sources.json",
    transcript: transcript ? relativeProjectPath(projectRoot, transcript.file) : null,
    maximum_clips: Math.max(8, context.authoring.segments.length),
    clips: context.authoring.segments.map((segment) => ({
      id: `clip-${segment.id}`,
      source_id: segment.selection.source_id,
      start_seconds: segment.selection.start_seconds,
      end_seconds: segment.selection.end_seconds,
      purpose: segment.purpose,
      spoken_content: segment.selection.spoken_content,
      transcript_segment_ids: segment.selection.transcript_segment_ids,
      semantic_boundary_review: {
        status: "passed",
        listened: true,
        waveform_checked: true,
        notes: `已随 authoring 由用户确认：${context.confirmation.evidence}`,
      },
      intentional_repeat_reason: segment.selection.intentional_repeat_reason,
    })),
  };
  const clipsPath = path.join(projectRoot, "clip-selections.json");
  const clipsPayload = `${JSON.stringify(clips, null, 2)}\n`;
  if (fs.existsSync(clipsPath) && fs.readFileSync(clipsPath, "utf8") !== clipsPayload) {
    const existing = readJson(clipsPath);
    if ((existing.clips || []).length) throw new Error("clip-selections.json 已经包含其它正式选段，拒绝覆盖");
  }
  fs.writeFileSync(clipsPath, clipsPayload, "utf8");

  const draftSegments = context.authoring.segments.map((segment) => {
    const narration = segment.narration ? narrationByText.get(sha256Text(segment.narration.text.trim())) : null;
    if (segment.narration && !narration) throw new Error(`segment ${segment.id} 找不到与确认文本相同的已试听旁白`);
    const duration = narration?.duration_seconds ?? (segment.selection.end_seconds - segment.selection.start_seconds);
    const captions = context.authoring.target.caption_mode === "none"
      ? []
      : captionsForSegment(segment, narration, transcript, duration, context.authoring.voice.language);
    return {
      id: segment.id,
      order: segment.order,
      purpose: segment.purpose,
      visual_role: segment.visual_role,
      visual: {
        kind: "source-clip",
        clip_selection_id: `clip-${segment.id}`,
        fit: segment.selection.fit,
        freeze_when_shorter: segment.selection.freeze_when_shorter,
      },
      narration_segment_id: narration?.id ?? null,
      audio: segment.audio,
      captions,
    };
  });
  const draft = {
    protocol: "visual-multimedia-source-video-commentary-draft",
    version: 1,
    project_id: context.authoring.project_id,
    profile: PROFILE,
    target: context.authoring.target,
    script: {
      file: relativeProjectPath(projectRoot, scriptPath),
      sha256: sha256File(scriptPath),
      confirmed_by: "user",
      confirmed_at: context.confirmation.confirmed_at,
      confirmation_evidence: context.confirmation.evidence,
    },
    contracts: {
      media_sources: "media-sources.json",
      transcript: transcript ? relativeProjectPath(projectRoot, transcript.file) : null,
      clip_selections: "clip-selections.json",
      narration_bundle: relativeProjectPath(projectRoot, bundlePath),
      video_direction_plan: null,
    },
    background_music: context.authoring.background_music,
    integrated_sample: context.authoring.integrated_sample,
    segments: draftSegments,
  };
  assertJsonSchema(draft, DRAFT_SCHEMA, "materialized source video commentary draft");
  const draftPath = projectPath(projectRoot, options.draft || DRAFT_RELATIVE, "source video commentary draft");
  writeProjectArtifact(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "source-video-commentary-draft.json");
  return {
    project: projectRoot,
    script: scriptPath,
    clip_selections: clipsPath,
    narration_bundle: bundlePath,
    draft: draftPath,
    segments: draftSegments.length,
    background_music: draft.background_music?.source_id || null,
  };
}

export const SOURCE_VIDEO_COMMENTARY_PREPRODUCTION_PATHS = {
  analysis: ANALYSIS_RELATIVE,
  authoring: AUTHORING_RELATIVE,
  authoringConfirmation: AUTHORING_CONFIRMATION_RELATIVE,
  narrationCandidates: NARRATION_CANDIDATES_RELATIVE,
  narrationBundle: NARRATION_BUNDLE_RELATIVE,
};
