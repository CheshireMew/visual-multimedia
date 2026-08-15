#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertJsonSchema } from "./json_schema_contract.mjs";
import { validateMediaSources } from "./validate-media-sources.mjs";
import { assertSkillTaskPath } from "./media-task-workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  SCRIPT_DIR,
  "..",
  "schemas",
  "sound-production-profile.v1.schema.json",
);
const DEFAULT_FILE = "sound-profile.json";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ROLES = new Set([
  "voice-anchor",
  "music",
  "ambient",
  "transition",
  "emphasis",
  "foley",
  "identity",
]);

function usage() {
  console.log(`用法：
  node scripts/sound-production-profile.mjs create --project <目录>
    --profile-id <id> --name <名称> --scope <project|series>
    [--file <项目相对路径>] [--notes <说明>]
  node scripts/sound-production-profile.mjs add-cue --project <目录>
    --cue-id <id> --source-id <音频 source id> --role <声音职责>
    --usage <采用条件> [--gain-db <数字>] [--loop <true|false>] [--tag <标签>]...
    [--file <项目相对路径>]
  node scripts/sound-production-profile.mjs set-ducking --project <目录>
    --enabled <true|false> --trigger-role <职责>... --target-role <职责>...
    --reduction-db <数字> --attack-ms <整数> --release-ms <整数>
    [--file <项目相对路径>]
  node scripts/sound-production-profile.mjs link-motion --project <目录>
    --cue-id <id> --semantic-event <事件> --offset-ms <整数>
    --policy <at-state-change|before-change|after-change>
    [--file <项目相对路径>]
  node scripts/sound-production-profile.mjs validate --project <目录>
    [--file <项目相对路径>]

声音档案只引用 media-sources.json 中已经入账的 audio source id，不保存音频路径，
也不与视觉 style-profile.json 合并。`);
}

function parseArgs(argv) {
  const command = argv[0];
  const values = new Map();
  const repeated = new Set(["tag", "trigger-role", "target-role"]);
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
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少必需参数 --${key}`);
  return value.trim();
}

function requireId(value, label) {
  if (!ID_PATTERN.test(value || "")) throw new Error(`${label} 格式不合法：${value}`);
  return value;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} 必须是有限数字`);
  return number;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${label} 必须是整数`);
  return number;
}

function boolean(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} 必须是 true 或 false`);
}

function nowIso() {
  return new Date().toISOString();
}

function relativeProfilePath(projectRoot, args) {
  const value = args.get("file") || DEFAULT_FILE;
  if (value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error("--file 必须是项目内使用 / 的相对路径");
  }
  const absolute = path.resolve(projectRoot, ...value.split("/"));
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--file 不能离开项目目录");
  }
  return absolute;
}

function projectId(projectRoot) {
  const statePath = path.join(projectRoot, "media-project-state.json");
  const value = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8")).project_id
    : path.basename(projectRoot).toLowerCase();
  return requireId(value, "project id");
}

function readProfile(profilePath) {
  if (!fs.existsSync(profilePath)) throw new Error(`声音档案不存在：${profilePath}`);
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  assertJsonSchema(profile, SCHEMA_PATH, "声音制作档案");
  return profile;
}

