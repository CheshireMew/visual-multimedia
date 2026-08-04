#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {readEditableMediaPackage} from "./editable-media-contract.mjs";
import {
  loadLocalMediaEnvironment,
  mediaFlowProDescribe,
  mediaFlowProExecute,
} from "./local-media-environment.mjs";
import {materializeShotRecipe, sha256Tree} from "./shot-recipe-library.mjs";
import {validateVideoDirectionPlan} from "./validate-video-direction-plan.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_SCHEMA = path.join(SKILL_ROOT, "schemas", "explanatory-broll-studio.v1.schema.json");
const TIMING_SCHEMA = path.join(SKILL_ROOT, "schemas", "video-direction-timing-projection.v1.schema.json");
const GALLERY_ENTRY = "/assets/shot-recipe-library/index.html";
const REQUIRED_OPERATIONS = [
  "project.create", "project.inspect", "web.import", "timeline.get",
  "timeline.track.add", "timeline.clip.add", "web.clip.variant.select",
  "web.clip.data.update", "web.clip.theme.update", "web.clip.export",
];

function usage() {
  console.log(`用法：
node scripts/explanatory-broll-studio.mjs serve --project <媒体项目目录>
  [--plan <video-direction-plan.json>] [--editor-project <MediaFlow Pro 工程>]
  [--host 127.0.0.1] [--port 4178]

node scripts/explanatory-broll-studio.mjs apply-plan --project <媒体项目目录>
  --timings <video-direction-timing-projection.json>
  [--plan <video-direction-plan.json>] [--editor-project <MediaFlow Pro 工程>]

node scripts/explanatory-broll-studio.mjs export --project <媒体项目目录>
  --selection-id <selection id> --format <png|gif|video|alpha_video|overlay>

浏览器入口会显示真实活动模板，可编辑当前场景的数据和主题，并通过 MediaFlow Pro
导入时间线、选择布局及导出 PNG / GIF / 视频 / 透明视频。`);
}

