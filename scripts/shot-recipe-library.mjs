#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {
  assertEditableMediaPackageClosed,
  readEditableMediaPackage,
} from "./editable-media-contract.mjs";
import {validateJsonSchema} from "./json_schema_contract.mjs";
import {
  EDITABLE_MEDIA_SOURCES_CONTRACT,
  validateMediaSources,
} from "./validate-media-sources.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
export const skillRoot = path.resolve(SCRIPT_DIR, "..");
export const libraryRoot = path.join(skillRoot, "assets", "shot-recipe-library");
export const recipesRoot = path.join(libraryRoot, "recipes");
export const libraryPath = path.join(libraryRoot, "library.json");
export const catalogPath = path.join(libraryRoot, "catalog.json");
export const schemaPath = path.join(skillRoot, "schemas", "shot-recipe.v1.schema.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableText(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function treeEntries(root, current = root) {
  const result = [];
  for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
    const absolute = path.join(current, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`网页包不能包含符号链接：${absolute}`);
    if (entry.isDirectory()) result.push(...treeEntries(root, absolute));
    else if (entry.isFile()) result.push({absolute, relative: path.relative(root, absolute).split(path.sep).join("/")});
  }
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

export function sha256Tree(root) {
  const hash = crypto.createHash("sha256");
  for (const entry of treeEntries(root)) {
    hash.update(entry.relative);
    hash.update("\0");
    hash.update(fs.readFileSync(entry.absolute));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function relativeInside(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 不能离开 ${path.resolve(root)}：${target}`);
  }
  return relative.split(path.sep).join("/");
}

function resolveSkillPath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\")) {
    throw new Error(`${label} 必须是使用 / 的 Skill 相对路径`);
  }
  const absolute = path.resolve(skillRoot, ...value.split("/"));
  relativeInside(skillRoot, absolute, label);
  return absolute;
}

export function recipeFingerprint(recipe) {
  return sha256(JSON.stringify(stable({
    category: recipe.category,
    intent: recipe.intent,
    styles: recipe.styles.map((style) => ({
      id: style.id,
      description: style.description,
      use: style.use,
    })),
  })));
}

export function loadShotRecipeLibrary() {
  return readJson(libraryPath);
}

export function loadShotRecipes() {
  return fs.readdirSync(recipesRoot, {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(recipesRoot, entry.name);
      return {filePath, fileName: entry.name, bytes: fs.readFileSync(filePath), document: readJson(filePath)};
    })
    .sort((left, right) => String(left.document.id).localeCompare(String(right.document.id), "en"));
}

function validatePackage(packagePath, errors, label) {
  try {
    const editable = readEditableMediaPackage(packagePath);
    assertEditableMediaPackageClosed(editable.packageRoot, editable.manifest);
    const media = validateMediaSources(
      path.join(editable.packageRoot, editable.manifest.media_sources),
      {contract: EDITABLE_MEDIA_SOURCES_CONTRACT},
    );
    if (!media.ok) throw new Error(media.errors.join("；"));
    return {
      package_sha256: sha256Tree(packagePath),
      manifest_sha256: sha256File(editable.manifestPath),
    };
  } catch (error) {
    errors.push(`${label}：${error.message}`);
    return null;
  }
}

export function buildCatalogDocument(library, recipes, errors = []) {
  let activeStyleCount = 0;
  let referenceStyleCount = 0;
  const items = recipes.map(({document, bytes}) => ({
    id: document.id,
    name: document.name,
    category: document.category,
    status: document.status,
    path: `recipes/${document.id}.json`,
    sha256: sha256(bytes),
    behavior_fingerprint: document.behavior_fingerprint,
    purpose: document.intent.purpose,
    use: document.intent.use,
    energy: document.intent.energy,
    semantic_tags: document.intent.semantic_tags,
    styles: document.styles.map((style) => {
      const active = style.status === "active";
      if (active) activeStyleCount += 1;
      else referenceStyleCount += 1;
      let hashes = null;
      if (active) {
        hashes = validatePackage(
          resolveSkillPath(style.implementation.package, `${document.id}/${style.id}.package`),
          errors,
          `${document.id}/${style.id}`,
        );
      }
      return {
        id: style.id,
        label: style.label,
        status: style.status,
        implementation_kind: style.implementation.kind,
        package: style.implementation.package,
        package_sha256: hashes?.package_sha256 ?? null,
        manifest_sha256: hashes?.manifest_sha256 ?? null,
      };
    }),
  }));
  return {
    protocol: "visual-multimedia-shot-recipe-catalog",
    version: 1,
    library_version: library.library_version,
    recipe_count: recipes.length,
    active_style_count: activeStyleCount,
    reference_style_count: referenceStyleCount,
    recipes: items,
  };
}

export function validateShotRecipeLibrary() {
  const errors = [];
  const library = loadShotRecipeLibrary();
  errors.push(...validateJsonSchema(library, schemaPath).map((message) => `library.json：${message}`));
  const sourceIds = new Set((library.sources || []).map((source) => source.id));
  if (sourceIds.size !== (library.sources || []).length) errors.push("library.json 的 source id 重复");
  const recipes = loadShotRecipes();
  if (!recipes.length) errors.push("镜头配方目录不能为空");
  const ids = new Set();
  const names = new Set();
  const fingerprints = new Map();
  for (const item of recipes) {
    const recipe = item.document;
    errors.push(...validateJsonSchema(recipe, schemaPath).map((message) => `${item.fileName}：${message}`));
    if (`${recipe.id}.json` !== item.fileName) errors.push(`${item.fileName} 与 recipe id ${recipe.id} 不一致`);
    if (ids.has(recipe.id)) errors.push(`recipe id 重复：${recipe.id}`);
    ids.add(recipe.id);
    const name = String(recipe.name).normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (names.has(name)) errors.push(`recipe name 重复：${recipe.name}`);
    names.add(name);
    if (!sourceIds.has(recipe.source_id)) errors.push(`${recipe.id} 引用了未知 source ${recipe.source_id}`);
    const actualFingerprint = recipeFingerprint(recipe);
    if (recipe.behavior_fingerprint !== actualFingerprint) errors.push(`${recipe.id} 的 behavior_fingerprint 与当前行为不一致`);
    if (fingerprints.has(actualFingerprint)) errors.push(`${recipe.id} 与 ${fingerprints.get(actualFingerprint)} 的镜头行为完全重复`);
    else fingerprints.set(actualFingerprint, recipe.id);
    const styleIds = new Set();
    let active = 0;
    for (const style of recipe.styles || []) {
      if (styleIds.has(style.id)) errors.push(`${recipe.id} 的 style id 重复：${style.id}`);
      styleIds.add(style.id);
      if (style.status === "active") {
        active += 1;
        if (style.implementation.kind !== "editable-media-package" || !style.implementation.package) {
          errors.push(`${recipe.id}/${style.id} active 但没有完整 editable-media package`);
        }
      } else if (style.implementation.kind !== "none" || style.implementation.package !== null) {
        errors.push(`${recipe.id}/${style.id} reference-only 不能绑定活动实现`);
      }
    }
    if ((recipe.status === "active") !== (active > 0)) errors.push(`${recipe.id} 的 recipe status 与 style 状态不一致`);
  }
  const expectedCatalog = buildCatalogDocument(library, recipes, errors);
  if (!fs.existsSync(catalogPath)) errors.push("缺少生成目录 catalog.json；请运行 build");
  else {
    const actual = readJson(catalogPath);
    errors.push(...validateJsonSchema(actual, schemaPath).map((message) => `catalog.json：${message}`));
    if (stableText(actual) !== stableText(expectedCatalog)) errors.push("catalog.json 没有由当前 recipe 真源与实现包生成；请运行 build");
  }
  for (const file of ["index.html", "THIRD_PARTY_NOTICES.md"]) {
    if (!fs.existsSync(path.join(libraryRoot, file))) errors.push(`镜头配方库缺少 ${file}`);
  }
  return {ok: errors.length === 0, errors, library, recipes, catalog: expectedCatalog};
}

export function buildShotRecipeLibrary() {
  const library = loadShotRecipeLibrary();
  const recipes = loadShotRecipes();
  const preErrors = [];
  for (const item of recipes) {
    preErrors.push(...validateJsonSchema(item.document, schemaPath).map((message) => `${item.fileName}：${message}`));
    if (item.document.behavior_fingerprint !== recipeFingerprint(item.document)) {
      preErrors.push(`${item.document.id} 的 behavior_fingerprint 与当前行为不一致`);
    }
  }
  if (preErrors.length) throw new Error(preErrors.join("\n"));
  const catalog = buildCatalogDocument(library, recipes, preErrors);
  if (preErrors.length) throw new Error(preErrors.join("\n"));
  fs.writeFileSync(catalogPath, stableText(catalog), "utf8");
  const result = validateShotRecipeLibrary();
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result;
}

export function searchShotRecipes(query, recipes = loadShotRecipes()) {
  const tokens = String(query || "").normalize("NFKC").toLocaleLowerCase("zh-CN").split(/\s+/u).filter(Boolean);
  return recipes.filter(({document}) => {
    const haystack = [
      document.id, document.name, ...document.aliases, document.category,
      document.intent.purpose, document.intent.use, document.intent.duration,
      document.intent.energy, ...document.intent.semantic_tags,
      ...document.styles.flatMap((style) => [style.id, style.label, style.description, style.use]),
    ].join(" ").normalize("NFKC").toLocaleLowerCase("zh-CN");
    return tokens.every((token) => haystack.includes(token));
  });
}

function copyDirectoryOnce(source, destination, expectedHash) {
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isDirectory() || sha256Tree(destination) !== expectedHash) {
      throw new Error(`物化目标已存在但内容不同：${destination}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.cpSync(source, destination, {recursive: true, errorOnExist: true, force: false});
  if (sha256Tree(destination) !== expectedHash) throw new Error(`物化后包哈希不一致：${destination}`);
}

export function materializeShotRecipe({projectRoot, recipeId, styleId}) {
  const project = path.resolve(projectRoot || "");
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new Error(`项目目录不存在：${project}`);
  const item = loadShotRecipes().find(({document}) => document.id === recipeId);
  if (!item) throw new Error(`找不到镜头配方 ${recipeId || "(empty)"}`);
  const style = item.document.styles.find((candidate) => candidate.id === styleId);
  if (!style) throw new Error(`${recipeId} 没有 style ${styleId || "(empty)"}`);
  if (style.status !== "active" || style.implementation.kind !== "editable-media-package") {
    throw new Error(`${recipeId}/${styleId} 只有参考语义；先在当前项目建立并验证完整 editable-media 包`);
  }
  const sourcePackage = resolveSkillPath(style.implementation.package, "implementation.package");
  const packageHash = sha256Tree(sourcePackage);
  const destination = path.join(project, "components", "shot-recipes", recipeId, styleId, packageHash);
  copyDirectoryOnce(sourcePackage, destination, packageHash);
  const packageErrors = [];
  const hashes = validatePackage(destination, packageErrors, `${recipeId}/${styleId}`);
  if (packageErrors.length) throw new Error(packageErrors.join("\n"));
  const selection = {
    protocol: "visual-multimedia-shot-recipe-selection",
    version: 1,
    library_version: loadShotRecipeLibrary().library_version,
    recipe_id: recipeId,
    style_id: styleId,
    recipe_sha256: sha256(item.bytes),
    behavior_fingerprint: item.document.behavior_fingerprint,
    package: relativeInside(project, destination, "物化包"),
    package_sha256: hashes.package_sha256,
    manifest_sha256: hashes.manifest_sha256,
    time_source: "editable-media",
  };
  const schemaErrors = validateJsonSchema(selection, schemaPath);
  if (schemaErrors.length) throw new Error(schemaErrors.join("\n"));
  const selectionDir = path.join(project, "shot-recipe-selections");
  fs.mkdirSync(selectionDir, {recursive: true});
  const selectionPath = path.join(selectionDir, `${recipeId}.${styleId}.json`);
  const serialized = stableText(selection);
  if (fs.existsSync(selectionPath) && fs.readFileSync(selectionPath, "utf8") !== serialized) {
    throw new Error(`selection 已存在且内容不同，不会覆盖：${selectionPath}`);
  }
  fs.writeFileSync(selectionPath, serialized, "utf8");
  return {project, package: destination, selection: selectionPath, document: selection};
}

function printRows(items) {
  for (const {document} of items) console.log(`${document.id}\t${document.name}\t${document.category}\t${document.status}`);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function usage() {
  console.error("用法：node scripts/shot-recipe-library.mjs <list|search|get|validate|build|fingerprint|materialize> [query-or-id] [--style <id>] [--project <目录>] [--json]");
}

async function main(argv) {
  const command = argv[0];
  const json = argv.includes("--json");
  if (command === "list") {
    const status = option(argv, "--status");
    if (status && !["active", "reference-only"].includes(status)) throw new Error("--status 必须是 active 或 reference-only");
    const items = loadShotRecipes().filter(({document}) => !status || document.status === status);
    if (json) console.log(JSON.stringify(items.map(({document}) => document), null, 2));
    else printRows(items);
    return;
  }
  if (command === "search") {
    const query = argv.slice(1).filter((value) => !value.startsWith("--") && value !== option(argv, "--style") && value !== option(argv, "--project")).join(" ");
    const items = searchShotRecipes(query);
    if (json) console.log(JSON.stringify(items.map(({document}) => document), null, 2));
    else printRows(items);
    return;
  }
  if (command === "get") {
    const item = loadShotRecipes().find(({document}) => document.id === argv[1]);
    if (!item) throw new Error(`找不到镜头配方 ${argv[1] || "(empty)"}`);
    console.log(JSON.stringify(item.document, null, 2));
    return;
  }
  if (command === "validate") {
    const result = validateShotRecipeLibrary();
    if (!result.ok) throw new Error(result.errors.join("\n"));
    console.log(`镜头配方库通过：${result.catalog.recipe_count} 张配方，${result.catalog.active_style_count} 个目标实现，${result.catalog.reference_style_count} 个参考变体`);
    return;
  }
  if (command === "build") {
    const result = buildShotRecipeLibrary();
    console.log(`镜头配方目录已生成：${result.catalog.recipe_count} 张配方`);
    return;
  }
  if (command === "fingerprint") {
    const filePath = path.resolve(argv[1] || "");
    console.log(recipeFingerprint(readJson(filePath)));
    return;
  }
  if (command === "materialize") {
    const result = materializeShotRecipe({
      projectRoot: option(argv, "--project"),
      recipeId: argv[1],
      styleId: option(argv, "--style"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  usage();
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
