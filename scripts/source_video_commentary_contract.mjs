import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  ensureFile,
  hashPath,
  nowIso,
  probeMedia,
  projectPath,
  readJson,
  relativeProjectPath,
  run,
  sha256File,
  writeJson,
} from "./interview_explainer_common.mjs";
import {createMediaBuildPlan, fileDependency} from "./media_build_contract.mjs";
import {
  assertStageApproved,
  createProjectState,
  decideStage,
  submitStage,
  validateProjectState,
} from "./media_project_state.mjs";
import {validateMediaSources} from "./validate-media-sources.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
export const PROFILE = "source-video-commentary@1.0.0";
export const PROFILE_RELATIVE = "contracts/source-video-commentary-profile.json";
export const DRAFT_RELATIVE = "source-video-commentary-draft.json";
export const PLAN_RELATIVE = "source-video-commentary-plan.json";
export const CONFIRMATION_RELATIVE = "source-video-commentary-plan-confirmation.json";
export const TIMELINE_RELATIVE = "media-timeline.json";
export const BUILD_PLAN_RELATIVE = "media-build-plan.json";

const PROFILE_SOURCE = path.join(SKILL_ROOT, "assets", "video-production-profiles", "source-video-commentary", "1.0.0", "profile.json");
const MEDIA_STARTER = path.join(SKILL_ROOT, "assets", "media-project-starter");
const COMMENTARY_STARTER = path.join(SKILL_ROOT, "assets", "source-video-commentary-starter");
const DRAFT_SCHEMA = path.join(SKILL_ROOT, "schemas", "source-video-commentary-draft.v1.schema.json");
const PLAN_SCHEMA = path.join(SKILL_ROOT, "schemas", "source-video-commentary-plan.v1.schema.json");
const CONFIRMATION_SCHEMA = path.join(SKILL_ROOT, "schemas", "source-video-commentary-plan-confirmation.v1.schema.json");
const NARRATION_SCHEMA = path.join(SKILL_ROOT, "schemas", "narration-bundle.v1.schema.json");
const TRANSCRIPT_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-transcript.v1.schema.json");
const DIRECTION_SCHEMA = path.join(SKILL_ROOT, "schemas", "video-direction-plan.v2.schema.json");
const CLIP_VALIDATOR = path.join(SCRIPT_DIR, "validate-clip-selections.mjs");

function requireProjectId(value) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(value || "")) {
    throw new Error("project-id 只能使用小写字母、数字、点、下划线和连字符");
  }
  return value;
}

function unique(items, selector, label) {
  const values = items.map(selector);
  if (new Set(values).size !== values.length) throw new Error(`${label} 不能重复`);
}

function binding(projectRoot, relative, label, schema = null) {
  const absolute = projectPath(projectRoot, relative, label);
  ensureFile(absolute, label);
  const document = schema ? readJson(absolute) : null;
  if (schema) assertJsonSchema(document, schema, label);
  return {file: relativeProjectPath(projectRoot, absolute), absolute, sha256: sha256File(absolute), document};
}

function validateClipSelections(projectRoot, relative, ffprobe) {
  const absolute = projectPath(projectRoot, relative, "clip selections");
  const args = [CLIP_VALIDATOR, absolute, "--json"];
  if (ffprobe) args.push("--ffprobe", ffprobe);
  const result = run(process.execPath, args, {cwd: SKILL_ROOT});
  return {absolute, document: readJson(absolute), validation: JSON.parse(result.stdout)};
}

function stateAt(projectRoot) {
  const statePath = path.join(projectRoot, "media-project-state.json");
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  return {statePath, state: readJson(statePath), validation};
}

function writeValidState(statePath, state) {
  writeJson(statePath, state);
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  return validation;
}

function copyStarter(source, destination) {
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (fs.existsSync(to)) throw new Error(`拒绝覆盖已有项目文件：${to}`);
    fs.cpSync(from, to, {recursive: true, errorOnExist: true, force: false});
  }
}

export function createSourceVideoCommentaryProject(options) {
  const projectRoot = path.resolve(options.project);
  const projectId = requireProjectId(options.projectId);
  if (fs.existsSync(projectRoot) && fs.readdirSync(projectRoot).length > 0) {
    throw new Error(`项目目录必须不存在或为空，拒绝合并覆盖：${projectRoot}`);
  }
  fs.mkdirSync(projectRoot, {recursive: true});
  copyStarter(MEDIA_STARTER, projectRoot);
  copyStarter(COMMENTARY_STARTER, projectRoot);
  const profileTarget = projectPath(projectRoot, PROFILE_RELATIVE, "profile snapshot");
  fs.mkdirSync(path.dirname(profileTarget), {recursive: true});
  fs.copyFileSync(PROFILE_SOURCE, profileTarget, fs.constants.COPYFILE_EXCL);

  const draftPath = path.join(projectRoot, DRAFT_RELATIVE);
  const draft = readJson(draftPath);
  draft.project_id = projectId;
  writeJson(draftPath, draft);
  const state = createProjectState({projectId, mediaKind: "mixed-video", profile: PROFILE});
  writeJson(path.join(projectRoot, "media-project-state.json"), state);
  const stateValidation = validateProjectState(path.join(projectRoot, "media-project-state.json"));
  if (!stateValidation.ok) throw new Error(`新项目状态未通过：\n- ${stateValidation.errors.join("\n- ")}`);
  return {
    project: projectRoot,
    project_id: projectId,
    draft: draftPath,
    profile: profileTarget,
    next_action: "补齐素材账本、转写、片段选择、完整解说稿和试听通过的旁白包，再运行 validate。",
  };
}

