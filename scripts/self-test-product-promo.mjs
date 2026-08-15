#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {captureProductUi} from "./capture-product-ui.mjs";
import {analyzeMusicBeats} from "./analyze-music-beats.mjs";
import {
  confirmProductPromoPlan,
  createProductPromoBuildPlan,
  createProductPromoProject,
  validateProductPromoPlan,
} from "./product-promo.mjs";
import {materializeShotRecipe} from "./shot-recipe-library.mjs";
import {listenOnBrowserSafePort} from "./browser-safe-server.mjs";
import {
  nowIso,
  readJson,
  relativeProjectPath,
  sha256File,
  writeJson,
} from "./interview_explainer_common.mjs";
import {decideStage, submitStage, validateProjectState} from "./media_project_state.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROFILE_PATH = path.join(SKILL_ROOT, "assets", "video-production-profiles", "product-promo", "1.0.0", "profile.json");
const VALIDATOR = path.join(SKILL_ROOT, "scripts", "validate-editable-media.mjs");
const BEAT_ANALYZER = path.join(SKILL_ROOT, "scripts", "analyze-music-beats.mjs");
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [process.cwd(), SCRIPT_DIR, ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [])];
  for (const candidate of candidates) {
    try { return require(require.resolve("playwright", {paths: [candidate]})); }
    catch { /* continue */ }
  }
  throw new Error("self-test 找不到 Playwright");
}

