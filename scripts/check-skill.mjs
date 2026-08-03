#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertEditableMediaPackageClosed,
  readEditableMediaPackage,
  resolvePackageReference,
} from "./editable-media-contract.mjs";
import {
  EDITABLE_MEDIA_SOURCES_CONTRACT,
  validateMediaSources,
} from "./validate-media-sources.mjs";
import { validateMediaTranscript } from "./validate-media-transcript.mjs";
import { validateMediaProjectState } from "./validate-media-project-state.mjs";
import { validateMediaReview } from "./validate-media-review.mjs";
import { validateTextMotionLibrary } from "./text-motion-library.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDir);
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`JSON 无法读取：${filePath}（${error.message}）`);
    return null;
  }
}

function checkStyleProfile(filePath, label) {
  const profile = readJson(filePath);
  if (!profile) return null;
  if (!String(profile.profile_id || "").trim()) fail(`${label} 缺少 profile_id`);
  if (!String(profile.source || "").trim()) fail(`${label} 缺少 source`);
  for (const legacyField of [
    "visual_rules",
    "image_treatment",
    "motion_rules",
    "typography_rules",
    "overrides",
  ]) {
    if (Object.hasOwn(profile, legacyField)) {
      fail(`${label} 仍保留旧风格档案字段 ${legacyField}`);
    }
  }
  for (const layer of [
    "shared_visual_core",
    "static_composition",
    "time_motion",
    "interaction",
  ]) {
    if (!Array.isArray(profile.applicability?.[layer])) {
      fail(`${label} 的 applicability.${layer} 必须是成品类型列表`);
    }
  }
  if (!profile.shared_visual_core || typeof profile.shared_visual_core !== "object") {
    fail(`${label} 缺少 shared_visual_core`);
  }
  for (const layer of ["static_composition", "time_motion", "interaction"]) {
    if (!Object.hasOwn(profile.realizations || {}, layer)) {
      fail(`${label} 缺少 realizations.${layer}`);
    }
  }
  return profile;
}

