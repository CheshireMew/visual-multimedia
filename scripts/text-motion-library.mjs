#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "./json_schema_contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
export const skillRoot = path.resolve(scriptDir, "..");
export const libraryRoot = path.join(skillRoot, "assets", "text-motion-library");
export const effectsRoot = path.join(libraryRoot, "effects");
export const schemaPath = path.join(skillRoot, "schemas", "text-motion.v1.schema.json");
export const libraryPath = path.join(libraryRoot, "library.json");
export const catalogPath = path.join(libraryRoot, "catalog.json");
export const galleryBasePath = path.join(libraryRoot, "editable-media.base.json");
export const galleryManifestPath = path.join(libraryRoot, "editable-media.json");
export const galleryRuntimePath = path.join(libraryRoot, "editable-media-runtime.js");
export const starterRuntimePath = path.join(
  skillRoot,
  "assets",
  "web-media-starter",
  "editable-media-runtime.js"
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function stableText(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizedSearch(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

const SEARCH_EXPANSIONS = Object.freeze({
  whole: "整段 整体",
  grapheme: "逐字 逐字素 字符",
  word: "逐词 词组",
  line: "逐行 行级",
  calm: "克制 柔和 低强度",
  moderate: "适中 中等",
  expressive: "鲜明 强烈 高强度",
  enter: "进入 入场",
  exit: "退出 出场",
  replace: "替换 切换",
  emphasis: "强调 循环",
});

export function effectFingerprint(effect) {
  return sha256(JSON.stringify(stable({
    segmentation: effect.segmentation,
    timing: effect.timing,
    renderer: effect.renderer,
  })));
}

export function loadTextMotionLibrary() {
  return readJson(libraryPath);
}

export function loadEffects() {
  return fs.readdirSync(effectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(effectsRoot, entry.name);
      return {
        filePath,
        fileName: entry.name,
        document: readJson(filePath),
        bytes: fs.readFileSync(filePath),
      };
    })
    .sort((left, right) =>
      String(left.document.id).localeCompare(String(right.document.id), "en")
    );
}

function validateTrack(track, label, errors) {
  if (!Array.isArray(track) || track.length < 2) return;
  if (track[0].offset !== 0) errors.push(`${label} 必须从 offset 0 开始`);
  if (track[track.length - 1].offset !== 1) {
    errors.push(`${label} 必须在 offset 1 结束`);
  }
  for (let index = 1; index < track.length; index += 1) {
    if (!(track[index].offset > track[index - 1].offset)) {
      errors.push(`${label} 的 offset 必须严格递增`);
      break;
    }
  }
}

function validateEffectSemantics(effect, fileName, sourceIds, errors) {
  if (`${effect.id}.json` !== fileName) {
    errors.push(`${fileName} 的文件名与 effect id ${effect.id} 不一致`);
  }
  if (!effect.intent.operations.includes(effect.intent.default_operation)) {
    errors.push(`${effect.id} 的 default_operation 不在 operations 中`);
  }
  for (const sourceId of effect.source_ids) {
    if (!sourceIds.has(sourceId)) {
      errors.push(`${effect.id} 引用了不存在的来源 ${sourceId}`);
    }
  }
  const hasEmphasis = effect.intent.operations.includes("emphasis");
  if (hasEmphasis !== Boolean(effect.timing.emphasis)) {
    errors.push(`${effect.id} 的 emphasis 操作与 timing.emphasis 不一致`);
  }
  if (hasEmphasis !== Boolean(effect.renderer.tracks.emphasis)) {
    errors.push(`${effect.id} 的 emphasis 操作与 renderer.tracks.emphasis 不一致`);
  }
  if (effect.renderer.kind === "shimmer" && !hasEmphasis) {
    errors.push(`${effect.id} 的 shimmer renderer 必须提供 emphasis 操作`);
  }
  if (
    effect.segmentation.unit === "line"
    && effect.segmentation.layout_measurement !== "visual-lines"
  ) {
    errors.push(`${effect.id} 的逐行动效必须使用 visual-lines 测量`);
  }
  if (
    effect.segmentation.unit !== "line"
    && effect.segmentation.layout_measurement !== "none"
  ) {
    errors.push(`${effect.id} 不是逐行动效，不能声明行测量`);
  }
  if (
    effect.constraints.layout_sensitive !== effect.host.requires_final_width
  ) {
    errors.push(`${effect.id} 的布局敏感性与 host.requires_final_width 不一致`);
  }
  if (
    effect.host.requires_final_width
    && effect.host.sizing !== "layout-slot"
  ) {
    errors.push(`${effect.id} 需要最终宽度时必须使用 layout-slot host`);
  }
  if (
    effect.timing.replace.mode === "sequential"
    && effect.timing.replace.overlap_ms !== 0
  ) {
    errors.push(`${effect.id} 的 sequential 替换不能声明 overlap_ms`);
  }
  if (effect.timing.replace.overlap_ms > effect.timing.exit.duration_ms) {
    errors.push(`${effect.id} 的 overlap_ms 不能超过单元退出时长`);
  }
  for (const [name, track] of Object.entries(effect.renderer.tracks)) {
    validateTrack(track, `${effect.id}.renderer.tracks.${name}`, errors);
  }
  const reviewIds = new Set();
  for (const state of effect.review.key_states) {
    if (!effect.intent.operations.includes(state.operation)) {
      errors.push(`${effect.id} 的审阅状态 ${state.id} 使用了未支持操作 ${state.operation}`);
    }
    const key = `${state.operation}:${state.id}`;
    if (reviewIds.has(key)) errors.push(`${effect.id} 的审阅状态重复：${key}`);
    reviewIds.add(key);
  }
  const defaultStates = effect.review.key_states.filter(
    (state) => state.operation === effect.intent.default_operation
  );
  if (!defaultStates.some((state) => state.at === 0)) {
    errors.push(`${effect.id} 的默认操作缺少 at=0 审阅状态`);
  }
  if (!defaultStates.some((state) => state.at === 1)) {
    errors.push(`${effect.id} 的默认操作缺少 at=1 审阅状态`);
  }
}

export function buildCatalogDocument(library, effects) {
  return {
    protocol: "visual-multimedia-text-motion-catalog",
    version: 1,
    library_version: library.library_version,
    effect_count: effects.length,
    effects: effects.map(({ document, bytes }) => ({
      id: document.id,
      name: document.name,
      aliases: document.aliases,
      path: `effects/${document.id}.json`,
      sha256: sha256(bytes),
      behavior_fingerprint: effectFingerprint(document),
      operations: document.intent.operations,
      default_operation: document.intent.default_operation,
      unit: document.segmentation.unit,
      energy: document.intent.energy,
      host_sizing: document.host.sizing,
      requires_final_width: document.host.requires_final_width,
      motion_intensity: document.constraints.motion_intensity,
      recommended_max_graphemes: document.constraints.recommended_max_graphemes,
      recommended_max_lines: document.constraints.recommended_max_lines,
      semantic_tags: document.intent.semantic_tags,
      purpose: document.intent.purpose,
      status: document.status,
    })),
  };
}

export function buildGalleryManifest(base, effects) {
  return {
    ...base,
    resources: [
      "editable-media-runtime.js",
      "text-motion-runtime.js",
      "text-motion-binding.js",
      "library.json",
      "catalog.json",
      "THIRD_PARTY_NOTICES.md",
      ...effects.map(({ document }) => `effects/${document.id}.json`),
    ],
  };
}

export function validateTextMotionLibrary() {
  const errors = [];
  const library = loadTextMotionLibrary();
  const librarySchema = validateJsonSchema(library, schemaPath);
  errors.push(...librarySchema.map((message) => `library.json：${message}`));
  const sourceIds = new Set();
  for (const source of library.sources || []) {
    if (sourceIds.has(source.id)) errors.push(`library.json 的来源 ID 重复：${source.id}`);
    sourceIds.add(source.id);
  }

  const effects = loadEffects();
  if (effects.length === 0) errors.push("效果目录不能为空");
  const effectIds = new Set();
  const names = new Set();
  const fingerprints = new Map();
  for (const effect of effects) {
    const result = validateJsonSchema(effect.document, schemaPath);
    errors.push(
      ...result.map((message) => `${effect.fileName}：${message}`)
    );
    if (effectIds.has(effect.document.id)) {
      errors.push(`效果 ID 重复：${effect.document.id}`);
    }
    effectIds.add(effect.document.id);
    const normalizedName = normalizedSearch(effect.document.name);
    if (names.has(normalizedName)) errors.push(`效果名称重复：${effect.document.name}`);
    names.add(normalizedName);
    validateEffectSemantics(
      effect.document,
      effect.fileName,
      sourceIds,
      errors
    );
    const fingerprint = effectFingerprint(effect.document);
    if (fingerprints.has(fingerprint)) {
      errors.push(
        `效果 ${effect.document.id} 与 ${fingerprints.get(fingerprint)} 的行为完全重复`
      );
    } else {
      fingerprints.set(fingerprint, effect.document.id);
    }
  }

  const expectedCatalog = buildCatalogDocument(library, effects);
  if (!fs.existsSync(catalogPath)) {
    errors.push("缺少生成目录 catalog.json；请运行 build");
  } else {
    const catalog = readJson(catalogPath);
    const catalogSchema = validateJsonSchema(catalog, schemaPath);
    errors.push(...catalogSchema.map((message) => `catalog.json：${message}`));
    if (stableText(catalog) !== stableText(expectedCatalog)) {
      errors.push("catalog.json 没有由当前效果真源生成；请运行 build");
    }
  }

  if (!fs.existsSync(galleryBasePath)) {
    errors.push("缺少 editable-media.base.json");
  } else if (!fs.existsSync(galleryManifestPath)) {
    errors.push("缺少生成画廊清单 editable-media.json；请运行 build");
  } else {
    const expectedManifest = buildGalleryManifest(readJson(galleryBasePath), effects);
    if (stableText(readJson(galleryManifestPath)) !== stableText(expectedManifest)) {
      errors.push("editable-media.json 没有由当前效果目录生成；请运行 build");
    }
  }
  if (!fs.existsSync(galleryRuntimePath)) {
    errors.push("画廊缺少 editable-media 通用运行时快照；请运行 build");
  } else if (
    !fs.existsSync(starterRuntimePath)
    || !fs.readFileSync(galleryRuntimePath).equals(fs.readFileSync(starterRuntimePath))
  ) {
    errors.push("画廊没有消费当前唯一 editable-media 通用运行时；请运行 build");
  }
  for (const required of [
    "index.html",
    "media-sources.json",
    "text-motion-runtime.js",
    "text-motion-binding.js",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    if (!fs.existsSync(path.join(libraryRoot, required))) {
      errors.push(`画廊缺少 ${required}`);
    }
  }
  for (const runtimeName of [
    "text-motion-runtime.js",
    "text-motion-binding.js",
  ]) {
    const motionRuntimePath = path.join(libraryRoot, runtimeName);
    if (!fs.existsSync(motionRuntimePath)) continue;
    const runtimeText = fs.readFileSync(motionRuntimePath, "utf8");
    for (const forbidden of [
      "setTimeout(",
      "setInterval(",
      "requestAnimationFrame(",
      ".animate(",
      "new Animation(",
    ]) {
      if (runtimeText.includes(forbidden)) {
        errors.push(`${runtimeName} 不能启动独立时钟或动画：${forbidden}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, library, effects };
}

export function buildTextMotionLibrary() {
  const library = loadTextMotionLibrary();
  const effects = loadEffects();
  const preliminaryErrors = [];
  const sourceIds = new Set(library.sources.map((source) => source.id));
  const librarySchema = validateJsonSchema(library, schemaPath);
  preliminaryErrors.push(...librarySchema);
  for (const effect of effects) {
    const result = validateJsonSchema(effect.document, schemaPath);
    preliminaryErrors.push(...result.map((message) => `${effect.fileName}：${message}`));
    validateEffectSemantics(
      effect.document,
      effect.fileName,
      sourceIds,
      preliminaryErrors
    );
  }
  if (preliminaryErrors.length > 0) {
    throw new Error(preliminaryErrors.join("\n"));
  }
  fs.writeFileSync(
    catalogPath,
    stableText(buildCatalogDocument(library, effects)),
    "utf8"
  );
  fs.copyFileSync(starterRuntimePath, galleryRuntimePath);
  const manifest = buildGalleryManifest(readJson(galleryBasePath), effects);
  fs.writeFileSync(galleryManifestPath, stableText(manifest), "utf8");
  const result = validateTextMotionLibrary();
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return {
    effectCount: effects.length,
    catalogPath,
    galleryManifestPath,
    galleryRuntimePath,
  };
}

export function searchEffects(query, effects = loadEffects()) {
  const tokens = normalizedSearch(query).split(/\s+/u).filter(Boolean);
  return effects.filter(({ document }) => {
    const haystack = normalizedSearch([
      document.id,
      document.name,
      ...document.aliases,
      document.intent.purpose,
      document.intent.energy,
      document.segmentation.unit,
      ...document.intent.operations,
      ...document.intent.semantic_tags,
      SEARCH_EXPANSIONS[document.intent.energy],
      SEARCH_EXPANSIONS[document.segmentation.unit],
      ...document.intent.operations.map((operation) => SEARCH_EXPANSIONS[operation]),
    ].join(" "));
    return tokens.every((token) => haystack.includes(token));
  });
}

function projectPath(projectRoot, relativePath) {
  const absolute = path.resolve(projectRoot, relativePath);
  const inside = path.relative(projectRoot, absolute);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error(`文字动效目标路径逃出网页包：${relativePath}`);
  }
  return absolute;
}

export function materializeTextMotion({ projectRoot, effectId, operation }) {
  const resolvedProject = path.resolve(projectRoot || "");
  const manifestPath = projectPath(resolvedProject, "editable-media.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`目标目录缺少 editable-media.json：${resolvedProject}`);
  }
  const manifest = readJson(manifestPath);
  if (manifest.protocol !== "editable-media" || manifest.version !== 5) {
    throw new Error("文字动效只能物化到 editable-media v5 网页包");
  }
  const library = loadTextMotionLibrary();
  const match = loadEffects().find(({ document }) => document.id === effectId);
  if (!match) throw new Error(`找不到文字动效 ${effectId}`);
  const selectedOperation = operation || match.document.intent.default_operation;
  if (!match.document.intent.operations.includes(selectedOperation)) {
    throw new Error(`${effectId} 不支持操作 ${selectedOperation}`);
  }
  const runtimeRelative = "text-motion/text-motion-runtime.js";
  const bindingRelative = "text-motion/text-motion-binding.js";
  const libraryRelative = "text-motion/library.json";
  const noticeRelative = "text-motion/THIRD_PARTY_NOTICES.md";
  const effectRelative = `text-motion/effects/${effectId}.json`;
  const selectionRelative = "text-motion/selection.json";
  const runtimeTarget = projectPath(resolvedProject, runtimeRelative);
  const bindingTarget = projectPath(resolvedProject, bindingRelative);
  const libraryTarget = projectPath(resolvedProject, libraryRelative);
  const noticeTarget = projectPath(resolvedProject, noticeRelative);
  const effectTarget = projectPath(resolvedProject, effectRelative);
  const selectionTarget = projectPath(resolvedProject, selectionRelative);
  fs.mkdirSync(path.dirname(runtimeTarget), { recursive: true });
  fs.mkdirSync(path.dirname(effectTarget), { recursive: true });
  fs.copyFileSync(path.join(libraryRoot, "text-motion-runtime.js"), runtimeTarget);
  fs.copyFileSync(path.join(libraryRoot, "text-motion-binding.js"), bindingTarget);
  fs.copyFileSync(libraryPath, libraryTarget);
  fs.copyFileSync(path.join(libraryRoot, "THIRD_PARTY_NOTICES.md"), noticeTarget);
  fs.copyFileSync(match.filePath, effectTarget);
  const selection = {
    protocol: "visual-multimedia-text-motion-selection",
    version: 1,
    library_version: library.library_version,
    effect_id: effectId,
    operation: selectedOperation,
    effect_path: effectRelative,
    runtime_path: runtimeRelative,
    binding_path: bindingRelative,
    effect_sha256: sha256(match.bytes),
    behavior_fingerprint: effectFingerprint(match.document),
    time_source: "editable-media",
  };
  const selectionSchema = validateJsonSchema(selection, schemaPath);
  if (selectionSchema.length > 0) {
    throw new Error(selectionSchema.join("\n"));
  }
  fs.writeFileSync(selectionTarget, stableText(selection), "utf8");
  const additions = [
    runtimeRelative,
    bindingRelative,
    libraryRelative,
    noticeRelative,
    effectRelative,
    selectionRelative,
  ];
  const existing = Array.isArray(manifest.resources) ? manifest.resources : [];
  manifest.resources = [
    ...existing.filter((value) => !additions.includes(value)),
    ...additions,
  ];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    projectRoot: resolvedProject,
    effectId,
    operation: selectedOperation,
    selectionPath: selectionTarget,
    runtimePath: runtimeTarget,
    bindingPath: bindingTarget,
    libraryPath: libraryTarget,
    noticePath: noticeTarget,
    effectPath: effectTarget,
    manifestPath,
  };
}

function summary(effect) {
  return {
    id: effect.id,
    name: effect.name,
    operations: effect.intent.operations,
    default_operation: effect.intent.default_operation,
    unit: effect.segmentation.unit,
    energy: effect.intent.energy,
    purpose: effect.intent.purpose,
  };
}

function printRows(effects) {
  for (const { document } of effects) {
    console.log(
      `${document.id}\t${document.name}\t${document.segmentation.unit}`
      + `\t${document.intent.default_operation}\t${document.intent.energy}`
    );
  }
}

function usage() {
  console.error(
    "用法：node scripts/text-motion-library.mjs "
    + "<list|search|get|validate|build|materialize> [query-or-id] "
    + "[--project <editable-media-package>] [--operation <operation>] [--json]"
  );
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

async function main(argv) {
  const command = argv[0];
  const json = argv.includes("--json");
  const values = argv.slice(1).filter((value) => value !== "--json");
  if (command === "list") {
    const effects = loadEffects();
    if (json) console.log(JSON.stringify(effects.map(({ document }) => summary(document)), null, 2));
    else printRows(effects);
    return;
  }
  if (command === "search") {
    const effects = searchEffects(values.join(" "));
    if (json) console.log(JSON.stringify(effects.map(({ document }) => summary(document)), null, 2));
    else printRows(effects);
    return;
  }
  if (command === "get") {
    const id = values[0];
    const match = loadEffects().find(({ document }) => document.id === id);
    if (!match) throw new Error(`找不到文字动效 ${id || "(empty)"}`);
    console.log(JSON.stringify(match.document, null, 2));
    return;
  }
  if (command === "validate") {
    const result = validateTextMotionLibrary();
    if (!result.ok) throw new Error(result.errors.join("\n"));
    console.log(`文字动效库通过：${result.effects.length} 个真实效果，行为指纹无重复`);
    return;
  }
  if (command === "build") {
    const result = buildTextMotionLibrary();
    console.log(`文字动效库已生成：${result.effectCount} 个效果与真实画廊清单`);
    return;
  }
  if (command === "materialize") {
    const effectId = values.find((value) =>
      !value.startsWith("--")
      && value !== option(argv, "--project")
      && value !== option(argv, "--operation")
    );
    const result = materializeTextMotion({
      projectRoot: option(argv, "--project"),
      effectId,
      operation: option(argv, "--operation"),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `文字动效已物化：${result.effectId}/${result.operation} -> ${result.projectRoot}`
      );
    }
    return;
  }
  usage();
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
