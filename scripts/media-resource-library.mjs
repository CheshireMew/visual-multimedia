#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertEditableMediaPackageClosed,
  readEditableMediaPackage,
} from "./editable-media-contract.mjs";
import { assertJsonSchema } from "./json_schema_contract.mjs";
import {
  EDITABLE_MEDIA_SOURCES_CONTRACT,
  validateMediaSources,
} from "./validate-media-sources.mjs";
import { assertSkillTaskPath } from "./media-task-workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(SCRIPT_DIR);
const SCHEMA_DIR = path.join(SKILL_ROOT, "schemas");
const LIBRARY_SCHEMA = path.join(SCHEMA_DIR, "media-resource-library.v1.schema.json");
const REGISTRY_SCHEMA = path.join(SCHEMA_DIR, "media-resource-registry.v1.schema.json");
const ADOPTIONS_SCHEMA = path.join(SCHEMA_DIR, "media-resource-adoptions.v1.schema.json");
const PROMOTIONS_SCHEMA = path.join(SCHEMA_DIR, "resource-promotion-candidates.v1.schema.json");
const IMPORTER = path.join(SCRIPT_DIR, "import-media-asset.mjs");
const EDITABLE_MEDIA_VALIDATOR = path.join(SCRIPT_DIR, "validate-editable-media.mjs");
const LIBRARY_FILE = "media-library.json";
const REGISTRY_FILE = "registry.json";
const ADOPTIONS_FILE = "media-resource-adoptions.json";
const PROMOTIONS_FILE = "resource-promotion-candidates.json";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const LIBRARY_KINDS = new Set([
  "creator-media",
  "production-assets",
  "web-components",
]);
const RESOURCE_KINDS = new Set(["creator-media", "production-assets"]);
const TARGET_KINDS = new Set([
  ...LIBRARY_KINDS,
  "visual-style-profile",
  "sound-production-profile",
]);
const MEDIA_TYPES = new Set([
  "photo",
  "screenshot",
  "video",
  "video-frame",
  "audio",
  "subtitle",
  "icon",
  "document",
  "generated",
]);
const RIGHTS = new Set(["confirmed", "not-required"]);
const METHODS = new Set([
  "user-provided",
  "project-owned",
  "external-download",
  "generated",
]);

function usage() {
  console.log(`用法：
  node scripts/media-resource-library.mjs init-registry --registry <目录>
  node scripts/media-resource-library.mjs init-library --library <目录>
    --id <库 id> --version <x.y.z> --kind <creator-media|production-assets|web-components>
    --name <名称> [--description <说明>]
  node scripts/media-resource-library.mjs add-file --library <目录> --input <文件>
    --item-id <id> --name <名称> --media-type <类型> --role <职责>
    --rights-status <confirmed|not-required> --license <依据>
    [--method <取得方式>] [--source-url <来源>] [--provider <提供方>]
    [--captured-at <ISO 时间>] [--attribution <署名>] [--terms-url <地址>]
    [--tag <标签>]...
  node scripts/media-resource-library.mjs add-component --library <目录> --package <网页包>
    --item-id <id> --name <名称> --role <职责> [--tag <标签>]...
  node scripts/media-resource-library.mjs register --registry <目录> --library <目录>
  node scripts/media-resource-library.mjs list --registry <目录> [--kind <类型>]
  node scripts/media-resource-library.mjs search --registry <目录>
    [--kind <类型>] [--query <名称、职责或标签>] [--tag <标签>]...
  node scripts/media-resource-library.mjs adopt --registry <目录> --library-id <id>
    --version <x.y.z> --item-id <id> --project <项目目录>
    [--project-id <id>] [--source-id <素材 id>]
  node scripts/media-resource-library.mjs propose --project <项目目录>
    --candidate-id <id> --target-kind <类型> --scope <project|series>
    --target-item-id <id> --rationale <理由> --evidence <项目内文件>...
    (--source-id <media-sources source id> | --source <项目内文件>)
    [--target-library-id <id>]
  node scripts/media-resource-library.mjs promote-file --project <项目目录>
    --candidate-id <id> --library <草稿库目录> --registry <注册表目录>
    --name <名称> --role <职责>
    [--tag <标签>]...
  node scripts/media-resource-library.mjs decide --project <项目目录>
    --candidate-id <id> --status <accepted|rejected> --notes <结论>
    [--published-target <路径或稳定标识>]

库没有全局默认项。注册只发布不可变版本；adopt 才把文件写入项目唯一的
media-sources.json，或把完整 editable-media 包复制进项目并重新验证。`);
}

function parseArgs(argv) {
  const command = argv[0];
  const values = new Map();
  const repeated = new Set(["tag", "evidence"]);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 --${key} 缺少值`);
    if (repeated.has(key)) {
      values.set(key, [...(values.get(key) || []), value]);
    } else {
      values.set(key, value);
    }
    index += 1;
  }
  return { command, values };
}

function required(args, key) {
  const value = args.get(key);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少必需参数 --${key}`);
  }
  return value.trim();
}

function requireId(value, label) {
  if (!ID_PATTERN.test(value || "")) throw new Error(`${label} 格式不合法：${value}`);
  return value;
}

