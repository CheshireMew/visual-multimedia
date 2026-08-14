import fs from "node:fs";
import path from "node:path";

import {
  mediaFlowProDescribe,
  mediaFlowProExecute,
  mediaFlowProWaitForTask,
} from "./local-media-environment.mjs";

const REQUIRED_VIDEO_OPERATIONS = [
  "runtime.inspect",
  "project.create",
  "project.inspect",
  "asset.import",
  "web.import",
  "timeline.get",
  "timeline.track.add",
  "timeline.clip.add",
  "timeline.clip.delete",
  "timeline.clip.source.replace",
  "web.clip.export",
  "export.sequence.build",
  "task.wait",
];

export function assertMediaFlowProVideoCapabilities(environment) {
  const describe = mediaFlowProDescribe(environment);
  if (describe.protocol !== "mediaflow-editor" || describe.version !== 4) {
    throw new Error("MediaFlow Pro describe 不是当前 v4 能力合同");
  }
  if (describe.product !== "MediaFlow Pro") {
    throw new Error(`当前 CLI 不是 MediaFlow Pro：${JSON.stringify(describe.product)}`);
  }
  if (typeof describe.default_project_root !== "string" || !path.isAbsolute(describe.default_project_root)) {
    throw new Error("MediaFlow Pro 没有声明绝对默认工程根目录");
  }
  const operations = new Map((describe.operations || []).map((item) => [item.name, item]));
  const missing = REQUIRED_VIDEO_OPERATIONS.filter((name) => !operations.has(name));
  if (missing.length) throw new Error(`MediaFlow Pro 缺少正式能力：${missing.join(", ")}`);
  for (const name of REQUIRED_VIDEO_OPERATIONS) {
    const operation = operations.get(name);
    if (
      !["none", "create", "read", "write"].includes(operation.project_access)
      || !["atomic", "task"].includes(operation.execution_mode)
      || !Array.isArray(operation.required_capabilities)
    ) throw new Error(`MediaFlow Pro ${name} 没有完整的 v4 操作摘要`);
  }
  const capabilityCatalog = new Map((describe.capabilities || []).map((item) => [item.id, item]));
  const requiredCapabilityIds = new Set(
    REQUIRED_VIDEO_OPERATIONS.flatMap((name) => operations.get(name).required_capabilities),
  );
  const unknown = [...requiredCapabilityIds].filter((id) => !capabilityCatalog.has(id));
  if (unknown.length) throw new Error(`MediaFlow Pro 没有定义所需能力：${unknown.join(", ")}`);
  const runtime = mediaFlowProExecute(environment, null, "runtime.inspect", {});
  const statuses = new Map((runtime.capabilities || []).map((item) => [item.id, item]));
  const unavailable = [...requiredCapabilityIds].filter((id) => (
    capabilityCatalog.get(id).availability === "runtime-inspected"
    && statuses.get(id)?.status !== "ready"
  ));
  if (unavailable.length) {
    throw new Error(`MediaFlow Pro 运行时能力未就绪：${unavailable.map(
      (id) => `${id}: ${statuses.get(id)?.reason || "没有检查结果"}`,
    ).join("；")}`);
  }
  return describe;
}

export function ensureMediaFlowProVideoProject(environment, contract, projectSpec, output) {
  const requestedProfile = {
    width: output.width,
    height: output.height,
    fps_numerator: output.fps,
    fps_denominator: 1,
    color_mode: "sdr_bt709",
    bit_depth: 8,
    audio_sample_rate: output.audio_sample_rate,
    audio_channels: output.audio_channels,
  };
  const created = mediaFlowProExecute(environment, null, "project.create", {
    name: projectSpec.name,
    directory_name: projectSpec.directoryName,
    profile: requestedProfile,
  }, projectSpec.requestId);
  const editorProject = path.resolve(created.path || "");
  const defaultRoot = path.resolve(contract.default_project_root);
  const relative = path.relative(defaultRoot, editorProject);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) !== ".") {
    throw new Error(`MediaFlow Pro 工程没有直接创建在默认根目录中：${editorProject}`);
  }
  if (!fs.statSync(path.join(editorProject, "project.mfp"), {throwIfNoEntry: false})?.isFile()) {
    throw new Error(`MediaFlow Pro 没有生成工程文件：${editorProject}`);
  }
  const inspected = mediaFlowProExecute(environment, editorProject, "project.inspect", {});
  if (path.resolve(inspected.path || "") !== editorProject) {
    throw new Error("MediaFlow Pro 创建结果与重新读取的工程路径不一致");
  }
  const mainSequence = (inspected.sequences || []).find(
    (item) => item.id === inspected.project?.main_sequence_id,
  );
  const actualProfile = mainSequence?.profile || {};
  for (const [field, expected] of Object.entries(requestedProfile)) {
    if (actualProfile[field] !== expected) {
      throw new Error(`MediaFlow Pro 工程 profile.${field}=${actualProfile[field]}，预期 ${expected}`);
    }
  }
  return {editorProject, inspected};
}

