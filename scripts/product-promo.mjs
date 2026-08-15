#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  nowIso,
  parseArgs,
  projectPath,
  readJson,
  relativeProjectPath,
  requireArg,
  sha256File,
  writeJson,
} from "./interview_explainer_common.mjs";
import {readEditableMediaPackage} from "./editable-media-contract.mjs";
import {
  createMediaBuildPlan,
  fileDependency,
  validateMediaBuildPlan,
} from "./media_build_contract.mjs";
import {renderProductPromo} from "./product_promo_runtime.mjs";
import {
  finalizeStandardVideo,
  reviewStandardVideo,
} from "./standard_video_delivery.mjs";
import {
  loadShotRecipes,
  materializeShotRecipe,
  searchShotRecipes,
  sha256Tree,
} from "./shot-recipe-library.mjs";
import {assertSkillTaskPath} from "./media-task-workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const STARTER_ROOT = path.join(SKILL_ROOT, "assets", "media-project-starter");
const PROFILE_RELATIVE = "assets/video-production-profiles/product-promo/1.0.0/profile.json";
const PROFILE_PATH = path.join(SKILL_ROOT, ...PROFILE_RELATIVE.split("/"));
const PRODUCT_SCHEMA = path.join(SKILL_ROOT, "schemas", "product-promo.v1.schema.json");
const SHOT_SCHEMA = path.join(SKILL_ROOT, "schemas", "shot-recipe.v2.schema.json");
const CAPTURE_SCHEMA = path.join(SKILL_ROOT, "schemas", "product-ui-capture.v1.schema.json");
const BEAT_SCHEMA = path.join(SKILL_ROOT, "schemas", "music-beat-analysis.v1.schema.json");
const PROJECT_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-project-state.v3.schema.json");
const PROFILE = readJson(PROFILE_PATH);

function fileBinding(projectRoot, relative, label, schema = null) {
  const absolute = projectPath(projectRoot, relative, label);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`${label}不存在：${absolute}`);
  const document = schema ? readJson(absolute) : null;
  if (schema) assertJsonSchema(document, schema, label);
  return {file: relative, sha256: sha256File(absolute), document, absolute};
}

function assertBinding(projectRoot, binding, label, schema = null) {
  const actual = fileBinding(projectRoot, binding.file, label, schema);
  if (actual.sha256 !== binding.sha256) throw new Error(`${label}哈希与实际文件不一致：${binding.file}`);
  return actual;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function pointerValue(document, pointer) {
  if (pointer === "") return document;
  return pointer.slice(1).split("/").reduce((current, encoded) => {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current == null || !Object.prototype.hasOwnProperty.call(current, key)) throw new Error(`审阅承诺指向不存在的位置：${pointer}`);
    return current[key];
  }, document);
}

function briefPath(args, projectRoot) {
  return projectPath(projectRoot, args.brief || "product-promo-brief.json", "brief");
}

function planPath(args, projectRoot) {
  return projectPath(projectRoot, args.plan || "product-promo-plan.json", "plan");
}

