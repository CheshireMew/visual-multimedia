#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {
  assertEditableMediaPackageClosed,
  validateEditableMediaSchema,
} from "./editable-media-contract.mjs";
import {validateJsonSchema} from "./json_schema_contract.mjs";
import {
  EDITABLE_MEDIA_SOURCES_CONTRACT,
  validateMediaSources,
} from "./validate-media-sources.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const TEMPLATE_ROOT = path.join(SKILL_ROOT, "assets", "video-progress-bar");
const SPEC_SCHEMA = path.join(SKILL_ROOT, "schemas", "video-progress-bar-spec.v1.schema.json");

function usage() {
  console.log(`用法：
node scripts/create-video-progress-bar.mjs --spec <进度条参数.json> --output <新网页包目录>

输出目录必须不存在。脚本会生成与真实视频总时长、章节起点、画布比例和上下位置一致的
editable-media v6 透明网页包，不会覆盖已有成品。`);
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
    if (args.has(key)) throw new Error(`参数 --${key} 重复`);
    args.set(key, argv[index + 1]);
    index += 1;
  }
  for (const key of args.keys()) {
    if (!["spec", "output"].includes(key)) throw new Error(`未知参数 --${key}`);
  }
  return args;
}

function required(args, key) {
  const value = args.get(key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少必需参数 --${key}`);
  }
  return value;
}

function readJson(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${label}不存在：${absolute}`);
  }
  try {
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error.message}`);
  }
}

function stableText(value) {
  const stable = (item) => Array.isArray(item)
    ? item.map(stable)
    : (item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])]))
      : item);
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function validateSpec(spec) {
  const errors = validateJsonSchema(spec, SPEC_SCHEMA);
  if (typeof spec.lead_label === "string" && spec.lead_label.length > 16) {
    errors.push("$.lead_label 不能超过 16 个字符");
  }
  for (const [index, chapter] of (Array.isArray(spec.chapters) ? spec.chapters : []).entries()) {
    if (typeof chapter?.label === "string" && chapter.label.length > 24) {
      errors.push(`$.chapters[${index}].label 不能超过 24 个字符`);
    }
  }
  if (Array.isArray(spec.chapters) && spec.chapters.length > 0) {
    if (spec.chapters[0]?.start_ms !== 0) errors.push("第一个章节必须从 0 毫秒开始");
    spec.chapters.forEach((chapter, index) => {
      if (index > 0 && chapter.start_ms <= spec.chapters[index - 1].start_ms) {
        errors.push(`章节 ${index + 1} 的 start_ms 必须严格晚于前一个章节`);
      }
      if (Number.isInteger(spec.duration_ms) && chapter.start_ms >= spec.duration_ms) {
        errors.push(`章节 ${index + 1} 的 start_ms 必须早于视频总时长`);
      }
    });
  }
  return errors;
}

function chapterStep(chapter, index, count) {
  const final = index === count - 1;
  return {
    id: `chapter-${index + 1}`,
    at_ms: chapter.start_ms,
    label: chapter.label,
    state_kind: index === 0 ? "start" : (final ? "result" : "change"),
    review: true,
    description: `进度到达第 ${index + 1} 章“${chapter.label}”。`,
  };
}

function mirrorBoundsForBottom(manifest) {
  const variantById = new Map(manifest.variants.map((variant) => [variant.id, variant]));
  const landscape = variantById.get("landscape");
  const shellTop = landscape.layers["progress-shell"].y;
  const shellHeight = landscape.layers["progress-shell"].height;
  const landscapeDelta = landscape.canvas.height - shellTop - shellHeight - shellTop;
  manifest.layers.forEach((layer) => {
    layer.default_bounds.y += landscapeDelta;
  });
  manifest.variants.forEach((variant) => {
    const shell = variant.layers["progress-shell"];
    const delta = variant.canvas.height - shell.y - shell.height - shell.y;
    Object.values(variant.layers).forEach((bounds) => {
      if (Number.isFinite(bounds.y)) bounds.y += delta;
    });
  });
}

function projectHtml(html, spec, canvas) {
  const durationSeconds = Number((spec.duration_ms / 1000).toFixed(3));
  return html
    .replace(/data-duration="[^"]+"/u, `data-duration="${durationSeconds}"`)
    .replace(/data-width="[^"]+"/u, `data-width="${canvas.width}"`)
    .replace(/data-height="[^"]+"/u, `data-height="${canvas.height}"`)
    .replace(
      /(data-fps="[^"]+"\s+data-progress-placement)="[^"]+"/u,
      `$1="${spec.placement}"`,
    );
}

function writeGeneratedPackage(candidate, spec) {
  const manifestPath = path.join(candidate, "editable-media.json");
  const manifest = readJson(manifestPath, "模板清单");
  const scene = manifest.scenes.find((item) => item.id === "progress");
  if (!scene) throw new Error("模板清单缺少 progress 场景");
  const data = {
    lead_label: spec.lead_label,
    traveler_mode: spec.traveler_mode,
    chapters: spec.chapters,
  };
  scene.duration_ms = spec.duration_ms;
  scene.primary_blocks = spec.chapters.length;
  scene.steps = spec.chapters.map((chapter, index) => chapterStep(chapter, index, spec.chapters.length));
  scene.data = data;
  manifest.default_variant_id = spec.variant_id;
  manifest.data_fields.forEach((field) => {
    if (Object.hasOwn(data, field.id)) field.default = data[field.id];
  });
  if (spec.placement === "bottom") mirrorBoundsForBottom(manifest);

  const schemaErrors = validateEditableMediaSchema(manifest);
  if (schemaErrors.length) {
    throw new Error(`生成清单没有通过 editable-media v6：\n- ${schemaErrors.join("\n- ")}`);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(candidate, "video-progress-bar-spec.json"), stableText(spec), "utf8");
  const defaultVariant = manifest.variants.find((item) => item.id === spec.variant_id);
  const htmlPath = path.join(candidate, manifest.entry);
  fs.writeFileSync(
    htmlPath,
    projectHtml(fs.readFileSync(htmlPath, "utf8"), spec, defaultVariant.canvas),
    "utf8",
  );

  assertEditableMediaPackageClosed(candidate, manifest);
  const mediaValidation = validateMediaSources(
    path.join(candidate, manifest.media_sources),
    {contract: EDITABLE_MEDIA_SOURCES_CONTRACT},
  );
  if (!mediaValidation.ok) {
    throw new Error(`生成包的素材账本无效：\n- ${mediaValidation.errors.join("\n- ")}`);
  }
  return manifest;
}

export function createVideoProgressBar(specPath, outputPath) {
  const spec = readJson(specPath, "进度条参数");
  const errors = validateSpec(spec);
  if (errors.length) throw new Error(`进度条参数无效：\n- ${errors.join("\n- ")}`);

  const output = path.resolve(outputPath);
  if (fs.existsSync(output)) throw new Error(`输出目录已经存在，拒绝覆盖：${output}`);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, {recursive: true});
  const candidate = `${output}.candidate`;
  if (fs.existsSync(candidate)) {
    throw new Error(`候选目录已经存在，请先人工检查或归档：${candidate}`);
  }
  fs.cpSync(TEMPLATE_ROOT, candidate, {recursive: true, errorOnExist: true, force: false});
  let manifest;
  try {
    manifest = writeGeneratedPackage(candidate, spec);
  } catch (error) {
    throw new Error(`${error.message}\n未完成的候选包保留在：${candidate}`);
  }
  fs.renameSync(candidate, output);
  return {
    output,
    duration_ms: spec.duration_ms,
    chapters: spec.chapters.length,
    variant_id: spec.variant_id,
    placement: spec.placement,
    manifest,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const args = parseArgs(argv);
  const result = createVideoProgressBar(required(args, "spec"), required(args, "output"));
  console.log(JSON.stringify({
    created: true,
    output: result.output,
    duration_ms: result.duration_ms,
    chapters: result.chapters,
    variant_id: result.variant_id,
    placement: result.placement,
  }, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  }
}
