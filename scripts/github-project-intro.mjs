#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {assertJsonSchema} from "./json_schema_contract.mjs";
import {readEditableMediaPackage} from "./editable-media-contract.mjs";
import {
  commandPath,
  escapeAssText,
  ffmpegFilterPath,
  formatAssTime,
  formatSrtTime,
  nowIso,
  parseArgs,
  probeMedia,
  projectPath,
  readJson,
  relativeProjectPath,
  requireArg,
  run,
  sha256File,
  toolVersion,
  writeJson,
} from "./interview_explainer_common.mjs";
import {
  buildUnitCacheKey,
  createMediaBuildPlan,
  fileDependency,
  validateMediaBuildPlan,
  validateMediaBuildReport,
} from "./media_build_contract.mjs";
import {loadLocalMediaEnvironment} from "./local-media-environment.mjs";
import {
  assemblePreparedVideoUnits,
  assertMediaFlowProVideoCapabilities,
  ensureMediaFlowProVideoProject,
  exportEditableWebScene,
} from "./mediaflow_video_common.mjs";
import {createOperationRun} from "./media_operation_run.mjs";
import {assertStageApproved, submitStage, validateProjectState} from "./media_project_state.mjs";
import {finalizeStandardVideo, reviewStandardVideo} from "./standard_video_delivery.mjs";
import {sha256Tree} from "./shot-recipe-library.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const STARTER = path.join(SKILL_ROOT, "assets", "media-project-starter");
const PROFILE_RELATIVE = "assets/video-production-profiles/github-project-intro/1.0.0/profile.json";
const PROFILE_PATH = path.join(SKILL_ROOT, ...PROFILE_RELATIVE.split("/"));
const SCHEMA = path.join(SKILL_ROOT, "schemas", "github-project-intro.v1.schema.json");
const PROJECT_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-project-state.v3.schema.json");
const BUILD_REPORT_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-build-report.v2.schema.json");
const RESOURCE_CLI = path.join(SCRIPT_DIR, "media-resource-library.mjs");
const DEFAULT_REGISTRY = process.platform === "win32"
  ? "D:\\Tools\\visual-multimedia-resources\\registry"
  : null;
const VOICE_ID = "game.honkai-star-rail.silverwolf.default";

function binding(projectRoot, file, label, schema = null) {
  const absolute = projectPath(projectRoot, file, label);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`${label}不存在：${absolute}`);
  const document = schema ? readJson(absolute) : null;
  if (schema) assertJsonSchema(document, schema, label);
  return {file, absolute, sha256: sha256File(absolute), document};
}

function assertBinding(projectRoot, value, label, schema = null) {
  const actual = binding(projectRoot, value.file, label, schema);
  if (actual.sha256 !== value.sha256) throw new Error(`${label}哈希已经失效：${value.file}`);
  return actual;
}

function loadSources(projectRoot) {
  const file = path.join(projectRoot, "media-sources.json");
  const document = readJson(file);
  return {file, document, byId: new Map(document.sources.map((item) => [item.id, item]))};
}

function ensureProjectId(value) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(value || "")) throw new Error("--project-id 只能使用小写字母、数字、点、下划线和连字符");
  return value;
}

