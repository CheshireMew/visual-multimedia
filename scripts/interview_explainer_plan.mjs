import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {
  canonical,
  commandPath,
  ensureDirectory,
  ensureFile,
  hashPath,
  nowIso,
  probeMedia,
  projectPath,
  readJson,
  relativeProjectPath,
  run,
  sha256File,
  slash,
  writeJson,
} from "./interview_explainer_common.mjs";
import {
  assertEditableMediaPackageClosed,
  readEditableMediaPackage,
} from "./editable-media-contract.mjs";
import {validateMediaSources} from "./validate-media-sources.mjs";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  assertStageApproved,
  decideStage,
  submitStage,
  validateProjectState,
} from "./media_project_state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(SCRIPT_DIR);
const PUBLIC_ENTRY = path.join(SCRIPT_DIR, "interview-explainer.mjs");
const RENDER_PLAN_MODULES = [
  "interview_explainer_common.mjs",
  "interview_explainer_plan.mjs",
  "interview_explainer_render.mjs",
  "json_schema_contract.mjs",
  "editable-media-contract.mjs",
  "validate-media-sources.mjs",
  "validate-media-transcript.mjs",
  "validate-clip-selections.mjs",
  "media_project_state.mjs",
].map((name) => path.join(SCRIPT_DIR, name));
const PROFILE_CATALOG = path.join(
  SKILL_ROOT,
  "assets",
  "video-production-profiles",
  "catalog.json",
);

