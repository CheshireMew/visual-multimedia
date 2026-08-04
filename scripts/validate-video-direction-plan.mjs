#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateMediaSources } from "./validate-media-sources.mjs";
import { validateJsonSchema } from "./json_schema_contract.mjs";
import { readEditableMediaPackage } from "./editable-media-contract.mjs";
import { sha256Tree } from "./shot-recipe-library.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT_SCHEMA = path.resolve(SCRIPT_DIR, "..", "schemas", "shot-recipe.v2.schema.json");
const SOURCE_KINDS = ["human", "screen-recording", "evidence", "explanatory-broll", "packaging"];
const RELATIONSHIPS = [
  "process", "phase-timeline", "layered-framework", "causal-loop",
  "input-output-toolchain", "comparison-matrix", "decompose-assemble",
  "metric-dashboard", "evidence-before-after", "layout",
];
const PLACEMENTS = ["full-frame", "presenter-split", "transparent-overlay"];
const ASPECTS = ["16:9", "9:16", "1:1"];

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, label, required, errors) {
  if (!isObject(value)) {
    errors.push(`${label} 必须是对象`);
    return false;
  }
  const keys = Object.keys(value);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${label} 缺少字段 ${key}`);
  }
  for (const key of keys) {
    if (!required.includes(key)) errors.push(`${label} 包含未知字段 ${key}`);
  }
  return true;
}

function nonEmptyString(value, label, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} 必须是非空字符串`);
    return false;
  }
  return true;
}

function id(value, label, errors) {
  if (!nonEmptyString(value, label, errors)) return false;
  if (!ID_PATTERN.test(value)) {
    errors.push(`${label} 只能包含小写字母、数字、点、下划线和连字符`);
    return false;
  }
  return true;
}

function dateTime(value, label, errors) {
  if (!nonEmptyString(value, label, errors)) return false;
  if (!Number.isFinite(new Date(value).getTime())) {
    errors.push(`${label} 不是有效日期时间`);
    return false;
  }
  return true;
}

function projectFile(projectRoot, relative, label, errors) {
  if (!nonEmptyString(relative, label, errors)) return null;
  const absolute = path.resolve(projectRoot, relative);
  const rel = path.relative(projectRoot, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    errors.push(`${label} 必须位于项目目录内`);
    return null;
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    errors.push(`${label} 指向的文件不存在：${absolute}`);
    return null;
  }
  return absolute;
}