function requireVersion(value, label) {
  if (!VERSION_PATTERN.test(value || "")) throw new Error(`${label} 必须是 x.y.z：${value}`);
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON ${filePath}：${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeNewOrSame(filePath, value, label) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, "utf8") !== serialized) {
      throw new Error(`${label} 已存在且内容不同，不会覆盖：${filePath}`);
    }
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serialized, { encoding: "utf8", flag: "wx" });
  return true;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    do {
      bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function treeEntries(root, current = root) {
  const entries = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`资源包不能包含符号链接：${absolute}`);
    if (entry.isDirectory()) entries.push(...treeEntries(root, absolute));
    else if (entry.isFile()) {
      entries.push({
        relative: path.relative(root, absolute).split(path.sep).join("/"),
        absolute,
      });
    }
  }
  return entries.sort((left, right) => left.relative.localeCompare(right.relative));
}

function sha256Tree(root) {
  const hash = crypto.createHash("sha256");
  for (const entry of treeEntries(root)) {
    hash.update(entry.relative);
    hash.update("\0");
    hash.update(sha256File(entry.absolute));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function mimeType(filePath) {
  const mapping = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".srt": "application/x-subrip",
    ".vtt": "text/vtt",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
  };
  return mapping[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function relativeInside(root, target, label) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于 ${absoluteRoot} 内：${absoluteTarget}`);
  }
  return relative.split(path.sep).join("/");
}

function resolveInside(root, value, label) {
  if (typeof value !== "string" || !value || value.includes("\\")) {
    throw new Error(`${label} 必须是使用 / 的相对路径`);
  }
  if (
    path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value.split("/").includes("..")
  ) {
    throw new Error(`${label} 不能离开所属目录：${value}`);
  }
  const absolute = path.resolve(root, ...value.split("/"));
  relativeInside(root, absolute, label);
  return absolute;
}

function copyFileContentAddressed(input, root, folder = "files") {
  const hash = sha256File(input);
  const extension = path.extname(input).toLowerCase();
  const destination = path.join(root, folder, hash.slice(0, 2), `${hash}${extension}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isFile() || sha256File(destination) !== hash) {
      throw new Error(`内容寻址目标冲突：${destination}`);
    }
  } else {
    fs.copyFileSync(input, destination, fs.constants.COPYFILE_EXCL);
  }
  return {
    file: relativeInside(root, destination, "资源文件"),
    sha256: hash,
    bytes: fs.statSync(destination).size,
    mime_type: mimeType(destination),
  };
}

function copyDirectoryOnce(source, destination, expectedHash) {
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isDirectory() || sha256Tree(destination) !== expectedHash) {
      throw new Error(`内容寻址目录已存在但内容不同：${destination}`);
    }
    return false;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: false,
  });
  if (sha256Tree(destination) !== expectedHash) {
    throw new Error(`目录复制后哈希不一致：${destination}`);
  }
  return true;
}

function libraryPath(root) {
  return path.join(path.resolve(root), LIBRARY_FILE);
}

function registryPath(root) {
  return path.join(path.resolve(root), REGISTRY_FILE);
}

function validateLibrary(root) {
  const absoluteRoot = path.resolve(root);
  const documentPath = libraryPath(absoluteRoot);
  if (!fs.existsSync(documentPath)) throw new Error(`找不到资源库清单：${documentPath}`);
  const library = readJson(documentPath);
  assertJsonSchema(library, LIBRARY_SCHEMA, "媒体资源库");
  if (!LIBRARY_KINDS.has(library.kind)) throw new Error(`资源库 kind 无效：${library.kind}`);
  const ids = new Set();
  for (const item of library.items) {
    if (ids.has(item.id)) throw new Error(`资源库 item id 重复：${item.id}`);
    ids.add(item.id);
    if (library.kind === "web-components" && item.type !== "editable-media-package") {
      throw new Error("web-components 资源库只能包含完整 editable-media 包");
    }
    if (RESOURCE_KINDS.has(library.kind) && item.type !== "file") {
      throw new Error(`${library.kind} 资源库只能包含文件素材`);
    }
    if (item.type === "file") {
      const target = resolveInside(absoluteRoot, item.file, `资源 ${item.id}.file`);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new Error(`资源文件不存在：${target}`);
      }
      if (sha256File(target) !== item.sha256 || fs.statSync(target).size !== item.bytes) {
        throw new Error(`资源 ${item.id} 的文件哈希或字节数不一致`);
      }
    } else {
      const target = resolveInside(absoluteRoot, item.package, `组件 ${item.id}.package`);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        throw new Error(`组件包不存在：${target}`);
      }
      const editable = readEditableMediaPackage(target);
      assertEditableMediaPackageClosed(editable.packageRoot, editable.manifest);
      const mediaValidation = validateMediaSources(
        path.join(editable.packageRoot, editable.manifest.media_sources),
        { contract: EDITABLE_MEDIA_SOURCES_CONTRACT },
      );
      if (!mediaValidation.ok) {
        throw new Error(`组件 ${item.id} 的素材账本无效：\n- ${mediaValidation.errors.join("\n- ")}`);
      }
      if (
        sha256File(editable.manifestPath) !== item.manifest_sha256
        || sha256Tree(target) !== item.package_sha256
      ) {
        throw new Error(`组件 ${item.id} 的包哈希不一致`);
      }
    }
  }
  return { root: absoluteRoot, path: documentPath, library };
}

