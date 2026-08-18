#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {loadLocalMediaEnvironment} from "./local-media-environment.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
export const TASK_WORKSPACE_ROOT = path.join(SKILL_ROOT, "artifacts");

const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const TASK_MANIFEST = ".media-task-workspace.json";
const TASK_MANIFEST_PROTOCOL = "visual-multimedia-task-workspace";

function existingVolumePath(target) {
  let candidate = path.resolve(target);
  while (!fs.existsSync(candidate) && path.dirname(candidate) !== candidate) {
    candidate = path.dirname(candidate);
  }
  if (!fs.existsSync(candidate)) throw new Error(`找不到存储根目录所在卷：${target}`);
  return candidate;
}

/** Validate the stable id used as a task workspace directory name. */
export function assertTaskId(value) {
  const taskId = String(value || "").trim();
  if (!TASK_ID_RE.test(taskId) || taskId.length > 32) {
    throw new Error("task id 最多 32 个字符，只能使用小写字母、数字、点、下划线和连字符");
  }
  return taskId;
}

/** Resolve a task-owned path below this Skill's ignored artifacts directory. */
export function resolveTaskPath(taskId, relativePath = "") {
  const root = path.join(TASK_WORKSPACE_ROOT, assertTaskId(taskId));
  const relative = String(relativePath || "").trim();
  if (path.isAbsolute(relative)) throw new Error("任务相对路径不能是绝对路径");
  const target = path.resolve(root, relative);
  assertSkillTaskPath(target, "任务路径");
  return target;
}

/** Reject production paths outside artifacts/<task-id> regardless of cwd. */
export function assertSkillTaskPath(value, label = "路径") {
  const target = path.resolve(String(value || ""));
  const relative = path.relative(TASK_WORKSPACE_ROOT, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于 ${TASK_WORKSPACE_ROOT} 下的任务目录内：${target}`);
  }
  const [taskId] = relative.split(path.sep);
  assertTaskId(taskId);
  return target;
}

function directoryInventory(root) {
  const categories = {};
  const cleanupCandidates = [];
  const linkedPaths = [];
  let bytes = 0;
  let files = 0;
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      const top = relative.split("/", 1)[0] || "root";
      if (entry.isSymbolicLink()) {
        linkedPaths.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = fs.statSync(target).size;
      bytes += size;
      files += 1;
      categories[top] = categories[top] || {bytes: 0, files: 0};
      categories[top].bytes += size;
      categories[top].files += 1;
      if (/\.pending(?:\.|$)|\.tmp$/u.test(entry.name) || /^(?:temp|tmp)\//u.test(relative)) {
        cleanupCandidates.push({path: relative, bytes: size, reason: "task-owned temporary or pending file"});
      }
    }
  };
  visit(root);
  return {
    root,
    bytes,
    files,
    categories,
    linked_paths_not_followed: linkedPaths.sort(),
    cleanup_candidates: cleanupCandidates.sort((left, right) => left.path.localeCompare(right.path)),
    cleanup: "report-only-until-authorized",
  };
}

export function preflightTaskWorkspace(taskId, expectedBytes = 0) {
  const root = resolveTaskPath(taskId);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error("expected bytes 必须是非负安全整数");
  }
  const environment = loadLocalMediaEnvironment();
  const inventory = directoryInventory(root);
  const artifactsReview = reviewTaskWorkspaceRoot();
  const artifactsInventory = artifactsReview.inventory;
  const filesystem = fs.statfsSync(existingVolumePath(root));
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const projectedBytes = inventory.bytes + expectedBytes;
  const projectedFreeBytes = freeBytes - expectedBytes;
  const report = {
    task_id: assertTaskId(taskId),
    root,
    current_bytes: inventory.bytes,
    expected_new_bytes: expectedBytes,
    projected_bytes: projectedBytes,
    maximum_task_bytes: environment.runtime.taskMaxBytes,
    current_artifacts_bytes: artifactsInventory.bytes,
    projected_artifacts_bytes: artifactsInventory.bytes + expectedBytes,
    maximum_artifacts_bytes: environment.runtime.artifactsMaxBytes,
    artifacts_review: artifactsReview,
    free_bytes: freeBytes,
    projected_free_bytes: projectedFreeBytes,
    minimum_free_bytes: environment.runtime.minimumFreeBytes,
  };
  const failures = [];
  if (projectedBytes > environment.runtime.taskMaxBytes) failures.push("预计任务用量超过单任务上限");
  if (artifactsInventory.bytes + expectedBytes > environment.runtime.artifactsMaxBytes) {
    failures.push("预计全部任务产物超过项目总上限");
  }
  if (projectedFreeBytes < environment.runtime.minimumFreeBytes) failures.push("预计写入后剩余空间低于安全线");
  if (failures.length) throw new Error(`任务存储预检未通过：${failures.join("；")}\n${JSON.stringify(report)}`);
  return report;
}

/** Create and return artifacts/<task-id>; existing contents are never removed. */
export function ensureTaskWorkspace(taskId, expectedBytes = 0) {
  const preflight = preflightTaskWorkspace(taskId, expectedBytes);
  const root = preflight.root;
  fs.mkdirSync(root, {recursive: true});
  const manifestPath = path.join(root, TASK_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      protocol: TASK_MANIFEST_PROTOCOL,
      version: 1,
      task_id: assertTaskId(taskId),
      status: "active",
      owner_pid: process.pid,
      created_at: new Date().toISOString(),
      preflight,
    }, null, 2)}\n`, "utf8");
  }
  return {path: root, preflight};
}

