#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {
  confirmGithubProjectIntroPlan,
  createGithubProjectIntro,
  createGithubProjectIntroPlan,
  renderGithubProjectIntro,
  validateGithubProjectIntro,
} from "./github-project-intro.mjs";
import {readJson, sha256File, writeJson} from "./interview_explainer_common.mjs";
import {decideStage, submitStage, validateProjectState} from "./media_project_state.mjs";
import {finalizeStandardVideo, reviewStandardVideo} from "./standard_video_delivery.mjs";
import {sha256Tree} from "./shot-recipe-library.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const ROOT = process.platform === "win32" && fs.existsSync("D:\\Tools")
  ? "D:\\Tools\\visual-multimedia-tests"
  : process.env.TEMP;
const RUN_ROOT = path.join(ROOT, "github-project-intro", `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
const IMPORTER = path.join(SCRIPT_DIR, "import-media-asset.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function copyTree(source, target) {
  fs.mkdirSync(target, {recursive: true});
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function importEvidence(project) {
  const source = path.join(SKILL_ROOT, "assets", "media-delivery-case", "assets", "by-sha256", "25", "255e6243648bbd731aa269c4ac5643e89a818c7ca79b334bec582584c73af91b.png");
  const result = spawnSync(process.execPath, [
    IMPORTER,
    "--project", project,
    "--input", source,
    "--id", "repository-evidence",
    "--media-type", "screenshot",
    "--method", "project-owned",
    "--rights-status", "confirmed",
    "--license", "visual-multimedia self-test fixture",
    "--usage", "验证无图形界面仓库的结果证据可以进入 GitHub 项目介绍链路",
  ], {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true});
  if (result.status !== 0) throw new Error(`导入测试证据失败：\n${result.stdout}\n${result.stderr}`);
}

function approve(project, stageId, artifact) {
  const statePath = path.join(project, "media-project-state.json");
  const state = readJson(statePath);
  submitStage(state, project, stageId, [artifact]);
  decideStage(state, stageId, "approved", `self-test 完整验证 ${stageId} 阶段`, {decidedBy: "user"});
  writeJson(statePath, state);
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`${stageId} 阶段状态失败：${validation.errors.join("；")}`);
}

function approveSubmitted(project, stageId, evidence) {
  const statePath = path.join(project, "media-project-state.json");
  const state = readJson(statePath);
  decideStage(state, stageId, "approved", evidence, {decidedBy: "user"});
  writeJson(statePath, state);
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`${stageId} 阶段批准后状态失败：${validation.errors.join("；")}`);
}

function prepareCase(mode) {
  const project = path.join(RUN_ROOT, mode);
  const created = createGithubProjectIntro({
    project,
    projectId: `github-intro-${mode}`,
    openingVariant: "recently",
    sameDayConfirmed: false,
  });
  importEvidence(project);
  const brief = readJson(created.brief);
  brief.repository = {
    name: mode === "editable-scene" ? "可编辑界面项目" : "无图形界面的命令行项目",
    url: `https://github.com/example/${mode}`,
    audience: "需要快速判断项目价值的开发者",
    interface_kind: mode === "editable-scene" ? "ui" : "cli",
    evidence_source_ids: ["repository-evidence"],
  };
  brief.content = {
    one_core_claim: mode === "editable-scene"
      ? "这个项目把可复现界面变成确定性视频证据。"
      : "这个命令行项目也可以用真实输出证明价值，不需要伪造产品界面。",
    confirmed_facts: ["测试证据已经通过素材导入器进入唯一素材账本。"],
    call_to_action: "查看仓库和实际输出。",
  };
  brief.standards.duration_user_specified = true;
  writeJson(created.brief, brief);
  const draft = readJson(created.draft);
  draft.shots[0].duration_frames = 90;
  draft.shots[0].narration.zh = "最近看到一个有意思的 GitHub 项目。";
  draft.shots[0].narration.en = "Recently I found an interesting GitHub project.";
  if (mode === "editable-scene") {
    const packageRoot = path.join(project, "components", "opening");
    copyTree(path.join(SKILL_ROOT, "assets", "web-media-starter"), packageRoot);
    draft.shots[0].visual = {
      kind: "editable-scene",
      source_id: null,
      package: "components/opening",
      package_sha256: sha256Tree(packageRoot),
      manifest_sha256: sha256File(path.join(packageRoot, "editable-media.json")),
      scene_id: "opening",
    };
  } else {
    draft.shots[0].visual.source_id = "repository-evidence";
  }
  draft.review_promises = [{
    id: "profile-is-github-intro",
    source_pointer: "/profile/id",
    promise: "计划必须使用 GitHub 项目介绍 profile。",
    expected_value: "github-project-intro",
  }];
  writeJson(created.draft, draft);
  validateGithubProjectIntro(project, created.brief, created.draft);
  const planPath = path.join(project, "github-project-intro-plan.json");
  createGithubProjectIntroPlan(project, created.brief, created.draft, planPath);
  const confirmationPath = path.join(project, "github-project-intro-plan-confirmation.json");
  confirmGithubProjectIntroPlan(project, planPath, confirmationPath, "user", "self-test 确认一个核心主张、真实证据、银狼开场与双语字幕");
  approve(project, "content", {id: "github-content", role: "content-contract", kind: "document", file: "github-project-intro-brief.json"});
  approve(project, "direction", {id: "github-direction", role: "direction-package", kind: "document", file: "github-project-intro-plan.json"});
  const sample = path.join(project, "integrated-sample.mp4");
  fs.copyFileSync(path.join(SKILL_ROOT, "assets", "media-delivery-case", "renders", "final.mp4"), sample);
  approve(project, "integrated-sample", {id: "github-sample", role: "integrated-sample", kind: "video", file: "integrated-sample.mp4"});
  return {project, planPath, confirmationPath};
}

