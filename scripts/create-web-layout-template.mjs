#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDir);
const catalogPath = path.join(skillRoot, "assets", "web-layout-templates", "catalog.json");

function fail(message) {
  console.error(message);
  process.exit(2);
}

function readCatalog() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (
    catalog.protocol !== "visual-multimedia-web-layout-template-catalog"
    || catalog.version !== 1
    || !Array.isArray(catalog.templates)
  ) {
    fail(`布局模板目录无效：${catalogPath}`);
  }
  return catalog;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) return null;
  return args[index + 1];
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/create-web-layout-template.mjs list",
    "  node scripts/create-web-layout-template.mjs create --template <id> --output <new-directory>",
    "",
    "create 只写入一个不存在的新目录，不覆盖或合并现有项目。",
  ].join("\n"));
}

const args = process.argv.slice(2);
const command = args[0];
if (!command || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

const catalog = readCatalog();
if (command === "list") {
  console.log(JSON.stringify({
    protocol: catalog.protocol,
    version: catalog.version,
    templates: catalog.templates.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      page_roles: item.page_roles,
      content_shapes: item.content_shapes,
      capacity: item.capacity,
      visual_source: item.style_policy?.visual_source,
    })),
  }, null, 2));
  process.exit(0);
}

if (command !== "create") fail(`未知命令：${command}`);

const templateId = readOption(args, "--template");
const outputOption = readOption(args, "--output");
if (!templateId || !outputOption) {
  fail("create 必须同时提供 --template 和 --output");
}

const template = catalog.templates.find((item) => item.id === templateId && item.status === "active");
if (!template) fail(`没有可用布局模板：${templateId}`);

const sourceRoot = path.resolve(skillRoot, template.source_package);
const skillPrefix = `${path.resolve(skillRoot)}${path.sep}`.toLowerCase();
if (!`${sourceRoot}${path.sep}`.toLowerCase().startsWith(skillPrefix)) {
  fail(`模板源必须位于当前 Skill 内：${template.source_package}`);
}
if (!fs.statSync(sourceRoot).isDirectory()) fail(`模板源不是目录：${sourceRoot}`);

const outputRoot = path.resolve(outputOption);
if (fs.existsSync(outputRoot)) {
  fail(`输出目录已经存在，拒绝覆盖或合并：${outputRoot}`);
}

fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
fs.cpSync(sourceRoot, outputRoot, { recursive: true, errorOnExist: true, force: false });

console.log(JSON.stringify({
  ok: true,
  template_id: template.id,
  source_package: sourceRoot,
  output: outputRoot,
  layout_ids: template.layout_ids,
  visual_source: false,
  next: "写入当前项目内容，并继续使用已有 active style-profile；没有既有风格时先制作全画布方向样稿并确认。",
}, null, 2));