function startServer(root) {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
    let target = path.resolve(root, ...pathname.split("/").filter(Boolean));
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`) && target !== path.resolve(root)) {
      response.writeHead(403); response.end("Forbidden"); return;
    }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404); response.end("Not found"); return;
    }
    const types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8"};
    response.writeHead(200, {"Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store"});
    fs.createReadStream(target).pipe(response);
  });
  return listenOnBrowserSafePort(server).then((port) => ({server, port}));
}

function writeClickTrack(filePath) {
  const sampleRate = 22050;
  const seconds = 8;
  const samples = new Int16Array(sampleRate * seconds);
  for (let beat = 0; beat < seconds * 2; beat += 1) {
    const start = Math.round(beat * 0.5 * sampleRate);
    for (let index = 0; index < Math.round(sampleRate * 0.025); index += 1) {
      const envelope = 1 - index / Math.round(sampleRate * 0.025);
      samples[start + index] = Math.round(Math.sin(index * 2 * Math.PI * 1500 / sampleRate) * envelope * 26000);
    }
  }
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], 44 + index * 2);
  fs.writeFileSync(filePath, buffer);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approveStage(project, stageId, artifact = null) {
  const statePath = path.join(project, "media-project-state.json");
  const state = readJson(statePath);
  if (artifact) submitStage(state, project, stageId, [artifact]);
  decideStage(state, stageId, "approved", `self-test 用户确认 ${stageId}`, {decidedBy: "user"});
  writeJson(statePath, state);
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`${stageId} 阶段状态失败：${validation.errors.join("；")}`);
}

async function main() {
  const testRoot = path.join(SKILL_ROOT, "artifacts");
  fs.mkdirSync(testRoot, {recursive: true});
  const project = path.join(testRoot, `pp-${Date.now().toString(36)}-${process.pid}`);
  createProductPromoProject(project, "product-promo-self-test");
  const {server, port} = await startServer(SKILL_ROOT);
  const base = `http://127.0.0.1:${port}`;
  try {
    const recipeCatalog = readJson(path.join(SKILL_ROOT, "assets", "shot-recipe-library", "catalog.json"));
    const playwright = loadPlaywright();
    const browser = await playwright.chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
    const page = await browser.newPage();
    await page.goto(`${base}/assets/shot-recipe-library/index.html`, {waitUntil: "networkidle"});
    await page.waitForFunction((count) => document.querySelectorAll("#grid article").length === count, recipeCatalog.recipe_count);
    const gallery = await page.evaluate(() => ({cards: document.querySelectorAll("#grid article").length, stats: document.querySelector("#stats").textContent}));
    await browser.close();
    assert(gallery.cards === recipeCatalog.recipe_count && gallery.stats.includes(`${recipeCatalog.active_style_count} 个活动实现`) && gallery.stats.includes(`${recipeCatalog.reference_style_count} 个参考变体`), "镜头配方 Gallery 没有显示生成目录的真实计数");

    const specPath = path.join(project, "captures", "product-ui-capture-spec.json");
    writeJson(specPath, {
      protocol: "visual-multimedia-product-ui-capture-spec",
      version: 1,
      project_id: "product-promo-self-test",
      viewport: {width: 1280, height: 900, device_scale_factor: 1},
      pages: [{
        id: "starter",
        url: `${base}/assets/web-media-starter/index.html?capture=0`,
        wait_for_selector: "#mediaCanvas",
        full_page: false,
        selectors: [{id: "canvas", selector: "#mediaCanvas", capture: true, transparent: false}],
      }],
    });
    const capturePath = path.join(project, "reports", "product-ui-capture.json");
    const capture = await captureProductUi({projectRoot: project, specPath, reportPath: capturePath, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || null});
    assert(capture.pages[0].assets[0].source_id === "product-starter-canvas", "真实页面截图没有进入素材账本");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const briefPath = path.join(project, "product-promo-brief.json");
  const brief = readJson(briefPath);
  brief.product = {name: "Editable Media Starter", audience: "需要可编辑媒体生产链的创作者", value_proposition: "同一网页真源可以交互预览并确定性渲染", call_to_action: "查看完整生产链"};
  brief.features = [{id: "deterministic-preview", name: "确定性预览", viewer_value: "同一场景可以随机定位并重复得到同一画面", proof: "真实浏览器中的 editable media canvas", required: true, source_ids: ["product-starter-canvas"]}];
  brief.constraints = ["保持标题和说明在镜头可读性层中"];
  writeJson(briefPath, brief);

  const materialized = materializeShotRecipe({
    projectRoot: project,
    recipeId: "feature-focus-tour",
    styleId: "semantic-focus-tour",
    variantId: "landscape",
    segmentId: "shot-1",
    visualSourceKind: "evidence",
    relationshipKind: null,
    placementMode: "full-frame",
    aspectRatio: "16:9",
    selectionReason: "用真实产品证据证明确定性预览。",
  });
  let rejectedReferenceOnly = false;
  try {
    materializeShotRecipe({
      projectRoot: project,
      recipeId: "crash-zoom-punch",
      styleId: "crash-zoom-punch",
      variantId: "landscape",
      segmentId: "reference-only",
      visualSourceKind: "evidence",
      relationshipKind: null,
      placementMode: "full-frame",
      aspectRatio: "16:9",
      selectionReason: "验证参考项不会进入正式生产链。",
    });
  }
  catch (error) {
    rejectedReferenceOnly = error.message.includes("活动镜头配方必须唯一匹配")
      || error.message.includes("只有参考语义");
  }
  assert(rejectedReferenceOnly, "reference-only 镜头没有被正式物化入口拒绝");

  const selection = materialized.document;
  const manifestPath = path.join(materialized.package, "editable-media.json");
  const planPath = path.join(project, "product-promo-plan.json");
  const output = brief.output;
  const plan = {
    protocol: "visual-multimedia-product-promo-plan",
    version: 1,
    project_id: brief.project_id,
    created_at: nowIso(),
    profile: {id: "product-promo", version: "1.0.0", sha256: sha256File(PROFILE_PATH)},
    brief: {file: relativeProjectPath(project, briefPath), sha256: sha256File(briefPath)},
    direction: {summary: "用稳定可读标题建立主张，再用两个景深面板解释同一真源的交互与渲染结果。", style_frames: []},
    capture_reports: [{file: "reports/product-ui-capture.json", sha256: sha256File(path.join(project, "reports", "product-ui-capture.json"))}],
    sound: {profile: null, beat_analysis: null, music_source_id: null},
    feature_coverage: [{feature_id: "deterministic-preview", shot_ids: ["shot-1"]}],
    shots: [{
      id: "shot-1",
      order: 1,
      purpose: "证明同一网页真源可以确定性定位并展示结果状态",
      feature_ids: ["deterministic-preview"],
      selection: {file: relativeProjectPath(project, materialized.selection), sha256: sha256File(materialized.selection)},
      implementation: {
        package: selection.package,
        package_sha256: selection.package_sha256,
        manifest_sha256: sha256File(manifestPath),
        scene_id: "opening",
      },
      timeline_start_frame: 0,
      duration_frames: 90,
      semantic_steps: ["claim", "result"],
    }],
    review_promises: [{id: "required-feature-covered", source_pointer: "/feature_coverage/0/shot_ids", promise: "必选功能必须由实际镜头覆盖", expected_value: ["shot-1"]}],
    output,
  };
  writeJson(planPath, plan);
  validateProductPromoPlan(project, planPath);
  const confirmationPath = path.join(project, "product-promo-plan-confirmation.json");
  confirmProductPromoPlan(project, planPath, confirmationPath, "agent", "self-test 固定案例验证合同与真实网页生产边界");
  const buildPath = path.join(project, "media-build-plan.json");
  const build = createProductPromoBuildPlan(project, planPath, confirmationPath, buildPath);
  assert(build.units.length === 1 && build.units[0].dependencies.length === 2, "产品计划没有正确投影为通用构建单元");

  const validationReport = path.join(project, "reports", "editable-media-validation.json");
  const validation = spawnSync(process.execPath, [VALIDATOR, materialized.package, "--variant", "landscape", "--scene", "opening", "--report", validationReport], {
    cwd: SKILL_ROOT,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (validation.status !== 0) throw new Error(`物化网页包真实浏览器验证失败：\n${validation.stdout}\n${validation.stderr}`);
  assert(readJson(validationReport).summary.passed, "网页验证报告没有通过");

  const clickPath = path.join(project, "working", "click-120bpm.wav");
  writeClickTrack(clickPath);
  const beatPath = path.join(project, "reports", "music-beats-self-test.json");
  const beat = analyzeMusicBeats({projectRoot: project, inputPath: clickPath, outputPath: beatPath, minimumBpm: 100, maximumBpm: 140});
  assert(Math.abs(beat.grid.bpm - 120) <= 2.5, `120 BPM 测试音频被识别为 ${beat.grid.bpm} BPM`);
  const beatConfirmation = spawnSync(process.execPath, [BEAT_ANALYZER, "--project", project, "--confirm", "--analysis", "reports/music-beats-self-test.json", "--reviewed-by", "agent", "--notes", "已听取固定 120 BPM 测试音轨并核对网格"], {encoding: "utf8", windowsHide: true});
  if (beatConfirmation.status !== 0) throw new Error(`节拍人工复核入口失败：${beatConfirmation.stderr || beatConfirmation.stdout}`);
  assert(readJson(beatPath).review.method === "manual", "人工听音复核没有写回节拍分析合同");

  approveStage(project, "content", {id: "product-content", role: "content-contract", kind: "document", file: "product-promo-brief.json"});
  approveStage(project, "direction", {id: "product-direction", role: "direction-package", kind: "document", file: "product-promo-plan.json"});
  fs.copyFileSync(path.join(SKILL_ROOT, "assets", "media-delivery-case", "renders", "final.mp4"), path.join(project, "integrated-sample.mp4"));
  approveStage(project, "integrated-sample", {id: "product-sample", role: "integrated-sample", kind: "video", file: "integrated-sample.mp4"});
  const productCli = path.join(SCRIPT_DIR, "product-promo.mjs");
  const rendered = spawnSync(process.execPath, [productCli, "render", "--project", project], {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024});
  if (rendered.status !== 0) throw new Error(`产品宣传片正式 render 失败：\n${rendered.stdout}\n${rendered.stderr}`);
  assert(fs.existsSync(JSON.parse(rendered.stdout).output), "产品宣传片正式 render 没有生成成片");
  approveStage(project, "full-preview");
  const reviewed = spawnSync(process.execPath, [
    productCli, "review", "--project", project,
    "--agent-status", "passed",
    "--agent-evidence", "self-test 完整播放产品宣传片，确认功能证据和连续画面可见。",
  ], {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024});
  if (reviewed.status !== 0 || JSON.parse(reviewed.stdout).status !== "passed") {
    throw new Error(`产品宣传片正式 review 失败：\n${reviewed.stdout}\n${reviewed.stderr}`);
  }
  const waiting = spawnSync(process.execPath, [productCli, "finalize", "--project", project], {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024});
  if (waiting.status !== 0 || JSON.parse(waiting.stdout).status !== "waiting-approval") {
    throw new Error(`产品宣传片 finalize 没有停在最终批准：\n${waiting.stdout}\n${waiting.stderr}`);
  }
  approveStage(project, "final-delivery");
  const finalized = spawnSync(process.execPath, [productCli, "finalize", "--project", project], {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024});
  if (finalized.status !== 0 || JSON.parse(finalized.stdout).status !== "complete") {
    throw new Error(`产品宣传片正式 finalize 失败：\n${finalized.stdout}\n${finalized.stderr}`);
  }

  const catalog = readJson(path.join(SKILL_ROOT, "assets", "shot-recipe-library", "catalog.json"));
  console.log(`产品宣传片真实链路通过：${catalog.recipe_count} 张配方、${catalog.reference_style_count} 个拒绝直接生产的参考变体、真实页面采集、活动配方物化、计划确认、通用构建、浏览器逐帧验证、完整审阅、最终批准、交付验证、120 BPM 派生分析与听音复核入口均通过。`);
  console.log(`诊断项目保留在 Skill 任务工作区：${project}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
}
