import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {
  canonical,
  commandPath,
  ensureFile,
  escapeAssText,
  ffmpegFilterPath,
  formatAssTime,
  formatSrtTime,
  nowIso,
  parseVtt,
  probeMedia,
  projectPath,
  readJson,
  relativeProjectPath,
  run,
  sha256File,
  slash,
  toolVersion,
  writeJson,
} from "./interview_explainer_common.mjs";
import {
  loadLocalMediaEnvironment,
  mediaFlowProDescribe,
  mediaFlowProExecute,
} from "./local-media-environment.mjs";
import {assertPlanAndConfirmation} from "./interview_explainer_plan.mjs";
import {assertJsonSchema} from "./json_schema_contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(SCRIPT_DIR, "..", "schemas");
const PUBLIC_ENTRY = path.join(SCRIPT_DIR, "interview-explainer.mjs");

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceMap(projectRoot, plan) {
  const manifestInput = plan.inputs.find((item) => item.role === "media-sources");
  if (!manifestInput) throw new Error("计划缺少 media-sources 输入");
  const manifestPath = projectPath(projectRoot, manifestInput.file, "media-sources");
  const document = readJson(manifestPath);
  return new Map(document.sources.map((source) => [source.id, source]));
}

function hexToAss(value, fallback) {
  const match = String(value || "").match(/^#([0-9a-f]{6})$/i);
  if (!match) return fallback;
  const rgb = match[1];
  return `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2).toUpperCase()}&`;
}

function writeSourceAss(projectRoot, plan, segment, target) {
  const {width, height} = plan.output;
  const landscapeInset = width > height;
  const footageWidth = landscapeInset
    ? Math.round(width * (5 / 6))
    : width;
  const footageHeight = landscapeInset
    ? Math.round(footageWidth * (9 / 16))
    : Math.round(height * Number(plan.style.source_card.footage_height_ratio));
  const footageLeft = landscapeInset ? Math.round((width - footageWidth) / 2) : 0;
  const labelTop = Math.round(height * (landscapeInset ? 0.025 : 0.05));
  const titleTop = Math.round(height * (landscapeInset ? 0.062 : 0.095));
  const footageTop = landscapeInset ? Math.round(height * 0.152) : Math.round(height * 0.18);
  const originalTop = footageTop + footageHeight + Math.round(height * 0.035);
  const marginLeft = Math.max(36, Math.round(width * (landscapeInset ? 0.033 : 0.06)));
  const marginRight = marginLeft;
  const titleSize = Math.max(30, Math.round(landscapeInset ? height * 0.043 : width * 0.052));
  const originalSize = Math.max(21, Math.round(landscapeInset ? height * 0.032 : width * 0.032));
  const labelSize = Math.max(18, Math.round(landscapeInset ? height * 0.023 : width * 0.026));
  const foreground = hexToAss(plan.style.foreground, "&H00F4F1E8&");
  const muted = hexToAss(plan.style.muted, "&H00A5A8B0&");
  const accent = hexToAss(plan.style.accent, "&H005CB8E7&");
  const duration = segment.duration_frames / plan.output.fps;
  const sourceTime = `${formatClock(segment.content.start_seconds)}–`
    + `${formatClock(segment.content.end_seconds)}`;
  const styles = [
    "Style: Label,"
      + `${plan.style.font_family},${labelSize},${accent},&H000000FF,&H00000000,&H70000000,`
      + `-1,0,0,0,100,100,0,0,1,0,0,7,${marginLeft},${marginRight},0,1`,
    "Style: Title,"
      + `${plan.style.font_family},${titleSize},${foreground},&H000000FF,&H00000000,&H70000000,`
      + `-1,0,0,0,100,100,0,0,1,0,0,7,${marginLeft},${marginRight},0,1`,
    "Style: Original,"
      + `${plan.style.font_family},${originalSize},${muted},&H000000FF,&H00000000,&H70000000,`
      + `0,0,0,0,100,100,0,0,1,0,0,7,${marginLeft},${marginRight},0,1`,
  ];
  const events = [
    `Dialogue: 0,${formatAssTime(0)},${formatAssTime(duration)},Label,,0,0,0,,`
      + `{\\pos(${marginLeft},${labelTop})}`
      + `${escapeAssText(segment.content.source_label)}  /  ${sourceTime}`,
    `Dialogue: 0,${formatAssTime(0)},${formatAssTime(duration)},Title,,0,0,0,,`
      + `{\\pos(${marginLeft},${titleTop})}${escapeAssText(segment.title)}`,
  ];
  if (plan.style.source_card.show_original_text && segment.content.original_text) {
    events.push(
      `Dialogue: 0,${formatAssTime(0)},${formatAssTime(duration)},Original,,0,0,0,,`
        + `{\\pos(${marginLeft},${originalTop})}`
        + `${escapeAssText(segment.content.original_text)}`,
    );
  }
  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,"
      + "BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,"
      + "BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...events,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, ass, "utf8");
  return {
    footageWidth,
    footageHeight,
    footageLeft,
    footageTop,
    landscapeInset,
    headerHeight: Math.round(height * 0.142),
  };
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function loudnorm(plan) {
  const value = plan.output.loudness;
  return `loudnorm=I=${value.target_lufs}:TP=${value.true_peak_dbfs}:LRA=${value.lra}`;
}

function segmentCacheKey(plan, segment) {
  const renderingModules = plan.producer.modules.filter((item) => (
    /interview_explainer_(?:common|render)\.mjs$/u.test(item.file)
    || /editable-media-contract\.mjs$/u.test(item.file)
  ));
  const inputRoles = new Set(segment.kind === "source-clip"
    ? [`source:${segment.content.source_id}`]
    : [
      `audio:${segment.content.audio_source_id}`,
      `scene-package:${segment.id}`,
  ]);
  return sha256Text(canonical({
    rendering_modules: renderingModules,
    inputs: plan.inputs.filter((item) => inputRoles.has(item.role)),
    output_contract: {
      width: plan.output.width,
      height: plan.output.height,
      fps: plan.output.fps,
      audio_sample_rate: plan.output.audio_sample_rate,
      audio_channels: plan.output.audio_channels,
      loudness: plan.output.loudness,
    },
    style: plan.style,
    segment,
  }));
}

function readValidCache(cachePath, outputPath, key, ffprobe, expectedFrames) {
  if (!fs.existsSync(cachePath) || !fs.existsSync(outputPath)) return null;
  try {
    const cache = readJson(cachePath);
    if (
      cache.key !== key
      || cache.output_sha256 !== sha256File(outputPath)
      || cache.frames !== expectedFrames
    ) return null;
    const probe = probeMedia(ffprobe, outputPath, true);
    if (probe.frames !== expectedFrames || !probe.has_audio || !probe.has_video) return null;
    return cache;
  } catch {
    return null;
  }
}

function renderSourceSegment(context, segment, outputPath, cachePath, cacheKey) {
  const {projectRoot, plan, ffmpeg, ffprobe, sources} = context;
  const source = sources.get(segment.content.source_id);
  if (!source) throw new Error(`素材账本缺少 ${segment.content.source_id}`);
  const input = projectPath(projectRoot, source.file, `原片 ${source.id}`);
  ensureFile(input, `原片 ${source.id}`);
  const workingAss = projectPath(
    projectRoot,
    `working/interview-explainer/${segment.id}.${cacheKey.slice(0, 12)}.ass`,
    "source card ass",
  );
  const layout = writeSourceAss(projectRoot, plan, segment, workingAss);
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const duration = segment.duration_frames / plan.output.fps;
  const assPath = ffmpegFilterPath(workingAss);
  const compositionFilters = layout.landscapeInset
    ? [
      `color=c=0x080908:s=${plan.output.width}x${plan.output.height}:r=${plan.output.fps}[bg]`,
      `[0:v]fps=${plan.output.fps},scale=${layout.footageWidth}:${layout.footageHeight}:`
        + "force_original_aspect_ratio=decrease,"
        + `pad=${layout.footageWidth}:${layout.footageHeight}:(ow-iw)/2:(oh-ih)/2:color=black[fg]`,
      `[bg][fg]overlay=${layout.footageLeft}:${layout.footageTop}[placed]`,
      `[placed]drawbox=x=0:y=${layout.headerHeight}:w=iw:h=2:`
        + "color=0xF4BE3E@0.70:t=fill,"
        + `drawbox=x=${layout.footageLeft - 1}:y=${layout.footageTop - 1}:`
        + `w=${layout.footageWidth + 2}:h=${layout.footageHeight + 2}:`
        + "color=0xF4BE3E@0.55:t=2[composed]",
    ]
    : [
      `[0:v]fps=${plan.output.fps},split=2[bg0][fg0]`,
      `[bg0]scale=${plan.output.width}:${plan.output.height}:`
        + "force_original_aspect_ratio=increase,"
        + `crop=${plan.output.width}:${plan.output.height},`
        + "gblur=sigma=26,eq=brightness=-0.34:saturation=0.82[bg]",
      `[fg0]scale=${plan.output.width}:${layout.footageHeight}:`
        + "force_original_aspect_ratio=decrease,"
        + `pad=${plan.output.width}:${layout.footageHeight}:(ow-iw)/2:(oh-ih)/2:color=black[fg]`,
      `[bg][fg]overlay=0:${layout.footageTop}[composed]`,
    ];
  const videoFilter = [
    ...compositionFilters,
    `[composed]ass='${assPath}',trim=end_frame=${segment.duration_frames},`
      + "setpts=PTS-STARTPTS,format=yuv420p[v]",
    `[0:a]${loudnorm(plan)},aresample=${plan.output.audio_sample_rate},`
      + `aformat=channel_layouts=${plan.output.audio_channels === 1 ? "mono" : "stereo"},`
      + `apad,atrim=duration=${duration.toFixed(6)}[a]`,
  ].join(";");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(segment.content.start_seconds),
    "-t", String(segment.content.end_seconds - segment.content.start_seconds),
    "-i", input,
    "-filter_complex", videoFilter,
    "-map", "[v]", "-map", "[a]",
    "-frames:v", String(segment.duration_frames),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-r", String(plan.output.fps),
    "-c:a", "aac", "-b:a", "192k",
    "-ar", String(plan.output.audio_sample_rate),
    "-ac", String(plan.output.audio_channels),
    "-movflags", "+faststart",
    "-y", outputPath,
  ]);
  const probe = verifySegment(ffprobe, outputPath, plan, segment);
  const cache = {
    key: cacheKey,
    output_sha256: sha256File(outputPath),
    frames: probe.frames,
    created_at: nowIso(),
  };
  writeJson(cachePath, cache);
  return cache;
}

