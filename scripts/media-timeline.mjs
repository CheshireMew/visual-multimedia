#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
export const MEDIA_TIMELINE_SCHEMA_PATH = path.join(
  SKILL_ROOT,
  "schemas",
  "media-timeline.v1.schema.json",
);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = {_: []};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      result[name] = true;
      continue;
    }
    result[name] = next;
    index += 1;
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (value == null || value === true || !String(value).trim()) {
    fail(`缺少 --${name}`);
  }
  return String(value).trim();
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} 不是有效 JSON：${filePath}\n${error.message}`);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function resolveProjectFile(root, value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} 必须是非空字符串`);
  }
  if (path.isAbsolute(value) || /^(?:[a-z]+:)?\/\//i.test(value)) {
    fail(`${label} 必须是时间线工程内的相对路径：${value}`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) {
    fail(`${label} 不能离开时间线工程：${value}`);
  }
  const target = path.resolve(root, ...normalized.split("/"));
  const relation = path.relative(path.resolve(root), target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    fail(`${label} 不能离开时间线工程：${value}`);
  }
  return target;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function uniqueIds(items, label, errors) {
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) {
      errors.push(`${label} 中存在空 id`);
      continue;
    }
    if (ids.has(item.id)) errors.push(`${label} 存在重复 id：${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function timelineDuration(document) {
  let duration = 0;
  for (const track of document.tracks || []) {
    for (const clip of track.clips || []) {
      const end = Number(clip.timeline_start_seconds || 0)
        + Number(clip.duration_seconds || 0);
      if (Number.isFinite(end)) duration = Math.max(duration, end);
    }
  }
  return document.profile?.duration_seconds ?? duration;
}

export function validateMediaTimeline(target) {
  const timelinePath = path.resolve(target);
  const errors = [];
  if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
    return {ok: false, errors: [`时间线文件不存在：${timelinePath}`]};
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  } catch (error) {
    return {ok: false, errors: [`时间线不是有效 JSON：${error.message}`]};
  }
  const root = path.dirname(timelinePath);
  if (document.protocol !== "visual-multimedia-timeline" || document.version !== 1) {
    errors.push("时间线必须使用 visual-multimedia-timeline v1");
  }
  if (typeof document.project_id !== "string" || !document.project_id.trim()) {
    errors.push("project_id 不能为空");
  }
  const profile = document.profile || {};
  if (!Number.isInteger(profile.width) || profile.width < 16 || profile.width % 2 !== 0) {
    errors.push("profile.width 必须是大于等于 16 的偶数");
  }
  if (!Number.isInteger(profile.height) || profile.height < 16 || profile.height % 2 !== 0) {
    errors.push("profile.height 必须是大于等于 16 的偶数");
  }
  if (!positiveNumber(profile.frame_rate)) errors.push("profile.frame_rate 必须大于 0");
  if (!Number.isInteger(profile.sample_rate) || profile.sample_rate < 8000) {
    errors.push("profile.sample_rate 必须是大于等于 8000 的整数");
  }
  if (!["mono", "stereo"].includes(profile.channel_layout)) {
    errors.push("profile.channel_layout 必须是 mono 或 stereo");
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(profile.background || "")) {
    errors.push("profile.background 必须是 #RRGGBB");
  }

  if (!Array.isArray(document.sources)) errors.push("sources 必须是数组");
  if (!Array.isArray(document.tracks) || document.tracks.length === 0) {
    errors.push("tracks 必须是非空数组");
  }
  if (!Array.isArray(document.subtitle_styles)) errors.push("subtitle_styles 必须是数组");
  if (!Array.isArray(document.markers)) errors.push("markers 必须是数组");
  const sources = Array.isArray(document.sources) ? document.sources : [];
  const tracks = Array.isArray(document.tracks) ? document.tracks : [];
  const styles = Array.isArray(document.subtitle_styles) ? document.subtitle_styles : [];
  const markers = Array.isArray(document.markers) ? document.markers : [];
  uniqueIds(sources, "sources", errors);
  uniqueIds(tracks, "tracks", errors);
  const styleIds = uniqueIds(styles, "subtitle_styles", errors);
  uniqueIds(markers, "markers", errors);
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  for (const source of sources) {
    if (!["video", "audio", "image", "web-render"].includes(source.kind)) {
      errors.push(`素材 ${source.id || "未命名"} 的 kind 无效`);
    }
    if (!/^[a-f0-9]{64}$/.test(source.sha256 || "")) {
      errors.push(`素材 ${source.id || "未命名"} 缺少有效 SHA-256`);
    }
    try {
      const filePath = resolveProjectFile(root, source.file, `素材 ${source.id} 的 file`);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        errors.push(`素材 ${source.id} 不存在：${source.file}`);
      } else if (sha256File(filePath) !== source.sha256) {
        errors.push(`素材 ${source.id} 的 SHA-256 不一致`);
      }
    } catch (error) {
      errors.push(error.message);
    }
    if (source.duration_seconds != null && !positiveNumber(source.duration_seconds)) {
      errors.push(`素材 ${source.id} 的 duration_seconds 必须大于 0`);
    }
  }

  const clipIds = new Set();
  for (const track of tracks) {
    if (!["video", "audio", "subtitle"].includes(track.kind)) {
      errors.push(`轨道 ${track.id || "未命名"} 的 kind 无效`);
    }
    if (!Array.isArray(track.clips)) {
      errors.push(`轨道 ${track.id || "未命名"} 的 clips 必须是数组`);
      continue;
    }
    for (const clip of track.clips) {
      if (!clip || typeof clip.id !== "string" || !clip.id.trim()) {
        errors.push(`轨道 ${track.id} 中存在空 clip id`);
        continue;
      }
      if (clipIds.has(clip.id)) errors.push(`片段 id 重复：${clip.id}`);
      clipIds.add(clip.id);
      if (!nonNegativeNumber(clip.timeline_start_seconds)) {
        errors.push(`片段 ${clip.id} 的 timeline_start_seconds 必须大于等于 0`);
      }
      if (!positiveNumber(clip.duration_seconds)) {
        errors.push(`片段 ${clip.id} 的 duration_seconds 必须大于 0`);
      }
      const expectedType = {video: ["media", "freeze"], audio: ["media"], subtitle: ["caption"]}[track.kind] || [];
      if (!expectedType.includes(clip.type)) {
        errors.push(`轨道 ${track.id} 不能包含 ${clip.type || "未知"} 片段 ${clip.id}`);
      }
      if (clip.type === "caption") {
        if (typeof clip.text !== "string" || !clip.text.trim()) {
          errors.push(`字幕片段 ${clip.id} 的 text 不能为空`);
        }
        if (!styleIds.has(clip.style_id)) {
          errors.push(`字幕片段 ${clip.id} 引用了不存在的样式 ${clip.style_id}`);
        }
        continue;
      }
      const source = sourceById.get(clip.source_id);
      if (!source) {
        errors.push(`片段 ${clip.id} 引用了不存在的素材 ${clip.source_id}`);
        continue;
      }
      if (track.kind === "video" && source.kind === "audio") {
        errors.push(`视频片段 ${clip.id} 不能使用音频素材`);
      }
      if (track.kind === "audio" && !["audio", "video", "web-render"].includes(source.kind)) {
        errors.push(`音频片段 ${clip.id} 的素材没有音轨`);
      }
      if (clip.type === "media") {
        if (!nonNegativeNumber(clip.source_in_seconds)) {
          errors.push(`片段 ${clip.id} 的 source_in_seconds 必须大于等于 0`);
        }
        if (clip.speed != null && !positiveNumber(clip.speed)) {
          errors.push(`片段 ${clip.id} 的 speed 必须大于 0`);
        }
      }
      if (clip.type === "freeze" && !nonNegativeNumber(clip.source_time_seconds)) {
        errors.push(`定格片段 ${clip.id} 的 source_time_seconds 必须大于等于 0`);
      }
      for (const key of ["fade_in", "fade_out"]) {
        const transition = clip[key];
        if (!transition) continue;
        if (!["none", "fade"].includes(transition.kind) || !nonNegativeNumber(transition.duration_seconds)) {
          errors.push(`片段 ${clip.id} 的 ${key} 无效`);
        } else if (transition.duration_seconds > clip.duration_seconds) {
          errors.push(`片段 ${clip.id} 的 ${key} 不能长于片段`);
        }
      }
    }
  }

  for (const marker of markers) {
    if (!nonNegativeNumber(marker.time_seconds)) {
      errors.push(`标记 ${marker.id || "未命名"} 的 time_seconds 必须大于等于 0`);
    }
    if (typeof marker.label !== "string" || !marker.label.trim()) {
      errors.push(`标记 ${marker.id || "未命名"} 的 label 不能为空`);
    }
  }
  const derivedDuration = timelineDuration(document);
  if (!positiveNumber(derivedDuration)) errors.push("时间线总时长必须大于 0");
  if (
    positiveNumber(profile.duration_seconds)
    && tracks.some((track) => (track.clips || []).some((clip) => (
      clip.timeline_start_seconds + clip.duration_seconds > profile.duration_seconds + 1e-6
    )))
  ) errors.push("存在片段超出 profile.duration_seconds");

  return {
    ok: errors.length === 0,
    errors,
    timeline_path: timelinePath,
    project_root: root,
    duration_seconds: derivedDuration,
    source_count: sources.length,
    track_count: tracks.length,
    clip_count: clipIds.size,
    marker_count: markers.length,
    document,
  };
}

function findCommand(name, explicit = null) {
  if (explicit) {
    const candidate = path.resolve(String(explicit));
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      fail(`${name} 不存在：${candidate}`);
    }
    return candidate;
  }
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [name], {encoding: "utf8", windowsHide: true});
  const candidate = (result.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (result.status !== 0 || !candidate) fail(`找不到 ${name}；请使用 --${name} 提供已有可执行文件`);
  return candidate;
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${label}失败（退出码 ${result.status}）\n${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function probeSource(ffprobe, filePath) {
  const result = run(ffprobe, [
    "-v", "error",
    "-show_entries", "stream=codec_type:format=duration",
    "-of", "json",
    filePath,
  ], `探测素材 ${filePath}`);
  const document = JSON.parse(result.stdout);
  const kinds = new Set((document.streams || []).map((stream) => stream.codec_type));
  return {
    hasVideo: kinds.has("video"),
    hasAudio: kinds.has("audio"),
    duration: Number(document.format?.duration || 0) || null,
  };
}

function number(value) {
  return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function atempoFilters(speed) {
  const filters = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-6) filters.push(`atempo=${number(remaining)}`);
  return filters;
}

function fadeDuration(clip, key) {
  const transition = clip[key];
  return transition?.kind === "fade" ? Number(transition.duration_seconds || 0) : 0;
}

function placementFilters(placement, profile) {
  const width = Number(placement?.width || profile.width);
  const height = Number(placement?.height || profile.height);
  const fit = placement?.fit || "contain";
  if (fit === "stretch") return [`scale=${width}:${height}`];
  if (fit === "cover") {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
    ];
  }
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
  ];
}

function assColor(value) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match) return "&H00FFFFFF";
  return `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase();
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assName(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_") || "Default";
}

function assText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r?\n/g, "\\N");
}