export function resolveMediaFlowArtifact(editorProject, artifact) {
  if (!artifact) return null;
  if (artifact.scope === "external") return path.resolve(artifact.path);
  if (artifact.scope === "project") return path.resolve(editorProject, ...String(artifact.path).split("/"));
  throw new Error(`MediaFlow Pro 返回未知素材范围：${JSON.stringify(artifact)}`);
}

export function exportEditableWebScene({
  environment,
  editorProject,
  projectId,
  unitId,
  packageRoot,
  durationFrames,
  timelineStart,
  outputPath,
  background,
  requestKey,
  trackName,
}) {
  const imported = mediaFlowProExecute(
    environment,
    editorProject,
    "web.import",
    {source: packageRoot},
    `${projectId}-${unitId}-web-import-${requestKey}`,
  );
  const asset = imported.asset;
  if (!asset?.id) throw new Error(`MediaFlow Pro 没有返回 ${unitId} 的 Web 素材`);
  let inspected = mediaFlowProExecute(environment, editorProject, "project.inspect", {});
  const registered = (inspected.web_assets || []).find((candidate) => candidate.asset_id === asset.id);
  if (!registered?.source_hash) throw new Error(`MediaFlow Pro 没有登记 ${unitId} 的 Web 素材源哈希`);
  const sequenceId = inspected.project.main_sequence_id;
  let timeline = mediaFlowProExecute(environment, editorProject, "timeline.get", {sequence_id: sequenceId}).timeline;
  let track = (timeline.tracks || []).find((candidate) => candidate.name === trackName);
  if (!track) {
    track = mediaFlowProExecute(environment, editorProject, "timeline.track.add", {
      sequence_id: sequenceId,
      kind: "video",
      name: trackName,
    }, `${projectId}-web-track-${requestKey}`).track;
  }
  timeline = mediaFlowProExecute(environment, editorProject, "timeline.get", {sequence_id: sequenceId}).timeline;
  let clip = (timeline.clips || []).find((candidate) => (
    candidate.track_id === track.id
    && candidate.asset_id === asset.id
    && candidate.timeline_start === timelineStart
    && candidate.source_in === 0
    && candidate.duration === durationFrames
  ));
  if (!clip) {
    clip = mediaFlowProExecute(environment, editorProject, "timeline.clip.add", {
      sequence_id: sequenceId,
      track_id: track.id,
      asset_id: asset.id,
      timeline_start: timelineStart,
      source_in: 0,
      duration: durationFrames,
    }, `${projectId}-${unitId}-web-clip-${requestKey}`).clip;
  }
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const receipt = mediaFlowProExecute(environment, editorProject, "web.clip.export", {
    sequence_id: sequenceId,
    clip_id: clip.id,
    output_path: outputPath,
    format: "video",
    background,
    overwrite: true,
    timeout: 1800,
  }, `${projectId}-${unitId}-web-export-${requestKey}`);
  const task = mediaFlowProWaitForTask(environment, editorProject, receipt, 1800);
  return {
    sequenceId,
    assetId: asset.id,
    sourceHash: registered.source_hash,
    clipId: clip.id,
    task,
  };
}

