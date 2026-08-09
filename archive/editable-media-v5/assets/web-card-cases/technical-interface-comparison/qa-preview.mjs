#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(process.argv[2] || ".");
const qaRoot = path.resolve(process.argv[3] || path.join(projectRoot, "qa"));

function loadPlaywright() {
  const candidates = [process.cwd(), projectRoot, "D:\\Tools\\NodeJS\\node_modules", "D:\\Tools\\codex-artifact-deps\\node_modules", "D:\\Tools\\visual-multimedia-node-runtime\\node_modules"];
  for (const candidate of candidates) {
    try { return require(require.resolve("playwright", { paths: [candidate] })); } catch {}
  }
  throw new Error("找不到 Playwright");
}

const mime = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".png", "image/png"]]);
function serveFile(request, response) {
  const raw = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const relative = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
  const file = path.resolve(projectRoot, relative);
  if (!file.startsWith(projectRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404); response.end("Not found"); return;
  }
  response.writeHead(200, { "Content-Type": mime.get(path.extname(file).toLowerCase()) || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(response);
}

async function startServer() {
  for (let port = 43187; port < 43217; port += 1) {
    const server = http.createServer(serveFile);
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      return { server, port };
    } catch { server.close(); }
  }
  throw new Error("找不到可用预览端口");
}

async function main() {
  fs.mkdirSync(qaRoot, { recursive: true });
  const { server, port } = await startServer();
  const playwright = loadPlaywright();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html?capture=1&variant=landscape-16x9&scene=interface-flow`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.editableMedia);
    await page.evaluate(() => window.editableMedia.ready);
    const canvas = page.locator("#mediaCanvas");
    await canvas.screenshot({ path: path.join(qaRoot, "preview.png"), type: "png" });
    const audit = await page.evaluate(() => {
      const canvasRect = document.querySelector("#mediaCanvas").getBoundingClientRect();
      const textElements = [...document.querySelectorAll("svg text, h1, h2, p, .key-label, .key-chip, .panel-index, .rail-label, .rail-entry, .rail-arrow, .rail-core strong, .rail-core span")];
      const outsideCanvas = textElements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { text: element.textContent.trim(), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      }).filter((item) => item.left < canvasRect.left - 1 || item.top < canvasRect.top - 1 || item.right > canvasRect.right + 1 || item.bottom > canvasRect.bottom + 1);
      const panels = [...document.querySelectorAll(".panel")].map((panel) => {
        const box = panel.getBoundingClientRect();
        const children = [...panel.querySelectorAll("svg text, h2, p, .panel-index")].map((element) => {
          const rect = element.getBoundingClientRect();
          return { text: element.textContent.trim(), inside: rect.left >= box.left - 1 && rect.top >= box.top - 1 && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1 };
        });
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height, outside_text: children.filter((item) => !item.inside) };
      });
      const text = document.querySelector("#mediaCanvas").textContent.replace(/\s+/g, " ").trim();
      const avatar = document.querySelector(".creator-avatar");
      return {
        canvas: { width: canvasRect.width, height: canvasRect.height },
        outside_canvas: outsideCanvas,
        panels,
        equal_panel_geometry: panels.every((panel) => Math.abs(panel.width - panels[0].width) <= 1 && Math.abs(panel.height - panels[0].height) <= 1 && Math.abs(panel.top - panels[0].top) <= 1 && Math.abs(panel.bottom - panels[0].bottom) <= 1),
        forbidden_fragments: ["tool/lis", "tool/cal", "MediaFlow", "编辑 · 查询 · 渲染 · 导出"].filter((token) => text.includes(token)),
        expected_shared_core: text.includes("规则 · 数据 · 操作 · 结果"),
        avatar_loaded: Boolean(avatar?.complete && avatar.naturalWidth > 0),
        title: document.querySelector(".title-primary")?.textContent.trim()
      };
    });
    const report = { console_errors: consoleErrors, ...audit };
    fs.writeFileSync(path.join(qaRoot, "preview-audit.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (
      consoleErrors.length
      || audit.canvas.width !== 1920
      || audit.canvas.height !== 1080
      || audit.outside_canvas.length
      || audit.panels.some((panel) => panel.outside_text.length)
      || !audit.equal_panel_geometry
      || audit.forbidden_fragments.length
      || !audit.expected_shared_core
      || !audit.avatar_loaded
    ) process.exitCode = 2;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
