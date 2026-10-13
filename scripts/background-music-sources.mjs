#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {Readable, Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import {fileURLToPath} from "node:url";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {assertSkillTaskPath, SKILL_ROOT} from "./media-task-workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SCHEMA_PATH = path.join(
  SKILL_ROOT,
  "schemas",
  "background-music-candidates.v1.schema.json",
);
const IMPORT_SCRIPT = path.join(SCRIPT_DIR, "import-media-asset.mjs");
const PROTOCOL = "visual-multimedia-background-music-candidates";
const VERSION = 1;
const CC0_LICENSE = "CC0-1.0";
const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
const DEFAULT_LIMIT = 12;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const PROVIDERS = ["openverse", "wikimedia-commons", "ccmixter"];
const PROVIDER_LABELS = {
  openverse: "Openverse",
  "wikimedia-commons": "Wikimedia Commons",
  ccmixter: "ccMixter",
};
const DEFAULT_ENDPOINTS = {
  openverse: "https://api.openverse.org/v1/audio/",
  "wikimedia-commons": "https://commons.wikimedia.org/w/api.php",
  ccmixter: "https://ccmixter.org/api/query",
};
const TERMS_URLS = {
  openverse: "https://docs.openverse.org/api/",
  "wikimedia-commons": "https://commons.wikimedia.org/wiki/Commons:API",
  ccmixter: "https://license.ccmixter.org/query-api",
};
const AUDIO_EXTENSIONS = new Set([
  "aac",
  "aif",
  "aiff",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "wave",
  "webm",
]);
const MIME_EXTENSIONS = new Map([
  ["audio/aac", "aac"],
  ["audio/flac", "flac"],
  ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
  ["audio/opus", "opus"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["application/ogg", "ogg"],
  ["video/webm", "webm"],
]);

function usage() {
  console.log(`用法：
node scripts/background-music-sources.mjs list-sources

node scripts/background-music-sources.mjs search --query <音乐需求>
  [--providers openverse,wikimedia-commons,ccmixter] [--limit 12]
  [--duration-min <秒>] [--duration-max <秒>] [--allow-vocals]
  [--project <项目目录> --output reports/background-music-candidates.json]

node scripts/background-music-sources.mjs validate
  --project <项目目录> --report <候选报告>

node scripts/background-music-sources.mjs acquire
  --project <项目目录> --report <候选报告> --candidate-id <候选 id>
  --source-id <素材 id> --usage <当前项目用途>
  [--max-bytes <字节>] [--ffprobe <路径>] [--captured-at <ISO 时间>]

search 只查询无需账号的公开接口，并且只保留许可地址能够精确确认 CC0 1.0 的结果。
acquire 会重新读取提供方记录、再次确认 CC0、下载真实音频、用 FFprobe 检查，随后调用
现有 import-media-asset.mjs 写入项目唯一的 media-sources.json v3；不会把候选自动绑定到时间线。

测试或私有镜像可覆盖：--openverse-api、--wikimedia-api、--ccmixter-api。`);
}

function parseArgs(argv) {
  const args = new Map();
  const booleans = new Set(["allow-vocals"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    if (booleans.has(key)) {
      args.set(key, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    args.set(key, argv[index + 1]);
    index += 1;
  }
  return args;
}

function assertAllowed(args, allowed) {
  for (const key of args.keys()) {
    if (!allowed.has(key)) throw new Error(`当前命令不接受 --${key}`);
  }
}

function required(args, key) {
  const value = String(args.get(key) || "").trim();
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}

function finiteNumber(args, key, fallback = null) {
  if (!args.has(key)) return fallback;
  const value = Number(args.get(key));
  if (!Number.isFinite(value)) throw new Error(`--${key} 必须是有限数字`);
  return value;
}

function integer(args, key, fallback, minimum, maximum) {
  const value = args.has(key) ? Number(args.get(key)) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${key} 必须是 ${minimum}–${maximum} 的整数`);
  }
  return value;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isoDate(value, label) {
  const raw = String(value || new Date().toISOString()).trim();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} 不是有效时间`);
  return parsed.toISOString();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.protocol === "http:" && url.hostname.toLowerCase().endsWith("creativecommons.org")) {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function exactCc0(licenseName, licenseUrl) {
  const label = stripHtml(licenseName).toLowerCase().replace(/[\s_-]+/gu, "");
  const normalized = normalizeUrl(licenseUrl);
  if (!normalized) return false;
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  const pathName = url.pathname.toLowerCase().replace(/\/+$/u, "");
  const exactUrl = host === "creativecommons.org"
    && pathName.startsWith("/publicdomain/zero/1.0");
  const plausibleLabel = !label
    || label === "cc0"
    || label === "cc01.0"
    || label === "creativecommonszero"
    || label === "publicdomain";
  return exactUrl && plausibleLabel;
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : [value];
  const tags = [];
  for (const item of raw) {
    const resolved = typeof item === "object" && item !== null
      ? item.name ?? item.tag ?? item.value ?? ""
      : item;
    for (const part of String(resolved || "").split(/[|,;\n]+/u)) {
      const tag = stripHtml(part).trim();
      if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
        tags.push(tag);
      }
      if (tags.length >= 40) return tags;
    }
  }
  return tags;
}

function instrumentalStatus(title, description, tags) {
  const haystack = [title, description, ...tags].join(" ").toLowerCase();
  if (/\b(instrumental|no[ -]?vocals?|without vocals?)\b/u.test(haystack)) {
    return "confirmed";
  }
  if (/\b(background music|music bed|underscore|ambient music|loop)\b/u.test(haystack)) {
    return "suggested";
  }
  return "unknown";
}

function hasRightsWarning(tags) {
  return tags.some((tag) => /license\s+review\s+needed|copyright.*(?:problem|violation|disput|unknown)|unclear\s+copyright|no\s+(?:machine-readable\s+)?license|deletion\s+request/iu.test(tag));
}

function extensionFrom(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/^\./u, "");
  if (AUDIO_EXTENSIONS.has(raw)) return raw === "wave" ? "wav" : raw;
  const mimeExtension = MIME_EXTENSIONS.get(raw.split(";", 1)[0]);
  if (mimeExtension) return mimeExtension;
  try {
    const ext = path.extname(new URL(value).pathname).slice(1).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) return ext === "wave" ? "wav" : ext;
  } catch {
    const ext = path.extname(raw).slice(1).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) return ext === "wave" ? "wav" : ext;
  }
  return "";
}

