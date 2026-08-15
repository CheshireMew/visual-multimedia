#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {
  parseArgs,
  readJson,
  requireArg,
  sha256File,
  slash,
  writeJson,
} from "./interview_explainer_common.mjs";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  confirmInterviewExplainerPlan,
  createInterviewExplainerPlan,
} from "./interview_explainer_plan.mjs";
import {renderInterviewExplainer} from "./interview_explainer_render.mjs";
import {
  finalizeInterviewExplainer,
  reviewInterviewExplainer,
} from "./interview_explainer_review.mjs";
import {assertSkillTaskPath} from "./media-task-workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(SCRIPT_DIR);

function usage() {
  console.log(`用法：
node scripts/interview-explainer.mjs list-profiles
node scripts/interview-explainer.mjs create-project --project <目录> --project-id <id>
node scripts/interview-explainer.mjs plan --project <目录> [--draft interview-explainer-draft.json]
  [--ffprobe <路径>] [--output interview-explainer-plan.json]
node scripts/interview-explainer.mjs confirm-plan --project <目录>
  [--plan interview-explainer-plan.json] --confirmed-by user|agent --evidence <说明>
node scripts/interview-explainer.mjs render --project <目录>
  [--plan ...] [--confirmation ...] [--ffmpeg <路径>] [--ffprobe <路径>]
  [--local-config <路径>]
node scripts/interview-explainer.mjs review --project <目录>
  [--agent-status pending|passed|changes-requested|failed]
  [--agent-notes <完整观看结论>] [--agent-method <观看方式>]
  [--user-required] [--user-status not-requested|pending|approved|rejected]
  [--user-evidence <用户确认依据>]
node scripts/interview-explainer.mjs finalize --project <目录>
  [--ffprobe <路径>] [--python <路径>]

这是采访原声讲解型视频的唯一公共入口。计划确认后，任何输入、profile 或生产脚本
哈希变化都会使确认失效；渲染不会重新选段、改旁白或切换到 avatar/HyperFrames。
项目阶段统一由 scripts/media-project.mjs 管理：content 确认后才能 plan，direction 和
integrated-sample 确认后才能完整 render，full-preview 确认后才能 finalize。`);
}

