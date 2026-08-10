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
  const candidates = [
    process.cwd(),
    projectRoot,
    "D:\\Tools\\NodeJS\\node_modules",
    "D:\\Tools\\codex-artifact-deps\\node_modules",
    "D:\\Tools\\visual-multimedia-node-runtime\\node_modules",
  ];
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", { paths: [candidate] }));
    } catch {}
  }
  throw new Error("找不到 Playwright");
}

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
]);

function serveFile(request, response) {
  const raw = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const relative = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
  const file = path.resolve(projectRoot, relative);
  if (!file.startsWith(projectRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": mime.get(path.extname(file).toLowerCase()) || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(response);
}

async function startServer() {
  for (let port = 43217; port < 43247; port += 1) {
    const server = http.createServer(serveFile);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return { server, port };
    } catch {
      server.close();
    }
  }
  throw new Error("找不到可用预览端口");
}

function near(a, b, tolerance = 1) {
  return Math.abs(a - b) <= tolerance;
}

async function main() {
  fs.mkdirSync(qaRoot, { recursive: true });
  const { server, port } = await startServer();
  const playwright = loadPlaywright();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1500 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  try {
    await page.goto(
      `http://127.0.0.1:${port}/index.html?capture=1&variant=portrait-4x5&scene=directory`,
      { waitUntil: "networkidle" },
    );
    await page.waitForFunction(() => window.editableMedia);
    await page.evaluate(() => window.editableMedia.ready);
    await page.locator("#mediaCanvas").screenshot({
      path: path.join(qaRoot, "preview.png"),
      type: "png",
    });

    const audit = await page.evaluate(() => {
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
        };
      };
      const canvas = document.querySelector("#mediaCanvas");
      const title = document.querySelector(".title");
      const hero = document.querySelector(".hero-mark");
      const grid = document.querySelector(".directory-grid");
      const cards = [...document.querySelectorAll(".directory-card")];
      const canvasRect = rectOf(canvas);
      const titleRect = rectOf(title);
      const heroRect = rectOf(hero);
      const gridRect = rectOf(grid);
      const cardRects = cards.map(rectOf);
      const textOutsideCards = cards.flatMap((card, index) => {
        const box = rectOf(card);
        return [...card.querySelectorAll(".item-name, .item-description")]
          .map((element) => ({ index, text: element.textContent.trim(), rect: rectOf(element) }))
          .filter((item) => (
            item.rect.left < box.left - 1
            || item.rect.top < box.top - 1
            || item.rect.right > box.right + 1
            || item.rect.bottom > box.bottom + 1
          ));
      });
      const visibleText = canvas.textContent.replace(/\s+/g, " ").trim();
      return {
        canvas: canvasRect,
        title: title.textContent.trim(),
        title_rect: titleRect,
        hero_rect: heroRect,
        grid_rect: gridRect,
        cards: cardRects,
        card_count: cards.length,
        icon_count: document.querySelectorAll(".icon-tile svg").length,
        primary_labels: [...document.querySelectorAll(".item-name")].map((node) => node.textContent.trim()),
        secondary_labels: [...document.querySelectorAll(".item-description")].map((node) => node.textContent.trim()),
        text_outside_cards: textOutsideCards,
        forbidden_fragments: ["Codex Plugins", "Computer Use", "Chrome", "HyperFrames", "GitHub", "Vercel"]
          .filter((token) => visibleText.includes(token)),
        background: getComputedStyle(canvas).backgroundColor,
        card_border_widths: cards.map((card) => getComputedStyle(card).borderTopWidth),
        runtime_bound_ids: Object.keys(window.editableMedia.getBounds()).sort(),
      };
    });

    const cards = audit.cards;
    const equalCardGeometry = cards.length === 8 && cards.every((card) => (
      near(card.width, cards[0].width)
      && near(card.height, cards[0].height)
    ));
    const alignedColumns = cards.length === 8 && [0, 1, 2, 3].every((column) => (
      near(cards[column].left, cards[column + 4].left)
      && near(cards[column].right, cards[column + 4].right)
    ));
    const alignedRows = cards.length === 8
      && cards.slice(0, 4).every((card) => near(card.top, cards[0].top))
      && cards.slice(4).every((card) => near(card.top, cards[4].top));
    const heroCentered = near(audit.hero_rect.centerX, audit.canvas.centerX);
    const titleCentered = near(audit.title_rect.centerX, audit.canvas.centerX);
    const gridInsideCanvas = audit.grid_rect.left >= audit.canvas.left
      && audit.grid_rect.top >= audit.canvas.top
      && audit.grid_rect.right <= audit.canvas.right
      && audit.grid_rect.bottom <= audit.canvas.bottom;

    const report = {
      console_errors: consoleErrors,
      ...audit,
      equal_card_geometry: equalCardGeometry,
      aligned_columns: alignedColumns,
      aligned_rows: alignedRows,
      hero_centered: heroCentered,
      title_centered: titleCentered,
      grid_inside_canvas: gridInsideCanvas,
    };
    fs.writeFileSync(
      path.join(qaRoot, "preview-audit.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    if (
      consoleErrors.length
      || audit.canvas.width !== 1200
      || audit.canvas.height !== 1500
      || audit.title !== "Creative Toolkit"
      || audit.card_count !== 8
      || audit.icon_count !== 8
      || audit.primary_labels.some((label) => !label)
      || audit.secondary_labels.some((label) => !label)
      || audit.text_outside_cards.length
      || audit.forbidden_fragments.length
      || audit.background !== "rgb(5, 7, 12)"
      || audit.card_border_widths.some((width) => width !== "1px")
      || JSON.stringify(audit.runtime_bound_ids) !== JSON.stringify(["directory-grid", "hero-mark", "title"])
      || !equalCardGeometry
      || !alignedColumns
      || !alignedRows
      || !heroCentered
      || !titleCentered
      || !gridInsideCanvas
    ) {
      process.exitCode = 2;
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