function validateRegistry(root) {
  const absoluteRoot = path.resolve(root);
  const documentPath = registryPath(absoluteRoot);
  if (!fs.existsSync(documentPath)) throw new Error(`找不到注册表：${documentPath}`);
  const registry = readJson(documentPath);
  assertJsonSchema(registry, REGISTRY_SCHEMA, "媒体资源注册表");
  const keys = new Set();
  for (const entry of registry.libraries) {
    const key = `${entry.library_id}@${entry.library_version}`;
    if (keys.has(key)) throw new Error(`注册表版本重复：${key}`);
    keys.add(key);
    const packageRoot = resolveInside(absoluteRoot, entry.package, `注册 ${key}.package`);
    if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
      throw new Error(`注册包不存在：${packageRoot}`);
    }
    if (sha256Tree(packageRoot) !== entry.package_sha256) {
      throw new Error(`注册包哈希不一致：${key}`);
    }
    const loaded = validateLibrary(packageRoot);
    if (
      loaded.library.library_id !== entry.library_id
      || loaded.library.library_version !== entry.library_version
      || loaded.library.kind !== entry.kind
      || loaded.library.name !== entry.name
    ) {
      throw new Error(`注册记录与包内资源库清单不一致：${key}`);
    }
  }
  return { root: absoluteRoot, path: documentPath, registry };
}

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: SKILL_ROOT,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label}失败：${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function loadProjectId(projectRoot, args) {
  const explicit = args.get("project-id");
  if (explicit) return requireId(explicit, "project id");
  const statePath = path.join(projectRoot, "media-project-state.json");
  if (fs.existsSync(statePath)) {
    return requireId(readJson(statePath).project_id, "media-project-state.project_id");
  }
  return requireId(path.basename(projectRoot).toLowerCase(), "项目目录名");
}

function loadAdoptions(projectRoot, projectId) {
  const filePath = path.join(projectRoot, ADOPTIONS_FILE);
  const document = fs.existsSync(filePath)
    ? readJson(filePath)
    : {
      protocol: "visual-multimedia-media-resource-adoptions",
      version: 1,
      project_id: projectId,
      adoptions: [],
    };
  assertJsonSchema(document, ADOPTIONS_SCHEMA, "媒体资源采用记录");
  if (document.project_id !== projectId) throw new Error("采用记录 project_id 与当前项目不一致");
  return { filePath, document };
}

export function validateMediaResourceAdoptions(adoptionsPath, options = {}) {
  const absolute = path.resolve(adoptionsPath);
  const errors = [];
  let document;
  try {
    document = readJson(absolute);
    assertJsonSchema(document, ADOPTIONS_SCHEMA, "媒体资源采用记录");
  } catch (error) {
    return { ok: false, file: absolute, errors: [error.message] };
  }
  const projectRoot = path.dirname(absolute);
  if (options.projectId && document.project_id !== options.projectId) {
    errors.push(`project_id ${document.project_id} 与项目 ${options.projectId} 不一致`);
  }
  const mediaSourcesPath = options.mediaSourcesPath
    ? path.resolve(options.mediaSourcesPath)
    : path.join(projectRoot, "media-sources.json");
  let sourceById = new Map();
  const mediaValidation = validateMediaSources(mediaSourcesPath);
  if (!mediaValidation.ok) {
    errors.push(...mediaValidation.errors.map((message) => `media-sources：${message}`));
  } else {
    sourceById = new Map(
      readJson(mediaSourcesPath).sources.map((source) => [source.id, source]),
    );
  }
  const keys = new Set();
  for (const adoption of document.adoptions) {
    const key =
      `${adoption.library_id}@${adoption.library_version}/${adoption.item_id}`;
    if (keys.has(key)) errors.push(`采用记录重复：${key}`);
    keys.add(key);
    if (adoption.consumer === "media-sources") {
      if (!adoption.media_source_id || adoption.package !== null) {
        errors.push(`${key} 的 media-sources 消费边界字段不一致`);
        continue;
      }
      const source = sourceById.get(adoption.media_source_id);
      if (!source) {
        errors.push(`${key} 没有到达 media-sources source ${adoption.media_source_id}`);
      } else if (source.integrity?.sha256 !== adoption.content_sha256) {
        errors.push(`${key} 的采用哈希与 media-sources 实际素材不一致`);
      }
    } else if (adoption.consumer === "editable-media") {
      if (adoption.media_source_id !== null || !adoption.package) {
        errors.push(`${key} 的 editable-media 消费边界字段不一致`);
        continue;
      }
      try {
        const packageRoot = resolveInside(projectRoot, adoption.package, `${key}.package`);
        if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
          throw new Error(`采用包不存在：${packageRoot}`);
        }
        if (sha256Tree(packageRoot) !== adoption.content_sha256) {
          throw new Error("采用包哈希与记录不一致");
        }
        const editable = readEditableMediaPackage(packageRoot);
        assertEditableMediaPackageClosed(editable.packageRoot, editable.manifest);
      } catch (error) {
        errors.push(`${key}：${error.message}`);
      }
    }
  }
  return {
    ok: errors.length === 0,
    file: absolute,
    project_id: document.project_id,
    adoption_count: document.adoptions.length,
    errors,
  };
}

