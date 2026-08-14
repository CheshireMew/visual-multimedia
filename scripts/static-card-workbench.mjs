#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

import {listenOnBrowserSafePort} from "./browser-safe-server.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const BASE_TEMPLATE = path.join(SKILL_ROOT, "assets", "static-card-workbench", "base.html");
const require = createRequire(import.meta.url);

function fail(message) {
  throw new Error(message);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) fail(`无法识别参数：${token}`);
    const name = token.slice(2);
    const next = values[index + 1];
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
  if (value == null || value === true || !String(value).trim()) fail(`缺少 --${name}`);
  return String(value).trim();
}

function absolutePath(value, name) {
  if (!path.isAbsolute(value)) fail(`--${name} 必须是绝对路径：${value}`);
  return path.resolve(value);
}

function positiveInteger(value, name, fallback = null) {
  if (value == null && fallback != null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) fail(`--${name} 必须是正整数`);
  return number;
}

function replaceToken(source, token, value) {
  if (!source.includes(token)) fail(`起始画布缺少占位符：${token}`);
  return source.replaceAll(token, String(value));
}

function resolveStyle(args) {
  if (!args["style-file"]) return {source: null, css: ""};
  const stylePath = absolutePath(required(args, "style-file"), "style-file");
  if (!fs.existsSync(stylePath) || !fs.statSync(stylePath).isFile()) {
    fail(`样式文件不存在：${stylePath}`);
  }
  return {source: stylePath, css: fs.readFileSync(stylePath, "utf8")};
}

function createCard(args) {
  const output = absolutePath(required(args, "output"), "output");
  if (path.extname(output).toLowerCase() !== ".html") fail("--output 必须指向 .html 文件");
  if (fs.existsSync(output)) fail(`拒绝覆盖现有文件：${output}`);
  const width = positiveInteger(required(args, "width"), "width");
  const height = positiveInteger(required(args, "height"), "height");
  const displayWidth = positiveInteger(args["display-width"], "display-width", 360);
  if (displayWidth > width) fail("--display-width 不能大于源画布宽度");

  const values = {
    "{{CARD_WIDTH}}": width,
    "{{CARD_HEIGHT}}": height,
    "{{DISPLAY_WIDTH}}": displayWidth,
  };
  const style = resolveStyle(args);
  let html = fs.readFileSync(BASE_TEMPLATE, "utf8");
  for (const [token, value] of Object.entries(values)) html = replaceToken(html, token, value);
  const styleBlock = style.css
    ? `<style data-explicit-card-style>\n${style.css.trim()}\n</style>`
    : "";
  html = replaceToken(html, "{{EXPLICIT_STYLE}}", styleBlock);
  if (/\{\{[A-Z0-9_]+\}\}/.test(html)) fail("起始画布仍有未解析占位符");

  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, html, "utf8");
  return {
    ok: true,
    command: "create",
    output,
    canvas: {width, height},
    minimum_display_width: displayWidth,
    style_source: style.source,
    project_files: [path.basename(output)],
  };
}

function loadPlaywright() {
  const candidates = [
    SKILL_ROOT,
    process.cwd(),
    process.env.NODE_PATH,
    process.env.PLAYWRIGHT_NODE_MODULES,
    process.platform === "win32" ? "D:\\Tools\\NodeJS\\node_modules" : null,
    process.platform === "win32" ? "D:\\Tools\\npm-global\\node_modules" : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", {paths: [candidate]}));
    } catch {
      // Continue through existing local dependency roots. This command never installs packages.
    }
  }
  fail("找不到现有 Playwright；请设置 PLAYWRIGHT_NODE_MODULES 指向已安装依赖");
}

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

