#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateMediaSources } from "./validate-media-sources.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDir);
const failures = [];

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

function ensurePath(relativePath, label = relativePath) {
  const absolute = path.resolve(skillRoot, relativePath);
  if (!fs.existsSync(absolute)) fail(`${label} 不存在：${absolute}`);
  return absolute;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function checkManifest(manifestPath) {
  const manifest = readJson(manifestPath);
  if (!manifest) return;
  const manifestDir = path.dirname(manifestPath);
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
  const mediaSourcesPath = path.resolve(
    manifestDir,
    manifest.media_sources || "__missing-media-sources.json"
  );
  const sourceValidation = validateMediaSources(mediaSourcesPath);
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
  if (manifest.version !== 2) fail(`${manifestPath} 必须使用 editable-media v2`);
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
  for (const resource of manifest.resources || []) {
    if (/^(?:[a-z]+:)?\/\//i.test(resource) || resource.startsWith("data:")) continue;
    const resourcePath = path.resolve(manifestDir, resource);
    if (!fs.existsSync(resourcePath)) fail(`${manifestPath} 引用缺失资源 ${resource}`);
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

  const entryPath = path.resolve(manifestDir, manifest.entry || "index.html");
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
            + "，但 v2 素材账本没有该记录"
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
for (const match of skillText.matchAll(/`((?:references|assets|scripts)\/[^`]+)`/g)) {
  ensurePath(match[1], `SKILL.md 引用 ${match[1]}`);
}

const starterManifest = ensurePath("assets/web-media-starter/editable-media.json");
checkManifest(starterManifest);

for (const schema of [
  "schemas/media-sources.v2.schema.json",
  "schemas/clip-selections.v1.schema.json",
  "schemas/media-delivery.v1.schema.json",
  "schemas/anime-avatar-project.v1.schema.json",
  "schemas/visual-viseme-library.v1.schema.json",
  "schemas/speech-timeline.v1.schema.json",
  "schemas/anime-avatar-inset.v1.schema.json",
]) {
  readJson(ensurePath(schema));
}
for (const avatarResource of [
  "references/anime-avatar-production.md",
  "assets/anime-avatar-prompts/master-image.md",
  "assets/anime-avatar-prompts/motion-source-video.md",
  "scripts/anime_avatar_common.py",
  "scripts/anime-avatar-project.py",
  "scripts/synthesize-avatar-speech.py",
  "scripts/render-anime-avatar.py",
  "scripts/compose-anime-avatar-inset.py",
]) {
  ensurePath(avatarResource);
}
for (const starterFile of [
  "assets/media-project-starter/media-sources.json",
  "assets/media-project-starter/clip-selections.json",
  "assets/media-project-starter/media-delivery.json",
]) {
  readJson(ensurePath(starterFile));
}
const mediaStarterValidation = validateMediaSources(
  ensurePath("assets/media-project-starter/media-sources.json")
);
if (!mediaStarterValidation.ok) {
  mediaStarterValidation.errors.forEach((message) =>
    fail(`媒体项目 starter：${message}`)
  );
}

const catalogPath = ensurePath("assets/web-card-cases/catalog.json");
const catalog = readJson(catalogPath);
const browserProjects = [path.dirname(starterManifest)];
for (const item of catalog?.cases || []) {
  const caseRoot = ensurePath(`assets/web-card-cases/${item.path}`, `案例 ${item.id}`);
  for (const [kind, relative] of Object.entries(item.files || {})) {
    const filePath = path.resolve(caseRoot, relative);
    if (!fs.existsSync(filePath)) fail(`案例 ${item.id} 缺少 ${kind}：${filePath}`);
  }
  const manifestPath = path.resolve(caseRoot, item.files?.manifest || "editable-media.json");
  checkManifest(manifestPath);
  browserProjects.push(caseRoot);
}

if (failures.length === 0) {
  const validator = path.join(scriptDir, "validate-editable-media.mjs");
  for (const project of browserProjects) {
    runChecked(process.execPath, [validator, project], `浏览器验证：${project}`);
  }
}

if (failures.length === 0) {
  const mediaCase = ensurePath("assets/media-delivery-case");
  const caseManifest = path.join(mediaCase, "media-sources.json");
  const caseValidation = validateMediaSources(caseManifest);
  if (!caseValidation.ok) {
    caseValidation.errors.forEach((message) => fail(`媒体生产案例：${message}`));
  } else {
    const importer = path.join(scriptDir, "import-media-asset.mjs");
    const avatar = ensurePath("assets/creator-identity/cheshire-avatar.png");
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
    const conflictInput = ensurePath(
      "assets/media-delivery-case/assets/by-sha256/a7/a794c1a9b4dbf66a63db82b28788d04e3b564804e3fb9f01bb51c748d00b7e9b.wav"
    );
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
}

if (failures.length === 0) {
  const python = process.env.VISUAL_MULTIMEDIA_PYTHON
    || (process.platform === "win32" ? "python.exe" : "python3");
  const avatarProjectSchema = readJson(
    path.join(skillRoot, "schemas", "anime-avatar-project.v1.schema.json")
  );
  const avatarRenderSchema = avatarProjectSchema?.properties?.render;
  if (
    avatarRenderSchema?.required?.includes("tail_seconds")
    || Object.prototype.hasOwnProperty.call(
      avatarRenderSchema?.properties || {},
      "tail_seconds"
    )
  ) {
    fail("二次元口播项目仍保留固定 tail_seconds；无声动态必须来自完整成片时间线");
  }
  const avatarRendererSource = fs.readFileSync(
    path.join(scriptDir, "render-anime-avatar.py"),
    "utf8"
  );
  if (avatarRendererSource.includes("tail_seconds")) {
    fail("二次元口播渲染器仍保留固定尾段实现");
  }
  if (
    !avatarRendererSource.includes("silent_intervals")
    || !avatarRendererSource.includes("silence_closed_match_rate")
  ) {
    fail("二次元口播渲染器没有把所有无声区间纳入连续闭嘴动态报告");
  }
  runChecked(
    python,
    [
      "-m",
      "py_compile",
      path.join(scriptDir, "anime_avatar_common.py"),
      path.join(scriptDir, "anime-avatar-project.py"),
      path.join(scriptDir, "synthesize-avatar-speech.py"),
      path.join(scriptDir, "render-anime-avatar.py"),
      path.join(scriptDir, "compose-anime-avatar-inset.py"),
    ],
    "二次元口播脚本语法检查"
  );
  runChecked(
    python,
    [path.join(scriptDir, "anime-avatar-project.py"), "--help"],
    "二次元口播项目入口检查"
  );
  runChecked(
    python,
    [path.join(scriptDir, "render-anime-avatar.py"), "--help"],
    "二次元口播渲染入口检查"
  );
  runChecked(
    python,
    [path.join(scriptDir, "synthesize-avatar-speech.py"), "--help"],
    "二次元口播 TTS 时间轴入口检查"
  );
  runChecked(
    python,
    [path.join(scriptDir, "compose-anime-avatar-inset.py"), "--help"],
    "二次元口播角色窗入口检查"
  );
}

if (failures.length > 0) {
  failures.forEach((message) => console.error(`FAIL ${message}`));
  console.error(`visual-multimedia 未通过：${failures.length} 个问题`);
  process.exit(1);
}

console.log(
  `visual-multimedia 通过：网页 starter、${catalog?.cases?.length || 0} 个网页案例`
    + "、1 个最终媒体案例与二次元口播及角色窗入口均通过验证"
);
