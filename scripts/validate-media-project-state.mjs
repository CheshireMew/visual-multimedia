#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateMediaSources } from "./validate-media-sources.mjs";
import {
  validateMediaResourceAdoptions,
  validateResourcePromotionCandidates,
} from "./media-resource-library.mjs";
import { validateSoundProductionProfile } from "./sound-production-profile.mjs";

const PROTOCOL = "visual-multimedia-media-project-state";
const VERSION = 2;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["in-progress", "waiting-approval", "blocked", "complete"]);
const CHECKPOINTS = new Set([
  "brief",
  "script",
  "style",
  "composition",
  "motion-sound",
  "assembly",
  "review",
  "delivery",
]);
const APPROVAL_SCOPES = new Set([
  "script",
  "style",
  "composition",
  "motion-sound",
]);
const APPROVAL_STATUSES = new Set(["pending", "approved", "rejected"]);
const ARTIFACT_KINDS = new Set([
  "script",
  "style-sample",
  "composition-sample",
  "motion-sound-sample",
  "timeline",
  "preview",
  "final",
]);
const DECISION_CATEGORIES = new Set([
  "content",
  "editorial",
  "visual",
  "motion",
  "audio",
  "technical",
  "delivery",
]);
const DECISION_STATUSES = new Set(["active", "superseded"]);
const DECISION_ACTORS = new Set(["user", "agent", "profile", "system"]);
const CONTRACT_KEYS = [
  "media_sources",
  "resource_adoptions",
  "transcript",
  "clip_selections",
  "timeline",
  "style_profile",
  "sound_profile",
  "promotion_candidates",
  "review",
  "delivery",
];
const ROOT_FIELDS = new Set([
  "protocol",
  "version",
  "project_id",
  "status",
  "current_checkpoint",
  "contracts",
  "creative_approvals",
  "production_decisions",
  "artifacts",
  "blockers",
  "next_action",
  "updated_at",
]);
const APPROVAL_FIELDS = new Set([
  "scope",
  "status",
  "artifact",
  "artifact_sha256",
  "recorded_at",
  "notes",
]);
const ARTIFACT_FIELDS = new Set(["id", "kind", "file", "sha256"]);
const PRODUCTION_DECISION_FIELDS = new Set([
  "id",
  "category",
  "status",
  "decision",
  "rationale",
  "applies_to",
  "evidence_artifact_ids",
  "decided_by",
  "decided_at",
  "superseded_by",
]);

function usage() {
  console.log(
    "用法：node scripts/validate-media-project-state.mjs"
      + " <media-project-state.json> [--json]\n"
      + "验证当前确认层、合同引用、样稿批准、制作决策、产物哈希、阻塞项和下一步。"
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

function projectPath(projectRoot, value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    addError(errors, label, "必须是非空项目相对路径");
    return null;
  }
  const absolute = path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    addError(errors, label, "不能离开项目目录");
    return null;
  }
  if (!fs.existsSync(absolute)) {
    addError(errors, label, `不存在：${absolute}`);
    return null;
  }
  return absolute;
}

