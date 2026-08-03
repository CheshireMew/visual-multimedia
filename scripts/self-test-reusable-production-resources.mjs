#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateMediaProjectState } from "./validate-media-project-state.mjs";
import {createProjectState, refreshProjectState} from "./media_project_state.mjs";
import { validateMediaSources } from "./validate-media-sources.mjs";
import {
  validateMediaResourceAdoptions,
  validateResourcePromotionCandidates,
} from "./media-resource-library.mjs";
import { validateSoundProductionProfile } from "./sound-production-profile.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(SCRIPT_DIR);
const defaultRoot = process.platform === "win32" && fs.existsSync("D:\\Tools")
  ? "D:\\Tools\\visual-multimedia-tests"
  : os.tmpdir();
const runRoot = path.join(
  path.resolve(process.env.VISUAL_MULTIMEDIA_TEST_ROOT || defaultRoot),
  "reusable-production-resources",
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
);
const registryRoot = path.join(runRoot, "registry");
const projectRoot = path.join(runRoot, "project");
const creatorV1 = path.join(runRoot, "creator-v1");
const creatorV11 = path.join(runRoot, "creator-v1.1");
const productionV1 = path.join(runRoot, "production-v1");
const componentsV1 = path.join(runRoot, "components-v1");
const resourceCli = path.join(SCRIPT_DIR, "media-resource-library.mjs");
const soundCli = path.join(SCRIPT_DIR, "sound-production-profile.mjs");
const editableValidator = path.join(SCRIPT_DIR, "validate-editable-media.mjs");

function run(script, args, label) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: SKILL_ROOT,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label}失败：${(result.stderr || result.stdout || "").trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { stdout: result.stdout };
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceFile(caseRoot, sourceId) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(caseRoot, "media-sources.json"), "utf8"),
  );
  const source = manifest.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error(`案例素材账本缺少 ${sourceId}`);
  return path.resolve(caseRoot, source.file);
}