function uniqueStrings(value, label, errors, { minItems = 0, ids = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组`);
    return [];
  }
  if (value.length < minItems) errors.push(`${label} 至少需要 ${minItems} 项`);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (ids) id(item, `${label}[${index}]`, errors);
    else nonEmptyString(item, `${label}[${index}]`, errors);
    if (seen.has(item)) errors.push(`${label} 包含重复项 ${item}`);
    seen.add(item);
  }
  return value;
}

function validateApproval(value, label, errors) {
  if (!exactObject(value, label, ["status", "confirmed_at", "evidence"], errors)) {
    return;
  }
  if (value.status !== "approved") errors.push(`${label}.status 必须是 approved`);
  dateTime(value.confirmed_at, `${label}.confirmed_at`, errors);
  nonEmptyString(value.evidence, `${label}.evidence`, errors);
}

function validateSourceRefs(value, label, prefix, errors) {
  const refs = uniqueStrings(value, label, errors, { minItems: 1 });
  for (const ref of refs) {
    if (typeof ref === "string" && !ref.startsWith(prefix)) {
      errors.push(`${label} 的 ${ref} 没有引用当前来源版本 ${prefix}`);
    }
    if (typeof ref === "string" && !ref.includes("#")) {
      errors.push(`${label} 的 ${ref} 缺少可核对位置`);
    }
  }
}

function validateBrief(brief, sourcePrefix, errors) {
  if (!exactObject(
    brief,
    "content_brief",
    [
      "audience",
      "promise",
      "core_claim",
      "supporting_points",
      "required_facts",
      "risk_flags",
    ],
    errors
  )) return;
  for (const key of ["audience", "promise", "core_claim"]) {
    nonEmptyString(brief[key], `content_brief.${key}`, errors);
  }
  if (!Array.isArray(brief.supporting_points) || brief.supporting_points.length === 0) {
    errors.push("content_brief.supporting_points 至少需要一项");
  } else {
    const ids = new Set();
    brief.supporting_points.forEach((item, index) => {
      const label = `content_brief.supporting_points[${index}]`;
      if (!exactObject(item, label, ["id", "text", "source_refs"], errors)) return;
      id(item.id, `${label}.id`, errors);
      if (ids.has(item.id)) errors.push(`${label}.id 重复：${item.id}`);
      ids.add(item.id);
      nonEmptyString(item.text, `${label}.text`, errors);
      validateSourceRefs(item.source_refs, `${label}.source_refs`, sourcePrefix, errors);
    });
  }
  for (const [key, fields] of [
    ["required_facts", ["text", "source_refs"]],
    ["risk_flags", ["risk", "handling", "source_refs"]],
  ]) {
    if (!Array.isArray(brief[key])) {
      errors.push(`content_brief.${key} 必须是数组`);
      continue;
    }
    brief[key].forEach((item, index) => {
      const label = `content_brief.${key}[${index}]`;
      if (!exactObject(item, label, fields, errors)) return;
      for (const field of fields.filter((field) => field !== "source_refs")) {
        nonEmptyString(item[field], `${label}.${field}`, errors);
      }
      validateSourceRefs(item.source_refs, `${label}.source_refs`, sourcePrefix, errors);
    });
  }
}

function validateNarration(narration, sourcePrefix, errors) {
  if (!exactObject(
    narration,
    "narration",
    ["status", "text", "sha256", "source_refs", "major_editorial_changes"],
    errors
  )) return;
  if (narration.status !== "confirmed") {
    errors.push("narration.status 必须是 confirmed");
  }
  if (nonEmptyString(narration.text, "narration.text", errors)) {
    const actual = sha256Buffer(Buffer.from(narration.text, "utf8"));
    if (narration.sha256 !== actual) {
      errors.push("narration.sha256 与实际确认旁白不一致");
    }
  }
  if (!SHA_PATTERN.test(narration.sha256 || "")) {
    errors.push("narration.sha256 必须是 SHA-256");
  }
  validateSourceRefs(narration.source_refs, "narration.source_refs", sourcePrefix, errors);
  if (!Array.isArray(narration.major_editorial_changes)) {
    errors.push("narration.major_editorial_changes 必须是数组");
    return;
  }
  const ids = new Set();
  narration.major_editorial_changes.forEach((item, index) => {
    const label = `narration.major_editorial_changes[${index}]`;
    if (!exactObject(
      item,
      label,
      ["id", "summary", "source_refs", "approval"],
      errors
    )) return;
    id(item.id, `${label}.id`, errors);
    if (ids.has(item.id)) errors.push(`${label}.id 重复：${item.id}`);
    ids.add(item.id);
    nonEmptyString(item.summary, `${label}.summary`, errors);
    validateSourceRefs(item.source_refs, `${label}.source_refs`, sourcePrefix, errors);
    validateApproval(item.approval, `${label}.approval`, errors);
  });
}

function validatePresenter(presenter, projectRoot, errors) {
  if (!exactObject(
    presenter,
    "presenter",
    ["mode", "source_id", "approval"],
    errors
  )) return;
  if (!["human", "none"].includes(presenter.mode)) {
    errors.push("presenter.mode 必须是 human 或 none");
  }
  validateApproval(presenter.approval, "presenter.approval", errors);
  if (presenter.mode === "human") {
    id(presenter.source_id, "presenter.source_id", errors);
  } else if (presenter.mode === "none") {
    if (presenter.source_id !== null) errors.push("none 出镜的 source_id 必须是 null");
  }
  if (presenter.source_id !== null) {
    const manifestPath = path.join(projectRoot, "media-sources.json");
    if (!fs.existsSync(manifestPath)) {
      errors.push("presenter.source_id 存在时项目必须提供 media-sources.json");
      return;
    }
    const validation = validateMediaSources(manifestPath);
    if (!validation.ok) {
      validation.errors.forEach((item) => errors.push(`出镜素材账本：${item}`));
      return;
    }
    const source = validation.sources.find((item) => item.id === presenter.source_id);
    if (!source) {
      errors.push(`presenter.source_id 不存在于素材账本：${presenter.source_id}`);
    } else {
      if (source.representation?.kind !== "source") {
        errors.push("出镜素材必须引用正式 source，不能引用代理");
      }
      if (source.rights?.status !== "confirmed") {
        errors.push("真人出镜素材的权利状态必须是 confirmed");
      }
    }
  }
}

function validatedMediaSourceIds(projectRoot, sourceIds, label, errors) {
  const ids = uniqueStrings(sourceIds, `${label}.source_ids`, errors, {ids: true});
  if (!ids.length) return;
  const manifestPath = path.join(projectRoot, "media-sources.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`${label}.source_ids 存在时项目必须提供 media-sources.json`);
    return;
  }
  const validation = validateMediaSources(manifestPath);
  if (!validation.ok) {
    validation.errors.forEach((item) => errors.push(`${label} 素材账本：${item}`));
    return;
  }
  const available = new Set(validation.sources.map((item) => item.id));
  ids.filter((item) => !available.has(item)).forEach(
    (item) => errors.push(`${label}.source_ids 不存在于素材账本：${item}`),
  );
}

function validateVisualPlan(visual, scene, label, projectRoot, errors) {
  if (!exactObject(
    visual,
    `${label}.visual_plan`,
    [
      "source_kind", "source_ids", "relationship_kind", "placement_mode",
      "aspect_ratio", "selection_reason", "recipe",
    ],
    errors,
  )) return;
  if (!SOURCE_KINDS.includes(visual.source_kind)) errors.push(`${label}.visual_plan.source_kind 无效`);
  if (visual.relationship_kind !== null && !RELATIONSHIPS.includes(visual.relationship_kind)) {
    errors.push(`${label}.visual_plan.relationship_kind 无效`);
  }
  if (!PLACEMENTS.includes(visual.placement_mode)) errors.push(`${label}.visual_plan.placement_mode 无效`);
  if (!ASPECTS.includes(visual.aspect_ratio)) errors.push(`${label}.visual_plan.aspect_ratio 无效`);
  nonEmptyString(visual.selection_reason, `${label}.visual_plan.selection_reason`, errors);
  if (["human", "screen-recording", "evidence"].includes(visual.source_kind)) {
    if (!Array.isArray(visual.source_ids)) {
      errors.push(`${label}.visual_plan.source_ids 必须是数组`);
    } else if (visual.source_ids.length) {
      validatedMediaSourceIds(projectRoot, visual.source_ids, `${label}.visual_plan`, errors);
    } else if (visual.source_kind !== "evidence" || scene.generation_job_ids.length === 0) {
      errors.push(`${label}.visual_plan 必须绑定现有 source_ids，或由 generation_job_ids 明确生成证据素材`);
    }
    if (visual.recipe !== null) errors.push(`${label}.visual_plan.recipe 必须是 null`);
    return;
  }
  uniqueStrings(visual.source_ids, `${label}.visual_plan.source_ids`, errors, {ids: true});
  if (visual.source_kind === "explanatory-broll" && visual.relationship_kind === null) {
    errors.push(`${label}.visual_plan.relationship_kind 不能为 null`);
  }
  const recipeLabel = `${label}.visual_plan.recipe`;
  if (!exactObject(
    visual.recipe,
    recipeLabel,
    ["recipe_id", "style_id", "variant_id", "selection"],
    errors,
  )) return;
  id(visual.recipe.recipe_id, `${recipeLabel}.recipe_id`, errors);
  id(visual.recipe.style_id, `${recipeLabel}.style_id`, errors);
  id(visual.recipe.variant_id, `${recipeLabel}.variant_id`, errors);
  const binding = visual.recipe.selection;
  if (!exactObject(binding, `${recipeLabel}.selection`, ["file", "sha256", "bytes"], errors)) return;
  const selectionPath = projectFile(projectRoot, binding.file, `${recipeLabel}.selection.file`, errors);
  if (!SHA_PATTERN.test(binding.sha256 || "")) errors.push(`${recipeLabel}.selection.sha256 必须是 SHA-256`);
  if (!Number.isInteger(binding.bytes) || binding.bytes < 1) errors.push(`${recipeLabel}.selection.bytes 必须是正整数`);
  if (!selectionPath) return;
  if (sha256File(selectionPath) !== binding.sha256) errors.push(`${recipeLabel}.selection.sha256 与实际文件不一致`);
  if (fs.statSync(selectionPath).size !== binding.bytes) errors.push(`${recipeLabel}.selection.bytes 与实际文件不一致`);
  let selection;
  try {
    selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
  } catch (error) {
    errors.push(`${recipeLabel}.selection 无法读取：${error.message}`);
    return;
  }
  validateJsonSchema(selection, SHOT_SCHEMA).forEach((item) => errors.push(`${recipeLabel}.selection：${item}`));
  const expected = {
    segment_id: scene.segment_id,
    visual_source_kind: visual.source_kind,
    relationship_kind: visual.relationship_kind,
    placement_mode: visual.placement_mode,
    aspect_ratio: visual.aspect_ratio,
    selection_reason: visual.selection_reason,
    recipe_id: visual.recipe.recipe_id,
    style_id: visual.recipe.style_id,
    variant_id: visual.recipe.variant_id,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (selection[key] !== value) errors.push(`${recipeLabel}.selection.${key} 没有冻结当前导演判断`);
  }
  const packageRoot = path.resolve(projectRoot, ...(selection.package || "").split("/"));
  const relative = path.relative(projectRoot, packageRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(packageRoot, {throwIfNoEntry: false})?.isDirectory()) {
    errors.push(`${recipeLabel}.selection.package 不是项目内真实目录`);
    return;
  }
  if (sha256Tree(packageRoot) !== selection.package_sha256) errors.push(`${recipeLabel}.selection.package_sha256 与实际包不一致`);
  try {
    const editable = readEditableMediaPackage(packageRoot);
    if (sha256File(editable.manifestPath) !== selection.manifest_sha256) errors.push(`${recipeLabel}.selection.manifest_sha256 与实际清单不一致`);
    if (!editable.manifest.scenes.some((item) => item.id === selection.scene_id)) errors.push(`${recipeLabel}.selection.scene_id 不存在`);
    if (!editable.manifest.variants.some((item) => item.id === selection.variant_id)) errors.push(`${recipeLabel}.selection.variant_id 不存在`);
  } catch (error) {
    errors.push(`${recipeLabel}.selection.package 无法作为 editable-media 读取：${error.message}`);
  }
}

export function validateVideoDirectionPlan(filePath) {
  const absolute = path.resolve(filePath);
  const projectRoot = path.dirname(absolute);
  const errors = [];
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`无法读取导演计划：${error.message}`], plan: null };
  }
  if (!exactObject(
    plan,
    "导演计划",
    [
      "protocol",
      "version",
      "project",
      "content_brief",
      "narration",
      "pronunciations",
      "presenter",
      "generation_jobs",
      "scenes",
    ],
    errors
  )) return { ok: false, errors, plan };
  if (plan.protocol !== "visual-multimedia-video-direction") {
    errors.push("protocol 必须是 visual-multimedia-video-direction");
  }
  if (plan.version !== 2) errors.push("version 必须是 2");
  if (!exactObject(
    plan.project,
    "project",
    [
      "media_project_id",
      "source",
      "media_script_version",
      "authoring_input_sha256",
      "created_at",
    ],
    errors
  )) return { ok: false, errors, plan };
  id(plan.project.media_project_id, "project.media_project_id", errors);
  nonEmptyString(plan.project.media_script_version, "project.media_script_version", errors);
  if (!SHA_PATTERN.test(plan.project.authoring_input_sha256 || "")) {
    errors.push("project.authoring_input_sha256 必须是 SHA-256");
  }
  dateTime(plan.project.created_at, "project.created_at", errors);
  const source = plan.project.source;
  if (!exactObject(
    source,
    "project.source",
    ["source_id", "source_version", "content_unit_id", "snapshot"],
    errors
  )) return { ok: false, errors, plan };
  id(source.source_id, "project.source.source_id", errors);
  nonEmptyString(source.source_version, "project.source.source_version", errors);
  id(source.content_unit_id, "project.source.content_unit_id", errors);
  const sourcePrefix = `${source.source_id}@${source.source_version}#`;
  if (exactObject(
    source.snapshot,
    "project.source.snapshot",
    ["file", "sha256", "bytes"],
    errors
  )) {
    const snapshot = projectFile(
      projectRoot,
      source.snapshot.file,
      "project.source.snapshot.file",
      errors
    );
    if (!SHA_PATTERN.test(source.snapshot.sha256 || "")) {
      errors.push("project.source.snapshot.sha256 必须是 SHA-256");
    }
    if (!Number.isInteger(source.snapshot.bytes) || source.snapshot.bytes < 1) {
      errors.push("project.source.snapshot.bytes 必须是正整数");
    }
    if (snapshot) {
      if (sha256File(snapshot) !== source.snapshot.sha256) {
        errors.push("源快照实际 SHA-256 与计划不一致");
      }
      if (fs.statSync(snapshot).size !== source.snapshot.bytes) {
        errors.push("源快照实际字节数与计划不一致");
      }
    }
  }
  validateBrief(plan.content_brief, sourcePrefix, errors);
  validateNarration(plan.narration, sourcePrefix, errors);
  if (!Array.isArray(plan.pronunciations)) {
    errors.push("pronunciations 必须是数组");
  } else {
    const written = new Set();
    plan.pronunciations.forEach((item, index) => {
      const label = `pronunciations[${index}]`;
      if (!exactObject(item, label, ["written", "spoken", "note"], errors)) return;
      nonEmptyString(item.written, `${label}.written`, errors);
      nonEmptyString(item.spoken, `${label}.spoken`, errors);
      if (typeof item.note !== "string") errors.push(`${label}.note 必须是字符串`);
      if (written.has(item.written)) errors.push(`${label}.written 重复：${item.written}`);
      written.add(item.written);
    });
  }
  validatePresenter(plan.presenter, projectRoot, errors);
  if (plan.generation_jobs !== "generation-jobs.json") {
    errors.push("generation_jobs 必须指向项目唯一的 generation-jobs.json");
  }
  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    errors.push("scenes 至少需要一项");
  } else {
    const segmentIds = new Set();
    plan.scenes.forEach((scene, index) => {
      const label = `scenes[${index}]`;
      if (!exactObject(
        scene,
        label,
        [
          "segment_id",
          "source_refs",
          "purpose",
          "voiceover_ref",
          "visual_plan",
          "timing",
          "generation_job_ids",
        ],
        errors
      )) return;
      id(scene.segment_id, `${label}.segment_id`, errors);
      if (segmentIds.has(scene.segment_id)) {
        errors.push(`${label}.segment_id 重复：${scene.segment_id}`);
      }
      segmentIds.add(scene.segment_id);
      validateSourceRefs(scene.source_refs, `${label}.source_refs`, sourcePrefix, errors);
      for (const field of ["purpose", "voiceover_ref"]) {
        nonEmptyString(scene[field], `${label}.${field}`, errors);
      }
      if (
        typeof scene.voiceover_ref === "string"
        && !/^narration#.+/.test(scene.voiceover_ref)
      ) errors.push(`${label}.voiceover_ref 必须引用确认旁白 narration#...`);
      validateVisualPlan(scene.visual_plan, scene, label, projectRoot, errors);
      if (exactObject(
        scene.timing,
        `${label}.timing`,
        ["source", "estimated_seconds"],
        errors
      )) {
        if (!["text-estimate", "real-speech", "existing-media", "fixed-spec"].includes(
          scene.timing.source
        )) errors.push(`${label}.timing.source 无效`);
        if (
          typeof scene.timing.estimated_seconds !== "number"
          || !Number.isFinite(scene.timing.estimated_seconds)
          || scene.timing.estimated_seconds <= 0
        ) errors.push(`${label}.timing.estimated_seconds 必须是正数`);
      }
      uniqueStrings(
        scene.generation_job_ids,
        `${label}.generation_job_ids`,
        errors,
        { ids: true }
      );
    });
  }
  return { ok: errors.length === 0, errors, plan };
}

function main() {
  if (
    process.argv.length !== 3
    || process.argv.includes("--help")
    || process.argv.includes("-h")
  ) {
    console.log("用法：node scripts/validate-video-direction-plan.mjs <video-direction-plan.json>");
    return process.argv.length === 3 ? 0 : 1;
  }
  const result = validateVideoDirectionPlan(process.argv[2]);
  if (!result.ok) {
    for (const error of result.errors) console.error(`错误：${error}`);
    return 1;
  }
  console.log(JSON.stringify({
    ok: true,
    file: path.resolve(process.argv[2]),
    media_project_id: result.plan.project.media_project_id,
    source_version: result.plan.project.source.source_version,
    scenes: result.plan.scenes.length,
    generation_job_ids: [
      ...new Set(result.plan.scenes.flatMap((scene) => scene.generation_job_ids)),
    ],
  }, null, 2));
  return 0;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
