#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {createVideoProgressBar} from "./create-video-progress-bar.mjs";
import {listenOnBrowserSafePort} from "./browser-safe-server.mjs";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadPlaywright() {
  const candidates = [
    process.cwd(),
    "D:\\Tools\\nodejs\\node_modules",
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", {paths: [candidate]}));
    } catch {
      // Continue through declared local dependency roots.
    }
  }
  throw new Error("找不到 Playwright；请通过 NODE_PATH 指向现有 node_modules，本脚本不会安装依赖。");
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function serve(root) {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(root, relative);
    const inside = path.relative(root, filePath);
    if (inside.startsWith("..") || path.isAbsolute(inside) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {"Content-Type": contentType(filePath), "Cache-Control": "no-store"});
    fs.createReadStream(filePath).pipe(response);
  });
  const port = await listenOnBrowserSafePort(server);
  return {server, url: `http://127.0.0.1:${port}/index.html?capture=1&variant=portrait`};
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runValidator(packageRoot) {
  const result = spawnSync(
    process.execPath,
    [path.join(SCRIPT_DIR, "validate-editable-media.mjs"), packageRoot],
    {cwd: SKILL_ROOT, env: process.env, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024},
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "生成包没有通过 editable-media 浏览器校验");
  }
}

async function main() {
  const testParent = path.join(SKILL_ROOT, "artifacts", "self-tests");
  fs.mkdirSync(testParent, {recursive: true});
  const testRoot = fs.mkdtempSync(path.join(testParent, "video-progress-bar-"));
  const specPath = path.join(testRoot, "spec.json");
  const outputRoot = path.join(testRoot, "generated");
  const spec = {
    protocol: "visual-multimedia-video-progress-bar",
    version: 1,
    lead_label: "章节导航",
    duration_ms: 73500,
    variant_id: "portrait",
    placement: "bottom",
    traveler_mode: "cursor",
    chapters: [
      {label: "开场", start_ms: 0},
      {label: "系统", start_ms: 18000},
      {label: "模板", start_ms: 49250},
      {label: "交付", start_ms: 64000},
    ],
  };
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  const generated = createVideoProgressBar(specPath, outputRoot);
  const manifest = readJson(path.join(outputRoot, "editable-media.json"));
  const scene = manifest.scenes.find((item) => item.id === "progress");
  const portrait = manifest.variants.find((item) => item.id === "portrait");
  const html = fs.readFileSync(path.join(outputRoot, "index.html"), "utf8");
  assert(generated.duration_ms === 73500 && generated.chapters === 4, "生成结果没有回报真实时长和章节数");
  assert(manifest.default_variant_id === "portrait", "生成清单没有使用指定竖屏变体");
  assert(scene.duration_ms === 73500, "生成场景仍保留模板时长");
  assert(JSON.stringify(scene.steps.map((item) => item.at_ms)) === JSON.stringify([0, 18000, 49250, 64000]), "章节起点没有成为正式场景步骤");
  assert(scene.data.lead_label === "章节导航" && scene.data.traveler_mode === "cursor", "生成清单没有保留导航栏内容");
  assert(portrait.layers["progress-shell"].y === 1818, "底部竖屏进度栏没有写入对应清单边界");
  assert(portrait.layers["lead-label"].y === 1818, "底部竖屏首格没有与进度栏一起迁移");
  assert(portrait.layers["progress-track"].y === 1892, "底边进度线没有与进度栏一起迁移");
  assert(html.includes('data-duration="73.5"'), "网页组合边界没有同步真实时长");
  assert(html.includes('data-width="1080"') && html.includes('data-height="1920"'), "网页组合边界没有同步默认变体尺寸");
  assert(html.includes('data-progress-placement="bottom"'), "网页没有消费底部位置参数");
  assert(
    !html.includes("current-chapter") && !html.includes("time-readout") && !html.includes("series-title"),
    "旧的标题—当前章节—时间卡片结构仍残留在活动网页包",
  );
  assert(
    fs.readFileSync(path.join(outputRoot, "editable-media-runtime.js")).equals(
      fs.readFileSync(path.join(SKILL_ROOT, "assets", "web-media-starter", "editable-media-runtime.js")),
    ),
    "生成包没有消费当前唯一 editable-media 通用运行时",
  );

  runValidator(outputRoot);

  const service = await serve(outputRoot);
  const browserErrors = [];
  let browser;
  try {
    const {chromium} = loadPlaywright();
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
    browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
    const page = await browser.newPage({viewport: {width: 1080, height: 1920}});
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(service.url, {waitUntil: "load"});
    await page.evaluate(() => window.editableMedia.ready);

    const snapshotAt = (seconds) => page.evaluate(async (time) => {
      await window.__hf.seek(time);
      const shell = window.editableMedia.getBounds()["progress-shell"];
      const lead = window.editableMedia.getBounds()["lead-label"];
      const track = window.editableMedia.getBounds()["progress-track"];
      const segments = Array.from(document.querySelectorAll(".chapter-segment"));
      const cursor = document.querySelector("#progressCursor");
      return {
        playback: window.editableMedia.getPlayback(),
        activeChapter: document.querySelector("#mediaCanvas").dataset.activeChapter,
        progressPercent: document.querySelector("#mediaCanvas").dataset.progressPercent,
        segmentLabels: segments.map((node) => node.textContent),
        currentLabel: document.querySelector(".chapter-segment.current")?.textContent || "",
        segmentBounds: segments.map((node) => node.getBoundingClientRect().toJSON()),
        cursorDisplay: getComputedStyle(cursor).display,
        cursorBounds: cursor.getBoundingClientRect().toJSON(),
        shell,
        lead,
        track,
        rootPlacement: document.querySelector("[data-editable-media-root]").dataset.progressPlacement,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        canvasBackground: getComputedStyle(document.querySelector("#mediaCanvas")).backgroundColor,
      };
    }, seconds);

    const first = await snapshotAt(49.25);
    const repeated = await snapshotAt(49.25);
    assert(JSON.stringify(first) === JSON.stringify(repeated), "同一视频时间产生了不同进度条状态");
    assert(first.playback.globalTimeMs === 49250, "HyperFrames 秒级入口没有到达真实全局时间");
    assert(first.activeChapter === "3" && first.currentLabel === "模板", "矩形分段的当前章节没有随真实时间切换");
    assert(JSON.stringify(first.segmentLabels) === JSON.stringify(["开场", "系统", "模板", "交付"]), "横向分段没有消费完整章节标签");
    assert(Math.abs(Number(first.progressPercent) - 67.0068) < .001, "进度位置没有按真实总时长计算");
    assert(first.segmentBounds.length === 4 && first.segmentBounds.every((bounds) => bounds.height === 78), "章节没有成为同一横方框内的完整高度矩形分段");
    assert(first.cursorDisplay !== "none", "人物暂缺时的移动占位游标没有显示");
    const expectedCursorX = first.shell.x + first.shell.width * Number(first.progressPercent) / 100;
    assert(Math.abs(first.cursorBounds.x + first.cursorBounds.width / 2 - expectedCursorX) < 1, "移动游标没有沿全片进度坐标移动");
    assert(first.shell.y === 1818 && first.lead.y === 1818 && first.track.y === 1892 && first.rootPlacement === "bottom", "浏览器最终画面没有形成底部横向分段进度栏");
    assert(first.bodyBackground === "rgba(0, 0, 0, 0)" && first.canvasBackground === "rgba(0, 0, 0, 0)", "捕获模式不是真实透明背景");

    const clickedTime = await page.evaluate(() => {
      document.querySelectorAll(".chapter-segment")[3].click();
      return window.editableMedia.getPlayback().globalTimeMs;
    });
    assert(clickedTime === 64000, "章节点击没有通过统一时间线定位");
    assert(browserErrors.length === 0, `浏览器出现错误：${browserErrors.join("；")}`);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => service.server.close(resolve));
  }

  console.log(`横向分段视频进度栏通过：真实参数生成、矩形分段、底边进度、移动游标、章节跳转和确定性时间均成立；测试包 ${outputRoot}`);
}

main().catch((error) => {
  console.error(`视频进度条自检失败：${error.message}`);
  process.exitCode = 1;
});
