#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {listenOnBrowserSafePort} from "./browser-safe-server.mjs";
import {loadLocalMediaEnvironment, mediaFlowProExecute} from "./local-media-environment.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const require = createRequire(import.meta.url);
const runRoot = path.join(
  SKILL_ROOT,
  "artifacts",
  `etc-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
);
const sourcePath = path.join(runRoot, "confirmed-title.md");
const draftPath = path.join(runRoot, "direction-draft.json");
const planPath = path.join(runRoot, "video-direction-plan.json");
const titleData = {
  title_line_1: "ChatCut 功能实测",
  title_line_2: "Agent 与时间线",
  subtitle: "可编辑、可验证、可人工接管",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function binding(projectRoot, filePath) {
  return {
    file: path.relative(projectRoot, filePath).split(path.sep).join("/"),
    sha256: sha256File(filePath),
    bytes: fs.statSync(filePath).size,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: SKILL_ROOT,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label}失败：\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  const output = (result.stdout || "").trim();
  return output ? JSON.parse(output) : null;
}

function loadPlaywright() {
  const candidates = [process.cwd(), SCRIPT_DIR, ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [])];
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", {paths: [candidate]}));
    } catch {
      // Try the next configured runtime.
    }
  }
  throw new Error("标题卡 self-test 找不到 Playwright");
}

function startServer(root) {
  const resolvedRoot = path.resolve(root);
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
    let target = path.resolve(resolvedRoot, ...pathname.split("/").filter(Boolean));
    const relative = path.relative(resolvedRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    if (fs.statSync(target, {throwIfNoEntry: false})?.isDirectory()) target = path.join(target, "index.html");
    if (!fs.statSync(target, {throwIfNoEntry: false})?.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
    };
    response.writeHead(200, {
      "content-type": types[path.extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(target).pipe(response);
  });
  return listenOnBrowserSafePort(server).then((port) => ({server, port}));
}

function createDirectionPlan() {
  fs.mkdirSync(runRoot, {recursive: true});
  fs.writeFileSync(
    sourcePath,
    `# 已确认标题卡文字\n\n${titleData.title_line_1}\n${titleData.title_line_2}\n${titleData.subtitle}\n`,
    "utf8",
  );
  writeJson(path.join(runRoot, "media-sources.json"), {
    protocol: "visual-multimedia-media-sources",
    version: 4,
    sources: [],
  });
  writeJson(draftPath, {
    media_project_id: "editorial-title-card-case",
    source_id: "editorial-title-card-request",
    source_version: "v1",
    content_unit_id: "opening-title",
    media_script_version: "v1-confirmed",
    content_brief: {
      audience: "需要判断 ChatCut 与可编辑视频制作边界的创作者",
      promise: "快速看懂当前视频将实测什么，以及为什么仍能继续人工调整",
      core_claim: "视频实测同时覆盖 Agent 制作和可编辑时间线。",
      supporting_points: [
        {
          id: "editable-handoff",
          text: titleData.subtitle,
          source_refs: ["editorial-title-card-request@v1#title"],
        },
      ],
      required_facts: [],
      risk_flags: [],
    },
    narration: {
      status: "confirmed",
      text: `${titleData.title_line_1}，${titleData.title_line_2}：${titleData.subtitle}。`,
      source_refs: ["editorial-title-card-request@v1#title"],
      major_editorial_changes: [],
    },
    pronunciations: [],
    presenter: {
      mode: "none",
      source_id: null,
      approval: {
        status: "approved",
        confirmed_at: "2026-08-23T00:00:00.000Z",
        evidence: "已确认使用无人物全屏开场标题卡",
      },
    },
    authoring_groups: [
      {
        id: "opening-title-group",
        segment_ids: ["opening-title"],
        continuity_reason: "两行主标题与副标题共同承担一个完整开场承诺。",
      },
    ],
    scenes: [
      {
        segment_id: "opening-title",
        source_refs: ["editorial-title-card-request@v1#title"],
        purpose: "建立视频开场与观看承诺",
        voiceover_ref: "narration#full",
        required_readable_result: `${titleData.title_line_1}、${titleData.title_line_2}和${titleData.subtitle}完整可读。`,
        creative_proposal: {
          visual_idea: "两行标题先后进入，同一画面中的副标题随后补充可编辑承诺。",
          composition: "主标题占据左侧主要视觉重量，副标题在下方保持更轻层级。",
          material_route: "native",
          material_integration: "原创文字、画框和强调线直接承担开场，不使用外部模板素材。",
          motion_sequence: {
            preparation: "先建立安静的画框和标题落点。",
            primary_action: "两行主标题依次从遮罩下方上揭。",
            dependent_overlap: "第二行进入后，副标题柔和淡入。",
            settle_and_hold: "全部文字稳定停留，保证阅读。",
            focus: "唯一注意力峰值是第二行标题完成进入。",
          },
          key_states: [
            {id: "quiet-frame", role: "start", description: "画框与标题落点建立。"},
            {id: "titles-enter", role: "change", description: "两行标题按阅读顺序进入。"},
            {id: "opening-readable", role: "result", description: "标题与副标题完整可读。"},
          ],
          seam_in: "从黑场或前导声音进入稳定画框。",
          seam_out: "以完整标题停留交给第一个实测画面。",
          revision_reason: null,
        },
        visual_plan: {
          source_kind: "packaging",
          source_ids: [],
          relationship_kind: null,
          placement_mode: "full-frame",
          aspect_ratio: "16:9",
          selection_reason: "整段只承担视频开场与短观看承诺，适合全屏编辑式标题卡。",
          realization: null,
        },
        timing: {source: "fixed-spec", estimated_seconds: 5},
        generation_job_ids: [],
      },
    ],
  });
  runNode([
    path.join(SCRIPT_DIR, "create-video-direction-plan.mjs"),
    "--project", runRoot,
    "--source", sourcePath,
    "--draft", draftPath,
    "--created-at", "2026-08-23T00:00:00.000Z",
  ], "标题卡导演计划与自动选择");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const realization = plan.scenes[0].visual_plan.realization;
  assert(realization?.kind === "recipe", "标题卡没有形成镜头配方 realization");
  assert(realization.recipe_id === "editorial-title-card", "packaging/full-frame 没有唯一选择原创标题卡");
  assert(realization.style_id === "editorial-solid", "标题卡默认样式不是实色编辑式标题卡");
  assert(realization.variant_id === "landscape", "标题卡没有匹配 16:9 实色变体");
  const selectionPath = path.resolve(runRoot, ...realization.selection.file.split("/"));
  const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
  assert(selection.library_version === "2.1.0", "标题卡 selection 没有绑定当前配方库版本");
  return {
    plan,
    selection,
    selectionPath,
    packageRoot: path.resolve(runRoot, ...selection.package.split("/")),
  };
}