function ensurePath(relativePath, label = relativePath) {
  const absolute = path.resolve(skillRoot, relativePath);
  if (!fs.existsSync(absolute)) fail(`${label} 不存在：${absolute}`);
  return absolute;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function checkManifest(manifestPath) {
  let manifest;
  let manifestDir;
  try {
    const packageDocument = readEditableMediaPackage(manifestPath);
    manifest = packageDocument.manifest;
    manifestDir = packageDocument.packageRoot;
    assertEditableMediaPackageClosed(manifestDir, manifest);
  } catch (error) {
    fail(`${manifestPath}：${error.message}`);
    return;
  }
  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const layerIds = new Set(layers.map((layer) => layer.id));
  const dataFields = new Set((manifest.data_fields || []).map((field) => field.id));
  const variantIds = new Set((manifest.variants || []).map((variant) => variant.id));
  const sceneIds = new Set((manifest.scenes || []).map((scene) => scene.id));
  const contractIds = new Set(
    (manifest.layout_contracts || []).map((contract) => contract.id)
  );
  const contracts = new Map(
    (manifest.layout_contracts || []).map((contract) => [contract.id, contract])
  );
  const fields = new Map(
    (manifest.data_fields || []).map((field) => [field.id, field])
  );
  const mediaSourcesPath = resolvePackageReference(
    manifestDir,
    manifest.media_sources,
    "media_sources"
  );
  const sourceValidation = validateMediaSources(mediaSourcesPath, {
    contract: EDITABLE_MEDIA_SOURCES_CONTRACT,
  });
  if (!sourceValidation.ok) {
    sourceValidation.errors.forEach((message) =>
      fail(`${mediaSourcesPath}：${message}`)
    );
  }
  const sourceIds = new Set(
    sourceValidation.ok
      ? sourceValidation.sources.map((source) => source.id)
      : []
  );

  if (manifest.protocol !== "editable-media") fail(`${manifestPath} 缺少 editable-media protocol`);
  if (manifest.version !== 5) fail(`${manifestPath} 必须使用 editable-media v5`);
  for (const legacyField of ["canvas", "timeline", "layouts", "default_layout_id"]) {
    if (Object.prototype.hasOwnProperty.call(manifest, legacyField)) {
      fail(`${manifestPath} 仍保留旧字段 ${legacyField}`);
    }
  }
  if (!variantIds.has(manifest.default_variant_id)) {
    fail(`${manifestPath} 的 default_variant_id 无对应输出变体`);
  }
  if (layerIds.size !== layers.length) fail(`${manifestPath} 存在重复图层 id`);
  if (sceneIds.size !== (manifest.scenes || []).length) {
    fail(`${manifestPath} 存在重复场景 id`);
  }
  if (contractIds.size !== (manifest.layout_contracts || []).length) {
    fail(`${manifestPath} 存在重复内容版式合同 id`);
  }
  for (const scene of manifest.scenes || []) {
    if (!contractIds.has(scene.layout_id)) {
      fail(`${manifestPath} 的场景 ${scene.id} 引用未知内容版式合同`);
      continue;
    }
    const steps = Array.isArray(scene.steps) ? scene.steps : [];
    if (
      !scene.motion
      || !["static", "simple", "complex"].includes(scene.motion.complexity)
      || !["none", "object", "camera", "mixed"].includes(scene.motion.driver)
    ) {
      fail(`${manifestPath} 的场景 ${scene.id} 缺少活动 motion 合同`);
    }
    if (
      !steps.length
      || steps[0]?.state_kind !== "start"
      || steps.some(
        (step) =>
          !["start", "change", "result", "hold"].includes(step.state_kind)
          || typeof step.review !== "boolean"
          || !String(step.description || "").trim(),
      )
    ) {
      fail(`${manifestPath} 的场景 ${scene.id} 没有完整语义步骤`);
    }
    if (scene.motion?.complexity === "complex") {
      const reviewedKinds = new Set(
        steps.filter((step) => step.review).map((step) => step.state_kind),
      );
      if (
        scene.motion.key_state_review !== "required"
        || !["start", "change", "result"].every((kind) => reviewedKinds.has(kind))
      ) {
        fail(`${manifestPath} 的复杂场景 ${scene.id} 缺少开始、变化或结果审阅状态`);
      }
    }
    if (
      ["camera", "mixed"].includes(scene.motion?.driver)
      !== Boolean(scene.motion?.camera)
    ) {
      fail(`${manifestPath} 的场景 ${scene.id} 镜头驱动与 camera 声明不一致`);
    }
    const contract = contracts.get(scene.layout_id);
    for (const slot of contract.asset_slots || []) {
      if (slot.required !== true) continue;
      const binding = scene.asset_slots?.[slot.id];
      if (!binding || typeof binding.data_field !== "string") {
        fail(`${manifestPath} 的场景 ${scene.id} 未绑定必需素材槽位 ${slot.id}`);
        continue;
      }
      const field = fields.get(binding.data_field);
      const sourceId = Object.hasOwn(scene.data || {}, binding.data_field)
        ? scene.data[binding.data_field]
        : field?.default;
      if (
        !field
        || field.kind !== "media-source"
        || typeof sourceId !== "string"
        || !sourceIds.has(sourceId)
      ) {
        fail(
          `${manifestPath} 的素材槽位 ${slot.id} 没有绑定到有效的 media-source id`
        );
      }
    }
  }
  if (manifest.accessibility?.title_data_field
    && !dataFields.has(manifest.accessibility.title_data_field)) {
    fail(`${manifestPath} 的 accessibility.title_data_field 无对应数据字段`);
  }
  const roundtrips = [
    manifest.quality?.roundtrip,
    ...Object.values(manifest.quality?.variant_overrides || {}).map(
      (item) => item.roundtrip
    ),
    ...Object.values(manifest.quality?.scene_overrides || {}).map(
      (item) => item.roundtrip
    ),
  ].filter(Boolean);
  for (const roundtrip of roundtrips) {
    if (!dataFields.has(roundtrip.data_field)) {
      fail(`${manifestPath} 的往返检查引用未知数据字段 ${roundtrip.data_field}`);
    }
    if (!layerIds.has(roundtrip.layer_id)) {
      fail(`${manifestPath} 的往返检查引用未知图层 ${roundtrip.layer_id}`);
    }
  }

  const entryPath = resolvePackageReference(manifestDir, manifest.entry, "entry");
  if (!fs.existsSync(entryPath)) {
    fail(`${manifestPath} 缺少入口 HTML`);
    return;
  }
  const html = fs.readFileSync(entryPath, "utf8");
  if (html.includes("const PROJECT")) fail(`${entryPath} 仍保存平行 PROJECT 配置`);
  if (html.includes("window.mediaSource")) fail(`${entryPath} 恢复了旧 mediaSource 接口`);
  for (const legacyText of [
    "editableMediaRenderTime",
    "editableMediaDataChanged",
    "data-editable-layout=",
    "manifest.layouts",
    "state.layout",
  ]) {
    if (html.includes(legacyText)) fail(`${entryPath} 仍使用旧入口 ${legacyText}`);
  }

  for (const scene of manifest.scenes || []) {
    const contract = contracts.get(scene.layout_id);
    for (const slot of contract?.asset_slots || []) {
      if (slot.required !== true) continue;
      const field = fields.get(scene.asset_slots?.[slot.id]?.data_field);
      if (!field || typeof field.default !== "string") continue;
      const sourceId = Object.hasOwn(scene.data || {}, field.id)
        ? scene.data[field.id]
        : field.default;
      if (!sourceIds.has(sourceId)) {
        fail(
          `${manifestPath} 的场景 ${scene.id} 已采用 source id ${sourceId}`
            + "，但 media-sources v4 素材账本没有该记录"
        );
      }
    }
  }
}

function runChecked(command, args, label, cwd = skillRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) fail(`${label}失败`);
  return result;
}

const skillPath = ensurePath("SKILL.md");
const skillText = fs.readFileSync(skillPath, "utf8");

