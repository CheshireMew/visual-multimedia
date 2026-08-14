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
import { validateShotRecipeLibrary } from "./shot-recipe-library.mjs";
import { validateVideoProductionProfileCatalog } from "./video-production-profile-catalog.mjs";
import { validateJsonSchema } from "./json_schema_contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDir);
const failures = [];

function parseCheckMode(args) {
  const supported = new Set(["--fast", "--browser", "--full"]);
  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      "Usage: node scripts/check-skill.mjs [--fast|--browser|--full]",
      "  --fast     静态合同、schema、资源索引、许可证与脚本语法（默认）",
      "  --browser  fast + Playwright 网页、确定性时间与产品宣传片链路",
      "  --full     browser + 全部 Node/Python 生产、消费与交付回归",
    ].join("\n"));
    process.exit(0);
  }
  const unknown = args.filter((arg) => !supported.has(arg));
  const selected = args.filter((arg) => supported.has(arg));
  if (unknown.length > 0 || selected.length > 1) {
    console.error(
      `参数无效：${[...unknown, ...selected.slice(1)].join(", ")}`
        + "；使用 --help 查看验证档位。",
    );
    process.exit(2);
  }
  return (selected[0] || "--fast").slice(2);
}

const checkMode = parseCheckMode(process.argv.slice(2));
const runBrowserChecks = checkMode === "browser" || checkMode === "full";
const runFullChecks = checkMode === "full";

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
  if (manifest.version !== 6) fail(`${manifestPath} 必须使用 editable-media v6`);
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
const readmePath = ensurePath("README.md");
const readmeText = fs.readFileSync(readmePath, "utf8");
const agentsText = fs.readFileSync(ensurePath("AGENTS.md"), "utf8");

for (const [label, text, markers] of [
  [
    "README 验证档位",
    readmeText,
    ["--fast", "--browser", "--full"],
  ],
  [
    "AGENTS 验证分级",
    agentsText,
    ["## 验证分级", "node scripts/check-skill.mjs --full"],
  ],
]) {
  for (const marker of markers) {
    if (!text.includes(marker)) fail(`${label}缺少：${marker}`);
  }
}