function writeAss(document, outputPath) {
  const profile = document.profile;
  const styles = new Map((document.subtitle_styles || []).map((style) => [style.id, style]));
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${profile.width}`,
    `PlayResY: ${profile.height}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  ];
  for (const style of styles.values()) {
    lines.push([
      `Style: ${assName(style.id)}`,
      style.font_family,
      number(style.font_size),
      assColor(style.primary_color),
      assColor(style.primary_color),
      assColor(style.outline_color),
      "&H80000000",
      style.bold ? "-1" : "0",
      style.italic ? "-1" : "0",
      "0", "0", "100", "100", "0", "0", "1",
      number(style.outline_width),
      "0",
      String(style.alignment),
      "24", "24", String(style.margin_vertical), "1",
    ].join(","));
  }
  lines.push("", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
  for (const track of document.tracks || []) {
    if (track.kind !== "subtitle" || track.muted) continue;
    for (const clip of track.clips || []) {
      const start = clip.timeline_start_seconds;
      const end = start + clip.duration_seconds;
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},${assName(clip.style_id)},,0,0,0,,${assText(clip.text)}`);
    }
  }
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function ffmpegFilterPath(filePath) {
  return path.resolve(filePath)
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, "$1\\:")
    .replaceAll("'", "\\'");
}

function compileTimeline(validation, ffprobe, outputPath) {
  const {document, project_root: root, duration_seconds: duration} = validation;
  const profile = document.profile;
  const sources = new Map((document.sources || []).map((source) => [source.id, {
    ...source,
    absolute: resolveProjectFile(root, source.file, `素材 ${source.id}`),
  }]));
  const probes = new Map();
  for (const source of sources.values()) {
    probes.set(source.id, probeSource(ffprobe, source.absolute));
  }

  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi",
    "-i", `color=c=${profile.background.slice(1)}:s=${profile.width}x${profile.height}:r=${number(profile.frame_rate)}:d=${number(duration)}`,
  ];
  const visualClips = [];
  const audioClips = [];
  let inputIndex = 1;
  for (const track of document.tracks || []) {
    if (track.muted || track.kind === "subtitle") continue;
    for (const clip of track.clips || []) {
      const source = sources.get(clip.source_id);
      const probe = probes.get(clip.source_id);
      const speed = Number(clip.speed || 1);
      const sourceStart = clip.type === "freeze"
        ? Number(clip.source_time_seconds)
        : Number(clip.source_in_seconds || 0);
      const inputDuration = clip.type === "freeze"
        ? Math.max(1 / profile.frame_rate, 0.1)
        : Number(clip.duration_seconds) * speed;
      if (source.kind === "image") {
        args.push("-loop", "1", "-t", number(clip.duration_seconds), "-i", source.absolute);
      } else {
        args.push("-ss", number(sourceStart), "-t", number(inputDuration + 0.1), "-i", source.absolute);
      }
      const record = {track, clip, source, probe, inputIndex};
      if (track.kind === "video") {
        if (!probe.hasVideo) fail(`视频片段 ${clip.id} 的素材没有画面`);
        visualClips.push(record);
        if (clip.type === "media" && clip.audio_enabled === true && probe.hasAudio) {
          audioClips.push(record);
        }
      } else if (track.kind === "audio") {
        if (!probe.hasAudio) fail(`音频片段 ${clip.id} 的素材没有音轨`);
        audioClips.push(record);
      }
      inputIndex += 1;
    }
  }

  const filters = [`[0:v]format=rgba[base]`];
  let currentVideo = "base";
  visualClips.forEach((record, index) => {
    const {clip, source, inputIndex: sourceIndex} = record;
    const speed = Number(clip.speed || 1);
    const durationValue = Number(clip.duration_seconds);
    const chain = [];
    if (clip.type === "freeze") {
      chain.push(`trim=duration=${number(Math.max(1 / profile.frame_rate, 0.05))}`);
      chain.push("setpts=PTS-STARTPTS");
      chain.push(`fps=${number(profile.frame_rate)}`);
      chain.push(`tpad=stop_mode=clone:stop_duration=${number(durationValue)}`);
      chain.push(`trim=duration=${number(durationValue)}`);
    } else if (source.kind === "image") {
      chain.push(`trim=duration=${number(durationValue)}`);
      chain.push("setpts=PTS-STARTPTS");
      chain.push(`fps=${number(profile.frame_rate)}`);
    } else {
      chain.push(`trim=duration=${number(durationValue * speed)}`);
      chain.push(`setpts=(PTS-STARTPTS)/${number(speed)}`);
      chain.push(`fps=${number(profile.frame_rate)}`);
    }
    chain.push(...placementFilters(clip.placement, profile));
    chain.push("format=rgba");
    const opacity = clip.opacity == null ? 1 : Number(clip.opacity);
    if (opacity < 1) chain.push(`colorchannelmixer=aa=${number(opacity)}`);
    const fadeIn = fadeDuration(clip, "fade_in");
    const fadeOut = fadeDuration(clip, "fade_out");
    if (fadeIn > 0) chain.push(`fade=t=in:st=0:d=${number(fadeIn)}:alpha=1`);
    if (fadeOut > 0) {
      chain.push(`fade=t=out:st=${number(Math.max(0, durationValue - fadeOut))}:d=${number(fadeOut)}:alpha=1`);
    }
    chain.push(`setpts=PTS-STARTPTS+${number(clip.timeline_start_seconds)}/TB`);
    const clipLabel = `vc${index}`;
    filters.push(`[${sourceIndex}:v]${chain.join(",")}[${clipLabel}]`);
    const nextVideo = `vo${index}`;
    const placement = clip.placement || {};
    const x = placement.x == null
      ? Math.round((profile.width - Number(placement.width || profile.width)) / 2)
      : Number(placement.x);
    const y = placement.y == null
      ? Math.round((profile.height - Number(placement.height || profile.height)) / 2)
      : Number(placement.y);
    const start = Number(clip.timeline_start_seconds);
    const end = start + durationValue;
    filters.push(
      `[${currentVideo}][${clipLabel}]overlay=x=${x}:y=${y}:eof_action=pass:shortest=0:enable='between(t,${number(start)},${number(end)})'[${nextVideo}]`,
    );
    currentVideo = nextVideo;
  });

  const captionCount = (document.tracks || []).reduce((total, track) => (
    total + (track.kind === "subtitle" && !track.muted ? track.clips.length : 0)
  ), 0);
  let assPath = null;
  if (captionCount > 0) {
    assPath = `${outputPath}.captions.ass`;
    writeAss(document, assPath);
    filters.push(`[${currentVideo}]subtitles='${ffmpegFilterPath(assPath)}'[captioned]`);
    currentVideo = "captioned";
  }
  filters.push(`[${currentVideo}]format=yuv420p[vout]`);

  let audioOutput = null;
  audioClips.forEach((record, index) => {
    const {clip, inputIndex: sourceIndex} = record;
    const speed = Number(clip.speed || 1);
    const durationValue = Number(clip.duration_seconds);
    const chain = [
      `atrim=duration=${number(durationValue * speed)}`,
      "asetpts=PTS-STARTPTS",
      ...atempoFilters(speed),
      `aresample=${profile.sample_rate}`,
    ];
    const gain = Number(clip.gain_db || 0);
    if (Math.abs(gain) > 1e-6) chain.push(`volume=${number(gain)}dB`);
    const fadeIn = fadeDuration(clip, "fade_in");
    const fadeOut = fadeDuration(clip, "fade_out");
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${number(fadeIn)}`);
    if (fadeOut > 0) {
      chain.push(`afade=t=out:st=${number(Math.max(0, durationValue - fadeOut))}:d=${number(fadeOut)}`);
    }
    const delay = Math.round(Number(clip.timeline_start_seconds) * 1000);
    if (delay > 0) chain.push(`adelay=${delay}:all=1`);
    const label = `ac${index}`;
    filters.push(`[${sourceIndex}:a]${chain.join(",")}[${label}]`);
  });
  if (audioClips.length === 1) {
    filters.push(`[ac0]atrim=duration=${number(duration)}[aout]`);
    audioOutput = "aout";
  } else if (audioClips.length > 1) {
    const inputs = audioClips.map((_, index) => `[ac${index}]`).join("");
    filters.push(`${inputs}amix=inputs=${audioClips.length}:duration=longest:normalize=0,atrim=duration=${number(duration)}[aout]`);
    audioOutput = "aout";
  }

  const filterPath = `${outputPath}.filter.txt`;
  fs.writeFileSync(filterPath, `${filters.join(";\n")}\n`, "utf8");
  args.push("-filter_complex_script", filterPath, "-map", "[vout]");
  if (audioOutput) args.push("-map", `[${audioOutput}]`);
  args.push(
    "-r", number(profile.frame_rate),
    "-t", number(duration),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
  );
  if (audioOutput) {
    args.push(
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", String(profile.sample_rate),
      "-ac", profile.channel_layout === "mono" ? "1" : "2",
    );
  }
  args.push("-movflags", "+faststart", "-y", outputPath);
  return {args, filterPath, assPath, duration, visualClips, audioClips};
}