for (const filePath of [
  skillPath,
  ensurePath("README.md"),
  ...fs.readdirSync(path.join(skillRoot, "references"), {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(skillRoot, "references", entry.name)),
  ensurePath("scripts/interview-explainer.mjs"),
  ensurePath("scripts/interview_explainer_common.mjs"),
  ensurePath("scripts/interview_explainer_render.mjs"),
]) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (/\bMediaFlow\b(?! Pro)/u.test(lines[index])) {
      fail(
        `产品名称必须完整写作 MediaFlow Pro：${filePath}:${index + 1}`,
      );
    }
  }
}
for (const match of skillText.matchAll(/`((?:references|assets|scripts)\/[^`]+)`/g)) {
  ensurePath(match[1], `SKILL.md 引用 ${match[1]}`);
}

const starterManifest = ensurePath("assets/web-media-starter/editable-media.json");
checkManifest(starterManifest);

for (const schema of [
  "schemas/editable-media.v5.schema.json",
  "schemas/text-motion.v1.schema.json",
  "schemas/media-sources.v3.schema.json",
  "schemas/media-resource-library.v1.schema.json",
  "schemas/media-resource-registry.v1.schema.json",
  "schemas/media-resource-adoptions.v1.schema.json",
  "schemas/resource-promotion-candidates.v1.schema.json",
  "schemas/sound-production-profile.v1.schema.json",
  "schemas/media-transcript.v1.schema.json",
  "schemas/clip-selections.v2.schema.json",
  "schemas/media-stage-template.v1.schema.json",
  "schemas/media-project-state.v3.schema.json",
  "schemas/media-review.v3.schema.json",
  "schemas/media-delivery.v2.schema.json",
  "schemas/video-direction-plan.v1.schema.json",
  "schemas/generation-jobs.v1.schema.json",
  "schemas/video-production-profile-catalog.v1.schema.json",
  "schemas/interview-explainer-draft.v2.schema.json",
  "schemas/narration-bundle.v1.schema.json",
  "schemas/interview-explainer-plan.v2.schema.json",
  "schemas/interview-explainer-plan-confirmation.v1.schema.json",
  "schemas/media-build-plan.v1.schema.json",
  "schemas/media-build-report.v2.schema.json",
]) {
  readJson(ensurePath(schema));
}
for (const textMotionResource of [
  "references/text-motion-production.md",
  "assets/text-motion-library/library.json",
  "assets/text-motion-library/catalog.json",
  "assets/text-motion-library/editable-media.json",
  "assets/text-motion-library/editable-media.base.json",
  "assets/text-motion-library/index.html",
  "assets/text-motion-library/text-motion-runtime.js",
  "assets/text-motion-library/text-motion-binding.js",
  "scripts/text-motion-library.mjs",
  "scripts/self-test-text-motion-library.mjs",
]) {
  ensurePath(textMotionResource);
}
for (const reusableResource of [
  "references/reusable-media-resources.md",
  "references/sound-production-profiles.md",
  "scripts/media-resource-library.mjs",
  "scripts/sound-production-profile.mjs",
  "scripts/self-test-reusable-production-resources.mjs",
]) {
  ensurePath(reusableResource);
}
for (const stagedMediaResource of [
  "references/staged-media-production.md",
  "assets/media-stage-templates/time-media-production.v1.json",
  "scripts/media_project_state.mjs",
  "scripts/media-project.mjs",
  "scripts/self-test-media-project-stages.mjs",
]) {
  ensurePath(stagedMediaResource);
}
for (const mediaBuildResource of [
  "scripts/media_build_contract.mjs",
  "scripts/self-test-media-build-contract.mjs",
  "scripts/generate-media-build-case.mjs",
  "assets/media-build-cases/segmented-video/source-contract.json",
  "assets/media-build-cases/segmented-video/media-build-plan.json",
  "assets/media-build-cases/segmented-video/inputs/scene-1.json",
  "assets/media-build-cases/segmented-video/inputs/scene-2.json",
  "assets/media-build-cases/segmented-video/inputs/scene-3.json",
  "assets/media-build-cases/segmented-video/inputs/avatar-1.json",
  "assets/media-build-cases/segmented-video/inputs/avatar-2.json",
  "assets/media-build-cases/segmented-video/inputs/avatar-3.json",
]) {
  ensurePath(mediaBuildResource);
}
for (const voiceoverReferenceResource of [
  "references/voiceover-writing.md",
  "references/voiceover-reference-library.md",
  "scripts/voiceover_reference_library.py",
  "scripts/self-test-voiceover-reference-library.py",
]) {
  ensurePath(voiceoverReferenceResource);
}
for (const interviewResource of [
  "references/interview-explainer-production.md",
  "assets/video-production-profiles/catalog.json",
  "assets/video-production-profiles/interview-explainer/1.4.0/profile.json",
  "assets/interview-explainer-starter/interview-explainer-draft.json",
  "assets/interview-explainer-starter/narration-bundle.json",
  "scripts/json_schema_contract.mjs",
  "scripts/interview-explainer.mjs",
  "scripts/interview_explainer_common.mjs",
  "scripts/interview_explainer_plan.mjs",
  "scripts/interview_explainer_render.mjs",
  "scripts/interview_explainer_review.mjs",
  "scripts/self-test-interview-explainer-v2.mjs",
]) {
  ensurePath(interviewResource);
}
for (const directionResource of [
  "references/video-direction-contracts.md",
  "references/external-generation-jobs.md",
  "scripts/create-video-direction-plan.mjs",
  "scripts/validate-video-direction-plan.mjs",
  "scripts/manage-generation-job.mjs",
  "scripts/validate-generation-jobs.mjs",
  "scripts/self-test-video-generation-chain.mjs",
  "assets/video-generation-case/source.md",
  "assets/video-generation-case/direction-draft.json",
  "assets/video-generation-case/generation-request.json",
  "assets/video-generation-case/generation-job-spec.json",
  "assets/video-generation-case/approval.txt",
]) {
  ensurePath(directionResource);
}
for (const directionJson of [
  "assets/video-generation-case/direction-draft.json",
  "assets/video-generation-case/generation-request.json",
  "assets/video-generation-case/generation-job-spec.json",
]) {
  readJson(ensurePath(directionJson));
}
for (const starterFile of [
  "assets/media-project-starter/media-sources.json",
  "assets/media-project-starter/clip-selections.json",
  "assets/media-project-starter/media-project-state.json",
  "assets/media-project-starter/media-delivery.json",
]) {
  readJson(ensurePath(starterFile));
}
const starterDelivery = readJson(
  ensurePath("assets/media-project-starter/media-delivery.json")
);
if (
  !["editable_native", "flat_render"].includes(
    starterDelivery?.editability?.classification
  )
) {
  fail("媒体项目 starter 没有声明 editable_native 或 flat_render");
}
const mediaStarterValidation = validateMediaSources(
  ensurePath("assets/media-project-starter/media-sources.json")
);
if (!mediaStarterValidation.ok) {
  mediaStarterValidation.errors.forEach((message) =>
    fail(`媒体项目 starter：${message}`)
  );
}
const mediaStarterState = validateMediaProjectState(
  ensurePath("assets/media-project-starter/media-project-state.json")
);
if (!mediaStarterState.ok) {
  mediaStarterState.errors.forEach((message) =>
    fail(`媒体项目状态 starter：${message}`)
  );
}

const creatorIdentity = readJson(
  ensurePath("assets/creator-identity/identity.json")
);
if (
  creatorIdentity?.credit_roles?.original?.avatar !== true
  || creatorIdentity?.credit_roles?.original?.label !== "柴郡@0xCheshire"
  || creatorIdentity?.credit_roles?.curated?.avatar !== true
  || creatorIdentity?.credit_roles?.curated?.label !== "整理：柴郡@0xCheshire"
  || creatorIdentity?.credit_roles?.production_watermark?.avatar !== false
  || creatorIdentity?.credit_roles?.production_watermark?.label !== "𝕏@0xCheshire"
  || !(Number(creatorIdentity?.credit_roles?.production_watermark?.opacity) > 0)
  || !(Number(creatorIdentity?.credit_roles?.production_watermark?.opacity) < 0.5)
) {
  fail("创作者身份档案没有分开原创署名、整理说明和低干扰制作水印");
}
if (Object.hasOwn(creatorIdentity || {}, "use")) {
  fail("创作者身份档案仍保留含混的默认作者 use 字段");
}
const textCardReferencePath = ensurePath("references/text-card-production.md");
if (!skillText.includes("references/text-card-production.md")) {
  fail("SKILL.md 缺少纯文字卡正式路由：references/text-card-production.md");
}
const textCardReferenceText = fs.readFileSync(textCardReferencePath, "utf8");
for (const token of [
  "单句观点卡",
  "段落文字卡",
  "并列清单卡",
  "名词解释卡",
  "引文摘录卡",
  "文字对照卡",
  "production_watermark",
]) {
  if (!textCardReferenceText.includes(token)) {
    fail(`纯文字卡制作说明缺少正式分型或身份语义：${token}`);
  }
}

const catalogPath = ensurePath("assets/web-card-cases/catalog.json");
const catalog = readJson(catalogPath);
const browserProjects = [path.dirname(starterManifest)];
const starterRuntime = ensurePath("assets/web-media-starter/editable-media-runtime.js");
const starterRuntimeHash = sha256File(starterRuntime);
if (!fs.readFileSync(starterRuntime, "utf8").includes("getCamera")) {
  fail("网页通用运行时没有暴露确定性 getCamera 接口");
}
for (const item of catalog?.cases || []) {
  const caseRoot = ensurePath(`assets/web-card-cases/${item.path}`, `案例 ${item.id}`);
  for (const [kind, relative] of Object.entries(item.files || {})) {
    const filePath = path.resolve(caseRoot, relative);
    if (!fs.existsSync(filePath)) fail(`案例 ${item.id} 缺少 ${kind}：${filePath}`);
  }
  const manifestPath = path.resolve(caseRoot, item.files?.manifest || "editable-media.json");
  checkManifest(manifestPath);
  const stylePath = path.resolve(caseRoot, item.files?.style || "style-profile.json");
  const styleProfile = checkStyleProfile(stylePath, `案例 ${item.id} 的风格档案`);
  if (item.id === "social-evidence-variants") {
    const caseManifest = readJson(manifestPath);
    const scenes = new Map((caseManifest?.scenes || []).map((scene) => [scene.id, scene]));
    if (scenes.get("evidence")?.motion?.complexity !== "static") {
      fail("编辑证据案例缺少静态构图消费者");
    }
    if (
      scenes.get("evidence-motion")?.motion?.complexity !== "complex"
      || scenes.get("evidence-motion")?.motion?.driver !== "object"
    ) {
      fail("编辑证据案例缺少由对象关系承担的真实动画消费者");
    }
    for (const output of ["static-card", "web-animation", "web-derived-video"]) {
      const layer = output === "static-card" ? "static_composition" : "time_motion";
      if (!styleProfile?.applicability?.[layer]?.includes(output)) {
        fail(`编辑证据案例的 ${layer} 没有声明 ${output}`);
      }
    }
    const sourceManifest = readJson(
      path.resolve(caseRoot, item.files?.sources || "media-sources.json")
    );
    const creatorAvatar = (sourceManifest?.sources || []).find(
      (source) => source.id === "creator-avatar"
    );
    if (
      !String(creatorAvatar?.notes || "").includes("确认为原创")
      || creatorAvatar?.usage !== "creator signature"
    ) {
      fail("编辑证据案例没有把头像限定为已确认原创的正式作者署名");
    }
  }
  if (item.id === "warm-paper-project-list") {
    const caseManifest = readJson(manifestPath);
    const fields = new Map(
      (caseManifest?.data_fields || []).map((field) => [field.id, field])
    );
    const sourceManifest = readJson(
      path.resolve(caseRoot, item.files?.sources || "media-sources.json")
    );
    if (
      fields.get("curator_label")?.default !== "整理"
      || fields.has("creator_name")
      || fields.has("creator_avatar")
      || !(sourceManifest?.sources || []).some(
        (source) => source.id === "curator-avatar" && source.usage === "curator credit"
      )
    ) {
      fail("GitHub 清单案例没有使用明确的整理贡献说明，或仍保留默认作者字段");
    }
  }
  if (item.id === "text-card-glossary") {
    const caseManifest = readJson(manifestPath);
    const fields = new Map(
      (caseManifest?.data_fields || []).map((field) => [field.id, field])
    );
    const sourceManifest = readJson(
      path.resolve(caseRoot, item.files?.sources || "media-sources.json")
    );
    const serialized = JSON.stringify(caseManifest);
    if (
      fields.get("production_watermark")?.default !== "𝕏@0xCheshire"
      || !caseManifest?.layers?.some((layer) => layer.id === "production-watermark")
      || (sourceManifest?.sources || []).length !== 0
      || serialized.includes("creator_avatar")
      || serialized.includes("creator-name")
      || caseManifest?.component?.id !== "ai-glossary-text-card"
    ) {
      fail("名词解释纯文字卡没有使用无头像的制作水印唯一语义");
    }
  }
  const caseRuntime = path.join(caseRoot, "editable-media-runtime.js");
  if (!fs.existsSync(caseRuntime) || sha256File(caseRuntime) !== starterRuntimeHash) {
    fail(`案例 ${item.id} 没有消费当前唯一 editable-media 通用运行时`);
  }
  browserProjects.push(caseRoot);
}

const textMotionValidation = validateTextMotionLibrary();
if (!textMotionValidation.ok) {
  textMotionValidation.errors.forEach((message) =>
    fail(`文字动效库：${message}`)
  );
} else {
  const textMotionRoot = ensurePath("assets/text-motion-library");
  checkManifest(path.join(textMotionRoot, "editable-media.json"));
  const textMotionRuntime = path.join(textMotionRoot, "editable-media-runtime.js");
  if (
    !fs.existsSync(textMotionRuntime)
    || sha256File(textMotionRuntime) !== starterRuntimeHash
  ) {
    fail("文字动效画廊没有消费当前唯一 editable-media 通用运行时");
  }
  browserProjects.push(textMotionRoot);
}

if (failures.length === 0) {
  const validator = path.join(scriptDir, "validate-editable-media.mjs");
  for (const project of browserProjects) {
    runChecked(process.execPath, [validator, project], `浏览器验证：${project}`);
  }
}

if (failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-text-motion-library.mjs")],
    "文字动效真源—生成目录—编辑状态—确定性浏览器消费者检查",
  );
}

if (failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-reusable-production-resources.mjs")],
    "注册资源—项目采用—声音档案—成果晋升—网页消费者真实链路检查",
  );
}

for (const token of [
  "references/text-motion-production.md",
  "scripts/text-motion-library.mjs",
  "assets/text-motion-library/text-motion-runtime.js",
  "assets/text-motion-library/text-motion-binding.js",
]) {
  if (!skillText.includes(token)) {
    fail(`SKILL.md 缺少文字动效正式路由：${token}`);
  }
}

if (failures.length === 0) {
  const mediaCaseSource = ensurePath("assets/media-delivery-case");
  const mediaCase = fs.mkdtempSync(
    path.join(os.tmpdir(), "visual-multimedia-media-delivery-case-")
  );
  fs.cpSync(mediaCaseSource, mediaCase, { recursive: true });
  const caseManifest = path.join(mediaCase, "media-sources.json");
  const caseValidation = validateMediaSources(caseManifest);
  if (!caseValidation.ok) {
    caseValidation.errors.forEach((message) => fail(`媒体生产案例：${message}`));
  } else {
    const importer = path.join(scriptDir, "import-media-asset.mjs");
    const avatarSource = caseValidation.sources.find(
      (source) => source.id === "case-avatar"
    );
    if (!avatarSource) fail("媒体生产案例缺少 case-avatar 素材");
    const avatar = path.resolve(mediaCase, avatarSource?.file || "");
    const idempotent = runChecked(
      process.execPath,
      [
        importer,
        "--project",
        mediaCase,
        "--input",
        avatar,
        "--id",
        "case-avatar",
        "--media-type",
        "photo",
        "--method",
        "project-owned",
        "--rights-status",
        "confirmed",
        "--license",
        "project-owned",
        "--usage",
        "最终交付案例的画面主体",
      ],
      "内容寻址导入幂等检查"
    );
    if (idempotent.status === 0) {
      try {
        const result = JSON.parse(idempotent.stdout);
        if (result.reused !== true || result.binding_changed !== false) {
          fail("内容寻址导入没有证明同 id 同内容复用且不改消费者绑定");
        }
      } catch (error) {
        fail(`内容寻址导入没有返回可读结果：${error.message}`);
      }
    }
    const manifestHashBeforeConflict = sha256File(caseManifest);
    const conflictSource = caseValidation.sources.find(
      (source) => source.id === "case-narration"
    );
    if (!conflictSource) fail("媒体生产案例缺少 case-narration 素材");
    const conflictInput = path.resolve(mediaCase, conflictSource?.file || "");
    const conflict = spawnSync(
      process.execPath,
      [
        importer,
        "--project",
        mediaCase,
        "--input",
        conflictInput,
        "--id",
        "case-avatar",
        "--media-type",
        "audio",
        "--method",
        "project-owned",
        "--rights-status",
        "confirmed",
        "--license",
        "project-owned",
        "--usage",
        "冲突内容",
      ],
      {
        cwd: skillRoot,
        env: process.env,
        encoding: "utf8",
        windowsHide: true,
      }
    );
    if (
      conflict.status === 0
      || sha256File(caseManifest) !== manifestHashBeforeConflict
    ) {
      fail("内容寻址导入没有拒绝同 id 的其它内容，或冲突后改写了素材账本");
    }
  }
  const transcriptContract = readJson(path.join(mediaCase, "transcript.json"));
  if (transcriptContract) {
    const transcriptImporter = path.join(
      scriptDir,
      "import-media-transcript.mjs"
    );
    const transcriptImportArgs = [
      transcriptImporter,
      "--project",
      mediaCase,
      "--source-id",
      transcriptContract.source_id,
      "--input",
      path.join(mediaCase, transcriptContract.input.file),
      "--language",
      transcriptContract.language,
      "--kind",
      transcriptContract.input.kind,
    ];
    if (transcriptContract.review?.status === "passed") {
      transcriptImportArgs.push(
        "--reviewed",
        "--review-notes",
        transcriptContract.review.notes
      );
    }
    const transcriptImport = runChecked(
      process.execPath,
      transcriptImportArgs,
      "转写生产者幂等检查"
    );
    if (transcriptImport.status === 0) {
      try {
        const result = JSON.parse(transcriptImport.stdout);
        if (result.reused !== true || result.created !== false) {
          fail("转写生产者没有证明同一原片、输入和听音状态可以复用");
        }
      } catch (error) {
        fail(`转写生产者没有返回可读结果：${error.message}`);
      }
    }
  }
  runChecked(
    process.execPath,
    [
      path.join(scriptDir, "validate-media-transcript.mjs"),
      path.join(mediaCase, "transcript.json"),
    ],
    "真实转写合同检查"
  );
  runChecked(
    process.execPath,
    [
      path.join(scriptDir, "validate-clip-selections.mjs"),
      path.join(mediaCase, "clip-selections.json"),
    ],
    "真实片段选择检查"
  );
  runChecked(
    process.execPath,
    [path.join(mediaCase, "build.mjs")],
    "媒体生产案例构建"
  );
  const projectStateValidation = validateMediaProjectState(
    path.join(mediaCase, "media-project-state.json")
  );
  if (!projectStateValidation.ok) {
    projectStateValidation.errors.forEach((message) =>
      fail(`媒体项目状态：${message}`)
    );
  }
  const transcriptValidation = validateMediaTranscript(
    path.join(mediaCase, "transcript.json")
  );
  if (!transcriptValidation.ok) {
    transcriptValidation.errors.forEach((message) =>
      fail(`媒体转写：${message}`)
    );
  }
  const reviewValidation = validateMediaReview(
    path.join(mediaCase, "media-review.json")
  );
  if (!reviewValidation.ok) {
    reviewValidation.errors.forEach((message) =>
      fail(`媒体评审：${message}`)
    );
  }
  const python = process.env.VISUAL_MULTIMEDIA_PYTHON
    || (process.platform === "win32" ? "python.exe" : "python3");
  runChecked(
    python,
    [
      path.join(scriptDir, "verify-media-delivery.py"),
      path.join(mediaCase, "media-delivery.json"),
      "--require-delivery-ready",
    ],
    "最终媒体交付检查"
  );
  const deliveryReport = readJson(
    path.join(mediaCase, "reports", "media-delivery-report.json")
  );
  if (
    deliveryReport?.summary?.technical_ready !== true
    || deliveryReport?.summary?.delivery_ready !== true
  ) {
    fail("最终媒体交付报告没有证明 technical_ready 与 delivery_ready");
  }
  for (const visibleOutput of [
    path.join(mediaCase, "renders", "final.mp4"),
    path.join(mediaCase, "reports", "contact-sheet.jpg"),
  ]) {
    if (!fs.existsSync(visibleOutput) || fs.statSync(visibleOutput).size === 0) {
      fail(`媒体生产案例缺少用户可见结果：${visibleOutput}`);
    }
  }
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-media-contracts.mjs")],
    "原片—代理—素材账本—消费者真实链路检查"
  );
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-media-project-stages.mjs")],
    "通用视频上层阶段—逐层确认—下游失效真实链路检查"
  );
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-media-build-contract.mjs")],
    "通用构建单元—局部失效—装配缓存合同检查"
  );
  runChecked(
    process.execPath,
    [path.join(scriptDir, "generate-media-build-case.mjs"), "--check"],
    "通用媒体构建生产者案例检查"
  );
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-video-generation-chain.mjs")],
    "长内容—导演计划—费用门—远程任务—素材入账—时间线—交付真实链路检查"
  );
}

{
  const requiredVoiceoverReferenceTokens = [
    "references/voiceover-writing.md",
    "references/voiceover-reference-library.md",
    "scripts/voiceover_reference_library.py",
    "口播声音",
    "voice-candidates",
    "完整口播案例",
    "开头钩子",
  ];
  for (const token of requiredVoiceoverReferenceTokens) {
    if (!skillText.includes(token)) {
      fail(`SKILL.md 缺少口播参考库正式链路：${token}`);
    }
  }
  const voiceoverWritingText = fs.readFileSync(
    path.join(skillRoot, "references", "voiceover-writing.md"),
    "utf8"
  );
  for (const token of [
    "内容贡献",
    "结构关系",
    "作者与听众",
    "不建立固定禁词表",
  ]) {
    if (!voiceoverWritingText.includes(token)) {
      fail(`完整口播写作缺少根因审查合同：${token}`);
    }
  }
  const lightWritingText = fs.readFileSync(
    path.join(skillRoot, "references", "media-writing.md"),
    "utf8"
  );
  if (!lightWritingText.includes("完整口播、旁白、播客独白和主持连接语的新写")) {
    fail("轻量媒体文字没有明确排除完整口播写作");
  }
  const voiceoverPython = process.env.VISUAL_MULTIMEDIA_PYTHON
    || (process.platform === "win32" ? "python.exe" : "python3");
  runChecked(
    voiceoverPython,
    [path.join(scriptDir, "self-test-voiceover-reference-library.py")],
    "口播私人库 v2 协议、声音资格、引用、索引与去重检查"
  );
}

{
  const requiredActiveAvatarTokens = [
    "references/anime-avatar-production.md",
    "scripts/anime-avatar-project.py",
    "scripts/render-anime-avatar.py",
    "scripts/compose-anime-avatar-inset.py",
    "scripts/self-test-anime-avatar-inset.py",
    "assets/anime-avatar-libraries/",
    "plan → confirm-plan → render",
    "夜希数字人",
  ];
  for (const token of requiredActiveAvatarTokens) {
    if (!skillText.includes(token)) {
      fail(`SKILL.md 缺少二次元口播正式链路：${token}`);
    }
  }
  for (const file of [
    "references/anime-avatar-production.md",
    "scripts/anime-avatar-project.py",
    "scripts/render-anime-avatar.py",
    "scripts/compose-anime-avatar-inset.py",
    "scripts/check-anime-avatar-resources.py",
    "assets/anime-avatar-libraries/catalog.json",
    "schemas/anime-avatar-project.v4.schema.json",
    "schemas/anime-avatar-render-plan.v3.schema.json",
    "schemas/anime-avatar-track-clips.v1.schema.json",
    "schemas/anime-avatar-inset.v1.schema.json",
  ]) {
    ensurePath(file, `二次元口播正式资源 ${file}`);
  }
  for (const legacyActiveSchema of [
    "schemas/anime-avatar-project.v2.schema.json",
    "schemas/anime-avatar-project.v3.schema.json",
    "schemas/anime-avatar-join-plan.v1.schema.json",
    "schemas/anime-avatar-render-plan.v2.schema.json",
  ]) {
    if (fs.existsSync(path.join(skillRoot, legacyActiveSchema))) {
      fail(`二次元口播旧合同仍留在活动 schema 目录：${legacyActiveSchema}`);
    }
  }
  for (const archivedAvatarSchema of [
    "archive/schemas/anime-avatar-project.v2.schema.json",
    "archive/schemas/anime-avatar-project.v3.schema.json",
    "archive/schemas/anime-avatar-join-plan.v1.schema.json",
    "archive/schemas/anime-avatar-render-plan.v2.schema.json",
  ]) {
    ensurePath(archivedAvatarSchema, `二次元口播旧合同归档 ${archivedAvatarSchema}`);
  }
  const avatarCatalog = readJson(
    path.join(skillRoot, "assets", "anime-avatar-libraries", "catalog.json")
  );
  const yexi = avatarCatalog?.libraries?.find((item) => item?.id === "yexi");
  if (
    avatarCatalog?.protocol
      !== "visual-multimedia-anime-avatar-library-catalog"
    || avatarCatalog?.version !== 2
    || avatarCatalog?.default_library !== null
    || !yexi?.aliases?.includes("夜希数字人")
    || typeof yexi?.preferred_version !== "string"
  ) {
    fail("二次元口播注册表没有提供无默认角色、可按“夜希数字人”解析的 v2 资源");
  }
  const avatarPython = process.env.VISUAL_MULTIMEDIA_PYTHON
    || (process.platform === "win32" ? "python.exe" : "python3");
  runChecked(
    avatarPython,
    [path.join(scriptDir, "anime_avatar_motion.py"), "--self-test"],
    "二次元口播连续动作规划回归检查"
  );
  runChecked(
    avatarPython,
    [path.join(scriptDir, "self-test-anime-avatar-segmentation.py")],
    "二次元口播真实静音分段与连续发音保护回归检查"
  );
  runChecked(
    avatarPython,
    [path.join(scriptDir, "check-anime-avatar-resources.py"), "--deep"],
    "二次元口播注册资源与视觉素材库真实文件检查"
  );
  runChecked(
    avatarPython,
    [path.join(scriptDir, "anime-avatar-project.py"), "list-libraries"],
    "二次元口播公开角色目录检查"
  );
  runChecked(
    avatarPython,
    [path.join(scriptDir, "self-test-anime-avatar-inset.py")],
    "素材导入—固定角色窗—音轨默认—项目相对输出—真实成片检查"
  );

  const avatarRenderHelp = runChecked(
    avatarPython,
    [path.join(scriptDir, "render-anime-avatar.py"), "render", "--help"],
    "二次元口播渲染公开参数检查"
  );
  if (
    avatarRenderHelp.stdout.includes("--render-plan")
    || !avatarRenderHelp.stdout.includes("--plan-id")
  ) {
    fail("二次元口播渲染仍暴露外部计划路径，或没有通过 project + plan-id 唯一解析计划");
  }
  const avatarRenderSource = fs.readFileSync(
    path.join(scriptDir, "render-anime-avatar.py"),
    "utf8"
  );
  for (const token of [
    "run_segmented_avatar_pipeline",
    "anime-avatar-medium-master-v1",
    "anime-avatar-segment-cache-v1",
    "avatar-track-clips.json",
    "continuous-audio.wav",
  ]) {
    if (!avatarRenderSource.includes(token)) {
      fail(`二次元口播分段生产链缺少活动实现：${token}`);
    }
  }
  if (
    avatarRenderSource.includes("def run_avatar_pipeline(")
    || avatarRenderSource.includes('render_config["output_size"]')
  ) {
    fail("二次元口播旧整轨渲染架构仍留在活动脚本");
  }

  const requiredInterviewTokens = [
    "references/interview-explainer-production.md",
    "scripts/interview-explainer.mjs",
    "list-profiles",
    "plan → confirm-plan → render → review → finalize",
    "MediaFlow Pro",
  ];
  for (const token of requiredInterviewTokens) {
    if (!skillText.includes(token)) {
      fail(`SKILL.md 缺少采访原声讲解型活动边界：${token}`);
    }
  }

  const videoProfileCatalog = readJson(
    path.join(skillRoot, "assets", "video-production-profiles", "catalog.json")
  );
  const activeInterviewProfiles = (videoProfileCatalog?.profiles || []).filter(
    (item) => item.id === "interview-explainer" && item.status === "active"
  );
  if (
    activeInterviewProfiles.length !== 1
    || activeInterviewProfiles[0]?.version !== "1.4.0"
  ) {
    fail("采访原声讲解型必须只启用 v2 draft/plan 与可配置原片构图的 1.4.0 profile");
  }
  const activeInterviewProfile = readJson(
    path.resolve(
      skillRoot,
      "assets",
      "video-production-profiles",
      activeInterviewProfiles[0]?.package || "missing"
    )
  );
  if (
    activeInterviewProfile?.algorithm_defaults?.mediaflow_pro_project_scope
      !== "one-project-per-plan-sha256"
    || activeInterviewProfile?.algorithm_defaults?.mediaflow_pro_project_location
      !== "consumer-default-root"
    || activeInterviewProfile?.schemas?.draft
      !== "schemas/interview-explainer-draft.v2.schema.json"
    || activeInterviewProfile?.schemas?.plan
      !== "schemas/interview-explainer-plan.v2.schema.json"
    || !activeInterviewProfile?.project_configurable?.includes("source_card_footage_box")
    || !activeInterviewProfile?.project_configurable?.includes("source_card_fit")
    || !activeInterviewProfile?.project_configurable?.includes("source_card_focus")
  ) {
    fail("采访原声讲解型活动 profile 没有绑定 v2 合同、MediaFlow Pro 工程根目录和原片构图配置");
  }

  if (fs.existsSync(path.join(skillRoot, "plans"))) {
    fail("Skill 源码根目录仍含项目运行计划；采访和角色计划必须只存在于 Skill 外部项目");
  }

  for (const script of [
    "json_schema_contract.mjs",
    "interview-explainer.mjs",
    "interview_explainer_common.mjs",
    "interview_explainer_plan.mjs",
    "interview_explainer_render.mjs",
    "interview_explainer_review.mjs",
  ]) {
    runChecked(
      process.execPath,
      ["--check", path.join(scriptDir, script)],
      `采访原声讲解型脚本语法检查：${script}`
    );
  }
  runChecked(
    process.execPath,
    [path.join(scriptDir, "interview-explainer.mjs"), "list-profiles"],
    "采访原声讲解型公开 profile 目录检查"
  );
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-interview-explainer-v2.mjs")],
    "正式素材导入—听音转写—选段—网页场景—采访 v2 计划消费者检查"
  );

  const coldStartRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "visual-multimedia-interview-starter-")
  );
  runChecked(
    process.execPath,
    [
      path.join(scriptDir, "interview-explainer.mjs"),
      "create-project",
      "--project",
      coldStartRoot,
      "--project-id",
      "interview-starter-contract-check",
    ],
    "Skill 外部采访原声讲解型项目生产入口检查"
  );
  for (const packageId of ["context", "explanation-01", "summary"]) {
    checkManifest(
      path.join(coldStartRoot, "editable-media", packageId, "editable-media.json")
    );
  }
}

if (failures.length > 0) {
  failures.forEach((message) => console.error(`FAIL ${message}`));
  console.error(`visual-multimedia 未通过：${failures.length} 个问题`);
  process.exit(1);
}

console.log(
  `visual-multimedia 通过：网页 starter、${catalog?.cases?.length || 0} 个网页案例`
    + `、${textMotionValidation.effects?.length || 0} 个确定性文字动效`
    + "、1 个最终媒体案例、口播私人库协议、注册资源与声音档案链路、真实代理链路、"
    + "视频导演链路与采访原声讲解型正式入口均通过验证"
);