for (const filePath of [
  skillPath,
  readmePath,
  ...fs.readdirSync(path.join(skillRoot, "references"), {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(skillRoot, "references", entry.name)),
  ensurePath("scripts/interview-explainer.mjs"),
  ensurePath("scripts/interview_explainer_common.mjs"),
  ensurePath("scripts/interview_explainer_render.mjs"),
]) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const prose = lines[index].replace(/https?:\/\/[^\s)>]+/gu, "");
    if (/\bMediaFlow\b(?! Pro)/u.test(prose)) {
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
  "schemas/editable-media.v6.schema.json",
  "schemas/text-motion.v1.schema.json",
  "schemas/media-sources.v3.schema.json",
  "schemas/media-resource-library.v1.schema.json",
  "schemas/media-resource-registry.v1.schema.json",
  "schemas/media-resource-adoptions.v1.schema.json",
  "schemas/resource-promotion-candidates.v1.schema.json",
  "schemas/sound-production-profile.v1.schema.json",
  "schemas/media-transcript.v1.schema.json",
  "schemas/production-captions.v1.schema.json",
  "schemas/caption-qc.v1.schema.json",
  "schemas/clip-selections.v2.schema.json",
  "schemas/media-stage-template.v1.schema.json",
  "schemas/media-project-state.v3.schema.json",
  "schemas/media-review.v3.schema.json",
  "schemas/media-delivery.v3.schema.json",
  "schemas/media-timeline.v1.schema.json",
  "schemas/video-direction-plan.v2.schema.json",
  "schemas/video-direction-timing-projection.v1.schema.json",
  "schemas/explanatory-broll-studio.v1.schema.json",
  "schemas/generation-jobs.v1.schema.json",
  "schemas/video-production-profile-catalog.v1.schema.json",
  "schemas/interview-explainer-draft.v2.schema.json",
  "schemas/narration-bundle.v1.schema.json",
  "schemas/interview-explainer-plan.v2.schema.json",
  "schemas/interview-explainer-plan-confirmation.v1.schema.json",
  "schemas/media-build-plan.v1.schema.json",
  "schemas/media-build-report.v2.schema.json",
  "schemas/shot-recipe.v2.schema.json",
  "schemas/video-progress-bar-spec.v1.schema.json",
  "schemas/product-promo.v1.schema.json",
  "schemas/product-ui-capture.v1.schema.json",
  "schemas/music-beat-analysis.v1.schema.json",
  "schemas/github-project-intro.v1.schema.json",
  "schemas/media-operation-run.v1.schema.json",
]) {
  readJson(ensurePath(schema));
}
for (const captionResource of [
  "references/subtitle-production.md",
  "scripts/production-captions.mjs",
  "scripts/self-test-production-captions.mjs",
  "assets/production-caption-case/source.srt",
  "assets/production-caption-case/captions.json",
  "assets/production-caption-case/captions.srt",
  "assets/production-caption-case/captions.vtt",
  "assets/production-caption-case/caption-qc.json",
]) {
  ensurePath(captionResource);
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
for (const localMediaResource of [
  "references/production-providers.md",
  "assets/local-media-environment.example.json",
  "scripts/local-media-environment.mjs",
  "scripts/media-timeline.mjs",
  "scripts/render-web-media-local.mjs",
  "scripts/self-test-media-timeline.mjs",
  "scripts/self-test-local-web-render.mjs",
  "scripts/self-test-editable-preview.mjs",
  "scripts/self-test-visual-variable-drift.mjs",
  "scripts/self-test-production-providers.mjs",
  "assets/web-media-starter/editable-media-editor.css",
  "assets/web-media-starter/editable-media-editor.js",
  "assets/web-media-starter/typography-presets.json",
  "assets/web-media-starter/preview-server.py",
  "assets/web-media-starter/_start_editable_preview.bat",
  "references/color-palette-production.md",
  "assets/color-palette-library/catalog.json",
  "assets/color-palette-library/index.html",
  "assets/color-palette-library/preview.png",
  "scripts/render-color-palette-library.mjs",
]) {
  ensurePath(localMediaResource);
}
const localMediaEnvironmentText = fs.readFileSync(
  ensurePath("scripts/local-media-environment.mjs"),
  "utf8",
);
for (const token of [
  '["describe", "--summary"]',
  '["describe", "--operation", name]',
  '["describe", "--catalog", name]',
  "mediaFlowProDescribeOperation(environment, operation)",
  "mediaFlowDiscoveryCaches",
]) {
  if (!localMediaEnvironmentText.includes(token)) {
    fail(`MediaFlow Pro 渐进式能力读取缺少：${token}`);
  }
}
const structuredMediaEditorCliText = fs.readFileSync(
  ensurePath("references/structured-media-editor-cli.md"),
  "utf8",
);
for (const token of [
  "mediaflow describe --operation <操作名>",
  "mediaflow describe --catalog <字段目录名>",
  "mediaflow describe --full",
  "不是正式生产的默认入口",
]) {
  if (!structuredMediaEditorCliText.includes(token)) {
    fail(`结构化编辑器说明缺少渐进式能力发现边界：${token}`);
  }
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
  "references/voiceover-hook-library.md",
  "scripts/voiceover_reference_library.py",
  "scripts/voiceover_hook_library.py",
  "scripts/self-test-voiceover-reference-library.py",
  "scripts/self-test-voiceover-hook-library.py",
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
for (const productPromoResource of [
  "references/product-promo-production.md",
  "assets/video-production-profiles/product-promo/1.0.0/profile.json",
  "assets/shot-recipe-library/library.json",
  "assets/shot-recipe-library/catalog.json",
  "assets/shot-recipe-library/index.html",
  "assets/shot-recipe-library/THIRD_PARTY_NOTICES.md",
  "assets/shot-recipe-library/LICENSE.video-shotcraft.txt",
  "assets/shot-recipe-library/recipes/feature-focus-tour.json",
  "assets/shot-recipe-library/recipes/video-chapter-progress.json",
  "scripts/video-production-profile-catalog.mjs",
  "scripts/shot-recipe-library.mjs",
  "scripts/migrate-video-shotcraft-recipes.mjs",
  "scripts/product-promo.mjs",
  "scripts/product_promo_runtime.mjs",
  "scripts/mediaflow_video_common.mjs",
  "scripts/media_operation_run.mjs",
  "scripts/standard_video_delivery.mjs",
  "scripts/capture-product-ui.mjs",
  "scripts/analyze-music-beats.mjs",
  "scripts/self-test-product-promo.mjs",
  "scripts/browser-safe-server.mjs",
]) {
  ensurePath(productPromoResource);
}
for (const githubIntroResource of [
  "references/github-project-intro-production.md",
  "assets/video-production-profiles/github-project-intro/1.0.0/profile.json",
  "scripts/github-project-intro.mjs",
  "scripts/self-test-github-project-intro.mjs",
]) {
  ensurePath(githubIntroResource);
}
for (const sourceCommentaryResource of [
  "references/source-video-commentary-production.md",
  "assets/video-production-profiles/source-video-commentary/1.0.0/profile.json",
  "assets/source-video-commentary-starter/README.md",
  "assets/source-video-commentary-starter/source-video-commentary-script.md",
  "assets/source-video-commentary-starter/source-video-commentary-draft.json",
  "assets/source-video-commentary-starter/narration-bundle.json",
  "schemas/source-video-commentary-analysis.v1.schema.json",
  "schemas/source-video-commentary-authoring.v1.schema.json",
  "schemas/source-video-commentary-authoring-confirmation.v1.schema.json",
  "schemas/source-video-commentary-narration-candidates.v1.schema.json",
  "schemas/source-video-commentary-draft.v1.schema.json",
  "schemas/source-video-commentary-plan.v1.schema.json",
  "schemas/source-video-commentary-plan-confirmation.v1.schema.json",
  "scripts/source-video-commentary.mjs",
  "scripts/source_video_commentary_preproduction.mjs",
  "scripts/source_video_commentary_contract.mjs",
  "scripts/source_video_commentary_render.mjs",
  "scripts/self-test-source-video-commentary-preproduction.mjs",
  "scripts/self-test-source-video-commentary.mjs",
]) {
  ensurePath(sourceCommentaryResource);
}
for (const videoProgressResource of [
  "references/web-visual-production.md",
  "assets/video-progress-bar/editable-media.json",
  "assets/video-progress-bar/index.html",
  "assets/video-progress-bar/editable-media-runtime.js",
  "assets/video-progress-bar/media-sources.json",
  "assets/video-progress-bar/video-progress-bar-spec.json",
  "scripts/create-video-progress-bar.mjs",
  "scripts/self-test-video-progress-bar.mjs",
]) {
  ensurePath(videoProgressResource);
}
const shotRecipeNoticeText = fs.readFileSync(
  ensurePath("assets/shot-recipe-library/THIRD_PARTY_NOTICES.md"),
  "utf8",
);
for (const [label, text, markers] of [
  [
    "README 第三方资源与致谢",
    readmeText,
    [
      "## 第三方资源与致谢",
      "https://github.com/Vincentwei1021/video-shotcraft",
      "assets/shot-recipe-library/THIRD_PARTY_NOTICES.md",
      "assets/text-motion-library/THIRD_PARTY_NOTICES.md",
    ],
  ],
  [
    "video-shotcraft 第三方声明",
    shotRecipeNoticeText,
    [
      "https://github.com/Vincentwei1021/video-shotcraft",
      "Copyright 2026 Wei Yihao",
      "LICENSE.video-shotcraft.txt",
      "没有采用该 fork 的独有改动",
    ],
  ],
]) {
  for (const marker of markers) {
    if (!text.includes(marker)) fail(`${label}缺少：${marker}`);
  }
}
for (const directionResource of [
  "references/video-direction-contracts.md",
  "references/external-generation-jobs.md",
  "scripts/create-video-direction-plan.mjs",
  "scripts/validate-video-direction-plan.mjs",
  "scripts/manage-generation-job.mjs",
  "scripts/validate-generation-jobs.mjs",
  "scripts/self-test-video-generation-chain.mjs",
  "scripts/explanatory-broll-studio.mjs",
  "scripts/self-test-explanatory-broll.mjs",
  "assets/explanatory-broll-templates/editable-media.json",
  "assets/explanatory-broll-templates/index.html",
  "assets/explanatory-broll-case/source.md",
  "assets/explanatory-broll-case/direction-draft.json",
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
  "assets/explanatory-broll-case/direction-draft.json",
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
  starterDelivery?.version !== 3
  || !["native_project", "source_bundle", "flat_render"].includes(
    starterDelivery?.editability?.classification
  )
) {
  fail("媒体项目 starter 没有使用 v3 的 native_project、source_bundle 或 flat_render");
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

const technicalDiagramReferencePath = ensurePath("references/technical-diagram-production.md");
if (!skillText.includes("references/technical-diagram-production.md")) {
  fail("SKILL.md 缺少技术图解正式路由：references/technical-diagram-production.md");
}
const technicalDiagramReferenceText = fs.readFileSync(technicalDiagramReferencePath, "utf8");
for (const token of [
  "通用科普图",
  "静态对比图",
  "稳定全貌图",
  "光学中心",
  "正交",
  "同一条边",
  "继承所在路径的颜色",
  "顺序完整解码",
]) {
  if (!technicalDiagramReferenceText.includes(token)) {
    fail(`技术图解制作说明缺少可复用机制：${token}`);
  }
}

const visualResourceGovernancePath = ensurePath("references/visual-resource-governance.md");
const visualResourceGovernanceText = fs.readFileSync(visualResourceGovernancePath, "utf8");
for (const token of [
  "evidence-only",
  "active style-profile",
  "case_specific_visual_fingerprints",
  "完整画布",
  "assets/web-layout-templates/",
  "不能依赖案例目录",
]) {
  if (!visualResourceGovernanceText.includes(token)) {
    fail(`视觉资源治理缺少案例—模板—项目风格边界：${token}`);
  }
}
for (const token of [
  "references/visual-resource-governance.md",
  "“看看、参考、分析”等要求",
  "新的或实质变化的视觉方向确认后才写入风格档案并进入这些下游",
  "自动选择只决定待确认样稿",
  "“太丑”本身不等于整体改版",
]) {
  if (!skillText.includes(token)) {
    fail(`SKILL.md 缺少视觉参考边界或完整画布确认：${token}`);
  }
}
for (const token of [
  "独立的作图前确认",
  "确认前不得创建网页",
  "只有用户明确要求“跳过确认，直接作图”",
  "最终上图文字",
  "画布宽高由筛选后的内容",
  "固定画布只表示成品不会随窗口响应式重排",
]) {
  if (!skillText.includes(token)) {
    fail(`SKILL.md 缺少静态作图前确认、内容筛选或内容决定尺寸合同：${token}`);
  }
}

const visualRoutingRegressionPath = ensurePath("assets/visual-resource-routing-regressions.json");
const visualRoutingRegressions = readJson(visualRoutingRegressionPath);
const requiredVisualRoutingScenarios = new Map([
  ["inspect-another-project-after-negative-feedback", "evidence-only"],
  ["content-similarity-is-not-adoption", "evidence-only"],
  ["explicit-visual-adoption", "explicit-visual-adoption"],
  ["layout-template-does-not-set-style", "layout-template-instantiation"],
  ["ugly-current-basis-is-not-redesign", "recompose-or-restyle"],
  ["content-removal-recomposes-canvas", "recompose"],
  ["tiny-type-uses-display-size", "typography-first-recompose"],
  ["explicit-pre-drawing-confirmation-blocks-production", "pre-drawing-confirmation"],
  ["content-curation-precedes-dimensions", "curate-confirm-size"],
]);
if (
  visualRoutingRegressions?.protocol !== "visual-multimedia-visual-resource-routing-regressions"
  || visualRoutingRegressions?.version !== 3
  || !Array.isArray(visualRoutingRegressions?.scenarios)
) {
  fail("视觉资源路由回归场景缺少活动协议或版本");
} else {
  const diagnosticEvidence = new Map(
    (visualRoutingRegressions.diagnostic_evidence || []).map((item) => [item.id, item]),
  );
  const mistakenSelectionEvidence = diagnosticEvidence.get("mistaken-case-selection-20260809");
  const currentFeedbackEvidence = diagnosticEvidence.get("current-feedback-chain");
  if (
    mistakenSelectionEvidence?.use !== "historical-diagnostic-only"
    || mistakenSelectionEvidence?.runtime_source !== false
    || currentFeedbackEvidence?.use !== "generalized-into-regression-scenarios"
    || currentFeedbackEvidence?.runtime_source !== false
  ) {
    fail("视觉资源路由回归没有把历史误选和当前反馈限定为诊断证据");
  } else {
    ensurePath(
      mistakenSelectionEvidence.path,
      "历史案例误选诊断证据",
    );
  }
  const scenarios = new Map(
    visualRoutingRegressions.scenarios.map((item) => [item.id, item]),
  );
  for (const [id, mode] of requiredVisualRoutingScenarios) {
    const scenario = scenarios.get(id);
    if (!scenario || scenario.expected_mode !== mode) {
      fail(`视觉资源路由回归缺少 ${id} → ${mode}`);
      continue;
    }
    if (!Array.isArray(scenario.preserve) || scenario.preserve.length === 0) {
      fail(`视觉资源路由回归 ${id} 没有声明必须保留的活动项目状态`);
    }
  }
  const inspectScenario = scenarios.get("inspect-another-project-after-negative-feedback");
  if (
    inspectScenario?.full_canvas_sample_before_export !== true
    || !inspectScenario?.preserve?.includes("active-style-profile")
    || !inspectScenario?.forbidden_reference_output?.includes("case-palette")
    || !inspectScenario?.forbidden_reference_output?.includes("case-layout-coordinates")
  ) {
    fail("负面反馈—查看另一项目回归没有保留活动风格、隔离案例表面并要求完整画布确认");
  }
  const uglyCurrentBasis = scenarios.get("ugly-current-basis-is-not-redesign");
  if (
    uglyCurrentBasis?.full_canvas_sample_before_export !== true
    || !uglyCurrentBasis?.preserve?.includes("editable-source")
    || !uglyCurrentBasis?.forbidden_actions?.includes("restart-from-blank")
    || !uglyCurrentBasis?.forbidden_actions?.includes("replace-layout-template-without-evidence")
  ) {
    fail("当前基础上的负面视觉反馈没有固定为诊断后重排或局部换装");
  }
  const contentRemoval = scenarios.get("content-removal-recomposes-canvas");
  if (
    !contentRemoval?.required_actions?.includes("recalculate-full-canvas")
    || !contentRemoval?.required_actions?.includes("remove-retired-dividers")
    || !contentRemoval?.required_actions?.includes("remove-retired-layout-branches")
  ) {
    fail("删减内容后的回归没有要求整张重排并退出旧分隔线与版式分支");
  }
  const tinyType = scenarios.get("tiny-type-uses-display-size");
  if (
    Number(tinyType?.minimum_primary_text_px) < 14
    || Number(tinyType?.comfortable_primary_text_px) < 16
    || !tinyType?.forbidden_actions?.includes("use-10px-technical-visibility-as-reading-quality")
  ) {
    fail("静态卡字号回归没有以实际展示宽度、14px 下限和 16px 舒适目标约束主要文字");
  }
  const preDrawingConfirmation = scenarios.get("explicit-pre-drawing-confirmation-blocks-production");
  if (
    preDrawingConfirmation?.allowed_skip !== "explicit-skip-confirmation-only"
    || !preDrawingConfirmation?.required_output?.includes("exact-visible-copy")
    || !preDrawingConfirmation?.required_output?.includes("proposed-content-derived-dimensions")
    || !preDrawingConfirmation?.required_output?.includes("typography-color-surface-direction")
    || !preDrawingConfirmation?.stop_before?.includes("html-css-generation")
    || !preDrawingConfirmation?.stop_before?.includes("image-generation")
    || !preDrawingConfirmation?.stop_before?.includes("template-instantiation")
    || !preDrawingConfirmation?.stop_before?.includes("canvas-drawing")
    || !preDrawingConfirmation?.forbidden_interpretations?.includes("complete-means-skip-confirmation")
    || !preDrawingConfirmation?.forbidden_interpretations?.includes("later-vague-request-overrides-explicit-confirmation")
  ) {
    fail("正式作图前确认回归没有提交完整确认包、停止生产或限制为显式跳过");
  }
  const contentCuration = scenarios.get("content-curation-precedes-dimensions");
  if (
    !contentCuration?.required_actions?.includes("remove-ai-filler")
    || !contentCuration?.required_actions?.includes("remove-audience-irrelevant-details")
    || !contentCuration?.required_actions?.includes("remove-repeated-facts-and-numbers")
    || !contentCuration?.required_actions?.includes("keep-each-fact-once")
    || !contentCuration?.required_actions?.includes("derive-dimensions-after-curation")
    || !contentCuration?.forbidden_actions?.includes("include-all-source-material")
    || !contentCuration?.forbidden_actions?.includes("inherit-template-source-dimensions")
  ) {
    fail("内容筛选—可读字号—内容决定尺寸回归没有阻止废话、重复信息和模板尺寸先行");
  }
}

const catalogPath = ensurePath("assets/web-card-cases/catalog.json");
const catalog = readJson(catalogPath);
if (
  catalog?.protocol !== "visual-multimedia-web-card-case-catalog"
  || catalog?.version !== 2
  || catalog?.default_role !== "production-evidence"
  || !catalog?.adoption_policies?.["explicit-visual-adoption-only"]
) {
  fail("网页案例目录没有使用 production-evidence v2 与显式视觉采用策略");
}
const legacyCaseCatalogFields = ["use_when", "reuse", "adapt"];
const caseIds = new Set();
for (const item of catalog?.cases || []) {
  if (!String(item.id || "").trim() || caseIds.has(item.id)) {
    fail(`网页案例目录存在空白或重复 id：${item.id || "<empty>"}`);
  }
  caseIds.add(item.id);
  for (const legacyField of legacyCaseCatalogFields) {
    if (Object.hasOwn(item, legacyField)) {
      fail(`案例 ${item.id} 仍保留会把内容匹配误写成视觉选择的旧字段 ${legacyField}`);
    }
  }
  if (
    !String(item.evidence_when || "").trim()
    || !Array.isArray(item.transferable_mechanisms)
    || item.transferable_mechanisms.length === 0
    || !Array.isArray(item.current_project_decisions)
    || item.current_project_decisions.length === 0
    || !Array.isArray(item.case_specific_visual_fingerprints)
    || item.case_specific_visual_fingerprints.length < 2
    || item.adoption_policy !== "explicit-visual-adoption-only"
    || !Array.isArray(item.verify)
    || item.verify.length === 0
  ) {
    fail(`案例 ${item.id} 缺少证据职责、可迁移机制、当前项目决定、案例指纹、采用策略或验收项`);
  }
}
const warmPaperCatalogEntry = (catalog?.cases || []).find(
  (item) => item.id === "warm-paper-project-list",
);
const warmPaperFingerprints = JSON.stringify(
  warmPaperCatalogEntry?.case_specific_visual_fingerprints || [],
);
for (const token of ["暖纸纹理", "超大描边期号", "金色星标", "整理贡献说明"]) {
  if (!warmPaperFingerprints.includes(token)) {
    fail(`暖纸项目清单案例没有登记会误导复刻的专属视觉指纹：${token}`);
  }
}

const layoutTemplateCatalogPath = ensurePath("assets/web-layout-templates/catalog.json");
const layoutTemplateCatalog = readJson(layoutTemplateCatalogPath);
const layoutTemplateScript = ensurePath("scripts/create-web-layout-template.mjs");
const staticCardQualitySelfTest = ensurePath("scripts/self-test-static-card-quality.mjs");
const layoutTemplateScriptText = fs.readFileSync(layoutTemplateScript, "utf8");
if (
  layoutTemplateCatalog?.protocol !== "visual-multimedia-web-layout-template-catalog"
  || layoutTemplateCatalog?.version !== 1
  || !Array.isArray(layoutTemplateCatalog?.templates)
  || layoutTemplateCatalog.templates.length === 0
) {
  fail("布局模板目录缺少活动协议、版本或真实模板");
}
if (
  !layoutTemplateScriptText.includes("fs.cpSync")
  || !layoutTemplateScriptText.includes("拒绝覆盖或合并")
  || !layoutTemplateScriptText.includes("visual_source: false")
) {
  fail("布局模板实例化入口没有复制真实包、拒绝覆盖现有项目或声明不提供视觉身份");
}
const layoutTemplateIds = new Set();
const layoutTemplateSourceProjects = [];
for (const item of layoutTemplateCatalog?.templates || []) {
  if (!String(item.id || "").trim() || layoutTemplateIds.has(item.id)) {
    fail(`布局模板目录存在空白或重复 id：${item.id || "<empty>"}`);
  }
  layoutTemplateIds.add(item.id);
  const relativeSource = String(item.source_package || "");
  const sourceRoot = path.resolve(skillRoot, relativeSource);
  const relativeToSkill = path.relative(skillRoot, sourceRoot);
  if (
    !relativeSource
    || relativeToSkill.startsWith("..")
    || path.isAbsolute(relativeToSkill)
    || relativeSource.replaceAll("\\", "/").includes("assets/web-card-cases/")
    || item.case_dependency !== "none"
    || item.style_policy?.visual_source !== false
    || item.style_policy?.default_surface !== "neutral-placeholder"
    || item.size_policy?.source_dimensions !== "placeholder"
    || item.size_policy?.project_dimensions !== "derive-from-confirmed-content"
    || item.instantiate?.script !== "scripts/create-web-layout-template.mjs"
  ) {
    fail(`布局模板 ${item.id} 没有保持 Skill 内来源、案例独立、视觉中性、内容决定项目尺寸或唯一实例化入口`);
    continue;
  }
  layoutTemplateSourceProjects.push(sourceRoot);
  const sourceManifestPath = path.join(sourceRoot, "editable-media.json");
  if (!fs.existsSync(sourceManifestPath)) {
    fail(`布局模板 ${item.id} 的真实源包缺少 editable-media.json：${sourceManifestPath}`);
    continue;
  }
  checkManifest(sourceManifestPath);
  const sourceManifest = readJson(sourceManifestPath);
  const sourceLayoutIds = new Set(
    (sourceManifest?.layout_contracts || []).map((contract) => contract.id),
  );
  const sourceFieldIds = new Set(
    (sourceManifest?.data_fields || []).map((field) => field.id),
  );
  if (
    !Array.isArray(item.layout_ids)
    || item.layout_ids.length === 0
    || item.layout_ids.some((id) => !sourceLayoutIds.has(id))
    || !Array.isArray(item.required_data_fields)
    || item.required_data_fields.some((id) => !sourceFieldIds.has(id))
    || !Number.isInteger(item.capacity?.maximum_primary_blocks)
  ) {
    fail(`布局模板 ${item.id} 的版式、字段或容量与真实源包不一致`);
  }
  if ((sourceManifest?.component?.tags || []).includes("static-card")) {
    const thumbnail = sourceManifest?.quality?.thumbnail;
    if (
      !thumbnail
      || Number(thumbnail.width) <= 0
      || Number(thumbnail.minimum_text_px) < 14
      || !Array.isArray(thumbnail.text_layer_ids)
      || thumbnail.text_layer_ids.length === 0
    ) {
      fail(`静态卡布局模板 ${item.id} 没有声明实际展示宽度与至少 14px 的主要阅读文字下限`);
    }
  }
}
const browserProjects = Array.from(new Set([
  path.dirname(starterManifest),
  ...layoutTemplateSourceProjects,
]));
const browserCaseQa = [];
const starterRuntime = ensurePath("assets/web-media-starter/editable-media-runtime.js");
const starterRuntimeHash = sha256File(starterRuntime);
const starterManifestDocument = readJson(starterManifest);
const starterIndexText = fs.readFileSync(
  ensurePath("assets/web-media-starter/index.html"),
  "utf8",
);
const starterEditorText = fs.readFileSync(
  ensurePath("assets/web-media-starter/editable-media-editor.js"),
  "utf8",
);
const starterEditorCssText = fs.readFileSync(
  ensurePath("assets/web-media-starter/editable-media-editor.css"),
  "utf8",
);
const starterTypographyPresets = readJson(
  ensurePath("assets/web-media-starter/typography-presets.json"),
);
const starterLauncherText = fs.readFileSync(
  ensurePath("assets/web-media-starter/_start_editable_preview.bat"),
  "utf8",
);
const starterServerText = fs.readFileSync(
  ensurePath("assets/web-media-starter/preview-server.py"),
  "utf8",
);
if (
  !starterManifestDocument?.resources?.includes("editable-media-editor.js")
  || !starterManifestDocument?.resources?.includes("editable-media-editor.css")
  || !starterManifestDocument?.resources?.includes("typography-presets.json")
  || !starterIndexText.includes('id="editableMediaEditorMount"')
  || !starterIndexText.includes('href="editable-media-editor.css"')
  || !starterIndexText.includes('src="editable-media-editor.js"')
  || !starterIndexText.includes("body.capture #editorPanel")
  || !starterEditorText.includes('id="editorPanel"')
  || !starterEditorText.includes('id="editorDownload"')
  || !starterEditorText.includes('id="editorPreview"')
  || !starterEditorText.includes("new FontFace")
  || starterEditorText.includes("document.fonts.check")
  || !starterEditorText.includes("data-editor-section")
  || !starterEditorCssText.includes(".editor-preview-expanded")
  || !starterEditorCssText.includes('[contenteditable="true"]')
  || starterTypographyPresets?.protocol !== "visual-multimedia-typography-presets"
  || starterTypographyPresets?.version !== 2
  || !Array.isArray(starterTypographyPresets?.profiles)
  || starterTypographyPresets.profiles.length < 8
  || ["fz-shuti-display", "fz-yaoti-display", "noto-sans-sc-black", "fz-xiangli-display", "zihun-4181-warm-child-shadow"]
    .some((id) => !starterTypographyPresets.profiles.some((profile) => profile.id === id))
  || starterTypographyPresets.profiles.some((profile) =>
    [profile.display, profile.body].some((role) =>
      !Array.isArray(role?.local_names) || role.local_names.length === 0 || "check_family" in role
    )
  )
  || !starterLauncherText.includes("preview-server.py")
  || starterLauncherText.toLowerCase().includes(".ps1")
  || !starterServerText.includes('parser.add_argument("--port", type=int, default=0)')
) {
  fail("DOM starter 没有保持可复用编辑器、字体预设、捕获隐藏与动态端口 BAT 预览入口");
}
if (!fs.readFileSync(starterRuntime, "utf8").includes("getCamera")) {
  fail("网页通用运行时没有暴露确定性 getCamera 接口");
}
const reactStarterRoot = ensurePath("assets/react-media-starter");
const reactDistRoot = ensurePath("assets/react-media-starter/dist");
const reactDistManifest = ensurePath("assets/react-media-starter/dist/editable-media.json");
checkManifest(reactDistManifest);
const reactRuntime = ensurePath("assets/react-media-starter/dist/editable-media-runtime.js");
if (sha256File(reactRuntime) !== starterRuntimeHash) {
  fail("React 参考成品没有消费当前唯一 editable-media v6 通用运行时");
}
const reactBuildInfo = readJson(ensurePath("assets/react-media-starter/dist/build-info.json"));
ensurePath("assets/react-media-starter/THIRD_PARTY_NOTICES.md");
ensurePath("assets/react-media-starter/dist/THIRD_PARTY_NOTICES.md");
if (
  reactBuildInfo?.protocol !== "editable-media-react-build"
  || reactBuildInfo?.editable_media_version !== 6
  || reactBuildInfo?.sourcemaps !== true
  || !reactBuildInfo?.lock_sha256
  || !reactBuildInfo?.source_sha256
) {
  fail("React 参考成品缺少依赖、锁摘要、源码摘要或 sourcemap 构建证据");
}
browserProjects.push(reactDistRoot);
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
  if (item.id === "technical-interface-comparison") {
    const caseManifest = readJson(manifestPath);
    const indexText = fs.readFileSync(path.join(caseRoot, "index.html"), "utf8");
    const sourceManifest = readJson(
      path.resolve(caseRoot, item.files?.sources || "media-sources.json")
    );
    if (
      !styleProfile?.applicability?.static_composition?.includes("static-card")
      || caseManifest?.scenes?.[0]?.motion?.complexity !== "static"
      || !indexText.includes("规则 · 数据 · 操作 · 结果")
      || indexText.includes("MediaFlow")
      || JSON.stringify(caseManifest).includes("编辑 · 查询 · 渲染 · 导出")
      || !(sourceManifest?.sources || []).some(
        (source) => source.id === "cheshire-avatar"
          && String(source?.rights?.license || "").includes("original authorship")
      )
    ) {
      fail("技术接口对比案例没有保持通用机制、静态消费者或已确认原创署名边界");
    }
  }
  if (item.id === "dark-icon-directory") {
    const caseManifest = readJson(manifestPath);
    const indexText = fs.readFileSync(path.join(caseRoot, "index.html"), "utf8");
    const fields = new Map(
      (caseManifest?.data_fields || []).map((field) => [field.id, field])
    );
    const sourceManifest = readJson(
      path.resolve(caseRoot, item.files?.sources || "media-sources.json")
    );
    const iconSource = (sourceManifest?.sources || []).find(
      (source) => source.id === "generated-icon-system"
    );
    if (
      !styleProfile?.applicability?.static_composition?.includes("static-card")
      || caseManifest?.component?.id !== "dark-icon-directory-card"
      || caseManifest?.scenes?.[0]?.content_shape !== "hero-title-and-eight-icon-grid"
      || fields.get("items")?.kind !== "table"
      || fields.get("items")?.default?.length !== 8
      || iconSource?.acquisition?.method !== "generated-in-project"
      || iconSource?.integrity !== null
      || ["Codex Plugins", "Computer Use", "Chrome", "HyperFrames", "GitHub", "Vercel"]
        .some((token) => indexText.includes(token) || JSON.stringify(caseManifest).includes(token))
    ) {
      fail("深色图标目录案例没有保持八项可编辑目录、原创图标来源或品牌隔离边界");
    }
  }
  if (item.id === "handdrawn-system-collaboration-flow") {
    const caseManifest = readJson(manifestPath);
    const indexText = fs.readFileSync(path.join(caseRoot, "index.html"), "utf8");
    const exportText = fs.readFileSync(path.join(caseRoot, item.files?.export || "export-video.mjs"), "utf8");
    const noticesText = fs.readFileSync(path.join(caseRoot, item.files?.notices || "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const output of ["web-animation", "gif", "web-derived-video"]) {
      if (!styleProfile?.applicability?.time_motion?.includes(output)) {
        fail(`手绘系统协同案例的 time_motion 没有声明 ${output}`);
      }
    }
    for (const flowId of [
      "trigger", "agentClient", "clientServer", "serverTools", "toolsDecision",
      "yesHuman", "humanShared", "sharedFeedback", "feedbackAgent", "noShared",
      "serverStateDown", "stateServerUp",
    ]) {
      const count = (indexText.match(new RegExp(`flow\\(\"${flowId}\"`, "g")) || []).length;
      if (count !== 1) fail(`手绘系统协同案例的 ${flowId} 语义路径应且只应触发一次，实际 ${count} 次`);
    }
    for (const token of ["yuv420p", "avc1", "bt709", "+faststart"]) {
      if (!exportText.includes(token)) fail(`手绘系统协同案例的移动端导出缺少 ${token}`);
    }
    if (
      caseManifest?.scenes?.[0]?.motion?.key_state_review !== "required"
      || !caseManifest?.resources?.includes("style-profile.json")
      || !caseManifest?.resources?.includes("assets/fonts/Xiaolai-Regular.ttf")
      || !noticesText.includes("Lucide Static 1.28.0")
      || !noticesText.includes("SIL Open Font License 1.1")
      || !fs.existsSync(path.join(caseRoot, "LICENSE.lucide-icons.txt"))
      || !fs.readFileSync(path.join(caseRoot, "LICENSE.lucide-icons.txt"), "utf8").includes("Copyright (c) 2013-present Cole Bemis")
      || !fs.existsSync(path.join(caseRoot, "assets/fonts/Xiaolai-OFL.txt"))
    ) {
      fail("手绘系统协同案例缺少关键状态、完整字体、图标许可或风格档案边界");
    }
  }
  if (item.files?.qa) {
    browserCaseQa.push({ caseRoot, script: path.join(caseRoot, item.files.qa) });
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

const videoProgressRoot = ensurePath("assets/video-progress-bar");
const videoProgressManifestPath = path.join(videoProgressRoot, "editable-media.json");
checkManifest(videoProgressManifestPath);
const videoProgressRuntime = path.join(videoProgressRoot, "editable-media-runtime.js");
if (
  !fs.existsSync(videoProgressRuntime)
  || sha256File(videoProgressRuntime) !== starterRuntimeHash
) {
  fail("视频进度条没有消费当前唯一 editable-media 通用运行时");
}
const videoProgressSpec = readJson(path.join(videoProgressRoot, "video-progress-bar-spec.json"));
const videoProgressManifest = readJson(videoProgressManifestPath);
const videoProgressScene = videoProgressManifest?.scenes?.find((scene) => scene.id === "progress");
if (
  videoProgressSpec?.protocol !== "visual-multimedia-video-progress-bar"
  || videoProgressManifest?.default_variant_id !== videoProgressSpec?.variant_id
  || videoProgressScene?.duration_ms !== videoProgressSpec?.duration_ms
  || videoProgressScene?.data?.lead_label !== videoProgressSpec?.lead_label
  || videoProgressScene?.data?.traveler_mode !== videoProgressSpec?.traveler_mode
  || JSON.stringify(videoProgressScene?.data?.chapters) !== JSON.stringify(videoProgressSpec?.chapters)
) {
  fail("横向分段进度栏的首格、游标、时长、输出变体或章节真源没有保持一致");
}
browserProjects.push(videoProgressRoot);

const shotRecipeValidation = validateShotRecipeLibrary();
if (!shotRecipeValidation.ok) {
  shotRecipeValidation.errors.forEach((message) => fail(`镜头配方库：${message}`));
} else if (
  shotRecipeValidation.recipes.filter((item) => item.document.source_id === "video-shotcraft").length !== 104
  || shotRecipeValidation.recipes.filter((item) => item.document.source_id === "video-shotcraft").flatMap((item) => item.document.styles).length !== 161
  || shotRecipeValidation.recipes.filter((item) => item.document.source_id === "video-shotcraft").flatMap((item) => item.document.styles).some((style) => style.status !== "reference-only")
  || shotRecipeValidation.catalog.active_style_count !== 14
  || shotRecipeValidation.recipes.filter((item) => item.document.category === "explanatory-broll" && item.document.status === "active").length !== 10
) {
  fail("镜头配方目录没有保持 104 张来源配方、161 个仅参考变体、十类解释型 B-roll 和 14 个活动样式的证据边界");
}

const videoProfileValidation = validateVideoProductionProfileCatalog();
if (!videoProfileValidation.ok) {
  videoProfileValidation.errors.forEach((message) => fail(`视频生产 profile：${message}`));
}

{
  const commentaryProfiles = (videoProfileValidation.catalog?.profiles || []).filter(
    (item) => item.id === "source-video-commentary" && item.status === "active",
  );
  if (
    commentaryProfiles.length !== 1
    || commentaryProfiles[0]?.version !== "1.0.0"
    || commentaryProfiles[0]?.public_entry !== "scripts/source-video-commentary.mjs"
  ) {
    fail("素材解说型视频必须只启用通过正式项目入口消费的 1.0.0 profile");
  }
  const commentaryProfile = readJson(
    path.join(skillRoot, "assets", "video-production-profiles", "source-video-commentary", "1.0.0", "profile.json"),
  );
  const profileText = JSON.stringify(commentaryProfile);
  for (const token of [
    "narration-only",
    "source-only",
    "narration-with-source-bed",
    "clip-selections.json",
    "project.mfp",
    "integrated-sample",
    "speech.synthesize",
    "background_music",
    "source-video-commentary-analysis.v1.schema.json",
  ]) {
    if (!profileText.includes(token)) fail(`素材解说型 profile 缺少活动边界：${token}`);
  }
  for (const token of [
    "references/source-video-commentary-production.md",
    "source-video-commentary@1.0.0",
  ]) {
    if (!skillText.includes(token)) fail(`SKILL.md 缺少素材解说型正式路由：${token}`);
  }
  const draftStarter = readJson(path.join(skillRoot, "assets", "source-video-commentary-starter", "source-video-commentary-draft.json"));
  const narrationStarter = readJson(path.join(skillRoot, "assets", "source-video-commentary-starter", "narration-bundle.json"));
  for (const message of validateJsonSchema(draftStarter, path.join(skillRoot, "schemas", "source-video-commentary-draft.v1.schema.json"))) {
    fail(`素材解说 draft starter：${message}`);
  }
  for (const message of validateJsonSchema(narrationStarter, path.join(skillRoot, "schemas", "narration-bundle.v1.schema.json"))) {
    fail(`素材解说 narration starter：${message}`);
  }
  const planSchemaText = fs.readFileSync(path.join(skillRoot, "schemas", "source-video-commentary-plan.v1.schema.json"), "utf8");
  if (planSchemaText.includes('"start_seconds"') || planSchemaText.includes('"end_seconds"')) {
    fail("素材解说 production plan schema 复制了 clip selection 的源素材入点或出点");
  }
  for (const script of [
    "source-video-commentary.mjs",
    "source_video_commentary_preproduction.mjs",
    "source_video_commentary_contract.mjs",
    "source_video_commentary_render.mjs",
    "self-test-source-video-commentary-preproduction.mjs",
    "self-test-source-video-commentary.mjs",
  ]) {
    runChecked(process.execPath, ["--check", path.join(scriptDir, script)], `素材解说型脚本语法检查：${script}`);
  }
  runChecked(process.execPath, [path.join(scriptDir, "source-video-commentary.mjs"), "list-profiles"], "素材解说型公开 profile 入口检查");
}

if (failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "render-color-palette-library.mjs"), "--validate-only"],
    "六张典型配色卡、颜色职责与文字对比度检查",
  );
}

if (failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-production-providers.mjs")],
    "MediaFlow Pro 优先—本地完整能力—HyperFrames 明确选择路由检查",
  );
}

if (failures.length === 0) {
  runChecked(
    process.execPath,
    [layoutTemplateScript, "list"],
    "案例独立的中性布局模板目录与公开实例化入口检查",
  );
}

if (runBrowserChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-editable-preview.mjs")],
    "DOM starter 的 BAT 启动—可见编辑—刷新保留—恢复—导出真实用户链检查",
  );
}

if (runBrowserChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-visual-variable-drift.mjs")],
    "真实网页包的风格档案—主题变量—画布与声明图层漂移提醒检查",
  );
}

