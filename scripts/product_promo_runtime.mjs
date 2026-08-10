import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {
  commandPath,
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
import {buildUnitCacheKey, validateMediaBuildReport} from "./media_build_contract.mjs";
import {loadLocalMediaEnvironment} from "./local-media-environment.mjs";
import {
  assemblePreparedVideoUnits,
  assertMediaFlowProVideoCapabilities,
  ensureMediaFlowProVideoProject,
  exportEditableWebScene,
} from "./mediaflow_video_common.mjs";
import {createOperationRun} from "./media_operation_run.mjs";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {assertStageApproved, submitStage, validateProjectState} from "./media_project_state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const BUILD_REPORT_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-build-report.v2.schema.json");
const PUBLIC_ENTRY = path.join(SCRIPT_DIR, "product-promo.mjs");

function state(projectRoot) {
  const file = path.join(projectRoot, "media-project-state.json");
  const validation = validateProjectState(file);
  if (!validation.ok) throw new Error(`媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  return {file, document: readJson(file)};
}

function bindFullPreview(projectRoot, outputPath) {
  const loaded = state(projectRoot);
  assertStageApproved(loaded.document, "integrated-sample");
  const stage = loaded.document.stages.find((item) => item.id === "full-preview");
  const relative = relativeProjectPath(projectRoot, outputPath);
  const sha = sha256File(outputPath);
  if (["waiting-approval", "approved"].includes(stage.status)) {
    const artifact = loaded.document.artifacts.find(
      (item) => item.stage_id === "full-preview" && item.role === "full-preview",
    );
    if (!artifact || artifact.file !== relative || artifact.sha256 !== sha) {
      throw new Error("全量预览阶段已经绑定其它成果；先使 full-preview 及下游失效再渲染");
    }
    return validateProjectState(loaded.file);
  }
  submitStage(loaded.document, projectRoot, "full-preview", [{
    id: "product-promo-full-preview",
    role: "full-preview",
    kind: "video",
    file: relative,
  }]);
  writeJson(loaded.file, loaded.document);
  const validation = validateProjectState(loaded.file);
  if (!validation.ok) throw new Error(`全量预览状态未通过：\n- ${validation.errors.join("\n- ")}`);
  return validation;
}

function validCache(cachePath, outputPath, key, ffprobe, expectedFrames) {
  if (!fs.existsSync(cachePath) || !fs.existsSync(outputPath)) return null;
  try {
    const cache = readJson(cachePath);
    const probe = probeMedia(ffprobe, outputPath, true);
    if (
      cache.key !== key
      || cache.output_sha256 !== sha256File(outputPath)
      || probe.frames !== expectedFrames
      || !probe.has_video
    ) return null;
    return cache;
  } catch {
    return null;
  }
}

export function renderProductPromo(options, context) {
  const projectRoot = path.resolve(options.project);
  const {plan, brief, planPath, confirmationPath, buildPlan, buildPlanPath} = context;
  if (brief.sound.strategy !== "none") {
    throw new Error(
      `正式 render 尚未取得 ${brief.sound.strategy} 的已混音连续母带；先按已确认声音计划生成并验证母带，不能把结构性静音轨当作成片声音`,
    );
  }
  const loaded = state(projectRoot);
  assertStageApproved(loaded.document, "integrated-sample");
  const operation = createOperationRun("product-promo@1.0.0", "render");
  const operationPath = projectPath(projectRoot, options.operationReport || "reports/product-promo-render-run.json", "operation report");
  const reportPath = projectPath(projectRoot, options.report || "reports/media-build-report.json", "build report");
  const outputPath = projectPath(projectRoot, plan.output.file, "product promo output");
  const buildPlanSha = sha256File(buildPlanPath);
  if (fs.existsSync(outputPath) && fs.existsSync(reportPath)) {
    const existing = readJson(reportPath);
    if (
      existing.version === 2
      && existing.build_plan_sha256 === buildPlanSha
      && existing.output.sha256 === sha256File(outputPath)
    ) {
      operation.addStep("final-output", "reused", 0);
      operation.finish(operationPath);
      const stageValidation = bindFullPreview(projectRoot, outputPath);
      return {status: "reused", output: outputPath, report: reportPath, operation_report: operationPath, next_action: stageValidation.next_action};
    }
  }
  const ffmpeg = commandPath("ffmpeg", options.ffmpeg, "FFMPEG_BIN");
  const ffprobe = commandPath("ffprobe", options.ffprobe, "FFPROBE_BIN");
  const environment = loadLocalMediaEnvironment(options.localConfig);
  const contract = assertMediaFlowProVideoCapabilities(environment);
  const editor = ensureMediaFlowProVideoProject(environment, contract, {
    name: `${plan.project_id} · product promo web shots`,
    directoryName: `product-promo-${buildPlanSha}`,
    requestId: `product-promo-project-${buildPlanSha}`,
  }, plan.output);
  const buildUnits = new Map(buildPlan.units.map((item) => [item.id, item]));
  const prepared = [];
  for (const shot of plan.shots) {
    const started = Date.now();
    const unit = buildUnits.get(shot.id);
    if (!unit) throw new Error(`通用构建计划缺少镜头 ${shot.id}`);
    const key = buildUnitCacheKey(buildPlan, unit, {shot, output: plan.output});
    const file = projectPath(projectRoot, `renders/product-promo-units/${shot.id}.${key.slice(0, 12)}.mp4`, "rendered shot");
    const cachePath = projectPath(projectRoot, `working/product-promo/cache/${shot.id}.${key.slice(0, 12)}.json`, "shot cache");
    let cache = validCache(cachePath, file, key, ffprobe, shot.duration_frames);
    let status = "reused";
    if (!cache) {
      status = "rendered";
      const packageRoot = projectPath(projectRoot, shot.implementation.package, `镜头 ${shot.id} 网页包`);
      const rawFile = projectPath(projectRoot, `working/product-promo/web/${shot.id}.${key.slice(0, 12)}.mp4`, "raw web shot");
      const exported = exportEditableWebScene({
        environment,
        editorProject: editor.editorProject,
        projectId: plan.project_id,
        unitId: shot.id,
        packageRoot,
        durationFrames: shot.duration_frames,
        timelineStart: (shot.order - 1) * plan.output.fps * 600,
        outputPath: rawFile,
        background: "#000000",
        requestKey: key.slice(0, 16),
        trackName: `Product promo / ${buildPlanSha.slice(0, 12)}`,
      });
      if (!fs.existsSync(rawFile) || !fs.statSync(rawFile).isFile()) {
        throw new Error(`网页镜头 ${shot.id} 没有生成输出`);
      }
      fs.mkdirSync(path.dirname(file), {recursive: true});
      const duration = shot.duration_frames / plan.output.fps;
      run(ffmpeg, [
        "-hide_banner", "-loglevel", "error",
        "-i", rawFile,
        "-f", "lavfi", "-i", `anullsrc=r=${plan.output.audio_sample_rate}:cl=${plan.output.audio_channels === 1 ? "mono" : "stereo"}`,
        "-filter_complex",
        `[0:v]fps=${plan.output.fps},trim=end_frame=${shot.duration_frames},setpts=PTS-STARTPTS,format=yuv420p[v];`
          + `[1:a]atrim=duration=${duration.toFixed(6)}[a]`,
        "-map", "[v]", "-map", "[a]",
        "-frames:v", String(shot.duration_frames),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", String(plan.output.audio_sample_rate), "-ac", String(plan.output.audio_channels),
        "-shortest", "-movflags", "+faststart", "-y", file,
      ]);
      const probe = probeMedia(ffprobe, file, true);
      if (probe.frames !== shot.duration_frames || !probe.has_video || !probe.has_audio) {
        throw new Error(`网页镜头 ${shot.id} 的实际帧数或视频轨不正确`);
      }
      cache = {key, output_sha256: sha256File(file), frames: probe.frames, created_at: nowIso()};
      writeJson(cachePath, cache);
    }
    operation.addStep(shot.id, status, Date.now() - started);
    prepared.push({
      id: shot.id,
      absoluteFile: file,
      file: relativeProjectPath(projectRoot, file),
      sha256: sha256File(file),
      bytes: fs.statSync(file).size,
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
      name: `${plan.project_id} · product promo assembly`,
      directoryName: `product-promo-assembly-${buildPlanSha}`,
      requestId: `product-promo-assembly-${buildPlanSha}`,
    },
    output: plan.output,
    units: prepared,
    outputPath,
    presetName: "Product promo preview",
    requestKey: buildPlanSha.slice(0, 16),
  });
  const probe = probeMedia(ffprobe, outputPath, true);
  const expectedFrames = buildPlan.units.reduce((sum, item) => sum + item.duration_frames, 0);
  if (
    probe.frames !== expectedFrames
    || probe.width !== plan.output.width
    || probe.height !== plan.output.height
    || Math.abs(probe.fps - plan.output.fps) > 0.001
  ) throw new Error("产品宣传片最终文件的帧数、尺寸或帧率不符合计划");
  const unitsById = new Map(prepared.map((item) => [item.id, item]));
  const report = {
    protocol: "visual-multimedia-media-build-report",
    version: 2,
    profile: "product-promo",
    build_plan: relativeProjectPath(projectRoot, buildPlanPath),
    build_plan_sha256: buildPlanSha,
    producer: {
      entry: "scripts/product-promo.mjs",
      sha256: sha256File(PUBLIC_ENTRY),
      tools: {node: process.version, ffmpeg: toolVersion(ffmpeg), ffprobe: toolVersion(ffprobe), mediaflow_pro: String(contract.version)},
    },
    units: assembled.outcome.units.map((item) => {
      const local = unitsById.get(item.id);
      return {
        id: item.id,
        file: local.file,
        sha256: local.sha256,
        bytes: local.bytes,
        frames: local.frames,
        status: local.status === "rendered" || item.status === "rendered" ? "rendered" : "reused",
        cache_key: item.cache_key,
      };
    }),
    audio: {
      strategy: buildPlan.assembly.audio_strategy,
      status: "included-in-units",
      file: null,
      sha256: null,
      cache_key: null,
    },
    captions: {
      mode: buildPlan.assembly.caption_strategy,
      file: null,
      sha256: null,
      render_file: null,
      render_sha256: null,
      visible_in_standalone_output: false,
    },
    assembly: {status: assembled.outcome.assembly_status, cache_key: assembled.outcome.assembly_key},
    output: {
      file: relativeProjectPath(projectRoot, outputPath),
      sha256: sha256File(outputPath),
      bytes: fs.statSync(outputPath).size,
      frames: probe.frames,
      duration_seconds: probe.duration_seconds,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      audio_sample_rate: plan.output.audio_sample_rate,
      audio_channels: plan.output.audio_channels,
    },
    completed_at: nowIso(),
  };
  assertJsonSchema(validateMediaBuildReport(report), BUILD_REPORT_SCHEMA, "产品宣传片构建报告");
  writeJson(reportPath, report);
  operation.addStep(
    "assembly",
    assembled.outcome.assembly_status === "reused" ? "reused" : "rendered",
    Date.now() - assemblyStarted,
  );
  operation.finish(operationPath);
  const stageValidation = bindFullPreview(projectRoot, outputPath);
  return {
    status: "rendered",
    output: outputPath,
    output_sha256: report.output.sha256,
    report: reportPath,
    operation_report: operationPath,
    mediaflow_project: assembled.editorProject,
    plan_confirmation: confirmationPath,
    next_action: stageValidation.next_action,
  };
}