export function migrateSourceVideoCommentaryProfile(options) {
  const projectRoot = path.resolve(options.project);
  const {state} = stateAt(projectRoot);
  if (state.profile !== PROFILE) {
    throw new Error(`只能迁移 ${PROFILE} 项目；当前项目是 ${state.profile || "未声明 profile"}`);
  }
  const startedStage = state.stages.find((stage) =>
    !["ready", "blocked"].includes(stage.status)
    || stage.artifact_ids.length > 0
    || stage.submitted_at !== null
    || stage.approval !== null
    || stage.invalidation !== null,
  );
  if (startedStage || state.artifacts.length > 0 || state.production_decisions.length > 0) {
    throw new Error(`项目已经进入正式五阶段生产，不能迁移 profile；最早受影响阶段是 ${startedStage?.id || state.current_stage}`);
  }
  for (const relative of [PLAN_RELATIVE, CONFIRMATION_RELATIVE, TIMELINE_RELATIVE, BUILD_PLAN_RELATIVE]) {
    if (fs.existsSync(path.join(projectRoot, relative))) {
      throw new Error(`项目已经生成 ${relative}，不能迁移 profile`);
    }
  }

  const profileTarget = projectPath(projectRoot, PROFILE_RELATIVE, "profile snapshot");
  ensureFile(profileTarget, "profile snapshot");
  const previousSha256 = sha256File(profileTarget);
  const currentSha256 = sha256File(PROFILE_SOURCE);
  if (previousSha256 === currentSha256) {
    return {
      project: projectRoot,
      status: "current",
      profile: relativeProjectPath(projectRoot, profileTarget),
      sha256: currentSha256,
      archive: null,
    };
  }

  const timestamp = nowIso().replace(/[:.]/gu, "-");
  const archiveTarget = path.join(
    projectRoot,
    "archive",
    "profile-migrations",
    `${timestamp}-${previousSha256.slice(0, 12)}`,
    path.basename(PROFILE_RELATIVE),
  );
  fs.mkdirSync(path.dirname(archiveTarget), {recursive: true});
  fs.renameSync(profileTarget, archiveTarget);
  try {
    fs.copyFileSync(PROFILE_SOURCE, profileTarget, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    fs.renameSync(archiveTarget, profileTarget);
    throw error;
  }
  return {
    project: projectRoot,
    status: "migrated",
    profile: relativeProjectPath(projectRoot, profileTarget),
    previous_sha256: previousSha256,
    sha256: currentSha256,
    archive: relativeProjectPath(projectRoot, archiveTarget),
  };
}

function narrationMap(projectRoot, relative) {
  const loaded = binding(projectRoot, relative, "narration bundle", NARRATION_SCHEMA);
  return {...loaded, byId: new Map(loaded.document.segments.map((item) => [item.id, item]))};
}

function transcriptMap(projectRoot, relative) {
  if (relative == null) return null;
  const loaded = binding(projectRoot, relative, "transcript", TRANSCRIPT_SCHEMA);
  if (loaded.document.review.status !== "passed" || loaded.document.review.listened !== true) {
    throw new Error("source-video-commentary 引用的 transcript 必须已经真实听音并标记 passed");
  }
  return {...loaded, byId: new Map(loaded.document.segments.map((item) => [item.id, item]))};
}

function mediaSourceMap(projectRoot, relative, ffprobe) {
  const absolute = projectPath(projectRoot, relative, "media sources");
  const validation = validateMediaSources(absolute, {ffprobe});
  if (!validation.ok) throw new Error(`素材账本未通过：\n- ${validation.errors.join("\n- ")}`);
  const document = readJson(absolute);
  return {
    absolute,
    file: relativeProjectPath(projectRoot, absolute),
    sha256: sha256File(absolute),
    document,
    byId: new Map(document.sources.map((item) => [item.id, item])),
  };
}

function assertSourceAudio(projectRoot, source, ffprobe, segmentId) {
  const media = probeMedia(ffprobe, projectPath(projectRoot, source.file, `segment ${segmentId} source media`));
  if (!media.has_audio) throw new Error(`segment ${segmentId} 声明使用源声，但素材 ${source.id} 没有音轨`);
}

export function validateSourceVideoCommentaryDraft(options) {
  const projectRoot = path.resolve(options.project);
  const draftRelative = options.draft || DRAFT_RELATIVE;
  const draftBinding = binding(projectRoot, draftRelative, "source video commentary draft", DRAFT_SCHEMA);
  const draft = draftBinding.document;
  const {state} = stateAt(projectRoot);
  if (draft.project_id !== state.project_id || draft.profile !== PROFILE || state.profile !== PROFILE) {
    throw new Error("draft、媒体项目状态与 source-video-commentary profile 身份不一致");
  }
  const profile = binding(projectRoot, PROFILE_RELATIVE, "profile snapshot");
  if (profile.sha256 !== sha256File(PROFILE_SOURCE)) throw new Error("项目中的 profile snapshot 已过期；请新建项目或明确迁移");
  const script = binding(projectRoot, draft.script.file, "confirmed commentary script");
  if (script.sha256 !== draft.script.sha256) throw new Error("完整解说稿哈希与 draft 中的确认记录不一致");
  const sources = mediaSourceMap(projectRoot, draft.contracts.media_sources, options.ffprobe);
  const clips = validateClipSelections(projectRoot, draft.contracts.clip_selections, options.ffprobe);
  const clipById = new Map(clips.document.clips.map((item) => [item.id, item]));
  const narration = narrationMap(projectRoot, draft.contracts.narration_bundle);
  const transcript = transcriptMap(projectRoot, draft.contracts.transcript);
  const direction = draft.contracts.video_direction_plan == null
    ? null
    : binding(projectRoot, draft.contracts.video_direction_plan, "video direction plan", DIRECTION_SCHEMA);
  let backgroundMusic = null;
  if (draft.background_music) {
    const source = sources.byId.get(draft.background_music.source_id);
    if (!source || source.media_type !== "audio") {
      throw new Error("background_music.source_id 必须指向素材账本中的 audio source");
    }
    if (!new Set(["confirmed", "not-required"]).has(source.rights?.status)) {
      throw new Error("background_music 的权利状态尚未收口");
    }
    const audio = sourceBinding(projectRoot, source, "background music");
    const media = probeMedia(options.ffprobe, projectPath(projectRoot, source.file, "background music"));
    if (!media.has_audio || !(media.duration_seconds > 0)) throw new Error("background_music 没有可解码的真实音轨");
    backgroundMusic = {source, audio, duration_seconds: media.duration_seconds};
  }

  unique(draft.segments, (item) => item.id, "segment id");
  unique(draft.segments, (item) => item.order, "segment order");
  unique(draft.segments.flatMap((item) => item.captions), (item) => item.id, "caption id");
  for (const [index, segment] of [...draft.segments].sort((a, b) => a.order - b.order).entries()) {
    if (segment.order !== index + 1) throw new Error("segment order 必须从 1 连续递增");
  }
  const segmentIds = new Set(draft.segments.map((item) => item.id));
  for (const id of draft.integrated_sample.segment_ids) {
    if (!segmentIds.has(id)) throw new Error(`integrated sample 引用了不存在的 segment：${id}`);
  }

  const ffprobe = options.ffprobe;
  if (!ffprobe) throw new Error("validate 必须提供可用 ffprobe，或由公开入口从本机配置解析");
  for (const item of narration.document.segments) {
    const textSha = crypto.createHash("sha256").update(item.text, "utf8").digest("hex");
    if (textSha !== item.text_sha256) throw new Error(`narration ${item.id} 的文本哈希不一致`);
    const audioSource = sources.byId.get(item.audio_source_id);
    if (!audioSource || audioSource.media_type !== "audio") throw new Error(`narration ${item.id} 没有绑定素材账本中的 audio source`);
    const audioFile = projectPath(projectRoot, audioSource.file, `narration ${item.id} audio`);
    if (sha256File(audioFile) !== item.audio_sha256 || item.audio_sha256 !== audioSource.integrity?.sha256) {
      throw new Error(`narration ${item.id} 的音频哈希与旁白包或素材账本不一致`);
    }
    const timingFile = projectPath(projectRoot, item.timing_file, `narration ${item.id} timing`);
    ensureFile(timingFile, `narration ${item.id} timing`);
    if (sha256File(timingFile) !== item.timing_sha256) throw new Error(`narration ${item.id} 的 timing 哈希不一致`);
    const audioProbe = probeMedia(ffprobe, audioFile);
    if (!audioProbe.has_audio || Math.abs(audioProbe.duration_seconds - item.duration_seconds) > 0.08) {
      throw new Error(`narration ${item.id} 的实际音频时长与旁白包不一致`);
    }
  }
  for (const segment of draft.segments) {
    const needsNarration = segment.audio.mode !== "source-only";
    if (needsNarration !== Boolean(segment.narration_segment_id)) {
      throw new Error(`segment ${segment.id} 的 ${segment.audio.mode} 与 narration_segment_id 不一致`);
    }
    if (segment.audio.mode === "narration-only" && segment.audio.source_gain_db !== 0) {
      throw new Error(`segment ${segment.id} 使用 narration-only 时 source_gain_db 必须为 0，避免伪装成已混入源声`);
    }
    const narrationSegment = segment.narration_segment_id ? narration.byId.get(segment.narration_segment_id) : null;
    if (segment.narration_segment_id && !narrationSegment) {
      throw new Error(`segment ${segment.id} 引用了不存在的 narration segment：${segment.narration_segment_id}`);
    }
    let durationSeconds = narrationSegment?.duration_seconds ?? null;
    let selection = null;
    let source = null;
    if (segment.visual.kind !== "editable-scene") {
      selection = clipById.get(segment.visual.clip_selection_id);
      if (!selection) throw new Error(`segment ${segment.id} 引用了不存在的 clip selection：${segment.visual.clip_selection_id}`);
      source = sources.byId.get(selection.source_id);
      if (!source || source.media_type !== "video") throw new Error(`segment ${segment.id} 的画面 selection 必须来自 video source`);
      if (segment.audio.mode !== "narration-only") assertSourceAudio(projectRoot, source, ffprobe, segment.id);
      if (segment.audio.mode === "source-only") durationSeconds = selection.end_seconds - selection.start_seconds;
      if (
        segment.audio.mode !== "source-only"
        && segment.visual.kind === "source-clip"
        && segment.visual.freeze_when_shorter !== true
        && selection.end_seconds - selection.start_seconds + 1 / draft.target.fps < durationSeconds
      ) throw new Error(`segment ${segment.id} 的 selection 短于旁白且没有允许最后一帧冻结`);
    } else {
      if (segment.audio.mode !== "narration-only") {
        throw new Error(`segment ${segment.id} 的 editable-scene 没有源片声音，必须使用 narration-only`);
      }
      const packageRoot = projectPath(projectRoot, segment.visual.package, `segment ${segment.id} editable package`);
      const manifest = path.join(packageRoot, "editable-media.json");
      ensureFile(manifest, `segment ${segment.id} editable-media manifest`);
      hashPath(packageRoot);
    }
    if (!(durationSeconds > 0)) throw new Error(`segment ${segment.id} 无法从旁白或 selection 得到真实时长`);
    if (draft.target.caption_mode !== "none" && segment.captions.length === 0) {
      throw new Error(`segment ${segment.id} 没有字幕；caption_mode=${draft.target.caption_mode}`);
    }
    for (const caption of segment.captions) {
      if (caption.end_offset_seconds <= caption.start_offset_seconds || caption.end_offset_seconds > durationSeconds + 0.001) {
        throw new Error(`caption ${caption.id} 的片段内时间超出 segment ${segment.id}`);
      }
      if (caption.source_kind === "narration") {
        if (!narrationSegment || !caption.source_segment_ids.includes(narrationSegment.id)) {
          throw new Error(`caption ${caption.id} 标为 narration，但没有绑定当前 narration segment`);
        }
      }
      if (caption.source_kind === "transcript") {
        if (!transcript || caption.source_segment_ids.length === 0) {
          throw new Error(`caption ${caption.id} 标为 transcript，但项目没有已审核 transcript 引用`);
        }
        for (const id of caption.source_segment_ids) {
          if (!transcript.byId.has(id)) throw new Error(`caption ${caption.id} 引用了不存在的 transcript segment：${id}`);
          if (!selection?.transcript_segment_ids.includes(id)) {
            throw new Error(`caption ${caption.id} 的 transcript segment 不属于当前 clip selection`);
          }
        }
      }
    }
  }
  return {project: projectRoot, draft, draftBinding, profile, script, sources, clips, narration, transcript, direction, backgroundMusic};
}

export function confirmSourceVideoCommentaryContent(options) {
  const context = validateSourceVideoCommentaryDraft(options);
  const {statePath, state} = stateAt(context.project);
  state.contracts.media_sources = context.sources.file;
  state.contracts.transcript = context.transcript?.file ?? null;
  state.contracts.clip_selections = relativeProjectPath(context.project, context.clips.absolute);
  const stage = state.stages.find((item) => item.id === "content");
  if (stage.status === "approved") {
    const artifact = state.artifacts.find((item) => item.stage_id === "content" && item.role === "content-contract");
    if (!artifact || artifact.sha256 !== context.draftBinding.sha256) throw new Error("内容阶段已经确认了另一份 draft；先使阶段失效再重新提交");
    return {status: "approved", state: statePath, next_action: state.next_action};
  }
  if (stage.status !== "waiting-approval") {
    submitStage(state, context.project, "content", [{
      id: "source-video-commentary-content",
      role: "content-contract",
      kind: "document",
      file: context.draftBinding.file,
    }]);
  }
  decideStage(state, "content", "approved", options.evidence, {decidedBy: options.confirmedBy});
  const validation = writeValidState(statePath, state);
  return {status: "approved", state: statePath, next_action: validation.next_action};
}

function input(role, loaded) {
  return {role, file: loaded.file, sha256: loaded.sha256};
}

function sourceBinding(projectRoot, source, label) {
  const absolute = projectPath(projectRoot, source.file, label);
  ensureFile(absolute, label);
  const sha = sha256File(absolute);
  if (sha !== source.integrity?.sha256) throw new Error(`${label} 哈希与素材账本不一致`);
  return {file: relativeProjectPath(projectRoot, absolute), sha256: sha};
}

export function createSourceVideoCommentaryPlan(options) {
  const context = validateSourceVideoCommentaryDraft(options);
  const {statePath, state} = stateAt(context.project);
  assertStageApproved(state, "content");
  const fps = context.draft.target.fps;
  const clipById = new Map(context.clips.document.clips.map((item) => [item.id, item]));
  let timelineStart = 0;
  const segments = [...context.draft.segments].sort((a, b) => a.order - b.order).map((segment) => {
    const narration = segment.narration_segment_id ? context.narration.byId.get(segment.narration_segment_id) : null;
    const selection = segment.visual.kind === "editable-scene" ? null : clipById.get(segment.visual.clip_selection_id);
    const durationSeconds = narration?.duration_seconds ?? (selection.end_seconds - selection.start_seconds);
    const durationFrames = Math.max(1, Math.floor(durationSeconds * fps + 1e-9));
    let visual;
    if (segment.visual.kind === "editable-scene") {
      const packageRoot = projectPath(context.project, segment.visual.package, `segment ${segment.id} editable package`);
      visual = {
        ...segment.visual,
        package: relativeProjectPath(context.project, packageRoot),
        manifest_sha256: sha256File(path.join(packageRoot, "editable-media.json")),
        package_sha256: hashPath(packageRoot).sha256,
      };
    } else {
      const source = context.sources.byId.get(selection.source_id);
      visual = {
        ...segment.visual,
        source_id: source.id,
        source: sourceBinding(context.project, source, `segment ${segment.id} source`),
      };
    }
    let narrationPlan = null;
    if (narration) {
      const audioSource = context.sources.byId.get(narration.audio_source_id);
      if (!audioSource || audioSource.media_type !== "audio") throw new Error(`narration ${narration.id} 的 audio source 没有在素材账本中登记为 audio`);
      const audio = sourceBinding(context.project, audioSource, `narration ${narration.id} audio`);
      if (audio.sha256 !== narration.audio_sha256) throw new Error(`narration ${narration.id} 音频哈希与 narration bundle 不一致`);
      narrationPlan = {
        segment_id: narration.id,
        audio_source_id: narration.audio_source_id,
        audio,
        text_sha256: narration.text_sha256,
        duration_seconds: narration.duration_seconds,
      };
    }
    const captions = segment.captions.map((caption) => {
      const startOffset = Math.min(durationFrames - 1, Math.max(0, Math.round(caption.start_offset_seconds * fps)));
      const endOffset = Math.min(durationFrames, Math.max(startOffset + 1, Math.round(caption.end_offset_seconds * fps)));
      return {
        id: caption.id,
        start_frame: timelineStart + startOffset,
        end_frame: timelineStart + endOffset,
        text: caption.text,
        language: caption.language,
        source_kind: caption.source_kind,
        source_segment_ids: caption.source_segment_ids,
      };
    });
    const planned = {
      id: segment.id,
      order: segment.order,
      purpose: segment.purpose,
      visual_role: segment.visual_role,
      timeline_start_frame: timelineStart,
      duration_frames: durationFrames,
      visual,
      narration: narrationPlan,
      audio: segment.audio,
      captions,
    };
    timelineStart += durationFrames;
    return planned;
  });
  const inputs = [
    input("profile-package", context.profile),
    input("commentary-draft", context.draftBinding),
    input("confirmed-script", context.script),
    {role: "media-sources", file: context.sources.file, sha256: context.sources.sha256},
    {role: "clip-selections", file: relativeProjectPath(context.project, context.clips.absolute), sha256: sha256File(context.clips.absolute)},
    input("narration-bundle", context.narration),
  ];
  if (context.transcript) inputs.push(input("reviewed-transcript", context.transcript));
  if (context.direction) inputs.push(input("video-direction-plan", context.direction));
  const backgroundMusic = context.backgroundMusic
    ? {
      source_id: context.backgroundMusic.source.id,
      audio: context.backgroundMusic.audio,
      duration_seconds: context.backgroundMusic.duration_seconds,
      loop: context.draft.background_music.loop,
      base_gain_db: context.draft.background_music.base_gain_db,
      narration_reduction_db: context.draft.background_music.narration_reduction_db,
      source_only_reduction_db: context.draft.background_music.source_only_reduction_db,
      fade_in_seconds: context.draft.background_music.fade_in_seconds,
      fade_out_seconds: context.draft.background_music.fade_out_seconds,
    }
    : null;
  const plan = {
    protocol: "visual-multimedia-source-video-commentary-plan",
    version: 1,
    project_id: context.draft.project_id,
    profile: PROFILE,
    created_at: nowIso(),
    inputs,
    output: {
      file: "renders/source-video-commentary.mp4",
      width: context.draft.target.width,
      height: context.draft.target.height,
      fps,
      audio_sample_rate: context.draft.target.audio_sample_rate,
      audio_channels: context.draft.target.audio_channels,
      background: context.draft.target.background,
      caption_mode: context.draft.target.caption_mode,
    },
    background_music: backgroundMusic,
    integrated_sample: context.draft.integrated_sample,
    segments,
    total_frames: timelineStart,
    review_promises: [
      {id: "profile-identity", source_pointer: "/profile", promise: "成片使用用户确认的素材解说型视频 profile。", expected_value: PROFILE},
      {id: "caption-delivery-mode", source_pointer: "/output/caption_mode", promise: "字幕交付方式与已确认计划一致。", expected_value: context.draft.target.caption_mode},
      {id: "integer-frame-duration", source_pointer: "/total_frames", promise: "整片长度由已确认片段的整数帧计划唯一决定。", expected_value: timelineStart},
    ],
  };
  assertJsonSchema(plan, PLAN_SCHEMA, "source video commentary plan");
  const planPath = projectPath(context.project, options.plan || PLAN_RELATIVE, "source video commentary plan");
  writeJson(planPath, plan);
  const stage = state.stages.find((item) => item.id === "direction");
  if (stage.status === "waiting-approval" || stage.status === "approved") {
    const artifact = state.artifacts.find((item) => item.stage_id === "direction" && item.role === "direction-package");
    if (!artifact || artifact.sha256 !== sha256File(planPath)) throw new Error("方向阶段已经绑定另一份计划；先使阶段失效再重新计划");
  } else {
    submitStage(state, context.project, "direction", [{id: "source-video-commentary-plan", role: "direction-package", kind: "document", file: relativeProjectPath(context.project, planPath)}]);
    writeValidState(statePath, state);
  }
  return {project: context.project, plan: planPath, plan_sha256: sha256File(planPath), total_frames: plan.total_frames, next_action: state.next_action};
}

export function assertSourceVideoCommentaryPlan(projectRoot, planRelative = PLAN_RELATIVE) {
  const planBinding = binding(projectRoot, planRelative, "source video commentary plan", PLAN_SCHEMA);
  const plan = planBinding.document;
  const roles = new Set();
  for (const item of plan.inputs) {
    if (roles.has(item.role)) throw new Error(`production plan input role 重复：${item.role}`);
    roles.add(item.role);
    const actual = binding(projectRoot, item.file, `plan input ${item.role}`);
    if (actual.sha256 !== item.sha256) throw new Error(`production plan input 已变化：${item.role}`);
  }
  if (JSON.stringify(plan).includes('"start_seconds"') || JSON.stringify(plan).includes('"end_seconds"')) {
    throw new Error("production plan 不能复制 clip selection 的源素材入点或出点");
  }
  const ordered = [...plan.segments].sort((a, b) => a.order - b.order);
  let cursor = 0;
  for (const [index, segment] of ordered.entries()) {
    if (segment.order !== index + 1 || segment.timeline_start_frame !== cursor) throw new Error("production plan segments 必须按连续整数帧排列");
    cursor += segment.duration_frames;
  }
  if (cursor !== plan.total_frames) throw new Error("production plan total_frames 与 segment 布局不一致");
  return {plan, planBinding};
}

export function confirmSourceVideoCommentaryPlan(options) {
  const projectRoot = path.resolve(options.project);
  const {plan, planBinding} = assertSourceVideoCommentaryPlan(projectRoot, options.plan || PLAN_RELATIVE);
  const confirmation = {
    protocol: "visual-multimedia-source-video-commentary-plan-confirmation",
    version: 1,
    project_id: plan.project_id,
    profile: PROFILE,
    plan: planBinding.file,
    plan_sha256: planBinding.sha256,
    confirmed_by: options.confirmedBy,
    confirmed_at: nowIso(),
    evidence: options.evidence,
  };
  assertJsonSchema(confirmation, CONFIRMATION_SCHEMA, "source video commentary plan confirmation");
  const confirmationPath = projectPath(projectRoot, options.confirmation || CONFIRMATION_RELATIVE, "plan confirmation");
  if (fs.existsSync(confirmationPath)) {
    const existing = readJson(confirmationPath);
    assertJsonSchema(existing, CONFIRMATION_SCHEMA, "existing plan confirmation");
    if (existing.plan_sha256 !== planBinding.sha256) throw new Error("现有 plan confirmation 绑定另一份计划");
  } else {
    writeJson(confirmationPath, confirmation);
  }
  const {statePath, state} = stateAt(projectRoot);
  const stage = state.stages.find((item) => item.id === "direction");
  if (stage.status === "waiting-approval") {
    decideStage(state, "direction", "approved", options.evidence, {decidedBy: options.confirmedBy});
    writeValidState(statePath, state);
  } else if (stage.status !== "approved") {
    throw new Error(`direction 阶段当前为 ${stage.status}，不能确认计划`);
  }
  return {status: "approved", confirmation: confirmationPath, plan_sha256: planBinding.sha256, next_action: state.next_action};
}

export function assertPlanConfirmation(projectRoot, planRelative = PLAN_RELATIVE, confirmationRelative = CONFIRMATION_RELATIVE) {
  const {plan, planBinding} = assertSourceVideoCommentaryPlan(projectRoot, planRelative);
  const confirmationBinding = binding(projectRoot, confirmationRelative, "source video commentary plan confirmation", CONFIRMATION_SCHEMA);
  if (
    confirmationBinding.document.project_id !== plan.project_id
    || confirmationBinding.document.plan !== planBinding.file
    || confirmationBinding.document.plan_sha256 !== planBinding.sha256
  ) throw new Error("plan confirmation 没有绑定当前 production plan");
  return {plan, planBinding, confirmation: confirmationBinding.document, confirmationBinding};
}

function selectionContext(projectRoot, plan) {
  const clipInput = plan.inputs.find((item) => item.role === "clip-selections");
  const sourceInput = plan.inputs.find((item) => item.role === "media-sources");
  const clips = readJson(projectPath(projectRoot, clipInput.file, "plan clip selections"));
  const sources = readJson(projectPath(projectRoot, sourceInput.file, "plan media sources"));
  return {
    clipById: new Map(clips.clips.map((item) => [item.id, item])),
    sourceById: new Map(sources.sources.map((item) => [item.id, item])),
  };
}

function timelineSourceId(prefix, value) {
  return `${prefix}-${value}`.replace(/[^a-z0-9._-]+/gu, "-");
}

export function projectPlanToPortableTimeline(projectRoot, plan, options = {}) {
  const selectedIds = options.segmentIds ? new Set(options.segmentIds) : null;
  const selected = plan.segments.filter((item) => !selectedIds || selectedIds.has(item.id));
  if (!selected.length) throw new Error("portable timeline 至少需要一个 segment");
  if (selectedIds && selected.length !== selectedIds.size) throw new Error("portable timeline segmentIds 包含计划中不存在的 id");
  const {clipById, sourceById} = selectionContext(projectRoot, plan);
  const sourceDocuments = new Map();
  const videoClips = [];
  const sourceAudioClips = [];
  const narrationClips = [];
  const musicClips = [];
  const captions = [];
  const markers = [];
  const fps = plan.output.fps;
  let cursorFrames = 0;
  if (plan.background_music) {
    const sourceId = timelineSourceId("music", plan.background_music.source_id);
    sourceDocuments.set(sourceId, {
      id: sourceId,
      kind: "audio",
      file: plan.background_music.audio.file,
      sha256: plan.background_music.audio.sha256,
      duration_seconds: plan.background_music.duration_seconds,
    });
  }
  for (const segment of selected) {
    const durationFrames = segment.duration_frames;
    const duration = durationFrames / fps;
    const cursor = cursorFrames / fps;
    markers.push({id: `marker-${segment.id}`, time_seconds: cursor, label: segment.purpose, note: segment.visual_role});
    if (segment.visual.kind === "editable-scene") {
      const rendered = options.editableRenders?.get(segment.id);
      if (!rendered) throw new Error(`segment ${segment.id} 尚未生成 editable scene render`);
      const sourceId = timelineSourceId("web", segment.id);
      sourceDocuments.set(sourceId, {id: sourceId, kind: "web-render", file: rendered.file, sha256: rendered.sha256, duration_seconds: rendered.duration_seconds});
      const mediaFrames = Math.min(durationFrames, Math.max(0, Math.floor(rendered.duration_seconds * fps + 1e-9)));
      if (mediaFrames > 0) {
        videoClips.push({id: `visual-${segment.id}`, type: "media", source_id: sourceId, timeline_start_seconds: cursor, source_in_seconds: 0, duration_seconds: mediaFrames / fps, placement: {fit: segment.visual.fit}, audio_enabled: false});
      }
      if (mediaFrames < durationFrames) {
        videoClips.push({id: `freeze-${segment.id}`, type: "freeze", source_id: sourceId, timeline_start_seconds: (cursorFrames + mediaFrames) / fps, source_time_seconds: Math.max(0, rendered.duration_seconds - 1 / fps), duration_seconds: (durationFrames - mediaFrames) / fps, placement: {fit: segment.visual.fit}});
      }
    } else {
      const selection = clipById.get(segment.visual.clip_selection_id);
      const source = sourceById.get(selection.source_id);
      const sourceId = timelineSourceId("source", source.id);
      sourceDocuments.set(sourceId, {id: sourceId, kind: "video", file: source.file, sha256: source.integrity.sha256});
      const selectionDuration = selection.end_seconds - selection.start_seconds;
      const selectionFrames = Math.max(0, Math.floor(selectionDuration * fps + 1e-9));
      if (segment.visual.kind === "source-freeze") {
        const offset = segment.visual.frame === "start" ? 0 : (segment.visual.frame === "middle" ? selectionDuration / 2 : Math.max(0, selectionDuration - 1 / fps));
        videoClips.push({id: `visual-${segment.id}`, type: "freeze", source_id: sourceId, timeline_start_seconds: cursor, source_time_seconds: selection.start_seconds + offset, duration_seconds: duration, placement: {fit: segment.visual.fit}});
      } else {
        const mediaFrames = Math.min(durationFrames, selectionFrames);
        if (mediaFrames > 0) {
          videoClips.push({id: `visual-${segment.id}`, type: "media", source_id: sourceId, timeline_start_seconds: cursor, source_in_seconds: selection.start_seconds, duration_seconds: mediaFrames / fps, placement: {fit: segment.visual.fit}, audio_enabled: false});
        }
        if (mediaFrames < durationFrames) {
          videoClips.push({id: `freeze-${segment.id}`, type: "freeze", source_id: sourceId, timeline_start_seconds: (cursorFrames + mediaFrames) / fps, source_time_seconds: Math.max(selection.start_seconds, selection.end_seconds - 1 / fps), duration_seconds: (durationFrames - mediaFrames) / fps, placement: {fit: segment.visual.fit}});
        }
      }
      if (segment.audio.mode !== "narration-only") {
        const sourceAudioFrames = Math.min(durationFrames, selectionFrames);
        if (sourceAudioFrames > 0) {
        sourceAudioClips.push({
          id: `source-audio-${segment.id}`,
          type: "media",
          source_id: sourceId,
          timeline_start_seconds: cursor,
          source_in_seconds: selection.start_seconds,
          duration_seconds: sourceAudioFrames / fps,
          audio_enabled: true,
          gain_db: segment.audio.source_gain_db,
        });
        }
      }
    }
    if (segment.narration) {
      const sourceId = timelineSourceId("narration", segment.narration.audio_source_id);
      sourceDocuments.set(sourceId, {id: sourceId, kind: "audio", file: segment.narration.audio.file, sha256: segment.narration.audio.sha256, duration_seconds: segment.narration.duration_seconds});
      narrationClips.push({id: `narration-${segment.id}`, type: "media", source_id: sourceId, timeline_start_seconds: cursor, source_in_seconds: 0, duration_seconds: duration, audio_enabled: true, gain_db: 0});
    }
    if (plan.background_music) {
      const music = plan.background_music;
      const sourceId = timelineSourceId("music", music.source_id);
      const musicFrames = Math.max(1, Math.floor(music.duration_seconds * fps + 1e-9));
      const programStartFrames = segment.timeline_start_frame;
      let sourceInFrames = music.loop ? programStartFrames % musicFrames : programStartFrames;
      let remainingFrames = durationFrames;
      let localOffsetFrames = 0;
      let part = 1;
      const gain = music.base_gain_db + (segment.narration ? music.narration_reduction_db : music.source_only_reduction_db);
      while (remainingFrames > 0 && sourceInFrames < musicFrames) {
        const takeFrames = Math.min(remainingFrames, musicFrames - sourceInFrames);
        const take = takeFrames / fps;
        const clip = {
          id: `music-${segment.id}-${String(part).padStart(2, "0")}`,
          type: "media",
          source_id: sourceId,
          timeline_start_seconds: (cursorFrames + localOffsetFrames) / fps,
          source_in_seconds: sourceInFrames / fps,
          duration_seconds: take,
          audio_enabled: true,
          gain_db: gain,
        };
        if (programStartFrames + localOffsetFrames === 0 && music.fade_in_seconds > 0) {
          clip.fade_in = {kind: "fade", duration_seconds: Math.min(take, music.fade_in_seconds)};
        }
        const programEndFrames = programStartFrames + localOffsetFrames + takeFrames;
        if (programEndFrames === plan.total_frames && music.fade_out_seconds > 0) {
          clip.fade_out = {kind: "fade", duration_seconds: Math.min(take, music.fade_out_seconds)};
        }
        musicClips.push(clip);
        remainingFrames -= takeFrames;
        localOffsetFrames += takeFrames;
        part += 1;
        if (!music.loop) break;
        sourceInFrames = 0;
      }
    }
    for (const caption of segment.captions) {
      const start = (caption.start_frame - segment.timeline_start_frame) / plan.output.fps;
      const end = (caption.end_frame - segment.timeline_start_frame) / plan.output.fps;
      captions.push({id: caption.id, type: "caption", timeline_start_seconds: cursor + start, duration_seconds: end - start, text: caption.text, style_id: "commentary-caption", language: caption.language});
    }
    cursorFrames += durationFrames;
  }
  const tracks = [
    {id: "commentary-video", kind: "video", name: "Commentary picture", muted: false, clips: videoClips},
    {id: "commentary-source-audio", kind: "audio", name: "Source audio responsibilities", muted: false, clips: sourceAudioClips},
    {id: "commentary-narration", kind: "audio", name: "Reviewed narration", muted: false, clips: narrationClips},
  ];
  if (plan.background_music) tracks.push({id: "commentary-music", kind: "audio", name: "Background music", muted: false, clips: musicClips});
  if (plan.output.caption_mode !== "none") tracks.push({id: "commentary-captions", kind: "subtitle", name: "Commentary captions", muted: false, clips: captions});
  const timeline = {
    protocol: "visual-multimedia-timeline",
    version: 1,
    project_id: selectedIds ? `${plan.project_id}-sample` : plan.project_id,
    profile: {
      width: plan.output.width,
      height: plan.output.height,
      frame_rate: plan.output.fps,
      sample_rate: plan.output.audio_sample_rate,
      channel_layout: plan.output.audio_channels === 1 ? "mono" : "stereo",
      background: plan.output.background,
      duration_seconds: cursorFrames / fps,
    },
    sources: [...sourceDocuments.values()],
    tracks,
    subtitle_styles: plan.output.caption_mode === "none" ? [] : [{
      id: "commentary-caption",
      font_family: "Microsoft YaHei",
      font_size: Math.max(26, Math.round(plan.output.height * 0.045)),
      primary_color: "#FFFFFF",
      outline_color: "#101010",
      outline_width: Math.max(2, Math.round(plan.output.height * 0.003)),
      margin_vertical: Math.max(48, Math.round(plan.output.height * 0.08)),
      alignment: 2,
      bold: true,
      italic: false,
    }],
    markers,
  };
  return timeline;
}

export function createSourceVideoCommentaryBuildPlan(projectRoot, plan, planPath, outputRelative = null) {
  const dependenciesBySegment = new Map();
  for (const segment of plan.segments) {
    const dependencies = [];
    if (segment.visual.kind === "editable-scene") {
      dependencies.push(fileDependency(projectRoot, "editable-manifest", `${segment.visual.package}/editable-media.json`));
    } else {
      dependencies.push(fileDependency(projectRoot, "visual-source", segment.visual.source.file));
    }
    if (segment.narration) dependencies.push(fileDependency(projectRoot, "narration-audio", segment.narration.audio.file));
    if (plan.background_music) dependencies.push(fileDependency(projectRoot, "background-music", plan.background_music.audio.file));
    dependenciesBySegment.set(segment.id, dependencies);
  }
  return createMediaBuildPlan({
    projectRoot,
    producerRoot: SKILL_ROOT,
    projectId: plan.project_id,
    mediaKind: "mixed-video",
    profile: PROFILE,
    stageTarget: "full-preview",
    sourceContract: relativeProjectPath(projectRoot, planPath),
    producerEntry: "scripts/source-video-commentary.mjs",
    producerModules: ["scripts/source_video_commentary_contract.mjs", "scripts/source_video_commentary_render.mjs", "scripts/media-timeline.mjs"],
    output: {
      file: outputRelative || plan.output.file,
      width: plan.output.width,
      height: plan.output.height,
      fps: plan.output.fps,
      audio_sample_rate: plan.output.audio_sample_rate,
      audio_channels: plan.output.audio_channels,
      quality_profile: "proxy",
    },
    units: plan.segments.map((segment) => ({
      id: segment.id,
      order: segment.order,
      kind: "timeline-range",
      source_unit_id: segment.id,
      timeline_start_frame: segment.timeline_start_frame,
      duration_frames: segment.duration_frames,
      dependencies: dependenciesBySegment.get(segment.id),
    })),
    assembly: {strategy: "ordered-concat", audio_strategy: "continuous-master", caption_strategy: plan.output.caption_mode},
  });
}
