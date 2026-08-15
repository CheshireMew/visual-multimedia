#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {
  commandPath,
  parseArgs,
  projectPath,
  readJson,
  relativeProjectPath,
  requireArg,
  sha256File,
  writeJson,
} from "./interview_explainer_common.mjs";
import {loadLocalMediaEnvironment} from "./local-media-environment.mjs";
import {decideStage, validateProjectState} from "./media_project_state.mjs";
import {finalizeStandardVideo, reviewStandardVideo} from "./standard_video_delivery.mjs";
import {
  CONFIRMATION_RELATIVE,
  DRAFT_RELATIVE,
  PLAN_RELATIVE,
  PROFILE,
  PROFILE_RELATIVE,
  TIMELINE_RELATIVE,
  assertPlanConfirmation,
  confirmSourceVideoCommentaryContent,
  confirmSourceVideoCommentaryPlan,
  createSourceVideoCommentaryPlan,
  createSourceVideoCommentaryProject,
  migrateSourceVideoCommentaryProfile,
  validateSourceVideoCommentaryDraft,
} from "./source_video_commentary_contract.mjs";
import {
  confirmSourceVideoCommentaryPreview,
  confirmSourceVideoCommentarySample,
  renderSourceVideoCommentary,
  renderSourceVideoCommentarySample,
} from "./source_video_commentary_render.mjs";
import {
  analyzeSourceVideo,
  confirmSourceTranscript,
  confirmSourceVideoCommentaryAuthoring,
  confirmSourceVideoCommentaryNarration,
  importBackgroundMusic,
  ingestSourceVideo,
  materializeSourceVideoCommentary,
  synthesizeSourceVideoCommentaryNarration,
  validateSourceVideoCommentaryAuthoring,
} from "./source_video_commentary_preproduction.mjs";
import {assertSkillTaskPath} from "./media-task-workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function usage() {
  process.stdout.write(`素材解说型视频 source-video-commentary@1.0.0

用法：
node scripts/source-video-commentary.mjs list-profiles
node scripts/source-video-commentary.mjs create-project --project <目录> --project-id <id>
node scripts/source-video-commentary.mjs migrate-profile --project <目录>
node scripts/source-video-commentary.mjs prepare --project <目录> --project-id <id> --source <视频> --source-id <id> --rights-status <状态> --license <依据>
node scripts/source-video-commentary.mjs analyze --project <目录> --source-id <id> [--transcription-mode auto|required|skip] [--language zh]
node scripts/source-video-commentary.mjs confirm-transcript --project <目录> --confirmed-by user --evidence <完整听音依据>
node scripts/source-video-commentary.mjs import-bgm --project <目录> --input <音乐> --source-id <id> --rights-status <状态> --license <依据>
node scripts/source-video-commentary.mjs validate-authoring --project <目录>
node scripts/source-video-commentary.mjs confirm-authoring --project <目录> --confirmed-by user --evidence <完整稿、选段、声音和音乐确认依据>
node scripts/source-video-commentary.mjs synthesize --project <目录>
node scripts/source-video-commentary.mjs confirm-narration --project <目录> --confirmed-by user --evidence <完整试听依据>
node scripts/source-video-commentary.mjs materialize --project <目录>
node scripts/source-video-commentary.mjs validate --project <目录>
node scripts/source-video-commentary.mjs confirm-content --project <目录> --confirmed-by user --evidence <依据>
node scripts/source-video-commentary.mjs plan --project <目录>
node scripts/source-video-commentary.mjs confirm-plan --project <目录> --confirmed-by user --evidence <依据>
node scripts/source-video-commentary.mjs sample --project <目录> [--provider auto|mediaflow|local]
node scripts/source-video-commentary.mjs confirm-sample --project <目录> --confirmed-by user --evidence <依据>
node scripts/source-video-commentary.mjs render --project <目录> [--provider auto|mediaflow|local]
node scripts/source-video-commentary.mjs review --project <目录> --agent-status passed --agent-completed true --agent-evidence <完整观看依据>
node scripts/source-video-commentary.mjs confirm-preview --project <目录> --confirmed-by user --evidence <依据>
node scripts/source-video-commentary.mjs finalize --project <目录>
node scripts/source-video-commentary.mjs confirm-delivery --project <目录> --confirmed-by user --evidence <依据>

真实源片入点/出点只写 clip-selections.json；项目节目位置只写 portable timeline 或 project.mfp。
`);
}

function requireUserConfirmation(args) {
  const value = requireArg(args, "confirmed-by");
  if (value !== "user") throw new Error("阶段确认必须记录 confirmed-by=user；Agent 完整审看使用 review 命令单独记录");
  return value;
}

function runtimeOptions(args) {
  return {
    localConfig: args["local-config"],
    provider: args.provider || "auto",
    ffmpeg: args.ffmpeg,
    ffprobe: args.ffprobe,
    browser: args.browser,
  };
}

