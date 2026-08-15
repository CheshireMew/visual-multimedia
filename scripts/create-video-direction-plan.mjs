#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { validateVideoDirectionPlan } from "./validate-video-direction-plan.mjs";
import { materializeShotRecipe } from "./shot-recipe-library.mjs";
import { assertSkillTaskPath } from "./media-task-workspace.mjs";

const DRAFT_FIELDS = [
  "media_project_id",
  "source_id",
  "source_version",
  "content_unit_id",
  "media_script_version",
  "content_brief",
  "narration",
  "pronunciations",
  "presenter",
  "scenes",
];

function usage() {
  console.log(`用法：
node scripts/create-video-direction-plan.mjs --project <项目目录>
  --source <已确认内容文件> --draft <导演输入.json>
  [--created-at <ISO 日期时间>]

导演输入只保存创意判断；本脚本绑定真实来源快照、输入哈希和旁白哈希，
并为解释型 B-roll / 包装画面自动选择、物化和冻结活动镜头配方，
并写入项目唯一的 video-direction-plan.json。相同输入幂等复用，不覆盖变化后的计划。`);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    args.set(key, argv[index + 1]);
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少必需参数 --${key}`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isoDate(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("--created-at 不是有效日期时间");
  return date.toISOString();
}

function ensureProjectFile(projectRoot, filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${label}不存在：${absolute}`);
  }
  return absolute;
}

function snapshotSource(projectRoot, sourcePath) {
  const buffer = fs.readFileSync(sourcePath);
  if (buffer.length === 0) throw new Error("已确认内容文件不能为空");
  const digest = sha256(buffer);
  const extension = path.extname(sourcePath).toLowerCase();
  const destination = path.join(
    projectRoot,
    "direction",
    "source-snapshots",
    "by-sha256",
    digest.slice(0, 2),
    `${digest}${extension}`
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination);
    if (sha256(existing) !== digest) {
      throw new Error(`内容寻址快照冲突：${destination}`);
    }
  } else {
    fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
  }
  return {
    file: path.relative(projectRoot, destination).split(path.sep).join("/"),
    sha256: digest,
    bytes: buffer.length,
  };
}

function validateDraft(draft) {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("导演输入根节点必须是对象");
  }
  const missing = DRAFT_FIELDS.filter((field) => !Object.hasOwn(draft, field));
  const unknown = Object.keys(draft).filter((field) => !DRAFT_FIELDS.includes(field));
  if (missing.length > 0) throw new Error(`导演输入缺少字段：${missing.join(", ")}`);
  if (unknown.length > 0) throw new Error(`导演输入包含未知字段：${unknown.join(", ")}`);
  if (draft.narration?.status !== "confirmed") {
    throw new Error("导演输入的 narration.status 必须是 confirmed");
  }
  if (!Array.isArray(draft.scenes) || draft.scenes.length === 0) {
    throw new Error("导演输入至少需要一个 scenes 项");
  }
  for (const [index, scene] of draft.scenes.entries()) {
    const visual = scene?.visual_plan;
    if (!visual || typeof visual !== "object" || Array.isArray(visual)) {
      throw new Error(`scenes[${index}].visual_plan 必须是对象`);
    }
    const fields = [
      "source_kind", "source_ids", "relationship_kind", "placement_mode",
      "aspect_ratio", "selection_reason", "recipe",
    ];
    const missingVisual = fields.filter((field) => !Object.hasOwn(visual, field));
    const unknownVisual = Object.keys(visual).filter((field) => !fields.includes(field));
    if (missingVisual.length) {
      throw new Error(`scenes[${index}].visual_plan 缺少字段：${missingVisual.join(", ")}`);
    }
    if (unknownVisual.length) {
      throw new Error(`scenes[${index}].visual_plan 包含未知字段：${unknownVisual.join(", ")}`);
    }
  }
}

