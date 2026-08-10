#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY = path.join(ROOT, "assets", "color-palette-library");
const CATALOG = path.join(LIBRARY, "catalog.json");
const OUTPUT = path.join(LIBRARY, "preview.png");
const REQUIRED_ROLES = ["background", "surface", "text", "muted", "accent", "accent_text"];
const HEX = /^#[0-9A-F]{6}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function parseCatalog() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  assert(catalog.protocol === "visual-multimedia-color-palettes", "配色目录协议不正确");
  assert(catalog.version === 1, "配色目录版本不正确");
  assert(Array.isArray(catalog.palettes) && catalog.palettes.length === 6, "配色目录必须包含六张卡");
  const ids = new Set();
  for (const palette of catalog.palettes) {
    assert(palette.id && !ids.has(palette.id), `配色卡 id 重复或为空：${palette.id || "<empty>"}`);
    ids.add(palette.id);
    assert(Array.isArray(palette.use_when) && palette.use_when.length > 0, `${palette.id} 缺少适用条件`);
    assert(Array.isArray(palette.avoid_when) && palette.avoid_when.length > 0, `${palette.id} 缺少禁用条件`);
    for (const role of REQUIRED_ROLES) {
      assert(HEX.test(palette.roles?.[role] || ""), `${palette.id}.${role} 不是六位十六进制色值`);
    }
    assert(contrastRatio(palette.roles.text, palette.roles.background) >= 4.5, `${palette.id} 正文与背景对比度不足`);
    assert(contrastRatio(palette.roles.muted, palette.roles.background) >= 4.5, `${palette.id} 次要文字与背景对比度不足`);
    assert(contrastRatio(palette.roles.accent_text, palette.roles.accent) >= 4.5, `${palette.id} 强调文字与强调色对比度不足`);
  }
  return catalog;
}

function loadPlaywright() {
  const candidates = [
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
    process.platform === "win32" ? "D:\\Tools\\nodejs\\node_modules" : null,
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", {paths: [candidate]}));
    } catch {
      // Continue through configured local module roots.
    }
  }
  throw new Error("找不到 Playwright；不会自动安装依赖");
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.every((arg) => arg === "--validate-only"), `未知参数：${args.join(" ")}`);
  const catalog = parseCatalog();
  if (args.includes("--validate-only")) {
    console.log(JSON.stringify({ok: true, catalog: CATALOG, palettes: catalog.palettes.map(({id}) => id)}, null, 2));
    return;
  }
  const server = http.createServer((request, response) => {
    const relative = request.url === "/" ? "index.html" : decodeURIComponent(request.url.slice(1));
    const target = path.resolve(LIBRARY, relative);
    if (!target.startsWith(`${LIBRARY}${path.sep}`) || !fs.existsSync(target)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {"Content-Type": contentType(target)});
    fs.createReadStream(target).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const {chromium} = loadPlaywright();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
    || (process.platform === "win32" && fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined);
  const browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1600, height: 1050}, deviceScaleFactor: 1});
    await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: "networkidle"});
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    assert(await page.locator("[data-palette-id]").count() === catalog.palettes.length, "网页没有消费全部配色卡");
    await page.screenshot({path: OUTPUT, fullPage: true});
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(JSON.stringify({ok: true, catalog: CATALOG, preview: OUTPUT, palettes: catalog.palettes.map(({id}) => id)}, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