function assertMediaFlowProCapabilities(environment) {
  const describe = mediaFlowProDescribe(environment);
  if (describe.protocol !== "mediaflow-cli" || describe.version !== 2) {
    throw new Error("MediaFlow Pro describe 不是当前 v2 能力合同");
  }
  if (describe.product !== "MediaFlow Pro") {
    throw new Error(
      `当前 CLI 不是 MediaFlow Pro：${JSON.stringify(describe.product)}`,
    );
  }
  if (
    typeof describe.default_project_root !== "string"
    || !path.isAbsolute(describe.default_project_root)
  ) {
    throw new Error("MediaFlow Pro 没有声明绝对默认工程根目录");
  }
  const operations = new Map(
    (describe.operations || []).map((item) => [item.name, item]),
  );
  const required = [
    "runtime.inspect",
    "project.create",
    "project.inspect",
    "web.import",
    "timeline.get",
    "timeline.track.add",
    "timeline.clip.add",
    "web.clip.export",
  ];
  const missing = required.filter((name) => !operations.has(name));
  if (missing.length) {
    throw new Error(`MediaFlow Pro 缺少正式能力：${missing.join(", ")}`);
  }
  for (const name of required) {
    const operation = operations.get(name);
    if (
      !operation.arguments_schema
      || !operation.result_schema
      || !["none", "create", "read", "write"].includes(operation.project_access)
      || !["atomic", "task"].includes(operation.execution_mode)
      || !Array.isArray(operation.required_capabilities)
    ) {
      throw new Error(`MediaFlow Pro ${name} 没有完整的 v2 操作合同`);
    }
  }
  const capabilityCatalog = new Map(
    (describe.capabilities || []).map((item) => [item.id, item]),
  );
  const requiredCapabilityIds = new Set(
    required.flatMap((name) => operations.get(name).required_capabilities),
  );
  const unknownCapabilities = [...requiredCapabilityIds].filter(
    (id) => !capabilityCatalog.has(id),
  );
  if (unknownCapabilities.length) {
    throw new Error(
      `MediaFlow Pro 没有定义所需能力：${unknownCapabilities.join(", ")}`,
    );
  }
  const runtimeRequired = [...requiredCapabilityIds].filter(
    (id) => capabilityCatalog.get(id).availability === "runtime-inspected",
  );
  const runtime = mediaFlowProExecute(environment, null, "runtime.inspect", {});
  const runtimeStatuses = new Map(
    (runtime.capabilities || []).map((item) => [item.id, item]),
  );
  const unavailable = runtimeRequired.filter(
    (id) => runtimeStatuses.get(id)?.status !== "ready",
  );
  if (unavailable.length) {
    const reasons = unavailable.map(
      (id) => `${id}: ${runtimeStatuses.get(id)?.reason || "没有检查结果"}`,
    );
    throw new Error(`MediaFlow Pro 运行时能力未就绪：${reasons.join("；")}`);
  }
  return describe;
}

