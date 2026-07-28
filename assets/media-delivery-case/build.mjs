#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(projectRoot, "media-sources.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const byId = new Map(manifest.sources.map((source) => [source.id, source]));

function sourcePath(id) {
  const source = byId.get(id);
  if (!source) throw new Error(`素材账本缺少 ${id}`);
  const absolute = path.resolve(projectRoot, source.file);
  if (!fs.existsSync(absolute)) throw new Error(`素材文件不存在：${absolute}`);
  return absolute;
}

function commandPath(name) {
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [name],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(`找不到 ${name}；本案例不会自动安装工具`);
  }
  return result.stdout.split(/\r?\n/).find(Boolean).trim();
}

const ffmpeg = commandPath("ffmpeg");
const avatar = sourcePath("case-avatar");
const narration = sourcePath("case-narration");
const output = path.join(projectRoot, "renders", "final.mp4");
fs.mkdirSync(path.dirname(output), { recursive: true });

const result = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-loop",
    "1",
    "-framerate",
    "24",
    "-i",
    avatar,
    "-i",
    narration,
    "-filter_complex",
    "[0:v]scale=600:600:force_original_aspect_ratio=decrease,"
      + "pad=720:720:(ow-iw)/2:(oh-ih)/2:color=0xf3efe6,"
      + "format=yuv420p[v]",
    "-map",
    "[v]",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "24",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-shortest",
    "-movflags",
    "+faststart",
    "-y",
    output,
  ],
  { encoding: "utf8", windowsHide: true }
);
if (result.status !== 0) {
  throw new Error((result.stderr || result.stdout || "FFmpeg 构建失败").trim());
}
if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
  throw new Error("没有生成可用的最终视频");
}
console.log(`媒体生产案例已生成：${output}`);
