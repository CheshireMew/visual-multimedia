import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  commandPath,
  formatSrtTime,
  nowIso,
  probeMedia,
  projectPath,
  readJson,
  relativeProjectPath,
  run,
  sha256File,
  toolVersion,
  writeJson,
} from "./interview_explainer_common.mjs";
import {
  assemblyCacheKey,
  buildUnitCacheKey,
  validateMediaBuildPlan,
  validateMediaBuildReport,
} from "./media_build_contract.mjs";
import {
  inspectLocalMediaCapabilities,
  loadLocalMediaEnvironment,
  mediaFlowProExecute,
  mediaFlowProWaitForTask,
  resolveProviderNeed,
} from "./local-media-environment.mjs";
import {
  assertMediaFlowProVideoCapabilities,
  ensureMediaFlowProVideoProject,
  resolveMediaFlowArtifact,
} from "./mediaflow_video_common.mjs";
import {
  assertStageApproved,
  decideStage,
  submitStage,
  validateProjectState,
} from "./media_project_state.mjs";
import {
  BUILD_PLAN_RELATIVE,
  PLAN_RELATIVE,
  PROFILE,
  SKILL_ROOT,
  TIMELINE_RELATIVE,
  assertPlanConfirmation,
  createSourceVideoCommentaryBuildPlan,
  projectPlanToPortableTimeline,
} from "./source_video_commentary_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const TIMELINE_CLI = path.join(SCRIPT_DIR, "media-timeline.mjs");
const WEB_RENDER_CLI = path.join(SCRIPT_DIR, "render-web-media-local.mjs");
const BUILD_REPORT_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-build-report.v2.schema.json");

function stateAt(projectRoot) {
  const statePath = path.join(projectRoot, "media-project-state.json");
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  return {statePath, state: readJson(statePath)};
}

function writeState(statePath, state) {
  writeJson(statePath, state);
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  return validation;
}

function localTools(environment, options) {
  return {
    ffmpeg: commandPath("ffmpeg", options.ffmpeg || environment.providers.local.ffmpeg, "FFMPEG_BIN"),
    ffprobe: commandPath("ffprobe", options.ffprobe || environment.providers.local.ffprobe, "FFPROBE_BIN"),
    browser: options.browser || environment.providers.local.browser || environment.providers.local.playwright.browser_executable || null,
  };
}

function chooseProvider(environment, requested) {
  const resolution = resolveProviderNeed(environment, "timeline-render");
  const provider = requested && requested !== "auto" ? requested : resolution.preferred_provider;
  if (!new Set(["local", "mediaflow"]).has(provider)) throw new Error(`provider 必须是 auto、local 或 mediaflow：${provider}`);
  if (!resolution.candidates.includes(provider)) {
    const inspection = inspectLocalMediaCapabilities(environment);
    throw new Error(`本机 ${provider} 没有准备好完整 timeline-render：${JSON.stringify(inspection.providers[provider], null, 2)}`);
  }
  return provider;
}

function copyVerified(source, target, expectedSha = null) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`要复制的真实产物不存在：${source}`);
  const sourceSha = sha256File(source);
  if (expectedSha && sourceSha !== expectedSha) throw new Error(`真实产物哈希与提供方回执不一致：${source}`);
  if (fs.existsSync(target)) {
    if (sha256File(target) !== sourceSha) throw new Error(`目标已有不同文件，拒绝覆盖：${target}`);
    return {status: "reused", sha256: sourceSha};
  }
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return {status: "rendered", sha256: sourceSha};
}

function prepareEditableScenes(projectRoot, plan, environment, tools, options) {
  const result = new Map();
  for (const segment of plan.segments.filter((item) => item.visual.kind === "editable-scene")) {
    const key = segment.visual.package_sha256.slice(0, 16);
    const output = projectPath(projectRoot, `working/source-video-commentary/editable/${segment.id}.${key}.mp4`, "editable scene render");
    const reportPath = `${output}.render.json`;
    if (fs.existsSync(output) && fs.existsSync(reportPath)) {
      const report = readJson(reportPath);
      if (report.output_sha256 === sha256File(output) && report.manifest_sha256 === segment.visual.manifest_sha256) {
        result.set(segment.id, {file: relativeProjectPath(projectRoot, output), sha256: report.output_sha256, duration_seconds: report.duration_seconds});
        continue;
      }
      throw new Error(`segment ${segment.id} 已有不同 editable scene render；请归档后再重渲染`);
    }
    const args = [
      WEB_RENDER_CLI,
      "render",
      "--package", projectPath(projectRoot, segment.visual.package, `segment ${segment.id} editable package`),
      "--output", output,
      "--fps", String(plan.output.fps),
      "--ffmpeg", tools.ffmpeg,
      "--report", reportPath,
    ];
    if (segment.visual.variant) args.push("--variant", segment.visual.variant);
    if (tools.browser) args.push("--browser", tools.browser);
    const response = JSON.parse(run(process.execPath, args, {cwd: SKILL_ROOT}).stdout);
    if (response.manifest_sha256 !== segment.visual.manifest_sha256 || response.output_sha256 !== sha256File(output)) {
      throw new Error(`segment ${segment.id} 的 editable scene render 没有绑定当前计划`);
    }
    result.set(segment.id, {file: relativeProjectPath(projectRoot, output), sha256: response.output_sha256, duration_seconds: response.duration_seconds});
  }
  return result;
}