function ensureMediaFlowProProject(environment, contract, planSha, projectId) {
  const created = mediaFlowProExecute(
    environment,
    null,
    "project.create",
    {
      name: `${projectId} · interview explainer web scenes`,
      directory_name: `interview-explainer-${planSha}`,
    },
    `interview-explainer-project-${planSha}`,
  );
  const editorProject = path.resolve(created.path || "");
  const defaultRoot = path.resolve(contract.default_project_root);
  const relative = path.relative(defaultRoot, editorProject);
  if (
    !relative
    || relative.startsWith("..")
    || path.isAbsolute(relative)
    || path.dirname(relative) !== "."
  ) {
    throw new Error(
      `MediaFlow Pro 工程没有直接创建在默认根目录中：${editorProject}`,
    );
  }
  if (
    !fs.statSync(
      path.join(editorProject, "project.mfp"),
      {throwIfNoEntry: false},
    )?.isFile()
  ) {
    throw new Error(`MediaFlow Pro 没有生成工程文件：${editorProject}`);
  }
  const inspected = mediaFlowProExecute(
    environment,
    editorProject,
    "project.inspect",
    {},
  );
  if (path.resolve(inspected.path || "") !== editorProject) {
    throw new Error("MediaFlow Pro 创建结果与重新读取的工程路径不一致");
  }
  return {editorProject, inspected};
}

