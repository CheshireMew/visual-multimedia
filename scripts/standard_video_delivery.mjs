import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {assertJsonSchema} from "./json_schema_contract.mjs";
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
import {validateMediaBuildReport} from "./media_build_contract.mjs";
import {
  assertStageApproved,
  submitStage,
  validateProjectState,
} from "./media_project_state.mjs";
import {reviewBasisSha256, validateMediaReview} from "./validate-media-review.mjs";
import {validateMediaSources} from "./validate-media-sources.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const REVIEW_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-review.v3.schema.json");
const BUILD_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-build-report.v2.schema.json");
const DELIVERY_SCHEMA = path.join(SKILL_ROOT, "schemas", "media-delivery.v3.schema.json");

function pointerValue(document, pointer) {
  if (pointer === "") return document;
  return pointer.slice(1).split("/").reduce((current, encoded) => {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current == null || !Object.prototype.hasOwnProperty.call(current, key)) {
      throw new Error(`评审承诺指向不存在的位置：${pointer}`);
    }
    return current[key];
  }, document);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function loadState(projectRoot) {
  const statePath = path.join(projectRoot, "media-project-state.json");
  const validation = validateProjectState(statePath);
  if (!validation.ok) throw new Error(`媒体项目状态未通过：\n- ${validation.errors.join("\n- ")}`);
  return {statePath, state: readJson(statePath)};
}

function validateBuild(projectRoot, reportPath) {
  const report = readJson(reportPath);
  assertJsonSchema(validateMediaBuildReport(report), BUILD_SCHEMA, "媒体构建报告");
  const output = projectPath(projectRoot, report.output.file, "构建输出");
  ensureFile(output, "构建输出");
  if (sha256File(output) !== report.output.sha256) throw new Error("构建输出哈希已经失效");
  return {report, output};
}