async function browserCheck(packageRoot) {
  const {server, port} = await startServer(SKILL_ROOT);
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}
      : {}),
  });
  const relativePackage = path.relative(SKILL_ROOT, packageRoot).split(path.sep).join("/");
  const samplePath = path.join(runRoot, "editorial-title-card-sample.png");
  try {
    const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
    await page.goto(`http://127.0.0.1:${port}/${relativePackage}/index.html?capture=1`, {waitUntil: "networkidle"});
    await page.waitForFunction(() => window.editableMedia?.ready && window.__hf?.seek);
    await page.evaluate(async (values) => {
      await window.editableMedia.ready;
      const state = window.editableMedia.getState();
      state.scenes["editorial-title"].data = values;
      window.editableMedia.setState(state);
      await window.__hf.seek(0);
    }, titleData);

    const variants = {};
    for (const variantId of [
      "landscape", "portrait", "square",
      "landscape-transparent", "portrait-transparent", "square-transparent",
    ]) {
      variants[variantId] = await page.evaluate(async (id) => {
        window.editableMedia.setVariant(id);
        window.editableMedia.setScene("editorial-title", {timeMs: 3000});
        await window.__hf.seek(3);
        const rect = document.querySelector("#mediaCanvas").getBoundingClientRect();
        const titleRect = document.querySelector("[data-editable-id='title-line-1']").getBoundingClientRect();
        const style = getComputedStyle(document.querySelector("#mediaCanvas"));
        return {
          width: rect.width,
          height: rect.height,
          titleBounds: {
            x: titleRect.x - rect.x,
            y: titleRect.y - rect.y,
            width: titleRect.width,
            height: titleRect.height,
          },
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          titleOne: document.querySelector("[data-editable-data='title_line_1']").textContent,
          titleTwo: document.querySelector("[data-editable-data='title_line_2']").textContent,
          subtitle: document.querySelector("[data-editable-data='subtitle']").textContent,
          motionState: document.querySelector("#mediaCanvas").dataset.motionState,
        };
      }, variantId);
      const observed = variants[variantId];
      assert(observed.titleOne === titleData.title_line_1, `${variantId} 没有保留第一行真实标题`);
      assert(observed.titleTwo === titleData.title_line_2, `${variantId} 没有保留第二行真实标题`);
      assert(observed.subtitle === titleData.subtitle, `${variantId} 没有保留真实副标题`);
      assert(observed.motionState === "readable-result", `${variantId} 没有停在完整可读结果`);
      if (variantId.includes("transparent")) {
        assert(observed.backgroundColor === "rgba(0, 0, 0, 0)", `${variantId} 画布背景不透明`);
        assert(observed.backgroundImage === "none", `${variantId} 仍保留实色背景图层`);
      }
    }

    const states = [];
    for (const milliseconds of [0, 600, 1100, 1900, 3000]) {
      states.push(await page.evaluate(async (timeMs) => {
        window.editableMedia.setVariant("landscape");
        await window.__hf.seek(timeMs / 1000);
        const one = document.querySelector("[data-editable-data='title_line_1']");
        const two = document.querySelector("[data-editable-data='title_line_2']");
        const sub = document.querySelector("[data-editable-data='subtitle']");
        return {
          timeMs,
          motionState: document.querySelector("#mediaCanvas").dataset.motionState,
          one: {opacity: one.style.opacity, transform: one.style.transform, clipPath: one.style.clipPath},
          two: {opacity: two.style.opacity, transform: two.style.transform, clipPath: two.style.clipPath},
          subtitle: {opacity: sub.style.opacity, transform: sub.style.transform},
        };
      }, milliseconds));
    }
    const repeated = await page.evaluate(async () => {
      await window.__hf.seek(3);
      const one = document.querySelector("[data-editable-data='title_line_1']");
      const sub = document.querySelector("[data-editable-data='subtitle']");
      return JSON.stringify({
        one: [one.style.opacity, one.style.transform, one.style.clipPath],
        subtitle: [sub.style.opacity, sub.style.transform],
      });
    });
    const repeatedAgain = await page.evaluate(async () => {
      await window.__hf.seek(3);
      const one = document.querySelector("[data-editable-data='title_line_1']");
      const sub = document.querySelector("[data-editable-data='subtitle']");
      return JSON.stringify({
        one: [one.style.opacity, one.style.transform, one.style.clipPath],
        subtitle: [sub.style.opacity, sub.style.transform],
      });
    });
    assert(repeated === repeatedAgain, "相同时间定位没有得到相同标题动画状态");
    assert(Number(states[0].one.opacity) === 0, "第一帧标题没有位于进入前状态");
    assert(Number(states.at(-1).one.opacity) === 1, "结果态第一行标题未完整显示");
    assert(Number(states.at(-1).two.opacity) === 1, "结果态第二行标题未完整显示");
    assert(Number(states.at(-1).subtitle.opacity) === 1, "结果态副标题未完整显示");
    await page.locator("#mediaCanvas").screenshot({path: samplePath});
    return {variants, states, sample: samplePath};
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function mediaFlowCheck(plan) {
  runNode([
    path.join(SCRIPT_DIR, "review-video-scene-realization.mjs"),
    "--plan", planPath,
    "--segment", "opening-title",
    "--status", "accepted",
    "--summary", "已查看标题进入、完整停留和三种比例；接受当前原创标题卡。",
    "--reviewed-at", "2026-08-23T00:01:00.000Z",
  ], "标题卡实际画面接受记录");
  const speechTimeline = path.join(runRoot, "fixed-title-timeline.json");
  writeJson(speechTimeline, {
    protocol: "visual-multimedia-fixed-title-timeline-case",
    version: 1,
    fps: 30,
    segments: [{segment_id: "opening-title", start_frame: 0, duration_frames: 150}],
  });
  const timingPath = path.join(runRoot, "video-direction-timing-projection.json");
  writeJson(timingPath, {
    protocol: "visual-multimedia-video-direction-timing-projection",
    version: 1,
    direction_plan: binding(runRoot, planPath),
    source_timeline: binding(runRoot, speechTimeline),
    fps: 30,
    segments: [{segment_id: "opening-title", timeline_start_frame: 0, duration_frames: 150}],
  });
  const applied = runNode([
    path.join(SCRIPT_DIR, "explanatory-broll-studio.mjs"),
    "apply-plan",
    "--project", runRoot,
    "--timings", timingPath,
  ], "标题卡进入 MediaFlow Pro 时间线");
  assert(applied.clips.length === 1 && applied.clips[0].duration_frames === 150, "标题卡没有按 5 秒进入时间线");
  const state = applied.state;
  const clip = applied.clips[0];
  const environment = loadLocalMediaEnvironment();
  mediaFlowProExecute(environment, state.editor_project, "project.inspect", {});
  const current = mediaFlowProExecute(environment, state.editor_project, "web.clip.get", {clip_id: clip.clip_id}).web_clip_state;
  mediaFlowProExecute(
    environment,
    state.editor_project,
    "web.clip.data.update",
    {
      sequence_id: state.sequence_id,
      clip_id: clip.clip_id,
      scene_id: clip.scene_id,
      values: titleData,
      source_kind: "inline",
      source_label: "Editorial title card self-test",
    },
    `editorial-title-data-${sha256File(draftPath).slice(0, 16)}-r${current.revision}`,
  );
  const updated = mediaFlowProExecute(environment, state.editor_project, "web.clip.get", {clip_id: clip.clip_id}).web_clip_state;
  const values = updated.scenes?.[clip.scene_id]?.data_snapshot?.values || {};
  for (const [key, value] of Object.entries(titleData)) {
    assert(values[key] === value, `MediaFlow Pro 没有保存标题字段 ${key}`);
  }
  const exported = runNode([
    path.join(SCRIPT_DIR, "explanatory-broll-studio.mjs"),
    "export",
    "--project", runRoot,
    "--selection-id", clip.selection_id,
    "--format", "video",
  ], "MediaFlow Pro 标题卡视频导出");
  assert(fs.statSync(exported.file, {throwIfNoEntry: false})?.isFile(), "MediaFlow Pro 没有生成标题卡视频");
  assert(exported.bytes > 0 && sha256File(exported.file) === exported.sha256, "标题卡视频文件与导出报告不一致");
  return {
    editor_project: state.editor_project,
    sequence_id: state.sequence_id,
    clip_id: clip.clip_id,
    video: exported.file,
    bytes: exported.bytes,
    sha256: exported.sha256,
  };
}

async function main() {
  const direction = createDirectionPlan();
  const browser = await browserCheck(direction.packageRoot);
  const mediaflow = process.argv.includes("--mediaflow") ? mediaFlowCheck(direction.plan) : null;
  console.log(JSON.stringify({
    ok: true,
    run_root: runRoot,
    selection: direction.selectionPath,
    recipe_id: direction.selection.recipe_id,
    style_id: direction.selection.style_id,
    variant_id: direction.selection.variant_id,
    browser,
    mediaflow,
  }, null, 2));
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
