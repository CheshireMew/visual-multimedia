#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {validateProjectState} from "./media_project_state.mjs";

export const validateMediaProjectState = validateProjectState;

function usage() {
  console.log(
    "用法：node scripts/validate-media-project-state.mjs"
      + " <media-project-state.json> [--json]\n"
      + "验证活动 v3 阶段模板、真实成果哈希、逐层确认、合同入口和下一步。",
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    return args.length === 0 ? 1 : 0;
  }
  const file = args.find((value) => !value.startsWith("--"));
  const result = validateProjectState(file);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    const current = result.current_stage || "done";
    console.log(
      `项目状态通过：${result.project_id}，${current}/${result.status}`,
    );
  } else {
    result.errors.forEach((message) => console.error(`FAIL ${message}`));
  }
  return result.ok ? 0 : 1;
}

if (
  path.resolve(fileURLToPath(import.meta.url))
  === path.resolve(process.argv[1] || "")
) {
  process.exitCode = main();
}