function render(args) {
  const timelinePath = path.resolve(required(args, "timeline"));
  const outputPath = path.resolve(required(args, "output"));
  if (path.extname(outputPath).toLowerCase() !== ".mp4") {
    fail("可移植时间线 v1 当前正式输出必须是 .mp4；网页 GIF 使用本地网页渲染路线");
  }
  if (fs.existsSync(outputPath) && !args.overwrite) {
    fail(`输出已经存在；明确传入 --overwrite 才会覆盖：${outputPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const validation = validateMediaTimeline(timelinePath);
  if (!validation.ok) fail(`时间线未通过验证：\n- ${validation.errors.join("\n- ")}`);
  const ffmpeg = findCommand("ffmpeg", args.ffmpeg);
  const ffprobe = findCommand("ffprobe", args.ffprobe);
  const compiled = compileTimeline(validation, ffprobe, outputPath);
  run(ffmpeg, compiled.args, "渲染时间线", {cwd: validation.project_root});
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    fail(`时间线没有生成输出：${outputPath}`);
  }
  run(ffmpeg, ["-v", "error", "-i", outputPath, "-f", "null", "-"], "解码最终视频");
  const reportPath = args.report
    ? path.resolve(String(args.report))
    : `${outputPath}.render.json`;
  const report = {
    protocol: "visual-multimedia-local-timeline-render",
    version: 1,
    timeline: timelinePath,
    timeline_sha256: sha256File(timelinePath),
    output: outputPath,
    output_sha256: sha256File(outputPath),
    duration_seconds: compiled.duration,
    video_clip_count: compiled.visualClips.length,
    audio_clip_count: compiled.audioClips.length,
    caption_file: compiled.assPath,
    filter_graph: compiled.filterPath,
    rendered_at: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {...report, report: reportPath};
}

function printHelp() {
  process.stdout.write(`用法：
node scripts/media-timeline.mjs validate --timeline <media-timeline.json>
node scripts/media-timeline.mjs inspect --timeline <media-timeline.json>
node scripts/media-timeline.mjs render --timeline <media-timeline.json> --output <final.mp4>
  [--ffmpeg <路径>] [--ffprobe <路径>] [--report <路径>] [--overwrite]

时间线中的素材路径必须相对于时间线文件，不能引用工程目录外的文件。
`);
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === "help" || args.help || args.h) {
    printHelp();
    return command ? 0 : 1;
  }
  let result;
  if (command === "validate" || command === "inspect") {
    result = validateMediaTimeline(path.resolve(required(args, "timeline")));
    if (command === "inspect" && result.document) delete result.document;
  } else if (command === "render") {
    result = render(args);
  } else {
    fail(`未知命令：${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok === false ? 1 : 0;
}

if (path.resolve(process.argv[1] || "") === path.resolve(SCRIPT_PATH)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  }
}