function writeTimeline(projectRoot, relative, timeline) {
  const target = projectPath(projectRoot, relative, "portable timeline");
  if (fs.existsSync(target)) {
    const previous = readJson(target);
    if (JSON.stringify(previous) !== JSON.stringify(timeline)) throw new Error(`已有不同 portable timeline，拒绝覆盖；请先归档：${target}`);
  } else {
    writeJson(target, timeline);
  }
  const result = JSON.parse(run(process.execPath, [TIMELINE_CLI, "validate", "--timeline", target], {cwd: SKILL_ROOT}).stdout);
  if (!result.ok) throw new Error(`portable timeline 未通过：\n- ${result.errors.join("\n- ")}`);
  return target;
}

function captionsFromTimeline(timeline) {
  return (timeline.tracks.find((item) => item.kind === "subtitle")?.clips || [])
    .slice()
    .sort((a, b) => a.timeline_start_seconds - b.timeline_start_seconds);
}

function writeSrt(projectRoot, relative, timeline) {
  const target = projectPath(projectRoot, relative, "commentary captions");
  const lines = [];
  for (const [index, caption] of captionsFromTimeline(timeline).entries()) {
    lines.push(
      String(index + 1),
      `${formatSrtTime(caption.timeline_start_seconds)} --> ${formatSrtTime(caption.timeline_start_seconds + caption.duration_seconds)}`,
      caption.text,
      "",
    );
  }
  const text = `${lines.join("\n")}\n`;
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== text) throw new Error(`已有不同字幕文件，拒绝覆盖：${target}`);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, text, "utf8");
  }
  return target;
}

function withoutCaptionTrack(timeline) {
  return {...timeline, tracks: timeline.tracks.filter((item) => item.kind !== "subtitle"), subtitle_styles: []};
}

function muxEmbeddedSubtitle(tools, sourceVideo, srt, output) {
  if (fs.existsSync(output)) throw new Error(`嵌入字幕输出已经存在，拒绝覆盖：${output}`);
  run(tools.ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", sourceVideo,
    "-i", srt,
    "-map", "0:v", "-map", "0:a?", "-map", "1:0",
    "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
    "-metadata:s:s:0", "language=und",
    "-movflags", "+faststart",
    output,
  ]);
}