function adoptOpeningAudio(projectRoot, projectId, registry, variant) {
  const itemId = variant === "today"
    ? "github-project-intro-today-silverwolf"
    : "github-project-intro-recently-silverwolf";
  const sourceId = `github-intro-${variant}-silverwolf`;
  const result = spawnSync(process.execPath, [
    RESOURCE_CLI,
    "adopt",
    "--registry", registry,
    "--library-id", "github-project-intro-voice-lines",
    "--version", "1.0.0",
    "--item-id", itemId,
    "--project", projectRoot,
    "--project-id", projectId,
    "--source-id", sourceId,
  ], {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`采用 GitHub 开场语音失败：\n${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  return {sourceId, itemId, adoption: payload.adoption};
}

export function createGithubProjectIntro(options) {
  const projectRoot = path.resolve(options.project);
  const projectId = ensureProjectId(options.projectId);
  const openingVariant = options.openingVariant || "recently";
  if (!new Set(["today", "recently"]).has(openingVariant)) throw new Error("opening variant 只能是 today 或 recently");
  if (openingVariant === "today" && options.sameDayConfirmed !== true) {
    throw new Error("使用‘今天’开场前必须通过 --same-day-confirmed true 明确确认同日事实");
  }
  const registry = path.resolve(options.registry || DEFAULT_REGISTRY || "");
  if (!registry || !fs.existsSync(path.join(registry, "registry.json"))) {
    throw new Error("找不到已注册的 GitHub 项目介绍开场语音；请用 --registry 指定注册表目录");
  }
  fs.mkdirSync(projectRoot, {recursive: true});
  for (const entry of fs.readdirSync(STARTER, {withFileTypes: true})) {
    if (!entry.isFile()) continue;
    const target = path.join(projectRoot, entry.name);
    if (fs.existsSync(target)) throw new Error(`项目已有 ${entry.name}；不会覆盖现有合同`);
    fs.copyFileSync(path.join(STARTER, entry.name), target, fs.constants.COPYFILE_EXCL);
  }
  for (const directory of ["components", "plans", "reports", "renders", "working"]) {
    fs.mkdirSync(path.join(projectRoot, directory), {recursive: true});
  }
  const opening = adoptOpeningAudio(projectRoot, projectId, registry, openingVariant);
  const statePath = path.join(projectRoot, "media-project-state.json");
  const state = readJson(statePath);
  state.project_id = projectId;
  state.media_kind = "mixed-video";
  state.profile = "github-project-intro@1.0.0";
  state.contracts.resource_adoptions = "media-resource-adoptions.json";
  state.next_action = "填写仓库事实、一个核心主张、真实证据和逐镜头双语旁白，再验证内容合同。";
  state.updated_at = nowIso();
  writeJson(statePath, state);
  assertJsonSchema(state, PROJECT_SCHEMA, "媒体项目状态");
  const brief = {
    protocol: "visual-multimedia-github-project-intro-brief",
    version: 1,
    project_id: projectId,
    profile: {id: "github-project-intro", version: "1.0.0"},
    repository: {
      name: "待替换仓库名",
      url: "https://github.com/owner/repository",
      audience: "待确认目标观众",
      interface_kind: "mixed",
      evidence_source_ids: ["replace-with-repository-evidence"],
    },
    content: {
      one_core_claim: "待确认整条视频只讲清楚的一个主张",
      confirmed_facts: ["待绑定已经核实的仓库事实"],
      call_to_action: "",
    },
    standards: {
      opening_variant: openingVariant,
      opening_audio_source_id: opening.sourceId,
      same_day_claim_confirmed: options.sameDayConfirmed === true,
      voice_id: VOICE_ID,
      speed_factor: 1.25,
      caption_languages: ["zh-CN", "en"],
      recommended_duration_seconds: {minimum: 60, maximum: 75},
      duration_user_specified: false,
      avatar: "none",
    },
    output: {
      file: "renders/github-project-intro-preview.mp4",
      width: 1920,
      height: 1080,
      fps: 30,
      audio_sample_rate: 48000,
      audio_channels: 2,
      caption_strategy: "burned-in",
    },
  };
  const draft = {
    protocol: "visual-multimedia-github-project-intro-draft",
    version: 1,
    project_id: projectId,
    shots: [{
      id: "opening",
      order: 1,
      purpose: "用当前项目重新制作的开场卡建立项目名称和核心主张",
      timeline_start_frame: 0,
      duration_frames: 90,
      visual: {
        kind: "media-source",
        source_id: "replace-with-repository-evidence",
        package: null,
        package_sha256: null,
        manifest_sha256: null,
        scene_id: null,
      },
      narration: {
        audio_source_id: opening.sourceId,
        zh: openingVariant === "today" ? "今天看到一个有意思的 GitHub 项目。" : "最近看到一个有意思的 GitHub 项目。",
        en: openingVariant === "today" ? "Today I found an interesting GitHub project." : "Recently I found an interesting GitHub project.",
        voice_id: VOICE_ID,
        speed_factor: 1.25,
      },
    }],
    review_promises: [{
      id: "one-core-claim",
      source_pointer: "/brief/file",
      promise: "整条视频只围绕 brief 中已经确认的一个核心主张。",
      expected_value: "github-project-intro-brief.json",
    }],
  };
  const briefPath = path.join(projectRoot, "github-project-intro-brief.json");
  const draftPath = path.join(projectRoot, "github-project-intro-draft.json");
  writeJson(briefPath, brief);
  writeJson(draftPath, draft);
  assertJsonSchema(brief, SCHEMA, "GitHub 项目介绍 brief");
  assertJsonSchema(draft, SCHEMA, "GitHub 项目介绍 draft");
  return {project: projectRoot, state: statePath, brief: briefPath, draft: draftPath, adopted_opening: opening};
}

function assertOpeningAdoption(projectRoot, brief) {
  const file = path.join(projectRoot, "media-resource-adoptions.json");
  if (!fs.existsSync(file)) throw new Error("项目没有开场语音采用记录");
  const adoptions = readJson(file).adoptions || [];
  const expectedItem = brief.standards.opening_variant === "today"
    ? "github-project-intro-today-silverwolf"
    : "github-project-intro-recently-silverwolf";
  const match = adoptions.find((item) => (
    item.library_id === "github-project-intro-voice-lines"
    && item.library_version === "1.0.0"
    && item.item_id === expectedItem
    && item.media_source_id === brief.standards.opening_audio_source_id
  ));
  if (!match) throw new Error("开场语音没有采用已注册的 today/recently 银狼素材");
  return match;
}

export function validateGithubProjectIntro(projectRoot, briefFile, draftFile) {
  const project = path.resolve(projectRoot);
  const brief = readJson(briefFile);
  const draft = readJson(draftFile);
  assertJsonSchema(brief, SCHEMA, "GitHub 项目介绍 brief");
  assertJsonSchema(draft, SCHEMA, "GitHub 项目介绍 draft");
  if (brief.project_id !== draft.project_id) throw new Error("brief 与 draft 的 project_id 不一致");
  const placeholders = JSON.stringify({brief, draft}).match(/待替换|待确认|待绑定|replace-with/gu) || [];
  if (placeholders.length) throw new Error("brief 或 draft 仍有待替换、待确认、待绑定内容");
  if (brief.standards.opening_variant === "today" && !brief.standards.same_day_claim_confirmed) {
    throw new Error("‘今天’开场没有同日事实确认");
  }
  const sources = loadSources(project);
  for (const id of brief.repository.evidence_source_ids) {
    if (!sources.byId.has(id)) throw new Error(`仓库证据 source id 不存在：${id}`);
  }
  assertOpeningAdoption(project, brief);
  const ids = new Set();
  let cursor = 0;
  for (let index = 0; index < draft.shots.length; index += 1) {
    const shot = draft.shots[index];
    if (shot.order !== index + 1 || shot.timeline_start_frame !== cursor) throw new Error(`镜头 ${shot.id} 的 order 或帧范围不连续`);
    if (ids.has(shot.id)) throw new Error(`镜头 id 重复：${shot.id}`);
    ids.add(shot.id);
    cursor += shot.duration_frames;
    const audio = sources.byId.get(shot.narration.audio_source_id);
    if (!audio || audio.media_type !== "audio") throw new Error(`镜头 ${shot.id} 没有绑定真实旁白音频 source`);
    if (
      shot.narration.audio_source_id !== brief.standards.opening_audio_source_id
      && audio.speech?.provider_voice_id !== VOICE_ID
    ) throw new Error(`镜头 ${shot.id} 的旁白没有绑定精确银狼声音身份`);
    if (shot.visual.kind === "media-source") {
      if (!shot.visual.source_id || !sources.byId.has(shot.visual.source_id)) throw new Error(`镜头 ${shot.id} 没有绑定真实画面 source`);
      if (shot.visual.package || shot.visual.package_sha256 || shot.visual.manifest_sha256 || shot.visual.scene_id) {
        throw new Error(`镜头 ${shot.id} 的 media-source 画面不能同时保留网页包字段`);
      }
    } else {
      if (shot.visual.source_id || !shot.visual.package || !shot.visual.scene_id) throw new Error(`镜头 ${shot.id} 的 editable-scene 字段不完整`);
      const packageRoot = projectPath(project, shot.visual.package, `镜头 ${shot.id} 网页包`);
      const editable = readEditableMediaPackage(packageRoot);
      if (sha256Tree(packageRoot) !== shot.visual.package_sha256) throw new Error(`镜头 ${shot.id} 网页包哈希失效`);
      if (sha256File(editable.manifestPath) !== shot.visual.manifest_sha256) throw new Error(`镜头 ${shot.id} 网页清单哈希失效`);
      if (!editable.manifest.scenes.some((item) => item.id === shot.visual.scene_id)) throw new Error(`镜头 ${shot.id} 找不到计划场景`);
    }
  }
  const duration = cursor / brief.output.fps;
  if (!brief.standards.duration_user_specified && (duration < 60 || duration > 75)) {
    throw new Error(`用户未指定时，GitHub 项目介绍应为 60–75 秒；当前为 ${duration.toFixed(2)} 秒`);
  }
  return {brief, draft, duration_seconds: duration};
}

export function createGithubProjectIntroPlan(projectRoot, briefFile, draftFile, outputFile) {
  const project = path.resolve(projectRoot);
  const {brief, draft} = validateGithubProjectIntro(project, briefFile, draftFile);
  const plan = {
    protocol: "visual-multimedia-github-project-intro-plan",
    version: 1,
    project_id: brief.project_id,
    created_at: nowIso(),
    profile: {id: "github-project-intro", version: "1.0.0", sha256: sha256File(PROFILE_PATH)},
    brief: {file: relativeProjectPath(project, briefFile), sha256: sha256File(briefFile)},
    draft: {file: relativeProjectPath(project, draftFile), sha256: sha256File(draftFile)},
    shots: draft.shots,
    review_promises: draft.review_promises,
    output: brief.output,
  };
  assertJsonSchema(plan, SCHEMA, "GitHub 项目介绍计划");
  if (fs.existsSync(outputFile)) throw new Error(`计划已存在，不会覆盖：${outputFile}`);
  writeJson(outputFile, plan);
  return plan;
}

export function validateGithubProjectIntroPlan(projectRoot, planFile) {
  const project = path.resolve(projectRoot);
  const plan = readJson(planFile);
  assertJsonSchema(plan, SCHEMA, "GitHub 项目介绍计划");
  if (plan.profile.sha256 !== sha256File(PROFILE_PATH)) throw new Error("计划绑定的 GitHub 项目介绍 profile 已失效");
  const brief = assertBinding(project, plan.brief, "brief", SCHEMA).document;
  const draft = assertBinding(project, plan.draft, "draft", SCHEMA).document;
  const validated = validateGithubProjectIntro(project, projectPath(project, plan.brief.file, "brief"), projectPath(project, plan.draft.file, "draft"));
  if (
    plan.project_id !== brief.project_id
    || JSON.stringify(plan.shots) !== JSON.stringify(draft.shots)
    || JSON.stringify(plan.output) !== JSON.stringify(brief.output)
  ) throw new Error("计划没有完整冻结当前 brief 和 draft");
  return {plan, brief, draft, ...validated};
}

export function confirmGithubProjectIntroPlan(projectRoot, planFile, outputFile, confirmedBy, evidence) {
  const project = path.resolve(projectRoot);
  const {plan} = validateGithubProjectIntroPlan(project, planFile);
  const confirmation = {
    protocol: "visual-multimedia-github-project-intro-plan-confirmation",
    version: 1,
    project_id: plan.project_id,
    plan: relativeProjectPath(project, planFile),
    plan_sha256: sha256File(planFile),
    confirmed_by: confirmedBy,
    confirmed_at: nowIso(),
    evidence,
  };
  assertJsonSchema(confirmation, SCHEMA, "GitHub 项目介绍计划确认");
  if (fs.existsSync(outputFile)) throw new Error(`确认记录已存在，不会覆盖：${outputFile}`);
  writeJson(outputFile, confirmation);
  return confirmation;
}

function executionContext(projectRoot, planFile, confirmationFile, buildPlanFile) {
  const project = path.resolve(projectRoot);
  const {plan, brief} = validateGithubProjectIntroPlan(project, planFile);
  const confirmation = readJson(confirmationFile);
  assertJsonSchema(confirmation, SCHEMA, "GitHub 项目介绍计划确认");
  if (
    confirmation.project_id !== plan.project_id
    || confirmation.plan !== relativeProjectPath(project, planFile)
    || confirmation.plan_sha256 !== sha256File(planFile)
  ) throw new Error("确认记录没有绑定当前 GitHub 项目介绍计划与哈希");
  const sources = loadSources(project);
  if (!fs.existsSync(buildPlanFile)) {
    const {caption_strategy: _captionStrategy, ...videoOutput} = plan.output;
    const build = createMediaBuildPlan({
      projectRoot: project,
      producerRoot: SKILL_ROOT,
      projectId: plan.project_id,
      mediaKind: "mixed-video",
      profile: "github-project-intro@1.0.0",
      stageTarget: "full-preview",
      sourceContract: relativeProjectPath(project, planFile),
      producerEntry: "scripts/github-project-intro.mjs",
      producerModules: ["scripts/mediaflow_video_common.mjs", "scripts/media_build_contract.mjs"],
      output: {...videoOutput, quality_profile: "proxy"},
      units: plan.shots.map((shot) => {
        const dependencies = [fileDependency(project, "narration-audio", sources.byId.get(shot.narration.audio_source_id).file)];
        if (shot.visual.kind === "media-source") {
          dependencies.push(fileDependency(project, "visual-source", sources.byId.get(shot.visual.source_id).file));
        } else {
          dependencies.push(fileDependency(project, "editable-manifest", `${shot.visual.package}/editable-media.json`));
        }
        return {
          id: shot.id,
          order: shot.order,
          kind: shot.visual.kind === "editable-scene" ? "editable-scene" : "pre-rendered-media",
          source_unit_id: shot.visual.kind === "editable-scene" ? shot.visual.scene_id : shot.visual.source_id,
          timeline_start_frame: shot.timeline_start_frame,
          duration_frames: shot.duration_frames,
          dependencies,
        };
      }),
      assembly: {strategy: "ordered-concat", audio_strategy: "unit-audio", caption_strategy: "burned-in"},
    });
    writeJson(buildPlanFile, build);
  }
  const buildPlan = validateMediaBuildPlan(readJson(buildPlanFile));
  if (
    buildPlan.profile !== "github-project-intro@1.0.0"
    || buildPlan.source_contract_sha256 !== sha256File(planFile)
  ) throw new Error("现有构建计划没有绑定当前 GitHub 项目介绍计划");
  return {project, plan, brief, confirmation, planFile, confirmationFile, buildPlan, buildPlanFile, sources};
}

function writeBilingualAss(plan, shot, target) {
  const duration = shot.duration_frames / plan.output.fps;
  const width = plan.output.width;
  const height = plan.output.height;
  const zhSize = Math.max(30, Math.round(height * 0.045));
  const enSize = Math.max(20, Math.round(height * 0.029));
  const outline = Math.max(2, Math.round(height * 0.003));
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`,
    "WrapStyle: 0", "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Chinese,Microsoft YaHei,${zhSize},&H00FFFFFF,&H000000FF,&H00101010,&H50000000,-1,0,0,0,100,100,0,0,1,${outline},1,2,110,110,108,1`,
    `Style: English,Arial,${enSize},&H00E4E4E4,&H000000FF,&H00101010,&H50000000,0,0,0,0,100,100,0,0,1,${outline},1,2,130,130,62,1`,
    "", "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 0,${formatAssTime(0)},${formatAssTime(duration)},Chinese,,0,0,0,,${escapeAssText(shot.narration.zh)}`,
    `Dialogue: 0,${formatAssTime(0)},${formatAssTime(duration)},English,,0,0,0,,${escapeAssText(shot.narration.en)}`,
    "",
  ];
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, lines.join("\n"), "utf8");
}

