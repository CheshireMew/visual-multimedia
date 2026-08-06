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
const CLI = path.join(SCRIPT_DIR, "render-web-media-local.mjs");
const TEST_PARENT = process.platform === "win32" && fs.existsSync("D:\\Tools")
  ? "D:\\Tools\\visual-multimedia-tests"
  : os.tmpdir();
const ROOT = path.join(
  path.resolve(process.env.VISUAL_MULTIMEDIA_TEST_ROOT || TEST_PARENT),
  "local-web-render",
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
);

function commandPath(name) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [name], {encoding: "utf8", windowsHide: true});
  const candidate = (result.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (result.status !== 0 || !candidate) throw new Error(`找不到 ${name}`);
  return candidate;
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: SKILL_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label}失败\n${result.stdout}\n${result.stderr}`);
  return result;
}

function main() {
  fs.mkdirSync(ROOT, {recursive: true});
  const ffmpeg = commandPath("ffmpeg");
  const ffprobe = commandPath("ffprobe");
  const browser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : null);
  if (browser && !fs.existsSync(browser)) throw new Error(`测试浏览器不存在：${browser}`);
  const source = path.join(
    SKILL_ROOT,
    "assets",
    "web-card-cases",
    "editorial-technology-diagram-cover",
  );
  const mp4 = path.join(ROOT, "local-web.mp4");
  const renderArguments = [
    CLI, "render",
    "--package", source,
    "--output", mp4,
    "--fps", "3",
    "--ffmpeg", ffmpeg,
  ];
  if (browser) renderArguments.push("--browser", browser);
  const response = JSON.parse(run(process.execPath, renderArguments, "本地网页 MP4 渲染").stdout);
  if (response.renderer !== "playwright-ffmpeg" || response.frame_count !== 3) {
    throw new Error("本地网页渲染回执没有记录真实逐帧路线");
  }
  const probe = JSON.parse(run(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    mp4,
  ], "探测本地网页视频").stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  if (!video || video.width !== 1500 || video.height !== 600) {
    throw new Error("本地网页视频没有使用网页包输出变体的真实画布");
  }
  if (!(Math.abs(Number(probe.format.duration) - 1) < 0.2)) {
    throw new Error(`本地网页视频时长不正确：${probe.format.duration}`);
  }
  const gif = path.join(ROOT, "local-web.gif");
  const gifArguments = [
    CLI, "render",
    "--package", source,
    "--output", gif,
    "--fps", "2",
    "--ffmpeg", ffmpeg,
  ];
  if (browser) gifArguments.push("--browser", browser);
  run(process.execPath, gifArguments, "本地网页 GIF 渲染");
  run(ffmpeg, ["-v", "error", "-i", gif, "-f", "null", "-"], "解码本地网页 GIF");
  console.log(JSON.stringify({
    ok: true,
    project: ROOT,
    source_package: source,
    mp4,
    gif,
    deterministic_seek_contract: "window.__hf.seek(seconds)",
    real_browser_rendered: true,
    outputs_decoded: true,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