export function createProductPromoProject(projectRoot, projectId) {
  const project = assertSkillTaskPath(path.resolve(projectRoot || ""), "projectRoot");
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(projectId || "")) throw new Error("--project-id 只能使用小写字母、数字、点、下划线和连字符");
  fs.mkdirSync(project, {recursive: true});
  for (const entry of fs.readdirSync(STARTER_ROOT, {withFileTypes: true})) {
    if (!entry.isFile()) continue;
    const destination = path.join(project, entry.name);
    if (fs.existsSync(destination)) throw new Error(`项目已有 ${entry.name}；不会覆盖现有合同`);
    fs.copyFileSync(path.join(STARTER_ROOT, entry.name), destination, fs.constants.COPYFILE_EXCL);
  }
  const statePath = path.join(project, "media-project-state.json");
  const state = readJson(statePath);
  state.project_id = projectId;
  state.media_kind = "mixed-video";
  state.profile = "product-promo@1.0.0";
  state.next_action = "填写产品主张、功能证据与输出要求，再提交内容阶段。";
  state.updated_at = nowIso();
  writeJson(statePath, state);
  assertJsonSchema(state, PROJECT_SCHEMA, "媒体项目状态");
  const brief = {
    protocol: "visual-multimedia-product-promo-brief",
    version: 1,
    project_id: projectId,
    profile: {id: "product-promo", version: "1.0.0"},
    product: {
      name: "待替换产品名",
      audience: "待确认目标观众",
      value_proposition: "待确认产品主张",
      call_to_action: "",
    },
    features: [{
      id: "feature-1",
      name: "待替换功能",
      viewer_value: "待确认观众价值",
      proof: "待绑定真实页面、录屏或结果证据",
      required: true,
      source_ids: [],
    }],
    style_profile: null,
    output: {
      file: "renders/product-promo-preview.mp4",
      width: 1920,
      height: 1080,
      fps: 30,
      audio_sample_rate: 48000,
      audio_channels: 2,
      caption_strategy: "none",
    },
    sound: {strategy: "none", strong_beat: false, music_source_id: null},
    constraints: ["提交计划前替换全部待确认字段，并为必选功能绑定真实 source id。"],
  };
  const output = path.join(project, "product-promo-brief.json");
  writeJson(output, brief);
  assertJsonSchema(brief, PRODUCT_SCHEMA, "产品宣传片 brief");
  for (const directory of ["captures", "components", "shot-recipe-selections", "plans", "reports", "renders", "working"]) {
    fs.mkdirSync(path.join(project, directory), {recursive: true});
  }
  return {project, state: statePath, brief: output};
}

export function validateProductPromoBrief(projectRoot, filePath) {
  const project = path.resolve(projectRoot);
  const brief = readJson(filePath);
  assertJsonSchema(brief, PRODUCT_SCHEMA, "产品宣传片 brief");
  const state = readJson(path.join(project, "media-project-state.json"));
  assertJsonSchema(state, PROJECT_SCHEMA, "媒体项目状态");
  if (state.project_id !== brief.project_id || state.profile !== "product-promo@1.0.0") throw new Error("brief 与媒体项目状态的 project/profile 不一致");
  const placeholders = JSON.stringify(brief).match(/待替换|待确认|待绑定/gu) || [];
  if (placeholders.length) throw new Error("brief 仍有待替换、待确认或待绑定占位内容");
  const sourceManifest = readJson(path.join(project, "media-sources.json"));
  const sourceIds = new Set((sourceManifest.sources || []).map((source) => source.id));
  const featureIds = new Set();
  for (const feature of brief.features) {
    if (featureIds.has(feature.id)) throw new Error(`brief 功能 id 重复：${feature.id}`);
    featureIds.add(feature.id);
    if (feature.required && !feature.source_ids.length) throw new Error(`必选功能 ${feature.id} 没有绑定真实 source id`);
    for (const sourceId of feature.source_ids) if (!sourceIds.has(sourceId)) throw new Error(`功能 ${feature.id} 引用了不存在的 source id：${sourceId}`);
  }
  if (brief.sound.strategy === "music-and-sfx" && !brief.sound.music_source_id) throw new Error("music-and-sfx 必须绑定 music_source_id");
  if (brief.sound.music_source_id && !sourceIds.has(brief.sound.music_source_id)) throw new Error(`音乐 source id 不存在：${brief.sound.music_source_id}`);
  return brief;
}