if (runBrowserChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-explanatory-broll.mjs")],
    "十类解释型 B-roll—九种布局—Gallery 动画预览浏览器检查",
  );
}

if (runFullChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-source-video-commentary-preproduction.mjs")],
    "素材解说型原始源片入账—镜头分析—写作包—音乐—authoring—profile 迁移检查",
  );
}

if (runFullChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(reactStarterRoot, "scripts", "verify-reproducible-build.mjs")],
    "React editable-media 可复现构建",
    reactStarterRoot
  );
}

if (runBrowserChecks && failures.length === 0) {
  const validator = path.join(scriptDir, "validate-editable-media.mjs");
  runChecked(
    process.execPath,
    [staticCardQualitySelfTest],
    "静态卡完整缩略图合同与实际显示字号硬失败回归"
  );
  for (const project of browserProjects) {
    runChecked(process.execPath, [validator, project], `浏览器验证：${project}`);
  }
  for (const item of browserCaseQa) {
    const output = path.join(skillRoot, "artifacts", "web-card-case-qa", path.basename(item.caseRoot));
    runChecked(process.execPath, [item.script, item.caseRoot, output], `案例几何与运动验证：${item.caseRoot}`);
  }
}

if (runFullChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-production-captions.mjs")],
    "真实转写—生产字幕—便携字幕—短语质检检查",
  );
}

