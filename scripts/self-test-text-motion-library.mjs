#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  libraryRoot,
  searchEffects,
  validateTextMotionLibrary,
} from "./text-motion-library.mjs";
import {listenOnBrowserSafePort} from "./browser-safe-server.mjs";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "ms-playwright"),
    "D:\\Tools\\nodejs\\node_modules",
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", { paths: [candidate] }));
    } catch {
      // Continue through declared local dependency roots.
    }
  }
  throw new Error(
    "找不到 Playwright；请通过 NODE_PATH 指向现有 node_modules，本脚本不会安装依赖。"
  );
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
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
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(response);
  });
  const port = await listenOnBrowserSafePort(server);
  return {
    server,
    url: `http://127.0.0.1:${port}/index.html?capture=1`,
  };
}

function averageOpacity(layer) {
  if (!layer?.units?.length) return 0;
  return layer.units.reduce(
    (total, unit) => total + Number(unit.opacity || 0),
    0
  ) / layer.units.length;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeterministicEffect(result) {
  assert(
    JSON.stringify(result.start) === JSON.stringify(result.startRepeat),
    `${result.id} 在相同开始时间产生了不同样式`
  );
  assert(
    JSON.stringify(result.middle) === JSON.stringify(result.middleRepeat),
    `${result.id} 在相同中间时间产生了不同样式`
  );
  assert(
    JSON.stringify(result.start) !== JSON.stringify(result.middle)
      || JSON.stringify(result.middle) !== JSON.stringify(result.end),
    `${result.id} 的开始、中间和结束没有可观察变化`
  );
  if (result.operation === "enter") {
    assert(
      averageOpacity(result.start.primary) < averageOpacity(result.end.primary),
      `${result.id} 的进入结果没有比开始状态更可见`
    );
  } else if (result.operation === "exit") {
    assert(
      averageOpacity(result.start.primary) > averageOpacity(result.end.primary),
      `${result.id} 的退出结果没有比开始状态更隐藏`
    );
  } else if (result.operation === "replace") {
    assert(
      averageOpacity(result.start.outgoing) > averageOpacity(result.end.outgoing),
      `${result.id} 的旧文字没有完成退出`
    );
    assert(
      averageOpacity(result.start.incoming) < averageOpacity(result.end.incoming),
      `${result.id} 的新文字没有完成进入`
    );
  }
}

async function main() {
  const validation = validateTextMotionLibrary();
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  assert(
    searchEffects("逐字 克制").some(
      ({ document }) => document.id === "soft-blur-in"
    ),
    "中文语义搜索没有找到符合分段和能量条件的效果"
  );
  const skillRoot = path.resolve(libraryRoot, "..", "..");
  const testRoot = path.join(skillRoot, "artifacts", "self-tests");
  fs.mkdirSync(testRoot, {recursive: true});
  const materializedRoot = fs.mkdtempSync(
    path.join(testRoot, "text-motion-")
  );
  fs.cpSync(
    path.join(skillRoot, "assets", "web-media-starter"),
    materializedRoot,
    { recursive: true }
  );
  const materialize = spawnSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "text-motion-library.mjs"),
      "materialize",
      "per-character-rise",
      "--project",
      materializedRoot,
      "--operation",
      "enter",
      "--json",
    ],
    {
      cwd: skillRoot,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
    }
  );
  if (materialize.status !== 0) {
    throw new Error(materialize.stderr || materialize.stdout || "文字动效物化失败");
  }
  const materialized = JSON.parse(materialize.stdout);
  const materializedManifest = JSON.parse(
    fs.readFileSync(path.join(materializedRoot, "editable-media.json"), "utf8")
  );
  for (const resource of [
    "text-motion/text-motion-runtime.js",
    "text-motion/text-motion-binding.js",
    "text-motion/library.json",
    "text-motion/THIRD_PARTY_NOTICES.md",
    "text-motion/effects/per-character-rise.json",
    "text-motion/selection.json",
  ]) {
    assert(
      materializedManifest.resources.includes(resource),
      `物化后的网页包没有登记资源 ${resource}`
    );
    assert(
      fs.existsSync(path.join(materializedRoot, resource)),
      `物化后的网页包缺少资源 ${resource}`
    );
  }
  assert(
    materialized.effectId === "per-character-rise"
      && materialized.operation === "enter",
    "公开 materialize 命令没有保留选择结果"
  );
  const screenshotIndex = process.argv.indexOf("--screenshot");
  const screenshotPath = screenshotIndex >= 0
    ? path.resolve(process.argv[screenshotIndex + 1])
    : null;
  const { server, url } = await serve(libraryRoot);
  const materializedService = await serve(materializedRoot);
  const browserErrors = [];
  let browser;
  try {
    const { chromium } = loadPlaywright();
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? {executablePath} : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.textMotionGallery), null, {
      timeout: 10000,
    });
    await page.evaluate(() => window.textMotionGallery.ready);

    const effectIds = await page.evaluate(() => window.textMotionGallery.getEffectIds());
    assert(effectIds.length === 24, `真实画廊应加载 24 个效果，实际 ${effectIds.length}`);

    const results = [];
    for (const id of effectIds) {
      const operations = await page.evaluate((effectId) => {
        const gallery = window.textMotionGallery;
        gallery.selectEffect(effectId);
        return gallery.getOperations();
      }, id);
      for (const operation of operations) {
        const result = await page.evaluate(({ effectId, operation }) => {
          const gallery = window.textMotionGallery;
          gallery.selectEffect(effectId);
          gallery.setOperation(operation);
          const duration = gallery.getDuration();
          const start = gallery.renderAt(0);
          const startRepeat = gallery.renderAt(0);
          const middle = gallery.renderAt(duration / 2);
          const middleRepeat = gallery.renderAt(duration / 2);
          const end = gallery.renderAt(duration);
          return {
            id: effectId,
            operation,
            duration,
            start,
            startRepeat,
            middle,
            middleRepeat,
            end,
          };
        }, { effectId: id, operation });
        assert(result.duration > 0, `${id}/${operation} 没有正数可采样时长`);
        assertDeterministicEffect(result);
        results.push(result);
      }
    }

    const segmentation = await page.evaluate(async () => {
      const graphemes = TextMotion.segmentText(
        "A👨‍👩‍👧‍👦e\u0301中",
        "grapheme",
        "zh-CN"
      ).map((part) => part.text);
      const wordSource = "文字 motion，保持  空白";
      const words = TextMotion.segmentText(wordSource, "word", "zh-CN");

      const lineEffect = await fetch("effects/line-by-line-slide.json")
        .then((response) => response.json());
      const lineHost = document.createElement("div");
      Object.assign(lineHost.style, {
        position: "fixed",
        left: "-10000px",
        top: "0",
        width: "180px",
        fontSize: "32px",
        lineHeight: "1.2",
      });
      document.body.append(lineHost);
      const linePlayer = TextMotion.createPlayer(lineHost, lineEffect, {
        text: "真实排版宽度决定文字究竟换成多少行",
        previousText: "旧文字",
        locale: "zh-CN",
      });
      const lineCount = linePlayer.getUnitCounts().primary;
      linePlayer.destroy();
      lineHost.remove();

      const blurEffect = await fetch("effects/soft-blur-in.json")
        .then((response) => response.json());
      const reducedHost = document.createElement("div");
      document.body.append(reducedHost);
      const reducedPlayer = TextMotion.createPlayer(reducedHost, blurEffect, {
        text: "降低运动",
        previousText: "旧文字",
        locale: "zh-CN",
      });
      reducedPlayer.renderAt(90, "enter", { reducedMotion: true });
      const reduced = reducedPlayer.snapshot();
      reducedPlayer.destroy();
      reducedHost.remove();

      return {
        graphemes,
        wordSource,
        wordRoundtrip: words.map((part) => part.text).join(""),
        lineCount,
        reduced,
      };
    });
    assert(
      segmentation.graphemes.length === 4,
      `字素分段应得到 4 个可见字符，实际 ${segmentation.graphemes.length}`
    );
    assert(
      segmentation.wordRoundtrip === segmentation.wordSource,
      "逐词分段没有原样保留空白和标点"
    );
    assert(segmentation.lineCount >= 2, "逐行动效没有读取真实布局换行");
    for (const unit of segmentation.reduced.primary.units) {
      const blur = unit.filter.match(/blur\(([-\d.]+)px\)/);
      assert(blur && Number(blur[1]) === 0, "降低运动仍然保留了模糊");
      const translation = unit.transform.match(
        /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*[-\d.]+px\)/
      );
      assert(
        translation
          && Number(translation[1]) === 0
          && Number(translation[2]) === 0,
        "降低运动仍然保留了位移"
      );
    }

    const roundtrip = await page.evaluate(() => {
      const text = "A👨‍👩‍👧‍👦e\u0301中";
      window.textMotionGallery.setText(text, "旧文字");
      window.textMotionGallery.selectEffect("per-character-rise");
      window.textMotionGallery.renderAt(400);
      return {
        text,
        bound: document.querySelector("[data-editable-data='preview_text']").textContent,
        units: window.textMotionGallery.getUnitCounts().primary,
      };
    });
    assert(roundtrip.bound === roundtrip.text, "编辑状态没有到达画廊文字绑定");
    assert(roundtrip.units === 4, "编辑后的真实字素没有进入文字动效运行时");

    const consumerPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consumerErrors = [];
    consumerPage.on("pageerror", (error) => consumerErrors.push(error.message));
    await consumerPage.goto(materializedService.url, { waitUntil: "networkidle" });
    await consumerPage.waitForFunction(() => Boolean(window.editableMedia));
    await consumerPage.evaluate(() => window.editableMedia.ready);
    await consumerPage.addScriptTag({
      url: new URL(
        "text-motion/text-motion-binding.js",
        materializedService.url
      ).href,
    });
    const consumer = await consumerPage.evaluate(async () => {
      const host = document.createElement("div");
      host.id = "materializedTextMotionHost";
      Object.assign(host.style, {
        position: "fixed",
        left: "80px",
        top: "80px",
        width: "720px",
        height: "180px",
        fontSize: "56px",
      });
      document.body.append(host);
      const controller = await TextMotionBinding.attach({
        host,
        textField: "title",
        previousTextField: "summary",
      });
      const duration = controller.player.getDuration(controller.selection.operation);
      window.editableMedia.setTime(duration / 2);
      const first = controller.player.snapshot();
      window.editableMedia.setTime(duration / 2);
      const second = controller.player.snapshot();
      return {
        selection: controller.selection,
        duration,
        first,
        second,
        text: host.textContent,
      };
    });
    assert(consumerErrors.length === 0, `物化消费者产生错误：${consumerErrors.join(" | ")}`);
    assert(consumer.duration > 0, "物化消费者没有得到可采样时长");
    assert(
      JSON.stringify(consumer.first) === JSON.stringify(consumer.second),
      "物化后的正式绑定器在相同 editable-media 时间产生不同结果"
    );
    assert(
      consumer.selection.effect_id === "per-character-rise"
        && consumer.text.length > 0,
      "物化后的效果、selection 和网页文字没有接通"
    );
    await consumerPage.close();

    assert(browserErrors.length === 0, `画廊产生浏览器错误：${browserErrors.join(" | ")}`);
    if (screenshotPath) {
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.evaluate(() => {
        window.textMotionGallery.selectEffect("soft-blur-in");
        window.textMotionGallery.setOperation("replace");
        window.textMotionGallery.setText("确定性文字动效", "同一时间，同一画面");
        window.textMotionGallery.renderAt(620);
      });
      await page.locator("#mediaCanvas").screenshot({ path: screenshotPath });
    }
    console.log(
      `文字动效真实链路通过：24 个效果的 ${results.length} 个操作、字素/词/实际行分段、`
      + "降低运动、公开物化、正式绑定器、编辑状态传输和相同时间重复采样均通过"
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => materializedService.server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
