#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {
  assertStageApproved,
  createProjectState,
  decideStage,
  invalidateStage,
  migrateV2State,
  readJson,
  setExecutionPolicy,
  setProjectContract,
  startStage,
  submitStage,
  validateProjectState,
  writeJson,
} from "./media_project_state.mjs";
import {assertSkillTaskPath} from "./media-task-workspace.mjs";

function usage() {
  console.log(`用法：
node scripts/media-project.mjs init --project <目录> --project-id <id>
  [--media-kind video|mixed-video|audio|podcast] [--profile <id>]
node scripts/media-project.mjs migrate-v2 --project <目录>
  [--media-kind ...] [--profile <id>]
node scripts/media-project.mjs inspect --project <目录>
node scripts/media-project.mjs start-stage --project <目录> --stage <id>
node scripts/media-project.mjs submit-stage --project <目录> --stage <id>
  --artifact <role>:<kind>:<project-relative-file>[:<id>] [...]
node scripts/media-project.mjs approve-stage --project <目录> --stage <id>
  --evidence <用户确认依据> [--decided-by user|profile|system]
node scripts/media-project.mjs reject-stage --project <目录> --stage <id>
  --evidence <用户修改意见> [--decided-by user|profile|system]
node scripts/media-project.mjs invalidate-stage --project <目录> --stage <id>
  --reason <上游变化>
node scripts/media-project.mjs set-policy --project <目录> --mode staged|full-auto
  [--authorized-by user --evidence <用户全自动授权>]
node scripts/media-project.mjs set-contract --project <目录> --name <合同字段>
  --file <项目相对文件|null>
node scripts/media-project.mjs assert-stage --project <目录> --stage <id>

完整时间型媒体默认 staged。每个阶段提交真实成果后进入 waiting-approval；
只有用户明确授权 full-auto 时，提交成果才自动推进。`);
}

function parseArgs(values) {
  const result = {_: [], artifact: []};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next == null || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    index += 1;
    if (key === "artifact") result.artifact.push(next);
    else result[key] = next;
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (value == null || value === true || String(value).length === 0) {
    throw new Error(`缺少 --${name}`);
  }
  return String(value);
}

function projectPaths(args) {
  const project = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  return {
    project,
    state: path.join(project, "media-project-state.json"),
  };
}

function parseArtifact(value) {
  const parts = String(value).split(":");
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(`--artifact 格式应为 role:kind:file[:id]，实际为 ${value}`);
  }
  const [role, kind, file, id] = parts;
  return {role, kind, file, id: id || undefined};
}

function loadActiveState(statePath) {
  if (!fs.existsSync(statePath)) throw new Error(`项目状态不存在：${statePath}`);
  const validation = validateProjectState(statePath);
  if (!validation.ok) {
    throw new Error(`项目状态无效：\n- ${validation.errors.join("\n- ")}`);
  }
  return readJson(statePath);
}

function writeAndInspect(statePath, state) {
  writeJson(statePath, state);
  const result = validateProjectState(statePath);
  if (!result.ok) {
    throw new Error(`写入后的项目状态无效：\n- ${result.errors.join("\n- ")}`);
  }
  return result;
}

function init(args) {
  const {project, state} = projectPaths(args);
  fs.mkdirSync(project, {recursive: true});
  if (fs.existsSync(state)) throw new Error(`不会覆盖已有项目状态：${state}`);
  const mediaSources = path.join(project, "media-sources.json");
  if (!fs.existsSync(mediaSources)) {
    throw new Error(`项目必须先有 media-sources.json：${mediaSources}`);
  }
  const document = createProjectState({
    projectId: required(args, "project-id"),
    mediaKind: String(args["media-kind"] || "video"),
    profile: args.profile ? String(args.profile) : null,
  });
  return writeAndInspect(state, document);
}

function migrate(args) {
  const {project, state} = projectPaths(args);
  if (!fs.existsSync(state)) throw new Error(`旧项目状态不存在：${state}`);
  const old = readJson(state);
  const migrated = migrateV2State(old, project, {
    mediaKind: String(args["media-kind"] || "video"),
    profile: args.profile ? String(args.profile) : null,
  });
  const backup = path.join(project, "archive", "media-project-state.v2.json");
  if (fs.existsSync(backup)) throw new Error(`迁移备份已经存在：${backup}`);
  writeJson(backup, old);
  return writeAndInspect(state, migrated);
}

function mutate(args, action) {
  const {project, state: statePath} = projectPaths(args);
  const state = loadActiveState(statePath);
  const stageId = required(args, "stage");
  let result;
  if (action === "start") {
    result = startStage(state, stageId);
  } else if (action === "submit") {
    result = submitStage(
      state,
      project,
      stageId,
      args.artifact.map(parseArtifact),
    );
  } else if (action === "approve" || action === "reject") {
    result = decideStage(
      state,
      stageId,
      action === "approve" ? "approved" : "rejected",
      required(args, "evidence"),
      {decidedBy: String(args["decided-by"] || "user")},
    );
  } else if (action === "invalidate") {
    result = invalidateStage(state, stageId, required(args, "reason"));
  } else {
    throw new Error(`未知状态动作：${action}`);
  }
  return writeAndInspect(statePath, result);
}

function setPolicy(args) {
  const {state: statePath} = projectPaths(args);
  const state = loadActiveState(statePath);
  const result = setExecutionPolicy(state, required(args, "mode"), {
    authorizedBy: args["authorized-by"] ? String(args["authorized-by"]) : null,
    evidence: args.evidence ? String(args.evidence) : "",
  });
  return writeAndInspect(statePath, result);
}

function setContract(args) {
  const {project, state: statePath} = projectPaths(args);
  const state = loadActiveState(statePath);
  const result = setProjectContract(
    state,
    project,
    required(args, "name"),
    required(args, "file"),
  );
  return writeAndInspect(statePath, result);
}

function inspect(args) {
  const {state} = projectPaths(args);
  return validateProjectState(state);
}

function assertStage(args) {
  const {state: statePath} = projectPaths(args);
  const state = loadActiveState(statePath);
  const stage = assertStageApproved(state, required(args, "stage"));
  return {ok: true, project_id: state.project_id, stage};
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || args.help || args.h) {
    usage();
    return command ? 0 : 1;
  }
  let result;
  if (command === "init") result = init(args);
  else if (command === "migrate-v2") result = migrate(args);
  else if (command === "inspect") result = inspect(args);
  else if (command === "start-stage") result = mutate(args, "start");
  else if (command === "submit-stage") result = mutate(args, "submit");
  else if (command === "approve-stage") result = mutate(args, "approve");
  else if (command === "reject-stage") result = mutate(args, "reject");
  else if (command === "invalidate-stage") result = mutate(args, "invalidate");
  else if (command === "set-policy") result = setPolicy(args);
  else if (command === "set-contract") result = setContract(args);
  else if (command === "assert-stage") result = assertStage(args);
  else throw new Error(`未知命令：${command}`);
  console.log(JSON.stringify(result, null, 2));
  return result.ok === false ? 1 : 0;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  }
}