function exportWebScene(context, segment, webOutput, cacheKey) {
  const {projectRoot, plan, planSha, mediaflowEnvironment, editorProject} = context;
  const packageRoot = projectPath(projectRoot, segment.content.scene_package, "scene package");
  const imported = mediaFlowProExecute(
    mediaflowEnvironment,
    editorProject,
    "web.import",
    {source: packageRoot},
    `${plan.project_id}-${segment.id}-web-import-${cacheKey.slice(0, 12)}`,
  );
  const asset = imported.asset;
  if (!asset?.id) {
    throw new Error(`MediaFlow Pro 没有返回 ${segment.id} 的 Web 素材`);
  }
  let inspected = mediaFlowProExecute(
    mediaflowEnvironment,
    editorProject,
    "project.inspect",
    {},
  );
  const registeredWebAsset = (inspected.web_assets || []).find(
    (candidate) => candidate.asset_id === asset.id,
  );
  if (!registeredWebAsset?.source_hash) {
    throw new Error(`MediaFlow Pro 没有登记 ${segment.id} 的 Web 素材源哈希`);
  }
  const sequenceId = inspected.project.main_sequence_id;
  const trackName = `Interview explainer / ${planSha.slice(0, 12)}`;
  let timeline = mediaFlowProExecute(
    mediaflowEnvironment,
    editorProject,
    "timeline.get",
    {sequence_id: sequenceId},
  ).timeline;
  let track = (timeline.tracks || []).find(
    (candidate) => candidate.name === trackName,
  );
  if (!track) {
    track = mediaFlowProExecute(
      mediaflowEnvironment,
      editorProject,
      "timeline.track.add",
      {sequence_id: sequenceId, kind: "video", name: trackName},
      `${plan.project_id}-interview-explainer-track-${planSha.slice(0, 12)}`,
    ).track;
  }
  timeline = mediaFlowProExecute(
    mediaflowEnvironment,
    editorProject,
    "timeline.get",
    {sequence_id: sequenceId},
  ).timeline;
  const timelineStart = (segment.order - 1) * (plan.output.fps * 600);
  let clip = (timeline.clips || []).find(
    (candidate) => candidate.track_id === track.id
      && candidate.asset_id === asset.id
      && candidate.timeline_start === timelineStart
      && candidate.source_in === 0
      && candidate.duration === segment.duration_frames,
  );
  if (!clip) {
    clip = mediaFlowProExecute(
      mediaflowEnvironment,
      editorProject,
      "timeline.clip.add",
      {
        sequence_id: sequenceId,
        track_id: track.id,
        asset_id: asset.id,
        timeline_start: timelineStart,
        source_in: 0,
        duration: segment.duration_frames,
      },
      `${plan.project_id}-${segment.id}-web-clip-${cacheKey.slice(0, 12)}`,
    ).clip;
  }
  fs.mkdirSync(path.dirname(webOutput), {recursive: true});
  const exported = mediaFlowProExecute(
    mediaflowEnvironment,
    editorProject,
    "web.clip.export",
    {
      sequence_id: sequenceId,
      clip_id: clip.id,
      output_path: webOutput,
      format: "video",
      background: plan.style.background,
      overwrite: true,
      timeout: 1800,
    },
    `${plan.project_id}-${segment.id}-web-export-${cacheKey.slice(0, 12)}`,
  );
  if (exported.task?.status !== "completed") {
    throw new Error(
      `MediaFlow Pro 没有完成 ${segment.id}：${JSON.stringify(exported)}`,
    );
  }
  return {
    sequenceId,
    assetId: asset.id,
    sourceHash: registeredWebAsset.source_hash,
    clipId: clip.id,
    task: exported.task,
  };
}

