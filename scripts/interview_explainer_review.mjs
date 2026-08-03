import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {
  commandPath,
  ensureFile,
  nowIso,
  probeMedia,
  projectPath,
  readJson,
  relativeProjectPath,
  run,
  sha256File,
  writeJson,
} from "./interview_explainer_common.mjs";
import {assertPlanAndConfirmation} from "./interview_explainer_plan.mjs";
import {
  reviewBasisSha256,
  validateMediaReview,
} from "./validate-media-review.mjs";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  assertStageApproved,
  submitStage,
  validateProjectState,
} from "./media_project_state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(SCRIPT_DIR, "..", "schemas");

function parseSrtSummary(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const matches = [...text.matchAll(
    /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/g,
  )];
  if (!matches.length) throw new Error(`字幕没有时间码：${filePath}`);
  const seconds = (values, offset) =>
    Number(values[offset]) * 3600
    + Number(values[offset + 1]) * 60
    + Number(values[offset + 2])
    + Number(values[offset + 3]) / 1000;
  return {
    cues: matches.length,
    first_start_seconds: seconds(matches[0], 1),
    last_end_seconds: seconds(matches.at(-1), 5),
  };
}

function ffmpegAnalysis(ffmpeg, args) {
  const result = run(ffmpeg, ["-hide_banner", "-nostats", ...args]);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function makeReviewArtifacts(projectRoot, plan, outputPath, outputSha256, ffmpeg) {
  const reports = projectPath(projectRoot, "reports", "reports");
  fs.mkdirSync(reports, {recursive: true});
  const prefix = path.join(
    reports,
    `interview-explainer-${outputSha256.slice(0, 12)}`,
  );
  const contactSheet = `${prefix}-contact-sheet.jpg`;
  const denseContactSheet = `${prefix}-dense-contact-sheet.jpg`;
  const firstFrame = `${prefix}-first-frame.jpg`;
  const lastFrame = `${prefix}-last-frame.jpg`;
  const audioReview = `${prefix}-review-audio.mp3`;
  const sampleRate = Math.max(0.05, 20 / plan.duration_seconds);
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", outputPath,
    "-vf", `fps=${sampleRate},scale=270:-2:flags=lanczos,tile=5x4`,
    "-frames:v", "1", "-q:v", "2", "-y", contactSheet,
  ]);
  const denseRate = Math.max(0.1, Math.min(2, 48 / plan.duration_seconds));
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", outputPath,
    "-vf", `fps=${denseRate},scale=180:-2:flags=lanczos,tile=8x6`,
    "-frames:v", "1", "-q:v", "2", "-y", denseContactSheet,
  ]);
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", outputPath, "-frames:v", "1", "-q:v", "2", "-y", firstFrame,
  ]);
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-sseof", "-0.12", "-i", outputPath,
    "-frames:v", "1", "-q:v", "2", "-y", lastFrame,
  ]);
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", outputPath, "-vn", "-c:a", "libmp3lame", "-b:a", "160k",
    "-y", audioReview,
  ]);
  return {contactSheet, denseContactSheet, firstFrame, lastFrame, audioReview};
}

function determineReviewStatus(machineStatus, agentStatus, user) {
  if (
    machineStatus === "failed"
    || agentStatus === "failed"
    || user.status === "rejected"
  ) return "failed";
  if (agentStatus === "changes-requested") return "changes-requested";
  if (
    machineStatus === "passed"
    && agentStatus === "passed"
    && (!user.required || user.status === "approved")
  ) return "passed";
  return "pending";
}