if (runBrowserChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-video-progress-bar.mjs")],
    "真实视频参数—透明进度条包—章节跳转—确定性浏览器消费者检查",
  );
}

if (runBrowserChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-product-promo.mjs")],
    "镜头配方—真实页面采集—产品计划—通用构建—浏览器—节拍真实链路检查",
  );
}

if (runFullChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-github-project-intro.mjs")],
    "GitHub 项目介绍注册语音—非 GUI/网页证据—双语字幕—MediaFlow 构建—审阅交付真实链路检查",
  );
}

if (runFullChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-source-video-commentary.mjs"), "--provider", "local"],
    "素材解说型三种逐段声音职责—综合样片—portable timeline—完整审看—source bundle 交付真实链路检查",
  );
}

if (runBrowserChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-text-motion-library.mjs")],
    "文字动效真源—生成目录—编辑状态—确定性浏览器消费者检查",
  );
}

if (runBrowserChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-local-web-render.mjs")],
    "editable-media 网页真源—本地浏览器逐帧—MP4/GIF 真实导出检查",
  );
}

if (runFullChecks && failures.length === 0) {
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

if (runFullChecks && failures.length === 0) {
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-media-timeline.mjs")],
    "可移植时间线—画面—定格—音频—双语字幕—改真源再导出检查",
  );
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
  runChecked(
    process.execPath,
    [path.join(scriptDir, "self-test-explanatory-broll.mjs"), "--mediaflow"],
    "导演计划—活动模板选择—真实时间投影—MediaFlow Pro 时间线—五种导出真实链路检查",
  );
}

