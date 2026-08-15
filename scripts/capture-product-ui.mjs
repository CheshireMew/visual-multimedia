#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  nowIso,
  parseArgs,
  projectPath,
  readJson,
  relativeProjectPath,
  requireArg,
  sha256File,
  writeJson,
} from "./interview_explainer_common.mjs";
import {assertSkillTaskPath} from "./media-task-workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCHEMA_PATH = path.join(SKILL_ROOT, "schemas", "product-ui-capture.v1.schema.json");
const IMPORTER = path.join(SKILL_ROOT, "scripts", "import-media-asset.mjs");
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [process.cwd(), SCRIPT_DIR, ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [])];
  for (const candidate of candidates) {
    try { return require(require.resolve("playwright", {paths: [candidate]})); }
    catch { /* continue */ }
  }
  throw new Error("找不到 Playwright；请通过 NODE_PATH 指向现有 node_modules，本脚本不会安装依赖。");
}

function importScreenshot(projectRoot, filePath, id, url, capturedAt) {
  const result = spawnSync(process.execPath, [
    IMPORTER,
    "--project", projectRoot,
    "--input", filePath,
    "--id", id,
    "--media-type", "screenshot",
    "--method", "project-owned",
    "--rights-status", "confirmed",
    "--license", "项目自有产品界面截图",
    "--usage", "产品宣传片的真实功能证据与画面素材",
    "--source-url", url,
    "--captured-at", capturedAt,
    "--notes", "由 capture-product-ui.mjs 按已确认采集规格取得",
  ], {encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`截图导入素材账本失败：${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout).source;
}

function ensureNewFile(filePath, label) {
  if (fs.existsSync(filePath)) throw new Error(`${label}已存在，不会覆盖：${filePath}`);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
}

export async function captureProductUi({projectRoot, specPath, reportPath, executablePath = null}) {
  const project = assertSkillTaskPath(path.resolve(projectRoot), "projectRoot");
  const specFile = path.resolve(specPath);
  const reportFile = path.resolve(reportPath);
  const spec = readJson(specFile);
  assertJsonSchema(spec, SCHEMA_PATH, "产品页面采集规格");
  const state = readJson(path.join(project, "media-project-state.json"));
  if (state.project_id !== spec.project_id) throw new Error("采集规格与媒体项目 project_id 不一致");
  const relativeSpec = relativeProjectPath(project, specFile);
  relativeProjectPath(project, reportFile);
  ensureNewFile(reportFile, "采集报告");
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
  const context = await browser.newContext({
    viewport: {width: spec.viewport.width, height: spec.viewport.height},
    deviceScaleFactor: spec.viewport.device_scale_factor,
  });
  const createdAt = nowIso();
  const pages = [];
  try {
    for (const pageSpec of spec.pages) {
      const page = await context.newPage();
      await page.goto(pageSpec.url, {waitUntil: "domcontentloaded"});
      if (pageSpec.wait_for_selector) await page.locator(pageSpec.wait_for_selector).waitFor({state: "visible"});
      await page.evaluate(() => document.fonts?.ready);
      const dimensions = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      }));
      const assets = [];
      async function record(id, screenshotPath, bounds) {
        const sourceId = `product-${pageSpec.id}-${id}`;
        const source = importScreenshot(project, screenshotPath, sourceId, pageSpec.url, createdAt);
        assets.push({
          id,
          source_id: sourceId,
          file: source.file,
          sha256: source.integrity.sha256,
          bytes: source.integrity.bytes,
          bounds,
        });
      }
      if (pageSpec.full_page) {
        const output = projectPath(project, `working/product-ui-capture/${pageSpec.id}/full-page.png`, "整页截图");
        ensureNewFile(output, "整页截图");
        await page.screenshot({path: output, fullPage: true});
        await record("full-page", output, {x: 0, y: 0, width: dimensions.width, height: dimensions.height});
      }
      for (const selectorSpec of pageSpec.selectors) {
        const locator = page.locator(selectorSpec.selector);
        const count = await locator.count();
        if (count !== 1) throw new Error(`${pageSpec.id}/${selectorSpec.id} 的 selector 必须且只能命中一个节点，实际 ${count}`);
        const element = locator.first();
        await element.scrollIntoViewIfNeeded();
        const bounds = await element.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return {x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height};
        });
        if (!bounds.width || !bounds.height) throw new Error(`${pageSpec.id}/${selectorSpec.id} 没有可见尺寸`);
        if (!selectorSpec.capture) continue;
        const output = projectPath(project, `working/product-ui-capture/${pageSpec.id}/${selectorSpec.id}.png`, "元素截图");
        ensureNewFile(output, "元素截图");
        await element.screenshot({path: output, omitBackground: selectorSpec.transparent});
        await record(selectorSpec.id, output, bounds);
      }
      if (!assets.length) throw new Error(`${pageSpec.id} 没有要求采集任何截图`);
      pages.push({id: pageSpec.id, url: page.url(), document_width: dimensions.width, document_height: dimensions.height, assets});
      await page.close();
    }
  } finally {
    await context.close();
    await browser.close();
  }
  const report = {
    protocol: "visual-multimedia-product-ui-capture-report",
    version: 1,
    project_id: spec.project_id,
    created_at: createdAt,
    spec: {file: relativeSpec, sha256: sha256File(specFile)},
    pages,
  };
  assertJsonSchema(report, SCHEMA_PATH, "产品页面采集报告");
  writeJson(reportFile, report);
  return report;
}

async function main(argv) {
  const args = parseArgs(argv);
  const project = path.resolve(requireArg(args, "project"));
  const report = await captureProductUi({
    projectRoot: project,
    specPath: projectPath(project, requireArg(args, "spec"), "capture spec"),
    reportPath: projectPath(project, args.output || "reports/product-ui-capture.json", "capture report"),
    executablePath: args.browser ? path.resolve(args.browser) : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || null,
  });
  console.log(JSON.stringify({pages: report.pages.length, assets: report.pages.reduce((sum, page) => sum + page.assets.length, 0)}, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exit(1); });
}