function writeFullSrt(plan, target) {
  const lines = [];
  for (const shot of plan.shots) {
    const start = shot.timeline_start_frame / plan.output.fps;
    const end = (shot.timeline_start_frame + shot.duration_frames) / plan.output.fps;
    lines.push(String(shot.order), `${formatSrtTime(start)} --> ${formatSrtTime(end)}`, shot.narration.zh, shot.narration.en, "");
  }
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, lines.join("\n"), "utf8");
}

function validCache(cachePath, outputPath, key, ffprobe, frames) {
  if (!fs.existsSync(cachePath) || !fs.existsSync(outputPath)) return null;
  try {
    const cache = readJson(cachePath);
    const probe = probeMedia(ffprobe, outputPath, true);
    if (cache.key !== key || cache.output_sha256 !== sha256File(outputPath) || probe.frames !== frames || !probe.has_audio || !probe.has_video) return null;
    return cache;
  } catch {
    return null;
  }
}

function prepareShot(context, shot, unit, environment, editor, ffmpeg, ffprobe, key) {
  const {project, plan, sources} = context;
  const rawVisual = projectPath(project, `working/github-project-intro/visual/${shot.id}.${key.slice(0, 12)}.mp4`, "raw visual");
  let visualInput;
  let imageInput = false;
  if (shot.visual.kind === "editable-scene") {
    const packageRoot = projectPath(project, shot.visual.package, `镜头 ${shot.id} 网页包`);
    const exported = exportEditableWebScene({
      environment,
      editorProject: editor.editorProject,
      projectId: plan.project_id,
      unitId: shot.id,
      packageRoot,
      durationFrames: shot.duration_frames,
      timelineStart: (shot.order - 1) * plan.output.fps * 600,
      outputPath: rawVisual,
      background: "#000000",
      requestKey: key.slice(0, 16),
      trackName: `GitHub project intro / ${sha256File(context.planFile).slice(0, 12)}`,
    });
    if (!fs.existsSync(rawVisual) || !fs.statSync(rawVisual).isFile()) {
      throw new Error(`镜头 ${shot.id} 的网页画面没有导出`);
    }
    visualInput = rawVisual;
  } else {
    const source = sources.byId.get(shot.visual.source_id);
    visualInput = projectPath(project, source.file, `镜头 ${shot.id} 画面 source`);
    imageInput = new Set(["photo", "screenshot", "video-frame", "icon", "generated"]).has(source.media_type);
  }
  const audioSource = sources.byId.get(shot.narration.audio_source_id);
  const audioInput = projectPath(project, audioSource.file, `镜头 ${shot.id} 旁白`);
  const ass = projectPath(project, `working/github-project-intro/captions/${shot.id}.${key.slice(0, 12)}.ass`, "bilingual captions");
  writeBilingualAss(plan, shot, ass);
  const output = projectPath(project, `renders/github-project-intro-units/${shot.id}.${key.slice(0, 12)}.mp4`, "prepared shot");
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const args = ["-hide_banner", "-loglevel", "error"];
  if (imageInput) args.push("-loop", "1");
  args.push("-i", visualInput, "-i", audioInput);
  const duration = shot.duration_frames / plan.output.fps;
  const filter = [
    `[0:v]fps=${plan.output.fps},scale=${plan.output.width}:${plan.output.height}:force_original_aspect_ratio=increase,crop=${plan.output.width}:${plan.output.height},tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${shot.duration_frames},setpts=PTS-STARTPTS,ass='${ffmpegFilterPath(ass)}',format=yuv420p[v]`,
    `[1:a]aresample=${plan.output.audio_sample_rate},aformat=channel_layouts=${plan.output.audio_channels === 1 ? "mono" : "stereo"},apad,atrim=duration=${duration.toFixed(6)}[a]`,
  ].join(";");
  args.push(
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a]",
    "-frames:v", String(shot.duration_frames),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(plan.output.fps),
    "-c:a", "aac", "-b:a", "192k", "-ar", String(plan.output.audio_sample_rate), "-ac", String(plan.output.audio_channels),
    "-movflags", "+faststart", "-y", output,
  );
  run(ffmpeg, args);
  const probe = probeMedia(ffprobe, output, true);
  if (probe.frames !== shot.duration_frames || !probe.has_audio || !probe.has_video) throw new Error(`镜头 ${shot.id} 的最终音画单元不完整`);
  return output;
}