function main() {
  fs.mkdirSync(projectRoot, { recursive: true });
  writeJson(path.join(projectRoot, "media-sources.json"), {
    protocol: "visual-multimedia-media-sources",
    version: 3,
    sources: [],
  });
  const statePath = path.join(projectRoot, "media-project-state.json");
  const state = createProjectState({
    projectId: "reusable-production-selfcheck",
    mediaKind: "video",
    timestamp: "2026-07-30T00:00:00.000Z",
  });
  writeJson(statePath, state);

  run(resourceCli, ["init-registry", "--registry", registryRoot], "建立注册表");
  run(resourceCli, [
    "init-library",
    "--library", creatorV1,
    "--id", "shared-creator-media",
    "--version", "1.0.0",
    "--kind", "creator-media",
    "--name", "Self-check creator media",
  ], "建立创作者媒体库");
  run(resourceCli, [
    "add-file",
    "--library", creatorV1,
    "--input", path.join(SKILL_ROOT, "assets", "creator-identity", "cheshire-avatar.png"),
    "--item-id", "creator-portrait",
    "--name", "Creator portrait",
    "--media-type", "photo",
    "--role", "已确认创作者画面素材",
    "--rights-status", "confirmed",
    "--license", "project-owned",
    "--method", "project-owned",
    "--source-url", "https://example.invalid/self-check/creator-portrait",
    "--provider", "self-check-fixture",
    "--captured-at", "2026-07-30T00:00:00.000Z",
    "--tag", "creator",
    "--tag", "portrait",
  ], "创作者媒体入库");
  run(resourceCli, [
    "register",
    "--registry", registryRoot,
    "--library", creatorV1,
  ], "注册创作者媒体库");
  const creatorSearch = run(resourceCli, [
    "search",
    "--registry", registryRoot,
    "--kind", "creator-media",
    "--query", "portrait",
    "--tag", "creator",
  ], "检索创作者媒体");
  if (
    creatorSearch.result_count !== 1
    || creatorSearch.results[0]?.item_id !== "creator-portrait"
  ) {
    throw new Error("注册资源检索没有返回唯一的创作者媒体");
  }
  const creatorAdoption = run(resourceCli, [
    "adopt",
    "--registry", registryRoot,
    "--library-id", "shared-creator-media",
    "--version", "1.0.0",
    "--item-id", "creator-portrait",
    "--project", projectRoot,
    "--source-id", "creator-shot",
  ], "采用创作者媒体");
  if (
    creatorAdoption.adoption?.consumer !== "media-sources"
    || creatorAdoption.adoption?.media_source_id !== "creator-shot"
  ) {
    throw new Error("创作者媒体没有经过现有导入器到达 media-sources");
  }

  const mediaCase = path.join(SKILL_ROOT, "assets", "media-delivery-case");
  run(resourceCli, [
    "init-library",
    "--library", productionV1,
    "--id", "shared-production-assets",
    "--version", "1.0.0",
    "--kind", "production-assets",
    "--name", "Self-check production assets",
  ], "建立通用制作素材库");
  run(resourceCli, [
    "add-file",
    "--library", productionV1,
    "--input", sourceFile(mediaCase, "case-narration"),
    "--item-id", "voice-anchor",
    "--name", "Voice anchor",
    "--media-type", "audio",
    "--role", "声音档案真实音频锚点",
    "--rights-status", "confirmed",
    "--license", "project-owned",
    "--method", "project-owned",
    "--tag", "voice",
  ], "声音素材入库");
  run(resourceCli, [
    "register",
    "--registry", registryRoot,
    "--library", productionV1,
  ], "注册通用制作素材库");
  const productionSearch = run(resourceCli, [
    "search",
    "--registry", registryRoot,
    "--kind", "production-assets",
    "--query", "voice",
    "--tag", "voice",
  ], "检索通用声音素材");
  if (
    productionSearch.result_count !== 1
    || productionSearch.results[0]?.item_id !== "voice-anchor"
  ) {
    throw new Error("注册资源检索没有返回唯一的声音素材");
  }
  run(resourceCli, [
    "adopt",
    "--registry", registryRoot,
    "--library-id", "shared-production-assets",
    "--version", "1.0.0",
    "--item-id", "voice-anchor",
    "--project", projectRoot,
    "--source-id", "series-voice-anchor",
  ], "采用声音素材");

  run(soundCli, [
    "create",
    "--project", projectRoot,
    "--profile-id", "series-sound",
    "--name", "Series sound",
    "--scope", "series",
  ], "建立独立声音档案");
  run(soundCli, [
    "add-cue",
    "--project", projectRoot,
    "--cue-id", "voice",
    "--source-id", "series-voice-anchor",
    "--role", "voice-anchor",
    "--usage", "需要验证系列人声质感和混音优先级时采用",
    "--gain-db", "0",
    "--loop", "false",
    "--tag", "series",
  ], "声音档案采用音频");
  run(soundCli, [
    "set-ducking",
    "--project", projectRoot,
    "--enabled", "true",
    "--trigger-role", "voice-anchor",
    "--target-role", "music",
    "--reduction-db", "8",
    "--attack-ms", "80",
    "--release-ms", "260",
  ], "写入声音混音规则");
  run(soundCli, [
    "link-motion",
    "--project", projectRoot,
    "--cue-id", "voice",
    "--semantic-event", "explanation-start",
    "--offset-ms", "0",
    "--policy", "at-state-change",
  ], "绑定声音与语义事件");

  run(resourceCli, [
    "propose",
    "--project", projectRoot,
    "--candidate-id", "confirmed-creator-shot",
    "--target-kind", "creator-media",
    "--scope", "series",
    "--target-library-id", "shared-creator-media",
    "--target-item-id", "confirmed-creator-shot",
    "--rationale", "当前项目已经真实采用并验证，可作为系列候选素材。",
    "--source-id", "creator-shot",
    "--evidence", "media-resource-adoptions.json",
  ], "提出项目成果晋升候选");
  run(resourceCli, [
    "init-library",
    "--library", creatorV11,
    "--id", "shared-creator-media",
    "--version", "1.1.0",
    "--kind", "creator-media",
    "--name", "Self-check creator media",
  ], "建立下一不可变版本草稿");
  const promotion = run(resourceCli, [
    "promote-file",
    "--project", projectRoot,
    "--candidate-id", "confirmed-creator-shot",
    "--library", creatorV11,
    "--registry", registryRoot,
    "--name", "Confirmed creator shot",
    "--role", "经过项目真实采用验证的系列创作者素材",
    "--tag", "confirmed",
  ], "从项目唯一素材账本晋升资源");
  if (
    promotion.candidate?.status !== "accepted"
    || !promotion.registration?.entry?.package_sha256
    || !promotion.candidate.decision?.published_target?.endsWith(
      `#sha256=${promotion.registration.entry.package_sha256}`,
    )
  ) {
    throw new Error("文件晋升没有和不可变注册形成同一次发布");
  }
  const promotedSearch = run(resourceCli, [
    "search",
    "--registry", registryRoot,
    "--kind", "creator-media",
    "--tag", "confirmed",
  ], "检索刚晋升的不可变资源");
  if (
    promotedSearch.result_count !== 1
    || promotedSearch.results[0]?.library_version !== "1.1.0"
    || promotedSearch.results[0]?.item_id !== "confirmed-creator-shot"
  ) {
    throw new Error("晋升结果没有到达可检索的不可变注册表");
  }

  run(resourceCli, [
    "init-library",
    "--library", componentsV1,
    "--id", "shared-web-components",
    "--version", "1.0.0",
    "--kind", "web-components",
    "--name", "Self-check web components",
  ], "建立网页组件库");
  run(resourceCli, [
    "add-component",
    "--library", componentsV1,
    "--package", path.join(SKILL_ROOT, "assets", "web-media-starter"),
    "--item-id", "editable-card",
    "--name", "Editable card",
    "--role", "复杂动效和镜头合同的完整网页真源",
    "--tag", "editable-media",
  ], "完整网页包入库");
  run(resourceCli, [
    "register",
    "--registry", registryRoot,
    "--library", componentsV1,
  ], "注册网页组件库");
  const componentSearch = run(resourceCli, [
    "search",
    "--registry", registryRoot,
    "--kind", "web-components",
    "--tag", "editable-media",
  ], "检索完整网页组件");
  if (
    componentSearch.result_count !== 1
    || componentSearch.results[0]?.item_id !== "editable-card"
  ) {
    throw new Error("注册资源检索没有返回完整 editable-media 包");
  }
  const componentAdoption = run(resourceCli, [
    "adopt",
    "--registry", registryRoot,
    "--library-id", "shared-web-components",
    "--version", "1.0.0",
    "--item-id", "editable-card",
    "--project", projectRoot,
  ], "采用完整网页包");
  if (
    componentAdoption.adoption?.consumer !== "editable-media"
    || !componentAdoption.adoption?.package
  ) {
    throw new Error("网页组件没有到达 editable-media 消费边界");
  }
  run(editableValidator, [
    path.join(projectRoot, ...componentAdoption.adoption.package.split("/")),
  ], "项目消费者读取采用后的网页包");

  state.contracts.resource_adoptions = "media-resource-adoptions.json";
  state.contracts.sound_profile = "sound-profile.json";
  state.contracts.promotion_candidates = "resource-promotion-candidates.json";
  refreshProjectState(state, "2026-07-30T00:01:00.000Z");
  writeJson(statePath, state);

  const sourceValidation = validateMediaSources(
    path.join(projectRoot, "media-sources.json"),
  );
  const adoptionValidation = validateMediaResourceAdoptions(
    path.join(projectRoot, "media-resource-adoptions.json"),
    {
      projectId: state.project_id,
      mediaSourcesPath: path.join(projectRoot, "media-sources.json"),
    },
  );
  const soundValidation = validateSoundProductionProfile(
    path.join(projectRoot, "sound-profile.json"),
    {
      projectId: state.project_id,
      mediaSourcesPath: path.join(projectRoot, "media-sources.json"),
    },
  );
  const promotionValidation = validateResourcePromotionCandidates(
    path.join(projectRoot, "resource-promotion-candidates.json"),
    { projectId: state.project_id },
  );
  const stateValidation = validateMediaProjectState(statePath);
  for (const [label, validation] of [
    ["media-sources", sourceValidation],
    ["adoptions", adoptionValidation],
    ["sound-profile", soundValidation],
    ["promotion-candidates", promotionValidation],
    ["media-project-state", stateValidation],
  ]) {
    if (!validation.ok) {
      throw new Error(`${label} 最终验证失败：\n- ${validation.errors.join("\n- ")}`);
    }
  }
  const adoptedSources = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "media-sources.json"), "utf8"),
  ).sources;
  if (
    !adoptedSources.some((source) => source.id === "creator-shot")
    || !adoptedSources.some((source) => source.id === "series-voice-anchor")
  ) {
    throw new Error("最终消费者没有读取到注册资源的真实 source id");
  }
  const creatorSource = adoptedSources.find((source) => source.id === "creator-shot");
  if (
    creatorSource.acquisition?.method !== "project-owned"
    || creatorSource.acquisition?.source_url
      !== "https://example.invalid/self-check/creator-portrait"
    || creatorSource.acquisition?.captured_at !== "2026-07-30T00:00:00.000Z"
    || creatorSource.provenance_runs?.at(-1)?.provider !== "self-check-fixture"
  ) {
    throw new Error("注册素材采用后没有保留原始采集来源");
  }
  console.log(JSON.stringify({
    passed: true,
    run_root: runRoot,
    registry: path.join(registryRoot, "registry.json"),
    project_state: statePath,
    adopted_source_ids: adoptedSources.map((source) => source.id),
    adopted_component: componentAdoption.adoption.package,
    sound_profile: path.join(projectRoot, "sound-profile.json"),
    promotion_candidates: path.join(projectRoot, "resource-promotion-candidates.json"),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