export function validateProductPromoPlan(projectRoot, filePath) {
  const project = path.resolve(projectRoot);
  const plan = readJson(filePath);
  assertJsonSchema(plan, PRODUCT_SCHEMA, "产品宣传片计划");
  if (plan.profile.sha256 !== sha256File(PROFILE_PATH)) throw new Error("计划绑定的 product-promo profile 哈希已失效");
  const briefBinding = assertBinding(project, plan.brief, "brief", PRODUCT_SCHEMA);
  const brief = validateProductPromoBrief(project, briefBinding.absolute);
  if (brief.project_id !== plan.project_id || JSON.stringify(brief.output) !== JSON.stringify(plan.output)) throw new Error("计划与 brief 的 project/output 不一致");
  const mediaSources = readJson(path.join(project, "media-sources.json"));
  const sourcesById = new Map(mediaSources.sources.map((source) => [source.id, source]));
  for (const frame of plan.direction.style_frames) assertBinding(project, frame, "style frame");
  const capturedSourceIds = new Set();
  for (const reportBinding of plan.capture_reports) {
    const report = assertBinding(project, reportBinding, "产品页面采集报告", CAPTURE_SCHEMA).document;
    if (report.project_id !== plan.project_id) throw new Error("采集报告与计划 project_id 不一致");
    const spec = assertBinding(project, report.spec, "产品页面采集规格", CAPTURE_SCHEMA).document;
    if (spec.project_id !== plan.project_id) throw new Error("采集规格与计划 project_id 不一致");
    for (const page of report.pages) for (const asset of page.assets) {
      const source = sourcesById.get(asset.source_id);
      if (!source || source.file !== asset.file || source.integrity?.sha256 !== asset.sha256 || source.integrity?.bytes !== asset.bytes) throw new Error(`采集资产 ${asset.source_id} 与素材账本不一致`);
      const actual = fileBinding(project, asset.file, `采集资产 ${asset.source_id}`);
      if (actual.sha256 !== asset.sha256) throw new Error(`采集资产 ${asset.source_id} 的实际文件哈希已失效`);
      capturedSourceIds.add(asset.source_id);
    }
  }
  if (plan.sound.profile) assertBinding(project, plan.sound.profile, "声音 profile");
  const beat = plan.sound.beat_analysis ? assertBinding(project, plan.sound.beat_analysis, "音乐节拍分析", BEAT_SCHEMA).document : null;
  if (brief.sound.strong_beat && !plan.sound.beat_analysis) throw new Error("brief 要求强节拍，但计划没有节拍分析");
  if (!brief.sound.strong_beat && plan.sound.beat_analysis) throw new Error("brief 未启用强节拍，计划不应绑定节拍分析");
  if (plan.sound.music_source_id !== brief.sound.music_source_id) throw new Error("计划与 brief 的音乐 source id 不一致");
  if (beat) {
    const music = sourcesById.get(plan.sound.music_source_id);
    if (!music || music.file !== beat.source.file || music.integrity?.sha256 !== beat.source.sha256) throw new Error("节拍分析没有绑定计划采用的同一音乐 source 文件与哈希");
    const actualMusic = fileBinding(project, beat.source.file, "节拍分析音乐源");
    if (actualMusic.sha256 !== beat.source.sha256) throw new Error("节拍分析绑定的音乐文件哈希已失效");
    if (beat.review.status === "manual-review") throw new Error("节拍分析仍要求人工复核，不能进入已确认计划");
  }
  const shots = [...plan.shots].sort((left, right) => left.order - right.order);
  const shotIds = new Set();
  let cursor = 0;
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index];
    if (shot.order !== index + 1 || shot.timeline_start_frame !== cursor) throw new Error(`镜头 ${shot.id} 的 order 或帧范围不连续`);
    if (shotIds.has(shot.id)) throw new Error(`镜头 id 重复：${shot.id}`);
    shotIds.add(shot.id);
    cursor += shot.duration_frames;
    const selection = assertBinding(project, shot.selection, `镜头 ${shot.id} 的配方选择`, SHOT_SCHEMA).document;
    const packageRoot = projectPath(project, shot.implementation.package, `镜头 ${shot.id} 包`);
    const editable = readEditableMediaPackage(packageRoot);
    const packageHash = sha256Tree(packageRoot);
    const manifestHash = sha256File(editable.manifestPath);
    if (selection.package !== shot.implementation.package || selection.package_sha256 !== packageHash || selection.manifest_sha256 !== manifestHash) throw new Error(`镜头 ${shot.id} 的 selection 与实际包不一致`);
    if (shot.implementation.package_sha256 !== packageHash || shot.implementation.manifest_sha256 !== manifestHash) throw new Error(`镜头 ${shot.id} 的实现包哈希已失效`);
    const scene = editable.manifest.scenes.find((candidate) => candidate.id === shot.implementation.scene_id);
    if (!scene) throw new Error(`镜头 ${shot.id} 找不到场景 ${shot.implementation.scene_id}`);
    const stepIds = new Set(scene.steps.map((step) => step.id));
    for (const stepId of shot.semantic_steps) if (!stepIds.has(stepId)) throw new Error(`镜头 ${shot.id} 找不到语义状态 ${stepId}`);
  }
  const featureIds = new Set(brief.features.map((feature) => feature.id));
  const coverageIds = new Set();
  for (const coverage of plan.feature_coverage) {
    if (!featureIds.has(coverage.feature_id) || coverageIds.has(coverage.feature_id)) throw new Error(`功能覆盖记录无效或重复：${coverage.feature_id}`);
    coverageIds.add(coverage.feature_id);
    for (const shotId of coverage.shot_ids) if (!shotIds.has(shotId)) throw new Error(`功能 ${coverage.feature_id} 引用了不存在的镜头 ${shotId}`);
  }
  for (const feature of brief.features) if (feature.required && !coverageIds.has(feature.id)) throw new Error(`必选功能 ${feature.id} 没有镜头覆盖`);
  for (const shot of shots) for (const featureId of shot.feature_ids) if (!featureIds.has(featureId)) throw new Error(`镜头 ${shot.id} 引用了不存在的功能 ${featureId}`);
  const allSourceIds = new Set(mediaSources.sources.map((source) => source.id));
  for (const feature of brief.features) for (const sourceId of feature.source_ids) {
    if (!allSourceIds.has(sourceId)) throw new Error(`功能 ${feature.id} 的证据 source 已失效：${sourceId}`);
    const source = sourcesById.get(sourceId);
    if (source?.notes?.includes("capture-product-ui.mjs") && !capturedSourceIds.has(sourceId)) throw new Error(`浏览器采集截图 ${sourceId} 没有出现在计划绑定的采集报告中`);
  }
  const promiseIds = new Set();
  for (const promise of plan.review_promises) {
    if (promiseIds.has(promise.id)) throw new Error(`审阅承诺 id 重复：${promise.id}`);
    promiseIds.add(promise.id);
    const actual = pointerValue(plan, promise.source_pointer);
    if (canonical(actual) !== canonical(promise.expected_value)) throw new Error(`审阅承诺 ${promise.id} 的 expected_value 与计划当前位置不一致`);
  }
  return {plan, brief};
}

