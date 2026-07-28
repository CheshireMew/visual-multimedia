#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { validateMediaSources } from "./validate-media-sources.mjs";

const require = createRequire(import.meta.url);

function usage(message) {
  if (message) console.error(`错误：${message}\n`);
  console.error(
    "用法：node scripts/validate-editable-media.mjs <项目目录或 editable-media.json> "
    + "[--variant <id>] [--scene <id>] [--screenshot <png>] [--report <json>]"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const values = {
    target: null,
    variant: null,
    scene: null,
    screenshot: null,
    report: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--") && !values.target) {
      values.target = value;
      continue;
    }
    if (["--variant", "--scene", "--screenshot", "--report"].includes(value)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) usage(`${value} 缺少参数`);
      values[value.slice(2)] = next;
      index += 1;
      continue;
    }
    usage(`无法识别参数 ${value}`);
  }
  if (!values.target) usage("缺少项目目录或清单路径");
  return values;
}

function loadPlaywright() {
  const candidates = [
    process.cwd(),
    path.dirname(new URL(import.meta.url).pathname),
    "D:\\Tools\\nodejs\\node_modules",
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const resolved = require.resolve("playwright", { paths: [candidate] });
      return require(resolved);
    } catch {
      // Continue until every declared local module root has been checked.
    }
  }
  throw new Error(
    "找不到 Playwright。请使用已经安装 Playwright 的 Node 环境，"
    + "或通过 NODE_PATH 指向现有 node_modules；本脚本不会自动安装依赖。"
  );
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON ${filePath}：${error.message}`);
  }
}

function normalizeTarget(target) {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) throw new Error(`目标不存在：${absolute}`);
  const stat = fs.statSync(absolute);
  const manifestPath = stat.isDirectory()
    ? path.join(absolute, "editable-media.json")
    : absolute;
  if (!fs.existsSync(manifestPath)) throw new Error(`找不到清单：${manifestPath}`);
  return manifestPath;
}

function localResourcePaths(manifest, manifestDir) {
  const values = [
    manifest.entry,
    manifest.media_sources,
    ...(Array.isArray(manifest.resources) ? manifest.resources : []),
  ];
  const resources = values
    .filter((value) => typeof value === "string" && value.length > 0)
    .filter((value) => !/^(?:[a-z]+:)?\/\//i.test(value) && !value.startsWith("data:"))
    .map((value) => path.resolve(manifestDir, value));
  if (typeof manifest.media_sources === "string" && manifest.media_sources) {
    const mediaSourcesPath = path.resolve(manifestDir, manifest.media_sources);
    if (fs.existsSync(mediaSourcesPath)) {
      try {
        const mediaSources = readJson(mediaSourcesPath);
        for (const source of mediaSources.sources || []) {
          if (typeof source.file !== "string" || !source.file) continue;
          const file = source.file.split("#", 1)[0];
          if (!/^(?:[a-z]+:)?\/\//i.test(file) && !file.startsWith("data:")) {
            resources.push(path.resolve(path.dirname(mediaSourcesPath), file));
          }
        }
      } catch {
        // structuralChecks reports the invalid media source manifest.
      }
    }
  }
  return Array.from(new Set(resources));
}

function commonAncestor(paths) {
  const resolved = paths.map((value) => path.resolve(value));
  let current = path.dirname(resolved[0]);
  while (!resolved.every((value) => {
    const relative = path.relative(current, value);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  })) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  }[extension] || "application/octet-stream";
}

async function startStaticServer(root) {
  const normalizedRoot = path.resolve(root);
  const compareRoot = `${normalizedRoot.toLowerCase()}${path.sep}`;
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(normalizedRoot, relative);
      const comparePath = filePath.toLowerCase();
      if (comparePath !== normalizedRoot.toLowerCase() && !comparePath.startsWith(compareRoot)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentType(filePath),
        "Cache-Control": "no-store",
      });
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function structuralChecks(manifest, manifestPath) {
  const failures = [];
  const warnings = [];
  const manifestDir = path.dirname(manifestPath);
  const fail = (rule, message) => failures.push({ rule, message });
  const warn = (rule, message) => warnings.push({ rule, message });

  if (manifest.protocol !== "editable-media") fail("S1", "protocol 必须是 editable-media");
  if (manifest.version !== 2) fail("S1", "version 必须是 2");
  if (typeof manifest.entry !== "string" || !manifest.entry) {
    fail("S2", "entry 必须指向入口 HTML");
  }
  for (const legacyField of ["canvas", "timeline", "layouts", "default_layout_id"]) {
    if (Object.prototype.hasOwnProperty.call(manifest, legacyField)) {
      fail("S2", `旧字段 ${legacyField} 已退出；使用 scenes、playback、variants 与 layout_contracts`);
    }
  }
  if (typeof manifest.media_sources !== "string" || !manifest.media_sources) {
    fail("S3", "media_sources 必须指向唯一的 v2 素材账本");
  }
  const mediaSourcesPath = typeof manifest.media_sources === "string"
    ? path.resolve(manifestDir, manifest.media_sources)
    : path.join(manifestDir, "__missing-media-sources.json");
  const mediaSourcesValidation = validateMediaSources(mediaSourcesPath);
  if (!mediaSourcesValidation.ok) {
    mediaSourcesValidation.errors.forEach((message) =>
      fail("S3", `素材账本无效：${message}`)
    );
  }
  for (const resource of manifest.resources || []) {
    if (resource === manifest.media_sources) {
      fail("S3", "media_sources 不能同时重复写入 resources");
    }
    const resourcePath = String(resource).split(/[?#]/, 1)[0];
    if (
      /\.(?:png|jpe?g|webp|gif|svg|mp4|mov|webm|wav|mp3|m4a|aac|flac)$/i
        .test(resourcePath)
    ) {
      fail(
        "S3",
        `媒体文件 ${resource} 必须进入素材账本，不能直接写入 resources`
      );
    }
  }
  const mediaSourceIds = new Set(
    mediaSourcesValidation.ok
      ? mediaSourcesValidation.sources.map((source) => source.id)
      : []
  );
  const mediaSourceRecords = new Map();
  if (mediaSourcesValidation.ok) {
    const mediaSourcesDocument = readJson(mediaSourcesPath);
    for (const source of mediaSourcesDocument.sources || []) {
      mediaSourceRecords.set(source.id, source);
    }
  }

  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const layerIds = new Set();
  const selectors = new Set();
  layers.forEach((layer, index) => {
    if (!layer?.id || typeof layer.id !== "string") {
      fail("S4", `layers[${index}] 缺少稳定 id`);
    } else if (layerIds.has(layer.id)) {
      fail("S4", `图层 id 重复：${layer.id}`);
    } else {
      layerIds.add(layer.id);
    }
    if (!layer?.selector || typeof layer.selector !== "string") {
      fail("S4", `图层 ${layer?.id || index} 缺少 selector`);
    } else if (selectors.has(layer.selector)) {
      fail("S4", `图层 selector 重复：${layer.selector}`);
    } else {
      selectors.add(layer.selector);
    }
  });

  const dataFields = Array.isArray(manifest.data_fields) ? manifest.data_fields : [];
  const dataFieldById = new Map();
  dataFields.forEach((field, index) => {
    if (!field?.id || typeof field.id !== "string") {
      fail("S4", `data_fields[${index}] 缺少稳定 id`);
      return;
    }
    if (dataFieldById.has(field.id)) fail("S4", `数据字段 id 重复：${field.id}`);
    if (field.kind === "image") {
      fail(
        "S3",
        `图片字段 ${field.id} 仍使用旧 kind=image；必须使用 media-source 并保存 source id`
      );
    }
    if (
      field.kind === "media-source"
      && (typeof field.default !== "string" || !mediaSourceIds.has(field.default))
    ) {
      fail(
        "S3",
        `媒体字段 ${field.id} 的默认 source id 不存在：${field.default || "空"}`
      );
    }
    dataFieldById.set(field.id, field);
  });

  const variants = Array.isArray(manifest.variants) ? manifest.variants : [];
  const variantIds = new Set();
  if (!variants.length) fail("S5", "variants 必须至少声明一个输出比例");
  variants.forEach((variant, index) => {
    if (!variant?.id || typeof variant.id !== "string") {
      fail("S5", `variants[${index}] 缺少 id`);
      return;
    }
    if (variantIds.has(variant.id)) fail("S5", `输出变体 id 重复：${variant.id}`);
    variantIds.add(variant.id);
    if (!(Number(variant.canvas?.width) > 0) || !(Number(variant.canvas?.height) > 0)) {
      fail("S5", `输出变体 ${variant.id} 缺少有效画布尺寸`);
    }
    Object.keys(variant.layers || {}).forEach((id) => {
      if (!layerIds.has(id)) fail("S5", `输出变体 ${variant.id} 引用了未声明图层 ${id}`);
    });
  });
  if (!variantIds.has(manifest.default_variant_id)) {
    fail("S5", `default_variant_id 不存在：${manifest.default_variant_id || "空"}`);
  }

  const contracts = Array.isArray(manifest.layout_contracts)
    ? manifest.layout_contracts
    : [];
  const contractById = new Map();
  if (!contracts.length) fail("S8", "layout_contracts 必须至少声明一个内容版式合同");
  contracts.forEach((contract, index) => {
    if (!contract?.id || typeof contract.id !== "string") {
      fail("S8", `layout_contracts[${index}] 缺少 id`);
      return;
    }
    if (contractById.has(contract.id)) fail("S8", `内容版式合同 id 重复：${contract.id}`);
    contractById.set(contract.id, contract);
    for (const fieldId of contract.required_data_fields || []) {
      if (!dataFieldById.has(fieldId)) {
        fail("S8", `内容版式合同 ${contract.id} 引用了未知数据字段 ${fieldId}`);
      }
    }
    for (const layerId of [
      ...(contract.required_layer_ids || []),
      ...(contract.content_layer_ids || []),
      ...(contract.title_layer_ids || []),
    ]) {
      if (!layerIds.has(layerId)) {
        fail("S8", `内容版式合同 ${contract.id} 引用了未知图层 ${layerId}`);
      }
    }
    const slotIds = new Set();
    for (const slot of contract.asset_slots || []) {
      if (!slot?.id || slotIds.has(slot.id)) {
        fail("S9", `内容版式合同 ${contract.id} 的素材槽位缺少或重复 id`);
        continue;
      }
      slotIds.add(slot.id);
      if (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(String(slot.ratio || ""))) {
        fail("S9", `素材槽位 ${contract.id}/${slot.id} 缺少有效 ratio`);
      }
      if (!["cover", "contain"].includes(slot.fit)) {
        fail("S9", `素材槽位 ${contract.id}/${slot.id} 的 fit 必须是 cover 或 contain`);
      }
      if (slot.preserve_full_frame === true && slot.fit !== "contain") {
        fail("S9", `素材槽位 ${contract.id}/${slot.id} 保留完整画面时必须使用 contain`);
      }
    }
  });

  const scenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];
  const sceneIds = new Set();
  if (!scenes.length) fail("S8", "scenes 必须至少声明一个场景");
  scenes.forEach((scene, index) => {
    if (!scene?.id || typeof scene.id !== "string") {
      fail("S8", `scenes[${index}] 缺少 id`);
      return;
    }
    if (sceneIds.has(scene.id)) fail("S8", `场景 id 重复：${scene.id}`);
    sceneIds.add(scene.id);
    if (!scene.page_role || !scene.content_shape || !scene.layout_id) {
      fail("S8", `场景 ${scene.id} 必须声明 page_role、content_shape 和 layout_id`);
    }
    if (!(Number(scene.duration_ms) > 0)) {
      fail("S8", `场景 ${scene.id} 的 duration_ms 必须是正数`);
    }
    const contract = contractById.get(scene.layout_id);
    if (!contract) {
      fail("S8", `场景 ${scene.id} 引用了未知内容版式合同 ${scene.layout_id}`);
    } else {
      if (contract.page_roles?.length && !contract.page_roles.includes(scene.page_role)) {
        fail("S8", `场景 ${scene.id} 的 page_role 不适用于内容版式 ${contract.id}`);
      }
      if (contract.content_shapes?.length
        && !contract.content_shapes.includes(scene.content_shape)) {
        fail("S8", `场景 ${scene.id} 的 content_shape 不适用于内容版式 ${contract.id}`);
      }
      for (const fieldId of contract.required_data_fields || []) {
        const field = dataFieldById.get(fieldId);
        const value = Object.prototype.hasOwnProperty.call(scene.data || {}, fieldId)
          ? scene.data[fieldId]
          : field?.default;
        if (value == null
          || (typeof value === "string" && !value.trim())
          || (Array.isArray(value) && value.length === 0)) {
          fail("S8", `场景 ${scene.id} 的必需数据字段 ${fieldId} 没有内容`);
        }
      }
      const maximum = Number(contract.capacity?.maximum_primary_blocks || 0);
      if (maximum > 0) {
        if (!(Number(scene.primary_blocks) > 0)) {
          fail("S8", `场景 ${scene.id} 必须声明实际主要内容块数量`);
        } else if (Number(scene.primary_blocks) > maximum) {
          fail("S8", `场景 ${scene.id} 的主要内容块超过内容版式 ${contract.id} 容量`);
        }
      }
      const declaredSlots = scene.asset_slots || {};
      for (const slot of contract.asset_slots || []) {
        const binding = declaredSlots[slot.id];
        if (slot.required && !binding) {
          fail("S9", `场景 ${scene.id} 缺少必需素材槽位 ${slot.id}`);
          continue;
        }
        if (!binding) continue;
        const field = dataFieldById.get(binding.data_field);
        if (!field || field.kind !== "media-source") {
          fail(
            "S9",
            `场景 ${scene.id} 的素材槽位 ${slot.id} 必须绑定 media-source 数据字段`
          );
          continue;
        }
        const value = Object.prototype.hasOwnProperty.call(scene.data || {}, field.id)
          ? scene.data[field.id]
          : field.default;
        if (slot.required && (typeof value !== "string" || !mediaSourceIds.has(value))) {
          fail(
            "S9",
            `场景 ${scene.id} 的素材槽位 ${slot.id} 没有有效 source id`
          );
        } else if (typeof value === "string") {
          const source = mediaSourceRecords.get(value);
          if (
            source
            && (
              !["photo", "screenshot", "video-frame", "icon", "generated"]
                .includes(source.media_type)
              || source.acquisition?.method === "generated-in-project"
            )
          ) {
            fail(
              "S9",
              `场景 ${scene.id} 的图片槽位 ${slot.id} 引用了不能由 img 读取的素材 ${value}`
            );
          }
        }
      }
      const allowedSlots = new Set((contract.asset_slots || []).map((slot) => slot.id));
      for (const slotId of Object.keys(declaredSlots)) {
        if (!allowedSlots.has(slotId)) {
          fail("S9", `场景 ${scene.id} 绑定了内容版式未声明的素材槽位 ${slotId}`);
        }
      }
    }
    for (const fieldId of Object.keys(scene.data || {})) {
      if (!dataFieldById.has(fieldId)) fail("S8", `场景 ${scene.id} 引用了未知数据字段 ${fieldId}`);
    }
    for (const layerId of Object.keys(scene.layers || {})) {
      if (!layerIds.has(layerId)) fail("S8", `场景 ${scene.id} 引用了未知图层 ${layerId}`);
    }
    const steps = Array.isArray(scene.steps) ? scene.steps : [];
    if (!steps.length || Number(steps[0]?.at_ms) !== 0) {
      fail("S8", `场景 ${scene.id} 的 steps 必须从 at_ms=0 开始`);
    }
    const stepIds = new Set();
    let previousAt = -1;
    for (const step of steps) {
      const at = Number(step.at_ms);
      if (!step?.id || stepIds.has(step.id)) fail("S8", `场景 ${scene.id} 的 step id 缺少或重复`);
      stepIds.add(step.id);
      if (at < previousAt || at < 0 || at >= Number(scene.duration_ms)) {
        fail("S8", `场景 ${scene.id} 的 step ${step.id || "空"} 时间无效`);
      }
      previousAt = at;
    }
  });

  const playback = manifest.playback || {};
  if (!["manual", "autoplay", "hybrid"].includes(playback.mode)) {
    fail("S10", "playback.mode 必须是 manual、autoplay 或 hybrid");
  }
  if (!(Number(playback.fps) > 0) || !["none", "repeat"].includes(playback.loop)) {
    fail("S10", "playback 必须声明正数 fps，loop 必须是 none 或 repeat");
  }

  if (manifest.delivery?.preview !== "local-server") {
    fail("S11", "delivery.preview 必须明确为 local-server");
  }
  if (!["allow", "forbid"].includes(manifest.delivery?.remote_dependencies)) {
    fail("S11", "delivery.remote_dependencies 必须是 allow 或 forbid");
  }

  localResourcePaths(manifest, manifestDir).forEach((filePath) => {
    if (!fs.existsSync(filePath)) fail("S6", `本地资源不存在：${filePath}`);
  });
  const entryPath = path.resolve(manifestDir, manifest.entry || "index.html");
  if (fs.existsSync(entryPath)) {
    const html = fs.readFileSync(entryPath, "utf8");
    const directMediaAttributes = Array.from(
      html.matchAll(
        /<(?:img|video|audio|source)\b[^>]*(?:src|poster)=["']([^"']+)["']/gi
      )
    ).map((match) => match[1]).filter(Boolean);
    for (const mediaPath of directMediaAttributes) {
      fail(
        "S3",
        `入口 HTML 直接引用媒体 ${mediaPath}；必须由 source id 经运行时解析`
      );
    }
    const cssMediaPaths = Array.from(
      html.matchAll(
        /url\(\s*["']?([^"')]+\.(?:png|jpe?g|webp|gif|svg|mp4|mov|webm|wav|mp3|m4a|aac|flac)(?:[?#][^"')]*)?)["']?\s*\)/gi
      )
    ).map((match) => match[1]);
    for (const mediaPath of cssMediaPaths) {
      fail(
        "S3",
        `入口 HTML/CSS 直接引用媒体 ${mediaPath}；必须由 source id 经运行时解析`
      );
    }
  }
  if (manifest.delivery?.remote_dependencies === "forbid") {
    for (const resource of manifest.resources || []) {
      if (/^(?:[a-z]+:)?\/\//i.test(resource)) {
        fail("S11", `禁止远程依赖，但 resources 包含 ${resource}`);
      }
    }
    if (fs.existsSync(entryPath)) {
      const html = fs.readFileSync(entryPath, "utf8");
      const dependencyPattern = /<(?:script|img|source|video|audio|link)\b[^>]*(?:src|href)=["']https?:\/\//gi;
      if (dependencyPattern.test(html) || /@import\s+(?:url\()?["']?https?:\/\//i.test(html)) {
        fail("S11", "禁止远程依赖，但入口 HTML 仍引用远程脚本、样式或媒体");
      }
    }
  }

  const quality = manifest.quality || {};
  if (manifest.accessibility?.title_data_field
    && !(manifest.data_fields || []).some(
      (field) => field.id === manifest.accessibility.title_data_field
    )) {
    fail(
      "S7",
      `accessibility.title_data_field 不存在：${manifest.accessibility.title_data_field}`
    );
  }
  for (const id of Object.keys(quality.variant_overrides || {})) {
    if (!variantIds.has(id)) fail("S7", `quality.variant_overrides 引用了未知输出变体 ${id}`);
  }
  for (const id of Object.keys(quality.scene_overrides || {})) {
    if (!sceneIds.has(id)) fail("S7", `quality.scene_overrides 引用了未知场景 ${id}`);
  }
  const qualitySets = [
    { label: "quality", rules: quality },
    ...Object.entries(quality.variant_overrides || {}).map(([id, rules]) => ({
      label: `quality.variant_overrides.${id}`,
      rules,
    })),
    ...Object.entries(quality.scene_overrides || {}).map(([id, rules]) => ({
      label: `quality.scene_overrides.${id}`,
      rules,
    })),
  ];
  for (const { label, rules } of qualitySets) {
    const referencedLayerIds = [
      ...(rules.required_layer_ids || []),
      ...(rules.content_bounds_layer_ids || []),
      ...(rules.safe_area_layer_ids || []),
      ...(rules.navigation_safe_area?.layer_ids || []),
      ...(rules.title_to_content?.title_layer_id
        ? [rules.title_to_content.title_layer_id]
        : []),
      ...(rules.title_to_content?.content_layer_ids || []),
      ...(rules.bottom_whitespace?.content_layer_ids || []),
      ...(rules.thumbnail?.text_layer_ids || []),
      ...Object.keys(rules.minimum_font_px || {}),
    ];
    for (const id of referencedLayerIds) {
      if (!layerIds.has(id)) fail("S7", `${label} 引用了未声明图层 ${id}`);
    }
    for (const pair of rules.minimum_gaps || []) {
      if (!layerIds.has(pair.above) || !layerIds.has(pair.below)) {
        fail("S7", `${label}.minimum_gaps 引用了未声明图层 ${pair.above}/${pair.below}`);
      }
    }
    if (rules.roundtrip) {
      if (!dataFieldById.has(rules.roundtrip.data_field)) {
        fail("S7", `${label}.roundtrip 引用了未知数据字段 ${rules.roundtrip.data_field}`);
      }
      if (!layerIds.has(rules.roundtrip.layer_id)) {
        fail("S7", `${label}.roundtrip 引用了未知图层 ${rules.roundtrip.layer_id}`);
      }
    }
  }
  if (!manifest.quality) warn("S7", "未声明 quality；只执行通用结构和浏览器检查");

  return { failures, warnings, variants, scenes };
}

function screenshotPathForTarget(basePath, variantId, sceneId, multiple) {
  const absolute = path.resolve(basePath);
  if (!multiple) return absolute;
  const extension = path.extname(absolute) || ".png";
  const stem = extension ? absolute.slice(0, -extension.length) : absolute;
  return `${stem}-${variantId}-${sceneId}${extension}`;
}

function sceneStartTimeForValidation(manifest, sceneId) {
  let start = 0;
  for (const scene of manifest.scenes || []) {
    if (scene.id === sceneId) return start;
    start += Number(scene.duration_ms || 0);
  }
  return 0;
}

async function inspectTarget(
  page,
  manifest,
  variant,
  scene,
  quality,
  url,
  screenshotPath,
  exercisePlayback
) {
  const failures = [];
  const warnings = [];
  const fail = (rule, message) => failures.push({ rule, message });
  const warn = (rule, message) => warnings.push({ rule, message });
  const browserErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.setViewportSize({
    width: Math.ceil(Number(variant.canvas.width)),
    height: Math.ceil(Number(variant.canvas.height)),
  });
  await page.goto(
    `${url}?capture=1&variant=${encodeURIComponent(variant.id)}`
      + `&scene=${encodeURIComponent(scene.id)}`,
    {
    waitUntil: "load",
    }
  );
  await page.waitForFunction(() => Boolean(window.editableMedia), null, { timeout: 10000 });
  await page.evaluate(() => window.editableMedia.ready);

  const stateBefore = await page.evaluate(() => window.editableMedia.getState());
  if (stateBefore.variant?.id !== variant.id || stateBefore.scene_id !== scene.id) {
    await page.evaluate(({ variantId, sceneId }) => {
      window.editableMedia.setVariant(variantId);
      window.editableMedia.setScene(sceneId);
    }, { variantId: variant.id, sceneId: scene.id });
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));

  if (quality.roundtrip?.data_field && quality.roundtrip?.layer_id) {
    const roundtrip = await page.evaluate(({ dataField, layerId, sceneId }) => {
      const originalState = window.editableMedia.getState();
      const originalBounds = window.editableMedia.getBounds()[layerId];
      const originalScene = originalState.scenes[sceneId];
      const dataNode = Array.from(document.querySelectorAll("[data-editable-data]"))
        .find((node) => node.dataset.editableData === dataField);
      const originalText = dataNode?.textContent || "";
      const sentinel = `${originalText} · VALIDATION`;
      window.editableMedia.setState({
        ...originalState,
        scenes: {
          ...originalState.scenes,
          [sceneId]: {
            ...originalScene,
            data: { ...originalScene.data, [dataField]: sentinel },
          },
        },
        revision: Number(originalState.revision || 0) + 1,
      });
      const changedText = dataNode?.textContent || "";
      window.editableMedia.setState({
        ...originalState,
        scenes: {
          ...originalState.scenes,
          [sceneId]: {
            ...originalScene,
            layers: {
              ...originalScene.layers,
              [layerId]: {
                ...(originalScene.layers?.[layerId] || {}),
                x: originalBounds.x + 3,
              },
            },
          },
        },
        revision: Number(originalState.revision || 0) + 1,
      });
      const movedBounds = window.editableMedia.getBounds()[layerId];
      window.editableMedia.setState(originalState);
      const restoredText = dataNode?.textContent || "";
      const restoredBounds = window.editableMedia.getBounds()[layerId];
      return {
        dataNodeFound: Boolean(dataNode),
        textChanged: changedText === sentinel,
        textRestored: restoredText === originalText,
        movedBy: movedBounds.x - originalBounds.x,
        positionRestored: Math.abs(restoredBounds.x - originalBounds.x) <= 0.5,
      };
    }, {
      dataField: quality.roundtrip.data_field,
      layerId: quality.roundtrip.layer_id,
      sceneId: scene.id,
    });
    if (!roundtrip.dataNodeFound) {
      fail("Q8", `往返检查找不到数据字段 ${quality.roundtrip.data_field} 的页面绑定`);
    } else if (!roundtrip.textChanged || !roundtrip.textRestored) {
      fail("Q8", `数据字段 ${quality.roundtrip.data_field} 修改或恢复没有到达页面`);
    }
    if (Math.abs(roundtrip.movedBy - 3) > 0.5 || !roundtrip.positionRestored) {
      fail("Q8", `图层 ${quality.roundtrip.layer_id} 位置修改或恢复没有到达页面`);
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  }

  const inspection = await page.evaluate(({ manifestLayers, qualityRules }) => {
    const canvasSelector = qualityRules.canvas_selector || ".media-canvas";
    const canvas = document.querySelector(canvasSelector);
    if (!canvas) return { missingCanvas: canvasSelector };
    const canvasRect = canvas.getBoundingClientRect();
    const layerResults = [];
    const selectorCounts = {};
    const editableIdCounts = {};

    document.querySelectorAll("[data-editable-id]").forEach((node) => {
      const id = node.dataset.editableId;
      editableIdCounts[id] = (editableIdCounts[id] || 0) + 1;
    });

    for (const layer of manifestLayers) {
      const matches = Array.from(document.querySelectorAll(layer.selector));
      selectorCounts[layer.id] = matches.length;
      if (matches.length !== 1) continue;
      const node = matches[0];
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const visible = style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) > 0
        && rect.width > 0
        && rect.height > 0;
      layerResults.push({
        id: layer.id,
        kind: layer.kind,
        text: node.textContent?.trim() || "",
        visible,
        bounds: {
          x: rect.left - canvasRect.left,
          y: rect.top - canvasRect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right - canvasRect.left,
          bottom: rect.bottom - canvasRect.top,
        },
        fontSize: Number.parseFloat(style.fontSize) || 0,
        constrainedOverflow: {
          x: window.editableMedia.getState().scenes?.[
            window.editableMedia.getState().scene_id
          ]?.layers?.[layer.id]?.width != null
            || ["hidden", "clip", "scroll", "auto"].includes(style.overflowX),
          y: window.editableMedia.getState().scenes?.[
            window.editableMedia.getState().scene_id
          ]?.layers?.[layer.id]?.height != null
            || ["hidden", "clip", "scroll", "auto"].includes(style.overflowY),
        },
        scrollOverflow: {
          x: Math.max(0, node.scrollWidth - node.clientWidth),
          y: Math.max(0, node.scrollHeight - node.clientHeight),
        },
      });
    }

    return {
      canvas: {
        width: canvasRect.width,
        height: canvasRect.height,
        scrollWidth: canvas.scrollWidth,
        scrollHeight: canvas.scrollHeight,
      },
      selectorCounts,
      editableIdCounts,
      layers: layerResults,
      images: Array.from(document.images).map((image) => ({
        src: image.currentSrc || image.src,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      })),
      mediaSources: window.editableMedia.getMediaSources?.() || null,
      mediaBindings: Array.from(
        document.querySelectorAll("[data-editable-image]")
      ).map((image) => {
        const fieldId = image.dataset.editableImage;
        const sourceId = window.editableMedia.getState().scenes?.[
          window.editableMedia.getState().scene_id
        ]?.data?.[fieldId];
        return {
          fieldId,
          sourceId,
          expectedSrc: sourceId
            ? window.editableMedia.getMediaSourceUrl?.(sourceId)
            : null,
          actualSrc: image.currentSrc || image.src,
        };
      }),
      fonts: document.fonts.status,
      interfaceReady: Boolean(window.editableMedia),
      state: window.editableMedia.getState(),
    };
  }, { manifestLayers: manifest.layers || [], qualityRules: quality });

  if (inspection.missingCanvas) {
    fail("B1", `找不到画布 ${inspection.missingCanvas}`);
    return { failures, warnings, inspection, browserErrors, consoleErrors };
  }

  const expectedWidth = Number(variant.canvas.width);
  const expectedHeight = Number(variant.canvas.height);
  if (Math.abs(inspection.canvas.width - expectedWidth) > 1
    || Math.abs(inspection.canvas.height - expectedHeight) > 1) {
    fail(
      "B1",
      `画布实测 ${inspection.canvas.width}×${inspection.canvas.height}，`
      + `清单要求 ${expectedWidth}×${expectedHeight}`
    );
  }
  if (inspection.state?.variant?.id !== variant.id) {
    fail("B1", `运行时输出变体为 ${inspection.state?.variant?.id || "空"}，不是 ${variant.id}`);
  }
  if (inspection.state?.scene_id !== scene.id) {
    fail("B1", `运行时场景为 ${inspection.state?.scene_id || "空"}，不是 ${scene.id}`);
  }
  if (
    inspection.mediaSources?.protocol !== "visual-multimedia-media-sources"
    || inspection.mediaSources?.version !== 2
  ) {
    fail("B2", "浏览器运行时没有读取 v2 素材账本");
  }
  for (const binding of inspection.mediaBindings || []) {
    if (!binding.sourceId || !binding.expectedSrc) {
      fail("B2", `图片字段 ${binding.fieldId} 没有解析到 source id`);
    } else if (binding.actualSrc !== binding.expectedSrc) {
      fail(
        "B2",
        `图片字段 ${binding.fieldId} 没有从素材账本解析实际文件`
      );
    }
  }
  const playbackState = await page.evaluate(() => window.editableMedia.getPlayback());
  if (playbackState.sceneId !== scene.id || playbackState.localTimeMs !== 0) {
    fail("B1", `播放状态没有停在场景 ${scene.id} 的起点`);
  }
  if (exercisePlayback) {
    const playbackExercise = await page.evaluate(async (sceneId) => {
      const api = window.editableMedia;
      const originalMode = api.getPlayback().mode;
      api.setScene(sceneId);
      api.setPlaybackMode("manual");
      const manualPlayed = api.play();
      api.next();
      const manualAfter = api.getPlayback();
      api.setScene(sceneId);
      api.setPlaybackMode("autoplay");
      const autoplayStarted = api.play();
      await new Promise((resolve) => setTimeout(resolve, 80));
      api.pause();
      const autoplayAfter = api.getPlayback();
      api.setScene(sceneId);
      api.setPlaybackMode("hybrid");
      const hybridStarted = api.play();
      await new Promise((resolve) => setTimeout(resolve, 80));
      api.pause();
      const hybridAfter = api.getPlayback();
      api.setScene(sceneId);
      api.setPlaybackMode(originalMode);
      return {
        manualPlayed,
        manualAfter,
        autoplayStarted,
        autoplayAfter,
        hybridStarted,
        hybridAfter,
      };
    }, scene.id);
    if (playbackExercise.manualPlayed !== false) {
      fail("B7", "manual 模式仍启动了自动时钟");
    }
    if (!playbackExercise.autoplayStarted
      || playbackExercise.autoplayAfter.globalTimeMs <= 0) {
      fail("B7", "autoplay 模式没有推进统一时间线");
    }
    if (!playbackExercise.hybridStarted
      || playbackExercise.hybridAfter.localTimeMs <= 0
      || playbackExercise.hybridAfter.sceneId !== scene.id) {
      fail("B7", "hybrid 模式没有在当前场景内推进并停留于场景边界内");
    }
    const controls = manifest.playback?.controls || {};
    if (controls.keyboard) {
      await page.evaluate((sceneId) => {
        window.editableMedia.setScene(sceneId);
        window.editableMedia.setPlaybackMode("manual");
      }, scene.id);
      const before = await page.evaluate(() => window.editableMedia.getPlayback().globalTimeMs);
      await page.keyboard.press("ArrowRight");
      const after = await page.evaluate(() => window.editableMedia.getPlayback().globalTimeMs);
      if (!(after > before)) fail("B8", "键盘前进没有到达下一个步骤或场景");
    }
    if (controls.wheel) {
      await page.evaluate((sceneId) => window.editableMedia.setScene(sceneId), scene.id);
      const before = await page.evaluate(() => window.editableMedia.getPlayback().globalTimeMs);
      await page.mouse.move(
        Math.max(1, Math.floor(Number(variant.canvas.width) / 2)),
        Math.max(1, Math.floor(Number(variant.canvas.height) / 2))
      );
      await page.mouse.wheel(0, 120);
      const after = await page.evaluate(() => window.editableMedia.getPlayback().globalTimeMs);
      if (!(after > before)) fail("B8", "滚轮前进没有到达下一个步骤或场景");
    }
    if (controls.touch) {
      await page.evaluate((sceneId) => {
        window.editableMedia.setScene(sceneId);
        document.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch",
          pointerId: 91,
          clientX: 220,
          clientY: 160,
        }));
        document.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true,
          pointerType: "touch",
          pointerId: 91,
          clientX: 120,
          clientY: 160,
        }));
      }, scene.id);
      const after = await page.evaluate(() => window.editableMedia.getPlayback().globalTimeMs);
      if (!(after > sceneStartTimeForValidation(manifest, scene.id))) {
        fail("B8", "触摸滑动没有到达下一个步骤或场景");
      }
    }
    if (controls.overview) {
      const overviewWorked = await page.evaluate(() => {
        const opened = window.editableMedia.toggleOverview(true);
        const visible = document.documentElement.hasAttribute("data-editable-overview");
        window.editableMedia.toggleOverview(false);
        return opened && visible;
      });
      if (!overviewWorked) fail("B8", "场景总览没有显示");
    }
    await page.evaluate(({ sceneId, mode }) => {
      window.editableMedia.setScene(sceneId);
      window.editableMedia.setPlaybackMode(mode);
    }, { sceneId: scene.id, mode: manifest.playback.mode });
  }
  if (inspection.fonts !== "loaded") fail("B2", `字体状态为 ${inspection.fonts}`);
  inspection.images.forEach((image) => {
    if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      fail("B2", `图片未正确加载：${image.src}`);
    }
  });
  browserErrors.forEach((message) => fail("B3", `页面异常：${message}`));
  consoleErrors.forEach((message) => fail("B3", `控制台异常：${message}`));

  Object.entries(inspection.selectorCounts).forEach(([id, count]) => {
    if (count !== 1) fail("B4", `图层 ${id} 的 selector 命中 ${count} 个节点`);
  });
  Object.entries(inspection.editableIdCounts).forEach(([id, count]) => {
    if (count !== 1) fail("B4", `data-editable-id 重复：${id} × ${count}`);
  });

  const tolerance = Number(quality.bounds_tolerance_px ?? 1);
  const allowOverflow = new Set(quality.allow_overflow_layer_ids || []);
  const byId = new Map(inspection.layers.map((layer) => [layer.id, layer]));
  for (const layer of inspection.layers) {
    if (!layer.visible || allowOverflow.has(layer.id)) continue;
    const { x, y, right, bottom } = layer.bounds;
    if (x < -tolerance || y < -tolerance
      || right > expectedWidth + tolerance || bottom > expectedHeight + tolerance) {
      fail(
        "B5",
        `图层 ${layer.id} 越出画布：`
        + `x=${x.toFixed(1)}, y=${y.toFixed(1)}, `
        + `right=${right.toFixed(1)}, bottom=${bottom.toFixed(1)}`
      );
    }
    if ((layer.constrainedOverflow.x && layer.scrollOverflow.x > tolerance)
      || (layer.constrainedOverflow.y && layer.scrollOverflow.y > tolerance)) {
      fail(
        "B6",
        `图层 ${layer.id} 内部溢出 `
        + `${layer.scrollOverflow.x.toFixed(1)}×${layer.scrollOverflow.y.toFixed(1)}px`
      );
    }
  }

  for (const id of quality.required_layer_ids || []) {
    const layer = byId.get(id);
    if (!layer || !layer.visible) fail("Q1", `必需图层 ${id} 未显示`);
    else if (layer.kind === "text" && !layer.text) fail("Q1", `必需文字图层 ${id} 为空`);
  }
  if (quality.required_title_layer_ids?.length) {
    const visibleTitle = quality.required_title_layer_ids
      .map((id) => byId.get(id))
      .find((layer) => layer?.visible && layer.text);
    if (!visibleTitle) {
      fail(
        "Q1",
        `内容版式要求至少显示一个标题图层：${quality.required_title_layer_ids.join(" / ")}`
      );
    }
  }

  const safe = quality.safe_area;
  if (safe) {
    const ids = quality.safe_area_layer_ids || quality.required_layer_ids || [];
    for (const id of ids) {
      const layer = byId.get(id);
      if (!layer?.visible) continue;
      const left = Number(safe.left || 0);
      const top = Number(safe.top || 0);
      const right = expectedWidth - Number(safe.right || 0);
      const bottom = expectedHeight - Number(safe.bottom || 0);
      if (layer.bounds.x < left - tolerance || layer.bounds.y < top - tolerance
        || layer.bounds.right > right + tolerance || layer.bounds.bottom > bottom + tolerance) {
        fail("Q2", `图层 ${id} 越出安全区`);
      }
    }
  }

  const minimumFonts = quality.minimum_font_px || {};
  for (const [id, minimum] of Object.entries(minimumFonts)) {
    const layer = byId.get(id);
    if (layer?.visible && layer.fontSize < Number(minimum)) {
      fail("Q3", `图层 ${id} 字号 ${layer.fontSize}px，小于要求 ${minimum}px`);
    }
  }

  for (const pair of quality.minimum_gaps || []) {
    const above = byId.get(pair.above);
    const below = byId.get(pair.below);
    if (!above?.visible || !below?.visible) continue;
    const gap = below.bounds.y - above.bounds.bottom;
    if (gap < Number(pair.min_px || 0)) {
      fail(
        "Q4",
        `${pair.above} 与 ${pair.below} 间距 ${gap.toFixed(1)}px，`
        + `小于要求 ${pair.min_px}px`
      );
    }
  }

  const contentLayers = (quality.content_bounds_layer_ids || [])
    .map((id) => byId.get(id))
    .filter((layer) => layer?.visible);
  if (contentLayers.length && quality.minimum_content_span != null) {
    const top = Math.min(...contentLayers.map((layer) => layer.bounds.y));
    const bottom = Math.max(...contentLayers.map((layer) => layer.bounds.bottom));
    const ratio = (bottom - top) / expectedHeight;
    if (ratio < Number(quality.minimum_content_span)) {
      fail(
        "Q5",
        `内容纵向跨度 ${(ratio * 100).toFixed(1)}%，`
        + `小于要求 ${(Number(quality.minimum_content_span) * 100).toFixed(1)}%`
      );
    }
  }

  const bandRule = quality.band_occupancy;
  if (contentLayers.length && bandRule) {
    const bands = Math.max(1, Number(bandRule.bands || 4));
    const bandHeight = expectedHeight / bands;
    const fills = Array.from({ length: bands }, (_, index) => {
      const start = index * bandHeight;
      const end = start + bandHeight;
      const intervals = contentLayers
        .map((layer) => [
          Math.max(start, layer.bounds.y),
          Math.min(end, layer.bounds.bottom),
        ])
        .filter(([left, right]) => right > left)
        .sort((a, b) => a[0] - b[0]);
      let filled = 0;
      let cursor = start;
      for (const [left, right] of intervals) {
        if (right <= cursor) continue;
        filled += right - Math.max(left, cursor);
        cursor = right;
      }
      return filled / bandHeight;
    });
    const minimum = Number(bandRule.minimum_fill || 0);
    const underfilled = fills
      .map((fill, index) => ({ fill, index }))
      .filter((item) => item.fill < minimum);
    const allowed = Number(bandRule.maximum_underfilled_bands ?? 0);
    if (underfilled.length > allowed) {
      fail(
        "Q6",
        `分带占用 ${(fills.map((fill) => `${(fill * 100).toFixed(0)}%`).join(" / "))}，`
        + `${underfilled.length} 个低于 ${(minimum * 100).toFixed(0)}%`
      );
    }
  }

  const thumbnailWidth = Number(quality.thumbnail?.width || 0);
  const minimumDisplayFont = Number(quality.thumbnail?.minimum_text_px || 0);
  if (thumbnailWidth > 0 && minimumDisplayFont > 0) {
    const scale = thumbnailWidth / expectedWidth;
    for (const id of quality.thumbnail.text_layer_ids || []) {
      const layer = byId.get(id);
      if (layer?.visible && layer.fontSize * scale < minimumDisplayFont) {
        warn(
          "Q7",
          `缩到 ${thumbnailWidth}px 宽时，${id} 约为 `
          + `${(layer.fontSize * scale).toFixed(1)}px，小于 ${minimumDisplayFont}px`
        );
      }
    }
  }

  const navigationSafe = quality.navigation_safe_area;
  if (navigationSafe) {
    const safeBottom = expectedHeight - Number(navigationSafe.bottom || 0);
    for (const id of navigationSafe.layer_ids || quality.required_layer_ids || []) {
      const layer = byId.get(id);
      if (layer?.visible && layer.bounds.bottom > safeBottom + tolerance) {
        fail("Q9", `图层 ${id} 进入底部导航安全区`);
      }
    }
  }

  const titleRule = quality.title_to_content;
  if (titleRule) {
    const title = byId.get(titleRule.title_layer_id);
    const following = (titleRule.content_layer_ids || [])
      .map((id) => byId.get(id))
      .filter((layer) => layer?.visible && layer.bounds.y >= (title?.bounds.bottom || 0))
      .sort((left, right) => left.bounds.y - right.bounds.y)[0];
    if (title?.visible && following) {
      const gap = following.bounds.y - title.bounds.bottom;
      if (gap < Number(titleRule.minimum_px || 0)) {
        fail(
          "Q10",
          `标题与第一块有效内容间距 ${gap.toFixed(1)}px，`
            + `小于要求 ${titleRule.minimum_px}px`
        );
      }
    }
  }

  const whitespaceRule = quality.bottom_whitespace;
  if (whitespaceRule) {
    const measured = (whitespaceRule.content_layer_ids || [])
      .map((id) => byId.get(id))
      .filter((layer) => layer?.visible);
    if (measured.length) {
      const bottom = Math.max(...measured.map((layer) => layer.bounds.bottom));
      const ratio = Math.max(0, expectedHeight - bottom) / expectedHeight;
      if (ratio > Number(whitespaceRule.maximum_ratio || 0)) {
        fail(
          "Q11",
          `底部空白 ${(ratio * 100).toFixed(1)}%，`
            + `大于要求 ${(Number(whitespaceRule.maximum_ratio) * 100).toFixed(1)}%`
        );
      }
    }
  }

  if (screenshotPath) {
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    const canvas = page.locator(quality.canvas_selector || ".media-canvas");
    await canvas.screenshot({ path: screenshotPath });
  }

  return { failures, warnings, inspection, browserErrors, consoleErrors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = normalizeTarget(args.target);
  const manifestDir = path.dirname(manifestPath);
  const manifest = readJson(manifestPath);
  const structural = structuralChecks(manifest, manifestPath);
  const requestedVariants = args.variant
    ? structural.variants.filter((variant) => variant.id === args.variant)
    : structural.variants;
  const requestedScenes = args.scene
    ? structural.scenes.filter((scene) => scene.id === args.scene)
    : structural.scenes;
  if (args.variant && requestedVariants.length === 0) {
    structural.failures.push({ rule: "S5", message: `找不到输出变体 ${args.variant}` });
  }
  if (args.scene && requestedScenes.length === 0) {
    structural.failures.push({ rule: "S8", message: `找不到场景 ${args.scene}` });
  }

  const localPaths = [manifestPath, ...localResourcePaths(manifest, manifestDir)];
  const serveRoot = commonAncestor(localPaths);
  const entryPath = path.resolve(manifestDir, manifest.entry || "index.html");
  const entryRelative = path.relative(serveRoot, entryPath).split(path.sep).map(encodeURIComponent).join("/");
  const report = {
    manifest: manifestPath,
    checked_at: new Date().toISOString(),
    structural: {
      failures: structural.failures,
      warnings: structural.warnings,
    },
    targets: [],
  };

  let server;
  let browser;
  try {
    if (requestedVariants.length > 0
      && requestedScenes.length > 0
      && structural.failures.length === 0) {
      const playwright = loadPlaywright();
      server = await startStaticServer(serveRoot);
      browser = await playwright.chromium.launch({ headless: true });
      const page = await browser.newPage();
      const baseUrl = `http://127.0.0.1:${server.port}/${entryRelative}`;
      let exercisedPlayback = false;
      for (const variant of requestedVariants) {
        for (const scene of requestedScenes) {
          const screenshotPath = args.screenshot
            ? screenshotPathForTarget(
              args.screenshot,
              variant.id,
              scene.id,
              requestedVariants.length * requestedScenes.length > 1
            )
            : null;
          const baseQuality = manifest.quality || {};
          const variantQuality = baseQuality.variant_overrides?.[variant.id] || {};
          const sceneQuality = baseQuality.scene_overrides?.[scene.id] || {};
          const contract = manifest.layout_contracts.find(
            (item) => item.id === scene.layout_id
          );
          const targetQuality = {
            ...baseQuality,
            ...variantQuality,
            ...sceneQuality,
            required_layer_ids: Array.from(new Set([
              ...(variantQuality.required_layer_ids
                || sceneQuality.required_layer_ids
                || baseQuality.required_layer_ids
                || []),
              ...(contract?.required_layer_ids || []),
            ])),
            required_title_layer_ids: contract?.title_layer_ids || [],
          };
          delete targetQuality.variant_overrides;
          delete targetQuality.scene_overrides;
          const result = await inspectTarget(
            page,
            manifest,
            variant,
            scene,
            targetQuality,
            baseUrl,
            screenshotPath,
            !exercisedPlayback
          );
          exercisedPlayback = true;
          report.targets.push({
            variant_id: variant.id,
            scene_id: scene.id,
            canvas: variant.canvas,
            screenshot: screenshotPath,
            failures: result.failures,
            warnings: result.warnings,
            measured_layers: result.inspection?.layers || [],
          });
        }
      }
    }
  } catch (error) {
    report.structural.failures.push({ rule: "RUNTIME", message: error.message });
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }

  const failureCount = report.structural.failures.length
    + report.targets.reduce((sum, target) => sum + target.failures.length, 0);
  const warningCount = report.structural.warnings.length
    + report.targets.reduce((sum, target) => sum + target.warnings.length, 0);
  report.summary = {
    passed: failureCount === 0,
    failures: failureCount,
    warnings: warningCount,
  };

  if (args.report) {
    const reportPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(`editable-media：${manifestPath}`);
  for (const failure of report.structural.failures) {
    console.log(`FAIL ${failure.rule}  ${failure.message}`);
  }
  for (const warning of report.structural.warnings) {
    console.log(`WARN ${warning.rule}  ${warning.message}`);
  }
  for (const target of report.targets) {
    console.log(
      `输出变体 ${target.variant_id} / 场景 ${target.scene_id}`
        + `（${target.canvas.width}×${target.canvas.height}）`
    );
    target.failures.forEach((item) => console.log(`FAIL ${item.rule}  ${item.message}`));
    target.warnings.forEach((item) => console.log(`WARN ${item.rule}  ${item.message}`));
    if (target.failures.length === 0) console.log("PASS 浏览器结构、播放与量化检查");
  }
  console.log(
    report.summary.passed
      ? `通过：0 个失败，${warningCount} 个提醒`
      : `未通过：${failureCount} 个失败，${warningCount} 个提醒`
  );
  process.exitCode = report.summary.passed ? 0 : 1;
}

await main();