function runCase(mode) {
  const prepared = prepareCase(mode);
  const buildPlanFile = path.join(prepared.project, "media-build-plan.json");
  const module = spawnSync(process.execPath, [
    path.join(SCRIPT_DIR, "github-project-intro.mjs"),
    "render",
    "--project", prepared.project,
  ], {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024});
  if (module.status !== 0) throw new Error(`${mode} 真实渲染失败：\n${module.stdout}\n${module.stderr}`);
  const rendered = JSON.parse(module.stdout);
  assert(fs.existsSync(rendered.output), `${mode} 没有生成真实成片`);
  assert(fs.existsSync(buildPlanFile), `${mode} 没有生成通用构建计划`);
  approveSubmitted(prepared.project, "full-preview", `self-test 用户完整观看 ${mode} 全量预览`);
  const review = reviewStandardVideo({
    project: prepared.project,
    profile: "github-project-intro@1.0.0",
    plan: "github-project-intro-plan.json",
    confirmation: "github-project-intro-plan-confirmation.json",
    agentStatus: "passed",
    agentCompleted: true,
    agentEvidence: "self-test 完整播放三秒成片，确认真实画面、银狼开场和中英文字幕均可见可听。",
  });
  assert(review.status === "passed", `${mode} 评审没有通过`);
  const waiting = finalizeStandardVideo({
    project: prepared.project,
    profile: "github-project-intro@1.0.0",
    plan: "github-project-intro-plan.json",
    confirmation: "github-project-intro-plan-confirmation.json",
    audioRequired: true,
    captionsRequired: true,
  });
  assert(waiting.status === "waiting-approval", `${mode} 最终阶段没有等待真实批准`);
  const statePath = path.join(prepared.project, "media-project-state.json");
  const state = readJson(statePath);
  decideStage(state, "final-delivery", "approved", "self-test 用户确认最终交付", {decidedBy: "user"});
  writeJson(statePath, state);
  const complete = finalizeStandardVideo({
    project: prepared.project,
    profile: "github-project-intro@1.0.0",
    plan: "github-project-intro-plan.json",
    confirmation: "github-project-intro-plan-confirmation.json",
    audioRequired: true,
    captionsRequired: true,
  });
  assert(complete.status === "complete", `${mode} 没有完成最终交付`);
  const second = spawnSync(process.execPath, [
    path.join(SCRIPT_DIR, "github-project-intro.mjs"), "render", "--project", prepared.project,
  ], {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024});
  if (second.status !== 0) throw new Error(`${mode} 缓存复用渲染失败：${second.stderr || second.stdout}`);
  assert(JSON.parse(second.stdout).status === "reused", `${mode} 第二次渲染没有复用成片`);
  return {mode, project: prepared.project, output: complete.output, operation_report: path.join(prepared.project, "reports", "github-project-intro-render-run.json")};
}

function main() {
  fs.mkdirSync(RUN_ROOT, {recursive: true});
  const selectedMode = process.env.VISUAL_MULTIMEDIA_GITHUB_INTRO_TEST_MODE || null;
  const modes = selectedMode ? [selectedMode] : ["media-source", "editable-scene"];
  if (modes.some((item) => !new Set(["media-source", "editable-scene"]).has(item))) {
    throw new Error(`未知 GitHub 项目介绍测试模式：${selectedMode}`);
  }
  const cases = modes.map(runCase);
  console.log(JSON.stringify({
    ok: true,
    root: RUN_ROOT,
    cases,
    verified: [
      "注册银狼开场采用",
      "非 GUI 真实 source 证据",
      "editable-media 界面证据",
      "双语字幕烧录",
      "MediaFlow 公开时间线装配",
      "机器审阅、Agent 完整观看和最终批准",
      "逐步耗时记录与第二次缓存复用"
    ],
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