export function reviewStandardVideo(options) {
  const projectRoot = path.resolve(options.project);
  const planPath = projectPath(projectRoot, options.plan, "production plan");
  const confirmationPath = projectPath(projectRoot, options.confirmation, "plan confirmation");
  const reportPath = projectPath(projectRoot, options.buildReport || "reports/media-build-report.json", "build report");
  const reviewPath = projectPath(projectRoot, options.review || "media-review.json", "media review");
  const machinePath = projectPath(projectRoot, options.machineReport || "reports/standard-video-machine-review.json", "machine report");
  ensureFile(planPath, "production plan");
  ensureFile(confirmationPath, "plan confirmation");
  const plan = readJson(planPath);
  const {report, output} = validateBuild(projectRoot, reportPath);
  const ffmpeg = commandPath("ffmpeg", options.ffmpeg, "FFMPEG_BIN");
  const ffprobe = commandPath("ffprobe", options.ffprobe, "FFPROBE_BIN");
  const python = commandPath("python", options.python, "PYTHON_BIN");
  const probe = probeMedia(ffprobe, output, true);
  if (
    probe.width !== report.output.width
    || probe.height !== report.output.height
    || Math.abs(probe.fps - report.output.fps) > 0.001
    || probe.frames !== report.output.frames
  ) throw new Error("真实成片与构建报告的尺寸、帧率或帧数不一致");
  const contactSheet = projectPath(projectRoot, options.contactSheet || "reports/standard-video-contact-sheet.jpg", "contact sheet");
  run(python, [
    path.join(SCRIPT_DIR, "make-video-contact-sheet.py"),
    output,
    contactSheet,
    "--frames", "12",
    "--cols", "4",
    "--ffmpeg", ffmpeg,
    "--ffprobe", ffprobe,
  ]);
  const machine = {
    protocol: "visual-multimedia-standard-video-machine-review",
    version: 1,
    completed_at: nowIso(),
    output: {file: relativeProjectPath(projectRoot, output), sha256: sha256File(output)},
    probe,
    contact_sheet: relativeProjectPath(projectRoot, contactSheet),
    checks: {dimensions: "passed", frame_rate: "passed", frame_count: "passed", readable_media: "passed"},
  };
  writeJson(machinePath, machine);
  const artifacts = [
    {id: "production-plan", role: "production-plan", file: relativeProjectPath(projectRoot, planPath), sha256: sha256File(planPath)},
    {id: "plan-approval", role: "approval", file: relativeProjectPath(projectRoot, confirmationPath), sha256: sha256File(confirmationPath)},
    {id: "build-report", role: "build-report", file: relativeProjectPath(projectRoot, reportPath), sha256: sha256File(reportPath)},
    {id: "machine-report", role: "machine-report", file: relativeProjectPath(projectRoot, machinePath), sha256: sha256File(machinePath)},
  ];
  const promises = (plan.review_promises || []).map((promise) => {
    const actual = pointerValue(plan, promise.source_pointer);
    const passed = canonical(actual) === canonical(promise.expected_value);
    return {
      id: promise.id,
      basis_artifact_id: "production-plan",
      source_pointer: promise.source_pointer,
      promise: promise.promise,
      expected_value: promise.expected_value,
      status: passed ? "passed" : "failed",
      actual: JSON.stringify(actual),
      evidence: passed ? "已从不可变生产计划重新读取并与承诺值逐项比较。" : "计划当前位置与承诺值不一致。",
      finding_id: null,
    };
  });
  if (!promises.length) {
    promises.push({
      id: "output-bound-to-build",
      basis_artifact_id: "build-report",
      source_pointer: "",
      promise: "实际成片必须与构建报告绑定同一文件哈希。",
      expected_value: report.output.sha256,
      status: "passed",
      actual: sha256File(output),
      evidence: "已重新计算实际成片 SHA-256。",
      finding_id: null,
    });
  }
  const agentStatus = options.agentStatus || "pending";
  const agentCompleted = agentStatus !== "pending" && options.agentCompleted === true;
  const userRequired = options.userRequired === true;
  const userStatus = userRequired ? (options.userStatus || "pending") : "not-requested";
  const passed = promises.every((item) => item.status === "passed")
    && agentStatus === "passed"
    && agentCompleted
    && (!userRequired || userStatus === "approved");
  const review = {
    protocol: "visual-multimedia-media-review",
    version: 3,
    project_state: "media-project-state.json",
    review_basis: {created_at: nowIso(), basis_sha256: reviewBasisSha256(artifacts), artifacts},
    reviewed_media: {
      file: relativeProjectPath(projectRoot, output),
      sha256: sha256File(output),
      duration_seconds: probe.duration_seconds,
      frame_rate: probe.fps,
    },
    status: passed ? "passed" : (agentStatus === "changes-requested" ? "changes-requested" : "pending"),
    machine_review: {
      status: "passed",
      report: relativeProjectPath(projectRoot, machinePath),
      report_sha256: sha256File(machinePath),
      completed_at: machine.completed_at,
      notes: "已读取真实成片、核对构建报告并生成联系表。",
    },
    agent_review: {
      status: agentStatus,
      completed: agentCompleted,
      reviewed_at: agentCompleted ? nowIso() : null,
      method: agentCompleted ? "完整播放同一成片并结合联系表检查" : "尚未完成",
      notes: options.agentEvidence || "",
    },
    user_confirmation: {
      required: userRequired,
      status: userStatus,
      confirmed_at: userStatus === "approved" ? nowIso() : null,
      evidence: options.userEvidence || "",
    },
    promise_checks: promises,
    findings: [],
  };
  assertJsonSchema(review, REVIEW_SCHEMA, "媒体评审");
  writeJson(reviewPath, review);
  const loadedState = loadState(projectRoot);
  loadedState.state.contracts.review = relativeProjectPath(projectRoot, reviewPath);
  writeJson(loadedState.statePath, loadedState.state);
  const stateValidation = validateProjectState(loadedState.statePath);
  if (!stateValidation.ok) {
    throw new Error(`绑定媒体评审后的项目状态未通过：\n- ${stateValidation.errors.join("\n- ")}`);
  }
  const validation = validateMediaReview(reviewPath, {ffprobe});
  if (!validation.ok) throw new Error(`媒体评审未通过合同检查：\n- ${validation.errors.join("\n- ")}`);
  return {status: review.status, review: reviewPath, machine_report: machinePath, contact_sheet: contactSheet};
}