function listProfiles() {
  const catalogPath = path.join(
    SKILL_ROOT,
    "assets",
    "video-production-profiles",
    "catalog.json",
  );
  const catalog = readJson(catalogPath);
  assertJsonSchema(
    catalog,
    path.join(
      SKILL_ROOT,
      "schemas",
      "video-production-profile-catalog.v1.schema.json",
    ),
    "视频生产类型目录",
  );
  const result = [];
  for (const profile of catalog.profiles || []) {
    const packagePath = path.resolve(path.dirname(catalogPath), profile.package);
    const actual = sha256File(packagePath);
    if (actual !== profile.package_sha256) {
      throw new Error(`profile ${profile.id}@${profile.version} 哈希不匹配`);
    }
    result.push({
      id: profile.id,
      name: profile.name,
      version: profile.version,
      status: profile.status,
      package_sha256: actual,
      public_entry: profile.public_entry,
    });
  }
  console.log(JSON.stringify({
    protocol: catalog.protocol,
    version: catalog.version,
    profiles: result,
  }, null, 2));
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

function configureScenePackage(packageRoot, segmentId, name, output) {
  const manifestPath = path.join(packageRoot, "editable-media.json");
  const manifest = readJson(manifestPath);
  const opening = structuredClone(manifest.scenes[0]);
  opening.id = "opening";
  opening.name = name;
  opening.page_role = segmentId === "context"
    ? "opening"
    : "explanation";
  opening.duration_ms = 30000;
  opening.steps = [
    {
      id: "setup",
      at_ms: 0,
      label: "承接",
      state_kind: "start",
      review: true,
      description: "先承接原问题、上一段证据或必要背景。",
    },
    {
      id: "explain",
      at_ms: 9000,
      label: "解释",
      state_kind: "change",
      review: true,
      description: "用对象与镜头变化展示本段新增的因果或关系。",
    },
    {
      id: "takeaway",
      at_ms: 21000,
      label: "结论",
      state_kind: "result",
      review: true,
      description: "把本段解释收束为持续可读的结果状态。",
    },
  ];
  opening.motion = {
    complexity: "simple",
    driver: "object",
    semantic_purpose: "保持阅读容器稳定，只让当前旁白真正改变的对象、数值和关系进入下一状态。",
    key_state_review: "required",
    camera: null,
  };
  opening.data = {
    ...opening.data,
    eyebrow: "INTERVIEW EXPLAINER",
    title: name,
    summary: "根据当前旁白写清这一段新增的信息，画面负责显示关系和变化。",
    left_label: "承接",
    left_value: "原问题或上一段证据",
    right_label: "落点",
    right_value: "这一段真正解释清楚的结论",
  };
  manifest.component.id = `interview-explainer-${segmentId}`;
  manifest.component.name = `Interview explainer / ${name} / ${segmentId}`;
  manifest.component.category = "video-scenes";
  manifest.component.tags = ["interview", "explanation", "video"];
  manifest.playback.mode = "autoplay";
  manifest.playback.loop = "none";
  manifest.playback.fps = output.fps;
  const outputVariant = manifest.variants.find(
    (variant) => (
      Number(variant.canvas?.width) === Number(output.width)
      && Number(variant.canvas?.height) === Number(output.height)
    ),
  );
  if (!outputVariant) {
    throw new Error(
      `网页 starter 没有 ${output.width}x${output.height} 输出变体，不能建立采访场景包`,
    );
  }
  manifest.default_variant_id = outputVariant.id;
  manifest.scenes = [opening];
  manifest.production = {
    profile_id: "interview-explainer",
  };
  writeJson(manifestPath, manifest);
  const htmlPath = path.join(packageRoot, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  html = html
    .replace(/data-duration="[^"]+"/, 'data-duration="30"')
    .replace(/data-width="[^"]+"/, `data-width="${output.width}"`)
    .replace(/data-height="[^"]+"/, `data-height="${output.height}"`)
    .replace(/data-fps="[^"]+"/, `data-fps="${output.fps}"`);
  fs.writeFileSync(htmlPath, html, "utf8");
}

function createProject(args) {
  const project = assertSkillTaskPath(path.resolve(requireArg(args, "project")), "--project");
  const projectId = requireArg(args, "project-id");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(projectId)) {
    throw new Error("project-id 只允许小写字母、数字、点、下划线和连字符");
  }
  if (fs.existsSync(project)) {
    const entries = fs.readdirSync(project);
    if (entries.length) {
      throw new Error(`项目目录已经存在且非空，不会覆盖：${project}`);
    }
  } else {
    fs.mkdirSync(project, {recursive: true});
  }
  const mediaStarter = path.join(SKILL_ROOT, "assets", "media-project-starter");
  for (const entry of fs.readdirSync(mediaStarter, {withFileTypes: true})) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(mediaStarter, entry.name), path.join(project, entry.name));
  }
  const profileStarter = path.join(
    SKILL_ROOT,
    "assets",
    "interview-explainer-starter",
  );
  for (const entry of fs.readdirSync(profileStarter, {withFileTypes: true})) {
    if (!entry.isFile() || entry.name === "README.md") continue;
    fs.copyFileSync(path.join(profileStarter, entry.name), path.join(project, entry.name));
  }
  const statePath = path.join(project, "media-project-state.json");
  const state = readJson(statePath);
  state.project_id = projectId;
  state.media_kind = "mixed-video";
  state.profile = "interview-explainer";
  state.updated_at = new Date().toISOString();
  writeJson(statePath, state);
  const draftPath = path.join(project, "interview-explainer-draft.json");
  const draft = readJson(draftPath);
  draft.project_id = projectId;
  writeJson(draftPath, draft);

  const webStarter = path.join(SKILL_ROOT, "assets", "web-media-starter");
  for (const [segmentId, name] of [
    ["context", "先交代背景"],
    ["explanation-01", "紧接解释"],
    ["summary", "最后收束"],
  ]) {
    const destination = path.join(project, "editable-media", segmentId);
    copyDirectory(webStarter, destination);
    configureScenePackage(destination, segmentId, name, draft.output);
  }
  fs.mkdirSync(path.join(project, "captions"), {recursive: true});
  fs.mkdirSync(path.join(project, "renders", "final"), {recursive: true});
  fs.mkdirSync(path.join(project, "reports"), {recursive: true});
  fs.mkdirSync(path.join(project, "working"), {recursive: true});
  console.log(JSON.stringify({
    status: "created",
    project,
    project_id: projectId,
    profile: `${draft.profile.id}@${draft.profile.version}`,
    next: "导入真实素材并填写内容合同；提交通用 content 阶段并等待确认。",
  }, null, 2));
}

function booleanFlag(args, name) {
  return args[name] === true || args[name] === "true";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || args.help || args.h) {
    usage();
    return command ? 0 : 1;
  }
  if (command === "list-profiles") {
    listProfiles();
    return 0;
  }
  if (command === "create-project") {
    createProject(args);
    return 0;
  }
  const project = assertSkillTaskPath(path.resolve(requireArg(args, "project")), "--project");
  let result;
  if (command === "plan") {
    result = createInterviewExplainerPlan({
      project,
      draft: args.draft,
      output: args.output,
      ffprobe: args.ffprobe,
    });
  } else if (command === "confirm-plan") {
    result = confirmInterviewExplainerPlan({
      project,
      plan: args.plan,
      output: args.output,
      confirmedBy: requireArg(args, "confirmed-by"),
      evidence: requireArg(args, "evidence"),
    });
  } else if (command === "render") {
    result = renderInterviewExplainer({
      project,
      plan: args.plan,
      confirmation: args.confirmation,
      ffmpeg: args.ffmpeg,
      ffprobe: args.ffprobe,
      localConfig: args["local-config"],
      report: args.report,
    });
  } else if (command === "review") {
    result = reviewInterviewExplainer({
      project,
      plan: args.plan,
      confirmation: args.confirmation,
      buildReport: args["build-report"],
      review: args.review,
      machineReport: args["machine-report"],
      ffmpeg: args.ffmpeg,
      ffprobe: args.ffprobe,
      agentStatus: args["agent-status"],
      agentNotes: args["agent-notes"],
      agentMethod: args["agent-method"],
      userRequired: booleanFlag(args, "user-required"),
      userStatus: args["user-status"],
      userEvidence: args["user-evidence"],
    });
  } else if (command === "finalize") {
    result = finalizeInterviewExplainer({
      project,
      plan: args.plan,
      confirmation: args.confirmation,
      buildReport: args["build-report"],
      review: args.review,
      state: args.state,
      delivery: args.delivery,
      ffprobe: args.ffprobe,
      python: args.python,
    });
  } else {
    throw new Error(`未知 command：${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