function filenameFrom(downloadUrl, title, remoteId, extension) {
  try {
    const base = decodeURIComponent(path.basename(new URL(downloadUrl).pathname));
    if (base && base !== "/") return base;
  } catch {
    // Use the stable fallback below.
  }
  const name = safeFilename(title || remoteId || "background-music");
  return extension ? `${name}.${extension}` : name;
}

function safeFilename(value) {
  const normalized = String(value || "background-music")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[. -]+|[. -]+$/gu, "")
    .slice(0, 80);
  return normalized || "background-music";
}

function sourceRecordUrl(provider, endpoint, remoteId) {
  if (provider === "openverse") {
    const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
    return new URL(`${encodeURIComponent(remoteId)}/`, base).toString();
  }
  const url = new URL(endpoint);
  if (provider === "wikimedia-commons") {
    url.search = "";
    url.searchParams.set("action", "query");
    url.searchParams.set("pageids", remoteId);
    url.searchParams.set("prop", "imageinfo");
    url.searchParams.set("iiprop", "url|mime|extmetadata");
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    return url.toString();
  }
  url.search = "";
  url.searchParams.set("f", "json");
  url.searchParams.set("dataview", "info");
  url.searchParams.set("ids", remoteId);
  return url.toString();
}

function makeCandidate({
  provider,
  remoteId,
  title,
  creator,
  description,
  duration,
  tags,
  landingUrl,
  downloadUrl,
  filename,
  mimeType,
  extension,
  sourceUrl,
  licenseName,
  licenseUrl,
}) {
  const normalizedDownload = normalizeUrl(downloadUrl);
  const normalizedLanding = normalizeUrl(landingUrl) || normalizeUrl(sourceUrl);
  if (!remoteId || !title || !normalizedDownload || !normalizedLanding) return null;
  if (!exactCc0(licenseName, licenseUrl)) return null;
  const normalizedTags = normalizeTags(tags);
  if (hasRightsWarning(normalizedTags)) return null;
  const normalizedDescription = stripHtml(description);
  const normalizedExtension = extensionFrom(extension)
    || extensionFrom(mimeType)
    || extensionFrom(normalizedDownload);
  return {
    id: `${provider}:${remoteId}`,
    provider,
    remote_id: String(remoteId),
    title: stripHtml(title),
    creator: stripHtml(creator),
    description: normalizedDescription,
    duration_seconds: positiveNumber(duration),
    tags: normalizedTags,
    instrumental_status: instrumentalStatus(title, normalizedDescription, normalizedTags),
    landing_url: normalizedLanding,
    download_url: normalizedDownload,
    download_filename: stripHtml(filename)
      || filenameFrom(normalizedDownload, title, remoteId, normalizedExtension),
    mime_type: String(mimeType || "").trim().toLowerCase(),
    file_extension: normalizedExtension,
    source_record_url: normalizeUrl(sourceUrl),
    provider_terms_url: TERMS_URLS[provider],
    license: CC0_LICENSE,
    license_url: CC0_URL,
    attribution_required: false,
  };
}

