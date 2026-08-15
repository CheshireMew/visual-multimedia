#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_ROOT = path.join(SKILL_ROOT, "assets", "web-media-starter");
const TEST_PARENT = path.join(SKILL_ROOT, "artifacts", "self-tests");
const ROOT = path.join(
  TEST_PARENT,
  "editable-preview",
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
);

function loadPlaywright() {
  const candidates = [
    process.cwd(),
    SCRIPT_DIR,
    process.platform === "win32" ? "D:\\Tools\\nodejs\\node_modules" : null,
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", {paths: [candidate]}));
    } catch {
      // Continue through the declared local module roots.
    }
  }
  throw new Error("找不到 Playwright；测试不会自动安装依赖");
}

function runBat(readyFile) {
  if (process.platform !== "win32") {
    throw new Error("BAT 预览启动链只在 Windows 验收");
  }
  const launcher = path.join(PACKAGE_ROOT, "_start_editable_preview.bat");
  const result = spawnSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/c", "call", launcher, "--no-open", "--ready-file", readyFile],
    {
      cwd: PACKAGE_ROOT,
      stdio: "ignore",
      windowsHide: true,
      timeout: 15000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`BAT 启动失败，退出码 ${result.status}`);
  }
}

async function waitForReady(readyFile) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      return JSON.parse(fs.readFileSync(readyFile, "utf8"));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("BAT 启动器没有生成就绪回执");
}