export function confirmProductPromoPlan(projectRoot, filePath, outputPath, confirmedBy, evidence) {
  const project = path.resolve(projectRoot);
  const {plan} = validateProductPromoPlan(project, filePath);
  const confirmation = {
    protocol: "visual-multimedia-product-promo-plan-confirmation",
    version: 1,
    project_id: plan.project_id,
    plan: relativeProjectPath(project, filePath),
    plan_sha256: sha256File(filePath),
    confirmed_by: confirmedBy,
    confirmed_at: nowIso(),
    evidence,
  };
  assertJsonSchema(confirmation, PRODUCT_SCHEMA, "产品宣传片计划确认");
  if (fs.existsSync(outputPath)) throw new Error(`确认记录已存在，不会覆盖：${outputPath}`);
  writeJson(outputPath, confirmation);
  return confirmation;
}

export function createProductPromoBuildPlan(projectRoot, planFile, confirmationFile, outputFile, stageTarget = "full-preview") {
  const project = path.resolve(projectRoot);
  const {plan, brief} = validateProductPromoPlan(project, planFile);
  const confirmation = readJson(confirmationFile);
  assertJsonSchema(confirmation, PRODUCT_SCHEMA, "产品宣传片计划确认");
  if (confirmation.project_id !== plan.project_id || confirmation.plan !== relativeProjectPath(project, planFile) || confirmation.plan_sha256 !== sha256File(planFile)) throw new Error("确认记录没有绑定当前项目、计划文件与哈希");
  const quality = stageTarget === "integrated-sample" ? "sample" : stageTarget === "final-delivery" ? "final" : "proxy";
  const {caption_strategy: captionStrategy, ...videoOutput} = brief.output;
  const build = createMediaBuildPlan({
    projectRoot: project,
    producerRoot: SKILL_ROOT,
    projectId: plan.project_id,
    mediaKind: "mixed-video",
    profile: "product-promo@1.0.0",
    stageTarget,
    sourceContract: relativeProjectPath(project, planFile),
    producerEntry: "scripts/product-promo.mjs",
    producerModules: ["scripts/shot-recipe-library.mjs", "scripts/media_build_contract.mjs"],
    output: {...videoOutput, quality_profile: quality},
    units: plan.shots.map((shot) => ({
      id: shot.id,
      order: shot.order,
      kind: "editable-scene",
      source_unit_id: shot.implementation.scene_id,
      timeline_start_frame: shot.timeline_start_frame,
      duration_frames: shot.duration_frames,
      dependencies: [
        fileDependency(project, "shot-selection", shot.selection.file),
        fileDependency(project, "editable-manifest", `${shot.implementation.package}/editable-media.json`),
      ],
    })),
    assembly: {
      strategy: "ordered-concat",
      audio_strategy: brief.sound.strategy === "none" ? "none" : "continuous-master",
      caption_strategy: captionStrategy,
    },
  });
  if (fs.existsSync(outputFile)) throw new Error(`构建计划已存在，不会覆盖：${outputFile}`);
  writeJson(outputFile, build);
  return build;
}