function renderNarrationSegment(context, segment, outputPath, cachePath, cacheKey) {
  const {projectRoot, plan, ffmpeg, ffprobe, sources} = context;
  const audio = sources.get(segment.content.audio_source_id);
  if (!audio) throw new Error(`素材账本缺少旁白 ${segment.content.audio_source_id}`);
  const audioPath = projectPath(projectRoot, audio.file, `旁白 ${audio.id}`);
  const webOutput = projectPath(
    projectRoot,
    `working/interview-explainer/web/${segment.id}.${cacheKey.slice(0, 12)}.mp4`,
    "web scene output",
  );
  const web = exportWebScene(context, segment, webOutput, cacheKey);
  const duration = segment.duration_frames / plan.output.fps;
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const filters = [
    `[0:v]fps=${plan.output.fps},`
      + `scale=${plan.output.width}:${plan.output.height}:force_original_aspect_ratio=increase,`
      + `crop=${plan.output.width}:${plan.output.height},`
      + "tpad=stop_mode=clone:stop_duration=0.25,"
      + `trim=end_frame=${segment.duration_frames},setpts=PTS-STARTPTS,format=yuv420p[v]`,
    `[1:a]${loudnorm(plan)},aresample=${plan.output.audio_sample_rate},`
      + `aformat=channel_layouts=${plan.output.audio_channels === 1 ? "mono" : "stereo"},`
      + `apad,atrim=duration=${duration.toFixed(6)}[a]`,
  ].join(";");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", webOutput,
    "-i", audioPath,
    "-filter_complex", filters,
    "-map", "[v]", "-map", "[a]",
    "-frames:v", String(segment.duration_frames),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-r", String(plan.output.fps),
    "-c:a", "aac", "-b:a", "192k",
    "-ar", String(plan.output.audio_sample_rate),
    "-ac", String(plan.output.audio_channels),
    "-movflags", "+faststart",
    "-y", outputPath,
  ]);
  const probe = verifySegment(ffprobe, outputPath, plan, segment);
  const cache = {
    key: cacheKey,
    output_sha256: sha256File(outputPath),
    frames: probe.frames,
    web_export: {
      file: relativeProjectPath(projectRoot, webOutput),
      sha256: sha256File(webOutput),
      mediaflow_pro_sequence_id: web.sequenceId,
      mediaflow_pro_asset_id: web.assetId,
      mediaflow_pro_source_hash: web.sourceHash,
      mediaflow_pro_clip_id: web.clipId,
    },
    created_at: nowIso(),
  };
  writeJson(cachePath, cache);
  return cache;
}

function verifySegment(ffprobe, outputPath, plan, segment) {
  const probe = probeMedia(ffprobe, outputPath, true);
  const errors = [];
  if (probe.width !== plan.output.width || probe.height !== plan.output.height) {
    errors.push(`尺寸=${probe.width}x${probe.height}`);
  }
  if (Math.abs(Number(probe.fps) - plan.output.fps) > 0.001) {
    errors.push(`fps=${probe.fps}`);
  }
  if (probe.frames !== segment.duration_frames) {
    errors.push(`帧数=${probe.frames} 预期=${segment.duration_frames}`);
  }
  if (
    !probe.has_audio
    || probe.audio_sample_rate !== plan.output.audio_sample_rate
    || probe.audio_channels !== plan.output.audio_channels
  ) {
    errors.push(
      `音频=${probe.has_audio} ${probe.audio_sample_rate}Hz ${probe.audio_channels}ch`,
    );
  }
  if (errors.length) {
    throw new Error(`片段 ${segment.id} 验证失败：${errors.join("；")}`);
  }
  return probe;
}