async function startServer(root) {
  const resolvedRoot = path.resolve(root);
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const target = path.resolve(resolvedRoot, ...relative.split("/"));
      const relation = path.relative(resolvedRoot, target);
      if (relation.startsWith("..") || path.isAbsolute(relation)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": MIME.get(path.extname(target).toLowerCase()) || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(target).pipe(response);
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  const port = await listenOnBrowserSafePort(server);
  return {server, origin: `http://127.0.0.1:${port}`};
}

function browserExecutable(args) {
  if (args.browser) {
    const explicit = absolutePath(required(args, "browser"), "browser");
    if (!fs.existsSync(explicit) || !fs.statSync(explicit).isFile()) fail(`浏览器不存在：${explicit}`);
    return explicit;
  }
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function captureCard(args) {
  const input = absolutePath(required(args, "input"), "input");
  const outputDir = absolutePath(required(args, "output-dir"), "output-dir");
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) fail(`HTML 不存在：${input}`);
  fs.mkdirSync(outputDir, {recursive: true});

  const {chromium} = loadPlaywright();
  const executablePath = browserExecutable(args);
  const {server, origin} = await startServer(path.dirname(input));
  let browser;
  try {
    browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
    const target = `${origin}/${encodeURIComponent(path.basename(input))}`;
    await page.goto(target, {waitUntil: "networkidle"});
    await page.evaluate(() => document.fonts.ready);

    const report = await page.evaluate(() => {
      const root = document.documentElement;
      const card = document.querySelector("#card");
      if (!card) throw new Error("页面缺少 #card");
      const width = Number(root.dataset.cardWidth);
      const height = Number(root.dataset.cardHeight);
      const displayWidth = Number(root.dataset.displayWidth || 360);
      if (![width, height, displayWidth].every((value) => Number.isFinite(value) && value > 0)) {
        throw new Error("html 缺少有效 data-card-width、data-card-height 或 data-display-width");
      }
      const displayScale = displayWidth / width;
      const cardRect = card.getBoundingClientRect();
      const primary = [...card.querySelectorAll('[data-primary="true"]')]
        .filter((element) => getComputedStyle(element).display !== "none" && element.textContent.trim())
        .map((element) => ({
          text: element.textContent.trim().slice(0, 80),
          source_px: Number.parseFloat(getComputedStyle(element).fontSize),
        }));
      const overflow = [...card.querySelectorAll("*")]
        .filter((element) => {
          if (element.closest("[data-allow-bleed]")) return false;
          const style = getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = element.getBoundingClientRect();
          return rect.left < cardRect.left - 2
            || rect.right > cardRect.right + 2
            || rect.top < cardRect.top - 2
            || rect.bottom > cardRect.bottom + 2;
        })
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          class: element.className || "",
          text: element.textContent.trim().slice(0, 80),
        }));
      return {
        canvas: {width, height},
        display: {width: displayWidth, height: Math.round(height * displayScale), scale: displayScale},
        placeholders: card.querySelectorAll('[data-placeholder="true"]').length,
        primary_count: primary.length,
        minimum_display_primary_text_px: primary.length
          ? Math.min(...primary.map((item) => item.source_px * displayScale))
          : null,
        overflow,
        fonts: primary.slice(0, 12).map((item) => ({
          text: item.text,
          display_px: Number((item.source_px * displayScale).toFixed(2)),
        })),
      };
    });

    if (report.placeholders > 0 && args["allow-placeholder"] !== true) {
      fail(`画布仍有 ${report.placeholders} 个占位内容，拒绝生成确认稿`);
    }
    if (report.primary_count === 0) fail("画布没有 data-primary=\"true\" 的主要阅读文字");
    if (report.minimum_display_primary_text_px < 14) {
      fail(`主要文字在 ${report.display.width}px 展示宽度下仅 ${report.minimum_display_primary_text_px.toFixed(2)}px`);
    }
    if (report.overflow.length > 0) {
      fail(`画布存在 ${report.overflow.length} 个越界元素：${JSON.stringify(report.overflow.slice(0, 5))}`);
    }

    const fullPath = path.join(outputDir, "full.png");
    const displayPath = path.join(outputDir, `display-${report.display.width}.png`);
    const card = page.locator("#card");
    await card.screenshot({path: fullPath, animations: "disabled"});
    await page.setViewportSize({
      width: Math.max(report.display.width + 40, 400),
      height: Math.max(Math.min(report.display.height + 40, 8000), 400),
    });
    await card.evaluate((element, scale) => {
      element.style.transformOrigin = "top left";
      element.style.transform = `scale(${scale})`;
      element.style.margin = "0";
    }, report.display.scale);
    await card.screenshot({path: displayPath, animations: "disabled"});

    return {
      ok: true,
      command: "capture",
      input,
      previews: {full: fullPath, minimum_display: displayPath},
      ...report,
    };
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function usage() {
  return [
    "用法：",
    "  node scripts/static-card-workbench.mjs create --output <绝对路径/index.html> --width <px> --height <px> [--display-width 360] [--style-file <绝对路径>]",
    "  node scripts/static-card-workbench.mjs capture --input <绝对路径/index.html> --output-dir <绝对路径> [--browser <绝对路径>]",
  ].join("\n");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(usage());
    return;
  }
  const args = parseArgs(rest);
  const result = command === "create"
    ? createCard(args)
    : command === "capture"
      ? await captureCard(args)
      : fail(`未知命令：${command}\n${usage()}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