function recordAdoption(projectRoot, projectId, adoption) {
  const loaded = loadAdoptions(projectRoot, projectId);
  const key = `${adoption.library_id}@${adoption.library_version}/${adoption.item_id}`;
  const existing = loaded.document.adoptions.find(
    (item) => `${item.library_id}@${item.library_version}/${item.item_id}` === key,
  );
  if (existing) {
    if (JSON.stringify({ ...existing, adopted_at: adoption.adopted_at })
      !== JSON.stringify(adoption)) {
      throw new Error(`资源 ${key} 已采用但目标不同，不会覆盖`);
    }
    return existing;
  }
  loaded.document.adoptions.push(adoption);
  assertJsonSchema(loaded.document, ADOPTIONS_SCHEMA, "媒体资源采用记录");
  writeJson(loaded.filePath, loaded.document);
  return adoption;
}

function initRegistry(args) {
  const root = path.resolve(required(args, "registry"));
  const document = {
    protocol: "visual-multimedia-media-resource-registry",
    version: 1,
    libraries: [],
  };
  assertJsonSchema(document, REGISTRY_SCHEMA, "媒体资源注册表");
  writeNewOrSame(registryPath(root), document, "媒体资源注册表");
  return { registry: registryPath(root) };
}

function initLibrary(args) {
  const root = path.resolve(required(args, "library"));
  const id = requireId(required(args, "id"), "library id");
  const version = requireVersion(required(args, "version"), "library version");
  const kind = required(args, "kind");
  if (!LIBRARY_KINDS.has(kind)) throw new Error(`kind 无效：${kind}`);
  const document = {
    protocol: "visual-multimedia-media-resource-library",
    version: 1,
    library_id: id,
    library_version: version,
    kind,
    name: required(args, "name"),
    description: args.get("description") || "",
    items: [],
  };
  assertJsonSchema(document, LIBRARY_SCHEMA, "媒体资源库");
  writeNewOrSame(libraryPath(root), document, "媒体资源库");
  return { library: libraryPath(root), library_id: id, library_version: version, kind };
}

function appendLibraryItem(root, item) {
  const loaded = validateLibrary(root);
  const existing = loaded.library.items.find((candidate) => candidate.id === item.id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(item)) {
      throw new Error(`item id 已存在但内容不同，不会覆盖：${item.id}`);
    }
    return { ...loaded, item: existing, reused: true };
  }
  loaded.library.items.push(item);
  assertJsonSchema(loaded.library, LIBRARY_SCHEMA, "媒体资源库");
  writeJson(loaded.path, loaded.library);
  validateLibrary(root);
  return { ...loaded, item, reused: false };
}

function addFileItem(args, provenance = null) {
  const root = path.resolve(required(args, "library"));
  const loaded = validateLibrary(root);
  if (!RESOURCE_KINDS.has(loaded.library.kind)) {
    throw new Error(`${loaded.library.kind} 资源库不能添加普通文件`);
  }
  const input = path.resolve(required(args, "input"));
  if (!fs.existsSync(input) || !fs.statSync(input).isFile() || fs.statSync(input).size === 0) {
    throw new Error(`输入文件不存在或为空：${input}`);
  }
  const mediaType = required(args, "media-type");
  if (!MEDIA_TYPES.has(mediaType)) throw new Error(`media-type 无效：${mediaType}`);
  const rightsStatus = required(args, "rights-status");
  if (!RIGHTS.has(rightsStatus)) throw new Error(`rights-status 无效：${rightsStatus}`);
  const method = args.get("method") || "project-owned";
  if (!METHODS.has(method)) throw new Error(`method 无效：${method}`);
  const imported = copyFileContentAddressed(input, root);
  const item = {
    type: "file",
    id: requireId(required(args, "item-id"), "item id"),
    name: required(args, "name"),
    media_type: mediaType,
    role: required(args, "role"),
    tags: [...new Set(args.get("tag") || [])].map((tag) => requireId(tag, "tag")),
    ...imported,
    acquisition: {
      method,
      source_url: args.get("source-url") || "",
      provider: args.get("provider") || "",
      captured_at: args.get("captured-at") || nowIso(),
    },
    rights: {
      status: rightsStatus,
      license: required(args, "license"),
      attribution: args.get("attribution") || "",
      terms_url: args.get("terms-url") || "",
    },
    provenance,
  };
  const result = appendLibraryItem(root, item);
  return {
    library_id: loaded.library.library_id,
    library_version: loaded.library.library_version,
    item: result.item,
    reused: result.reused,
  };
}