export function validateMediaProjectState(statePath) {
  const absolutePath = path.resolve(statePath);
  const errors = [];
  let document;
  try {
    document = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      file: absolutePath,
      errors: [`${absolutePath}：无法读取 JSON（${error.message}）`],
    };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return {
      ok: false,
      file: absolutePath,
      errors: [`${absolutePath}：根节点必须是对象`],
    };
  }
  rejectUnknown(errors, document, ROOT_FIELDS, "root");
  if (document.protocol !== PROTOCOL) addError(errors, "protocol", `必须是 ${PROTOCOL}`);
  if (document.version !== VERSION) addError(errors, "version", `必须是 ${VERSION}`);
  if (!ID_PATTERN.test(document.project_id || "")) {
    addError(errors, "project_id", "格式不合法");
  }
  if (!STATUSES.has(document.status)) {
    addError(errors, "status", "不是允许的项目状态");
  }
  if (!CHECKPOINTS.has(document.current_checkpoint)) {
    addError(errors, "current_checkpoint", "不是允许的确认层");
  }
  const projectRoot = path.dirname(absolutePath);
  const contracts = document.contracts;
  const resolvedContracts = {};
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
    addError(errors, "contracts", "必须是对象");
  } else {
    rejectUnknown(errors, contracts, new Set(CONTRACT_KEYS), "contracts");
    for (const key of CONTRACT_KEYS) {
      const value = contracts[key];
      if (key === "media_sources") {
        const resolved = projectPath(projectRoot, value, `contracts.${key}`, errors);
        resolvedContracts[key] = resolved;
        if (resolved) {
          const validation = validateMediaSources(resolved);
          if (!validation.ok) {
            validation.errors.forEach((message) =>
              addError(errors, `contracts.${key}`, message)
            );
          }
        }
      } else if (value === null) {
        resolvedContracts[key] = null;
      } else {
        resolvedContracts[key] = projectPath(
          projectRoot,
          value,
          `contracts.${key}`,
          errors
        );
        if (
          resolvedContracts[key]
          && key !== "timeline"
          && !fs.statSync(resolvedContracts[key]).isFile()
        ) {
          addError(errors, `contracts.${key}`, "必须指向文件");
        }
      }
    }
  }
  if (resolvedContracts.resource_adoptions) {
    const validation = validateMediaResourceAdoptions(
      resolvedContracts.resource_adoptions,
      {
        projectId: document.project_id,
        mediaSourcesPath: resolvedContracts.media_sources,
      },
    );
    validation.errors.forEach((message) =>
      addError(errors, "contracts.resource_adoptions", message)
    );
  }
  if (resolvedContracts.sound_profile) {
    const validation = validateSoundProductionProfile(
      resolvedContracts.sound_profile,
      {
        projectId: document.project_id,
        mediaSourcesPath: resolvedContracts.media_sources,
      },
    );
    validation.errors.forEach((message) =>
      addError(errors, "contracts.sound_profile", message)
    );
  }
  if (resolvedContracts.promotion_candidates) {
    const validation = validateResourcePromotionCandidates(
      resolvedContracts.promotion_candidates,
      { projectId: document.project_id },
    );
    validation.errors.forEach((message) =>
      addError(errors, "contracts.promotion_candidates", message)
    );
  }
  const approvalScopes = new Set();
  if (!Array.isArray(document.creative_approvals)) {
    addError(errors, "creative_approvals", "必须是数组");
  } else {
    for (const [index, approval] of document.creative_approvals.entries()) {
      const location = `creative_approvals[${index}]`;
      if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
        addError(errors, location, "必须是对象");
        continue;
      }
      rejectUnknown(errors, approval, APPROVAL_FIELDS, location);
      if (!APPROVAL_SCOPES.has(approval.scope)) {
        addError(errors, `${location}.scope`, "不是允许的样稿层");
      } else if (approvalScopes.has(approval.scope)) {
        addError(errors, `${location}.scope`, "同一层只能保留一条活动确认");
      } else {
        approvalScopes.add(approval.scope);
      }
      if (!APPROVAL_STATUSES.has(approval.status)) {
        addError(errors, `${location}.status`, "不是允许的确认状态");
      }
      const artifact = projectPath(
        projectRoot,
        approval.artifact,
        `${location}.artifact`,
        errors
      );
      if (artifact && !fs.statSync(artifact).isFile()) {
        addError(errors, `${location}.artifact`, "必须指向文件");
      }
      if (!SHA256_PATTERN.test(approval.artifact_sha256 || "")) {
        addError(errors, `${location}.artifact_sha256`, "必须是小写 64 位 SHA-256");
      } else if (
        artifact
        && artifact === path.resolve(artifact)
        && fs.statSync(artifact).isFile()
        && sha256File(artifact) !== approval.artifact_sha256
      ) {
        addError(errors, `${location}.artifact_sha256`, "与当前样稿文件不一致");
      }
      if (
        approval.status === "pending"
        && approval.recorded_at !== null
      ) {
        addError(errors, `${location}.recorded_at`, "pending 必须为 null");
      }
      if (
        approval.status !== "pending"
        && !Number.isFinite(Date.parse(approval.recorded_at))
      ) {
        addError(errors, `${location}.recorded_at`, "批准或否定必须记录时间");
      }
      if (typeof approval.notes !== "string") {
        addError(errors, `${location}.notes`, "必须是字符串");
      }
    }
  }
  const artifactIds = new Set();
  if (!Array.isArray(document.artifacts)) {
    addError(errors, "artifacts", "必须是数组");
  } else {
    for (const [index, artifact] of document.artifacts.entries()) {
      const location = `artifacts[${index}]`;
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        addError(errors, location, "必须是对象");
        continue;
      }
      rejectUnknown(errors, artifact, ARTIFACT_FIELDS, location);
      if (!ID_PATTERN.test(artifact.id || "")) {
        addError(errors, `${location}.id`, "格式不合法");
      } else if (artifactIds.has(artifact.id)) {
        addError(errors, `${location}.id`, "id 重复");
      } else {
        artifactIds.add(artifact.id);
      }
      if (!ARTIFACT_KINDS.has(artifact.kind)) {
        addError(errors, `${location}.kind`, "不是允许的产物类型");
      }
      const file = projectPath(projectRoot, artifact.file, `${location}.file`, errors);
      if (file && !fs.statSync(file).isFile()) {
        addError(errors, `${location}.file`, "必须指向文件");
      }
      if (!SHA256_PATTERN.test(artifact.sha256 || "")) {
        addError(errors, `${location}.sha256`, "必须是小写 64 位 SHA-256");
      } else if (file && fs.statSync(file).isFile() && sha256File(file) !== artifact.sha256) {
        addError(errors, `${location}.sha256`, "与当前产物文件不一致");
      }
    }
  }
  const decisionsById = new Map();
  if (!Array.isArray(document.production_decisions)) {
    addError(errors, "production_decisions", "必须是数组");
  } else {
    for (const [index, decision] of document.production_decisions.entries()) {
      const location = `production_decisions[${index}]`;
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
        addError(errors, location, "必须是对象");
        continue;
      }
      rejectUnknown(errors, decision, PRODUCTION_DECISION_FIELDS, location);
      if (!ID_PATTERN.test(decision.id || "")) {
        addError(errors, `${location}.id`, "格式不合法");
      } else if (decisionsById.has(decision.id)) {
        addError(errors, `${location}.id`, "id 重复");
      } else {
        decisionsById.set(decision.id, decision);
      }
      if (!DECISION_CATEGORIES.has(decision.category)) {
        addError(errors, `${location}.category`, "不是允许的制作决策分类");
      }
      if (!DECISION_STATUSES.has(decision.status)) {
        addError(errors, `${location}.status`, "不是允许的制作决策状态");
      }
      for (const field of ["decision", "rationale"]) {
        if (typeof decision[field] !== "string" || decision[field].length === 0) {
          addError(errors, `${location}.${field}`, "必须是非空字符串");
        }
      }
      if (
        !Array.isArray(decision.applies_to)
        || decision.applies_to.length === 0
        || decision.applies_to.some(
          (item) => typeof item !== "string" || item.length === 0
        )
        || new Set(decision.applies_to).size !== decision.applies_to.length
      ) {
        addError(errors, `${location}.applies_to`, "必须是无重复的非空字符串数组");
      }
      if (
        !Array.isArray(decision.evidence_artifact_ids)
        || decision.evidence_artifact_ids.some(
          (item) => !ID_PATTERN.test(item) || !artifactIds.has(item)
        )
        || new Set(decision.evidence_artifact_ids).size
          !== decision.evidence_artifact_ids.length
      ) {
        addError(
          errors,
          `${location}.evidence_artifact_ids`,
          "只能引用当前 artifacts 中存在且不重复的 id"
        );
      }
      if (!DECISION_ACTORS.has(decision.decided_by)) {
        addError(errors, `${location}.decided_by`, "不是允许的决策主体");
      }
      if (!Number.isFinite(Date.parse(decision.decided_at))) {
        addError(errors, `${location}.decided_at`, "必须是 ISO 日期时间");
      }
      if (
        decision.superseded_by !== null
        && !ID_PATTERN.test(decision.superseded_by || "")
      ) {
        addError(errors, `${location}.superseded_by`, "必须是决策 id 或 null");
      }
      if (decision.status === "active" && decision.superseded_by !== null) {
        addError(errors, `${location}.superseded_by`, "active 决策必须为 null");
      }
      if (decision.status === "superseded" && decision.superseded_by === null) {
        addError(errors, `${location}.superseded_by`, "superseded 决策必须指向替代决策");
      }
    }
    for (const [decisionId, decision] of decisionsById.entries()) {
      if (decision.status !== "superseded") continue;
      const replacement = decisionsById.get(decision.superseded_by);
      if (!replacement) {
        addError(
          errors,
          `production_decisions.${decisionId}.superseded_by`,
          "替代决策不存在"
        );
        continue;
      }
      if (replacement.category !== decision.category) {
        addError(
          errors,
          `production_decisions.${decisionId}.superseded_by`,
          "替代决策必须属于同一分类"
        );
      }
      const visited = new Set([decisionId]);
      let cursor = replacement;
      while (cursor?.status === "superseded") {
        if (visited.has(cursor.id)) {
          addError(
            errors,
            `production_decisions.${decisionId}.superseded_by`,
            "制作决策替代链不能成环"
          );
          break;
        }
        visited.add(cursor.id);
        cursor = decisionsById.get(cursor.superseded_by);
      }
    }
  }
  if (
    !Array.isArray(document.blockers)
    || document.blockers.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    addError(errors, "blockers", "必须是非空字符串数组");
  }
  if (document.status === "blocked" && document.blockers?.length === 0) {
    addError(errors, "blockers", "blocked 状态必须说明阻塞项");
  }
  if (document.status !== "blocked" && document.blockers?.length > 0) {
    addError(errors, "blockers", "存在阻塞项时项目状态必须是 blocked");
  }
  if (
    document.status === "waiting-approval"
    && !document.creative_approvals?.some((item) => item.status === "pending")
  ) {
    addError(errors, "creative_approvals", "waiting-approval 必须存在 pending 确认层");
  }
  if (typeof document.next_action !== "string") {
    addError(errors, "next_action", "必须是字符串");
  }
  if (document.status !== "complete" && !document.next_action) {
    addError(errors, "next_action", "未完成项目必须说明下一步");
  }
  if (
    document.status === "complete"
    && (
      document.current_checkpoint !== "delivery"
      || contracts?.delivery === null
      || document.blockers?.length > 0
    )
  ) {
    addError(errors, "status", "complete 必须已经到 delivery、有交付合同且没有阻塞项");
  }
  if (!Number.isFinite(Date.parse(document.updated_at))) {
    addError(errors, "updated_at", "必须是 ISO 日期时间");
  }
  return {
    ok: errors.length === 0,
    file: absolutePath,
    project_id: document.project_id,
    status: document.status,
    current_checkpoint: document.current_checkpoint,
    contracts: resolvedContracts,
    errors,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    return args.length === 0 ? 1 : 0;
  }
  const file = args.find((value) => !value.startsWith("--"));
  const result = validateMediaProjectState(file);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `项目状态通过：${result.project_id}，${result.current_checkpoint}/${result.status}`
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