function ffprobeFor(args) {
  const environment = loadLocalMediaEnvironment(args["local-config"]);
  return commandPath("ffprobe", args.ffprobe || environment.providers.local.ffprobe, "FFPROBE_BIN");
}

function commandProject(args) {
  return assertSkillTaskPath(path.resolve(requireArg(args, "project")), "--project");
}

function confirmFinalDelivery(projectRoot, evidence, confirmedBy) {
  const statePath = path.join(projectRoot, "media-project-state.json");
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  const state = readJson(statePath);
  const stage = state.stages.find((item) => item.id === "final-delivery");
  if (stage.status === "waiting-approval") {
    decideStage(state, "final-delivery", "approved", evidence, {decidedBy: confirmedBy});
    writeJson(statePath, state);
    const next = validateProjectState(statePath);
    if (!next.ok) throw new Error(`最终交付确认后状态未通过：\n- ${next.errors.join("\n- ")}`);
    return {status: "approved", state: statePath, next_action: next.next_action};
  }
  if (stage.status !== "approved") throw new Error(`final-delivery 当前为 ${stage.status}，不能确认`);
  return {status: "approved", state: statePath, next_action: state.next_action};
}

function finalizationOptions(projectRoot, args) {
  const context = assertPlanConfirmation(projectRoot, args.plan || PLAN_RELATIVE, args.confirmation || CONFIRMATION_RELATIVE);
  const reportRelative = args.report || "reports/media-build-report.json";
  const report = readJson(projectPath(projectRoot, reportRelative, "media build report"));
  const state = readJson(path.join(projectRoot, "media-project-state.json"));
  const sources = readJson(path.join(projectRoot, "media-sources.json"));
  const adoptedSourceIds = [...new Set(context.plan.segments.flatMap((segment) => [
    segment.visual.source_id || null,
    segment.narration?.audio_source_id || null,
  ]).concat(context.plan.background_music?.source_id || []).filter(Boolean))];
  const byId = new Map(sources.sources.map((item) => [item.id, item]));
  for (const id of adoptedSourceIds) {
    const status = byId.get(id)?.rights?.status;
    if (!new Set(["confirmed", "not-required"]).has(status)) throw new Error(`正式采用素材 ${id} 的权利状态仍为 ${status || "missing"}`);
  }
  const renderReceiptPath = path.join(projectRoot, "reports", "source-video-commentary-render-receipt.json");
  const isMediaFlow = fs.existsSync(renderReceiptPath) && readJson(renderReceiptPath).provider === "mediaflow";
  let production;
  let editability;
  let timelineContract;
  if (isMediaFlow) {
    const receipt = readJson(renderReceiptPath);
    const nativeProjectPath = projectPath(projectRoot, receipt.native_project, "MediaFlow native project snapshot");
    if (sha256File(nativeProjectPath) !== receipt.native_project_sha256) throw new Error("MediaFlow native project snapshot 哈希已经失效");
    production = {
      provider: "mediaflow",
      truth_kind: "mediaflow-project",
      truth_files: [{role: "native-project", file: receipt.native_project, sha256: receipt.native_project_sha256}],
      render_receipt: {file: relativeProjectPath(projectRoot, renderReceiptPath), sha256: sha256File(renderReceiptPath)},
    };
    editability = {
      classification: "native_project",
      native_project: {
        file: receipt.native_project,
        sha256: receipt.native_project_sha256,
        project_id: receipt.mediaflow_project_id,
        content_revision: receipt.content_revision,
      },
      limitations: ["editable scene 仍以项目内 editable-media 网页包为内容真源；MediaFlow 时间线保存其确定性预渲染片段。"],
    };
    timelineContract = receipt.native_project;
  } else {
    const timeline = projectPath(projectRoot, TIMELINE_RELATIVE, "portable timeline");
    const localReceipt = fs.existsSync(renderReceiptPath)
      ? {file: relativeProjectPath(projectRoot, renderReceiptPath), sha256: sha256File(renderReceiptPath)}
      : null;
    production = {
      provider: "local",
      truth_kind: "portable-timeline",
      truth_files: [{role: "portable-timeline", file: relativeProjectPath(projectRoot, timeline), sha256: sha256File(timeline)}],
      render_receipt: localReceipt,
    };
    editability = {
      classification: "source_bundle",
      native_project: null,
      limitations: ["本地路线没有生成 MediaFlow 原生工程；继续编辑使用 portable timeline、素材账本、片段选择、旁白包和项目内 editable-media 网页包。"],
    };
    timelineContract = relativeProjectPath(projectRoot, timeline);
  }
  return {
    project: projectRoot,
    profile: PROFILE,
    plan: context.planBinding.file,
    confirmation: context.confirmationBinding.file,
    buildReport: reportRelative,
    review: args.review || "media-review.json",
    delivery: args.delivery || "media-delivery.json",
    ffprobe: args.ffprobe,
    python: args.python,
    audioRequired: true,
    captionsRequired: context.plan.output.caption_mode !== "none",
    production,
    editability,
    transcript: state.contracts.transcript,
    clipSelections: state.contracts.clip_selections,
    adoptedSourceIds,
    timelineContract,
    rightsReviewNotes: `正式采用的 ${adoptedSourceIds.length} 项素材均已通过账本与权利状态检查。`,
    output_sha256: report.output.sha256,
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === "help" || args.help || args.h) {
    usage();
    return command ? 0 : 1;
  }
  if (command === "list-profiles") {
    process.stdout.write(`${JSON.stringify({id: "source-video-commentary", version: "1.0.0", profile: PROFILE, package: "assets/video-production-profiles/source-video-commentary/1.0.0/profile.json", public_entry: "scripts/source-video-commentary.mjs"}, null, 2)}\n`);
    return 0;
  }
  const project = commandProject(args);
  if (command === "create-project") {
    process.stdout.write(`${JSON.stringify(createSourceVideoCommentaryProject({project, projectId: requireArg(args, "project-id")}), null, 2)}\n`);
    return 0;
  }
  if (command === "migrate-profile") {
    process.stdout.write(`${JSON.stringify(migrateSourceVideoCommentaryProfile({project}), null, 2)}\n`);
    return 0;
  }
  if (command === "prepare") {
    if (!fs.existsSync(project) || fs.readdirSync(project).length === 0) {
      createSourceVideoCommentaryProject({project, projectId: requireArg(args, "project-id")});
    }
    const ingested = ingestSourceVideo({
      project,
      input: requireArg(args, "source"),
      sourceId: requireArg(args, "source-id"),
      method: args.method || "user-provided",
      rightsStatus: requireArg(args, "rights-status"),
      license: requireArg(args, "license"),
      usage: args.usage,
      notes: args.notes,
    });
    const analyzed = analyzeSourceVideo({
      project,
      sourceId: requireArg(args, "source-id"),
      transcriptionMode: args["transcription-mode"] || "auto",
      language: args.language,
      sceneThreshold: args["scene-threshold"],
      maximumCandidates: args["maximum-candidates"],
      contactSheetFrames: args["contact-sheet-frames"],
      localConfig: args["local-config"],
      ffmpeg: args.ffmpeg,
      ffprobe: args.ffprobe,
      python: args.python,
    });
    process.stdout.write(`${JSON.stringify({project, ingested, analyzed, next_action: "查看联系表与转写；先确认 transcript，再由 Agent 写 source-video-commentary-authoring.json。"}, null, 2)}\n`);
    return 0;
  }
  if (command === "analyze") {
    const result = analyzeSourceVideo({
      project,
      sourceId: requireArg(args, "source-id"),
      transcriptionMode: args["transcription-mode"] || "auto",
      language: args.language,
      sceneThreshold: args["scene-threshold"],
      maximumCandidates: args["maximum-candidates"],
      contactSheetFrames: args["contact-sheet-frames"],
      localConfig: args["local-config"],
      ffmpeg: args.ffmpeg,
      ffprobe: args.ffprobe,
      python: args.python,
      output: args.output,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "confirm-transcript") {
    const result = confirmSourceTranscript({project, transcript: args.transcript, analysis: args.analysis, authoring: args.authoring, confirmedBy: requireUserConfirmation(args), evidence: requireArg(args, "evidence")});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "import-bgm") {
    const result = importBackgroundMusic({
      project,
      input: requireArg(args, "input"),
      sourceId: requireArg(args, "source-id"),
      method: args.method || "user-provided",
      rightsStatus: requireArg(args, "rights-status"),
      license: requireArg(args, "license"),
      usage: args.usage,
      notes: args.notes,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "validate-authoring") {
    const environment = loadLocalMediaEnvironment(args["local-config"]);
    const result = validateSourceVideoCommentaryAuthoring({project, authoring: args.authoring, environment, ffprobe: ffprobeFor(args), requireReviewedTranscript: true});
    process.stdout.write(`${JSON.stringify({ok: true, authoring: result.authoringPath, segments: result.authoring.segments.length, voice: result.voice?.id || null, background_music: result.music?.id || null}, null, 2)}\n`);
    return 0;
  }
  if (command === "confirm-authoring") {
    const result = confirmSourceVideoCommentaryAuthoring({project, authoring: args.authoring, confirmation: args.confirmation, localConfig: args["local-config"], ffprobe: args.ffprobe, confirmedBy: requireUserConfirmation(args), evidence: requireArg(args, "evidence")});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "synthesize") {
    const result = synthesizeSourceVideoCommentaryNarration({project, authoring: args.authoring, confirmation: args.confirmation, output: args.output, localConfig: args["local-config"], ffprobe: args.ffprobe, timeoutSeconds: args["timeout-seconds"]});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "confirm-narration") {
    const result = confirmSourceVideoCommentaryNarration({project, candidates: args.candidates, confirmation: args.confirmation, output: args.output, confirmedBy: requireUserConfirmation(args), evidence: requireArg(args, "evidence")});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "materialize") {
    const result = materializeSourceVideoCommentary({project, authoring: args.authoring, confirmation: args.confirmation, narrationBundle: args["narration-bundle"], script: args.script, draft: args.draft, localConfig: args["local-config"], ffprobe: args.ffprobe});
    const validation = validateSourceVideoCommentaryDraft({project, draft: args.draft || DRAFT_RELATIVE, ffprobe: ffprobeFor(args)});
    process.stdout.write(`${JSON.stringify({...result, validated: true, bindings: {draft: validation.draftBinding.sha256, script: validation.script.sha256, media_sources: validation.sources.sha256}}, null, 2)}\n`);
    return 0;
  }
  if (command === "validate") {
    const result = validateSourceVideoCommentaryDraft({project, draft: args.draft || DRAFT_RELATIVE, ffprobe: ffprobeFor(args)});
    process.stdout.write(`${JSON.stringify({ok: true, project, profile: PROFILE, segments: result.draft.segments.length, sample_segments: result.draft.integrated_sample.segment_ids, bindings: {draft: result.draftBinding.sha256, script: result.script.sha256, media_sources: result.sources.sha256, clip_selections: sha256File(result.clips.absolute), narration_bundle: result.narration.sha256}}, null, 2)}\n`);
    return 0;
  }
  if (command === "confirm-content") {
    const result = confirmSourceVideoCommentaryContent({project, draft: args.draft || DRAFT_RELATIVE, ffprobe: ffprobeFor(args), confirmedBy: requireUserConfirmation(args), evidence: requireArg(args, "evidence")});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "plan") {
    const result = createSourceVideoCommentaryPlan({project, draft: args.draft || DRAFT_RELATIVE, plan: args.plan || PLAN_RELATIVE, ffprobe: ffprobeFor(args)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "confirm-plan") {
    const result = confirmSourceVideoCommentaryPlan({project, plan: args.plan || PLAN_RELATIVE, confirmation: args.confirmation || CONFIRMATION_RELATIVE, confirmedBy: requireUserConfirmation(args), evidence: requireArg(args, "evidence")});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "sample") {
    const result = renderSourceVideoCommentarySample({project, plan: args.plan || PLAN_RELATIVE, confirmation: args.confirmation || CONFIRMATION_RELATIVE, output: args.output, ...runtimeOptions(args)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "confirm-sample") {
    const result = confirmSourceVideoCommentarySample({project, confirmedBy: requireUserConfirmation(args), evidence: requireArg(args, "evidence")});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "render") {
    const result = renderSourceVideoCommentary({project, plan: args.plan || PLAN_RELATIVE, confirmation: args.confirmation || CONFIRMATION_RELATIVE, timeline: args.timeline || TIMELINE_RELATIVE, buildPlan: args["build-plan"], report: args.report, ...runtimeOptions(args)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "review") {
    const context = assertPlanConfirmation(project, args.plan || PLAN_RELATIVE, args.confirmation || CONFIRMATION_RELATIVE);
    const result = reviewStandardVideo({
      project,
      profile: PROFILE,
      plan: context.planBinding.file,
      confirmation: context.confirmationBinding.file,
      buildReport: args.report || "reports/media-build-report.json",
      review: args.review || "media-review.json",
      machineReport: args["machine-report"],
      contactSheet: args["contact-sheet"],
      ffmpeg: args.ffmpeg,
      ffprobe: args.ffprobe,
      python: args.python,
      agentStatus: args["agent-status"] || "pending",
      agentCompleted: args["agent-completed"] === "true",
      agentEvidence: args["agent-evidence"] || "",
      userRequired: args["user-required"] === "true",
      userStatus: args["user-status"],
      userEvidence: args["user-evidence"] || "",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "confirm-preview") {
    const result = confirmSourceVideoCommentaryPreview({project, confirmedBy: requireUserConfirmation(args), evidence: requireArg(args, "evidence")});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "finalize") {
    const result = finalizeStandardVideo(finalizationOptions(project, args));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "confirm-delivery") {
    const result = confirmFinalDelivery(project, requireArg(args, "evidence"), requireUserConfirmation(args));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  usage();
  throw new Error(`未知命令：${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`错误：${error.stack || error.message}\n`);
      process.exitCode = 1;
    },
  );
}
