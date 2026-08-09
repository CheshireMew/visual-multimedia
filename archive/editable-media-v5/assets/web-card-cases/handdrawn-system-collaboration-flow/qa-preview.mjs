#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(process.argv[2] || ".");
const qaRoot = path.resolve(process.argv[3] || path.join(projectRoot, "qa"));
const captureTimes = [0, 1300, 3050, 4250, 5900, 8300, 10100, 11800, 13500];

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
  for (let port = 43157; port < 43187; port += 1) {
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html?capture=1&variant=landscape&scene=mcp-collaboration-loop`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.editableMedia && window.__hf);
    await page.evaluate(() => window.editableMedia.ready);
    await page.evaluate(() => window.editableMedia.pause());
    const canvas = page.locator("#mediaCanvas");
    const staticSnapshots = [];
    for (const timeMs of captureTimes) {
      await page.evaluate(async (value) => {
        window.editableMedia.setTime(value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, timeMs);
      staticSnapshots.push(await page.evaluate(() => [...document.querySelectorAll("#mediaCanvas *:not(.flow-dot)")].map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          index,
          tag: element.tagName,
          id: element.id,
          text: element.tagName.toLowerCase() === "text" ? element.textContent.trim() : "",
          rect: [rect.left, rect.top, rect.width, rect.height].map((value) => Number(value.toFixed(3))),
          geometry: ["x", "y", "x1", "y1", "x2", "y2", "width", "height", "d", "transform", "viewBox"].map((name) => element.getAttribute(name) || ""),
          style: [style.color, style.fill, style.stroke, style.strokeWidth, style.opacity, style.fontFamily, style.fontSize]
        };
      })));
      await canvas.screenshot({ path: path.join(qaRoot, `preview-${String(timeMs).padStart(5, "0")}.png`), type: "png" });
    }
    const staticSignature = JSON.stringify(staticSnapshots[0]);
    const staticInvariant = staticSnapshots.map((snapshot, index) => ({
      time_ms: captureTimes[index],
      matches_first_frame: JSON.stringify(snapshot) === staticSignature
    }));
    const audit = await page.evaluate(() => {
      const canvas = document.querySelector("#mediaCanvas").getBoundingClientRect();
      const allText = [...document.querySelectorAll("svg text")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { text: element.textContent.trim(), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      const outside = allText.filter((item) => item.left < canvas.left - 1 || item.top < canvas.top - 1 || item.right > canvas.right + 1 || item.bottom > canvas.bottom + 1);
      const emptyBindings = [...document.querySelectorAll("[data-editable-data]")].filter((element) => !element.textContent.trim()).map((element) => element.getAttribute("data-editable-data"));
      const dotCounts = Object.fromEntries(["trigger", "agentClient", "clientServer", "serverTools", "toolsDecision", "yesHuman", "humanShared", "sharedFeedback", "feedbackAgent", "noShared", "serverStateDown", "stateServerUp"].map((id) => [id, document.querySelectorAll(`[id^='${id}Trail'], #${id}Dot`).length]));
      const triggerAlignment = ["human", "agent", "state", "timer"].map((id) => {
        const icon = document.querySelector(`#trigger-icon-${id}`).getBoundingClientRect();
        const label = document.querySelector(`#trigger-label-${id}`).getBoundingClientRect();
        const iconCenter = icon.left + icon.width / 2;
        const labelCenter = label.left + label.width / 2;
        return { id, center_error_px: Number(Math.abs(iconCenter - labelCenter).toFixed(3)) };
      });
      const eventSafeMargins = ["result", "state", "next"].map((id) => {
        const card = document.querySelector(`#event-card-${id}`).getBoundingClientRect();
        const title = document.querySelector(`#event-title-${id}`).getBoundingClientRect();
        const copy = document.querySelector(`#event-copy-${id}`).getBoundingClientRect();
        const inner = { left: card.left + 8, right: card.right - 8, top: card.top + 6, bottom: card.bottom - 6 };
        return {
          id,
          title_inside: title.left >= inner.left && title.right <= inner.right && title.top >= inner.top && title.bottom <= inner.bottom,
          copy_inside: copy.left >= inner.left && copy.right <= inner.right && copy.top >= inner.top && copy.bottom <= inner.bottom,
          copy_bottom_gap_px: Number((card.bottom - copy.bottom).toFixed(3))
        };
      });
      const displayFontLoaded = document.fonts.check('20px "Xiaolai"');
      const displayFontFamilies = [...document.querySelectorAll(".headline, .region-title, .node-title, .label")].map((element) => getComputedStyle(element).fontFamily);
      const flowColorChecks = ["trigger", "agentClient", "clientServer", "serverTools", "toolsDecision", "yesHuman", "humanShared", "sharedFeedback", "feedbackAgent", "noShared", "serverStateDown", "stateServerUp"].map((id) => {
        const pathColor = getComputedStyle(document.querySelector(`#${id}Path`)).stroke;
        const dots = [...document.querySelectorAll(`#${id}Dot, [id^='${id}Trail']`)];
        const dotColors = [...new Set(dots.map((dot) => getComputedStyle(dot).fill))];
        return { id, path_color: pathColor, dot_colors: dotColors, matches: dotColors.length === 1 && dotColors[0] === pathColor };
      });
      return {
        canvas: { width: canvas.width, height: canvas.height },
        outside,
        emptyBindings,
        dotCounts,
        triggerAlignment,
        eventSafeMargins,
        displayFontLoaded,
        displayFontFamilies: [...new Set(displayFontFamilies)],
        flowColorChecks,
        title: document.querySelector(".headline")?.textContent.trim(),
        avatar: document.querySelector(".creator-avatar")?.getAttribute("src")
      };
    });
    const report = { capture_times_ms: captureTimes, console_errors: consoleErrors, static_invariant: staticInvariant, ...audit };
    fs.writeFileSync(path.join(qaRoot, "preview-audit.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (
      consoleErrors.length
      || audit.outside.length
      || audit.emptyBindings.length
      || Object.values(audit.dotCounts).some((count) => count !== 3)
      || audit.triggerAlignment.some((item) => item.center_error_px > 1)
      || audit.eventSafeMargins.some((item) => !item.title_inside || !item.copy_inside || item.copy_bottom_gap_px < 6)
      || !audit.displayFontLoaded
      || audit.displayFontFamilies.some((family) => !family.includes("Xiaolai"))
      || audit.flowColorChecks.some((item) => !item.matches)
      || staticInvariant.some((item) => !item.matches_first_frame)
    ) process.exitCode = 2;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