export function loadProductPromoExecutionContext(
  projectRoot,
  planFile,
  confirmationFile,
  buildPlanFile,
  stageTarget = "full-preview",
) {
  const project = path.resolve(projectRoot);
  const {plan, brief} = validateProductPromoPlan(project, planFile);
  const confirmation = readJson(confirmationFile);
  assertJsonSchema(confirmation, PRODUCT_SCHEMA, "产品宣传片计划确认");
  if (
    confirmation.project_id !== plan.project_id
    || confirmation.plan !== relativeProjectPath(project, planFile)
    || confirmation.plan_sha256 !== sha256File(planFile)
  ) throw new Error("确认记录没有绑定当前产品宣传片计划与哈希");
  if (!fs.existsSync(buildPlanFile)) {
    createProductPromoBuildPlan(project, planFile, confirmationFile, buildPlanFile, stageTarget);
  }
  const buildPlan = validateMediaBuildPlan(readJson(buildPlanFile));
  if (
    buildPlan.source_contract !== relativeProjectPath(project, planFile)
    || buildPlan.source_contract_sha256 !== sha256File(planFile)
    || buildPlan.profile !== "product-promo@1.0.0"
  ) throw new Error("现有通用构建计划没有绑定当前产品宣传片计划");
  return {
    project,
    plan,
    brief,
    confirmation,
    planPath: planFile,
    confirmationPath: confirmationFile,
    buildPlan,
    buildPlanPath: buildPlanFile,
  };
}