function openverseCandidate(item, endpoint, explicitSourceUrl = "") {
  const remoteId = String(item?.id || "").trim();
  return makeCandidate({
    provider: "openverse",
    remoteId,
    title: item?.title || `Openverse audio ${remoteId}`,
    creator: item?.creator || "",
    description: item?.description || "",
    duration: item?.duration,
    tags: item?.tags || [],
    landingUrl: item?.foreign_landing_url || item?.landing_url || item?.detail_url,
    downloadUrl: item?.url || item?.download_url,
    filename: item?.filename || "",
    mimeType: item?.mime_type || "",
    extension: item?.filetype || "",
    sourceUrl: explicitSourceUrl || sourceRecordUrl("openverse", endpoint, remoteId),
    licenseName: item?.license,
    licenseUrl: item?.license_url,
  });
}

function metadataValue(metadata, key) {
  return metadata?.[key]?.value ?? metadata?.[key] ?? "";
}

function wikimediaCandidate(page, endpoint, explicitSourceUrl = "") {
  const imageInfo = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  const metadata = imageInfo?.extmetadata || {};
  const remoteId = String(page?.pageid || "").trim();
  const title = String(page?.title || "").replace(/^File:/iu, "");
  return makeCandidate({
    provider: "wikimedia-commons",
    remoteId,
    title,
    creator: metadataValue(metadata, "Artist") || metadataValue(metadata, "Creator"),
    description: metadataValue(metadata, "ImageDescription"),
    duration: null,
    tags: metadataValue(metadata, "Categories"),
    landingUrl: imageInfo?.descriptionurl || imageInfo?.descriptionshorturl,
    downloadUrl: imageInfo?.url,
    filename: title,
    mimeType: imageInfo?.mime || "",
    extension: imageInfo?.mime || imageInfo?.url || title,
    sourceUrl: explicitSourceUrl || sourceRecordUrl("wikimedia-commons", endpoint, remoteId),
    licenseName: metadataValue(metadata, "LicenseShortName"),
    licenseUrl: metadataValue(metadata, "LicenseUrl"),
  });
}

function firstAudioFile(item) {
  const files = Array.isArray(item?.files) ? item.files : [];
  return files.find((file) => {
    const candidate = file?.download_url || file?.file_url || file?.url || file?.file_name;
    return extensionFrom(candidate) || /^audio\//iu.test(String(file?.file_type || file?.mime_type || ""));
  }) || files[0] || {};
}

function ccMixterRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function ccMixterCandidate(item, endpoint, explicitSourceUrl = "") {
  const file = firstAudioFile(item);
  const remoteId = String(item?.upload_id ?? item?.id ?? "").trim();
  const duration = item?.duration
    ?? item?.upload_duration
    ?? file?.duration
    ?? file?.file_duration
    ?? file?.file_extra?.duration
    ?? null;
  return makeCandidate({
    provider: "ccmixter",
    remoteId,
    title: item?.upload_name || item?.title || `ccMixter audio ${remoteId}`,
    creator: item?.user_real_name || item?.user_name || item?.user || item?.creator || "",
    description: item?.upload_description_html || item?.upload_description || item?.description || "",
    duration,
    tags: item?.upload_tags || item?.tags || [],
    landingUrl: item?.file_page_url || item?.upload_page_url || item?.url,
    downloadUrl: item?.download_url || file?.download_url || file?.file_url || file?.url,
    filename: file?.file_name || item?.file_name || "",
    mimeType: file?.file_type || file?.mime_type || item?.mime_type || "",
    extension: file?.file_name || file?.file_type || item?.filetype || "",
    sourceUrl: explicitSourceUrl || sourceRecordUrl("ccmixter", endpoint, remoteId),
    licenseName: item?.upload_license || item?.license_name || item?.license || "public domain",
    licenseUrl: item?.license_url || item?.upload_license_url,
  });
}