function buildCaptions(projectRoot, plan) {
  const cues = [];
  for (const segment of plan.sequence) {
    const offset = segment.timeline_start_frame / plan.output.fps;
    const duration = segment.duration_frames / plan.output.fps;
    if (segment.kind === "source-clip") {
      for (const cue of segment.content.subtitle_cues) {
        cues.push({
          start: offset
            + Number(cue.source_start_seconds)
            - Number(segment.content.start_seconds),
          end: offset
            + Number(cue.source_end_seconds)
            - Number(segment.content.start_seconds),
          text: cue.text,
        });
      }
      continue;
    }
    const timingPath = projectPath(projectRoot, segment.content.timing_file, "timing file");
    for (const cue of parseVtt(timingPath)) {
      const start = Math.max(0, Math.min(duration, cue.start));
      const end = Math.max(start + 0.05, Math.min(duration, cue.end));
      cues.push({start: offset + start, end: offset + end, text: cue.text});
    }
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0;
  for (const cue of cues) {
    if (cue.start < previousEnd) cue.start = previousEnd + 0.03;
    if (cue.end <= cue.start) cue.end = cue.start + 0.08;
    previousEnd = cue.end;
  }
  const outputPath = projectPath(projectRoot, plan.output.caption_file, "caption output");
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const text = cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`,
    cue.text,
    "",
  ].join("\n")).join("\n");
  fs.writeFileSync(outputPath, text, "utf8");
  const burnInPath = outputPath.replace(/\.[^.]+$/, ".burn-in.ass");
  const fontSize = Math.max(
    26,
    Math.round(Math.min(plan.output.width * 0.045, plan.output.height * 0.06)),
  );
  const marginV = Math.max(48, Math.round(plan.output.height * 0.06));
  const marginH = Math.max(40, Math.round(plan.output.width * 0.055));
  const fontFamily = String(plan.style.font_family || "sans-serif")
    .replaceAll(",", " ")
    .replaceAll("\n", " ");
  const maxLineUnits = Math.max(
    12,
    Math.floor(
      (plan.output.width - marginH * 2)
      / (fontSize * 1.08),
    ),
  );
  const characterUnits = (character) => {
    if (/\s/u.test(character)) return 0.35;
    if (/[\u0000-\u024f]/u.test(character)) return 0.56;
    return 1;
  };
  const wrapSubtitle = (value) => String(value).split(/\r?\n/u).flatMap((sourceLine) => {
    const lines = [];
    let current = "";
    let units = 0;
    for (const character of [...sourceLine.trim()]) {
      const nextUnits = characterUnits(character);
      if (current && units + nextUnits > maxLineUnits) {
        let breakAt = -1;
        const characters = [...current];
        for (let index = characters.length - 1; index >= 0; index -= 1) {
          if (/[\s，。；？！：、,.!?;:]/u.test(characters[index])) {
            breakAt = index;
            break;
          }
        }
        if (breakAt >= Math.floor(characters.length * 0.55)) {
          lines.push(characters.slice(0, breakAt + 1).join("").trim());
          current = characters.slice(breakAt + 1).join("").trimStart();
          units = [...current].reduce(
            (total, item) => total + characterUnits(item),
            0,
          );
        } else {
          lines.push(current.trim());
          current = "";
          units = 0;
        }
      }
      current += character;
      units += nextUnits;
    }
    if (current.trim()) lines.push(current.trim());
    return lines.length ? lines : [""];
  }).join("\n");
  const assTime = (seconds) => {
    const total = Math.max(0, Math.round(seconds * 100));
    const hours = Math.floor(total / 360000);
    const minutes = Math.floor((total % 360000) / 6000);
    const secs = Math.floor((total % 6000) / 100);
    const centiseconds = total % 100;
    return `${hours}:${String(minutes).padStart(2, "0")}:`
      + `${String(secs).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
  };
  const assText = (value) => String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r?\n/g, "\\N");
  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${plan.output.width}`,
    `PlayResY: ${plan.output.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
      + "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
      + "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
      + "Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontFamily},${fontSize},&H00FFFFFF,&H000000FF,`
      + `&H90000000,&H40000000,-1,0,0,0,100,100,0,0,1,3,1,2,`
      + `${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
      + "Effect, Text",
    ...cues.map((cue) => (
      `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},`
      + `Default,,0,0,0,,${assText(wrapSubtitle(cue.text))}`
    )),
    "",
  ].join("\n");
  fs.writeFileSync(burnInPath, ass, "utf8");
  return {file: outputPath, burnInFile: burnInPath, cues};
}

function concatSegments(context, segmentFiles, captions, outputPath, planSha) {
  const {projectRoot, plan, ffmpeg} = context;
  const concatPath = projectPath(
    projectRoot,
    `working/interview-explainer/concat.${planSha.slice(0, 12)}.txt`,
    "concat manifest",
  );
  fs.mkdirSync(path.dirname(concatPath), {recursive: true});
  const concatText = segmentFiles.map((file) => {
    const normalized = slash(path.resolve(file)).replaceAll("'", "'\\''");
    return `file '${normalized}'`;
  }).join("\n");
  fs.writeFileSync(concatPath, `${concatText}\n`, "utf8");
  const rawOutput = projectPath(
    projectRoot,
    `working/interview-explainer/raw.${planSha.slice(0, 12)}.mp4`,
    "raw concat",
  );
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-c", "copy", "-movflags", "+faststart",
    "-y", rawOutput,
  ]);
  const unique = `${Date.now()}-${process.pid}`;
  const temporaryOutput = projectPath(
    projectRoot,
    `working/interview-explainer/final.${planSha.slice(0, 12)}.${unique}.partial.mp4`,
    "temporary final",
  );
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const duration = plan.total_frames / plan.output.fps;
  const audioFilter = `${loudnorm(plan)},aresample=${plan.output.audio_sample_rate},`
    + `aformat=channel_layouts=${plan.output.audio_channels === 1 ? "mono" : "stereo"},`
    + `apad,atrim=duration=${duration.toFixed(6)}`;
  const common = [
    "-hide_banner", "-loglevel", "error",
    "-i", rawOutput,
  ];
  if (plan.output.caption_mode === "burned-in") {
    const subtitleFilter = `ass='${ffmpegFilterPath(captions.burnInFile)}'`;
    run(ffmpeg, [
      ...common,
      "-vf", subtitleFilter,
      "-af", audioFilter,
      "-frames:v", String(plan.total_frames),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      "-y", temporaryOutput,
    ]);
  } else if (plan.output.caption_mode === "embedded-track") {
    run(ffmpeg, [
      ...common,
      "-i", captionPath,
      "-map", "0:v:0", "-map", "0:a:0", "-map", "1:0",
      "-c:v", "copy",
      "-af", audioFilter,
      "-c:a", "aac", "-b:a", "192k",
      "-c:s", "mov_text",
      "-metadata:s:s:0", "language=zho",
      "-frames:v", String(plan.total_frames),
      "-movflags", "+faststart",
      "-y", temporaryOutput,
    ]);
  } else {
    run(ffmpeg, [
      ...common,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy",
      "-af", audioFilter,
      "-c:a", "aac", "-b:a", "192k",
      "-frames:v", String(plan.total_frames),
      "-movflags", "+faststart",
      "-y", temporaryOutput,
    ]);
  }
  if (fs.existsSync(outputPath)) {
    throw new Error(
      `正式输出已经存在：${outputPath}。入口不会覆盖或自动归档，`
      + "请明确使用新的 output.file。",
    );
  }
  fs.renameSync(temporaryOutput, outputPath);
  return {rawOutput, concatPath};
}

function verifyFinal(ffprobe, outputPath, plan) {
  const probe = probeMedia(ffprobe, outputPath, true);
  const errors = [];
  if (probe.frames !== plan.total_frames) {
    errors.push(`帧数=${probe.frames} 预期=${plan.total_frames}`);
  }
  if (probe.width !== plan.output.width || probe.height !== plan.output.height) {
    errors.push(`尺寸=${probe.width}x${probe.height}`);
  }
  if (Math.abs(Number(probe.fps) - plan.output.fps) > 0.001) {
    errors.push(`fps=${probe.fps}`);
  }
  if (
    !probe.has_audio
    || probe.audio_sample_rate !== plan.output.audio_sample_rate
    || probe.audio_channels !== plan.output.audio_channels
  ) {
    errors.push(
      `音频=${probe.has_audio} ${probe.audio_sample_rate}Hz ${probe.audio_channels}ch`,
    );
  }
  if (plan.output.caption_mode === "embedded-track" && !probe.has_subtitle) {
    errors.push("没有真实字幕轨");
  }
  if (errors.length) throw new Error(`最终视频验证失败：${errors.join("；")}`);
  return probe;
}

export function renderInterviewExplainer(options) {
  const projectRoot = path.resolve(options.project);
  const {plan, planPath, confirmationPath} = assertPlanAndConfirmation(
    projectRoot,
    options.plan || "interview-explainer-plan.json",
    options.confirmation || "interview-explainer-plan.confirmation.json",
  );
  const planSha = sha256File(planPath);
  const ffmpeg = commandPath("ffmpeg", options.ffmpeg, "FFMPEG_BIN");
  const ffprobe = commandPath("ffprobe", options.ffprobe, "FFPROBE_BIN");
  const mediaflowEnvironment = loadLocalMediaEnvironment(options.localConfig);
  const mediaFlowProContract = assertMediaFlowProCapabilities(mediaflowEnvironment);
  const {editorProject} = ensureMediaFlowProProject(
    mediaflowEnvironment,
    mediaFlowProContract,
    planSha,
    plan.project_id,
  );
  const sources = sourceMap(projectRoot, plan);
  const context = {
    projectRoot,
    plan,
    planSha,
    ffmpeg,
    ffprobe,
    mediaflowEnvironment,
    editorProject,
    sources,
  };

  const segmentReports = [];
  const segmentFiles = [];
  for (const segment of plan.sequence) {
    const key = segmentCacheKey(plan, segment);
    const base = `${segment.id}.${key.slice(0, 12)}`;
    const outputPath = projectPath(
      projectRoot,
      `renders/segments/${base}.mp4`,
      "segment output",
    );
    const cachePath = projectPath(
      projectRoot,
      `working/interview-explainer/cache/${base}.json`,
      "segment cache",
    );
    let cache = readValidCache(
      cachePath,
      outputPath,
      key,
      ffprobe,
      segment.duration_frames,
    );
    let status = "reused";
    if (!cache) {
      status = "rendered";
      cache = segment.kind === "source-clip"
        ? renderSourceSegment(context, segment, outputPath, cachePath, key)
        : renderNarrationSegment(context, segment, outputPath, cachePath, key);
    }
    segmentFiles.push(outputPath);
    segmentReports.push({
      id: segment.id,
      file: relativeProjectPath(projectRoot, outputPath),
      sha256: sha256File(outputPath),
      bytes: fs.statSync(outputPath).size,
      frames: segment.duration_frames,
      status,
      cache_key: key,
      producer_detail: cache.web_export || null,
    });
    process.stdout.write(`${status} ${segment.id}\n`);
  }

  const captions = buildCaptions(projectRoot, plan);
  const outputPath = projectPath(projectRoot, plan.output.file, "final output");
  const existingReportPath = projectPath(
    projectRoot,
    options.report || "reports/media-build-report.json",
    "build report",
  );
  if (fs.existsSync(outputPath) && fs.existsSync(existingReportPath)) {
    const existing = readJson(existingReportPath);
    if (
      existing.plan_sha256 === planSha
      && existing.output?.file === relativeProjectPath(projectRoot, outputPath)
      && existing.output?.sha256 === sha256File(outputPath)
    ) {
      return {
        status: "reused",
        output: outputPath,
        output_sha256: existing.output.sha256,
        report: existingReportPath,
      };
    }
  }
  concatSegments(context, segmentFiles, captions, outputPath, planSha);
  const finalProbe = verifyFinal(ffprobe, outputPath, plan);
  const visible = plan.output.caption_mode === "burned-in"
    || plan.output.caption_mode === "embedded-track";
  const buildReport = {
    protocol: "visual-multimedia-media-build-report",
    version: 1,
    profile: "interview-explainer",
    plan: relativeProjectPath(projectRoot, planPath),
    plan_sha256: planSha,
    confirmation: relativeProjectPath(projectRoot, confirmationPath),
    producer: {
      entry: "scripts/interview-explainer.mjs",
      sha256: sha256File(PUBLIC_ENTRY),
      tools: {
        node: process.version,
        ffmpeg: toolVersion(ffmpeg),
        ffprobe: toolVersion(ffprobe),
        mediaflow_pro: mediaFlowProContract.version.toString(),
      },
    },
    segments: segmentReports.map((item) => ({
      id: item.id,
      file: item.file,
      sha256: item.sha256,
      bytes: item.bytes,
      frames: item.frames,
    })),
    captions: {
      mode: plan.output.caption_mode,
      file: relativeProjectPath(projectRoot, captions.file),
      sha256: sha256File(captions.file),
      render_file: plan.output.caption_mode === "burned-in"
        ? relativeProjectPath(projectRoot, captions.burnInFile)
        : null,
      render_sha256: plan.output.caption_mode === "burned-in"
        ? sha256File(captions.burnInFile)
        : null,
      visible_in_standalone_output: visible,
    },
    output: {
      file: relativeProjectPath(projectRoot, outputPath),
      sha256: sha256File(outputPath),
      bytes: fs.statSync(outputPath).size,
      frames: finalProbe.frames,
      duration_seconds: finalProbe.duration_seconds,
      width: finalProbe.width,
      height: finalProbe.height,
      fps: finalProbe.fps,
      audio_sample_rate: finalProbe.audio_sample_rate,
      audio_channels: finalProbe.audio_channels,
    },
    completed_at: nowIso(),
  };
  assertJsonSchema(
    buildReport,
    path.join(SCHEMA_DIR, "media-build-report.v1.schema.json"),
    "媒体构建报告",
  );
  writeJson(existingReportPath, buildReport);
  const detailPath = projectPath(
    projectRoot,
    `reports/interview-explainer-segments.${planSha.slice(0, 12)}.json`,
    "segment detail report",
  );
  writeJson(detailPath, {
    protocol: "visual-multimedia-interview-explainer-segments",
    version: 1,
    plan_sha256: planSha,
    mediaflow_pro_project: {
      product: mediaFlowProContract.product,
      default_root: path.resolve(mediaFlowProContract.default_project_root),
      path: editorProject,
    },
    segments: segmentReports,
  });
  return {
    status: "rendered",
    output: outputPath,
    output_sha256: buildReport.output.sha256,
    report: existingReportPath,
  };
}
