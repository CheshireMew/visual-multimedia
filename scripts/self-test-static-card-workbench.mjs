#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const workbench = path.join(scriptDir, "static-card-workbench.mjs");
const baseTemplate = path.join(skillRoot, "assets", "static-card-workbench", "base.html");
const testBase = path.join(skillRoot, "artifacts", "self-tests", "static-card-workbench");
const runRoot = path.join(testBase, `run-${Date.now()}-${process.pid}`);
const unrelatedCwd = path.join(runRoot, "unrelated-cwd");

fs.mkdirSync(unrelatedCwd, {recursive: true});

function run(args) {
  const result = spawnSync(process.execPath, [workbench, ...args], {
    cwd: unrelatedCwd,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`命令失败：${args.join(" ")}\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return JSON.parse(result.stdout);
}

function runExpectFailure(args, expected) {
  const result = spawnSync(process.execPath, [workbench, ...args], {
    cwd: unrelatedCwd,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  if (result.status === 0 || !`${result.stdout || ""}\n${result.stderr || ""}`.includes(expected)) {
    throw new Error(`命令没有按预期失败：${args.join(" ")}\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
}

const base = fs.readFileSync(baseTemplate, "utf8");
const forbiddenBaseTokens = [
  "--paper", "--accent", "--ink", ".masthead", ".badge", ".callout",
  ".panel", ".metric", ".table", ".bar-list", ".flow", ".footer",
  "linear-gradient", "box-shadow",
];
const foundForbidden = forbiddenBaseTokens.filter((token) => base.includes(token));
if (foundForbidden.length) {
  throw new Error(`空白底座仍携带视觉选择：${foundForbidden.join(", ")}`);
}

const fixtures = [
  {
    name: "light-fixture",
    style: `
      #card { background: #fff7e8; color: #16231f; font-family: "Microsoft YaHei", sans-serif; }
      #card-content { padding: 110px; display: grid; align-content: space-between; }
      .tag { font-size: 44px; font-weight: 800; letter-spacing: .08em; }
      h1 { margin: 0; max-width: 820px; font-size: 104px; line-height: 1.04; }
      p { margin: 0; max-width: 800px; font-size: 54px; line-height: 1.48; }
      .mark { position: absolute; right: 80px; top: 70px; width: 170px; height: 170px; border-radius: 50%; background: #ff6c45; }
    `,
    content: `
      <main id="card-content">
        <div class="mark" aria-hidden="true"></div>
        <div class="tag" data-primary="true">TECHNICAL FIXTURE</div>
        <h1 data-primary="true">预测概率，再参与排序</h1>
        <p data-primary="true">这张测试稿只证明空白画布能够承载显式设计，不代表推荐风格。</p>
      </main>
    `,
  },
  {
    name: "dark-fixture",
    style: `
      #card { background: #111526; color: #f5f7ff; font-family: Georgia, "Microsoft YaHei", serif; }
      #card-content { padding: 96px; display: flex; flex-direction: column; justify-content: center; gap: 72px; }
      .rule { width: 100%; height: 22px; background: #70e1c8; transform: rotate(-4deg); }
      h1 { margin: 0; font-size: 112px; line-height: 1.03; font-weight: 700; }
      p { margin: 0; font-size: 52px; line-height: 1.5; color: #cbd4ff; }
      small { font-size: 44px; letter-spacing: .12em; color: #70e1c8; }
    `,
    content: `
      <main id="card-content">
        <small data-primary="true">OBJECTIVE CAPABILITY CHECK</small>
        <div class="rule" aria-hidden="true"></div>
        <h1 data-primary="true">同一底座，不同结果</h1>
        <p data-primary="true">样式由当前任务明确写入；工具不再偷偷选择所谓中性风格。</p>
      </main>
    `,
  },
];

const results = [];
for (const fixture of fixtures) {
  const projectRoot = path.join(runRoot, fixture.name);
  const previewRoot = path.join(projectRoot, "previews");
  const htmlPath = path.join(projectRoot, "index.html");
  fs.mkdirSync(previewRoot, {recursive: true});

  const created = run([
    "create",
    "--output", htmlPath,
    "--width", "1080",
    "--height", "1350",
    "--display-width", "360",
  ]);
  if (created.style_source !== null) throw new Error("空白画布意外自动采用了样式");

  let html = fs.readFileSync(htmlPath, "utf8");
  html = html
    .replace("</style>\n  \n</head>", `</style>\n  <style data-test-fixture>${fixture.style}</style>\n</head>`)
    .replace(/<main id="card-content" data-placeholder="true">[\s\S]*?<\/main>/, fixture.content.trim());
  fs.writeFileSync(htmlPath, html, "utf8");

  const report = run([
    "capture",
    "--input", htmlPath,
    "--output-dir", previewRoot,
  ]);
  if (report.placeholders !== 0 || report.overflow.length !== 0) {
    throw new Error(`${fixture.name} 仍有占位内容或越界元素`);
  }
  if (Number(report.minimum_display_primary_text_px) < 14) {
    throw new Error(`${fixture.name} 没有守住实际显示 14px 下限`);
  }
  for (const preview of ["full.png", "display-360.png"]) {
    const filePath = path.join(previewRoot, preview);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) {
      throw new Error(`缺少有效预览：${filePath}`);
    }
  }
  const projectFiles = fs.readdirSync(projectRoot).sort();
  if (projectFiles.join(",") !== "index.html,previews") {
    throw new Error(`${fixture.name} 出现额外项目文件：${projectFiles.join(", ")}`);
  }
  results.push({name: fixture.name, previews: report.previews, minimum_text_px: report.minimum_display_primary_text_px});
}

runExpectFailure([
  "create",
  "--output", path.join(skillRoot, "outside-task-output.html"),
  "--width", "1080",
  "--height", "1350",
], "必须位于");

if (fs.readdirSync(unrelatedCwd).length !== 0) {
  throw new Error("工作台向无关当前目录写入了文件");
}

console.log(JSON.stringify({
  ok: true,
  run_root: runRoot,
  blank_base: true,
  unrelated_cwd_clean: true,
  external_production_path_rejected: true,
  fixtures: results,
}, null, 2));