async function fetchJson(url, label, timeoutMs = 20000) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "visual-multimedia-background-music/1.0",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${label} 返回 HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("text/html")) {
    throw new Error(`${label} 返回了 HTML 而不是 JSON`);
  }
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} 没有返回可解析 JSON：${contentType || "未知类型"}`);
  }
}

async function searchOpenverse(endpoint, query, limit) {
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("license", "cc0");
  url.searchParams.set("page_size", String(Math.min(limit, 20)));
  const body = await fetchJson(url, "Openverse 音频检索");
  return (body?.results || [])
    .map((item) => openverseCandidate(item, endpoint))
    .filter(Boolean);
}

async function searchWikimedia(endpoint, query, limit) {
  const url = new URL(endpoint);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} filetype:audio incategory:CC-Zero`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(Math.min(limit, 50)));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|mime|extmetadata");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  const body = await fetchJson(url, "Wikimedia Commons 音频检索");
  return (body?.query?.pages || [])
    .map((page) => wikimediaCandidate(page, endpoint))
    .filter(Boolean);
}

async function searchCcMixter(endpoint, query, limit) {
  const url = new URL(endpoint);
  url.searchParams.set("f", "json");
  url.searchParams.set("dataview", "info");
  url.searchParams.set("lic", "pd");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("search", query);
  url.searchParams.set("search_type", "all");
  const body = await fetchJson(url, "ccMixter 音频检索");
  return ccMixterRows(body)
    .map((item) => ccMixterCandidate(item, endpoint))
    .filter(Boolean);
}

function providerList(args) {
  const raw = String(args.get("providers") || "all").trim().toLowerCase();
  if (!raw || raw === "all") return [...PROVIDERS];
  const providers = raw.split(",").map((item) => {
    const value = item.trim();
    return value === "wikimedia" || value === "commons"
      ? "wikimedia-commons"
      : value;
  }).filter(Boolean);
  if (!providers.length || providers.some((provider) => !PROVIDERS.includes(provider))) {
    throw new Error(`--providers 只接受 all 或 ${PROVIDERS.join(",")}`);
  }
  return [...new Set(providers)];
}

function endpoints(args) {
  return {
    openverse: normalizeUrl(args.get("openverse-api") || DEFAULT_ENDPOINTS.openverse),
    "wikimedia-commons": normalizeUrl(args.get("wikimedia-api") || DEFAULT_ENDPOINTS["wikimedia-commons"]),
    ccmixter: normalizeUrl(args.get("ccmixter-api") || DEFAULT_ENDPOINTS.ccmixter),
  };
}

function durationMatches(candidate, minimum, maximum) {
  if (candidate.duration_seconds === null) return true;
  if (minimum !== null && candidate.duration_seconds < minimum) return false;
  if (maximum !== null && candidate.duration_seconds > maximum) return false;
  return true;
}

function interleave(groups, limit) {
  const queues = groups.map((group) => [...group]);
  const result = [];
  const seen = new Set();
  while (result.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const candidate = queue.shift();
      if (!candidate) continue;
      const identity = `${candidate.provider}:${candidate.remote_id}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        result.push(candidate);
      }
      if (result.length >= limit) break;
    }
  }
  return result;
}

function projectRoot(args) {
  const root = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`项目目录不存在：${root}`);
  }
  return root;
}

function projectPath(root, value, label) {
  const target = path.resolve(root, String(value || ""));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于当前项目目录内：${target}`);
  }
  assertSkillTaskPath(target, label);
  return target;
}

function assertReport(report) {
  assertJsonSchema(report, SCHEMA_PATH, "BGM 候选报告");
  const ids = new Set();
  for (const candidate of report.candidates) {
    if (ids.has(candidate.id)) throw new Error(`BGM 候选 id 重复：${candidate.id}`);
    ids.add(candidate.id);
    if (!exactCc0(candidate.license, candidate.license_url)) {
      throw new Error(`BGM 候选不是精确 CC0：${candidate.id}`);
    }
    if (candidate.attribution_required !== false) {
      throw new Error(`BGM 候选要求署名：${candidate.id}`);
    }
  }
  return report;
}

