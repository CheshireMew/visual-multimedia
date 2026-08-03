#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {validateJsonSchema} from "./json_schema_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROFILE_ROOT = path.join(SKILL_ROOT, "assets", "video-production-profiles");
const CATALOG_PATH = path.join(PROFILE_ROOT, "catalog.json");
const SCHEMA_PATH = path.join(SKILL_ROOT, "schemas", "video-production-profile-catalog.v1.schema.json");
const ID = /^[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function slash(value) {
  return String(value).replaceAll("\\", "/");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function stableText(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function resolveSkillPath(relative, label) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new Error(`${label} 必须是 Skill 内使用 / 的相对路径`);
  }
  const absolute = path.resolve(SKILL_ROOT, ...relative.split("/"));
  const check = path.relative(SKILL_ROOT, absolute);
  if (check.startsWith("..") || path.isAbsolute(check)) throw new Error(`${label} 离开 Skill 根目录`);
  return absolute;
}

export function loadVideoProductionProfiles() {
  const result = [];
  for (const idEntry of fs.readdirSync(PROFILE_ROOT, {withFileTypes: true})) {
    if (!idEntry.isDirectory()) continue;
    const idRoot = path.join(PROFILE_ROOT, idEntry.name);
    for (const versionEntry of fs.readdirSync(idRoot, {withFileTypes: true})) {
      if (!versionEntry.isDirectory()) continue;
      const filePath = path.join(idRoot, versionEntry.name, "profile.json");
      if (!fs.existsSync(filePath)) continue;
      result.push({filePath, document: JSON.parse(fs.readFileSync(filePath, "utf8"))});
    }
  }
  return result.sort((left, right) => `${left.document.id}@${left.document.profile_version}`.localeCompare(`${right.document.id}@${right.document.profile_version}`, "en"));
}

function validateProfile(item, errors) {
  const profile = item.document;
  const relative = slash(path.relative(PROFILE_ROOT, item.filePath));
  if (profile.protocol !== "visual-multimedia-video-production-profile" || profile.version !== 1) errors.push(`${relative} 的 profile 协议无效`);
  if (!ID.test(profile.id || "")) errors.push(`${relative} 的 id 无效`);
  if (!VERSION.test(profile.profile_version || "")) errors.push(`${relative} 的 profile_version 无效`);
  if (!profile.name || !["active", "inactive"].includes(profile.status)) errors.push(`${relative} 缺少 name 或 status 无效`);
  const expected = `${profile.id}/${profile.profile_version}/profile.json`;
  if (relative !== expected) errors.push(`${relative} 与 profile 自身 id/version 不一致`);
  for (const [label, value] of [["public_entry", profile.public_entry], ["reference", profile.reference]]) {
    try {
      const absolute = resolveSkillPath(value, `${profile.id}.${label}`);
      if (!fs.existsSync(absolute)) errors.push(`${profile.id}.${label} 指向不存在的文件：${value}`);
    } catch (error) { errors.push(error.message); }
  }
  for (const [key, value] of Object.entries(profile.schemas || {})) {
    try {
      const absolute = resolveSkillPath(value, `${profile.id}.schemas.${key}`);
      if (!fs.existsSync(absolute)) errors.push(`${profile.id}.schemas.${key} 指向不存在的文件：${value}`);
    } catch (error) { errors.push(error.message); }
  }
}

export function buildProfileCatalogDocument(profiles, errors = []) {
  for (const item of profiles) validateProfile(item, errors);
  const activeById = new Set();
  for (const {document} of profiles) {
    if (document.status !== "active") continue;
    if (activeById.has(document.id)) errors.push(`同一 profile 不能有两个 active 版本：${document.id}`);
    activeById.add(document.id);
  }
  return {
    protocol: "visual-multimedia-video-production-profile-catalog",
    version: 1,
    profiles: profiles.map(({filePath, document}) => ({
      id: document.id,
      name: document.name,
      version: document.profile_version,
      status: document.status,
      package: slash(path.relative(PROFILE_ROOT, filePath)),
      package_sha256: sha256File(filePath),
      public_entry: document.public_entry,
    })),
  };
}

export function validateVideoProductionProfileCatalog() {
  const errors = [];
  const profiles = loadVideoProductionProfiles();
  if (!profiles.length) errors.push("视频生产 profile 目录不能为空");
  const expected = buildProfileCatalogDocument(profiles, errors);
  if (!fs.existsSync(CATALOG_PATH)) errors.push("缺少视频生产 profile catalog.json");
  else {
    const actual = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    errors.push(...validateJsonSchema(actual, SCHEMA_PATH).map((message) => `catalog.json：${message}`));
    if (stableText(actual) !== stableText(expected)) errors.push("profile catalog 没有由当前 profile 真源生成；请运行 build");
  }
  return {ok: errors.length === 0, errors, catalog: expected};
}

export function buildVideoProductionProfileCatalog() {
  const profiles = loadVideoProductionProfiles();
  const errors = [];
  const catalog = buildProfileCatalogDocument(profiles, errors);
  errors.push(...validateJsonSchema(catalog, SCHEMA_PATH).map((message) => `catalog.json：${message}`));
  if (errors.length) throw new Error(errors.join("\n"));
  fs.writeFileSync(CATALOG_PATH, stableText(catalog), "utf8");
  return catalog;
}

function main(argv) {
  const command = argv[0];
  if (command === "build") {
    const catalog = buildVideoProductionProfileCatalog();
    console.log(`视频生产 profile 目录已生成：${catalog.profiles.length} 个 profile`);
    return;
  }
  if (command === "validate") {
    const result = validateVideoProductionProfileCatalog();
    if (!result.ok) throw new Error(result.errors.join("\n"));
    console.log(`视频生产 profile 目录通过：${result.catalog.profiles.length} 个 profile`);
    return;
  }
  if (command === "list") {
    const profiles = loadVideoProductionProfiles();
    for (const {document} of profiles) console.log(`${document.id}\t${document.profile_version}\t${document.status}\t${document.name}`);
    return;
  }
  throw new Error("用法：node scripts/video-production-profile-catalog.mjs <build|validate|list>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