function parseArgs(argv) {
  const result = {_: []};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} 缺少值`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 --${key}`);
  return value;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compactManifest(value) {
  if (Array.isArray(value)) {
    const items = value.map(compactManifest).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, compactManifest(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === null ? undefined : value;
}

function containsValues(actual, expected) {
  return Object.entries(expected).every(([key, value]) => canonical(actual?.[key]) === canonical(value));
}

function stableId(value) {
  return String(value || "project")
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "project";
}

function projectRelative(projectRoot, target) {
  const relative = path.relative(projectRoot, path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`文件不在媒体项目内：${target}`);
  }
  return relative.split(path.sep).join("/");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeState(projectRoot, state) {
  assertJsonSchema(state, STATE_SCHEMA, "解释型 B-roll Studio 状态");
  const target = path.join(projectRoot, "explanatory-broll-studio.json");
  const candidate = `${target}.candidate`;
  fs.writeFileSync(candidate, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(candidate, target);
  return target;
}

function loadState(projectRoot) {
  const target = path.join(projectRoot, "explanatory-broll-studio.json");
  if (!fs.existsSync(target)) return null;
  const state = readJson(target);
  assertJsonSchema(state, STATE_SCHEMA, "解释型 B-roll Studio 状态");
  return state;
}

function directionPlan(projectRoot, explicit) {
  const target = explicit
    ? path.resolve(explicit)
    : path.join(projectRoot, "video-direction-plan.json");
  if (!fs.existsSync(target)) return null;
  const plan = readJson(target);
  if (plan.protocol !== "visual-multimedia-video-direction" || plan.version !== 2) {
    throw new Error(`Studio 只读取 video-direction-plan v2：${target}`);
  }
  return {target, plan};
}

function profileForAspect(aspect, fps = 30) {
  const dimensions = aspect === "9:16"
    ? [1080, 1920]
    : aspect === "1:1" ? [1080, 1080] : [1920, 1080];
  return {
    width: dimensions[0],
    height: dimensions[1],
    fps_numerator: fps,
    fps_denominator: 1,
    color_mode: "sdr_bt709",
    bit_depth: 8,
    audio_sample_rate: 48000,
    audio_channels: 2,
  };
}

function assertMediaFlowContract(environment) {
  const describe = mediaFlowProDescribe(environment);
  const operations = new Set((describe.operations || []).map((item) => item.name));
  const missing = REQUIRED_OPERATIONS.filter((name) => !operations.has(name));
  if (missing.length) throw new Error(`MediaFlow Pro 缺少能力：${missing.join(", ")}`);
  return describe;
}

function ensureEditorProject(context, aspect, fps = 30) {
  const {projectRoot, environment, contract, explicitEditorProject} = context;
  let state = loadState(projectRoot);
  let editorProject = explicitEditorProject || state?.editor_project || null;
  if (!editorProject) {
    const projectId = stableId(path.basename(projectRoot));
    const directoryName = `vm-broll-${projectId}-${sha256Buffer(projectRoot).slice(0, 8)}`;
    const expected = path.join(contract.default_project_root, directoryName);
    if (fs.existsSync(path.join(expected, "project.mfp"))) {
      editorProject = expected;
    } else {
      const created = mediaFlowProExecute(
        environment,
        null,
        "project.create",
        {
          name: `${path.basename(projectRoot)} · 解释型 B-roll`,
          directory_name: directoryName,
          profile: profileForAspect(aspect, fps),
        },
        `explanatory-broll-project-${sha256Buffer(projectRoot).slice(0, 24)}`,
      );
      editorProject = path.resolve(created.path || "");
    }
  }
  const inspected = mediaFlowProExecute(environment, editorProject, "project.inspect", {});
  const sequenceId = inspected.project?.main_sequence_id;
  if (!sequenceId) throw new Error("MediaFlow Pro 工程没有主时间线");
  const expectedProfile = profileForAspect(aspect, fps);
  const sequence = (inspected.sequences || []).find((item) => item.id === sequenceId);
  for (const key of ["width", "height", "fps_numerator", "fps_denominator"]) {
    if (sequence?.profile?.[key] !== expectedProfile[key]) {
      throw new Error(`MediaFlow Pro 主时间线 ${key}=${sequence?.profile?.[key]}，与当前 B-roll ${expectedProfile[key]} 不一致`);
    }
  }
  let timeline = mediaFlowProExecute(
    environment, editorProject, "timeline.get", {sequence_id: sequenceId},
  ).timeline;
  let track = (timeline.tracks || []).find((item) => item.name === "Visual Multimedia / Explanatory B-roll");
  if (!track) {
    track = mediaFlowProExecute(
      environment,
      editorProject,
      "timeline.track.add",
      {sequence_id: sequenceId, kind: "video", name: "Visual Multimedia / Explanatory B-roll"},
      `explanatory-broll-track-${sha256Buffer(editorProject).slice(0, 24)}`,
    ).track;
  }
  if (!state) {
    state = {
      protocol: "visual-multimedia-explanatory-broll-studio",
      version: 1,
      project_id: stableId(path.basename(projectRoot)),
      editor_project: editorProject,
      sequence_id: sequenceId,
      track_id: track.id,
      fps,
      timing_projections: [],
      clips: [],
      updated_at: new Date().toISOString(),
    };
  } else if (
    path.resolve(state.editor_project) !== path.resolve(editorProject)
    || state.sequence_id !== sequenceId
    || state.track_id !== track.id
    || state.fps !== fps
  ) {
    throw new Error("Studio 状态与 MediaFlow Pro 工程边界不一致；拒绝猜测恢复");
  }
  writeState(projectRoot, state);
  return state;
}

function sceneTiming(packageRoot, sceneId) {
  const editable = readEditableMediaPackage(packageRoot);
  const index = editable.manifest.scenes.findIndex((item) => item.id === sceneId);
  if (index < 0) throw new Error(`editable-media 不存在场景 ${sceneId}`);
  const fps = Number(editable.manifest.playback?.fps || 30);
  const startMs = editable.manifest.scenes.slice(0, index).reduce(
    (sum, item) => sum + Number(item.duration_ms), 0,
  );
  const durationMs = Number(editable.manifest.scenes[index].duration_ms);
  return {
    sourceIn: Math.round(startMs * fps / 1000),
    durationFrames: Math.round(durationMs * fps / 1000),
  };
}

function synchronizeRootMetadata(html, metadata) {
  let synchronized = html;
  for (const [attribute, value] of Object.entries(metadata)) {
    const pattern = new RegExp(`(\\b${attribute}=")[^"]*(")`, "gu");
    const matches = synchronized.match(pattern) || [];
    if (matches.length !== 1) {
      throw new Error(`editable-media 入口必须且只能声明一个 ${attribute}`);
    }
    synchronized = synchronized.replace(pattern, `$1${value}$2`);
  }
  return synchronized;
}

function deriveRuntimePackage(projectRoot, sourcePackage, selection, durationFrames, fps) {
  const editable = readEditableMediaPackage(sourcePackage);
  const scene = editable.manifest.scenes.find((item) => item.id === selection.scene_id);
  if (!scene) throw new Error(`editable-media 不存在场景 ${selection.scene_id}`);
  const variant = editable.manifest.variants.find((item) => item.id === selection.variant_id);
  if (!variant) throw new Error(`editable-media 不存在变体 ${selection.variant_id}`);
  const durationMs = Math.max(1, Math.round(durationFrames * 1000 / fps));
  const scale = durationMs / Number(scene.duration_ms);
  const derivedScene = {
    ...scene,
    duration_ms: durationMs,
    steps: scene.steps.map((step, index) => ({
      ...step,
      at_ms: index === 0 ? 0 : Math.min(durationMs - 1, Math.max(0, Math.round(step.at_ms * scale))),
    })),
  };
  const manifest = {
    ...editable.manifest,
    playback: {...editable.manifest.playback, fps},
    default_variant_id: variant.id,
    scenes: [derivedScene],
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha = sha256Buffer(Buffer.from(serialized, "utf8"));
  const sourceEntry = fs.readFileSync(path.join(sourcePackage, manifest.entry), "utf8");
  const synchronizedEntry = synchronizeRootMetadata(sourceEntry, {
    "data-duration": durationMs / 1000,
    "data-width": variant.canvas.width,
    "data-height": variant.canvas.height,
    "data-fps": fps,
  });
  const destination = path.join(
    projectRoot,
    "components",
    "shot-recipe-runtimes",
    selection.selection_id,
    `${fps}fps-${durationFrames}f-${manifestSha.slice(0, 16)}`,
  );
  if (fs.existsSync(destination)) {
    if (
      !fs.statSync(destination).isDirectory()
      || fs.readFileSync(path.join(destination, "editable-media.json"), "utf8") !== serialized
      || fs.readFileSync(path.join(destination, manifest.entry), "utf8") !== synchronizedEntry
    ) {
      throw new Error(`派生运行包已存在但内容不同：${destination}`);
    }
  } else {
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.cpSync(sourcePackage, destination, {recursive: true, errorOnExist: true, force: false});
    fs.writeFileSync(path.join(destination, "editable-media.json"), serialized, "utf8");
    fs.writeFileSync(path.join(destination, manifest.entry), synchronizedEntry, "utf8");
  }
  readEditableMediaPackage(destination);
  return {
    package: destination,
    packageSha256: sha256Tree(destination),
    manifestSha256: manifestSha,
  };
}

function nextTimelineStart(context, state) {
  const timeline = mediaFlowProExecute(
    context.environment,
    state.editor_project,
    "timeline.get",
    {sequence_id: state.sequence_id},
  ).timeline;
  return (timeline.clips || [])
    .filter((clip) => clip.track_id === state.track_id)
    .reduce((maximum, clip) => Math.max(maximum, clip.timeline_start + clip.duration), 0);
}

function attachClip(context, payload) {
  const materialized = materializeShotRecipe({
    projectRoot: context.projectRoot,
    recipeId: payload.recipe_id || null,
    styleId: payload.style_id || null,
    variantId: payload.variant_id || null,
    segmentId: payload.segment_id || null,
    visualSourceKind: payload.visual_source_kind,
    relationshipKind: payload.relationship_kind ?? null,
    placementMode: payload.placement_mode,
    aspectRatio: payload.aspect_ratio,
    selectionReason: payload.selection_reason,
  });
  const selection = materialized.document;
  const fps = Number.isInteger(payload.fps) ? payload.fps : 30;
  const state = ensureEditorProject(context, selection.aspect_ratio, fps);
  const selectionSha = sha256File(materialized.selection);
  const existing = state.clips.find((item) => item.selection.sha256 === selectionSha);
  if (existing) {
    if (
      (Number.isInteger(payload.timeline_start_frame) && existing.timeline_start_frame !== payload.timeline_start_frame)
      || (Number.isInteger(payload.duration_frames) && existing.duration_frames !== payload.duration_frames)
    ) {
      throw new Error(`selection ${selection.selection_id} 已绑定其它真实时间；不会静默移动`);
    }
    return {state, binding: existing, selection};
  }
  const timing = sceneTiming(materialized.package, selection.scene_id);
  const durationFrames = Number.isInteger(payload.duration_frames)
    ? payload.duration_frames
    : timing.durationFrames;
  const runtime = deriveRuntimePackage(
    context.projectRoot, materialized.package, selection, durationFrames, fps,
  );
  const editable = readEditableMediaPackage(runtime.package);
  const inspected = mediaFlowProExecute(
    context.environment, state.editor_project, "project.inspect", {},
  );
  const registered = (inspected.web_assets || []).find((item) => (
    item.manifest?.component?.id === editable.manifest.component?.id
    && canonical(compactManifest(item.manifest)) === canonical(compactManifest(editable.manifest))
  ));
  const imported = registered ? null : mediaFlowProExecute(
    context.environment,
    state.editor_project,
    "web.import",
    {source: runtime.package},
    `broll-import-${selectionSha.slice(0, 16)}-${runtime.packageSha256.slice(0, 16)}`,
  );
  const assetId = registered?.asset_id || imported?.asset?.id;
  if (!assetId) throw new Error("MediaFlow Pro 没有返回 Web 素材 id");
  const timelineStart = Number.isInteger(payload.timeline_start_frame)
    ? payload.timeline_start_frame
    : nextTimelineStart(context, state);
  const timeline = mediaFlowProExecute(
    context.environment,
    state.editor_project,
    "timeline.get",
    {sequence_id: state.sequence_id},
  ).timeline;
  let clip = (timeline.clips || []).find((item) => (
    item.track_id === state.track_id
    && item.asset_id === assetId
    && item.timeline_start === timelineStart
    && item.source_in === 0
    && item.duration === durationFrames
  ));
  if (!clip) {
    clip = mediaFlowProExecute(
      context.environment,
      state.editor_project,
      "timeline.clip.add",
      {
        sequence_id: state.sequence_id,
        track_id: state.track_id,
        asset_id: assetId,
        timeline_start: timelineStart,
        source_in: 0,
        duration: durationFrames,
      },
      `broll-clip-${selectionSha.slice(0, 24)}-${timelineStart}-${durationFrames}`,
    ).clip;
  }
  const binding = {
    selection_id: selection.selection_id,
    selection: {
      file: projectRelative(context.projectRoot, materialized.selection),
      sha256: selectionSha,
      bytes: fs.statSync(materialized.selection).size,
    },
    segment_id: selection.segment_id,
    recipe_id: selection.recipe_id,
    style_id: selection.style_id,
    scene_id: selection.scene_id,
    variant_id: selection.variant_id,
    runtime_package: projectRelative(context.projectRoot, runtime.package),
    runtime_package_sha256: runtime.packageSha256,
    runtime_manifest_sha256: runtime.manifestSha256,
    asset_id: assetId,
    clip_id: clip.id,
    timeline_start_frame: timelineStart,
    duration_frames: durationFrames,
  };
  state.clips.push(binding);
  state.updated_at = new Date().toISOString();
  writeState(context.projectRoot, state);
  let webState = mediaFlowProExecute(
    context.environment, state.editor_project, "web.clip.get", {clip_id: clip.id},
  ).web_clip_state;
  if (webState.variant?.id !== selection.variant_id) {
    mediaFlowProExecute(
      context.environment,
      state.editor_project,
      "web.clip.variant.select",
      {sequence_id: state.sequence_id, clip_id: clip.id, variant_id: selection.variant_id},
      `broll-variant-${selectionSha.slice(0, 18)}-r${webState.revision}`,
    );
    webState = mediaFlowProExecute(
      context.environment, state.editor_project, "web.clip.get", {clip_id: clip.id},
    ).web_clip_state;
  }
  const values = payload.values && typeof payload.values === "object" ? payload.values : {};
  if (
    Object.keys(values).length
    && !containsValues(webState.scenes?.[selection.scene_id]?.data_snapshot?.values, values)
  ) {
    mediaFlowProExecute(
      context.environment,
      state.editor_project,
      "web.clip.data.update",
      {
        sequence_id: state.sequence_id,
        clip_id: clip.id,
        scene_id: selection.scene_id,
        values,
        source_kind: "inline",
        source_label: "Explanatory B-roll Studio",
      },
      `broll-data-${selectionSha.slice(0, 16)}-${sha256Buffer(JSON.stringify(values)).slice(0, 10)}-r${webState.revision}`,
    );
    webState = mediaFlowProExecute(
      context.environment, state.editor_project, "web.clip.get", {clip_id: clip.id},
    ).web_clip_state;
  }
  const theme = payload.theme && typeof payload.theme === "object" ? payload.theme : {};
  if (Object.keys(theme).length && !containsValues(webState.theme, theme)) {
    mediaFlowProExecute(
      context.environment,
      state.editor_project,
      "web.clip.theme.update",
      {sequence_id: state.sequence_id, clip_id: clip.id, changes: theme},
      `broll-theme-${selectionSha.slice(0, 16)}-${sha256Buffer(JSON.stringify(theme)).slice(0, 10)}-r${webState.revision}`,
    );
  }
  return {state, binding, selection};
}

function updateClip(context, payload) {
  const state = loadState(context.projectRoot);
  if (!state) throw new Error("先把模板加入时间线，再编辑实际片段");
  const binding = state.clips.find((item) => item.selection_id === payload.selection_id);
  if (!binding) throw new Error(`Studio 状态不存在 selection ${payload.selection_id}`);
  mediaFlowProExecute(context.environment, state.editor_project, "project.inspect", {});
  let webState = mediaFlowProExecute(
    context.environment, state.editor_project, "web.clip.get", {clip_id: binding.clip_id},
  ).web_clip_state;
  if (
    payload.values
    && Object.keys(payload.values).length
    && !containsValues(webState.scenes?.[binding.scene_id]?.data_snapshot?.values, payload.values)
  ) {
    mediaFlowProExecute(
      context.environment, state.editor_project, "web.clip.data.update",
      {
        sequence_id: state.sequence_id,
        clip_id: binding.clip_id,
        scene_id: binding.scene_id,
        values: payload.values,
        source_kind: "inline",
        source_label: "Explanatory B-roll Studio",
      },
      `broll-data-${binding.selection.sha256.slice(0, 14)}-${sha256Buffer(JSON.stringify(payload.values)).slice(0, 10)}-r${webState.revision}`,
    );
    webState = mediaFlowProExecute(
      context.environment, state.editor_project, "web.clip.get", {clip_id: binding.clip_id},
    ).web_clip_state;
  }
  if (payload.theme && Object.keys(payload.theme).length && !containsValues(webState.theme, payload.theme)) {
    mediaFlowProExecute(
      context.environment, state.editor_project, "web.clip.theme.update",
      {sequence_id: state.sequence_id, clip_id: binding.clip_id, changes: payload.theme},
      `broll-theme-${binding.selection.sha256.slice(0, 14)}-${sha256Buffer(JSON.stringify(payload.theme)).slice(0, 10)}-r${webState.revision}`,
    );
  }
  state.updated_at = new Date().toISOString();
  writeState(context.projectRoot, state);
  return {state, binding};
}

function exportClip(context, payload) {
  const state = loadState(context.projectRoot);
  if (!state) throw new Error("Studio 没有已加入时间线的片段");
  const binding = state.clips.find((item) => item.selection_id === payload.selection_id);
  if (!binding) throw new Error(`找不到 selection ${payload.selection_id}`);
  const format = payload.format;
  const extensions = {png: "png", gif: "gif", video: "mp4", alpha_video: "mkv", overlay: "mkv"};
  if (!extensions[format]) throw new Error(`不支持导出格式：${format}`);
  const suffix = format === "alpha_video" ? ".alpha" : format === "overlay" ? ".overlay" : "";
  const output = payload.output_path
    ? path.resolve(payload.output_path)
    : path.join(context.projectRoot, "renders", "explanatory-broll", `${binding.selection_id}${suffix}.${extensions[format]}`);
  fs.mkdirSync(path.dirname(output), {recursive: true});
  mediaFlowProExecute(context.environment, state.editor_project, "project.inspect", {});
  const exported = mediaFlowProExecute(
    context.environment,
    state.editor_project,
    "web.clip.export",
    {
      sequence_id: state.sequence_id,
      clip_id: binding.clip_id,
      output_path: output,
      format,
      ...(format === "png" ? {time_ms: Number.isInteger(payload.time_ms) ? payload.time_ms : 2200} : {}),
      background: payload.background || (format === "alpha_video" || format === "overlay" ? null : "#0b0a10"),
      overwrite: true,
      timeout: 1800,
    },
    `broll-export-${binding.selection.sha256.slice(0, 18)}-${format}-${sha256Buffer(output).slice(0, 10)}`,
  );
  if (exported.task?.status !== "completed") throw new Error(`MediaFlow Pro 导出未完成：${JSON.stringify(exported.task)}`);
  return {file: output, format, bytes: fs.statSync(output).size, sha256: sha256File(output), task: exported.task};
}

function contextDocument(context) {
  const plan = context.plan?.plan || null;
  return {
    protocol: "visual-multimedia-explanatory-broll-studio-context",
    version: 1,
    enabled: true,
    project: context.projectRoot,
    direction_plan: context.plan?.target || null,
    segments: (plan?.scenes || []).map((scene) => ({
      segment_id: scene.segment_id,
      purpose: scene.purpose,
      ...scene.visual_plan,
    })),
    state: loadState(context.projectRoot),
    export_formats: ["png", "gif", "video", "alpha_video", "overlay"],
  };
}

function assertFileBinding(projectRoot, binding, label) {
  const target = path.resolve(projectRoot, ...(binding.file || "").split("/"));
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(target, {throwIfNoEntry: false})?.isFile()) {
    throw new Error(`${label} 不是项目内真实文件：${binding.file}`);
  }
  if (fs.statSync(target).size !== binding.bytes || sha256File(target) !== binding.sha256) {
    throw new Error(`${label} 的字节数或 SHA-256 与实际文件不一致`);
  }
  return target;
}

function applyDirectionPlan(context, timingPath) {
  if (!context.plan) throw new Error("apply-plan 需要 video-direction-plan.json");
  const planValidation = validateVideoDirectionPlan(context.plan.target);
  if (!planValidation.ok) {
    throw new Error(`导演计划未通过：\n- ${planValidation.errors.join("\n- ")}`);
  }
  const absoluteTiming = path.resolve(timingPath);
  const timing = readJson(absoluteTiming);
  assertJsonSchema(timing, TIMING_SCHEMA, "导演计划真实时间投影");
  const boundPlan = assertFileBinding(context.projectRoot, timing.direction_plan, "timing.direction_plan");
  if (path.resolve(boundPlan) !== path.resolve(context.plan.target)) {
    throw new Error("真实时间投影没有绑定当前导演计划");
  }
  assertFileBinding(context.projectRoot, timing.source_timeline, "timing.source_timeline");
  const timings = new Map(timing.segments.map((item) => [item.segment_id, item]));
  const bindings = [];
  for (const scene of planValidation.plan.scenes) {
    if (!scene.visual_plan.recipe) continue;
    const actual = timings.get(scene.segment_id);
    if (!actual) throw new Error(`真实时间投影缺少 ${scene.segment_id}`);
    const visual = scene.visual_plan;
    const result = attachClip(context, {
      recipe_id: visual.recipe.recipe_id,
      style_id: visual.recipe.style_id,
      variant_id: visual.recipe.variant_id,
      segment_id: scene.segment_id,
      visual_source_kind: visual.source_kind,
      relationship_kind: visual.relationship_kind,
      placement_mode: visual.placement_mode,
      aspect_ratio: visual.aspect_ratio,
      selection_reason: visual.selection_reason,
      fps: timing.fps,
      timeline_start_frame: actual.timeline_start_frame,
      duration_frames: actual.duration_frames,
    });
    bindings.push(result.binding);
  }
  if (!bindings.length) throw new Error("当前导演计划没有需要活动镜头配方的场景");
  const state = loadState(context.projectRoot);
  const projectionBinding = {
    file: projectRelative(context.projectRoot, absoluteTiming),
    sha256: sha256File(absoluteTiming),
    bytes: fs.statSync(absoluteTiming).size,
  };
  if (!state.timing_projections.some((item) => item.sha256 === projectionBinding.sha256)) {
    state.timing_projections.push(projectionBinding);
  }
  state.updated_at = new Date().toISOString();
  writeState(context.projectRoot, state);
  return {state, timing_projection: projectionBinding, clips: bindings};
}

function json(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  response.writeHead(status, {"content-type": "application/json; charset=utf-8", "content-length": body.length});
  response.end(body);
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("请求正文超过 1 MiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (error) { reject(new Error(`JSON 请求无效：${error.message}`)); }
    });
    request.on("error", reject);
  });
}

