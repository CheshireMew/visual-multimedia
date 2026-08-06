#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLI = path.join(SCRIPT_DIR, "media-timeline.mjs");
const TEST_PARENT = process.platform === "win32" && fs.existsSync("D:\\Tools")
  ? "D:\\Tools\\visual-multimedia-tests"
  : os.tmpdir();
const ROOT = path.join(
  path.resolve(process.env.VISUAL_MULTIMEDIA_TEST_ROOT || TEST_PARENT),
  "portable-timeline",
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
);

function commandPath(name) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [name], {encoding: "utf8", windowsHide: true});
  const resolved = (result.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (result.status !== 0 || !resolved) throw new Error(`找不到 ${name}`);
  return resolved;
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label}失败\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function writeJson(filePath, document) {
  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function sha256(relativePath) {
  return crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(ROOT, relativePath)))
    .digest("hex");
}

function probe(ffprobe, filePath) {
  return JSON.parse(run(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    filePath,
  ], `探测 ${filePath}`).stdout);
}

function makeTimeline(duration) {
  return {
    protocol: "visual-multimedia-timeline",
    version: 1,
    project_id: "portable-timeline-real-chain",
    profile: {
      width: 640,
      height: 360,
      frame_rate: 24,
      sample_rate: 48000,
      channel_layout: "stereo",
      background: "#101820",
      duration_seconds: duration,
    },
    sources: [
      {
        id: "moving",
        kind: "video",
        file: "sources/moving.mp4",
        sha256: sha256("sources/moving.mp4"),
        duration_seconds: 3,
      },
      {
        id: "still",
        kind: "image",
        file: "sources/still.png",
        sha256: sha256("sources/still.png"),
      },
      {
        id: "music",
        kind: "audio",
        file: "sources/music.wav",
        sha256: sha256("sources/music.wav"),
        duration_seconds: duration,
      },
    ],
    tracks: [
      {
        id: "main-video",
        kind: "video",
        name: "主画面",
        muted: false,
        clips: [
          {
            id: "moving-opening",
            type: "media",
            source_id: "moving",
            timeline_start_seconds: 0,
            source_in_seconds: 0,
            duration_seconds: 2,
            speed: 1,
            placement: {fit: "cover", x: 0, y: 0, width: 640, height: 360},
            opacity: 1,
            audio_enabled: false,
            fade_in: {kind: "none", duration_seconds: 0},
            fade_out: {kind: "fade", duration_seconds: 0.15},
          },
          {
            id: "held-action",
            type: "freeze",
            source_id: "moving",
            timeline_start_seconds: 2,
            source_time_seconds: 1.25,
            duration_seconds: 1,
            placement: {fit: "cover", x: 0, y: 0, width: 640, height: 360},
            opacity: 1,
            fade_in: {kind: "fade", duration_seconds: 0.1},
            fade_out: {kind: "fade", duration_seconds: 0.1},
          },
          {
            id: "still-ending",
            type: "media",
            source_id: "still",
            timeline_start_seconds: 3,
            source_in_seconds: 0,
            duration_seconds: duration - 3,
            speed: 1,
            placement: {fit: "contain", x: 0, y: 0, width: 640, height: 360},
            opacity: 1,
            audio_enabled: false,
            fade_in: {kind: "fade", duration_seconds: 0.15},
            fade_out: {kind: "none", duration_seconds: 0},
          },
        ],
      },
      {
        id: "music-track",
        kind: "audio",
        name: "背景音乐",
        muted: false,
        clips: [
          {
            id: "music-bed",
            type: "media",
            source_id: "music",
            timeline_start_seconds: 0,
            source_in_seconds: 0,
            duration_seconds: duration,
            speed: 1,
            gain_db: -12,
            fade_in: {kind: "fade", duration_seconds: 0.2},
            fade_out: {kind: "fade", duration_seconds: 0.3},
          },
        ],
      },
      {
        id: "zh-captions",
        kind: "subtitle",
        name: "中文字幕",
        muted: false,
        clips: [
          {
            id: "zh-1",
            type: "caption",
            timeline_start_seconds: 0.25,
            duration_seconds: 1.4,
            text: "本地时间线可以独立完成剪辑",
            style_id: "zh",
            language: "zh-CN",
          },
        ],
      },
      {
        id: "en-captions",
        kind: "subtitle",
        name: "英文字幕",
        muted: false,
        clips: [
          {
            id: "en-1",
            type: "caption",
            timeline_start_seconds: 0.25,
            duration_seconds: 1.4,
            text: "A portable timeline remains editable.",
            style_id: "en",
            language: "en",
          },
        ],
      },
    ],
    subtitle_styles: [
      {
        id: "zh",
        font_family: "Microsoft YaHei",
        font_size: 30,
        primary_color: "#FFFFFF",
        outline_color: "#000000",
        outline_width: 2,
        margin_vertical: 50,
        alignment: 2,
        bold: true,
        italic: false,
      },
      {
        id: "en",
        font_family: "Arial",
        font_size: 18,
        primary_color: "#E8E8E8",
        outline_color: "#000000",
        outline_width: 1,
        margin_vertical: 22,
        alignment: 2,
        bold: false,
        italic: false,
      },
    ],
    markers: [
      {id: "run", time_seconds: 0, label: "动态画面"},
      {id: "freeze", time_seconds: 2, label: "定格"},
      {id: "still", time_seconds: 3, label: "静止素材"},
    ],
  };
}