function readReport(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`候选报告不存在：${filePath}`);
  }
  return assertReport(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function writeReport(filePath, report) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function searchCommand(args) {
  assertAllowed(args, new Set([
    "query",
    "providers",
    "limit",
    "duration-min",
    "duration-max",
    "allow-vocals",
    "project",
    "output",
    "openverse-api",
    "wikimedia-api",
    "ccmixter-api",
  ]));
  const query = required(args, "query");
  const providers = providerList(args);
  const limit = integer(args, "limit", DEFAULT_LIMIT, 1, 50);
  const minimum = finiteNumber(args, "duration-min", null);
  const maximum = finiteNumber(args, "duration-max", null);
  if (minimum !== null && minimum < 0) throw new Error("--duration-min 不能小于 0");
  if (maximum !== null && maximum <= 0) throw new Error("--duration-max 必须大于 0");
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw new Error("--duration-min 不能大于 --duration-max");
  }
  if (args.has("output") !== args.has("project")) {
    throw new Error("写候选报告时必须同时提供 --project 与 --output");
  }
  const api = endpoints(args);
  const runs = await Promise.all(providers.map(async (provider) => {
    try {
      let candidates;
      if (provider === "openverse") {
        candidates = await searchOpenverse(api[provider], query, limit);
      } else if (provider === "wikimedia-commons") {
        candidates = await searchWikimedia(api[provider], query, limit);
      } else {
        candidates = await searchCcMixter(api[provider], query, limit);
      }
      return {
        provider,
        candidates: candidates.filter((candidate) => durationMatches(candidate, minimum, maximum)),
        run: {
          provider,
          api_url: api[provider],
          terms_url: TERMS_URLS[provider],
          status: "succeeded",
          error: "",
        },
      };
    } catch (error) {
      return {
        provider,
        candidates: [],
        run: {
          provider,
          api_url: api[provider],
          terms_url: TERMS_URLS[provider],
          status: "failed",
          error: String(error.message || error),
        },
      };
    }
  }));
  if (runs.every((item) => item.run.status === "failed")) {
    throw new Error(
      `全部 BGM 来源都不可用：\n${runs.map((item) => `- ${item.provider}: ${item.run.error}`).join("\n")}`,
    );
  }
  const report = assertReport({
    protocol: PROTOCOL,
    version: VERSION,
    generated_at: new Date().toISOString(),
    request: {
      query,
      providers,
      limit,
      duration_min_seconds: minimum,
      duration_max_seconds: maximum,
      instrumental_preference: !args.has("allow-vocals"),
    },
    license_policy: {
      commercial_use: true,
      public_attribution_required: false,
      accepted_licenses: [CC0_LICENSE],
      fallback_to_attribution_required: false,
    },
    provider_runs: runs.map((item) => item.run),
    candidates: interleave(runs.map((item) => item.candidates), limit),
  });
  let outputPath = null;
  if (args.has("output")) {
    const root = projectRoot(args);
    outputPath = projectPath(root, args.get("output"), "--output");
    writeReport(outputPath, report);
  }
  console.log(JSON.stringify({report_path: outputPath, ...report}, null, 2));
}

async function refreshCandidate(candidate) {
  const body = await fetchJson(candidate.source_record_url, `${PROVIDER_LABELS[candidate.provider]} 许可复核`);
  let refreshed = null;
  if (candidate.provider === "openverse") {
    refreshed = openverseCandidate(body, candidate.source_record_url, candidate.source_record_url);
  } else if (candidate.provider === "wikimedia-commons") {
    const page = (body?.query?.pages || []).find(
      (item) => String(item?.pageid || "") === candidate.remote_id,
    );
    refreshed = wikimediaCandidate(page, candidate.source_record_url, candidate.source_record_url);
  } else {
    const item = ccMixterRows(body).find(
      (row) => String(row?.upload_id ?? row?.id ?? "") === candidate.remote_id,
    );
    refreshed = ccMixterCandidate(item, candidate.source_record_url, candidate.source_record_url);
  }
  if (!refreshed || refreshed.remote_id !== candidate.remote_id) {
    throw new Error(`提供方记录已变化或不再满足精确 CC0：${candidate.id}`);
  }
  return refreshed;
}