function addComponentItem(args, provenance = null) {
  const root = path.resolve(required(args, "library"));
  const loaded = validateLibrary(root);
  if (loaded.library.kind !== "web-components") {
    throw new Error(`${loaded.library.kind} 资源库不能添加 editable-media 包`);
  }
  const source = path.resolve(required(args, "package"));
  const editable = readEditableMediaPackage(source);
  assertEditableMediaPackageClosed(editable.packageRoot, editable.manifest);
  runNode([EDITABLE_MEDIA_VALIDATOR, editable.packageRoot], "editable-media 真实浏览器验证");
  const packageHash = sha256Tree(editable.packageRoot);
  const itemId = requireId(required(args, "item-id"), "item id");
  const destination = path.join(root, "components", itemId, packageHash);
  copyDirectoryOnce(editable.packageRoot, destination, packageHash);
  const item = {
    type: "editable-media-package",
    id: itemId,
    name: required(args, "name"),
    role: required(args, "role"),
    tags: [...new Set(args.get("tag") || [])].map((tag) => requireId(tag, "tag")),
    package: relativeInside(root, destination, "组件包"),
    manifest_sha256: sha256File(path.join(destination, "editable-media.json")),
    package_sha256: packageHash,
    provenance,
  };
  const result = appendLibraryItem(root, item);
  return {
    library_id: loaded.library.library_id,
    library_version: loaded.library.library_version,
    item: result.item,
    reused: result.reused,
  };
}

function registerLibrary(args) {
  const registry = validateRegistry(required(args, "registry"));
  const library = validateLibrary(required(args, "library"));
  const packageHash = sha256Tree(library.root);
  const key = `${library.library.library_id}@${library.library.library_version}`;
  const existing = registry.registry.libraries.find(
    (entry) => `${entry.library_id}@${entry.library_version}` === key,
  );
  if (existing) {
    if (existing.package_sha256 !== packageHash) {
      throw new Error(`${key} 已注册为另一份内容；请提升版本，不会覆盖不可变版本`);
    }
    return { registered: false, reused: true, entry: existing };
  }
  const destination = path.join(
    registry.root,
    "packages",
    library.library.library_id,
    library.library.library_version,
    packageHash,
  );
  copyDirectoryOnce(library.root, destination, packageHash);
  const entry = {
    library_id: library.library.library_id,
    library_version: library.library.library_version,
    kind: library.library.kind,
    name: library.library.name,
    package: relativeInside(registry.root, destination, "注册包"),
    package_sha256: packageHash,
    registered_at: nowIso(),
  };
  registry.registry.libraries.push(entry);
  registry.registry.libraries.sort((left, right) =>
    `${left.library_id}@${left.library_version}`
      .localeCompare(`${right.library_id}@${right.library_version}`));
  assertJsonSchema(registry.registry, REGISTRY_SCHEMA, "媒体资源注册表");
  writeJson(registry.path, registry.registry);
  validateRegistry(registry.root);
  return { registered: true, reused: false, entry };
}

function listRegistry(args) {
  const loaded = validateRegistry(required(args, "registry"));
  const kind = args.get("kind");
  if (kind && !LIBRARY_KINDS.has(kind)) throw new Error(`kind 无效：${kind}`);
  return {
    registry: loaded.path,
    libraries: loaded.registry.libraries.filter((entry) => !kind || entry.kind === kind),
  };
}

function searchRegistry(args) {
  const loaded = validateRegistry(required(args, "registry"));
  const kind = args.get("kind");
  if (kind && !LIBRARY_KINDS.has(kind)) throw new Error(`kind 无效：${kind}`);
  const query = String(args.get("query") || "").trim().toLocaleLowerCase();
  const tags = [...new Set(args.get("tag") || [])].map((tag) => requireId(tag, "tag"));
  const results = [];
  for (const entry of loaded.registry.libraries) {
    if (kind && entry.kind !== kind) continue;
    const packageRoot = resolveInside(loaded.root, entry.package, "注册包");
    const library = validateLibrary(packageRoot).library;
    for (const item of library.items) {
      const searchable = [
        item.id,
        item.name,
        item.role,
        item.media_type || "",
        ...(item.tags || []),
      ].join(" ").toLocaleLowerCase();
      if (query && !searchable.includes(query)) continue;
      if (tags.some((tag) => !(item.tags || []).includes(tag))) continue;
      results.push({
        library_id: entry.library_id,
        library_version: entry.library_version,
        library_kind: entry.kind,
        registry_package_sha256: entry.package_sha256,
        item_id: item.id,
        item_type: item.type,
        name: item.name,
        role: item.role,
        media_type: item.media_type || null,
        tags: [...(item.tags || [])],
        content_sha256: item.sha256 || item.package_sha256,
      });
    }
  }
  results.sort((left, right) =>
    `${left.library_id}@${left.library_version}/${left.item_id}`
      .localeCompare(`${right.library_id}@${right.library_version}/${right.item_id}`));
  return {
    registry: loaded.path,
    query,
    tags,
    result_count: results.length,
    results,
  };
}

function registeredItem(args) {
  const loaded = validateRegistry(required(args, "registry"));
  const id = requireId(required(args, "library-id"), "library id");
  const version = requireVersion(required(args, "version"), "library version");
  const entry = loaded.registry.libraries.find(
    (candidate) => candidate.library_id === id && candidate.library_version === version,
  );
  if (!entry) throw new Error(`没有注册资源库 ${id}@${version}`);
  const packageRoot = resolveInside(loaded.root, entry.package, "注册包");
  const library = validateLibrary(packageRoot).library;
  const itemId = requireId(required(args, "item-id"), "item id");
  const item = library.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`资源库 ${id}@${version} 没有 item ${itemId}`);
  return { registry: loaded, entry, packageRoot, library, item };
}