export function inventoryTaskWorkspace(taskId) {
  const root = resolveTaskPath(taskId);
  if (!fs.existsSync(root)) throw new Error(`任务工作区不存在：${root}`);
  return {task_id: assertTaskId(taskId), ...directoryInventory(root)};
}

export function reviewTaskWorkspaceRoot() {
  const inventory = directoryInventory(TASK_WORKSPACE_ROOT);
  const active = [];
  const cleanupCandidates = [];
  const unowned = [];
  const externallyOwned = new Map();
  if (fs.existsSync(TASK_WORKSPACE_ROOT)) {
    for (const entry of fs.readdirSync(TASK_WORKSPACE_ROOT, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const reportPath = path.join(
        TASK_WORKSPACE_ROOT,
        entry.name,
        "reports",
        "artifact-delta.json",
      );
      if (!fs.existsSync(reportPath)) continue;
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        if (report.protocol !== "visual-multimedia-artifact-delta" || report.version !== 1) continue;
        for (const record of [...(report.created_paths || []), ...(report.changed_paths || [])]) {
          if (typeof record?.path !== "string") continue;
          const owners = externallyOwned.get(record.path) || [];
          owners.push({task_id: entry.name, delta_bytes: record.delta_bytes});
          externallyOwned.set(record.path, owners);
        }
      } catch {
        // Invalid operation evidence is handled through the owning task manifest below.
      }
    }
    for (const entry of fs.readdirSync(TASK_WORKSPACE_ROOT, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const bytes = inventory.categories[entry.name]?.bytes || 0;
      const manifestPath = path.join(TASK_WORKSPACE_ROOT, entry.name, TASK_MANIFEST);
      if (!fs.existsSync(manifestPath)) {
        if (externallyOwned.has(entry.name)) continue;
        unowned.push({path: entry.name, bytes, reason: "missing task ownership manifest"});
        continue;
      }
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (manifest.protocol !== TASK_MANIFEST_PROTOCOL || manifest.task_id !== entry.name) {
          throw new Error("identity mismatch");
        }
        const record = {path: entry.name, bytes, status: manifest.status};
        if (["completed", "failed", "interrupted"].includes(manifest.status)) {
          cleanupCandidates.push({...record, reason: "terminal owned task; review before cleanup"});
        } else {
          active.push(record);
        }
      } catch (error) {
        unowned.push({path: entry.name, bytes, reason: `invalid task ownership manifest: ${error.message}`});
      }
    }
  }
  return {
    root: TASK_WORKSPACE_ROOT,
    inventory,
    active_tasks: active.sort((left, right) => left.path.localeCompare(right.path)),
    cleanup_candidates: cleanupCandidates.sort((left, right) => right.bytes - left.bytes),
    externally_owned_paths: [...externallyOwned.entries()]
      .map(([externalPath, owners]) => ({path: externalPath, owners}))
      .sort((left, right) => left.path.localeCompare(right.path)),
    unowned_review_required: unowned.sort((left, right) => right.bytes - left.bytes),
    cleanup: "report-only-until-authorized",
  };
}

