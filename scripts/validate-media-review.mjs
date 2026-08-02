#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateMediaProjectState } from "./validate-media-project-state.mjs";

const PROTOCOL = "visual-multimedia-media-review";
const VERSION = 3;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["pending", "changes-requested", "passed", "failed"]);
const SEVERITIES = new Set(["blocker", "major", "minor", "polish"]);
const CATEGORIES = new Set([
  "content",
  "captions",
  "layout",
  "layering",
  "continuity",
  "motion",
  "audio",
  "sync",
  "rights",
  "technical",
]);
const ROOT_FIELDS = new Set([
  "protocol",
  "version",
  "project_state",
  "review_basis",
  "reviewed_media",
  "status",
  "machine_review",
  "agent_review",
  "user_confirmation",
  "promise_checks",
  "findings",
]);
const REVIEW_BASIS_FIELDS = new Set([
  "created_at",
  "basis_sha256",
  "artifacts",
]);
const BASIS_ARTIFACT_FIELDS = new Set(["id", "role", "file", "sha256"]);
const BASIS_ARTIFACT_ROLES = new Set([
  "production-plan",
  "approval",
  "build-report",
  "machine-report",
  "source-contract",
  "delivery-contract",
  "other",
]);
const REVIEWED_MEDIA_FIELDS = new Set([
  "file",
  "sha256",
  "duration_seconds",
  "frame_rate",
]);
const MACHINE_REVIEW_FIELDS = new Set([
  "status",
  "report",
  "report_sha256",
  "completed_at",
  "notes",
]);
const AGENT_REVIEW_FIELDS = new Set([
  "status",
  "completed",
  "reviewed_at",
  "method",
  "notes",
]);
const USER_CONFIRMATION_FIELDS = new Set([
  "required",
  "status",
  "confirmed_at",
  "evidence",
]);
const PROMISE_CHECK_FIELDS = new Set([
  "id",
  "basis_artifact_id",
  "source_pointer",
  "promise",
  "expected_value",
  "status",
  "actual",
  "evidence",
  "finding_id",
]);
const PROMISE_CHECK_STATUSES = new Set([
  "pending",
  "passed",
  "failed",
  "not-applicable",
]);
const FINDING_FIELDS = new Set([
  "id",
  "severity",
  "category",
  "start_seconds",
  "end_seconds",
  "start_frame",
  "end_frame",
  "timeline_element_ids",
  "evidence",
  "requested_change",
  "resolution",
]);
const REQUESTED_CHANGE_FIELDS = new Set([
  "before",
  "after",
  "duration_seconds",
  "easing",
  "layer_order",
  "invariants",
  "unaffected_ranges",
]);
const RANGE_FIELDS = new Set(["start_seconds", "end_seconds"]);
const RESOLUTION_FIELDS = new Set([
  "status",
  "notes",
  "verified_media_sha256",
]);

function usage() {
  console.log(
    "用法：node scripts/validate-media-review.mjs <media-review.json>"
      + " [--ffprobe <路径>] [--json]\n"
      + "验证评审绑定的真实媒体，以及机器、Agent 完整观看、用户确认和问题处理状态。"
  );
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(file);
  }
  return hash.digest("hex");
}

export function reviewBasisSha256(artifacts) {
  const lines = [...artifacts]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((item) => [item.id, item.role, item.file, item.sha256].join("\0"));
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])])
  );
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function resolveJsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error("必须是 JSON Pointer");
  }
  let current = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      current === null
      || typeof current !== "object"
      || !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      throw new Error(`找不到 ${pointer}`);
    }
    current = current[key];
  }
  return current;
}

function commandPath(override) {
  if (override) {
    const absolute = path.resolve(override);
    if (!fs.existsSync(absolute)) throw new Error(`ffprobe 不存在：${absolute}`);
    return absolute;
  }
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["ffprobe"],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error("找不到 ffprobe；评审必须绑定真实媒体，脚本不会自动安装。");
  }
  return result.stdout.split(/\r?\n/).find(Boolean).trim();
}

