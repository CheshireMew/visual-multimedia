#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLI = path.join(SCRIPT_DIR, "media-project.mjs");
const DEFAULT_ROOT = process.platform === "win32" && fs.existsSync("D:\\Tools")
  ? "D:\\Tools\\visual-multimedia-tests"
  : os.tmpdir();
const RUN_ROOT = path.join(
  path.resolve(process.env.VISUAL_MULTIMEDIA_TEST_ROOT || DEFAULT_ROOT),
  "media-project-stages",
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
);
const PROJECT = path.join(RUN_ROOT, "generic-video");

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: SKILL_ROOT,
    encoding: "utf8",
  });
  if (result.status !== expected) {
    throw new Error(
      `${args.join(" ")} 返回 ${result.status}，预期 ${expected}\n`
        + `${result.stdout}\n${result.stderr}`,
    );
  }
  if (expected !== 0) return null;
  return JSON.parse(result.stdout);
}

function write(relative, content) {
  const target = path.join(PROJECT, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, content);
  return target;
}

function completeStage(stage, artifact) {
  run(["start-stage", "--project", PROJECT, "--stage", stage]);
  const waiting = run([
    "submit-stage",
    "--project", PROJECT,
    "--stage", stage,
    "--artifact", artifact,
  ]);
  if (waiting.status !== "waiting-approval" || waiting.current_stage !== stage) {
    throw new Error(`${stage} 提交后没有停在 waiting-approval`);
  }
  return run([
    "approve-stage",
    "--project", PROJECT,
    "--stage", stage,
    "--evidence", `用户确认 ${stage} 测试成果`,
  ]);
}

function main() {
  fs.mkdirSync(PROJECT, {recursive: true});
  fs.copyFileSync(
    path.join(SKILL_ROOT, "assets", "media-project-starter", "media-sources.json"),
    path.join(PROJECT, "media-sources.json"),
  );
  write("content.md", "# 通用视频内容合同\n\n旁白、镜头职责和观众落点已经确认。\n");
  write("direction.md", "# 导演方向\n\n画面、网页动画、声音和角色的职责已经确认。\n");
  const realVideo = path.join(
    SKILL_ROOT,
    "assets",
    "media-delivery-case",
    "renders",
    "final.mp4",
  );
  for (const name of ["integrated-sample.mp4", "full-preview.mp4", "final.mp4"]) {
    fs.copyFileSync(realVideo, path.join(PROJECT, name));
  }
  fs.copyFileSync(
    path.join(SKILL_ROOT, "assets", "media-project-starter", "media-delivery.json"),
    path.join(PROJECT, "media-delivery.json"),
  );

  const initialized = run([
    "init",
    "--project", PROJECT,
    "--project-id", "generic-video-stage-selfcheck",
    "--media-kind", "video",
  ]);
  if (initialized.current_stage !== "content") throw new Error("项目没有从 content 开始");
  run(["set-policy", "--project", PROJECT, "--mode", "full-auto"], 1);
  const auto = run([
    "set-policy",
    "--project", PROJECT,
    "--mode", "full-auto",
    "--authorized-by", "user",
    "--evidence", "用户明确授权本次测试全自动完成",
  ]);
  if (
    auto.execution_policy.mode !== "full-auto"
    || auto.execution_policy.authorized_by !== "user"
  ) {
    throw new Error("明确用户授权没有被记录为 full-auto");
  }
  run(["set-policy", "--project", PROJECT, "--mode", "staged"]);

  run(["assert-stage", "--project", PROJECT, "--stage", "direction"], 1);
  completeStage("content", "content-contract:document:content.md");
  completeStage("direction", "direction-package:document:direction.md");
  completeStage(
    "integrated-sample",
    "integrated-sample:video:integrated-sample.mp4",
  );
  completeStage("full-preview", "full-preview:video:full-preview.mp4");
  run([
    "set-contract",
    "--project", PROJECT,
    "--name", "delivery",
    "--file", "media-delivery.json",
  ]);
  const completed = completeStage(
    "final-delivery",
    "final-delivery:video:final.mp4:final-video",
  );
  if (completed.status !== "complete" || completed.current_stage !== null) {
    throw new Error("五个阶段全部确认后项目没有完成");
  }

  const invalidated = run([
    "invalidate-stage",
    "--project", PROJECT,
    "--stage", "direction",
    "--reason", "用户修改了通用视频的导演方向",
  ]);
  const byId = new Map(invalidated.stages.map((stage) => [stage.id, stage]));
  if (
    byId.get("content")?.status !== "approved"
    || byId.get("direction")?.status !== "invalidated"
    || byId.get("integrated-sample")?.status !== "invalidated"
    || byId.get("full-preview")?.status !== "invalidated"
    || byId.get("final-delivery")?.status !== "invalidated"
  ) {
    throw new Error("上游失效没有只保留已确认 content 并失效全部下游");
  }
  const final = run(["inspect", "--project", PROJECT]);
  console.log(JSON.stringify({
    ok: true,
    project: PROJECT,
    initial_gate_blocked_downstream: true,
    each_stage_stopped_for_approval: true,
    full_auto_requires_explicit_user_authorization: true,
    authorized_full_auto_recorded: true,
    completed_once: true,
    invalidation_scope: final.stages.map((stage) => ({
      id: stage.id,
      status: stage.status,
    })),
    next_action: final.next_action,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
