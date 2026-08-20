#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {listenOnBrowserSafePort} from "./browser-safe-server.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const CASE_ROOT = path.join(SKILL_ROOT, "assets", "explanatory-broll-case");
const PACKAGE_ROOT = path.join(SKILL_ROOT, "assets", "explanatory-broll-templates");
const require = createRequire(import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function binding(projectRoot, filePath) {
  return {
    file: path.relative(projectRoot, filePath).split(path.sep).join("/"),
    sha256: sha256File(filePath),
    bytes: fs.statSync(filePath).size,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runNode(args, label, cwd = SKILL_ROOT) {
  const result = spawnSync(process.execPath, args, {cwd, encoding: "utf8", windowsHide: true});
  if (result.status !== 0) {
    throw new Error(`${label}失败：\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  const output = (result.stdout || "").trim();
  return output ? JSON.parse(output) : null;
}

function runNodeFailure(args, label, cwd = SKILL_ROOT) {
  const result = spawnSync(process.execPath, args, {cwd, encoding: "utf8", windowsHide: true});
  if (result.status === 0) throw new Error(`${label}本应失败却返回成功`);
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function loadPlaywright() {
  const candidates = [process.cwd(), SCRIPT_DIR, ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [])];
  for (const candidate of candidates) {
    try { return require(require.resolve("playwright", {paths: [candidate]})); }
    catch { /* continue */ }
  }
  throw new Error("解释型 B-roll self-test 找不到 Playwright");
}

function startServer(root) {
  const resolvedRoot = path.resolve(root);
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
    let target = path.resolve(resolvedRoot, ...pathname.split("/").filter(Boolean));
    const relative = path.relative(resolvedRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(403); response.end("Forbidden"); return;
    }
    if (fs.statSync(target, {throwIfNoEntry: false})?.isDirectory()) target = path.join(target, "index.html");
    if (!fs.statSync(target, {throwIfNoEntry: false})?.isFile()) {
      response.writeHead(404); response.end("Not found"); return;
    }
    const types = {".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8", ".css":"text/css; charset=utf-8"};
    response.writeHead(200, {"content-type": types[path.extname(target)] || "application/octet-stream", "cache-control":"no-store"});
    fs.createReadStream(target).pipe(response);
  });
  return listenOnBrowserSafePort(server).then((port) => ({server, port}));
}

async function browserChain() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "editable-media.json"), "utf8"));
  const catalog = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, "assets", "shot-recipe-library", "catalog.json"), "utf8"));
  assert(manifest.scenes.length === 10, "解释型 B-roll 必须提供十类场景");
  assert(manifest.variants.length === 9, "解释型 B-roll 必须提供三种比例 × 三种布局");
  const {server, port} = await startServer(SKILL_ROOT);
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}
      : {}),
  });
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    await page.goto(`http://127.0.0.1:${port}/assets/shot-recipe-library/index.html`, {waitUntil:"networkidle"});
    await page.waitForFunction((count) => document.querySelectorAll("#grid article").length === count, catalog.recipe_count);
    const gallery = await page.evaluate(() => ({
      cards: document.querySelectorAll("#grid article").length,
      activePreviews: document.querySelectorAll("#grid article .preview iframe").length,
      studioText: document.querySelector("#studioStatus").textContent,
    }));
    assert(gallery.cards === catalog.recipe_count, "Gallery 没有消费当前 catalog 真源");
    assert(gallery.activePreviews >= 11, "Gallery 没有为活动配方提供真实动画预览");
    assert(gallery.studioText.includes("静态目录模式"), "静态 Gallery 冒充了可写 Studio");
    await page.goto(`http://127.0.0.1:${port}/assets/explanatory-broll-templates/index.html?capture=1`, {waitUntil:"networkidle"});
    await page.waitForFunction(() => window.editableMedia?.ready);
    await page.evaluate(() => window.editableMedia.ready);
    let checked = 0;
    for (const variant of manifest.variants) {
      for (const scene of manifest.scenes) {
        const observed = await page.evaluate(async ({variantId, sceneId}) => {
          window.editableMedia.pause();
          window.editableMedia.setVariant(variantId);
          window.editableMedia.setScene(sceneId, {timeMs: 2200});
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const playback = window.editableMedia.getPlayback();
          const state = window.editableMedia.getState();
          const canvas = document.querySelector("#mediaCanvas").getBoundingClientRect();
          const stage = document.querySelector("#diagramStage");
          return {
            sceneId: playback.sceneId,
            variantId: state.variant.id,
            width: canvas.width,
            height: canvas.height,
            childCount: stage.children.length,
            text: stage.textContent.trim(),
          };
        }, {variantId: variant.id, sceneId: scene.id});
        assert(observed.sceneId === scene.id && observed.variantId === variant.id, `${scene.id}/${variant.id} 没有进入请求状态`);
        assert(observed.width > 0 && observed.height > 0 && observed.childCount > 0 && observed.text.length > 0, `${scene.id}/${variant.id} 没有真实可见结果`);
        checked += 1;
      }
    }
    return {gallery, checked};
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function mediaFlowChain() {
  const base = path.join(SKILL_ROOT, "artifacts");
  fs.mkdirSync(base, {recursive: true});
  const projectRoot = path.join(base, `eb-${Date.now().toString(36)}-${process.pid}`);
  fs.mkdirSync(projectRoot, {recursive: true});
  for (const name of ["source.md", "direction-draft.json"]) {
    fs.copyFileSync(path.join(CASE_ROOT, name), path.join(projectRoot, name), fs.constants.COPYFILE_EXCL);
  }
  writeJson(path.join(projectRoot, "media-sources.json"), {
    protocol: "visual-multimedia-media-sources",
    version: 3,
    sources: [],
  });
  const planPath = path.join(projectRoot, "video-direction-plan.json");
  runNode([
    path.join(SCRIPT_DIR, "create-video-direction-plan.mjs"),
    "--project", projectRoot,
    "--source", path.join(projectRoot, "source.md"),
    "--draft", path.join(projectRoot, "direction-draft.json"),
    "--created-at", "2026-08-04T00:00:00.000Z",
  ], "导演计划与自动镜头选择");
  let plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const recipe = plan.scenes[0].visual_plan.realization;
  assert(recipe?.kind === "recipe" && recipe.recipe_id === "explain-process-flow" && recipe.variant_id === "landscape-full", "导演计划没有自动选择流程语义骨架");
  assert(recipe.review === null, "自动选择的配方不应冒充已经看过实际画面");
  runNode([
    path.join(SCRIPT_DIR, "review-video-scene-realization.mjs"),
    "--plan", planPath,
    "--segment", "input-to-result",
    "--status", "accepted",
    "--summary", "已查看流程关键状态，关系可读；先接受语义骨架，再制作项目专用实现。",
    "--reviewed-at", "2026-08-04T00:01:00.000Z",
  ], "同一创作者接受实际配方画面");
  plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert(plan.scenes[0].visual_plan.realization.review?.status === "accepted", "接受结论没有绑定实际配方包");

  const customPackage = path.join(projectRoot, "components", "project-specific", "input-to-result");
  fs.mkdirSync(path.dirname(customPackage), {recursive: true});
  fs.cpSync(PACKAGE_ROOT, customPackage, {recursive: true, errorOnExist: true, force: false});
  const customManifestPath = path.join(customPackage, "editable-media.json");
  const customManifest = JSON.parse(fs.readFileSync(customManifestPath, "utf8"));
  customManifest.component = {
    ...customManifest.component,
    id: "explanatory-broll-case-project",
    name: "解释型 B-roll 案例项目专用实现",
  };
  writeJson(customManifestPath, customManifest);
  const revisedProposal = structuredClone(plan.scenes[0].creative_proposal);
  revisedProposal.composition = "输入沿左侧窄轨进入中央执行区，已检查输出在右侧扩大并保留最长阅读停顿。";
  revisedProposal.revision_reason = "实际预览中三个节点权重过于平均，改为让结果态获得明确的构图主次。";
  const proposalPath = path.join(projectRoot, "direction", "revised-input-to-result-proposal.json");
  writeJson(proposalPath, revisedProposal);
  const metadataOnly = runNodeFailure([
    path.join(SCRIPT_DIR, "review-video-scene-realization.mjs"),
    "--plan", planPath,
    "--segment", "input-to-result",
    "--status", "revised",
    "--summary", "只改组件声明不应被当成视觉返修。",
    "--package", customPackage,
    "--scene", "process-flow",
    "--variant", "landscape-full",
    "--proposal", proposalPath,
    "--reviewed-at", "2026-08-04T00:02:00.000Z",
  ], "只改组件声明的假返修");
  assert(metadataOnly.includes("视觉实现源码与当前实现相同"), "假返修没有沿视觉实现指纹被拒绝");
  const customEntryPath = path.join(customPackage, customManifest.entry);
  const customEntry = fs.readFileSync(customEntryPath, "utf8");
  const revisedEntry = customEntry.replace(
    "  </style>",
    "    .card.result { flex-grow: 1.32; background: color-mix(in srgb, var(--surface), var(--positive) 8%); }\n  </style>",
  );
  assert(revisedEntry !== customEntry, "项目专用案例没有找到可返修的视觉源码位置");
  fs.writeFileSync(customEntryPath, revisedEntry, "utf8");
  runNode([
    path.join(SCRIPT_DIR, "review-video-scene-realization.mjs"),
    "--plan", planPath,
    "--segment", "input-to-result",
    "--status", "revised",
    "--summary", "已根据关键状态和连续预览返修构图，结果态现在是唯一视觉重点。",
    "--package", customPackage,
    "--scene", "process-flow",
    "--variant", "landscape-full",
    "--proposal", proposalPath,
    "--reviewed-at", "2026-08-04T00:02:00.000Z",
  ], "同一创作者返修并采纳项目专用网页包");
  plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const realization = plan.scenes[0].visual_plan.realization;
  assert(realization.kind === "project-package" && realization.review.status === "revised", "返修后的项目专用实现没有进入导演计划");
  assert(plan.scenes[0].creative_proposal.revision_reason, "返修没有保留创意原因");
  const sourceTimeline = path.join(projectRoot, "speech-timeline.json");
  writeJson(sourceTimeline, {
    protocol: "visual-multimedia-real-speech-timeline-case",
    version: 1,
    fps: 30,
    segments: [{segment_id:"input-to-result", start_frame:0, duration_frames:165}],
  });
  const timingPath = path.join(projectRoot, "video-direction-timing-projection.json");
  writeJson(timingPath, {
    protocol: "visual-multimedia-video-direction-timing-projection",
    version: 1,
    direction_plan: binding(projectRoot, planPath),
    source_timeline: binding(projectRoot, sourceTimeline),
    fps: 30,
    segments: [{segment_id:"input-to-result", timeline_start_frame:0, duration_frames:165}],
  });
  const applied = runNode([
    path.join(SCRIPT_DIR, "explanatory-broll-studio.mjs"), "apply-plan",
    "--project", projectRoot,
    "--timings", timingPath,
  ], "真实时间投影进入 MediaFlow Pro 时间线");
  assert(applied.clips.length === 1 && applied.clips[0].duration_frames === 165, "MediaFlow Pro 没有消费真实段落时间");
  const runtimePackage = path.resolve(projectRoot, ...applied.clips[0].runtime_package.split("/"));
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimePackage, "editable-media.json"), "utf8"));
  assert(runtimeManifest.scenes.length === 1, "实际长镜头仍会串入下一模板场景");
  assert(runtimeManifest.scenes[0].id === "process-flow", "派生运行包没有保留所选场景");
  assert(runtimeManifest.scenes[0].duration_ms === 5500, "派生运行包没有读取真实持续帧");
  const outputs = [];
  for (const format of ["png", "gif", "video", "alpha_video", "overlay"]) {
    const result = runNode([
      path.join(SCRIPT_DIR, "explanatory-broll-studio.mjs"), "export",
      "--project", projectRoot,
      "--selection-id", applied.clips[0].selection_id,
      "--format", format,
    ], `MediaFlow Pro ${format} 导出`);
    assert(fs.statSync(result.file, {throwIfNoEntry:false})?.isFile() && result.bytes > 0, `${format} 没有生成真实文件`);
    assert(sha256File(result.file) === result.sha256, `${format} 报告哈希与实际文件不一致`);
    outputs.push({format, file:result.file, bytes:result.bytes, sha256:result.sha256});
  }
  return {projectRoot, state: applied.state, outputs};
}

async function main() {
  const browser = await browserChain();
  const mediaflow = process.argv.includes("--mediaflow") ? mediaFlowChain() : null;
  console.log(JSON.stringify({ok:true, browser, mediaflow}, null, 2));
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
