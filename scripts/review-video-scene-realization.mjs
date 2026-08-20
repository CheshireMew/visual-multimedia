#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {readEditableMediaPackage} from "./editable-media-contract.mjs";
import {assertSkillTaskPath} from "./media-task-workspace.mjs";
import {sha256EditableMediaImplementation, sha256Tree} from "./shot-recipe-library.mjs";
import {validateVideoDirectionPlan} from "./validate-video-direction-plan.mjs";

function usage() {
  console.log(`用法：
node scripts/review-video-scene-realization.mjs --plan <video-direction-plan.json>
  --segment <segment id> --status <accepted|revised> --summary <查看实际画面后的结论>
  [--package <项目内 editable-media v6 包> --scene <scene id> --variant <variant id>]
  [--proposal <返修后的 creative_proposal.json>] [--reviewed-at <ISO 日期时间>]

accepted 可接受计划中已经冻结的配方，也可直接采纳项目专用包。
revised 必须同时提交不同的项目专用包和带 revision_reason 的返修提案。
脚本只改创意提案与实现绑定；来源、事实、旁白、目的和真实时间保持不变。`);
}

function parseArgs(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 --${key} 缺少值`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

function required(args, key) {
  const value = args.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 --${key}`);
  return value;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function projectRelative(projectRoot, target, label) {
  const absolute = path.resolve(target);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于媒体项目内：${absolute}`);
  }
  return relative.split(path.sep).join("/");
}

function reviewedAt(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("--reviewed-at 不是有效日期时间");
  return date.toISOString();
}

function currentPackage(projectRoot, realization) {
  if (realization.kind === "project-package") {
    return {
      packageRoot: path.resolve(projectRoot, ...realization.package.split("/")),
      packageSha256: realization.package_sha256,
      implementationSha256: realization.implementation_sha256,
    };
  }
  const selectionPath = path.resolve(projectRoot, ...realization.selection.file.split("/"));
  const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
  return {
    packageRoot: path.resolve(projectRoot, ...(selection.package || "").split("/")),
    packageSha256: selection.package_sha256,
    implementationSha256: sha256EditableMediaImplementation(
      path.resolve(projectRoot, ...(selection.package || "").split("/")),
    ),
  };
}

function packageRealization(projectRoot, packagePath, sceneId, variantId, at, review) {
  const packageRoot = path.resolve(packagePath);
  projectRelative(projectRoot, packageRoot, "--package");
  if (!fs.statSync(packageRoot, {throwIfNoEntry: false})?.isDirectory()) {
    throw new Error(`--package 不是目录：${packageRoot}`);
  }
  const editable = readEditableMediaPackage(packageRoot);
  if (!editable.manifest.scenes.some((item) => item.id === sceneId)) {
    throw new Error(`项目专用包不存在 scene ${sceneId}`);
  }
  if (!editable.manifest.variants.some((item) => item.id === variantId)) {
    throw new Error(`项目专用包不存在 variant ${variantId}`);
  }
  const packageSha256 = sha256Tree(packageRoot);
  const implementationSha256 = sha256EditableMediaImplementation(packageRoot);
  return {
    kind: "project-package",
    package: projectRelative(projectRoot, packageRoot, "--package"),
    package_sha256: packageSha256,
    implementation_sha256: implementationSha256,
    manifest_sha256: sha256File(editable.manifestPath),
    scene_id: sceneId,
    variant_id: variantId,
    adopted_at: at,
    review: {...review, package_sha256: packageSha256},
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const args = parseArgs(argv);
  const planPath = path.resolve(required(args, "plan"));
  if (!fs.statSync(planPath, {throwIfNoEntry: false})?.isFile()) {
    throw new Error(`导演计划不存在：${planPath}`);
  }
  const projectRoot = assertSkillTaskPath(path.dirname(planPath), "--plan 所在项目");
  const initial = validateVideoDirectionPlan(planPath);
  if (!initial.ok) {
    throw new Error(`当前导演计划未通过验证：\n- ${initial.errors.join("\n- ")}`);
  }
  const segmentId = required(args, "segment");
  const scene = initial.plan.scenes.find((item) => item.segment_id === segmentId);
  if (!scene) throw new Error(`导演计划不存在 segment ${segmentId}`);
  const realization = scene.visual_plan.realization;
  if (!realization) throw new Error(`${segmentId} 不是可采纳网页实现的场景`);
  const status = required(args, "status");
  if (!["accepted", "revised"].includes(status)) throw new Error("--status 必须是 accepted 或 revised");
  const summary = required(args, "summary");
  const at = reviewedAt(args.get("reviewed-at"));
  const review = {status, reviewed_at: at, summary};
  const proposalPath = args.get("proposal") ? path.resolve(args.get("proposal")) : null;
  const packagePath = args.get("package") ? path.resolve(args.get("package")) : null;

  if (status === "revised" && (!packagePath || !proposalPath)) {
    throw new Error("revised 必须同时提供 --package 和 --proposal，使结论落到真实源码变化");
  }
  if (packagePath && (!args.get("scene") || !args.get("variant"))) {
    throw new Error("提供 --package 时必须同时提供 --scene 与 --variant");
  }
  if (!packagePath && (args.get("scene") || args.get("variant"))) {
    throw new Error("--scene 与 --variant 只能和 --package 一起使用");
  }

  let nextProposal = scene.creative_proposal;
  if (proposalPath) {
    if (!fs.statSync(proposalPath, {throwIfNoEntry: false})?.isFile()) {
      throw new Error(`--proposal 不存在：${proposalPath}`);
    }
    nextProposal = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
    if (status !== "revised" && canonicalJson(nextProposal) !== canonicalJson(scene.creative_proposal)) {
      throw new Error("改变创意提案时 --status 必须是 revised");
    }
    if (status === "revised" && !(typeof nextProposal.revision_reason === "string" && nextProposal.revision_reason.trim())) {
      throw new Error("返修后的 creative_proposal.revision_reason 必须说明真实改变原因");
    }
  }

  const previous = currentPackage(projectRoot, realization);
  let nextRealization;
  if (packagePath) {
    nextRealization = packageRealization(
      projectRoot,
      packagePath,
      required(args, "scene"),
      required(args, "variant"),
      at,
      review,
    );
    if (status === "revised" && nextRealization.implementation_sha256 === previous.implementationSha256) {
      throw new Error("revised 的视觉实现源码与当前实现相同；只改组件名称、声明或许可文件不算返修");
    }
  } else {
    if (status === "revised") throw new Error("revised 不能只改结论，必须提交新的项目专用包");
    nextRealization = {
      ...realization,
      review: {...review, package_sha256: previous.packageSha256},
    };
  }

  const nextPlan = structuredClone(initial.plan);
  const nextScene = nextPlan.scenes.find((item) => item.segment_id === segmentId);
  nextScene.creative_proposal = nextProposal;
  nextScene.visual_plan.realization = nextRealization;
  const candidatePath = path.join(
    projectRoot,
    `.video-direction-plan.${segmentId}.${sha256Buffer(canonicalJson(nextPlan)).slice(0, 16)}.candidate.json`,
  );
  fs.writeFileSync(candidatePath, `${JSON.stringify(nextPlan, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  const validation = validateVideoDirectionPlan(candidatePath);
  if (!validation.ok) {
    throw new Error(`返修候选未通过验证，当前计划未改变：\n- ${validation.errors.join("\n- ")}\n候选保留在 ${candidatePath}`);
  }

  const oldSha = sha256File(planPath);
  const revisionDirectory = path.join(projectRoot, "direction", "revisions", segmentId);
  fs.mkdirSync(revisionDirectory, {recursive: true});
  const archivePath = path.join(revisionDirectory, `${oldSha}.json`);
  if (fs.existsSync(archivePath)) {
    if (sha256File(archivePath) !== oldSha) throw new Error(`历史计划内容寻址冲突：${archivePath}`);
  } else {
    fs.copyFileSync(planPath, archivePath, fs.constants.COPYFILE_EXCL);
  }
  fs.renameSync(candidatePath, planPath);
  console.log(JSON.stringify({
    updated: true,
    plan: planPath,
    segment_id: segmentId,
    status,
    realization_kind: nextRealization.kind,
    package_sha256: nextRealization.review.package_sha256,
    previous_plan: archivePath,
  }, null, 2));
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