function rate(value) {
  const [numerator, denominator = "1"] = String(value || "").split("/");
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function probeMedia(ffprobe, filePath) {
  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", filePath],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "FFprobe 失败").trim());
  }
  const payload = JSON.parse(result.stdout);
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const duration = Number(payload?.format?.duration ?? video?.duration);
  return {
    duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    frame_rate: video
      ? rate(video.avg_frame_rate) ?? rate(video.r_frame_rate)
      : null,
  };
}

function addError(errors, location, message) {
  errors.push(`${location}：${message}`);
}

function rejectUnknown(errors, value, allowed, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      addError(errors, `${location}.${key}`, "不是当前合同字段；不接受旧版兼容字段");
    }
  }
}

export function validateMediaReview(reviewPath, options = {}) {
  const absolutePath = path.resolve(reviewPath);
  const errors = [];
  let document;
  try {
    document = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      file: absolutePath,
      findings: [],
      errors: [`${absolutePath}：无法读取 JSON（${error.message}）`],
    };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return {
      ok: false,
      file: absolutePath,
      findings: [],
      errors: [`${absolutePath}：根节点必须是对象`],
    };
  }
  rejectUnknown(errors, document, ROOT_FIELDS, "root");
  if (document.protocol !== PROTOCOL) addError(errors, "protocol", `必须是 ${PROTOCOL}`);
  if (document.version !== VERSION) addError(errors, "version", `必须是 ${VERSION}`);
  const projectRoot = path.dirname(absolutePath);
  const basisArtifacts = new Map();
  const basisDocuments = new Map();
  const reviewBasis = document.review_basis;
  if (!reviewBasis || typeof reviewBasis !== "object" || Array.isArray(reviewBasis)) {
    addError(errors, "review_basis", "必须是对象");
  } else {
    rejectUnknown(errors, reviewBasis, REVIEW_BASIS_FIELDS, "review_basis");
    if (!Number.isFinite(Date.parse(reviewBasis.created_at))) {
      addError(errors, "review_basis.created_at", "必须是 ISO 日期时间");
    }
    if (!Array.isArray(reviewBasis.artifacts) || reviewBasis.artifacts.length === 0) {
      addError(errors, "review_basis.artifacts", "必须至少绑定一个制作依据");
    } else {
      for (const [index, artifact] of reviewBasis.artifacts.entries()) {
        const location = `review_basis.artifacts[${index}]`;
        if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
          addError(errors, location, "必须是对象");
          continue;
        }
        rejectUnknown(errors, artifact, BASIS_ARTIFACT_FIELDS, location);
        if (!ID_PATTERN.test(artifact.id || "")) {
          addError(errors, `${location}.id`, "格式不合法");
        } else if (basisArtifacts.has(artifact.id)) {
          addError(errors, `${location}.id`, "id 重复");
        }
        if (!BASIS_ARTIFACT_ROLES.has(artifact.role)) {
          addError(errors, `${location}.role`, "不是允许的制作依据角色");
        }
        const basisPath = path.resolve(projectRoot, artifact.file || "");
        const relative = path.relative(projectRoot, basisPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          addError(errors, `${location}.file`, "不能离开项目目录");
        } else if (!fs.existsSync(basisPath) || !fs.statSync(basisPath).isFile()) {
          addError(errors, `${location}.file`, `文件不存在：${basisPath}`);
        } else if (
          !SHA256_PATTERN.test(artifact.sha256 || "")
          || sha256File(basisPath) !== artifact.sha256
        ) {
          addError(errors, `${location}.sha256`, "与当前制作依据文件不一致");
        } else {
          try {
            basisDocuments.set(
              artifact.id,
              JSON.parse(fs.readFileSync(basisPath, "utf8"))
            );
          } catch {
            basisDocuments.set(artifact.id, null);
          }
        }
        if (ID_PATTERN.test(artifact.id || "") && !basisArtifacts.has(artifact.id)) {
          basisArtifacts.set(artifact.id, {...artifact, absolute_path: basisPath});
        }
      }
      if (
        !SHA256_PATTERN.test(reviewBasis.basis_sha256 || "")
        || reviewBasisSha256(reviewBasis.artifacts) !== reviewBasis.basis_sha256
      ) {
        addError(
          errors,
          "review_basis.basis_sha256",
          "与当前不可变制作依据清单不一致"
        );
      }
    }
  }
  let statePath = null;
  if (document.project_state !== null) {
    if (
      typeof document.project_state !== "string"
      || document.project_state.length === 0
    ) {
      addError(errors, "project_state", "必须是非空项目相对路径或 null");
    } else {
      statePath = path.resolve(projectRoot, document.project_state);
      const stateRelative = path.relative(projectRoot, statePath);
      if (stateRelative.startsWith("..") || path.isAbsolute(stateRelative)) {
        addError(errors, "project_state", "不能离开项目目录");
      } else {
        const stateValidation = validateMediaProjectState(statePath);
        if (!stateValidation.ok) {
          stateValidation.errors.forEach((message) =>
            addError(errors, "project_state", message)
          );
        } else if (
          !stateValidation.contracts.review
          || path.resolve(stateValidation.contracts.review) !== absolutePath
        ) {
          addError(
            errors,
            "project_state",
            "没有把当前 media-review.json 作为活动评审合同"
          );
        }
      }
    }
  }
  const reviewed = document.reviewed_media;
  let actualProbe = { duration_seconds: null, frame_rate: null };
  let mediaPath = null;
  if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) {
    addError(errors, "reviewed_media", "必须是对象");
  } else {
    rejectUnknown(errors, reviewed, REVIEWED_MEDIA_FIELDS, "reviewed_media");
    mediaPath = path.resolve(projectRoot, reviewed.file || "");
    const relative = path.relative(projectRoot, mediaPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      addError(errors, "reviewed_media.file", "不能离开项目目录");
    } else if (!fs.existsSync(mediaPath) || !fs.statSync(mediaPath).isFile()) {
      addError(errors, "reviewed_media.file", `文件不存在：${mediaPath}`);
    } else {
      if (
        !SHA256_PATTERN.test(reviewed.sha256 || "")
        || sha256File(mediaPath) !== reviewed.sha256
      ) {
        addError(errors, "reviewed_media.sha256", "与当前评审媒体不一致");
      }
      try {
        actualProbe = probeMedia(commandPath(options.ffprobe), mediaPath);
      } catch (error) {
        addError(errors, "reviewed_media", error.message);
      }
    }
    if (
      actualProbe.duration_seconds !== null
      && (
        !Number.isFinite(reviewed.duration_seconds)
        || Math.abs(reviewed.duration_seconds - actualProbe.duration_seconds) > 0.03
      )
    ) {
      addError(errors, "reviewed_media.duration_seconds", "与真实媒体时长不一致");
    }
    if (
      actualProbe.frame_rate !== null
      && (
        !Number.isFinite(reviewed.frame_rate)
        || Math.abs(reviewed.frame_rate - actualProbe.frame_rate) > 0.02
      )
    ) {
      addError(errors, "reviewed_media.frame_rate", "与真实媒体帧率不一致");
    }
  }
  if (!STATUSES.has(document.status)) {
    addError(errors, "status", "不是允许的评审状态");
  }
  const machineReview = document.machine_review;
  let machineReportPath = null;
  if (
    !machineReview
    || typeof machineReview !== "object"
    || Array.isArray(machineReview)
  ) {
    addError(errors, "machine_review", "必须是对象");
  } else {
    rejectUnknown(errors, machineReview, MACHINE_REVIEW_FIELDS, "machine_review");
    if (!["pending", "passed", "failed"].includes(machineReview.status)) {
      addError(errors, "machine_review.status", "状态无效");
    }
    if (typeof machineReview.report !== "string" || !machineReview.report) {
      addError(errors, "machine_review.report", "必须是非空项目相对路径");
    } else {
      machineReportPath = path.resolve(projectRoot, machineReview.report);
      const relative = path.relative(projectRoot, machineReportPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        addError(errors, "machine_review.report", "不能离开项目目录");
      } else if (
        machineReview.status !== "pending"
        && (!fs.existsSync(machineReportPath) || !fs.statSync(machineReportPath).isFile())
      ) {
        addError(errors, "machine_review.report", `文件不存在：${machineReportPath}`);
      } else if (
        machineReview.status !== "pending"
        && (
          !SHA256_PATTERN.test(machineReview.report_sha256 || "")
          || sha256File(machineReportPath) !== machineReview.report_sha256
        )
      ) {
        addError(errors, "machine_review.report_sha256", "与真实机器报告不一致");
      }
    }
    if (
      machineReview.completed_at !== null
      && !Number.isFinite(Date.parse(machineReview.completed_at))
    ) {
      addError(errors, "machine_review.completed_at", "必须是 ISO 日期时间或 null");
    }
    if (
      machineReview.status !== "pending"
      && machineReview.completed_at === null
    ) {
      addError(errors, "machine_review.completed_at", "完成机器检查必须记录时间");
    }
    if (typeof machineReview.notes !== "string") {
      addError(errors, "machine_review.notes", "必须是字符串");
    }
    if (machineReview.status !== "pending") {
      const boundMachineReport = [...basisArtifacts.values()].find(
        (item) => item.role === "machine-report"
          && item.absolute_path === machineReportPath
          && item.sha256 === machineReview.report_sha256
      );
      if (!boundMachineReport) {
        addError(
          errors,
          "machine_review",
          "完成的机器报告必须以同一路径和哈希进入 review_basis"
        );
      }
    }
  }
  const agentReview = document.agent_review;
  if (!agentReview || typeof agentReview !== "object" || Array.isArray(agentReview)) {
    addError(errors, "agent_review", "必须是对象");
  } else {
    rejectUnknown(errors, agentReview, AGENT_REVIEW_FIELDS, "agent_review");
    if (!["pending", "passed", "changes-requested", "failed"].includes(agentReview.status)) {
      addError(errors, "agent_review.status", "状态无效");
    }
    if (typeof agentReview.completed !== "boolean") {
      addError(errors, "agent_review.completed", "必须是布尔值");
    }
    if (
      agentReview.reviewed_at !== null
      && !Number.isFinite(Date.parse(agentReview.reviewed_at))
    ) {
      addError(errors, "agent_review.reviewed_at", "必须是 ISO 日期时间或 null");
    }
    if (agentReview.completed === true && agentReview.reviewed_at === null) {
      addError(errors, "agent_review.reviewed_at", "完成 Agent 全片观看必须记录时间");
    }
    if (agentReview.status !== "pending" && agentReview.completed !== true) {
      addError(errors, "agent_review.completed", "非 pending 状态必须完成全片观看");
    }
    if (typeof agentReview.method !== "string") {
      addError(errors, "agent_review.method", "必须是字符串");
    }
    if (typeof agentReview.notes !== "string") {
      addError(errors, "agent_review.notes", "必须是字符串");
    }
  }
  const userConfirmation = document.user_confirmation;
  if (
    !userConfirmation
    || typeof userConfirmation !== "object"
    || Array.isArray(userConfirmation)
  ) {
    addError(errors, "user_confirmation", "必须是对象");
  } else {
    rejectUnknown(
      errors,
      userConfirmation,
      USER_CONFIRMATION_FIELDS,
      "user_confirmation"
    );
    if (typeof userConfirmation.required !== "boolean") {
      addError(errors, "user_confirmation.required", "必须是布尔值");
    }
    if (!["not-requested", "pending", "approved", "rejected"].includes(
      userConfirmation.status
    )) {
      addError(errors, "user_confirmation.status", "状态无效");
    }
    if (
      userConfirmation.confirmed_at !== null
      && !Number.isFinite(Date.parse(userConfirmation.confirmed_at))
    ) {
      addError(errors, "user_confirmation.confirmed_at", "必须是 ISO 日期时间或 null");
    }
    if (
      userConfirmation.status === "approved"
      && (
        userConfirmation.confirmed_at === null
        || typeof userConfirmation.evidence !== "string"
        || userConfirmation.evidence.length === 0
      )
    ) {
      addError(errors, "user_confirmation", "approved 必须记录时间和证据");
    }
    if (
      userConfirmation.required === true
      && userConfirmation.status === "not-requested"
    ) {
      addError(errors, "user_confirmation.status", "需要用户确认时不能标记 not-requested");
    }
  }
  const promiseChecks = [];
  const promiseCheckIds = new Set();
  if (!Array.isArray(document.promise_checks) || document.promise_checks.length === 0) {
    addError(errors, "promise_checks", "必须至少核对一项已承诺结果");
  } else {
    for (const [index, check] of document.promise_checks.entries()) {
      const location = `promise_checks[${index}]`;
      if (!check || typeof check !== "object" || Array.isArray(check)) {
        addError(errors, location, "必须是对象");
        continue;
      }
      rejectUnknown(errors, check, PROMISE_CHECK_FIELDS, location);
      if (!ID_PATTERN.test(check.id || "")) {
        addError(errors, `${location}.id`, "格式不合法");
      } else if (promiseCheckIds.has(check.id)) {
        addError(errors, `${location}.id`, "id 重复");
      } else {
        promiseCheckIds.add(check.id);
      }
      const basisArtifact = basisArtifacts.get(check.basis_artifact_id);
      if (!basisArtifact) {
        addError(errors, `${location}.basis_artifact_id`, "没有对应的 review_basis 依据");
      } else {
        const basisDocument = basisDocuments.get(check.basis_artifact_id);
        if (basisDocument === null || basisDocument === undefined) {
          addError(errors, `${location}.basis_artifact_id`, "承诺来源必须是 JSON 文件");
        } else {
          try {
            const promisedValue = resolveJsonPointer(
              basisDocument,
              check.source_pointer
            );
            if (!Object.prototype.hasOwnProperty.call(check, "expected_value")) {
              addError(errors, `${location}.expected_value`, "必须复制承诺来源的准确值");
            } else if (!sameJson(promisedValue, check.expected_value)) {
              addError(
                errors,
                `${location}.expected_value`,
                "与不可变依据中的 source_pointer 当前值不一致"
              );
            }
          } catch (error) {
            addError(errors, `${location}.source_pointer`, error.message);
          }
        }
      }
      if (typeof check.promise !== "string" || check.promise.length === 0) {
        addError(errors, `${location}.promise`, "必须说明被核对的承诺");
      }
      if (!PROMISE_CHECK_STATUSES.has(check.status)) {
        addError(errors, `${location}.status`, "不是允许的承诺检查状态");
      }
      if (typeof check.actual !== "string") {
        addError(errors, `${location}.actual`, "必须是字符串");
      }
      if (typeof check.evidence !== "string") {
        addError(errors, `${location}.evidence`, "必须是字符串");
      }
      if (
        check.status !== "pending"
        && (!(check.actual || "").trim() || !(check.evidence || "").trim())
      ) {
        addError(errors, location, "完成的承诺检查必须记录实际结果和证据");
      }
      if (
        check.finding_id !== null
        && !ID_PATTERN.test(check.finding_id || "")
      ) {
        addError(errors, `${location}.finding_id`, "必须是 finding id 或 null");
      }
      if (
        ["passed", "not-applicable", "pending"].includes(check.status)
        && check.finding_id !== null
      ) {
        addError(errors, `${location}.finding_id`, "只有 failed 承诺检查可以关联问题");
      }
      if (check.status === "failed" && check.finding_id === null) {
        addError(errors, `${location}.finding_id`, "failed 必须关联可处理的问题");
      }
      promiseChecks.push({
        id: check.id,
        status: check.status,
        finding_id: check.finding_id,
      });
    }
  }
  if (!Array.isArray(document.findings)) {
    addError(errors, "findings", "必须是数组");
  }
  const findingIds = new Set();
  const findings = [];
  for (const [index, finding] of (document.findings || []).entries()) {
    const location = `findings[${index}]`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      addError(errors, location, "必须是对象");
      continue;
    }
    rejectUnknown(errors, finding, FINDING_FIELDS, location);
    if (!ID_PATTERN.test(finding.id || "")) {
      addError(errors, `${location}.id`, "格式不合法");
    } else if (findingIds.has(finding.id)) {
      addError(errors, `${location}.id`, "id 重复");
    } else {
      findingIds.add(finding.id);
    }
    if (!SEVERITIES.has(finding.severity)) {
      addError(errors, `${location}.severity`, "不是允许的严重度");
    }
    if (!CATEGORIES.has(finding.category)) {
      addError(errors, `${location}.category`, "不是允许的分类");
    }
    const start = Number(finding.start_seconds);
    const end = Number(finding.end_seconds);
    if (!Number.isFinite(start) || start < 0) {
      addError(errors, `${location}.start_seconds`, "必须大于或等于 0");
    }
    if (!Number.isFinite(end) || end <= start) {
      addError(errors, `${location}.end_seconds`, "必须大于 start_seconds");
    }
    if (
      actualProbe.duration_seconds !== null
      && end > actualProbe.duration_seconds + 0.03
    ) {
      addError(errors, `${location}.end_seconds`, "超过评审媒体真实时长");
    }
    const frameRate = actualProbe.frame_rate;
    for (const [field, seconds, round] of [
      ["start_frame", start, Math.floor],
      ["end_frame", end, Math.ceil],
    ]) {
      const value = finding[field];
      if (value !== null) {
        if (!Number.isInteger(value) || value < 0 || frameRate === null) {
          addError(errors, `${location}.${field}`, "必须是非负整数或 null");
        } else if (Math.abs(value - round(seconds * frameRate)) > 1) {
          addError(
            errors,
            `${location}.${field}`,
            "与权威秒数和当前帧率不一致；帧号只能作为派生定位"
          );
        }
      }
    }
    if (
      !Array.isArray(finding.timeline_element_ids)
      || finding.timeline_element_ids.some(
        (item) => typeof item !== "string" || item.length === 0
      )
    ) {
      addError(errors, `${location}.timeline_element_ids`, "必须是字符串数组");
    }
    if (typeof finding.evidence !== "string" || finding.evidence.length === 0) {
      addError(errors, `${location}.evidence`, "必须记录可核对证据");
    }
    const change = finding.requested_change;
    if (change !== null) {
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        addError(errors, `${location}.requested_change`, "必须是对象或 null");
      } else {
        rejectUnknown(
          errors,
          change,
          REQUESTED_CHANGE_FIELDS,
          `${location}.requested_change`
        );
        if (typeof change.before !== "string") {
          addError(errors, `${location}.requested_change.before`, "必须是字符串");
        }
        if (typeof change.after !== "string" || change.after.length === 0) {
          addError(errors, `${location}.requested_change.after`, "必须说明目标状态");
        }
        if (typeof change.easing !== "string") {
          addError(errors, `${location}.requested_change.easing`, "必须是字符串");
        }
        if (
          change.duration_seconds !== null
          && (!Number.isFinite(change.duration_seconds) || change.duration_seconds < 0)
        ) {
          addError(
            errors,
            `${location}.requested_change.duration_seconds`,
            "必须是非负数或 null"
          );
        }
        for (const field of ["layer_order", "invariants", "unaffected_ranges"]) {
          if (!Array.isArray(change[field])) {
            addError(errors, `${location}.requested_change.${field}`, "必须是数组");
          }
        }
        for (const field of ["layer_order", "invariants"]) {
          if (
            Array.isArray(change[field])
            && change[field].some(
              (item) => typeof item !== "string" || item.length === 0
            )
          ) {
            addError(
              errors,
              `${location}.requested_change.${field}`,
              "只能包含非空字符串"
            );
          }
        }
        for (const [rangeIndex, range] of (change.unaffected_ranges || []).entries()) {
          rejectUnknown(
            errors,
            range,
            RANGE_FIELDS,
            `${location}.requested_change.unaffected_ranges[${rangeIndex}]`
          );
          if (
            !Number.isFinite(range?.start_seconds)
            || !Number.isFinite(range?.end_seconds)
            || range.start_seconds < 0
            || range.end_seconds <= range.start_seconds
          ) {
            addError(
              errors,
              `${location}.requested_change.unaffected_ranges[${rangeIndex}]`,
              "必须是有效秒数范围"
            );
          }
        }
      }
    }
    const resolution = finding.resolution;
    if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
      addError(errors, `${location}.resolution`, "必须是对象");
    } else {
      rejectUnknown(errors, resolution, RESOLUTION_FIELDS, `${location}.resolution`);
      if (!["open", "fixed", "accepted"].includes(resolution.status)) {
        addError(errors, `${location}.resolution.status`, "状态无效");
      }
      if (typeof resolution.notes !== "string") {
        addError(errors, `${location}.resolution.notes`, "必须是字符串");
      }
      if (
        resolution.status === "fixed"
        && (
          !SHA256_PATTERN.test(resolution.verified_media_sha256 || "")
          || resolution.verified_media_sha256 !== reviewed?.sha256
        )
      ) {
        addError(
          errors,
          `${location}.resolution.verified_media_sha256`,
          "fixed 必须绑定当前复查媒体哈希"
        );
      }
      if (
        resolution.status === "accepted"
        && resolution.verified_media_sha256 !== null
      ) {
        addError(
          errors,
          `${location}.resolution.verified_media_sha256`,
          "accepted 不需要伪装成已经修复"
        );
      }
    }
    findings.push({
      id: finding.id,
      severity: finding.severity,
      start_seconds: start,
      end_seconds: end,
      resolution_status: resolution?.status || null,
    });
  }
  for (const check of promiseChecks) {
    if (check.status === "failed" && !findingIds.has(check.finding_id)) {
      addError(
        errors,
        `promise_checks.${check.id}.finding_id`,
        "关联的问题不存在"
      );
    }
  }
  const openFindings = findings.filter((item) => item.resolution_status === "open");
  const incompletePromises = promiseChecks.filter(
    (item) => !["passed", "not-applicable"].includes(item.status)
  );
  if (
    document.status === "passed"
    && (
      machineReview?.status !== "passed"
      || agentReview?.status !== "passed"
      || agentReview?.completed !== true
      || (
        userConfirmation?.required === true
        && userConfirmation?.status !== "approved"
      )
      || promiseChecks.length === 0
      || incompletePromises.length > 0
      || openFindings.length > 0
    )
  ) {
    addError(
      errors,
      "status",
      "passed 必须通过全部承诺检查、机器检查、Agent 全片观看、所需用户确认且没有未处理问题"
    );
  }
  if (
    document.status === "changes-requested"
    && openFindings.length === 0
  ) {
    addError(errors, "status", "changes-requested 必须存在 open 问题");
  }
  if (
    document.status === "pending"
    && (
      machineReview?.status === "failed"
      || agentReview?.status === "failed"
      || userConfirmation?.status === "rejected"
      || promiseChecks.some((item) => item.status === "failed")
    )
  ) {
    addError(errors, "status", "存在失败或拒绝状态时不能继续标记 pending");
  }
  return {
    ok: errors.length === 0,
    file: absolutePath,
    project_state: statePath,
    reviewed_media: mediaPath,
    reviewed_media_sha256: reviewed?.sha256 || null,
    review_basis_sha256: reviewBasis?.basis_sha256 || null,
    status: document.status,
    machine_review_passed: machineReview?.status === "passed",
    agent_review_completed: agentReview?.completed === true,
    agent_review_passed: agentReview?.status === "passed",
    user_confirmation_required: userConfirmation?.required === true,
    user_confirmation_passed: userConfirmation?.status === "approved",
    promise_checks: promiseChecks,
    incomplete_promise_checks: incompletePromises,
    findings,
    open_findings: openFindings,
    errors,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const ffprobeIndex = argv.indexOf("--ffprobe");
  const ffprobe = ffprobeIndex >= 0 ? argv[ffprobeIndex + 1] : null;
  const file = argv.find(
    (value, index) => !value.startsWith("--")
      && (ffprobeIndex < 0 || index !== ffprobeIndex + 1)
  );
  const result = validateMediaReview(file, { ffprobe });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `媒体评审通过：状态=${result.status}，问题=${result.findings.length}，`
        + `未处理=${result.open_findings.length}`
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