function findCommand(name, explicit = "") {
  const requested = String(explicit || "").trim();
  if (requested) {
    const resolved = path.resolve(requested);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`找不到 ${name}：${resolved}`);
    }
    return resolved;
  }
  const fromEnvironment = String(process.env.FFPROBE_BIN || "").trim();
  if (name === "ffprobe" && fromEnvironment) return findCommand(name, fromEnvironment);
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [name], {encoding: "utf8", windowsHide: true});
  if (result.status !== 0) throw new Error(`找不到 ${name}`);
  return String(result.stdout || "").split(/\r?\n/u).map((item) => item.trim()).find(Boolean);
}

function probeAudio(filePath, explicitFfprobe = "") {
  const ffprobe = findCommand("ffprobe", explicitFfprobe);
  const result = spawnSync(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration,format_name:stream=index,codec_type,codec_name,sample_rate,channels",
    "-of",
    "json",
    filePath,
  ], {encoding: "utf8", windowsHide: true});
  if (result.status !== 0) {
    throw new Error(`下载文件无法由 FFprobe 读取：${String(result.stderr || result.stdout).trim()}`);
  }
  const probe = JSON.parse(result.stdout);
  const audioStreams = (probe.streams || []).filter((stream) => stream.codec_type === "audio");
  const duration = positiveNumber(probe?.format?.duration);
  if (!audioStreams.length || duration === null) {
    throw new Error("下载文件不是具有有效时长的音频");
  }
  return {
    ffprobe,
    duration_seconds: duration,
    format_name: String(probe?.format?.format_name || ""),
    audio_streams: audioStreams,
  };
}

class ByteLimit extends Transform {
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    this.bytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new Error(`下载超过允许的 ${this.maxBytes} 字节`));
      return;
    }
    callback(null, chunk);
  }
}

function downloadExtension(candidate) {
  return extensionFrom(candidate.file_extension)
    || extensionFrom(candidate.mime_type)
    || extensionFrom(candidate.download_filename)
    || extensionFrom(candidate.download_url)
    || "audio";
}

async function downloadCandidate(candidate, root, maxBytes) {
  const extension = downloadExtension(candidate);
  const identity = crypto.createHash("sha256")
    .update(`${candidate.id}\n${candidate.download_url}`)
    .digest("hex")
    .slice(0, 12);
  const baseName = safeFilename(path.parse(candidate.download_filename).name || candidate.title);
  const directory = path.join(root, "working", "background-music");
  const target = path.join(directory, `${baseName}-${identity}.${extension}`);
  fs.mkdirSync(directory, {recursive: true});
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isFile()) throw new Error(`下载目标不是文件：${target}`);
    return {file: target, downloaded: false, bytes: fs.statSync(target).size};
  }
  const response = await fetch(candidate.download_url, {
    headers: {"user-agent": "visual-multimedia-background-music/1.0"},
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`BGM 下载返回 HTTP ${response.status}`);
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (/text\/html|application\/json|text\/plain/u.test(contentType)) {
    throw new Error(`BGM 下载返回了非音频内容：${contentType}`);
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`BGM 文件声明大小 ${declaredBytes} 超过限制 ${maxBytes}`);
  }
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  const limiter = new ByteLimit(maxBytes);
  await pipeline(
    Readable.fromWeb(response.body),
    limiter,
    fs.createWriteStream(temporary, {flags: "wx"}),
  );
  fs.renameSync(temporary, target);
  return {file: target, downloaded: true, bytes: limiter.bytes};
}