function main() {
  fs.mkdirSync(path.join(ROOT, "sources"), {recursive: true});
  const ffmpeg = commandPath("ffmpeg");
  const ffprobe = commandPath("ffprobe");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "sources/moving.mp4",
  ], "生成真实视频素材");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x2d6a86:s=480x270:d=0.1",
    "-frames:v", "1", "-y", "sources/still.png",
  ], "生成真实图片素材");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=6",
    "-c:a", "pcm_s16le", "-y", "sources/music.wav",
  ], "生成真实音频素材");

  const timelinePath = path.join(ROOT, "media-timeline.json");
  writeJson(timelinePath, makeTimeline(5));
  run(process.execPath, [CLI, "validate", "--timeline", timelinePath], "验证时间线");
  const unboundTimeline = makeTimeline(5);
  delete unboundTimeline.sources[0].sha256;
  const unboundPath = path.join(ROOT, "missing-source-hash.json");
  writeJson(unboundPath, unboundTimeline);
  const unboundValidation = spawnSync(
    process.execPath,
    [CLI, "validate", "--timeline", unboundPath],
    {cwd: ROOT, encoding: "utf8", windowsHide: true},
  );
  const unboundResult = JSON.parse(unboundValidation.stdout || "{}");
  if (
    unboundValidation.status === 0
    || unboundResult.ok !== false
    || !unboundResult.errors?.some((error) => error.includes("SHA-256"))
  ) {
    throw new Error("缺少素材哈希的时间线没有被拒绝");
  }
  const firstOutput = path.join(ROOT, "first.mp4");
  run(process.execPath, [
    CLI, "render",
    "--timeline", timelinePath,
    "--output", firstOutput,
    "--ffmpeg", ffmpeg,
    "--ffprobe", ffprobe,
  ], "第一次真实渲染");
  const first = probe(ffprobe, firstOutput);
  if (!(Math.abs(Number(first.format.duration) - 5) < 0.2)) {
    throw new Error(`第一次渲染时长不正确：${first.format.duration}`);
  }
  const streamKinds = new Set(first.streams.map((stream) => stream.codec_type));
  if (!streamKinds.has("video") || !streamKinds.has("audio")) {
    throw new Error("第一次渲染没有同时包含真实视频和音频流");
  }

  writeJson(timelinePath, makeTimeline(6));
  const secondOutput = path.join(ROOT, "second.mp4");
  run(process.execPath, [
    CLI, "render",
    "--timeline", timelinePath,
    "--output", secondOutput,
    "--ffmpeg", ffmpeg,
    "--ffprobe", ffprobe,
  ], "修改真源后的第二次渲染");
  const second = probe(ffprobe, secondOutput);
  if (!(Math.abs(Number(second.format.duration) - 6) < 0.2)) {
    throw new Error(`第二次渲染没有读取修改后的真源：${second.format.duration}`);
  }
  const firstHash = crypto.createHash("sha256").update(fs.readFileSync(firstOutput)).digest("hex");
  const secondHash = crypto.createHash("sha256").update(fs.readFileSync(secondOutput)).digest("hex");
  if (firstHash === secondHash) throw new Error("修改时间线后输出哈希没有变化");
  console.log(JSON.stringify({
    ok: true,
    project: ROOT,
    first_output: firstOutput,
    second_output: secondOutput,
    first_duration_seconds: Number(first.format.duration),
    second_duration_seconds: Number(second.format.duration),
    source_change_observed: true,
    missing_source_hash_rejected: true,
    video_and_audio_decoded: true,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