function stopServer(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return;
  }
  process.kill(pid, "SIGTERM");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  fs.mkdirSync(ROOT, {recursive: true});
  const readyFile = path.join(ROOT, "preview-ready.json");
  runBat(readyFile);
  const ready = await waitForReady(readyFile);
  let browser;
  try {
    assert(ready.protocol === "editable-media-preview-ready", "启动回执协议不正确");
    assert(path.resolve(ready.root) === path.resolve(PACKAGE_ROOT), "BAT 没有服务当前网页包");
    const response = await fetch(ready.url);
    assert(response.status === 200, `预览入口返回 ${response.status}`);
    const previewPort = Number(new URL(ready.url).port);
    assert(previewPort >= 49152 && previewPort <= 65535, "BAT 没有使用浏览器安全端口");
    const html = await response.text();
    assert(html.includes("editable-media-editor.js"), "预览入口没有读取可见编辑器");

    const playwright = loadPlaywright();
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
      || (process.platform === "win32"
        && fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : undefined);
    browser = await playwright.chromium.launch({
      headless: true,
      ...(executablePath ? {executablePath} : {}),
    });
    const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1600, height: 1000}});
    const page = await context.newPage();
    await page.goto(ready.url, {waitUntil: "networkidle"});
    await page.evaluate(() => localStorage.clear());
    await page.reload({waitUntil: "networkidle"});
    await page.locator("#editorPanel").waitFor({state: "visible"});

    const titleInput = page.locator('#contentEditor [data-editor-field="title"]');
    await titleInput.fill("侧栏里的真实修改");
    await page.locator("#mediaCanvas h1").waitFor();
    assert(
      await page.locator("#mediaCanvas h1").textContent() === "侧栏里的真实修改",
      "侧栏编辑文字后画布没有立即更新",
    );

    const canvasTitle = page.locator('#mediaCanvas [data-editor-field="title"]');
    await canvasTitle.evaluate((node) => {
      node.focus();
      node.innerText = "直接点击卡片修改";
      node.dispatchEvent(new Event("input", {bubbles: true}));
      node.blur();
    });
    assert(await titleInput.inputValue() === "直接点击卡片修改", "卡片内改字没有同步到侧栏");

    const typographyPreset = page.locator("#editorTypographyPreset");
    const typographyResults = {};
    for (const [profileId, expectedFamily, expectedWeight] of [
      ["fz-shuti-display", "方正舒体", "400"],
      ["fz-yaoti-display", "方正姚体", "400"],
      ["noto-sans-sc-black", "Noto Sans SC", "900"],
    ]) {
      assert(await typographyPreset.locator(`option[value="${profileId}"]`).isEnabled(), `${profileId} 本机字体应当可用`);
      await typographyPreset.selectOption(profileId);
      typographyResults[profileId] = await canvasTitle.evaluate((node) => ({
        family: getComputedStyle(node).fontFamily,
        weight: getComputedStyle(node).fontWeight,
      }));
      assert(typographyResults[profileId].family.includes(expectedFamily), `${profileId} 没有应用选定字体`);
      assert(typographyResults[profileId].weight === expectedWeight, `${profileId} 没有应用选定字重`);
    }
    assert(
      await typographyPreset.locator('option[value="fz-xiangli-display"]').evaluate((option) => option.disabled),
      "本机没有完整方正祥隶时预设仍然可选",
    );
    assert(
      await typographyPreset.locator('option[value="zihun-4181-warm-child-shadow"]').evaluate((option) => option.disabled),
      "本机没有精确字魂4181字体时预设仍然可选",
    );
    assert(await typographyPreset.locator('option[value="editorial-cn"]').isEnabled(), "本机编辑阅读字体不可用");
    await typographyPreset.selectOption("editorial-cn");
    const typographyResult = await canvasTitle.evaluate(async (node) => {
      let loaded = false;
      try {
        const probe = new FontFace("EditableMediaTestNotoSerif", 'local("Noto Serif SC")', {weight: "700"});
        await probe.load();
        loaded = probe.status === "loaded";
      } catch (_error) {
        loaded = false;
      }
      return {
        family: getComputedStyle(node).fontFamily,
        weight: getComputedStyle(node).fontWeight,
        loaded,
      };
    });
    assert(typographyResult.loaded, "字体文件没有被浏览器实际识别");
    assert(typographyResult.family.includes("Noto Serif SC"), "标题没有应用选定字体");
    assert(typographyResult.weight === "700", "标题没有应用选定字重");

    const backgroundPicker = page.locator('#colorEditor [data-editor-field="background"]');
    await backgroundPicker.evaluate((input) => {
      input.value = "#dcecff";
      input.dispatchEvent(new Event("input", {bubbles: true}));
    });
    assert(
      (await page.locator("#mediaCanvas").evaluate((node) => getComputedStyle(node).backgroundColor))
        === "rgb(220, 236, 255)",
      "编辑主题后画布没有立即更新",
    );

    await page.reload({waitUntil: "networkidle"});
    await page.locator("#editorPanel").waitFor({state: "visible"});
    assert(
      await page.locator("#mediaCanvas h1").textContent() === "直接点击卡片修改",
      "刷新后文字修改没有保留",
    );
    assert(
      (await page.locator("#mediaCanvas").evaluate((node) => getComputedStyle(node).backgroundColor))
        === "rgb(220, 236, 255)",
      "刷新后主题修改没有保留",
    );
    assert(
      (await page.locator("#mediaCanvas h1").evaluate((node) => getComputedStyle(node).fontFamily))
        .includes("Noto Serif SC"),
      "刷新后字体修改没有保留",
    );

    const dataDownloadPromise = page.waitForEvent("download");
    await page.locator("#editorDownload").click();
    const dataDownload = await dataDownloadPromise;
    const exportedData = path.join(ROOT, dataDownload.suggestedFilename());
    await dataDownload.saveAs(exportedData);
    const dataDocument = JSON.parse(fs.readFileSync(exportedData, "utf8"));
    assert(dataDocument.protocol === "editable-media-scene-data", "下载数据协议不正确");
    assert(dataDocument.data.title === "直接点击卡片修改", "下载数据没有当前文字");
    assert(dataDocument.theme.background === "#dcecff", "下载数据没有当前颜色");
    assert(dataDocument.theme.font_display_weight === 700, "下载数据没有当前字体字重");

    await page.locator("#editorPreview").click();
    assert(await page.locator("[data-editable-media-app]").evaluate((node) => node.classList.contains("editor-preview-expanded")), "放大预览没有进入预览状态");
    assert(await page.locator("#editorPanel").isHidden(), "放大预览仍显示编辑面板");
    await page.locator("#editorReturn").click();
    assert(await page.locator("#editorPanel").isVisible(), "返回编辑没有恢复编辑面板");

    await page.locator("#editorReset").click();
    assert(
      await page.locator("#mediaCanvas h1").textContent() === "One source, three ways to play",
      "恢复初始值没有回到清单默认状态",
    );

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#editorExport").click();
    const download = await downloadPromise;
    const exportedSvg = path.join(ROOT, download.suggestedFilename());
    await download.saveAs(exportedSvg);
    const svgText = fs.readFileSync(exportedSvg, "utf8");
    assert(svgText.includes("One source, three ways to play"), "导出文件没有包含当前画布文字");
    assert(svgText.includes("foreignObject"), "导出文件没有保存当前网页画布");

    await page.locator("#editorPanel").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({path: path.join(ROOT, "editable-preview-full.png"), fullPage: true});
    const mobile = await context.newPage();
    await mobile.setViewportSize({width: 360, height: 900});
    await mobile.goto(ready.url, {waitUntil: "networkidle"});
    await mobile.screenshot({path: path.join(ROOT, "editable-preview-360.png"), fullPage: true});
    await mobile.close();

    const capture = await context.newPage();
    await capture.goto(`${ready.url}?capture=1`, {waitUntil: "networkidle"});
    assert(await capture.locator("#editorPanel").isHidden(), "捕获模式仍显示编辑器");
    assert(await capture.locator(".controls").isHidden(), "捕获模式仍显示导航控件");
    await capture.close();
    await context.close();

    console.log(JSON.stringify({
      ok: true,
      protocol: "visual-multimedia-editable-preview-user-chain",
      version: 1,
      package_root: PACKAGE_ROOT,
      url: ready.url,
      launcher: path.join(PACKAGE_ROOT, "_start_editable_preview.bat"),
      editor_visible: true,
      text_edit_persisted: true,
      theme_edit_persisted: true,
      direct_canvas_edit_persisted: true,
      added_typography_verified: typographyResults,
      typography_verified: typographyResult,
      downloaded_data: exportedData,
      preview_roundtrip: true,
      reset_restored_manifest_defaults: true,
      svg_export: exportedSvg,
      capture_controls_hidden: true,
      screenshots: [
        path.join(ROOT, "editable-preview-full.png"),
        path.join(ROOT, "editable-preview-360.png"),
      ],
    }, null, 2));
  } finally {
    if (browser) await browser.close();
    stopServer(Number(ready.pid));
  }
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