function adoptResource(args) {
  const selected = registeredItem(args);
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`项目目录不存在：${projectRoot}`);
  }
  const projectId = loadProjectId(projectRoot, args);
  const adoptedAt = nowIso();
  let adoption;
  if (selected.item.type === "file") {
    const sourceId = requireId(
      args.get("source-id") || selected.item.id,
      "adopt source id",
    );
    const input = resolveInside(selected.packageRoot, selected.item.file, "注册素材文件");
    const originalMethod = selected.item.acquisition.method;
    const importMethod = originalMethod === "generated"
      ? "project-owned"
      : originalMethod;
    const originNotes = [
      `registered-library:${selected.entry.package_sha256}`,
      `registered-origin-method:${originalMethod}`,
    ].join(";");
    const importerArgs = [
      IMPORTER,
      "--project", projectRoot,
      "--input", input,
      "--id", sourceId,
      "--media-type", selected.item.media_type,
      "--method", importMethod,
      "--rights-status", selected.item.rights.status,
      "--license", selected.item.rights.license,
      "--usage", `采用 ${selected.entry.library_id}@${selected.entry.library_version}/${selected.item.id}：${selected.item.role}`,
      "--notes", originNotes,
      "--captured-at", selected.item.acquisition.captured_at,
    ];
    if (selected.item.acquisition.source_url) {
      importerArgs.push("--source-url", selected.item.acquisition.source_url);
    }
    if (selected.item.acquisition.provider) {
      importerArgs.push("--provider", selected.item.acquisition.provider);
    }
    if (selected.item.rights.attribution) {
      importerArgs.push("--attribution", selected.item.rights.attribution);
    }
    if (selected.item.rights.terms_url) {
      importerArgs.push("--terms-url", selected.item.rights.terms_url);
    }
    const result = runNode(importerArgs, "注册素材导入");
    let imported;
    try {
      imported = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`注册素材导入没有返回 JSON：${error.message}`);
    }
    if (imported.source?.integrity?.sha256 !== selected.item.sha256) {
      throw new Error("导入器写入项目后的素材哈希与注册资源不一致");
    }
    adoption = {
      library_id: selected.entry.library_id,
      library_version: selected.entry.library_version,
      library_kind: selected.entry.kind,
      item_id: selected.item.id,
      registry_package_sha256: selected.entry.package_sha256,
      consumer: "media-sources",
      media_source_id: sourceId,
      package: null,
      content_sha256: selected.item.sha256,
      adopted_at: adoptedAt,
    };
  } else {
    const input = resolveInside(selected.packageRoot, selected.item.package, "注册组件包");
    const destination = path.join(
      projectRoot,
      "components",
      "by-sha256",
      selected.item.package_sha256.slice(0, 2),
      selected.item.package_sha256,
    );
    copyDirectoryOnce(input, destination, selected.item.package_sha256);
    runNode([EDITABLE_MEDIA_VALIDATOR, destination], "采用后 editable-media 消费验证");
    adoption = {
      library_id: selected.entry.library_id,
      library_version: selected.entry.library_version,
      library_kind: selected.entry.kind,
      item_id: selected.item.id,
      registry_package_sha256: selected.entry.package_sha256,
      consumer: "editable-media",
      media_source_id: null,
      package: relativeInside(projectRoot, destination, "项目组件包"),
      content_sha256: selected.item.package_sha256,
      adopted_at: adoptedAt,
    };
  }
  const recorded = recordAdoption(projectRoot, projectId, adoption);
  return {
    adopted: true,
    project_id: projectId,
    adoptions: path.join(projectRoot, ADOPTIONS_FILE),
    adoption: recorded,
  };
}

function loadPromotions(projectRoot, projectId) {
  const filePath = path.join(projectRoot, PROMOTIONS_FILE);
  const document = fs.existsSync(filePath)
    ? readJson(filePath)
    : {
      protocol: "visual-multimedia-resource-promotion-candidates",
      version: 1,
      project_id: projectId,
      candidates: [],
    };
  assertJsonSchema(document, PROMOTIONS_SCHEMA, "资源晋升候选");
  if (document.project_id !== projectId) throw new Error("晋升候选 project_id 与当前项目不一致");
  return { filePath, document };
}