export function finalizeTaskWorkspace(taskId, status) {
  if (!new Set(["completed", "failed", "interrupted"]).has(status)) {
    throw new Error("status 必须是 completed、failed 或 interrupted");
  }
  const root = resolveTaskPath(taskId);
  const manifestPath = path.join(root, TASK_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new Error(`任务清单不存在：${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.protocol !== TASK_MANIFEST_PROTOCOL || manifest.task_id !== assertTaskId(taskId)) {
    throw new Error(`任务清单身份不一致：${manifestPath}`);
  }
  const inventory = inventoryTaskWorkspace(taskId);
  const completed = {...manifest, status, finished_at: new Date().toISOString(), inventory};
  fs.writeFileSync(manifestPath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");
  return {path: root, manifest: manifestPath, status, inventory};
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const next = values[index + 1];
    if (next == null || next.startsWith("--")) result[token.slice(2)] = true;
    else {
      result[token.slice(2)] = next;
      index += 1;
    }
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (value == null || value === true || !String(value).trim()) throw new Error(`缺少 --${name}`);
  return String(value).trim();
}

function usage() {
  return [
    "用法：",
    "  node scripts/media-task-workspace.mjs preflight --task-id <id> --expected-bytes <字节>",
    "  node scripts/media-task-workspace.mjs ensure --task-id <id> [--expected-bytes <字节>]",
    "  node scripts/media-task-workspace.mjs inventory --task-id <id>",
    "  node scripts/media-task-workspace.mjs review",
    "  node scripts/media-task-workspace.mjs finalize --task-id <id> --status completed|failed|interrupted",
    "  node scripts/media-task-workspace.mjs resolve --task-id <id> [--relative <任务内相对路径>]",
    "  node scripts/media-task-workspace.mjs assert --path <绝对或相对路径>",
  ].join("\n");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(usage());
    return;
  }
  const args = parseArgs(rest);
  let result;
  const expectedBytes = args["expected-bytes"] == null
    ? 0
    : Number(required(args, "expected-bytes"));
  if (command === "preflight") {
    result = preflightTaskWorkspace(required(args, "task-id"), expectedBytes);
  } else if (command === "ensure") {
    result = ensureTaskWorkspace(required(args, "task-id"), expectedBytes);
  } else if (command === "inventory") {
    result = inventoryTaskWorkspace(required(args, "task-id"));
  } else if (command === "review") {
    result = reviewTaskWorkspaceRoot();
  } else if (command === "finalize") {
    result = finalizeTaskWorkspace(required(args, "task-id"), required(args, "status"));
  } else if (command === "resolve") {
    result = resolveTaskPath(required(args, "task-id"), args.relative === true ? "" : args.relative || "");
  } else if (command === "assert") {
    result = assertSkillTaskPath(required(args, "path"));
  } else {
    throw new Error(`未知命令：${command}\n${usage()}`);
  }
  console.log(JSON.stringify({
    ok: true,
    path: typeof result === "string" ? result : result.path || null,
    result,
    workspace_root: TASK_WORKSPACE_ROOT,
  }, null, 2));
}

if (path.resolve(process.argv[1] || "") === path.resolve(SCRIPT_PATH)) {
  try {
    main();
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  }
}