function writeProfile(profilePath, profile) {
  assertJsonSchema(profile, SCHEMA_PATH, "声音制作档案");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

function mediaSources(projectRoot) {
  const manifestPath = path.join(projectRoot, "media-sources.json");
  const validation = validateMediaSources(manifestPath);
  if (!validation.ok) {
    throw new Error(`项目素材账本无效：\n- ${validation.errors.join("\n- ")}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return { manifestPath, manifest };
}

export function validateSoundProductionProfile(
  profilePath,
  options = {},
) {
  const absolute = path.resolve(profilePath);
  const errors = [];
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(absolute, "utf8"));
    assertJsonSchema(profile, SCHEMA_PATH, "声音制作档案");
  } catch (error) {
    return { ok: false, file: absolute, errors: [error.message] };
  }
  const cueIds = new Set();
  const sourceIds = new Set();
  let sources = null;
  const sourcesPath = options.mediaSourcesPath
    ? path.resolve(options.mediaSourcesPath)
    : path.join(path.dirname(absolute), "media-sources.json");
  const sourceValidation = validateMediaSources(sourcesPath);
  if (!sourceValidation.ok) {
    errors.push(...sourceValidation.errors.map((message) => `media-sources：${message}`));
  } else {
    sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  }
  const bySourceId = new Map((sources?.sources || []).map((source) => [source.id, source]));
  for (const cue of profile.palette || []) {
    if (cueIds.has(cue.id)) errors.push(`palette cue id 重复：${cue.id}`);
    cueIds.add(cue.id);
    if (sourceIds.has(cue.source_id)) {
      errors.push(`同一声音 source id 不能作为两条活动 cue 重复定义：${cue.source_id}`);
    }
    sourceIds.add(cue.source_id);
    const source = bySourceId.get(cue.source_id);
    if (!source) {
      errors.push(`cue ${cue.id} 引用未知 source id：${cue.source_id}`);
    } else {
      if (source.media_type !== "audio") {
        errors.push(`cue ${cue.id} 引用的 ${cue.source_id} 不是 audio`);
      }
      if (!["confirmed", "not-required"].includes(source.rights?.status)) {
        errors.push(`cue ${cue.id} 的音频权利状态尚未收口`);
      }
    }
    if (cue.role === "voice-anchor" && cue.loop) {
      errors.push(`voice-anchor cue ${cue.id} 不能循环`);
    }
  }
  for (const link of profile.motion_sync || []) {
    if (!cueIds.has(link.cue_id)) {
      errors.push(`motion_sync 引用了未知 cue：${link.cue_id}`);
    }
  }
  const ducking = profile.mix?.ducking;
  if (ducking?.enabled) {
    if (!(ducking.reduction_db > 0)) errors.push("启用 ducking 时 reduction_db 必须大于 0");
    if (!ducking.trigger_roles.length || !ducking.target_roles.length) {
      errors.push("启用 ducking 时必须声明 trigger_roles 与 target_roles");
    }
  }
  if (options.projectId && profile.project_id !== options.projectId) {
    errors.push(`profile.project_id ${profile.project_id} 与项目 ${options.projectId} 不一致`);
  }
  return {
    ok: errors.length === 0,
    file: absolute,
    profile_id: profile.profile_id,
    project_id: profile.project_id,
    cue_count: profile.palette.length,
    errors,
  };
}

function validateOrThrow(profilePath, projectRoot) {
  const result = validateSoundProductionProfile(profilePath, {
    mediaSourcesPath: path.join(projectRoot, "media-sources.json"),
    projectId: projectId(projectRoot),
  });
  if (!result.ok) throw new Error(`声音档案未通过验证：\n- ${result.errors.join("\n- ")}`);
  return result;
}

function createProfile(args) {
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  mediaSources(projectRoot);
  const profilePath = relativeProfilePath(projectRoot, args);
  const scope = required(args, "scope");
  if (!["project", "series"].includes(scope)) throw new Error("scope 必须是 project 或 series");
  const profile = {
    protocol: "visual-multimedia-sound-production-profile",
    version: 1,
    profile_id: requireId(required(args, "profile-id"), "profile id"),
    name: required(args, "name"),
    scope,
    project_id: projectId(projectRoot),
    palette: [],
    mix: {
      speech_priority: true,
      ducking: {
        enabled: false,
        trigger_roles: [],
        target_roles: [],
        reduction_db: 0,
        attack_ms: 0,
        release_ms: 0,
      },
      loudness: {
        target_lufs: -16,
        true_peak_dbfs: -1,
      },
      silence: {
        preserve_semantic_pauses: true,
        maximum_unacknowledged_seconds: 1,
      },
    },
    motion_sync: [],
    notes: args.get("notes") || "",
    updated_at: nowIso(),
  };
  if (fs.existsSync(profilePath)) {
    throw new Error(`声音档案已存在，不会覆盖：${profilePath}`);
  }
  writeProfile(profilePath, profile);
  validateOrThrow(profilePath, projectRoot);
  return { created: true, profile: profilePath, profile_id: profile.profile_id };
}

function addCue(args) {
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  const profilePath = relativeProfilePath(projectRoot, args);
  const profile = readProfile(profilePath);
  const cueId = requireId(required(args, "cue-id"), "cue id");
  if (profile.palette.some((cue) => cue.id === cueId)) {
    throw new Error(`cue id 已存在，不会覆盖：${cueId}`);
  }
  const sourceId = requireId(required(args, "source-id"), "source id");
  const source = mediaSources(projectRoot).manifest.sources.find(
    (item) => item.id === sourceId,
  );
  if (!source || source.media_type !== "audio") {
    throw new Error(`source ${sourceId} 不存在或不是 audio`);
  }
  if (!["confirmed", "not-required"].includes(source.rights?.status)) {
    throw new Error(`source ${sourceId} 的权利状态尚未收口`);
  }
  const role = required(args, "role");
  if (!ROLES.has(role)) throw new Error(`role 无效：${role}`);
  profile.palette.push({
    id: cueId,
    source_id: sourceId,
    role,
    usage_condition: required(args, "usage"),
    loop: args.has("loop") ? boolean(required(args, "loop"), "--loop") : false,
    default_gain_db: args.has("gain-db")
      ? finiteNumber(required(args, "gain-db"), "--gain-db")
      : 0,
    tags: [...new Set(args.get("tag") || [])].map((tag) => requireId(tag, "tag")),
  });
  profile.updated_at = nowIso();
  writeProfile(profilePath, profile);
  const validation = validateOrThrow(profilePath, projectRoot);
  return { added: true, profile: profilePath, cue_id: cueId, validation };
}

function setDucking(args) {
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  const profilePath = relativeProfilePath(projectRoot, args);
  const profile = readProfile(profilePath);
  const enabled = boolean(required(args, "enabled"), "--enabled");
  const triggers = [...new Set(args.get("trigger-role") || [])];
  const targets = [...new Set(args.get("target-role") || [])];
  for (const role of [...triggers, ...targets]) {
    if (!ROLES.has(role)) throw new Error(`ducking role 无效：${role}`);
  }
  profile.mix.ducking = {
    enabled,
    trigger_roles: triggers,
    target_roles: targets,
    reduction_db: finiteNumber(required(args, "reduction-db"), "--reduction-db"),
    attack_ms: integer(required(args, "attack-ms"), "--attack-ms"),
    release_ms: integer(required(args, "release-ms"), "--release-ms"),
  };
  profile.updated_at = nowIso();
  writeProfile(profilePath, profile);
  const validation = validateOrThrow(profilePath, projectRoot);
  return { updated: true, profile: profilePath, validation };
}

function linkMotion(args) {
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  const profilePath = relativeProfilePath(projectRoot, args);
  const profile = readProfile(profilePath);
  const cueId = requireId(required(args, "cue-id"), "cue id");
  if (!profile.palette.some((cue) => cue.id === cueId)) {
    throw new Error(`声音档案没有 cue ${cueId}`);
  }
  const event = required(args, "semantic-event");
  if (profile.motion_sync.some(
    (link) => link.cue_id === cueId && link.semantic_event === event,
  )) {
    throw new Error(`同一 cue 与语义事件已经绑定，不会覆盖：${cueId}/${event}`);
  }
  const policy = required(args, "policy");
  if (!["at-state-change", "before-change", "after-change"].includes(policy)) {
    throw new Error(`policy 无效：${policy}`);
  }
  profile.motion_sync.push({
    cue_id: cueId,
    semantic_event: event,
    offset_ms: integer(required(args, "offset-ms"), "--offset-ms"),
    policy,
  });
  profile.updated_at = nowIso();
  writeProfile(profilePath, profile);
  const validation = validateOrThrow(profilePath, projectRoot);
  return { linked: true, profile: profilePath, validation };
}

function validateCommand(args) {
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  return validateOrThrow(relativeProfilePath(projectRoot, args), projectRoot);
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length ? 0 : 1;
  }
  const { command, values } = parseArgs(argv);
  const handlers = {
    create: createProfile,
    "add-cue": addCue,
    "set-ducking": setDucking,
    "link-motion": linkMotion,
    validate: validateCommand,
  };
  if (!handlers[command]) throw new Error(`未知命令：${command}`);
  console.log(JSON.stringify(handlers[command](values), null, 2));
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