export function reviewInterviewExplainer(options) {
  const projectRoot = path.resolve(options.project);
  const {plan, planPath, confirmationPath} = assertPlanAndConfirmation(
    projectRoot,
    options.plan || "interview-explainer-plan.json",
    options.confirmation || "interview-explainer-plan.confirmation.json",
  );
  const buildPath = projectPath(
    projectRoot,
    options.buildReport || "reports/media-build-report.json",
    "build report",
  );
  ensureFile(buildPath, "构建报告");
  const build = readJson(buildPath);
  assertJsonSchema(
    build,
    path.join(SCHEMA_DIR, "media-build-report.v1.schema.json"),
    "媒体构建报告",
  );
  const outputPath = projectPath(projectRoot, build.output?.file || "", "built output");
  ensureFile(outputPath, "构建输出");
  if (
    build.protocol !== "visual-multimedia-media-build-report"
    || build.version !== 1
    || build.plan_sha256 !== sha256File(
      projectPath(projectRoot, build.plan, "build plan"),
    )
    || build.output.sha256 !== sha256File(outputPath)
  ) {
    throw new Error("构建报告没有绑定当前计划和真实成片");
  }
  const ffmpeg = commandPath("ffmpeg", options.ffmpeg, "FFMPEG_BIN");
  const ffprobe = commandPath("ffprobe", options.ffprobe, "FFPROBE_BIN");
  const probe = probeMedia(ffprobe, outputPath, true);
  const captionPath = projectPath(projectRoot, build.captions.file, "captions");
  ensureFile(captionPath, "字幕");
  if (sha256File(captionPath) !== build.captions.sha256) {
    throw new Error("字幕文件与构建报告不一致");
  }
  if (build.captions.mode === "burned-in") {
    const renderedCaptionPath = projectPath(
      projectRoot,
      build.captions.render_file || "",
      "burned-in captions",
    );
    ensureFile(renderedCaptionPath, "烧录字幕");
    if (sha256File(renderedCaptionPath) !== build.captions.render_sha256) {
      throw new Error("实际烧录字幕与构建报告不一致");
    }
  }
  const captions = parseSrtSummary(captionPath);
  const checks = {
    output_sha256_matches: build.output.sha256 === sha256File(outputPath),
    exact_frame_count: probe.frames === plan.total_frames,
    geometry:
      probe.width === plan.output.width && probe.height === plan.output.height,
    frame_rate: Math.abs(Number(probe.fps) - plan.output.fps) <= 0.001,
    audio:
      probe.has_audio
      && probe.audio_sample_rate === plan.output.audio_sample_rate
      && probe.audio_channels === plan.output.audio_channels,
    captions_within_program:
      captions.first_start_seconds >= 0
      && captions.last_end_seconds <= probe.duration_seconds + 0.05,
    caption_delivery:
      plan.output.caption_mode === "burned-in"
      || (plan.output.caption_mode === "embedded-track" && probe.has_subtitle)
      || (plan.output.caption_mode === "sidecar" && build.captions.visible_in_standalone_output === false),
  };
  const artifacts = makeReviewArtifacts(
    projectRoot,
    plan,
    outputPath,
    build.output.sha256,
    ffmpeg,
  );
  const blackLog = ffmpegAnalysis(ffmpeg, [
    "-i", outputPath,
    "-vf", "blackdetect=d=0.1:pic_th=0.98:pix_th=0.10",
    "-an", "-f", "null", "-",
  ]);
  const silenceLog = ffmpegAnalysis(ffmpeg, [
    "-i", outputPath,
    "-af", "silencedetect=noise=-50dB:d=0.5",
    "-vn", "-f", "null", "-",
  ]);
  const loudnessLog = ffmpegAnalysis(ffmpeg, [
    "-i", outputPath,
    "-af", `loudnorm=I=${plan.output.loudness.target_lufs}:`
      + `TP=${plan.output.loudness.true_peak_dbfs}:`
      + `LRA=${plan.output.loudness.lra}:print_format=json`,
    "-vn", "-f", "null", "-",
  ]);
  const machineStatus = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const machinePath = projectPath(
    projectRoot,
    options.machineReport || "reports/interview-explainer-machine-review.json",
    "machine review report",
  );
  const machine = {
    protocol: "visual-multimedia-interview-explainer-machine-review",
    version: 1,
    producer: {
      entry: "scripts/interview-explainer.mjs",
      entry_sha256: sha256File(path.join(SCRIPT_DIR, "interview-explainer.mjs")),
      module: "scripts/interview_explainer_review.mjs",
      module_sha256: sha256File(fileURLToPath(import.meta.url)),
      validator: "scripts/validate-media-review.mjs",
      validator_sha256: sha256File(path.join(SCRIPT_DIR, "validate-media-review.mjs")),
    },
    reviewed_media: {
      file: relativeProjectPath(projectRoot, outputPath),
      sha256: sha256File(outputPath),
    },
    plan: options.plan || "interview-explainer-plan.json",
    build_report: relativeProjectPath(projectRoot, buildPath),
    checks,
    probe: {
      duration_seconds: probe.duration_seconds,
      frames: probe.frames,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      audio_sample_rate: probe.audio_sample_rate,
      audio_channels: probe.audio_channels,
      has_subtitle: probe.has_subtitle,
    },
    captions,
    analysis: {
      blackdetect_log: blackLog,
      silencedetect_log: silenceLog,
      loudness_log: loudnessLog,
    },
    visual_artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([key, value]) => [
        key,
        relativeProjectPath(projectRoot, value),
      ]),
    ),
    status: machineStatus,
    completed_at: nowIso(),
  };
  writeJson(machinePath, machine);

  const agentStatus = options.agentStatus || "pending";
  if (!["pending", "passed", "changes-requested", "failed"].includes(agentStatus)) {
    throw new Error("agent-status 无效");
  }
  if (agentStatus !== "pending" && !(options.agentNotes || "").trim()) {
    throw new Error("记录 Agent 完整观看结论时必须提供 agent-notes");
  }
  const userRequired = options.userRequired === true;
  const userStatus = options.userStatus
    || (userRequired ? "pending" : "not-requested");
  if (!["not-requested", "pending", "approved", "rejected"].includes(userStatus)) {
    throw new Error("user-status 无效");
  }
  if (userStatus === "approved" && !(options.userEvidence || "").trim()) {
    throw new Error("用户确认通过必须提供 user-evidence");
  }
  const user = {
    required: userRequired,
    status: userStatus,
    confirmed_at: userStatus === "approved" || userStatus === "rejected"
      ? nowIso()
      : null,
    evidence: options.userEvidence || "",
  };
  const basisArtifacts = [
    {
      id: "production-plan",
      role: "production-plan",
      file: relativeProjectPath(projectRoot, planPath),
      sha256: sha256File(planPath),
    },
    {
      id: "plan-approval",
      role: "approval",
      file: relativeProjectPath(projectRoot, confirmationPath),
      sha256: sha256File(confirmationPath),
    },
    {
      id: "build-report",
      role: "build-report",
      file: relativeProjectPath(projectRoot, buildPath),
      sha256: sha256File(buildPath),
    },
    {
      id: "machine-report",
      role: "machine-report",
      file: relativeProjectPath(projectRoot, machinePath),
      sha256: sha256File(machinePath),
    },
  ];
  const promiseSpecs = [
    {
      id: "output-sha256",
      basis_artifact_id: "build-report",
      source_pointer: "/output/sha256",
      promise: "评审对象必须是构建报告声明的同一份成片。",
      expected_value: build.output.sha256,
      passed: checks.output_sha256_matches,
      actual: sha256File(outputPath),
      evidence: "成片文件 SHA-256 与 media-build-report.output.sha256 对照。",
      category: "technical",
    },
    {
      id: "exact-frame-count",
      basis_artifact_id: "production-plan",
      source_pointer: "/total_frames",
      promise: "成片必须保留计划声明的精确总帧数。",
      expected_value: plan.total_frames,
      passed: checks.exact_frame_count,
      actual: `${probe.frames} 帧`,
      evidence: "FFprobe 实际帧数与 interview-explainer-plan.total_frames 对照。",
      category: "technical",
    },
    {
      id: "output-width",
      basis_artifact_id: "production-plan",
      source_pointer: "/output/width",
      promise: "成片宽度必须与已确认计划一致。",
      expected_value: plan.output.width,
      passed: checks.geometry,
      actual: `${probe.width} px`,
      evidence: "FFprobe 视频流宽度。",
      category: "technical",
    },
    {
      id: "output-height",
      basis_artifact_id: "production-plan",
      source_pointer: "/output/height",
      promise: "成片高度必须与已确认计划一致。",
      expected_value: plan.output.height,
      passed: checks.geometry,
      actual: `${probe.height} px`,
      evidence: "FFprobe 视频流高度。",
      category: "technical",
    },
    {
      id: "frame-rate",
      basis_artifact_id: "production-plan",
      source_pointer: "/output/fps",
      promise: "成片帧率必须与已确认计划一致。",
      expected_value: plan.output.fps,
      passed: checks.frame_rate,
      actual: `${probe.fps} fps`,
      evidence: "FFprobe 视频流平均帧率。",
      category: "technical",
    },
    {
      id: "audio-sample-rate",
      basis_artifact_id: "production-plan",
      source_pointer: "/output/audio_sample_rate",
      promise: "成片音频采样率必须与已确认计划一致。",
      expected_value: plan.output.audio_sample_rate,
      passed: checks.audio,
      actual: `${probe.audio_sample_rate} Hz`,
      evidence: "FFprobe 音频流采样率。",
      category: "audio",
    },
    {
      id: "audio-channels",
      basis_artifact_id: "production-plan",
      source_pointer: "/output/audio_channels",
      promise: "成片音频声道数必须与已确认计划一致。",
      expected_value: plan.output.audio_channels,
      passed: checks.audio,
      actual: `${probe.audio_channels} 声道`,
      evidence: "FFprobe 音频流声道数。",
      category: "audio",
    },
    {
      id: "caption-timing",
      basis_artifact_id: "build-report",
      source_pointer: "/captions",
      promise: "构建报告声明的字幕必须全部位于成片时长内。",
      expected_value: build.captions,
      passed: checks.captions_within_program,
      actual: `${captions.first_start_seconds.toFixed(3)}s–${captions.last_end_seconds.toFixed(3)}s`,
      evidence: "解析真实 SRT 首尾时间码并与 FFprobe 时长对照。",
      category: "captions",
    },
    {
      id: "caption-delivery",
      basis_artifact_id: "production-plan",
      source_pointer: "/output/caption_mode",
      promise: "字幕交付方式必须与已确认计划一致。",
      expected_value: plan.output.caption_mode,
      passed: checks.caption_delivery,
      actual: build.captions.mode,
      evidence: "构建报告字幕方式与成片字幕流共同检查。",
      category: "captions",
    },
  ];
  const findings = promiseSpecs
    .filter((item) => !item.passed)
    .map((item) => ({
      id: `promise-${item.id}`,
      severity: "blocker",
      category: item.category,
      start_seconds: 0,
      end_seconds: probe.duration_seconds,
      start_frame: 0,
      end_frame: probe.frames,
      timeline_element_ids: [],
      evidence: `${item.promise} ${item.evidence} 实际结果：${item.actual}`,
      requested_change: {
        before: item.actual,
        after: item.promise,
        duration_seconds: null,
        easing: "",
        layer_order: [],
        invariants: ["未受该问题影响的内容、时序和声音保持不变。"],
        unaffected_ranges: [],
      },
      resolution: {
        status: "open",
        notes: "",
        verified_media_sha256: null,
      },
    }));
  if (agentStatus === "changes-requested" || agentStatus === "failed") {
    findings.push({
      id: "agent-full-program-review",
      severity: agentStatus === "failed" ? "blocker" : "major",
      category: "content",
      start_seconds: 0,
      end_seconds: probe.duration_seconds,
      start_frame: 0,
      end_frame: probe.frames,
      timeline_element_ids: [],
      evidence: options.agentNotes,
      requested_change: {
        before: "当前正式成片",
        after: options.agentNotes,
        duration_seconds: null,
        easing: "",
        layer_order: [],
        invariants: [],
        unaffected_ranges: [],
      },
      resolution: {
        status: "open",
        notes: "",
        verified_media_sha256: null,
      },
    });
  }
  const review = {
    protocol: "visual-multimedia-media-review",
    version: 3,
    project_state: null,
    review_basis: {
      created_at: nowIso(),
      basis_sha256: reviewBasisSha256(basisArtifacts),
      artifacts: basisArtifacts,
    },
    reviewed_media: {
      file: relativeProjectPath(projectRoot, outputPath),
      sha256: sha256File(outputPath),
      duration_seconds: probe.duration_seconds,
      frame_rate: probe.fps,
    },
    status: determineReviewStatus(machineStatus, agentStatus, user),
    machine_review: {
      status: machineStatus,
      report: relativeProjectPath(projectRoot, machinePath),
      report_sha256: sha256File(machinePath),
      completed_at: machine.completed_at,
      notes: machineStatus === "passed"
        ? "编码、精确帧数、音轨和字幕交付方式通过机器检查；不代表视觉效果通过。"
        : "至少一项机器检查失败。",
    },
    agent_review: {
      status: agentStatus,
      completed: agentStatus !== "pending",
      reviewed_at: agentStatus === "pending" ? null : nowIso(),
      method: agentStatus === "pending"
        ? ""
        : (options.agentMethod || "从头到尾播放正式成片并检查全部转场、字幕和声音"),
      notes: options.agentNotes || "",
    },
    user_confirmation: user,
    promise_checks: promiseSpecs.map((item) => ({
      id: item.id,
      basis_artifact_id: item.basis_artifact_id,
      source_pointer: item.source_pointer,
      promise: item.promise,
      expected_value: item.expected_value,
      status: item.passed ? "passed" : "failed",
      actual: item.actual,
      evidence: item.evidence,
      finding_id: item.passed ? null : `promise-${item.id}`,
    })),
    findings,
  };
  assertJsonSchema(
    review,
    path.join(SCHEMA_DIR, "media-review.v3.schema.json"),
    "媒体评审",
  );
  const reviewPath = projectPath(
    projectRoot,
    options.review || "media-review.json",
    "media review",
  );
  writeJson(reviewPath, review);
  const validation = validateMediaReview(reviewPath, {ffprobe});
  if (!validation.ok) {
    throw new Error(`媒体评审合同未通过：\n- ${validation.errors.join("\n- ")}`);
  }
  return {
    status: review.status,
    machine_status: machineStatus,
    review: reviewPath,
    machine_report: machinePath,
    output: outputPath,
    visual_artifacts: artifacts,
  };
}