function usage() {
  console.error("用法：node scripts/product-promo.mjs <create-project|validate-brief|validate-plan|confirm-plan|build-plan|render|review|finalize|list-recipes|search-recipes|get-recipe|materialize-recipe> ...");
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command === "list-recipes") {
    for (const {document} of loadShotRecipes()) console.log(`${document.id}\t${document.status}\t${document.name}`);
    return;
  }
  if (command === "search-recipes") {
    for (const {document} of searchShotRecipes(args._.slice(1).join(" "))) console.log(`${document.id}\t${document.status}\t${document.name}`);
    return;
  }
  if (command === "get-recipe") {
    const item = loadShotRecipes().find(({document}) => document.id === args._[1]);
    if (!item) throw new Error(`找不到镜头配方 ${args._[1] || "(empty)"}`);
    console.log(JSON.stringify(item.document, null, 2));
    return;
  }
  const project = assertSkillTaskPath(path.resolve(requireArg(args, "project")), "--project");
  if (command === "create-project") {
    console.log(JSON.stringify(createProductPromoProject(project, requireArg(args, "project-id")), null, 2));
    return;
  }
  if (command === "materialize-recipe") {
    console.log(JSON.stringify(materializeShotRecipe({
      projectRoot: project,
      recipeId: requireArg(args, "recipe-id"),
      styleId: requireArg(args, "style-id"),
      variantId: args.variant || null,
      segmentId: args.segment || null,
      visualSourceKind: args["source-kind"] || "evidence",
      relationshipKind: args.relationship || null,
      placementMode: args.placement || "full-frame",
      aspectRatio: args.aspect || "16:9",
      selectionReason: requireArg(args, "reason"),
    }), null, 2));
    return;
  }
  if (command === "validate-brief") {
    const file = briefPath(args, project);
    validateProductPromoBrief(project, file);
    console.log(`产品宣传片 brief 通过：${file}`);
    return;
  }
  const plan = planPath(args, project);
  if (command === "validate-plan") {
    validateProductPromoPlan(project, plan);
    console.log(`产品宣传片计划通过：${plan}`);
    return;
  }
  if (command === "confirm-plan") {
    const output = projectPath(project, args.output || "product-promo-plan-confirmation.json", "confirmation output");
    const result = confirmProductPromoPlan(project, plan, output, requireArg(args, "confirmed-by"), requireArg(args, "evidence"));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "build-plan") {
    const confirmation = projectPath(project, args.confirmation || "product-promo-plan-confirmation.json", "confirmation");
    const output = projectPath(project, args.output || "media-build-plan.json", "build output");
    const result = createProductPromoBuildPlan(project, plan, confirmation, output, args.stage || "full-preview");
    console.log(JSON.stringify({output, units: result.units.length, frames: result.units.reduce((sum, unit) => sum + unit.duration_frames, 0)}, null, 2));
    return;
  }
  if (["render", "review", "finalize"].includes(command)) {
    const confirmation = projectPath(project, args.confirmation || "product-promo-plan-confirmation.json", "confirmation");
    const buildPlan = projectPath(project, args["build-plan"] || "media-build-plan.json", "build plan");
    const context = loadProductPromoExecutionContext(project, plan, confirmation, buildPlan, args.stage || "full-preview");
    if (command === "render") {
      const result = renderProductPromo({
        project,
        report: args.report,
        operationReport: args["operation-report"],
        ffmpeg: args.ffmpeg,
        ffprobe: args.ffprobe,
        localConfig: args["local-config"],
      }, context);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "review") {
      const result = reviewStandardVideo({
        project,
        profile: "product-promo@1.0.0",
        plan: relativeProjectPath(project, plan),
        confirmation: relativeProjectPath(project, confirmation),
        buildReport: args.report || "reports/media-build-report.json",
        review: args.review || "media-review.json",
        machineReport: args["machine-report"],
        contactSheet: args["contact-sheet"],
        ffmpeg: args.ffmpeg,
        ffprobe: args.ffprobe,
        python: args.python,
        agentStatus: args["agent-status"] || "pending",
        agentCompleted: args["agent-status"] && args["agent-status"] !== "pending",
        agentEvidence: args["agent-evidence"] || "",
        userRequired: args["user-required"] === "true",
        userStatus: args["user-status"],
        userEvidence: args["user-evidence"] || "",
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const result = finalizeStandardVideo({
      project,
      profile: "product-promo@1.0.0",
      plan: relativeProjectPath(project, plan),
      confirmation: relativeProjectPath(project, confirmation),
      buildReport: args.report || "reports/media-build-report.json",
      review: args.review || "media-review.json",
      delivery: args.delivery || "media-delivery.json",
      ffprobe: args.ffprobe,
      python: args.python,
      audioRequired: context.brief.sound.strategy !== "none",
      captionsRequired: context.brief.output.caption_strategy !== "none",
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  usage();
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exit(1); });
}