export function assemblePreparedVideoUnits({
  environment,
  contract,
  projectSpec,
  output,
  units,
  outputPath,
  presetName,
  requestKey,
}) {
  const assemblyProject = ensureMediaFlowProVideoProject(environment, contract, projectSpec, output);
  const editorProject = assemblyProject.editorProject;
  const sequenceId = assemblyProject.inspected.project.main_sequence_id;
  const imported = units.map((unit) => {
    const receipt = mediaFlowProExecute(environment, editorProject, "asset.import", {
      source: unit.absoluteFile,
      timeout: 600,
    }, `${projectSpec.requestId}-${unit.id}-asset-${unit.sha256.slice(0, 12)}`);
    const task = mediaFlowProWaitForTask(environment, editorProject, receipt, 600);
    if (task.outcome?.outcome_type !== "imported_asset" || !task.outcome.asset_id) {
      throw new Error(`MediaFlow Pro 没有导入构建单元：${unit.id}`);
    }
    return {...unit, assetId: task.outcome.asset_id};
  });
  const trackName = `${presetName} / prepared units`;
  let timeline = mediaFlowProExecute(environment, editorProject, "timeline.get", {sequence_id: sequenceId}).timeline;
  let track = (timeline.tracks || []).find((item) => item.name === trackName);
  if (!track) {
    track = mediaFlowProExecute(environment, editorProject, "timeline.track.add", {
      sequence_id: sequenceId,
      kind: "video",
      name: trackName,
    }, `${projectSpec.requestId}-track`).track;
  }
  timeline = mediaFlowProExecute(environment, editorProject, "timeline.get", {sequence_id: sequenceId}).timeline;
  const existing = (timeline.clips || []).filter((clip) => clip.track_id === track.id);
  const retained = new Set();
  const expected = imported.map((unit) => {
    const candidate = existing.find((clip) => (
      !retained.has(clip.id)
      && clip.timeline_start === unit.timelineStartFrame
      && clip.source_in === 0
      && clip.duration === unit.frames
    ));
    if (!candidate) return {...unit, clip: null};
    retained.add(candidate.id);
    if (candidate.asset_id === unit.assetId) return {...unit, clip: candidate};
    const replaced = mediaFlowProExecute(environment, editorProject, "timeline.clip.source.replace", {
      sequence_id: sequenceId,
      clip_id: candidate.id,
      asset_id: unit.assetId,
    }, `${projectSpec.requestId}-${unit.id}-replace-${requestKey}`).clip;
    return {...unit, clip: replaced};
  });
  const stale = existing.filter((clip) => !retained.has(clip.id));
  if (stale.length) {
    mediaFlowProExecute(environment, editorProject, "timeline.clip.delete", {
      sequence_id: sequenceId,
      clip_ids: stale.map((clip) => clip.id),
      ripple: false,
    }, `${projectSpec.requestId}-prune-${requestKey}`);
  }
  const placed = expected.map((unit) => {
    if (unit.clip) return unit;
    const clip = mediaFlowProExecute(environment, editorProject, "timeline.clip.add", {
      sequence_id: sequenceId,
      track_id: track.id,
      asset_id: unit.assetId,
      timeline_start: unit.timelineStartFrame,
      source_in: 0,
      duration: unit.frames,
    }, `${projectSpec.requestId}-${unit.id}-clip-${requestKey}`).clip;
    return {...unit, clip};
  });
  const receipt = mediaFlowProExecute(environment, editorProject, "export.sequence.build", {
    sequence_id: sequenceId,
    units: units.map((unit) => ({
      id: unit.id,
      start_frame: unit.timelineStartFrame,
      end_frame: unit.timelineStartFrame + unit.frames,
    })),
    output_path: outputPath,
    format: "h264",
    preset: {
      name: presetName,
      format: "h264",
      container: "mp4",
      encoder_policy: {mode: "software", vendor: "auto"},
      audio_codec: "aac",
      pixel_format: "yuv420p",
      quality_value: 18,
      preset: "medium",
      gop_frames: Math.max(1, output.fps * 2),
      audio_bitrate: 192000,
    },
    overwrite: false,
    timeout: 3600,
  }, `${projectSpec.requestId}-build-${requestKey}`);
  const task = mediaFlowProWaitForTask(environment, editorProject, receipt, 3600);
  if (task.outcome?.outcome_type !== "sequence_build") {
    throw new Error(`MediaFlow Pro 分段构建失败：${JSON.stringify(task)}`);
  }
  const unitsById = new Map(placed.map((unit) => [unit.id, unit]));
  return {
    editorProject,
    outcome: task.outcome,
    units: task.outcome.units.map((unit) => ({...unitsById.get(unit.id), mediaflow: unit})),
    audioFile: resolveMediaFlowArtifact(editorProject, task.outcome.audio.output),
    reportFile: resolveMediaFlowArtifact(editorProject, task.outcome.report),
  };
}
