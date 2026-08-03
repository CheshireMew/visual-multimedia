#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {
  buildShotRecipeLibrary,
  libraryRoot,
  recipeFingerprint,
} from "./shot-recipe-library.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function stableText(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function markdownSection(text, heading) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return [];
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index])) break;
    section.push(lines[index]);
  }
  const items = [];
  let current = "";
  for (const raw of section) {
    const line = raw.trim();
    if (!line || line.startsWith("|") || line.startsWith("```")) continue;
    const bullet = line.match(/^[-*]\s+(.+)$/u);
    if (bullet) {
      if (current) items.push(current);
      current = bullet[1].trim();
    } else if (current) {
      current = `${current} ${line}`;
    } else {
      current = line;
    }
  }
  if (current) items.push(current);
  return items;
}

function demoReference(text) {
  return text.match(/(?:demos\/[A-Za-z0-9_./-]+\/|template\/[A-Za-z0-9_./-]+\.(?:tsx|ts))/u)?.[0] || null;
}

function normalizeTag(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "shot";
}

export function migrateVideoShotcraft(sourceRoot) {
  const root = path.resolve(sourceRoot || "");
  const galleryPath = path.join(root, "gallery", "api", "library.json");
  if (!fs.existsSync(galleryPath)) throw new Error(`找不到 video-shotcraft Gallery 真源：${galleryPath}`);
  const gallery = JSON.parse(fs.readFileSync(galleryPath, "utf8"));
  const cards = Array.isArray(gallery.cards) ? gallery.cards : [];
  if (!cards.length) throw new Error("video-shotcraft Gallery 没有 cards");
  const targetRoot = path.join(libraryRoot, "recipes");
  fs.mkdirSync(targetRoot, {recursive: true});
  const written = [];
  for (const card of cards) {
    const sourceCard = String(card.source || "");
    const cardPath = path.resolve(root, ...sourceCard.split("/"));
    if (!fs.existsSync(cardPath)) throw new Error(`来源卡片不存在：${cardPath}`);
    const markdown = fs.readFileSync(cardPath, "utf8");
    const styles = (card.styles || []).map((style) => ({
      id: normalizeTag(style.key),
      label: String(style.label || style.key || card.name),
      description: String(style.description || card.summary || card.intention),
      use: String(style.use || card.use || "按当前功能职责和画面条件判断"),
      status: "reference-only",
      implementation: {kind: "none", package: null},
    }));
    const recipe = {
      protocol: "visual-multimedia-shot-recipe",
      version: 1,
      id: normalizeTag(card.name),
      name: String(card.name),
      aliases: [],
      status: "reference-only",
      source_id: "video-shotcraft",
      category: String(card.category),
      intent: {
        purpose: String(card.intention || card.summary || card.name),
        use: String(card.use || "按当前产品功能、镜头职责和制作条件判断"),
        duration: String(card.duration || "由当前语义片段和真实声音决定"),
        energy: String(card.energy || "由当前段落能量决定"),
        semantic_tags: [...new Set([String(card.category), ...(card.tags || [])].map(normalizeTag))],
      },
      styles,
      known_pitfalls: markdownSection(markdown, "已知坑"),
      source_evidence: {
        source_card: sourceCard,
        upstream_demo: demoReference(markdown),
        upstream_preview_declared: styles.length > 0 && (card.styles || []).every((style) => Boolean(style.media)),
        notes: "上游 demo 路径与预览声明只证明来源材料存在；目标未复制其代码或媒体，因此全部变体保持 reference-only。",
      },
      behavior_fingerprint: "",
    };
    recipe.behavior_fingerprint = recipeFingerprint(recipe);
    const destination = path.join(targetRoot, `${recipe.id}.json`);
    fs.writeFileSync(destination, stableText(recipe), "utf8");
    written.push(destination);
  }
  const result = buildShotRecipeLibrary();
  return {source: root, written: written.length, recipe_count: result.catalog.recipe_count};
}

function main(argv) {
  const source = option(argv, "--source");
  if (!source) throw new Error("用法：node scripts/migrate-video-shotcraft-recipes.mjs --source <video-shotcraft 根目录>");
  console.log(JSON.stringify(migrateVideoShotcraft(source), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
