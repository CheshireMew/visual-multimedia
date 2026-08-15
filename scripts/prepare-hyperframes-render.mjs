#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertEditableMediaPackageClosed,
  readEditableMediaPackage,
  resolvePackageReference,
} from "./editable-media-contract.mjs";
import { assertSkillTaskPath } from "./media-task-workspace.mjs";

function usage() {
  console.log(
    "用法：node scripts/prepare-hyperframes-render.mjs "
      + "<网页包目录或 editable-media.json> --variant <id> --output <空目录>\n"
      + "生成只供 HyperFrames 渲染的工作副本；原网页包不会被修改。"
  );
}

function parseArgs(argv) {
  const source = argv.find((value) => !value.startsWith("-"));
  const variantIndex = argv.indexOf("--variant");
  const outputIndex = argv.indexOf("--output");
  if (
    !source
    || variantIndex < 0
    || !argv[variantIndex + 1]
    || outputIndex < 0
    || !argv[outputIndex + 1]
  ) {
    throw new Error("必须提供网页包、--variant 和 --output");
  }
  return {
    source,
    variantId: argv[variantIndex + 1],
    output: argv[outputIndex + 1],
  };
}

function setAttribute(tag, name, value = null) {
  const pattern = new RegExp(`\\s${name}(?:=(?:\"[^\"]*\"|'[^']*'|[^\\s>]+))?`, "i");
  const replacement = value === null ? ` ${name}` : ` ${name}="${String(value)}"`;
  if (pattern.test(tag)) return tag.replace(pattern, replacement);
  return tag.replace(/>$/, `${replacement}>`);
}

function addClass(tag, className) {
  const pattern = /\sclass=(["'])(.*?)\1/i;
  const match = tag.match(pattern);
  if (!match) return tag.replace(/>$/, ` class="${className}">`);
  const names = match[2].split(/\s+/).filter(Boolean);
  if (names.includes(className)) return tag;
  return tag.replace(pattern, ` class="${[...names, className].join(" ")}"`);
}

function prepare(sourceValue, variantId, outputValue) {
  const {
    packageRoot: sourceRoot,
    manifest,
  } = readEditableMediaPackage(sourceValue);
  assertEditableMediaPackageClosed(sourceRoot, manifest);
  const variant = (manifest.variants || []).find((item) => item.id === variantId);
  if (!variant) throw new Error(`找不到输出变体：${variantId}`);
  const durationSeconds = (manifest.scenes || []).reduce(
    (sum, scene) => sum + Number(scene.duration_ms || 0),
    0
  ) / 1000;
  if (!(durationSeconds > 0)) throw new Error("网页包总时长必须大于 0");

  const outputRoot = assertSkillTaskPath(path.resolve(outputValue), "--output");
  if (fs.existsSync(outputRoot)) {
    throw new Error(`输出目录已经存在：${outputRoot}`);
  }
  fs.cpSync(sourceRoot, outputRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  const copiedManifestPath = path.join(outputRoot, "editable-media.json");
  const copiedManifest = {
    ...manifest,
    default_variant_id: variant.id,
  };
  fs.writeFileSync(
    copiedManifestPath,
    `${JSON.stringify(copiedManifest, null, 2)}\n`,
    "utf8"
  );

  const entryPath = resolvePackageReference(outputRoot, manifest.entry, "entry");
  let html = fs.readFileSync(entryPath, "utf8");
  const rootPattern = /<[^>]+\sdata-editable-media-root(?:\s|>)[^>]*>/i;
  const rootMatches = html.match(new RegExp(rootPattern.source, "gi")) || [];
  if (rootMatches.length !== 1) {
    throw new Error("入口 HTML 必须有且只有一个 data-editable-media-root");
  }
  let rootTag = rootMatches[0];
  rootTag = setAttribute(rootTag, "data-composition-id", "editable-media");
  rootTag = setAttribute(rootTag, "data-no-timeline");
  rootTag = setAttribute(rootTag, "data-start", "0");
  rootTag = setAttribute(rootTag, "data-duration", durationSeconds);
  rootTag = setAttribute(rootTag, "data-width", variant.canvas.width);
  rootTag = setAttribute(rootTag, "data-height", variant.canvas.height);
  rootTag = setAttribute(rootTag, "data-fps", manifest.playback.fps);
  html = html.replace(rootPattern, rootTag);
  const bodyPattern = /<body\b[^>]*>/i;
  const bodyMatches = html.match(/<body\b[^>]*>/gi) || [];
  if (bodyMatches.length !== 1) {
    throw new Error("入口 HTML 必须有且只有一个 body");
  }
  html = html.replace(bodyPattern, addClass(bodyMatches[0], "capture"));
  fs.writeFileSync(entryPath, html, "utf8");

  return {
    source: sourceRoot,
    output: outputRoot,
    variant: variant.id,
    width: variant.canvas.width,
    height: variant.canvas.height,
    duration_seconds: durationSeconds,
    fps: manifest.playback.fps,
    composition: manifest.entry,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const args = parseArgs(argv);
  const result = prepare(args.source, args.variantId, args.output);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