{
  const requiredVoiceoverReferenceTokens = [
    "references/voiceover-writing.md",
    "references/voiceover-reference-library.md",
    "references/voiceover-hook-library.md",
    "scripts/voiceover_reference_library.py",
    "scripts/voiceover_hook_library.py",
    "口播声音",
    "完整案例",
    "独立口播钩子",
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
    "贡献事实、关系或推进",
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
  if (runFullChecks && failures.length === 0) {
    runChecked(
      voiceoverPython,
      [path.join(scriptDir, "self-test-voiceover-reference-library.py")],
      "口播私人库 v3 声音、完整案例、索引与去重检查"
    );
    runChecked(
      voiceoverPython,
      [path.join(scriptDir, "self-test-voiceover-hook-library.py")],
      "独立口播钩子生产、最少字段、索引与案例隔离检查"
    );
  }
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
  if (runFullChecks && failures.length === 0) {
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
  }

  if (runFullChecks && failures.length === 0) {
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

  for (const token of [
    "references/product-promo-production.md",
    "产品功能宣传片",
  ]) {
    if (!skillText.includes(token)) fail(`SKILL.md 缺少产品宣传片正式路由：${token}`);
  }
  for (const token of [
    "references/github-project-intro-production.md",
    "create → validate → plan → confirm-plan → render → review → finalize",
    "game.honkai-star-rail.silverwolf.default",
  ]) {
    if (!skillText.includes(token)) fail(`SKILL.md 缺少 GitHub 项目介绍正式路由：${token}`);
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
  const activeProductProfiles = (videoProfileCatalog?.profiles || []).filter(
    (item) => item.id === "product-promo" && item.status === "active"
  );
  if (
    activeProductProfiles.length !== 1
    || activeProductProfiles[0]?.version !== "1.0.0"
    || activeProductProfiles[0]?.public_entry !== "scripts/product-promo.mjs"
  ) {
    fail("产品宣传片必须只启用通过正式项目入口消费的 1.0.0 profile");
  }
  const activeGithubIntroProfiles = (videoProfileCatalog?.profiles || []).filter(
    (item) => item.id === "github-project-intro" && item.status === "active"
  );
  if (
    activeGithubIntroProfiles.length !== 1
    || activeGithubIntroProfiles[0]?.version !== "1.0.0"
    || activeGithubIntroProfiles[0]?.public_entry !== "scripts/github-project-intro.mjs"
  ) {
    fail("GitHub 项目介绍必须只启用通过正式项目入口消费的 1.0.0 profile");
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
    "video-production-profile-catalog.mjs",
    "shot-recipe-library.mjs",
    "create-video-direction-plan.mjs",
    "validate-video-direction-plan.mjs",
    "explanatory-broll-studio.mjs",
    "self-test-explanatory-broll.mjs",
    "create-video-progress-bar.mjs",
    "self-test-video-progress-bar.mjs",
    "migrate-video-shotcraft-recipes.mjs",
    "product-promo.mjs",
    "product_promo_runtime.mjs",
    "mediaflow_video_common.mjs",
    "media_operation_run.mjs",
    "standard_video_delivery.mjs",
    "github-project-intro.mjs",
    "self-test-github-project-intro.mjs",
    "capture-product-ui.mjs",
    "analyze-music-beats.mjs",
    "self-test-product-promo.mjs",
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
  if (runFullChecks && failures.length === 0) {
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
}

if (failures.length > 0) {
  failures.forEach((message) => console.error(`FAIL ${message}`));
  console.error(`visual-multimedia 未通过：${failures.length} 个问题`);
  process.exit(1);
}

const successMessages = {
  fast: `visual-multimedia fast 通过：静态合同、schema、资源索引、许可证、${catalog?.cases?.length || 0} 个网页案例、${layoutTemplateCatalog?.templates?.length || 0} 个中性布局模板与脚本入口均通过验证`,
  browser: `visual-multimedia browser 通过：fast 档位、${browserProjects.length} 个真实网页包、确定性时间、透明视频进度条、文字动效与产品功能宣传片浏览器链路均通过验证`,
  full: `visual-multimedia full 通过：browser 档位、${textMotionValidation.effects?.length || 0} 个确定性文字动效、透明视频进度条、最终媒体案例、口播私人库、注册资源、真实代理、视频导演、产品功能宣传片、GitHub 项目介绍、素材解说型与采访原声讲解型完整链路均通过验证`,
};
console.log(successMessages[checkMode]);