function replaceDecision(decisions, decision) {
  return [...(decisions || []).filter((item) => item.id !== decision.id), decision];
}

export function finalizeInterviewExplainer(options) {
  const projectRoot = path.resolve(options.project);
  const {plan, planPath, confirmation, confirmationPath} = assertPlanAndConfirmation(
    projectRoot,
    options.plan || "interview-explainer-plan.json",
    options.confirmation || "interview-explainer-plan.confirmation.json",
  );
  const ffprobe = commandPath("ffprobe", options.ffprobe, "FFPROBE_BIN");
  const buildPath = projectPath(
    projectRoot,
    options.buildReport || "reports/media-build-report.json",
    "build report",
  );
  const reviewPath = projectPath(
    projectRoot,
    options.review || "media-review.json",
    "media review",
  );
  ensureFile(buildPath, "构建报告");
  ensureFile(reviewPath, "媒体评审");
  const build = readJson(buildPath);
  const review = readJson(reviewPath);
  assertJsonSchema(
    build,
    path.join(SCHEMA_DIR, "media-build-report.v1.schema.json"),
    "媒体构建报告",
  );
  assertJsonSchema(
    review,
    path.join(SCHEMA_DIR, "media-review.v3.schema.json"),
    "媒体评审",
  );
  const outputPath = projectPath(projectRoot, build.output?.file || "", "final output");
  if (
    build.output?.sha256 !== sha256File(outputPath)
    || review.reviewed_media?.sha256 !== build.output.sha256
    || review.status !== "passed"
    || review.machine_review?.status !== "passed"
    || review.agent_review?.status !== "passed"
    || review.agent_review?.completed !== true
    || (review.user_confirmation?.required && review.user_confirmation?.status !== "approved")
  ) {
    throw new Error("当前成片尚未通过同一哈希绑定的机器、Agent和所需用户确认");
  }
  const reviewValidation = validateMediaReview(reviewPath, {ffprobe});
  if (!reviewValidation.ok) {
    throw new Error(`评审合同未通过：\n- ${reviewValidation.errors.join("\n- ")}`);
  }
  const mediaSourcesPath = projectPath(
    projectRoot,
    plan.inputs.find((item) => item.role === "media-sources").file,
    "media sources",
  );
  const mediaSources = readJson(mediaSourcesPath);
  const byId = new Map(mediaSources.sources.map((source) => [source.id, source]));
  const adoptedIds = [...new Set(plan.sequence.flatMap((segment) => [
    segment.content.source_id,
    segment.content.audio_source_id,
  ]).filter(Boolean))];
  const pendingRights = adoptedIds.filter((id) => {
    const source = byId.get(id);
    return !source || !["confirmed", "not-required"].includes(source.rights?.status);
  });
  if (pendingRights.length) {
    throw new Error(`正式收口仍有素材权利未确认：${pendingRights.join(", ")}`);
  }

  const statePath = projectPath(
    projectRoot,
    options.state || "media-project-state.json",
    "project state",
  );
  const deliveryPath = projectPath(
    projectRoot,
    options.delivery || "media-delivery.json",
    "media delivery",
  );
  if (!fs.existsSync(statePath)) {
    throw new Error("采访项目缺少通用 media-project-state.json v3");
  }
  const stateValidation = validateProjectState(statePath);
  if (!stateValidation.ok) {
    throw new Error(`媒体项目状态未通过：\n- ${stateValidation.errors.join("\n- ")}`);
  }
  const state = readJson(statePath);
  state.project_id = plan.project_id;
  state.media_kind = "mixed-video";
  state.profile = "interview-explainer";
  state.contracts = {
    media_sources: relativeProjectPath(projectRoot, mediaSourcesPath),
    resource_adoptions: fs.existsSync(path.join(projectRoot, "media-resource-adoptions.json"))
      ? "media-resource-adoptions.json"
      : null,
    transcript: plan.inputs.find((item) => item.role === "transcript")?.file || null,
    clip_selections: plan.inputs.find((item) => item.role === "clip-selections")?.file || null,
    timeline: relativeProjectPath(projectRoot, planPath),
    style_profile: plan.inputs.find((item) => item.role === "draft")?.file || null,
    sound_profile: fs.existsSync(path.join(projectRoot, "sound-profile.json"))
      ? "sound-profile.json"
      : null,
    promotion_candidates: fs.existsSync(
      path.join(projectRoot, "resource-promotion-candidates.json"),
    )
      ? "resource-promotion-candidates.json"
      : null,
    review: relativeProjectPath(projectRoot, reviewPath),
    delivery: relativeProjectPath(projectRoot, deliveryPath),
  };
  state.blockers = [];
  for (const stageId of ["content", "direction", "integrated-sample", "full-preview"]) {
    assertStageApproved(state, stageId);
  }
  state.production_decisions = replaceDecision(state.production_decisions, {
    id: "interview-explainer-output-profile",
    category: "delivery",
    status: "active",
    decision:
      `交付 ${plan.output.width}x${plan.output.height}、${plan.output.fps} fps、`
      + `${plan.output.audio_sample_rate} Hz/${plan.output.audio_channels} 声道成片。`,
    rationale: "已确认的讲解计划和构建报告共同约束最终可观察输出。",
    applies_to: ["contracts.timeline", "contracts.delivery", "artifacts.final-video"],
    evidence_artifact_ids: ["interview-explainer-plan", "final-video"],
    decided_by: "user",
    decided_at: confirmation.confirmed_at,
    superseded_by: null,
  });
  state.production_decisions = replaceDecision(state.production_decisions, {
    id: "interview-explainer-caption-delivery",
    category: "delivery",
    status: "active",
    decision: `字幕按 ${plan.output.caption_mode} 方式交付。`,
    rationale: "字幕交付方式已经进入用户确认的计划，不能在渲染或收口阶段隐式改变。",
    applies_to: ["contracts.delivery", "artifacts.final-video"],
    evidence_artifact_ids: ["interview-explainer-plan", "final-video"],
    decided_by: "user",
    decided_at: confirmation.confirmed_at,
    superseded_by: null,
  });
  review.project_state = relativeProjectPath(projectRoot, statePath);
  assertJsonSchema(
    review,
    path.join(SCHEMA_DIR, "media-review.v3.schema.json"),
    "已收口媒体评审",
  );
  writeJson(reviewPath, review);
  const machineReport = readJson(
    projectPath(projectRoot, review.machine_review.report, "machine report"),
  );
  const delivery = {
    protocol: "visual-multimedia-delivery",
    version: 2,
    profile: "final",
    output: {file: relativeProjectPath(projectRoot, outputPath)},
    editability: {
      classification: "flat_render",
      project_file: null,
      project_file_sha256: null,
      limitations: [
        "最终 MP4 不能反向恢复独立原声卡、网页场景、旁白轨和逐段渲染参数；"
          + "继续编辑应使用项目内已哈希绑定的计划、网页包和素材合同。",
      ],
    },
    project_state: relativeProjectPath(projectRoot, statePath),
    media_sources: relativeProjectPath(projectRoot, mediaSourcesPath),
    transcript: state.contracts.transcript,
    clip_selections: state.contracts.clip_selections,
    media_review: relativeProjectPath(projectRoot, reviewPath),
    adopted_source_ids: adoptedIds,
    expected: {
      media_kind: "video",
      audio_required: true,
      duration_seconds: plan.duration_seconds,
      duration_tolerance_seconds: 0.08,
      width: plan.output.width,
      height: plan.output.height,
      frame_rate: plan.output.fps,
      frame_rate_tolerance: 0.001,
    },
    analysis: {
      loudness: {
        target_lufs: plan.output.loudness.target_lufs,
        tolerance_lu: 1.5,
        true_peak_ceiling_dbfs: plan.output.loudness.true_peak_dbfs,
      },
      silence: {
        noise_db: -50,
        minimum_duration_seconds: 0.5,
        maximum_unacknowledged_seconds: 1,
        allowed_ranges: [],
      },
      black_frames: {
        picture_black_ratio: 0.98,
        pixel_threshold: 0.1,
        minimum_duration_seconds: 0.1,
        maximum_unacknowledged_seconds: 0.1,
        allowed_ranges: [],
      },
    },
    evidence: {
      captions: {
        required: true,
        file: build.captions.file,
        font_status: plan.output.caption_mode === "sidecar" ? "not-applicable" : "verified",
      },
      contact_sheet: {
        file: machineReport.visual_artifacts.contactSheet,
        frames: 20,
        columns: 5,
      },
      rights_review: {
        status: "passed",
        notes: `正式采用的 ${adoptedIds.length} 项素材均为 confirmed 或 not-required。`,
      },
    },
    report: `reports/media-delivery-report.${build.output.sha256.slice(0, 12)}.json`,
  };
  writeJson(deliveryPath, delivery);
  let finalStage = state.stages.find((stage) => stage.id === "final-delivery");
  if (!finalStage) throw new Error("通用阶段模板缺少 final-delivery");
  if (finalStage.status !== "approved") {
    if (finalStage.status !== "waiting-approval") {
      submitStage(state, projectRoot, "final-delivery", [{
        id: "final-video",
        role: "final-delivery",
        kind: "video",
        file: relativeProjectPath(projectRoot, outputPath),
      }]);
      finalStage = state.stages.find((stage) => stage.id === "final-delivery");
    }
    writeJson(statePath, state);
    const pendingStateValidation = validateProjectState(statePath);
    if (!pendingStateValidation.ok) {
      throw new Error(
        `待确认的最终阶段状态未通过：\n- ${pendingStateValidation.errors.join("\n- ")}`,
      );
    }
    if (finalStage.status !== "approved") {
      return {
        status: "waiting-approval",
        output: outputPath,
        output_sha256: build.output.sha256,
        state: statePath,
        review: reviewPath,
        delivery: deliveryPath,
        next_action: pendingStateValidation.next_action,
      };
    }
  }
  const finalArtifact = state.artifacts.find(
    (artifact) => artifact.stage_id === "final-delivery" && artifact.role === "final-delivery",
  );
  if (!finalArtifact || finalArtifact.sha256 !== build.output.sha256) {
    throw new Error("最终阶段批准的成果不是当前构建报告绑定的成片");
  }
  writeJson(statePath, state);
  const finalizedStateValidation = validateProjectState(statePath);
  if (!finalizedStateValidation.ok) {
    throw new Error(
      `已收口媒体项目状态未通过：\n- ${finalizedStateValidation.errors.join("\n- ")}`,
    );
  }
  const finalizedReviewValidation = validateMediaReview(reviewPath, {ffprobe});
  if (!finalizedReviewValidation.ok) {
    throw new Error(
      `绑定项目状态后的评审合同未通过：\n- ${finalizedReviewValidation.errors.join("\n- ")}`,
    );
  }
  const verifier = path.join(SCRIPT_DIR, "verify-media-delivery.py");
  const python = commandPath("python", options.python, "PYTHON_BIN");
  run(python, [
    verifier,
    deliveryPath,
    "--ffprobe", ffprobe,
    "--require-delivery-ready",
  ]);
  return {
    status: "complete",
    output: outputPath,
    output_sha256: build.output.sha256,
    state: statePath,
    review: reviewPath,
    delivery: deliveryPath,
    delivery_report: projectPath(projectRoot, delivery.report, "delivery report"),
    plan_confirmation: confirmationPath,
  };
}
