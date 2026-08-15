#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
export const TASK_WORKSPACE_ROOT = path.join(SKILL_ROOT, "artifacts");

const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;

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

/** Create and return artifacts/<task-id>; existing contents are never removed. */
export function ensureTaskWorkspace(taskId) {
  const root = resolveTaskPath(taskId);
  fs.mkdirSync(root, {recursive: true});
  return root;
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
    "  node scripts/media-task-workspace.mjs ensure --task-id <id>",
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
  if (command === "ensure") {
    result = ensureTaskWorkspace(required(args, "task-id"));
  } else if (command === "resolve") {
    result = resolveTaskPath(required(args, "task-id"), args.relative === true ? "" : args.relative || "");
  } else if (command === "assert") {
    result = assertSkillTaskPath(required(args, "path"));
  } else {
    throw new Error(`未知命令：${command}\n${usage()}`);
  }
  console.log(JSON.stringify({ok: true, path: result, workspace_root: TASK_WORKSPACE_ROOT}, null, 2));
}

if (path.resolve(process.argv[1] || "") === path.resolve(SCRIPT_PATH)) {
  try {
    main();
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  }
}