function bindFullPreview(projectRoot, outputPath) {
  const statePath = path.join(projectRoot, "media-project-state.json");
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  const state = readJson(statePath);
  assertStageApproved(state, "integrated-sample");
  const stage = state.stages.find((item) => item.id === "full-preview");
  const relative = relativeProjectPath(projectRoot, outputPath);
  const sha = sha256File(outputPath);
  if (["waiting-approval", "approved"].includes(stage.status)) {
    const artifact = state.artifacts.find((item) => item.stage_id === "full-preview" && item.role === "full-preview");
    if (!artifact || artifact.file !== relative || artifact.sha256 !== sha) throw new Error("full-preview 已绑定其它成果；先使本阶段及下游失效");
    return validation;
  }
  submitStage(state, projectRoot, "full-preview", [{id: "github-project-intro-full-preview", role: "full-preview", kind: "video", file: relative}]);
  writeJson(statePath, state);
  const next = validateProjectState(statePath);
  if (!next.ok) throw new Error(`全量预览状态未通过：\n- ${next.errors.join("\n- ")}`);
  return next;
}

export function renderGithubProjectIntro(options, context) {
  const {project, plan, buildPlan, buildPlanFile} = context;
  const stateValidation = validateProjectState(path.join(project, "media-project-state.json"));
  if (!stateValidation.ok) throw new Error(`媒体项目状态未通过：\n- ${stateValidation.errors.join("\n- ")}`);
  assertStageApproved(readJson(path.join(project, "media-project-state.json")), "integrated-sample");
  const operation = createOperationRun("github-project-intro@1.0.0", "render");
  const operationPath = projectPath(project, options.operationReport || "reports/github-project-intro-render-run.json", "operation report");
  const reportPath = projectPath(project, options.report || "reports/media-build-report.json", "build report");
  const outputPath = projectPath(project, plan.output.file, "GitHub project intro output");
  const buildPlanSha = sha256File(buildPlanFile);
  if (fs.existsSync(outputPath) && fs.existsSync(reportPath)) {
    const existing = readJson(reportPath);
    if (existing.version === 2 && existing.build_plan_sha256 === buildPlanSha && existing.output.sha256 === sha256File(outputPath)) {
      operation.addStep("final-output", "reused", 0);
      operation.finish(operationPath);
      const next = bindFullPreview(project, outputPath);
      return {status: "reused", output: outputPath, report: reportPath, operation_report: operationPath, next_action: next.next_action};
    }
  }
  const ffmpeg = commandPath("ffmpeg", options.ffmpeg, "FFMPEG_BIN");
  const ffprobe = commandPath("ffprobe", options.ffprobe, "FFPROBE_BIN");
  const environment = loadLocalMediaEnvironment(options.localConfig);
  const contract = assertMediaFlowProVideoCapabilities(environment);
  const editor = ensureMediaFlowProVideoProject(environment, contract, {
    name: `${plan.project_id} · GitHub project intro web shots`,
    directoryName: `github-project-intro-${buildPlanSha}`,
    requestId: `github-project-intro-project-${buildPlanSha}`,
  }, plan.output);
  const unitsById = new Map(buildPlan.units.map((item) => [item.id, item]));
  const prepared = [];
  for (const shot of plan.shots) {
    const started = Date.now();
    const unit = unitsById.get(shot.id);
    const key = buildUnitCacheKey(buildPlan, unit, {shot, output: plan.output});
    const output = projectPath(project, `renders/github-project-intro-units/${shot.id}.${key.slice(0, 12)}.mp4`, "prepared shot");
    const cachePath = projectPath(project, `working/github-project-intro/cache/${shot.id}.${key.slice(0, 12)}.json`, "shot cache");
    let cache = validCache(cachePath, output, key, ffprobe, shot.duration_frames);
    let status = "reused";
    if (!cache) {
      status = "rendered";
      const rendered = prepareShot(context, shot, unit, environment, editor, ffmpeg, ffprobe, key);
      cache = {key, output_sha256: sha256File(rendered), frames: shot.duration_frames, created_at: nowIso()};
      writeJson(cachePath, cache);
    }
    operation.addStep(shot.id, status, Date.now() - started);
    prepared.push({
      id: shot.id,
      absoluteFile: output,
      file: relativeProjectPath(project, output),
      sha256: sha256File(output),
      bytes: fs.statSync(output).size,
      frames: shot.duration_frames,
      timelineStartFrame: shot.timeline_start_frame,
      cache_key: key,
      status,
    });
  }
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const assemblyStarted = Date.now();
  const assembled = assemblePreparedVideoUnits({
    environment,
    contract,
    projectSpec: {
      name: `${plan.project_id} · GitHub project intro assembly`,
      directoryName: `github-project-intro-assembly-${buildPlanSha}`,
      requestId: `github-project-intro-assembly-${buildPlanSha}`,
    },
    output: plan.output,
    units: prepared,
    outputPath,
    presetName: "GitHub project intro preview",
    requestKey: buildPlanSha.slice(0, 16),
  });
  const captionsPath = projectPath(project, "captions/github-project-intro-bilingual.srt", "bilingual captions");
  writeFullSrt(plan, captionsPath);
  const probe = probeMedia(ffprobe, outputPath, true);
  const expectedFrames = buildPlan.units.reduce((sum, item) => sum + item.duration_frames, 0);
  if (!probe.has_audio || !probe.has_video || probe.frames !== expectedFrames || probe.width !== plan.output.width || probe.height !== plan.output.height) {
    throw new Error("GitHub 项目介绍最终文件的音画、帧数或尺寸不符合计划");
  }
  const localById = new Map(prepared.map((item) => [item.id, item]));
  const report = {
    protocol: "visual-multimedia-media-build-report",
    version: 2,
    profile: "github-project-intro",
    build_plan: relativeProjectPath(project, buildPlanFile),
    build_plan_sha256: buildPlanSha,
    producer: {
      entry: "scripts/github-project-intro.mjs",
      sha256: sha256File(SCRIPT_PATH),
      tools: {node: process.version, ffmpeg: toolVersion(ffmpeg), ffprobe: toolVersion(ffprobe), mediaflow_pro: String(contract.version)},
    },
    units: assembled.outcome.units.map((item) => {
      const local = localById.get(item.id);
      return {id: item.id, file: local.file, sha256: local.sha256, bytes: local.bytes, frames: local.frames, status: local.status === "rendered" || item.status === "rendered" ? "rendered" : "reused", cache_key: item.cache_key};
    }),
    audio: {strategy: "unit-audio", status: "included-in-units", file: null, sha256: null, cache_key: null},
    captions: {
      mode: "burned-in",
      file: relativeProjectPath(project, captionsPath),
      sha256: sha256File(captionsPath),
      render_file: relativeProjectPath(project, outputPath),
      render_sha256: sha256File(outputPath),
      visible_in_standalone_output: true,
    },
    assembly: {status: assembled.outcome.assembly_status, cache_key: assembled.outcome.assembly_key},
    output: {file: relativeProjectPath(project, outputPath), sha256: sha256File(outputPath), bytes: fs.statSync(outputPath).size, frames: probe.frames, duration_seconds: probe.duration_seconds, width: probe.width, height: probe.height, fps: probe.fps, audio_sample_rate: probe.audio_sample_rate, audio_channels: probe.audio_channels},
    completed_at: nowIso(),
  };
  assertJsonSchema(validateMediaBuildReport(report), BUILD_REPORT_SCHEMA, "GitHub 项目介绍构建报告");
  writeJson(reportPath, report);
  operation.addStep(
    "assembly",
    assembled.outcome.assembly_status === "reused" ? "reused" : "rendered",
    Date.now() - assemblyStarted,
  );
  operation.finish(operationPath);
  const next = bindFullPreview(project, outputPath);
  return {status: "rendered", output: outputPath, output_sha256: report.output.sha256, report: reportPath, operation_report: operationPath, mediaflow_project: assembled.editorProject, next_action: next.next_action};
}