function staticFile(requestPath) {
  const decoded = decodeURIComponent(requestPath === "/" ? GALLERY_ENTRY : requestPath);
  const target = path.resolve(SKILL_ROOT, `.${decoded}`);
  const relative = path.relative(SKILL_ROOT, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (!fs.statSync(target, {throwIfNoEntry: false})?.isFile()) return null;
  return target;
}

function serveFile(response, filePath) {
  const type = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const body = fs.readFileSync(filePath);
  response.writeHead(200, {"content-type": type, "content-length": body.length, "cache-control": "no-store"});
  response.end(body);
}

async function handler(context, request, response) {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/context") {
      return json(response, 200, contextDocument(context));
    }
    if (request.method === "POST" && url.pathname === "/api/materialize") {
      return json(response, 200, attachClip(context, await requestBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/edit") {
      return json(response, 200, updateClip(context, await requestBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/export") {
      return json(response, 200, exportClip(context, await requestBody(request)));
    }
    if (request.method !== "GET") return json(response, 405, {error: "method_not_allowed"});
    const target = staticFile(url.pathname);
    if (!target) return json(response, 404, {error: "not_found"});
    return serveFile(response, target);
  } catch (error) {
    return json(response, 400, {error: error.message});
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!["serve", "apply-plan", "export"].includes(args._[0]) || args.help || args.h) {
    usage();
    return args.help || args.h ? 0 : 1;
  }
  const projectRoot = path.resolve(required(args, "project"));
  if (!fs.statSync(projectRoot, {throwIfNoEntry: false})?.isDirectory()) {
    throw new Error(`媒体项目目录不存在：${projectRoot}`);
  }
  const environment = loadLocalMediaEnvironment();
  const contract = assertMediaFlowContract(environment);
  const context = {
    projectRoot,
    environment,
    contract,
    plan: directionPlan(projectRoot, args.plan),
    explicitEditorProject: args["editor-project"] ? path.resolve(args["editor-project"]) : null,
  };
  if (args._[0] === "apply-plan") {
    console.log(JSON.stringify(applyDirectionPlan(context, required(args, "timings")), null, 2));
    return 0;
  }
  if (args._[0] === "export") {
    console.log(JSON.stringify(exportClip(context, {
      selection_id: required(args, "selection-id"),
      format: required(args, "format"),
      output_path: args.output || null,
    }), null, 2));
    return 0;
  }
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || 4178);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port 必须是 0–65535 的整数");
  const server = http.createServer((request, response) => handler(context, request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" ? address.port : port;
  console.log(JSON.stringify({
    ready: true,
    url: `http://${host}:${actualPort}${GALLERY_ENTRY}`,
    project: projectRoot,
    direction_plan: context.plan?.target || null,
  }, null, 2));
  return await new Promise(() => {});
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => {
    if (Number.isInteger(code)) process.exitCode = code;
  }).catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