function runImport(root, candidate, inputFile, sourceId, usageText, capturedAt) {
  const notes = [
    `由 ${path.basename(SCRIPT_PATH)} 取得并重新核对精确 CC0`,
    `candidate=${candidate.id}`,
    `license_record=${candidate.source_record_url}`,
    `direct_download=${candidate.download_url}`,
  ].join("; ");
  const result = spawnSync(process.execPath, [
    IMPORT_SCRIPT,
    "--project", root,
    "--input", inputFile,
    "--id", sourceId,
    "--media-type", "audio",
    "--method", "external-download",
    "--rights-status", "confirmed",
    "--license", CC0_LICENSE,
    "--usage", usageText,
    "--source-url", candidate.landing_url,
    "--provider", PROVIDER_LABELS[candidate.provider],
    "--terms-url", CC0_URL,
    "--captured-at", capturedAt,
    "--notes", notes,
  ], {encoding: "utf8", windowsHide: true});
  if (result.status !== 0) {
    throw new Error(`BGM 已下载但素材入账失败：${String(result.stderr || result.stdout).trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`素材导入器没有返回结构化结果：${String(result.stdout).trim()}`);
  }
}

async function acquireCommand(args) {
  assertAllowed(args, new Set([
    "project",
    "report",
    "candidate-id",
    "source-id",
    "usage",
    "max-bytes",
    "ffprobe",
    "captured-at",
  ]));
  const root = projectRoot(args);
  const reportPath = projectPath(root, required(args, "report"), "--report");
  const report = readReport(reportPath);
  const candidateId = required(args, "candidate-id");
  const sourceId = required(args, "source-id");
  const usageText = required(args, "usage");
  const maximumBytes = integer(args, "max-bytes", DEFAULT_MAX_BYTES, 1024, 1024 * 1024 * 1024);
  const capturedAt = isoDate(args.get("captured-at"), "--captured-at");
  const candidate = report.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`候选报告中没有 ${candidateId}`);
  const refreshed = await refreshCandidate(candidate);
  const downloaded = await downloadCandidate(refreshed, root, maximumBytes);
  const probe = probeAudio(downloaded.file, args.get("ffprobe") || "");
  const imported = runImport(
    root,
    refreshed,
    downloaded.file,
    sourceId,
    usageText,
    capturedAt,
  );
  console.log(JSON.stringify({
    acquired: true,
    candidate: refreshed,
    license_revalidated_at: capturedAt,
    downloaded,
    probe,
    imported,
    next_action: "由 Agent 试听候选并在活动视频或音频时间线中显式采用 source id；主观适配未经试听确认前仍是候选。",
  }, null, 2));
}

function validateCommand(args) {
  assertAllowed(args, new Set(["project", "report"]));
  const root = projectRoot(args);
  const reportPath = projectPath(root, required(args, "report"), "--report");
  const report = readReport(reportPath);
  console.log(JSON.stringify({
    valid: true,
    report: reportPath,
    candidates: report.candidates.length,
    license: CC0_LICENSE,
    public_attribution_required: false,
  }, null, 2));
}

function listSources() {
  console.log(JSON.stringify({
    automated: [
      {
        id: "openverse",
        name: "Openverse Audio API",
        api_url: DEFAULT_ENDPOINTS.openverse,
        role: "宽范围发现；采用前重新读取单条记录并严格确认 CC0",
        account_required: false,
      },
      {
        id: "wikimedia-commons",
        name: "Wikimedia Commons MediaWiki API",
        api_url: DEFAULT_ENDPOINTS["wikimedia-commons"],
        role: "读取文件页原始音频与扩展许可元数据",
        account_required: false,
      },
      {
        id: "ccmixter",
        name: "ccMixter Query API",
        api_url: DEFAULT_ENDPOINTS.ccmixter,
        role: "先查询 public-domain 结果，再只保留许可地址为 CC0 1.0 的曲目",
        account_required: false,
      },
    ],
    manual_fallback: [
      {
        id: "opengameart",
        name: "OpenGameArt",
        url: "https://opengameart.org/",
        rule: "没有稳定发现 API；只采用具体音乐页明确标注 CC0 的文件，再用通用素材导入器入账",
      },
    ],
    excluded_from_no_attribution_default: [
      "要求公开署名的 CC BY 音乐",
      "只写 royalty-free 或 free、但没有逐曲商业使用和免署名依据的音乐",
      "需要账号、API Key、付费或许可文字自相矛盾而尚未单独获准的来源",
    ],
    license_policy: {
      commercial_use: true,
      public_attribution_required: false,
      accepted_licenses: [CC0_LICENSE],
      fallback_to_attribution_required: false,
      terms_url: CC0_URL,
    },
  }, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || rest.includes("--help")) {
    usage();
    return command ? 0 : 1;
  }
  if (command === "list-sources") {
    if (rest.length) throw new Error("list-sources 不接受其它参数");
    listSources();
    return 0;
  }
  const args = parseArgs(rest);
  if (command === "search") await searchCommand(args);
  else if (command === "validate") validateCommand(args);
  else if (command === "acquire") await acquireCommand(args);
  else throw new Error(`未知命令：${command}`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
