#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const testParent = process.platform === "win32" && fs.existsSync("D:\\Tools")
  ? "D:\\Tools\\visual-multimedia-tests"
  : os.tmpdir();
const testRoot = path.join(
  path.resolve(process.env.VISUAL_MULTIMEDIA_TEST_ROOT || testParent),
  "lightweight-visual-card",
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
);

function loadPlaywright() {
  const candidates = [
    process.cwd(),
    scriptDir,
    process.platform === "win32" ? "D:\\Tools\\nodejs\\node_modules" : null,
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", { paths: [candidate] }));
    } catch {
      // Continue through declared local module roots.
    }
  }
  throw new Error("找不到 Playwright；测试不会自动安装依赖");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>X 算法更新卡片轻量路线检查</title>
<style>
:root{--canvas-w:1800px;--canvas-h:3950px;--paper:#f4f1e9;--ink:#151515;--muted:#5f625f;--blue:#1649d8;--yellow:#f0bd1b;--rule:#222;--scale:1}
*{box-sizing:border-box}
html,body{margin:0;background:#cbc9c2;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;color:var(--ink);overflow:hidden}
body{min-height:100vh;position:relative}
.stage{position:absolute;inset:0 auto auto 0;width:var(--canvas-w);height:var(--canvas-h);transform:scale(var(--scale));transform-origin:top left}
.card{width:var(--canvas-w);height:var(--canvas-h);overflow:hidden;background:var(--paper);padding:104px 108px 72px;display:grid;grid-template-rows:auto auto auto 1fr auto;gap:52px}
.header{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(560px,.85fr);gap:72px;align-items:end}
.eyebrow{margin:0 0 24px;color:var(--blue);font-size:58px;font-weight:800;letter-spacing:.08em}
h1{margin:0;font-size:142px;line-height:1.04;letter-spacing:-.045em;max-width:1020px}
.subtitle{margin:34px 0 0;font-size:78px;line-height:1.36;color:var(--muted);font-weight:600}
.system{border-top:4px solid var(--rule);border-bottom:1px solid #aaa;display:grid}
.system div{padding:30px 0;display:grid;grid-template-columns:164px 1fr;gap:24px;align-items:start;border-bottom:1px solid #b8b7b0}
.system div:last-child{border-bottom:0}
.system strong{display:block;color:var(--blue);font-size:82px;line-height:1.08}
.system span{display:block;font-size:75px;line-height:1.3;color:var(--muted)}
.single-rule{height:4px;background:var(--blue)}
.takeaway{background:var(--blue);color:white;padding:42px 50px;font-size:82px;line-height:1.38;font-weight:800}
.content{display:grid;grid-template-columns:1fr;gap:56px;min-height:0}
.section{border-top:5px solid var(--rule);padding-top:34px}
h2{font-size:96px;line-height:1.16;margin:0 0 30px}
.note{font-size:75px;line-height:1.4;color:var(--muted);margin:0 0 36px}
table{width:100%;border-collapse:collapse;font-size:75px;line-height:1.28}
th{font-size:60px;color:var(--muted);text-align:left;padding:20px 0;border-bottom:4px solid var(--rule)}
th:last-child,td:last-child{text-align:right}
td{padding:26px 0;border-bottom:1px solid #c8c6be}
td:last-child{font-weight:900;color:var(--blue)}
.negative td:last-child{background:var(--yellow);color:var(--ink);padding-right:8px}
.limits{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.limit{min-height:255px;background:#e5e4df;border-top:6px solid var(--blue);padding:34px}
.limit strong{display:block;font-size:76px;color:var(--blue);line-height:1.1;white-space:nowrap}
.limit b{display:block;margin:18px 0 10px;font-size:72px;line-height:1.22}
.limit p{margin:0;font-size:75px;line-height:1.34;color:var(--muted)}
.plain{margin:40px 0 0;padding:34px 0;border-top:1px solid #aaa;font-size:75px;line-height:1.42}
.footer{border-top:1px solid #aaa;padding-top:24px;display:flex;justify-content:space-between;gap:40px;color:var(--muted);font-size:46px;line-height:1.35}
@media print{html,body{background:white}.stage{transform:none}}
</style>
</head>
<body>
<main class="stage"><article class="card" id="card">
  <header class="header">
    <div>
      <p class="eyebrow">X RECOMMENDATION SYSTEM</p>
      <h1>X 算法更新：真正影响你的部分</h1>
      <p class="subtitle" data-core-text>权重乘在算法预测的行为概率上，不是做一次操作就直接增减流量。</p>
    </div>
    <div class="system" aria-label="推荐链路">
      <div><strong>预测</strong><span data-core-text>估计用户可能做什么</span></div>
      <div><strong>排序</strong><span data-core-text>用权重计算推荐分</span></div>
      <div><strong>过滤</strong><span data-core-text>高分也可能不展示</span></div>
    </div>
  </header>
  <div class="single-rule" aria-hidden="true"></div>
  <section class="takeaway" data-core-text>互关作者的原创帖会提高“回复”预测项；回复帖和转帖没有这项额外加成。</section>
  <div class="content">
    <section class="section">
      <h2>公开的主要默认权重</h2>
      <p class="note" data-core-text>数值用于合成预测分，不等于一次真实互动会换来同等流量。</p>
      <table>
        <thead><tr><th>预测行为</th><th>权重</th></tr></thead>
        <tbody>
          <tr><td data-core-text>复制链接分享</td><td>+20</td></tr>
          <tr><td data-core-text>互关原创帖：回复预测</td><td>5 + 15</td></tr>
          <tr class="negative"><td data-core-text>举报</td><td>−234</td></tr>
          <tr class="negative"><td data-core-text>不感兴趣</td><td>−43.2</td></tr>
        </tbody>
      </table>
    </section>
    <section class="section">
      <h2>排序后仍会被限制</h2>
      <div class="limits">
        <div class="limit"><strong>×0.75</strong><b data-core-text>未关注内容折扣</b><p data-core-text>未关注内容通常再乘 0.75。</p></div>
        <div class="limit"><strong>最低 25%</strong><b data-core-text>作者多样性</b><p data-core-text>同一作者连续出现会逐步衰减。</p></div>
        <div class="limit"><strong>≈ 第 16 位</strong><b data-core-text>低曝光原创扶持</b><p data-core-text>部分原创帖会被抬到目标位置附近。</p></div>
        <div class="limit"><strong>48 小时</strong><b data-core-text>帖子年龄上限</b><p data-core-text>超龄候选会在打分前过滤。</p></div>
      </div>
    </section>
  </div>
  <footer class="footer"><span>来源：xai-org/x-algorithm · main@a389166</span><span>轻量单文件 HTML 路线检查</span></footer>
</article></main>
<script>
(() => {
  const width = 1800;
  const height = 3950;
  const update = () => {
    const capture = new URLSearchParams(location.search).get("capture") === "1";
    const scale = capture ? 1 : Math.min(1, innerWidth / width);
    document.documentElement.style.setProperty("--scale", String(scale));
    document.body.style.width = capture ? width + "px" : "100%";
    document.body.style.height = height * scale + "px";
    document.documentElement.dataset.previewScale = String(scale);
  };
  addEventListener("resize", update);
  update();
})();
</script>
</body>
</html>`;

async function main() {
  fs.mkdirSync(testRoot, { recursive: true });
  const htmlPath = path.join(testRoot, "index.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  assert(fs.readdirSync(testRoot).filter((name) => name.endsWith(".html")).length === 1, "轻量路线不止一份 HTML");
  assert(!/(?:src|href)=["']https?:/iu.test(html), "轻量 HTML 仍依赖外部资源");
  assert(!/editable-media\.json|MediaFlow Pro|window\.editableMedia/iu.test(html), "轻量 HTML 混入重型媒体工程");

  const playwright = loadPlaywright();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
    || (process.platform === "win32" && fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined);
  const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const sourcePage = await browser.newPage({ viewport: { width: 1800, height: 3950 }, deviceScaleFactor: 1 });
    await sourcePage.goto(`${pathToFileURL(htmlPath).href}?capture=1`, { waitUntil: "load" });
    const sourceBox = await sourcePage.locator("#card").boundingBox();
    assert(Math.round(sourceBox.width) === 1800 && Math.round(sourceBox.height) === 3950, "源画布尺寸不正确");
    const layout = await sourcePage.evaluate(() => {
      const card = document.querySelector("#card");
      const content = document.querySelector(".content").getBoundingClientRect();
      const footer = document.querySelector(".footer").getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const coreBottom = Math.max(...[...document.querySelectorAll("[data-core-text]")].map((node) => node.getBoundingClientRect().bottom));
      const deepestCore = [...document.querySelectorAll("[data-core-text]")]
        .map((node) => ({ text: node.textContent.trim(), ...node.getBoundingClientRect().toJSON() }))
        .sort((left, right) => right.bottom - left.bottom)
        .slice(0, 5);
      return {
        scrollHeight: card.scrollHeight,
        clientHeight: card.clientHeight,
        contentBottom: content.bottom,
        footerTop: footer.top,
        cardBottom: cardBox.bottom,
        coreBottom,
        deepestCore,
      };
    });
    assert(layout.scrollHeight <= layout.clientHeight + 1, `源画布仍有被隐藏的纵向溢出：${JSON.stringify(layout)}`);
    assert(layout.contentBottom <= layout.footerTop - 20, `正文与页脚仍然重叠：${JSON.stringify(layout)}`);
    assert(layout.coreBottom <= layout.footerTop - 20, `核心文字仍然碰到页脚：${JSON.stringify(layout)}`);
    assert(layout.footerTop < layout.cardBottom, "页脚已经跑出画布");
    const sourceScreenshot = path.join(testRoot, "source-1800.png");
    await sourcePage.locator("#card").screenshot({ path: sourceScreenshot });

    const mobilePage = await browser.newPage({ viewport: { width: 360, height: 900 }, deviceScaleFactor: 1 });
    await mobilePage.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    const metrics = await mobilePage.evaluate(() => {
      const scale = Number(document.documentElement.dataset.previewScale);
      return [...document.querySelectorAll("[data-core-text]")].map((node) => ({
        text: node.textContent.trim(),
        displayedPx: Number.parseFloat(getComputedStyle(node).fontSize) * scale,
      }));
    });
    const minimum = Math.min(...metrics.map((item) => item.displayedPx));
    assert(minimum >= 14, `360px 展示下核心文字只有 ${minimum.toFixed(2)}px`);
    const mobileScreenshot = path.join(testRoot, "preview-360.png");
    await mobilePage.screenshot({ path: mobileScreenshot, fullPage: true });

    const report = {
      protocol: "visual-multimedia-lightweight-card-check",
      version: 1,
      status: "passed",
      source_html: htmlPath,
      source_canvas: { width: 1800, height: 3950 },
      actual_display_width: 360,
      preview_scale: 0.2,
      minimum_core_text_px: minimum,
      html_files: 1,
      external_resources: 0,
      heavyweight_outputs: 0,
      screenshots: [sourceScreenshot, mobileScreenshot],
    };
    const reportPath = path.join(testRoot, "report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