function loadGenericState(projectRoot) {
  const statePath = path.join(projectRoot, "media-project-state.json");
  ensureFile(statePath, "通用媒体项目状态");
  const validation = validateProjectState(statePath);
  if (!validation.ok) {
    throw new Error(`通用媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  }
  return {statePath, state: readJson(statePath)};
}

function writeGenericState(statePath, state) {
  writeJson(statePath, state);
  const validation = validateProjectState(statePath);
  if (!validation.ok) {
    throw new Error(`更新后的通用阶段状态未通过：\n- ${validation.errors.join("\n- ")}`);
  }
  return validation;
}

function bindDirectionStage(projectRoot, planPath) {
  const {statePath, state} = loadGenericState(projectRoot);
  assertStageApproved(state, "content");
  const stage = state.stages.find((item) => item.id === "direction");
  const relative = relativeProjectPath(projectRoot, planPath);
  const expectedSha = sha256File(planPath);
  if (["waiting-approval", "approved"].includes(stage.status)) {
    const artifact = state.artifacts.find(
      (item) => item.stage_id === "direction" && item.role === "direction-package",
    );
    if (!artifact || artifact.file !== relative || artifact.sha256 !== expectedSha) {
      throw new Error("导演阶段已经绑定其它成果；先使 direction 及下游失效再生成新计划");
    }
    return validateProjectState(statePath);
  }
  submitStage(state, projectRoot, "direction", [{
    id: "interview-explainer-plan",
    role: "direction-package",
    kind: "timeline",
    file: relative,
  }]);
  return writeGenericState(statePath, state);
}

function approveDirectionStage(projectRoot, confirmedBy, evidence, timestamp) {
  const {statePath, state} = loadGenericState(projectRoot);
  const stage = state.stages.find((item) => item.id === "direction");
  if (stage.status === "approved") return validateProjectState(statePath);
  if (stage.status !== "waiting-approval") {
    throw new Error(`导演阶段当前为 ${stage.status}，不能确认采访计划`);
  }
  if (confirmedBy !== "user") {
    return validateProjectState(statePath);
  }
  decideStage(state, "direction", "approved", evidence, {
    decidedBy: "user",
    timestamp,
  });
  return writeGenericState(statePath, state);
}
const SCHEMA_DIR = path.join(SKILL_ROOT, "schemas");

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label}.${key} 不是当前合同字段`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} 缺少 ${key}`);
    }
  }
}

function loadProfile(id, version) {
  const catalog = readJson(PROFILE_CATALOG);
  assertJsonSchema(
    catalog,
    path.join(SCHEMA_DIR, "video-production-profile-catalog.v1.schema.json"),
    "视频生产类型目录",
  );
  if (
    catalog.protocol !== "visual-multimedia-video-production-profile-catalog"
    || catalog.version !== 1
    || !Array.isArray(catalog.profiles)
  ) {
    throw new Error("视频生产类型目录不是活动 v1 合同");
  }
  const item = catalog.profiles.find(
    (candidate) => candidate.id === id
      && candidate.version === version
      && candidate.status === "active",
  );
  if (!item) throw new Error(`没有活动视频生产类型：${id}@${version}`);
  const packagePath = path.resolve(path.dirname(PROFILE_CATALOG), item.package);
  ensureFile(packagePath, "视频生产类型包");
  const actualHash = sha256File(packagePath);
  if (actualHash !== item.package_sha256) {
    throw new Error(`视频生产类型包哈希不匹配：目录=${item.package_sha256} 实际=${actualHash}`);
  }
  const profile = readJson(packagePath);
  if (
    profile.protocol !== "visual-multimedia-video-production-profile"
    || profile.version !== 1
    || profile.id !== id
    || profile.profile_version !== version
    || profile.status !== "active"
  ) {
    throw new Error(`视频生产类型包身份不正确：${packagePath}`);
  }
  return {
    item,
    profile,
    packagePath,
    resourcePath: slash(path.relative(SKILL_ROOT, packagePath)),
    sha256: actualHash,
  };
}

function validateDraft(draft) {
  assertExactKeys(
    draft,
    ["protocol", "version", "project_id", "profile", "contracts", "output", "style", "sequence"],
    "draft",
  );
  if (
    draft.protocol !== "visual-multimedia-interview-explainer-draft"
    || draft.version !== 2
  ) {
    throw new Error("draft 必须使用 interview-explainer v2");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(draft.project_id || "")) {
    throw new Error("draft.project_id 不是稳定 id");
  }
  if (
    draft.profile?.id !== "interview-explainer"
    || !/^\d+\.\d+\.\d+$/.test(draft.profile?.version || "")
  ) {
    throw new Error("draft.profile 必须明确 interview-explainer 的语义版本");
  }
  const output = draft.output || {};
  if (
    !Number.isInteger(output.width)
    || !Number.isInteger(output.height)
    || !Number.isInteger(output.fps)
    || output.width < 240
    || output.height < 240
    || output.fps < 12
  ) {
    throw new Error("draft.output 的尺寸和帧率无效");
  }
  if (!["burned-in", "embedded-track", "sidecar"].includes(output.caption_mode)) {
    throw new Error("draft.output.caption_mode 无效");
  }
  if (draft.style?.source_card?.show_source_timecode !== true) {
    throw new Error("该类型的原声证据画面必须显示来源时间码");
  }
  const footageBox = draft.style?.source_card?.footage_box || {};
  if (
    ![footageBox.x, footageBox.y, footageBox.width, footageBox.height]
      .every((value) => Number.isFinite(Number(value)))
    || Number(footageBox.x) < 0
    || Number(footageBox.y) < 0
    || Number(footageBox.width) <= 0
    || Number(footageBox.height) <= 0
    || Number(footageBox.x) + Number(footageBox.width) > 1.000001
    || Number(footageBox.y) + Number(footageBox.height) > 1.000001
  ) {
    throw new Error("draft.style.source_card.footage_box 必须完整位于输出画布内");
  }
  if (!Array.isArray(draft.sequence) || draft.sequence.length < 3) {
    throw new Error("draft.sequence 至少需要背景、原声证据和解释/总结");
  }
  const ids = new Set();
  for (const [index, segment] of draft.sequence.entries()) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment?.id || "")) {
      throw new Error(`draft.sequence[${index}].id 无效`);
    }
    if (ids.has(segment.id)) throw new Error(`draft.sequence 的 id 重复：${segment.id}`);
    ids.add(segment.id);
    if (!["source-clip", "narration"].includes(segment.kind)) {
      throw new Error(`draft.sequence[${index}].kind 无效`);
    }
    if (segment.kind === "source-clip") {
      if (!String(segment.viewer_title || "").trim()) {
        throw new Error(`原声片段 ${segment.id} 必须提供直接显示给观众的 viewer_title`);
      }
      if (!Array.isArray(segment.subtitle_cues) || !segment.subtitle_cues.length) {
        throw new Error(`原声片段 ${segment.id} 必须提供复核过的分段字幕时间码`);
      }
      let previousEnd = -Infinity;
      for (const [cueIndex, cue] of segment.subtitle_cues.entries()) {
        if (
          !Number.isFinite(Number(cue.source_start_seconds))
          || !Number.isFinite(Number(cue.source_end_seconds))
          || Number(cue.source_end_seconds) <= Number(cue.source_start_seconds)
          || !String(cue.text || "").trim()
        ) {
          throw new Error(`原声片段 ${segment.id} 的字幕 ${cueIndex + 1} 无效`);
        }
        if (Number(cue.source_start_seconds) < previousEnd - 0.001) {
          throw new Error(`原声片段 ${segment.id} 的字幕时间码重叠或乱序`);
        }
        previousEnd = Number(cue.source_end_seconds);
      }
    }
  }
  const sourceHookOpening = draft.sequence[0].kind === "source-clip";
  if (sourceHookOpening) {
    if (draft.profile.version !== "1.4.0") {
      throw new Error("原声钩子开场需要 interview-explainer 1.4.0");
    }
    const contextBridge = draft.sequence[1];
    const answerEvidence = draft.sequence[2];
    if (
      !contextBridge
      || contextBridge.kind !== "narration"
      || contextBridge.role !== "context"
      || !answerEvidence
      || answerEvidence.kind !== "source-clip"
    ) {
      throw new Error("原声钩子开场必须使用：原声钩子 → 必要背景旁白 → 原声回答");
    }
  } else if (
    draft.sequence[0].kind !== "narration"
    || draft.sequence[0].role !== "context"
  ) {
    throw new Error("该类型必须从必要背景旁白开始，或使用 1.4.0 的原声钩子开场");
  }
  if (!draft.sequence.some((segment) => segment.kind === "source-clip")) {
    throw new Error("该类型至少需要一个真实原声证据片段");
  }
  if (
    draft.sequence.at(-1)?.kind !== "narration"
    || draft.sequence.at(-1)?.role !== "summary"
  ) {
    throw new Error("该类型必须用独立总结旁白收束");
  }
  for (let index = 0; index < draft.sequence.length; index += 1) {
    const current = draft.sequence[index];
    if (current.kind === "source-clip") {
      if (sourceHookOpening && index === 0) continue;
      const next = draft.sequence[index + 1];
      if (!next || next.kind !== "narration" || next.role !== "explanation") {
        throw new Error(`原声片段 ${current.id} 后必须紧接解释旁白`);
      }
    }
  }
}

function durationFrames(durationSeconds, fps) {
  const exactFrames = Number(durationSeconds) * Number(fps);
  const nearestFrame = Math.round(exactFrames);
  return Math.abs(exactFrames - nearestFrame) <= 1e-7
    ? nearestFrame
    : Math.ceil(exactFrames);
}

function validateNarrationBundle(projectRoot, bundle, mediaById, ffprobe) {
  if (
    bundle.protocol !== "visual-multimedia-narration-bundle"
    || bundle.version !== 1
    || !Array.isArray(bundle.segments)
    || bundle.segments.length < 1
  ) {
    throw new Error("narration-bundle.json 不是活动 v1 合同或没有段落");
  }
  const result = new Map();
  for (const segment of bundle.segments) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment?.id || "")) {
      throw new Error(`旁白 id 无效：${segment?.id}`);
    }
    if (result.has(segment.id)) throw new Error(`旁白 id 重复：${segment.id}`);
    if (sha256Text(segment.text || "") !== segment.text_sha256) {
      throw new Error(`旁白 ${segment.id} 的文本哈希不匹配`);
    }
    const source = mediaById.get(segment.audio_source_id);
    if (!source || source.media_type !== "audio") {
      throw new Error(`旁白 ${segment.id} 的音频 source id 不存在或不是 audio`);
    }
    if (source.integrity?.sha256 !== segment.audio_sha256) {
      throw new Error(`旁白 ${segment.id} 的素材账本音频哈希与旁白包不一致`);
    }
    if (source.speech?.text_sha256 !== segment.text_sha256) {
      throw new Error(`旁白 ${segment.id} 的准确文本哈希与素材账本合成输入不一致`);
    }
    const voiceKind = segment.voice?.kind;
    const providerMatches = voiceKind === "synthetic"
      ? (
        source.generation != null
        && segment.voice.provider === source.generation.provider
        && ["generated", "generated-in-project"].includes(source.acquisition?.method)
      )
      : (
        voiceKind === "recorded"
        && source.generation == null
        && segment.voice.provider === source.acquisition?.method
        && !["generated", "generated-in-project"].includes(source.acquisition?.method)
      );
    if (
      segment.voice?.provider_voice_id !== source.speech?.provider_voice_id
      || segment.voice?.voice_name !== source.speech?.voice_name
      || !providerMatches
    ) {
      throw new Error(`旁白 ${segment.id} 的声音身份与素材账本不一致`);
    }
    const audioPath = projectPath(projectRoot, source.file, `旁白 ${segment.id} 音频`);
    ensureFile(audioPath, `旁白 ${segment.id} 音频`);
    if (sha256File(audioPath) !== segment.audio_sha256) {
      throw new Error(`旁白 ${segment.id} 的真实音频哈希不匹配`);
    }
    const timingPath = projectPath(projectRoot, segment.timing_file, `旁白 ${segment.id} 时间标记`);
    ensureFile(timingPath, `旁白 ${segment.id} 时间标记`);
    if (sha256File(timingPath) !== segment.timing_sha256) {
      throw new Error(`旁白 ${segment.id} 的时间标记哈希不匹配`);
    }
    const probe = probeMedia(ffprobe, audioPath);
    if (!probe.has_audio || probe.duration_seconds == null) {
      throw new Error(`旁白 ${segment.id} 不是可读音频`);
    }
    if (Math.abs(probe.duration_seconds - Number(segment.duration_seconds)) > 0.06) {
      throw new Error(
        `旁白 ${segment.id} 记录时长 ${segment.duration_seconds}s`
        + ` 与真实时长 ${probe.duration_seconds}s 不一致`,
      );
    }
    if (
      segment.review?.listened !== true
      || segment.review?.text_matches_audio !== true
      || segment.review?.natural_speed !== true
    ) {
      throw new Error(`旁白 ${segment.id} 尚未完成听音、文本一致和自然原速审核`);
    }
    result.set(segment.id, {
      ...segment,
      source,
      audioPath,
      timingPath,
      actualDuration: probe.duration_seconds,
    });
  }
  return result;
}

function inputRecord(projectRoot, role, target) {
  const integrity = hashPath(target);
  return {
    role,
    file: relativeProjectPath(projectRoot, target),
    sha256: integrity.sha256,
    bytes: integrity.bytes,
  };
}

export function createInterviewExplainerPlan(options) {
  const projectRoot = path.resolve(options.project);
  ensureDirectory(projectRoot, "项目目录");
  const genericState = loadGenericState(projectRoot);
  assertStageApproved(genericState.state, "content");
  const draftPath = projectPath(
    projectRoot,
    options.draft || "interview-explainer-draft.json",
    "draft",
  );
  ensureFile(draftPath, "interview-explainer draft");
  const draft = readJson(draftPath);
  assertJsonSchema(
    draft,
    path.join(SCHEMA_DIR, "interview-explainer-draft.v2.schema.json"),
    "访谈解析 draft",
  );
  validateDraft(draft);
  const profile = loadProfile(draft.profile.id, draft.profile.version);
  const ffprobe = commandPath("ffprobe", options.ffprobe, "FFPROBE_BIN");

  const contractPaths = {
    mediaSources: projectPath(projectRoot, draft.contracts.media_sources, "media_sources"),
    transcript: projectPath(projectRoot, draft.contracts.transcript, "transcript"),
    clips: projectPath(projectRoot, draft.contracts.clip_selections, "clip_selections"),
    narration: projectPath(projectRoot, draft.contracts.narration_bundle, "narration_bundle"),
  };
  for (const [name, target] of Object.entries(contractPaths)) ensureFile(target, name);

  const sourceValidation = validateMediaSources(contractPaths.mediaSources);
  if (!sourceValidation.ok) {
    throw new Error(`素材账本未通过：\n- ${sourceValidation.errors.join("\n- ")}`);
  }
  run(process.execPath, [
    path.join(SCRIPT_DIR, "validate-media-transcript.mjs"),
    contractPaths.transcript,
    "--ffprobe",
    ffprobe,
  ]);
  run(process.execPath, [
    path.join(SCRIPT_DIR, "validate-clip-selections.mjs"),
    contractPaths.clips,
    "--ffprobe",
    ffprobe,
  ]);

  const mediaSources = readJson(contractPaths.mediaSources);
  const mediaById = new Map(mediaSources.sources.map((source) => [source.id, source]));
  const transcriptDocument = readJson(contractPaths.transcript);
  const clipsDocument = readJson(contractPaths.clips);
  const clipsById = new Map(clipsDocument.clips.map((clip) => [clip.id, clip]));
  const narrationBundle = readJson(contractPaths.narration);
  assertJsonSchema(
    narrationBundle,
    path.join(SCHEMA_DIR, "narration-bundle.v1.schema.json"),
    "旁白包",
  );
  if (narrationBundle.media_sources !== draft.contracts.media_sources) {
    throw new Error("旁白包与 draft 没有引用同一素材账本");
  }
  const narrations = validateNarrationBundle(
    projectRoot,
    narrationBundle,
    mediaById,
    ffprobe,
  );

  const inputs = [
    inputRecord(projectRoot, "draft", draftPath),
    inputRecord(projectRoot, "media-sources", contractPaths.mediaSources),
    inputRecord(projectRoot, "transcript", contractPaths.transcript),
    inputRecord(projectRoot, "clip-selections", contractPaths.clips),
    inputRecord(projectRoot, "narration-bundle", contractPaths.narration),
  ];
  const seenInputRoles = new Set(inputs.map((item) => item.role));
  const sequence = [];
  let timelineStart = 0;
  for (const [index, segment] of draft.sequence.entries()) {
    let frames;
    let content;
    if (segment.kind === "source-clip") {
      const clip = clipsById.get(segment.clip_id);
      if (!clip) throw new Error(`计划引用不存在的 clip id：${segment.clip_id}`);
      const source = mediaById.get(clip.source_id);
      if (!source || source.media_type !== "video") {
        throw new Error(`clip ${clip.id} 的 source 不是视频`);
      }
      if (source.representation?.kind !== "source") {
        throw new Error(`正式计划不能采用代理：${source.id}`);
      }
      if (transcriptDocument.source_id !== source.id) {
        throw new Error(`clip ${clip.id} 与听音复核转写不是同一原片`);
      }
      const boundaryValues = new Set(
        transcriptDocument.segments.flatMap((item) => [
          Number(item.start_seconds),
          Number(item.end_seconds),
        ]),
      );
      const nearReviewedBoundary = (value) => [...boundaryValues].some(
        (candidate) => Math.abs(candidate - Number(value)) <= 0.08,
      );
      for (const [cueIndex, cue] of segment.subtitle_cues.entries()) {
        const cueStart = Number(cue.source_start_seconds);
        const cueEnd = Number(cue.source_end_seconds);
        if (
          cueStart < Number(clip.start_seconds) - 0.001
          || cueEnd > Number(clip.end_seconds) + 0.001
        ) {
          throw new Error(
            `原声片段 ${segment.id} 的字幕 ${cueIndex + 1} 越过采用区间`,
          );
        }
        if (!nearReviewedBoundary(cueStart) || !nearReviewedBoundary(cueEnd)) {
          throw new Error(
            `原声片段 ${segment.id} 的字幕 ${cueIndex + 1}`
            + " 没有使用听音复核转写的时间边界",
          );
        }
      }
      const sourcePath = projectPath(projectRoot, source.file, `原片 ${source.id}`);
      ensureFile(sourcePath, `原片 ${source.id}`);
      if (sha256File(sourcePath) !== source.integrity?.sha256) {
        throw new Error(`原片 ${source.id} 的真实哈希与素材账本不一致`);
      }
      const duration = Number(clip.end_seconds) - Number(clip.start_seconds);
      frames = durationFrames(duration, draft.output.fps);
      content = {
        viewer_title: segment.viewer_title,
        source_id: source.id,
        clip_id: clip.id,
        start_seconds: Number(clip.start_seconds),
        end_seconds: Number(clip.end_seconds),
        source_label: segment.source_label,
        translation: segment.translation,
        original_text: segment.original_text,
        subtitle_cues: segment.subtitle_cues.map((cue) => ({
          source_start_seconds: Number(cue.source_start_seconds),
          source_end_seconds: Number(cue.source_end_seconds),
          text: cue.text,
        })),
        audio_source_id: null,
        audio_sha256: null,
        timing_file: null,
        timing_sha256: null,
        scene_package: null,
        scene_package_sha256: null,
        scene_id: null,
      };
      const role = `source:${source.id}`;
      if (!seenInputRoles.has(role)) {
        inputs.push(inputRecord(projectRoot, role, sourcePath));
        seenInputRoles.add(role);
      }
    } else {
      const narration = narrations.get(segment.narration_id);
      if (!narration) {
        throw new Error(`计划引用不存在的 narration id：${segment.narration_id}`);
      }
      const packageRoot = projectPath(
        projectRoot,
        segment.scene_package,
        `场景包 ${segment.id}`,
      );
      const editable = readEditableMediaPackage(packageRoot);
      assertEditableMediaPackageClosed(editable.packageRoot, editable.manifest);
      const selectedScene = editable.manifest.scenes.find(
        (scene) => scene.id === segment.scene_id,
      );
      if (!selectedScene) {
        throw new Error(`场景包 ${segment.scene_package} 缺少 scene id ${segment.scene_id}`);
      }
      if (Number(selectedScene.duration_ms) + 1 < Math.ceil(narration.actualDuration * 1000)) {
        throw new Error(
          `场景 ${segment.scene_id} 只有 ${selectedScene.duration_ms}ms，`
          + `短于真实旁白 ${Math.ceil(narration.actualDuration * 1000)}ms`,
        );
      }
      const variant = editable.manifest.variants.find(
        (candidate) => candidate.id === editable.manifest.default_variant_id,
      );
      if (
        !variant
        || Number(variant.canvas.width) !== draft.output.width
        || Number(variant.canvas.height) !== draft.output.height
        || Number(editable.manifest.playback.fps) !== draft.output.fps
      ) {
        throw new Error(
          `场景包 ${segment.scene_package} 的默认画布或帧率`
          + ` 与输出 ${draft.output.width}x${draft.output.height}@${draft.output.fps} 不一致`,
        );
      }
      const packageIntegrity = hashPath(packageRoot);
      frames = durationFrames(narration.actualDuration, draft.output.fps);
      content = {
        viewer_title: null,
        source_id: null,
        clip_id: null,
        start_seconds: null,
        end_seconds: null,
        source_label: null,
        translation: null,
        original_text: null,
        subtitle_cues: null,
        audio_source_id: narration.audio_source_id,
        audio_sha256: narration.audio_sha256,
        timing_file: narration.timing_file,
        timing_sha256: narration.timing_sha256,
        scene_package: segment.scene_package,
        scene_package_sha256: packageIntegrity.sha256,
        scene_id: segment.scene_id,
      };
      for (const [role, target] of [
        [`audio:${narration.audio_source_id}`, narration.audioPath],
        [`timing:${narration.id}`, narration.timingPath],
        [`scene-package:${segment.id}`, packageRoot],
      ]) {
        if (!seenInputRoles.has(role)) {
          inputs.push(inputRecord(projectRoot, role, target));
          seenInputRoles.add(role);
        }
      }
    }
    sequence.push({
      order: index + 1,
      id: segment.id,
      kind: segment.kind,
      role: segment.role,
      timeline_start_frame: timelineStart,
      duration_frames: frames,
      duration_seconds: Number((frames / draft.output.fps).toFixed(6)),
      content,
    });
    timelineStart += frames;
  }

  const plan = {
    protocol: "visual-multimedia-interview-explainer-plan",
    version: 2,
    project_id: draft.project_id,
    profile: {
      id: profile.profile.id,
      version: profile.profile.profile_version,
      package: profile.resourcePath,
      package_sha256: profile.sha256,
    },
    created_at: nowIso(),
    producer: {
      entry: "scripts/interview-explainer.mjs",
      sha256: sha256File(PUBLIC_ENTRY),
      runtime: process.version,
      modules: RENDER_PLAN_MODULES.map((target) => ({
        file: slash(path.relative(SKILL_ROOT, target)),
        sha256: sha256File(target),
      })),
    },
    inputs,
    output: draft.output,
    style: draft.style,
    sequence,
    total_frames: timelineStart,
    duration_seconds: Number((timelineStart / draft.output.fps).toFixed(6)),
  };
  assertJsonSchema(
    plan,
    path.join(SCHEMA_DIR, "interview-explainer-plan.v2.schema.json"),
    "不可变访谈解析计划",
  );
  const outputPath = projectPath(
    projectRoot,
    options.output || "interview-explainer-plan.json",
    "plan output",
  );
  if (fs.existsSync(outputPath)) {
    const existing = readJson(outputPath);
    plan.created_at = existing.created_at;
    if (canonical(existing) === canonical(plan)) {
      const stage = bindDirectionStage(projectRoot, outputPath);
      return {
        status: "reused",
        plan: outputPath,
        sha256: sha256File(outputPath),
        total_frames: existing.total_frames,
        duration_seconds: existing.duration_seconds,
        stage_status: stage.stages.find((item) => item.id === "direction").status,
        next_action: stage.next_action,
      };
    }
    throw new Error(
      `计划已经存在且输入不同：${outputPath}。`
      + "正式入口不会覆盖已生成计划，请在当前项目中明确采用新文件名。",
    );
  }
  writeJson(outputPath, plan);
  const stage = bindDirectionStage(projectRoot, outputPath);
  return {
    status: "created",
    plan: outputPath,
    sha256: sha256File(outputPath),
    total_frames: plan.total_frames,
    duration_seconds: plan.duration_seconds,
    stage_status: stage.stages.find((item) => item.id === "direction").status,
    next_action: stage.next_action,
  };
}

export function confirmInterviewExplainerPlan(options) {
  const projectRoot = path.resolve(options.project);
  const planPath = projectPath(
    projectRoot,
    options.plan || "interview-explainer-plan.json",
    "plan",
  );
  ensureFile(planPath, "计划");
  const plan = readJson(planPath);
  assertJsonSchema(
    plan,
    path.join(SCHEMA_DIR, "interview-explainer-plan.v2.schema.json"),
    "待确认计划",
  );
  if (
    plan.protocol !== "visual-multimedia-interview-explainer-plan"
    || plan.version !== 2
  ) {
    throw new Error("只能确认 interview-explainer v2 计划");
  }
  const confirmedBy = options.confirmedBy;
  if (!["user", "agent"].includes(confirmedBy)) {
    throw new Error("confirmed-by 必须是 user 或 agent");
  }
  if (typeof options.evidence !== "string" || !options.evidence.trim()) {
    throw new Error("确认计划必须提供非空 evidence");
  }
  const outputPath = projectPath(
    projectRoot,
    options.output || "interview-explainer-plan.confirmation.json",
    "confirmation output",
  );
  const confirmation = {
    protocol: "visual-multimedia-interview-explainer-plan-confirmation",
    version: 1,
    plan: relativeProjectPath(projectRoot, planPath),
    plan_sha256: sha256File(planPath),
    status: "confirmed",
    confirmed_at: nowIso(),
    confirmed_by: confirmedBy,
    evidence: options.evidence.trim(),
  };
  assertJsonSchema(
    confirmation,
    path.join(SCHEMA_DIR, "interview-explainer-plan-confirmation.v1.schema.json"),
    "计划确认合同",
  );
  if (fs.existsSync(outputPath)) {
    const existing = readJson(outputPath);
    confirmation.confirmed_at = existing.confirmed_at;
    if (canonical(existing) === canonical(confirmation)) {
      const stage = approveDirectionStage(
        projectRoot,
        confirmedBy,
        confirmation.evidence,
        confirmation.confirmed_at,
      );
      return {
        status: "reused",
        confirmation: outputPath,
        plan_sha256: confirmation.plan_sha256,
        stage_status: stage.stages.find((item) => item.id === "direction").status,
        next_action: stage.next_action,
      };
    }
    throw new Error(
      `确认合同已经存在且内容不同：${outputPath}。`
      + "入口不会覆盖确认记录；计划或证据变化时请明确使用新文件名。",
    );
  }
  writeJson(outputPath, confirmation);
  const stage = approveDirectionStage(
    projectRoot,
    confirmedBy,
    confirmation.evidence,
    confirmation.confirmed_at,
  );
  return {
    status: "created",
    confirmation: outputPath,
    plan_sha256: confirmation.plan_sha256,
    stage_status: stage.stages.find((item) => item.id === "direction").status,
    next_action: stage.next_action,
  };
}

export function assertPlanAndConfirmation(projectRoot, planRelative, confirmationRelative) {
  const planPath = projectPath(projectRoot, planRelative, "plan");
  const confirmationPath = projectPath(projectRoot, confirmationRelative, "confirmation");
  ensureFile(planPath, "计划");
  ensureFile(confirmationPath, "确认合同");
  const plan = readJson(planPath);
  const confirmation = readJson(confirmationPath);
  assertJsonSchema(
    plan,
    path.join(SCHEMA_DIR, "interview-explainer-plan.v2.schema.json"),
    "渲染计划",
  );
  assertJsonSchema(
    confirmation,
    path.join(SCHEMA_DIR, "interview-explainer-plan-confirmation.v1.schema.json"),
    "计划确认合同",
  );
  if (
    confirmation.protocol !== "visual-multimedia-interview-explainer-plan-confirmation"
    || confirmation.version !== 1
    || confirmation.status !== "confirmed"
    || confirmation.plan !== relativeProjectPath(projectRoot, planPath)
    || confirmation.plan_sha256 !== sha256File(planPath)
  ) {
    throw new Error("计划确认合同与当前计划不一致");
  }
  const generic = loadGenericState(projectRoot);
  assertStageApproved(generic.state, "direction");
  if (plan.producer?.sha256 !== sha256File(PUBLIC_ENTRY)) {
    throw new Error("公共生产脚本已经变化，当前计划确认失效");
  }
  const expectedModules = new Map(RENDER_PLAN_MODULES.map((target) => [
    slash(path.relative(SKILL_ROOT, target)),
    sha256File(target),
  ]));
  const plannedModules = plan.producer?.modules || [];
  if (
    plannedModules.length !== expectedModules.size
    || new Set(plannedModules.map((module) => module.file)).size !== expectedModules.size
  ) {
    throw new Error("计划没有完整绑定当前生产算法模块集合");
  }
  for (const module of plannedModules) {
    const target = path.resolve(SKILL_ROOT, module.file || "");
    const relative = path.relative(SKILL_ROOT, target);
    if (
      relative.startsWith("..")
      || path.isAbsolute(relative)
      || !fs.existsSync(target)
      || expectedModules.get(module.file) !== module.sha256
      || sha256File(target) !== module.sha256
    ) {
      throw new Error(`生产算法模块已经变化，当前计划确认失效：${module.file}`);
    }
  }
  const profilePath = path.resolve(SKILL_ROOT, plan.profile?.package || "");
  ensureFile(profilePath, "计划绑定的视频生产类型包");
  if (sha256File(profilePath) !== plan.profile?.package_sha256) {
    throw new Error("视频生产类型包已经变化，当前计划确认失效");
  }
  for (const input of plan.inputs || []) {
    const target = projectPath(projectRoot, input.file, `计划输入 ${input.role}`);
    const actual = hashPath(target);
    if (actual.sha256 !== input.sha256 || actual.bytes !== input.bytes) {
      throw new Error(`计划输入已经变化：${input.role} (${input.file})`);
    }
  }
  return {plan, planPath, confirmation, confirmationPath};
}