function concatUnits(tools, projectRoot, units, output) {
  const listKey = crypto.createHash("sha256").update(units.map((item) => item.sha256).join("\n")).digest("hex");
  const list = projectPath(projectRoot, `working/source-video-commentary/concat/${listKey.slice(0, 16)}.txt`, "concat list");
  const content = units.map((item) => `file '${item.absoluteFile.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n") + "\n";
  if (fs.existsSync(list) && fs.readFileSync(list, "utf8") !== content) throw new Error(`已有不同 concat list，拒绝覆盖：${list}`);
  if (!fs.existsSync(list)) {
    fs.mkdirSync(path.dirname(list), {recursive: true});
    fs.writeFileSync(list, content, "utf8");
  }
  if (fs.existsSync(output)) throw new Error(`完整输出已经存在且未命中当前构建报告，拒绝覆盖：${output}`);
  fs.mkdirSync(path.dirname(output), {recursive: true});
  run(tools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output]);
}

function renderLocalTimeline(tools, timelinePath, output, reportPath) {
  const args = [
    TIMELINE_CLI, "render",
    "--timeline", timelinePath,
    "--output", output,
    "--report", reportPath,
    "--ffmpeg", tools.ffmpeg,
    "--ffprobe", tools.ffprobe,
  ];
  if (fs.existsSync(output)) args.push("--overwrite");
  return JSON.parse(run(process.execPath, args, {cwd: SKILL_ROOT}).stdout);
}

function mediaFlowPreset(plan, subtitleTrackId) {
  const subtitleStyle = plan.output.caption_mode === "burned-in" ? {
    font_family: "Microsoft YaHei",
    font_size: Math.max(12, Math.round(plan.output.height * 0.045)),
    font_color: "#FFFFFF",
    bold: true,
    italic: false,
    outline_size: Math.max(1, Math.round(plan.output.height * 0.003)),
    shadow_size: 0,
    outline_color: "#101010",
    background_enabled: false,
    background_color: "#000000",
    background_opacity: 0,
    background_padding: 5,
    position_x: 0.5,
    position_y: 0.88,
    alignment: "center",
    multiline_alignment: "bottom",
  } : null;
  return {
    name: "Source video commentary",
    format: "h264",
    container: "mp4",
    encoder_policy: {mode: "software", vendor: "auto"},
    audio_codec: "aac",
    pixel_format: "yuv420p",
    quality_value: 18,
    preset: "medium",
    gop_frames: Math.max(1, plan.output.fps * 2),
    audio_bitrate: 192000,
    burn_subtitle_track_id: plan.output.caption_mode === "burned-in" ? subtitleTrackId : null,
    subtitle_style: subtitleStyle,
  };
}

function renderWithMediaFlow({projectRoot, plan, timelinePath, outputPath, environment, label, units}) {
  const contract = assertMediaFlowProVideoCapabilities(environment);
  const timelineSha = sha256File(timelinePath);
  const projectScope = crypto.createHash("sha256").update(path.resolve(projectRoot), "utf8").digest("hex").slice(0, 16);
  const editor = ensureMediaFlowProVideoProject(environment, contract, {
    name: `${plan.project_id} · ${label}`,
    directoryName: `source-video-commentary-${label}-${projectScope}-${timelineSha.slice(0, 16)}`,
    requestId: `source-video-commentary-${label}-${projectScope}-${timelineSha}`,
  }, plan.output);
  const sequenceId = editor.inspected.project.main_sequence_id;
  const inspected = mediaFlowProExecute(environment, editor.editorProject, "timeline.portable.inspect", {sequence_id: sequenceId, timeline_path: timelinePath});
  if (!inspected.mediaflow_compatible || inspected.timeline_sha256 !== timelineSha) throw new Error("MediaFlow Pro portable timeline inspect 没有绑定当前时间线");
  const imported = mediaFlowProExecute(
    environment,
    editor.editorProject,
    "timeline.portable.import",
    {sequence_id: sequenceId, timeline_path: timelinePath},
    `source-video-commentary-import-${projectScope}-${timelineSha}`,
  );
  if (imported.timeline_sha256 !== timelineSha) throw new Error("MediaFlow Pro portable timeline import 哈希不一致");
  const subtitleTrack = (imported.timeline.tracks || []).find((item) => item.kind === "subtitle") || null;
  const receipt = mediaFlowProExecute(environment, editor.editorProject, "export.sequence.build", {
    sequence_id: sequenceId,
    units,
    output_path: outputPath,
    format: "h264",
    preset: mediaFlowPreset(plan, subtitleTrack?.id ?? null),
    overwrite: false,
    timeout: 3600,
  }, `source-video-commentary-build-${label}-${projectScope}-${timelineSha}`);
  const task = mediaFlowProWaitForTask(environment, editor.editorProject, receipt, 3600);
  if (task.outcome?.outcome_type !== "sequence_build") throw new Error(`MediaFlow Pro 没有返回 sequence build：${JSON.stringify(task)}`);
  const after = mediaFlowProExecute(environment, editor.editorProject, "project.inspect", {});
  return {contract, editorProject: editor.editorProject, sequenceId, imported, task, outcome: task.outcome, inspected: after};
}

function snapshotMediaFlowProject(projectRoot, editorProject, timelineSha) {
  const snapshotRoot = projectPath(projectRoot, `native-project/mediaflow-${timelineSha.slice(0, 20)}`, "MediaFlow project snapshot");
  fs.mkdirSync(snapshotRoot, {recursive: true});
  const copyTree = (source, target) => {
    const stat = fs.statSync(source);
    if (stat.isFile()) {
      copyVerified(source, target);
      return;
    }
    if (!stat.isDirectory()) return;
    fs.mkdirSync(target, {recursive: true});
    for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
      if (new Set(["cache", "tmp", "temp"]).has(entry.name.toLowerCase())) continue;
      if (entry.name.endsWith("-shm") || entry.name.endsWith("-wal")) continue;
      copyTree(path.join(source, entry.name), path.join(target, entry.name));
    }
  };
  for (const entry of fs.readdirSync(editorProject, {withFileTypes: true})) {
    if (new Set(["cache", "tmp", "temp"]).has(entry.name.toLowerCase())) continue;
    if (entry.name.endsWith("-shm") || entry.name.endsWith("-wal")) continue;
    copyTree(path.join(editorProject, entry.name), path.join(snapshotRoot, entry.name));
  }
  const projectFile = path.join(snapshotRoot, "project.mfp");
  if (!fs.existsSync(projectFile)) throw new Error("MediaFlow project snapshot 缺少 project.mfp");
  return {root: snapshotRoot, projectFile, projectFileRelative: relativeProjectPath(projectRoot, projectFile), sha256: sha256File(projectFile)};
}

function renderSampleWithLocal(projectRoot, plan, timeline, timelinePath, outputPath, tools) {
  const mode = plan.output.caption_mode;
  let renderTimelinePath = timelinePath;
  if (mode === "sidecar" || mode === "embedded-track") {
    renderTimelinePath = writeTimeline(projectRoot, "source-video-commentary-sample-render-timeline.json", withoutCaptionTrack(timeline));
  }
  const srt = mode === "none" ? null : writeSrt(projectRoot, "captions/source-video-commentary-sample.srt", timeline);
  const baseOutput = mode === "embedded-track"
    ? projectPath(projectRoot, `working/source-video-commentary/sample/${sha256File(timelinePath).slice(0, 16)}.mp4`, "sample base video")
    : outputPath;
  const localReport = `${baseOutput}.render.json`;
  const response = renderLocalTimeline(tools, renderTimelinePath, baseOutput, localReport);
  if (mode === "embedded-track") muxEmbeddedSubtitle(tools, baseOutput, srt, outputPath);
  return {provider: "local", output: outputPath, provider_report: localReport, timeline_sha256: response.timeline_sha256, caption_file: srt};
}

function renderSampleWithMediaFlow(projectRoot, plan, timeline, timelinePath, outputPath, environment, tools) {
  const frames = Math.round(timeline.profile.duration_seconds * plan.output.fps);
  const baseOutput = plan.output.caption_mode === "embedded-track"
    ? projectPath(projectRoot, `working/source-video-commentary/sample/${sha256File(timelinePath).slice(0, 16)}.mp4`, "sample base video")
    : outputPath;
  const result = renderWithMediaFlow({
    projectRoot,
    plan,
    timelinePath,
    outputPath: baseOutput,
    environment,
    label: "sample",
    units: [{id: "integrated-sample", start_frame: 0, end_frame: frames}],
  });
  const srt = plan.output.caption_mode === "none" ? null : writeSrt(projectRoot, "captions/source-video-commentary-sample.srt", timeline);
  if (plan.output.caption_mode === "embedded-track") muxEmbeddedSubtitle(tools, baseOutput, srt, outputPath);
  const providerReportSource = resolveMediaFlowArtifact(result.editorProject, result.outcome.report);
  const providerReport = projectPath(projectRoot, `reports/mediaflow/source-video-commentary-sample.${sha256File(timelinePath).slice(0, 16)}.json`, "sample provider report");
  copyVerified(providerReportSource, providerReport);
  return {provider: "mediaflow", output: outputPath, provider_report: providerReport, editor_project: result.editorProject, caption_file: srt};
}

function bindStageArtifact(projectRoot, stageId, role, id, kind, outputPath) {
  const {statePath, state} = stateAt(projectRoot);
  const stage = state.stages.find((item) => item.id === stageId);
  const relative = relativeProjectPath(projectRoot, outputPath);
  const sha = sha256File(outputPath);
  if (["waiting-approval", "approved"].includes(stage.status)) {
    const artifact = state.artifacts.find((item) => item.stage_id === stageId && item.role === role);
    if (!artifact || artifact.file !== relative || artifact.sha256 !== sha) throw new Error(`${stageId} 已绑定其它成果；先使阶段及下游失效`);
    return {statePath, state, next_action: state.next_action};
  }
  submitStage(state, projectRoot, stageId, [{id, role, kind, file: relative}]);
  const validation = writeState(statePath, state);
  return {statePath, state, next_action: validation.next_action};
}

export function renderSourceVideoCommentarySample(options) {
  const projectRoot = path.resolve(options.project);
  const context = assertPlanConfirmation(projectRoot, options.plan || PLAN_RELATIVE, options.confirmation);
  const {state} = stateAt(projectRoot);
  assertStageApproved(state, "direction");
  const environment = loadLocalMediaEnvironment(options.localConfig);
  const provider = chooseProvider(environment, options.provider || "auto");
  const tools = localTools(environment, options);
  const editable = prepareEditableScenes(projectRoot, context.plan, environment, tools, options);
  const timeline = projectPlanToPortableTimeline(projectRoot, context.plan, {segmentIds: context.plan.integrated_sample.segment_ids, editableRenders: editable});
  const timelinePath = writeTimeline(projectRoot, "source-video-commentary-sample-timeline.json", timeline);
  const outputPath = projectPath(projectRoot, options.output || "renders/source-video-commentary-sample.mp4", "integrated sample");
  let result;
  const receiptPath = projectPath(projectRoot, "reports/source-video-commentary-sample-render-receipt.json", "sample render receipt");
  if (fs.existsSync(outputPath) && fs.existsSync(receiptPath)) {
    const existing = readJson(receiptPath);
    if (existing.timeline_sha256 !== sha256File(timelinePath) || existing.output_sha256 !== sha256File(outputPath)) {
      throw new Error("已有综合样片不属于当前计划；请先归档旧样片");
    }
    result = existing;
  } else {
    if (fs.existsSync(outputPath) || fs.existsSync(receiptPath)) throw new Error("综合样片或回执只存在一项；请先归档不完整结果");
    const rendered = provider === "mediaflow"
      ? renderSampleWithMediaFlow(projectRoot, context.plan, timeline, timelinePath, outputPath, environment, tools)
      : renderSampleWithLocal(projectRoot, context.plan, timeline, timelinePath, outputPath, tools);
    const probe = probeMedia(tools.ffprobe, outputPath, true);
    result = {
      protocol: "visual-multimedia-source-video-commentary-render-receipt",
      version: 1,
      stage: "integrated-sample",
      provider,
      timeline: relativeProjectPath(projectRoot, timelinePath),
      timeline_sha256: sha256File(timelinePath),
      output: relativeProjectPath(projectRoot, outputPath),
      output_sha256: sha256File(outputPath),
      frames: probe.frames,
      provider_report: rendered.provider_report ? relativeProjectPath(projectRoot, rendered.provider_report) : null,
      completed_at: nowIso(),
    };
    writeJson(receiptPath, result);
  }
  const bound = bindStageArtifact(projectRoot, "integrated-sample", "integrated-sample", "source-video-commentary-sample", "video", outputPath);
  return {...result, receipt: receiptPath, next_action: bound.next_action};
}

export function confirmSourceVideoCommentarySample(options) {
  const projectRoot = path.resolve(options.project);
  const {statePath, state} = stateAt(projectRoot);
  const stage = state.stages.find((item) => item.id === "integrated-sample");
  if (stage.status === "waiting-approval") {
    decideStage(state, "integrated-sample", "approved", options.evidence, {decidedBy: options.confirmedBy});
    const validation = writeState(statePath, state);
    return {status: "approved", state: statePath, next_action: validation.next_action};
  }
  if (stage.status !== "approved") throw new Error(`integrated-sample 当前为 ${stage.status}，不能确认`);
  return {status: "approved", state: statePath, next_action: state.next_action};
}

function loadOrCreateBuildPlan(projectRoot, plan, planPath, relative) {
  const target = projectPath(projectRoot, relative, "media build plan");
  if (fs.existsSync(target)) {
    const existing = validateMediaBuildPlan(readJson(target));
    if (existing.source_contract_sha256 !== sha256File(planPath) || existing.profile !== PROFILE) {
      throw new Error("已有 media-build-plan 没有绑定当前 production plan；请先归档旧构建计划");
    }
    return {path: target, document: existing};
  }
  const document = createSourceVideoCommentaryBuildPlan(projectRoot, plan, planPath);
  writeJson(target, document);
  return {path: target, document};
}

function renderLocalFull({projectRoot, plan, buildPlan, buildPlanPath, editable, tools, timeline, timelinePath, outputPath}) {
  const mode = plan.output.caption_mode;
  const units = [];
  for (const segment of plan.segments) {
    const unit = buildPlan.units.find((item) => item.id === segment.id);
    const unitTimeline = projectPlanToPortableTimeline(projectRoot, plan, {segmentIds: [segment.id], editableRenders: editable});
    const renderTimeline = (mode === "sidecar" || mode === "embedded-track") ? withoutCaptionTrack(unitTimeline) : unitTimeline;
    const timelinePath = writeTimeline(projectRoot, `source-video-commentary-unit-${segment.id}.timeline.json`, renderTimeline);
    const key = buildUnitCacheKey(buildPlan, unit, {timeline_sha256: sha256File(timelinePath), provider: "local"});
    const output = projectPath(projectRoot, `renders/source-video-commentary-units/${segment.id}.${key.slice(0, 16)}.mp4`, "local commentary unit");
    const receipt = `${output}.render.json`;
    let status = "reused";
    if (!fs.existsSync(output) || !fs.existsSync(receipt)) {
      if (fs.existsSync(output) || fs.existsSync(receipt)) throw new Error(`unit ${segment.id} 的文件与回执不完整`);
      renderLocalTimeline(tools, timelinePath, output, receipt);
      status = "rendered";
    }
    const probe = probeMedia(tools.ffprobe, output, true);
    if (probe.frames !== segment.duration_frames) throw new Error(`unit ${segment.id} 实际帧数 ${probe.frames} 不等于计划 ${segment.duration_frames}`);
    units.push({id: segment.id, absoluteFile: output, file: relativeProjectPath(projectRoot, output), sha256: sha256File(output), bytes: fs.statSync(output).size, frames: probe.frames, status, cache_key: key});
  }
  const srt = mode === "none" ? null : writeSrt(projectRoot, "captions/source-video-commentary.srt", timeline);
  const baseOutput = mode === "embedded-track"
    ? projectPath(projectRoot, `working/source-video-commentary/full/${sha256File(buildPlanPath).slice(0, 16)}.mp4`, "full base video")
    : outputPath;
  concatUnits(tools, projectRoot, units, baseOutput);
  if (mode === "embedded-track") muxEmbeddedSubtitle(tools, baseOutput, srt, outputPath);
  const assemblyKey = assemblyCacheKey(buildPlan, units);
  const receiptPath = projectPath(projectRoot, "reports/source-video-commentary-render-receipt.json", "source video commentary local render receipt");
  const receipt = {
    protocol: "visual-multimedia-source-video-commentary-render-receipt",
    version: 1,
    stage: "full-preview",
    provider: "local",
    timeline: relativeProjectPath(projectRoot, timelinePath),
    timeline_sha256: sha256File(timelinePath),
    output: relativeProjectPath(projectRoot, outputPath),
    output_sha256: sha256File(outputPath),
    completed_at: nowIso(),
  };
  writeJson(receiptPath, receipt);
  return {
    provider: "local",
    units: units.map(({absoluteFile, ...item}) => item),
    audio: {strategy: "unit-audio", status: "included-in-units", file: null, sha256: null, cache_key: null},
    assembly: {status: "assembled", cache_key: assemblyKey},
    srt,
    providerTools: {node: process.version, ffmpeg: toolVersion(tools.ffmpeg), ffprobe: toolVersion(tools.ffprobe)},
    nativeProject: null,
    renderReceipt: {file: relativeProjectPath(projectRoot, receiptPath), sha256: sha256File(receiptPath)},
  };
}

function renderMediaFlowFull({projectRoot, plan, buildPlan, timelinePath, timeline, outputPath, environment, tools}) {
  const mode = plan.output.caption_mode;
  const srt = mode === "none" ? null : writeSrt(projectRoot, "captions/source-video-commentary.srt", timeline);
  const baseOutput = mode === "embedded-track"
    ? projectPath(projectRoot, `working/source-video-commentary/full/${sha256File(timelinePath).slice(0, 16)}.mp4`, "MediaFlow base video")
    : outputPath;
  const result = renderWithMediaFlow({
    projectRoot,
    plan,
    timelinePath,
    outputPath: baseOutput,
    environment,
    label: "full",
    units: buildPlan.units.map((item) => ({id: item.id, start_frame: item.timeline_start_frame, end_frame: item.timeline_start_frame + item.duration_frames})),
  });
  if (mode === "embedded-track") muxEmbeddedSubtitle(tools, baseOutput, srt, outputPath);
  const timelineSha = sha256File(timelinePath);
  const copiedUnits = result.outcome.units.map((unit) => {
    const source = resolveMediaFlowArtifact(result.editorProject, unit.output);
    const target = projectPath(projectRoot, `reports/mediaflow/source-video-commentary-units/${unit.id}.${unit.cache_key.slice(0, 16)}.mp4`, "MediaFlow unit copy");
    const copied = copyVerified(source, target, unit.sha256);
    return {id: unit.id, file: relativeProjectPath(projectRoot, target), sha256: copied.sha256, bytes: fs.statSync(target).size, frames: unit.end_frame - unit.start_frame, status: unit.status, cache_key: unit.cache_key};
  });
  let audio = {strategy: "continuous-master", status: "absent", file: null, sha256: null, cache_key: null};
  if (result.outcome.audio.output) {
    const source = resolveMediaFlowArtifact(result.editorProject, result.outcome.audio.output);
    const target = projectPath(projectRoot, `reports/mediaflow/source-video-commentary-audio.${result.outcome.audio.cache_key.slice(0, 16)}.wav`, "MediaFlow audio master copy");
    const copied = copyVerified(source, target, result.outcome.audio.sha256);
    audio = {strategy: "continuous-master", status: result.outcome.audio.status, file: relativeProjectPath(projectRoot, target), sha256: copied.sha256, cache_key: result.outcome.audio.cache_key};
  }
  const providerReportSource = resolveMediaFlowArtifact(result.editorProject, result.outcome.report);
  const providerReport = projectPath(projectRoot, `reports/mediaflow/source-video-commentary-sequence-build.${timelineSha.slice(0, 16)}.json`, "MediaFlow sequence build report");
  copyVerified(providerReportSource, providerReport);
  const snapshot = snapshotMediaFlowProject(projectRoot, result.editorProject, timelineSha);
  const reopenedSnapshot = mediaFlowProExecute(environment, snapshot.root, "project.inspect", {});
  if (
    String(reopenedSnapshot.project?.id) !== String(result.inspected.project.id)
    || reopenedSnapshot.project?.main_sequence_id == null
  ) throw new Error("项目内 MediaFlow Pro snapshot 无法重新打开为同一原生工程");
  const receiptPath = projectPath(projectRoot, "reports/source-video-commentary-render-receipt.json", "source video commentary render receipt");
  const receipt = {
    protocol: "visual-multimedia-source-video-commentary-render-receipt",
    version: 1,
    stage: "full-preview",
    provider: "mediaflow",
    timeline: relativeProjectPath(projectRoot, timelinePath),
    timeline_sha256: timelineSha,
    provider_report: relativeProjectPath(projectRoot, providerReport),
    provider_report_sha256: sha256File(providerReport),
    native_project: snapshot.projectFileRelative,
    native_project_sha256: snapshot.sha256,
    mediaflow_project_id: String(result.inspected.project.id),
    content_revision: Number(result.inspected.project.content_revision ?? result.inspected.content_revision ?? 0),
    snapshot_reopened: true,
    output: relativeProjectPath(projectRoot, outputPath),
    output_sha256: sha256File(outputPath),
    completed_at: nowIso(),
  };
  writeJson(receiptPath, receipt);
  return {
    provider: "mediaflow",
    units: copiedUnits,
    audio,
    assembly: {status: result.outcome.assembly_status, cache_key: result.outcome.assembly_key},
    srt,
    providerTools: {node: process.version, ffmpeg: toolVersion(tools.ffmpeg), ffprobe: toolVersion(tools.ffprobe), mediaflow_pro: String(result.contract.version)},
    nativeProject: {file: snapshot.projectFileRelative, sha256: snapshot.sha256, project_id: receipt.mediaflow_project_id, content_revision: receipt.content_revision},
    renderReceipt: {file: relativeProjectPath(projectRoot, receiptPath), sha256: sha256File(receiptPath)},
  };
}

function buildReport(projectRoot, plan, buildPlanPath, render, outputPath, tools) {
  const probe = probeMedia(tools.ffprobe, outputPath, true);
  if (
    probe.frames !== plan.total_frames
    || probe.width !== plan.output.width
    || probe.height !== plan.output.height
    || Math.abs(probe.fps - plan.output.fps) > 0.001
    || !probe.has_video
    || !probe.has_audio
  ) throw new Error("最终全量预览的帧数、尺寸、帧率或音画轨不符合计划");
  const captionMode = plan.output.caption_mode;
  const report = {
    protocol: "visual-multimedia-media-build-report",
    version: 2,
    profile: "source-video-commentary",
    build_plan: relativeProjectPath(projectRoot, buildPlanPath),
    build_plan_sha256: sha256File(buildPlanPath),
    producer: {entry: "scripts/source-video-commentary.mjs", sha256: sha256File(path.join(SKILL_ROOT, "scripts", "source-video-commentary.mjs")), tools: render.providerTools},
    units: render.units,
    audio: render.audio,
    captions: {
      mode: captionMode,
      file: render.srt ? relativeProjectPath(projectRoot, render.srt) : null,
      sha256: render.srt ? sha256File(render.srt) : null,
      render_file: captionMode === "burned-in" || captionMode === "embedded-track" ? relativeProjectPath(projectRoot, outputPath) : null,
      render_sha256: captionMode === "burned-in" || captionMode === "embedded-track" ? sha256File(outputPath) : null,
      visible_in_standalone_output: captionMode === "burned-in" || captionMode === "embedded-track",
    },
    assembly: render.assembly,
    output: {
      file: relativeProjectPath(projectRoot, outputPath),
      sha256: sha256File(outputPath),
      bytes: fs.statSync(outputPath).size,
      frames: probe.frames,
      duration_seconds: probe.duration_seconds,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      audio_sample_rate: probe.audio_sample_rate,
      audio_channels: probe.audio_channels,
    },
    completed_at: nowIso(),
  };
  assertJsonSchema(validateMediaBuildReport(report), BUILD_REPORT_SCHEMA, "source video commentary build report");
  return report;
}

export function renderSourceVideoCommentary(options) {
  const projectRoot = path.resolve(options.project);
  const context = assertPlanConfirmation(projectRoot, options.plan || PLAN_RELATIVE, options.confirmation);
  const {state} = stateAt(projectRoot);
  assertStageApproved(state, "integrated-sample");
  const planPath = context.planBinding.absolute;
  const build = loadOrCreateBuildPlan(projectRoot, context.plan, planPath, options.buildPlan || BUILD_PLAN_RELATIVE);
  const reportPath = projectPath(projectRoot, options.report || "reports/media-build-report.json", "media build report");
  const outputPath = projectPath(projectRoot, context.plan.output.file, "source video commentary full preview");
  if (fs.existsSync(reportPath) && fs.existsSync(outputPath)) {
    const existing = readJson(reportPath);
    assertJsonSchema(validateMediaBuildReport(existing), BUILD_REPORT_SCHEMA, "existing build report");
    if (existing.build_plan_sha256 !== sha256File(build.path) || existing.output.sha256 !== sha256File(outputPath)) {
      throw new Error("已有全量预览没有绑定当前 build plan；请先归档旧输出");
    }
    const bound = bindStageArtifact(projectRoot, "full-preview", "full-preview", "source-video-commentary-full-preview", "video", outputPath);
    return {status: "reused", provider: existing.producer.tools.mediaflow_pro ? "mediaflow" : "local", output: outputPath, report: reportPath, next_action: bound.next_action};
  }
  if (fs.existsSync(reportPath) || fs.existsSync(outputPath)) throw new Error("全量预览或构建报告只存在一项；请先归档不完整结果");
  const environment = loadLocalMediaEnvironment(options.localConfig);
  const provider = chooseProvider(environment, options.provider || "auto");
  const tools = localTools(environment, options);
  const editable = prepareEditableScenes(projectRoot, context.plan, environment, tools, options);
  const timeline = projectPlanToPortableTimeline(projectRoot, context.plan, {editableRenders: editable});
  const timelinePath = writeTimeline(projectRoot, options.timeline || TIMELINE_RELATIVE, timeline);
  let render;
  if (provider === "mediaflow") {
    render = renderMediaFlowFull({projectRoot, plan: context.plan, buildPlan: build.document, timelinePath, timeline, outputPath, environment, tools});
  } else {
    render = renderLocalFull({projectRoot, plan: context.plan, buildPlan: build.document, buildPlanPath: build.path, editable, tools, timeline, timelinePath, outputPath});
  }
  const report = buildReport(projectRoot, context.plan, build.path, render, outputPath, tools);
  writeJson(reportPath, report);
  const {statePath, state: current} = stateAt(projectRoot);
  current.contracts.timeline = render.nativeProject?.file || relativeProjectPath(projectRoot, timelinePath);
  writeState(statePath, current);
  const bound = bindStageArtifact(projectRoot, "full-preview", "full-preview", "source-video-commentary-full-preview", "video", outputPath);
  return {
    status: "rendered",
    provider,
    output: outputPath,
    output_sha256: report.output.sha256,
    timeline: timelinePath,
    build_plan: build.path,
    report: reportPath,
    native_project: render.nativeProject,
    render_receipt: render.renderReceipt,
    next_action: bound.next_action,
  };
}

export function confirmSourceVideoCommentaryPreview(options) {
  const projectRoot = path.resolve(options.project);
  const {statePath, state} = stateAt(projectRoot);
  const stage = state.stages.find((item) => item.id === "full-preview");
  if (stage.status === "waiting-approval") {
    decideStage(state, "full-preview", "approved", options.evidence, {decidedBy: options.confirmedBy});
    const validation = writeState(statePath, state);
    return {status: "approved", state: statePath, next_action: validation.next_action};
  }
  if (stage.status !== "approved") throw new Error(`full-preview 当前为 ${stage.status}，不能确认`);
  return {status: "approved", state: statePath, next_action: state.next_action};
}