export function validateResourcePromotionCandidates(
  promotionPath,
  options = {},
) {
  const absolute = path.resolve(promotionPath);
  const errors = [];
  let document;
  try {
    document = readJson(absolute);
    assertJsonSchema(document, PROMOTIONS_SCHEMA, "资源晋升候选");
  } catch (error) {
    return { ok: false, file: absolute, errors: [error.message] };
  }
  const projectRoot = path.dirname(absolute);
  if (options.projectId && document.project_id !== options.projectId) {
    errors.push(`project_id ${document.project_id} 与项目 ${options.projectId} 不一致`);
  }
  const ids = new Set();
  for (const candidate of document.candidates) {
    if (ids.has(candidate.id)) errors.push(`candidate id 重复：${candidate.id}`);
    ids.add(candidate.id);
    try {
      const source = resolveInside(projectRoot, candidate.source, `${candidate.id}.source`);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`晋升源不存在：${source}`);
      }
      if (sha256File(source) !== candidate.source_sha256) {
        throw new Error("晋升源哈希已经变化");
      }
      for (const evidence of candidate.evidence) {
        const evidencePath = resolveInside(
          projectRoot,
          evidence,
          `${candidate.id}.evidence`,
        );
        if (!fs.existsSync(evidencePath) || !fs.statSync(evidencePath).isFile()) {
          throw new Error(`晋升证据不存在：${evidencePath}`);
        }
      }
    } catch (error) {
      errors.push(`${candidate.id}：${error.message}`);
    }
    if (candidate.status === "candidate" && candidate.decision !== null) {
      errors.push(`${candidate.id} 尚是 candidate，不应已有 decision`);
    }
    if (candidate.status !== "candidate" && candidate.decision === null) {
      errors.push(`${candidate.id} 已完成决定但缺少 decision`);
    }
    if (
      candidate.status === "accepted"
      && !candidate.decision?.published_target
    ) {
      errors.push(`${candidate.id} accepted 但没有 published_target`);
    }
    if (
      candidate.status === "rejected"
      && candidate.decision?.published_target !== null
    ) {
      errors.push(`${candidate.id} rejected 不应有 published_target`);
    }
  }
  return {
    ok: errors.length === 0,
    file: absolute,
    project_id: document.project_id,
    candidate_count: document.candidates.length,
    errors,
  };
}

function proposePromotion(args) {
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  const projectId = loadProjectId(projectRoot, args);
  const candidateId = requireId(required(args, "candidate-id"), "candidate id");
  const targetKind = required(args, "target-kind");
  if (!TARGET_KINDS.has(targetKind)) throw new Error(`target-kind 无效：${targetKind}`);
  const scope = required(args, "scope");
  if (!["project", "series"].includes(scope)) throw new Error("scope 必须是 project 或 series");
  let sourcePath;
  let sourceId = null;
  if (args.has("source-id")) {
    sourceId = requireId(required(args, "source-id"), "source id");
    const manifestPath = path.join(projectRoot, "media-sources.json");
    const validation = validateMediaSources(manifestPath);
    if (!validation.ok) throw new Error(`项目素材账本无效：\n- ${validation.errors.join("\n- ")}`);
    const manifest = readJson(manifestPath);
    const source = manifest.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error(`media-sources.json 没有 source ${sourceId}`);
    if (!["confirmed", "not-required"].includes(source.rights?.status)) {
      throw new Error(`source ${sourceId} 的权利状态尚未收口，不能晋升`);
    }
    sourcePath = resolveInside(projectRoot, source.file, `source ${sourceId}.file`);
  } else {
    sourcePath = path.resolve(projectRoot, required(args, "source"));
    relativeInside(projectRoot, sourcePath, "晋升源文件");
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`晋升源必须是项目内真实文件：${sourcePath}`);
  }
  const evidence = args.get("evidence") || [];
  if (!evidence.length) throw new Error("至少需要一个 --evidence，证明该候选已经过当前项目验证");
  const evidencePaths = evidence.map((value) => {
    const absolute = path.resolve(projectRoot, value);
    relativeInside(projectRoot, absolute, "晋升证据");
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`晋升证据不存在：${absolute}`);
    }
    return relativeInside(projectRoot, absolute, "晋升证据");
  });
  const loaded = loadPromotions(projectRoot, projectId);
  if (loaded.document.candidates.some((item) => item.id === candidateId)) {
    throw new Error(`candidate id 已存在，不会覆盖：${candidateId}`);
  }
  const candidate = {
    id: candidateId,
    status: "candidate",
    target_kind: targetKind,
    scope,
    source: relativeInside(projectRoot, sourcePath, "晋升源"),
    source_id: sourceId,
    source_sha256: sha256File(sourcePath),
    target_library_id: args.has("target-library-id")
      ? requireId(required(args, "target-library-id"), "target library id")
      : null,
    target_item_id: requireId(required(args, "target-item-id"), "target item id"),
    rationale: required(args, "rationale"),
    evidence: [...new Set(evidencePaths)],
    created_at: nowIso(),
    decision: null,
  };
  loaded.document.candidates.push(candidate);
  assertJsonSchema(loaded.document, PROMOTIONS_SCHEMA, "资源晋升候选");
  writeJson(loaded.filePath, loaded.document);
  return { proposed: true, file: loaded.filePath, candidate };
}

function projectMediaSource(projectRoot, sourceId) {
  const manifestPath = path.join(projectRoot, "media-sources.json");
  const validation = validateMediaSources(manifestPath);
  if (!validation.ok) throw new Error(`项目素材账本无效：\n- ${validation.errors.join("\n- ")}`);
  const source = readJson(manifestPath).sources.find((item) => item.id === sourceId);
  if (!source) throw new Error(`media-sources.json 没有 source ${sourceId}`);
  return source;
}