function materializeVisualPlan(projectRoot, scene) {
  const visual = scene.visual_plan;
  if (!["explanatory-broll", "packaging"].includes(visual.source_kind)) {
    if (visual.recipe !== null) {
      throw new Error(`${scene.segment_id} 的 ${visual.source_kind} 画面不能绑定镜头配方`);
    }
    return {...visual, recipe: null};
  }
  const intent = visual.recipe;
  if (intent !== null && (typeof intent !== "object" || Array.isArray(intent))) {
    throw new Error(`${scene.segment_id}.visual_plan.recipe 必须是对象或 null`);
  }
  const materialized = materializeShotRecipe({
    projectRoot,
    recipeId: intent?.recipe_id || null,
    styleId: intent?.style_id || null,
    variantId: intent?.variant_id || null,
    segmentId: scene.segment_id,
    visualSourceKind: visual.source_kind,
    relationshipKind: visual.relationship_kind,
    placementMode: visual.placement_mode,
    aspectRatio: visual.aspect_ratio,
    selectionReason: visual.selection_reason,
  });
  const stat = fs.statSync(materialized.selection);
  return {
    ...visual,
    recipe: {
      recipe_id: materialized.document.recipe_id,
      style_id: materialized.document.style_id,
      variant_id: materialized.document.variant_id,
      selection: {
        file: path.relative(projectRoot, materialized.selection).split(path.sep).join("/"),
        sha256: sha256(fs.readFileSync(materialized.selection)),
        bytes: stat.size,
      },
    },
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const args = parseArgs(argv);
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`项目目录不存在：${projectRoot}`);
  }
  const sourcePath = ensureProjectFile(
    projectRoot,
    required(args, "source"),
    "已确认内容"
  );
  const draftPath = ensureProjectFile(
    projectRoot,
    required(args, "draft"),
    "导演输入"
  );
  const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
  validateDraft(draft);
  const authoringInputSha256 = sha256(Buffer.from(canonicalJson(draft), "utf8"));
  const snapshot = snapshotSource(projectRoot, sourcePath);
  const plan = {
    protocol: "visual-multimedia-video-direction",
    version: 2,
    project: {
      media_project_id: draft.media_project_id,
      source: {
        source_id: draft.source_id,
        source_version: draft.source_version,
        content_unit_id: draft.content_unit_id,
        snapshot,
      },
      media_script_version: draft.media_script_version,
      authoring_input_sha256: authoringInputSha256,
      created_at: isoDate(args.get("created-at")),
    },
    content_brief: draft.content_brief,
    narration: {
      ...draft.narration,
      sha256: sha256(Buffer.from(draft.narration.text, "utf8")),
    },
    pronunciations: draft.pronunciations,
    presenter: draft.presenter,
    generation_jobs: "generation-jobs.json",
    scenes: draft.scenes.map((scene) => ({
      ...scene,
      visual_plan: materializeVisualPlan(projectRoot, scene),
    })),
  };
  const output = path.join(projectRoot, "video-direction-plan.json");
  if (fs.existsSync(output)) {
    const existingValidation = validateVideoDirectionPlan(output);
    if (!existingValidation.ok) {
      throw new Error(
        "现有 video-direction-plan.json 无效，拒绝覆盖：\n"
          + existingValidation.errors.map((item) => `- ${item}`).join("\n")
      );
    }
    const existing = existingValidation.plan;
    if (
      existing.project.authoring_input_sha256 !== authoringInputSha256
      || existing.project.source.snapshot.sha256 !== snapshot.sha256
      || existing.project.source.source_version !== draft.source_version
    ) {
      throw new Error(
        "现有导演计划绑定了不同来源或导演输入；请先建立新的明确版本，脚本不会静默覆盖"
      );
    }
    console.log(JSON.stringify({
      created: false,
      reused: true,
      file: output,
      source_sha256: snapshot.sha256,
      authoring_input_sha256: authoringInputSha256,
    }, null, 2));
    return 0;
  }
  const candidate = `${output}.candidate`;
  fs.writeFileSync(candidate, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const validation = validateVideoDirectionPlan(candidate);
  if (!validation.ok) {
    throw new Error(
      "导演计划候选未通过验证，活动计划未写入：\n"
        + validation.errors.map((item) => `- ${item}`).join("\n")
    );
  }
  fs.renameSync(candidate, output);
  console.log(JSON.stringify({
    created: true,
    reused: false,
    file: output,
    source_sha256: snapshot.sha256,
    authoring_input_sha256: authoringInputSha256,
    scenes: plan.scenes.length,
  }, null, 2));
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