function usage() {
  console.error("用法：node scripts/github-project-intro.mjs <create|validate|plan|confirm-plan|render|review|finalize> --project <目录> ...");
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!new Set(["create", "validate", "plan", "confirm-plan", "render", "review", "finalize"]).has(command)) {
    usage();
    process.exitCode = 2;
    return;
  }
  const project = path.resolve(requireArg(args, "project"));
  if (command === "create") {
    const result = createGithubProjectIntro({
      project,
      projectId: requireArg(args, "project-id"),
      registry: args.registry,
      openingVariant: args.opening || "recently",
      sameDayConfirmed: args["same-day-confirmed"] === "true",
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const brief = projectPath(project, args.brief || "github-project-intro-brief.json", "brief");
  const draft = projectPath(project, args.draft || "github-project-intro-draft.json", "draft");
  if (command === "validate") {
    console.log(JSON.stringify(validateGithubProjectIntro(project, brief, draft), null, 2));
    return;
  }
  const plan = projectPath(project, args.plan || "github-project-intro-plan.json", "plan");
  if (command === "plan") {
    console.log(JSON.stringify(createGithubProjectIntroPlan(project, brief, draft, plan), null, 2));
    return;
  }
  if (command === "confirm-plan") {
    const output = projectPath(project, args.output || "github-project-intro-plan-confirmation.json", "confirmation output");
    console.log(JSON.stringify(confirmGithubProjectIntroPlan(project, plan, output, requireArg(args, "confirmed-by"), requireArg(args, "evidence")), null, 2));
    return;
  }
  const confirmation = projectPath(project, args.confirmation || "github-project-intro-plan-confirmation.json", "confirmation");
  const buildPlan = projectPath(project, args["build-plan"] || "media-build-plan.json", "build plan");
  const context = executionContext(project, plan, confirmation, buildPlan);
  if (command === "render") {
    console.log(JSON.stringify(renderGithubProjectIntro({
      ffmpeg: args.ffmpeg,
      ffprobe: args.ffprobe,
      localConfig: args["local-config"],
      report: args.report,
      operationReport: args["operation-report"],
    }, context), null, 2));
    return;
  }
  if (command === "review") {
    console.log(JSON.stringify(reviewStandardVideo({
      project,
      profile: "github-project-intro@1.0.0",
      plan: relativeProjectPath(project, plan),
      confirmation: relativeProjectPath(project, confirmation),
      buildReport: args.report || "reports/media-build-report.json",
      review: args.review || "media-review.json",
      machineReport: args["machine-report"],
      contactSheet: args["contact-sheet"],
      ffmpeg: args.ffmpeg,
      ffprobe: args.ffprobe,
      python: args.python,
      agentStatus: args["agent-status"] || "pending",
      agentCompleted: args["agent-status"] && args["agent-status"] !== "pending",
      agentEvidence: args["agent-evidence"] || "",
      userRequired: args["user-required"] === "true",
      userStatus: args["user-status"],
      userEvidence: args["user-evidence"] || "",
    }), null, 2));
    return;
  }
  console.log(JSON.stringify(finalizeStandardVideo({
    project,
    profile: "github-project-intro@1.0.0",
    plan: relativeProjectPath(project, plan),
    confirmation: relativeProjectPath(project, confirmation),
    buildReport: args.report || "reports/media-build-report.json",
    review: args.review || "media-review.json",
    delivery: args.delivery || "media-delivery.json",
    ffprobe: args.ffprobe,
    python: args.python,
    audioRequired: true,
    captionsRequired: true,
  }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