function promoteFile(args) {
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  const projectId = loadProjectId(projectRoot, args);
  const loaded = loadPromotions(projectRoot, projectId);
  const candidateId = requireId(required(args, "candidate-id"), "candidate id");
  const candidate = loaded.document.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`找不到晋升候选 ${candidateId}`);
  if (candidate.status !== "candidate") throw new Error(`候选 ${candidateId} 已经完成决定`);
  if (!RESOURCE_KINDS.has(candidate.target_kind) || !candidate.source_id) {
    throw new Error("promote-file 只接受由 media-sources source 提出的 creator-media 或 production-assets 候选");
  }
  const library = validateLibrary(required(args, "library"));
  if (library.library.kind !== candidate.target_kind) {
    throw new Error(`候选目标 ${candidate.target_kind} 与资源库 ${library.library.kind} 不一致`);
  }
  if (
    candidate.target_library_id
    && candidate.target_library_id !== library.library.library_id
  ) {
    throw new Error("候选 target_library_id 与当前资源库不一致");
  }
  const registryRoot = path.resolve(required(args, "registry"));
  validateRegistry(registryRoot);
  const source = projectMediaSource(projectRoot, candidate.source_id);
  if (!["confirmed", "not-required"].includes(source.rights?.status)) {
    throw new Error("晋升时 source 权利状态不再满足要求");
  }
  const sourcePath = resolveInside(projectRoot, source.file, "晋升源素材");
  if (sha256File(sourcePath) !== candidate.source_sha256) {
    throw new Error("晋升源已变化；必须重新提出候选，不能沿用旧证据");
  }
  const forwarded = new Map(args);
  forwarded.set("input", sourcePath);
  forwarded.set("item-id", candidate.target_item_id);
  forwarded.set("media-type", source.media_type);
  forwarded.set("rights-status", source.rights.status);
  forwarded.set("license", source.rights.license || "not-required");
  forwarded.set("method", source.acquisition?.method === "generated-in-project"
    ? "generated"
    : source.acquisition?.method || "project-owned");
  if (source.acquisition?.source_url) {
    forwarded.set("source-url", source.acquisition.source_url);
  }
  if (source.acquisition?.captured_at) {
    forwarded.set("captured-at", source.acquisition.captured_at);
  }
  const sourceProvider = source.generation?.provider
    || source.provenance_runs?.at(-1)?.provider
    || "";
  if (sourceProvider) forwarded.set("provider", sourceProvider);
  if (source.rights?.attribution) forwarded.set("attribution", source.rights.attribution);
  if (source.rights?.terms_url) forwarded.set("terms-url", source.rights.terms_url);
  const promoted = addFileItem(forwarded, {
    project_id: projectId,
    source_id: candidate.source_id,
    promoted_at: nowIso(),
  });
  const registration = registerLibrary(new Map([
    ["registry", registryRoot],
    ["library", library.root],
  ]));
  candidate.status = "accepted";
  candidate.decision = {
    decided_at: nowIso(),
    notes: "已从项目唯一素材账本读取，经目标草稿库发布为不可变注册版本。",
    published_target:
      `${promoted.library_id}@${promoted.library_version}/${promoted.item.id}`
        + `#sha256=${registration.entry.package_sha256}`,
  };
  assertJsonSchema(loaded.document, PROMOTIONS_SCHEMA, "资源晋升候选");
  writeJson(loaded.filePath, loaded.document);
  return {
    promoted: true,
    candidate,
    library_item: promoted.item,
    registration,
  };
}

function decidePromotion(args) {
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  const projectId = loadProjectId(projectRoot, args);
  const loaded = loadPromotions(projectRoot, projectId);
  const candidateId = requireId(required(args, "candidate-id"), "candidate id");
  const candidate = loaded.document.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`找不到晋升候选 ${candidateId}`);
  if (candidate.status !== "candidate") throw new Error(`候选 ${candidateId} 已经完成决定`);
  const status = required(args, "status");
  if (!["accepted", "rejected"].includes(status)) {
    throw new Error("status 必须是 accepted 或 rejected");
  }
  const published = args.get("published-target") || null;
  if (status === "accepted" && !published) {
    throw new Error("非文件候选标记 accepted 时必须提供 --published-target");
  }
  candidate.status = status;
  candidate.decision = {
    decided_at: nowIso(),
    notes: required(args, "notes"),
    published_target: status === "accepted" ? published : null,
  };
  assertJsonSchema(loaded.document, PROMOTIONS_SCHEMA, "资源晋升候选");
  writeJson(loaded.filePath, loaded.document);
  return { decided: true, candidate };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length ? 0 : 1;
  }
  const { command, values } = parseArgs(argv);
  const handlers = {
    "init-registry": initRegistry,
    "init-library": initLibrary,
    "add-file": addFileItem,
    "add-component": addComponentItem,
    register: registerLibrary,
    list: listRegistry,
    search: searchRegistry,
    adopt: adoptResource,
    propose: proposePromotion,
    "promote-file": promoteFile,
    decide: decidePromotion,
  };
  const handler = handlers[command];
  if (!handler) throw new Error(`未知命令：${command}`);
  const result = handler(values);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (
  path.resolve(fileURLToPath(import.meta.url))
  === path.resolve(process.argv[1] || "")
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  }
}