export function finalizeStandardVideo(options) {
  const projectRoot = path.resolve(options.project);
  const planPath = projectPath(projectRoot, options.plan, "production plan");
  const confirmationPath = projectPath(projectRoot, options.confirmation, "plan confirmation");
  const reportPath = projectPath(projectRoot, options.buildReport || "reports/media-build-report.json", "build report");
  const reviewPath = projectPath(projectRoot, options.review || "media-review.json", "media review");
  const deliveryPath = projectPath(projectRoot, options.delivery || "media-delivery.json", "media delivery");
  const plan = readJson(planPath);
  const confirmation = readJson(confirmationPath);
  const {report, output} = validateBuild(projectRoot, reportPath);
  ensureFile(reviewPath, "media review");
  const review = readJson(reviewPath);
  assertJsonSchema(review, REVIEW_SCHEMA, "媒体评审");
  if (review.status !== "passed" || review.reviewed_media.sha256 !== report.output.sha256) {
    throw new Error("只有完整通过且绑定当前成片哈希的评审才能进入最终交付");
  }
  const ffprobe = commandPath("ffprobe", options.ffprobe, "FFPROBE_BIN");
  const python = commandPath("python", options.python, "PYTHON_BIN");
  const sourcesPath = path.join(projectRoot, "media-sources.json");
  const sourcesValidation = validateMediaSources(sourcesPath);
  if (!sourcesValidation.ok) throw new Error(`素材账本未通过：\n- ${sourcesValidation.errors.join("\n- ")}`);
  const {statePath, state} = loadState(projectRoot);
  assertStageApproved(state, "full-preview");
  const machine = readJson(projectPath(projectRoot, review.machine_review.report, "machine report"));
  const captionFile = report.captions.file || "";
  const delivery = {
    protocol: "visual-multimedia-delivery",
    version: 3,
    profile: "final",
    output: {file: relativeProjectPath(projectRoot, output)},
    production: {provider: "mediaflow", truth_kind: "flat-render", truth_files: [], render_receipt: null},
    editability: {
      classification: "flat_render",
      native_project: null,
      limitations: ["最终 MP4 不能反向恢复独立网页镜头与时间线；继续编辑应使用项目中的计划、素材账本和源包。"],
    },
    project_state: relativeProjectPath(projectRoot, statePath),
    media_sources: relativeProjectPath(projectRoot, sourcesPath),
    transcript: null,
    clip_selections: null,
    media_review: relativeProjectPath(projectRoot, reviewPath),
    adopted_source_ids: (readJson(sourcesPath).sources || []).map((item) => item.id),
    expected: {
      media_kind: "video",
      audio_required: options.audioRequired === true,
      duration_seconds: report.output.duration_seconds,
      duration_tolerance_seconds: 0.08,
      width: report.output.width,
      height: report.output.height,
      frame_rate: report.output.fps,
      frame_rate_tolerance: 0.001,
    },
    analysis: {
      loudness: {target_lufs: null, tolerance_lu: null, true_peak_ceiling_dbfs: null},
      silence: {noise_db: -50, minimum_duration_seconds: 0.5, maximum_unacknowledged_seconds: null, allowed_ranges: []},
      black_frames: {picture_black_ratio: 0.98, pixel_threshold: 0.1, minimum_duration_seconds: 0.1, maximum_unacknowledged_seconds: null, allowed_ranges: []},
    },
    evidence: {
      captions: {required: options.captionsRequired === true, file: captionFile, font_status: captionFile ? "verified" : "not-applicable"},
      contact_sheet: {file: machine.contact_sheet, frames: 12, columns: 4},
      rights_review: {status: "passed", notes: "素材账本已通过合同检查，正式采用项由当前项目记录。"},
    },
    report: `reports/media-delivery-report.${report.output.sha256.slice(0, 12)}.json`,
  };
  assertJsonSchema(delivery, DELIVERY_SCHEMA, "媒体交付");
  writeJson(deliveryPath, delivery);
  state.profile = options.profile;
  state.contracts.timeline = relativeProjectPath(projectRoot, planPath);
  state.contracts.review = relativeProjectPath(projectRoot, reviewPath);
  state.contracts.delivery = relativeProjectPath(projectRoot, deliveryPath);
  state.blockers = [];
  let finalStage = state.stages.find((item) => item.id === "final-delivery");
  if (finalStage.status !== "approved" && finalStage.status !== "waiting-approval") {
    submitStage(state, projectRoot, "final-delivery", [{
      id: `${options.profile.replaceAll("@", "-")}-final-video`,
      role: "final-delivery",
      kind: "video",
      file: relativeProjectPath(projectRoot, output),
    }]);
    finalStage = state.stages.find((item) => item.id === "final-delivery");
  }
  writeJson(statePath, state);
  const stateValidation = validateProjectState(statePath);
  if (!stateValidation.ok) throw new Error(`最终项目状态未通过：\n- ${stateValidation.errors.join("\n- ")}`);
  if (finalStage.status !== "approved") {
    return {status: "waiting-approval", delivery: deliveryPath, review: reviewPath, next_action: stateValidation.next_action};
  }
  const verifier = path.join(SCRIPT_DIR, "verify-media-delivery.py");
  run(python, [verifier, deliveryPath, "--ffprobe", ffprobe, "--require-delivery-ready"]);
  return {
    status: "complete",
    output,
    output_sha256: report.output.sha256,
    delivery: deliveryPath,
    review: reviewPath,
    plan_confirmation: confirmationPath,
    confirmed_at: confirmation.confirmed_at,
  };
}
