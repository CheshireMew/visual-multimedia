import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {validateJsonSchema} from "./json_schema_contract.mjs";
import {validateMediaSources} from "./validate-media-sources.mjs";
import {
  validateMediaResourceAdoptions,
  validateResourcePromotionCandidates,
} from "./media-resource-library.mjs";
import {validateSoundProductionProfile} from "./sound-production-profile.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
export const PROJECT_STATE_SCHEMA = path.join(
  SKILL_ROOT,
  "schemas",
  "media-project-state.v3.schema.json",
);
export const STAGE_TEMPLATE_SCHEMA = path.join(
  SKILL_ROOT,
  "schemas",
  "media-stage-template.v1.schema.json",
);
export const DEFAULT_STAGE_TEMPLATE = path.join(
  SKILL_ROOT,
  "assets",
  "media-stage-templates",
  "time-media-production.v1.json",
);

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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function nowIso() {
  return new Date().toISOString();
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function relativeProjectPath(projectRoot, value, label) {
  const absolute = path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于项目目录内：${absolute}`);
  }
  return relative.split(path.sep).join("/");
}

function resolvedProjectFile(projectRoot, value, label) {
  const relative = relativeProjectPath(projectRoot, value, label);
  const absolute = path.resolve(projectRoot, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${label} 不存在或不是文件：${absolute}`);
  }
  return {absolute, relative};
}

export function loadStageTemplate(templatePath = DEFAULT_STAGE_TEMPLATE) {
  const absolute = path.resolve(templatePath);
  const template = readJson(absolute);
  const errors = validateJsonSchema(template, STAGE_TEMPLATE_SCHEMA);
  if (errors.length) {
    throw new Error(`阶段模板无效：\n- ${errors.join("\n- ")}`);
  }
  const ids = new Set();
  const orders = [];
  for (const stage of template.stages) {
    if (ids.has(stage.id)) throw new Error(`阶段模板 id 重复：${stage.id}`);
    ids.add(stage.id);
    orders.push(stage.order);
    for (const dependency of stage.depends_on) {
      if (!ids.has(dependency)) {
        throw new Error(`阶段 ${stage.id} 依赖尚未出现的阶段 ${dependency}`);
      }
    }
  }
  if (orders.some((order, index) => order !== index + 1)) {
    throw new Error("阶段模板 order 必须从 1 连续递增");
  }
  return {
    template,
    file: absolute,
    sha256: sha256File(absolute),
  };
}

function stageFromTemplate(stage, index) {
  return {
    id: stage.id,
    order: stage.order,
    label: stage.label,
    depends_on: [...stage.depends_on],
    required_artifact_roles: [...stage.required_artifact_roles],
    status: index === 0 ? "ready" : "blocked",
    artifact_ids: [],
    artifact_set_sha256: null,
    submitted_at: null,
    approval: null,
    invalidation: null,
  };
}

export function defaultContracts(mediaSources = "media-sources.json") {
  return {
    media_sources: mediaSources,
    resource_adoptions: null,
    transcript: null,
    clip_selections: null,
    timeline: null,
    style_profile: null,
    sound_profile: null,
    promotion_candidates: null,
    review: null,
    delivery: null,
  };
}

export function createProjectState({
  projectId,
  mediaKind = "video",
  profile = null,
  contracts = defaultContracts(),
  templatePath = DEFAULT_STAGE_TEMPLATE,
  timestamp = nowIso(),
}) {
  if (!ID_PATTERN.test(projectId || "")) throw new Error("project-id 格式不合法");
  const loaded = loadStageTemplate(templatePath);
  if (!loaded.template.media_kinds.includes(mediaKind)) {
    throw new Error(`阶段模板不支持 media-kind=${mediaKind}`);
  }
  return {
    protocol: "visual-multimedia-media-project-state",
    version: 3,
    project_id: projectId,
    media_kind: mediaKind,
    profile,
    execution_policy: {
      mode: "staged",
      authorized_by: null,
      authorized_at: null,
      evidence: "",
    },
    stage_template: {
      id: loaded.template.id,
      version: loaded.template.template_version,
      sha256: loaded.sha256,
    },
    status: "in-progress",
    current_stage: loaded.template.stages[0].id,
    stages: loaded.template.stages.map(stageFromTemplate),
    contracts: Object.fromEntries(CONTRACT_KEYS.map((key) => [key, contracts[key] ?? null])),
    production_decisions: [],
    artifacts: [],
    blockers: [],
    next_action: `开始“${loaded.template.stages[0].label}”阶段并提交可展示成果。`,
    updated_at: timestamp,
  };
}

export function artifactSetSha256(artifacts) {
  const value = [...artifacts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((artifact) => `${artifact.id}\0${artifact.sha256}`)
    .join("\n");
  return sha256Text(value);
}

function stageById(state, stageId) {
  const stage = state.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error(`项目没有阶段：${stageId}`);
  return stage;
}

function stageArtifacts(state, stage) {
  const byId = new Map(state.artifacts.map((item) => [item.id, item]));
  return stage.artifact_ids.map((id) => {
    const artifact = byId.get(id);
    if (!artifact) throw new Error(`阶段 ${stage.id} 引用了不存在的产物 ${id}`);
    return artifact;
  });
}

function allDependenciesApproved(state, stage) {
  return stage.depends_on.every(
    (id) => stageById(state, id).status === "approved",
  );
}

export function refreshProjectState(state, timestamp = nowIso()) {
  for (const stage of [...state.stages].sort((a, b) => a.order - b.order)) {
    if (["approved", "waiting-approval", "in-progress", "rejected", "invalidated"].includes(stage.status)) {
      continue;
    }
    stage.status = allDependenciesApproved(state, stage) ? "ready" : "blocked";
  }
  state.updated_at = timestamp;
  if (state.blockers.length) {
    state.status = "blocked";
    state.current_stage = state.stages.find((stage) => stage.status !== "approved")?.id ?? null;
    state.next_action = `先处理阻塞项：${state.blockers[0]}`;
    return state;
  }
  const current = [...state.stages]
    .sort((a, b) => a.order - b.order)
    .find((stage) => stage.status !== "approved");
  if (!current) {
    state.status = "complete";
    state.current_stage = null;
    state.next_action = "";
    return state;
  }
  state.current_stage = current.id;
  state.status = current.status === "waiting-approval"
    ? "waiting-approval"
    : "in-progress";
  const actionByStatus = {
    blocked: `等待上游阶段确认后再进入“${current.label}”。`,
    ready: `开始“${current.label}”阶段并提交可展示成果。`,
    "in-progress": `完成“${current.label}”阶段的可展示成果并提交。`,
    "waiting-approval": `展示“${current.label}”成果并等待用户确认。`,
    rejected: `根据用户意见修订“${current.label}”成果。`,
    invalidated: `上游变化已使“${current.label}”失效；重新制作并提交。`,
  };
  state.next_action = actionByStatus[current.status];
  return state;
}

export function startStage(state, stageId, timestamp = nowIso()) {
  const stage = stageById(state, stageId);
  if (!["ready", "rejected", "invalidated"].includes(stage.status)) {
    throw new Error(`阶段 ${stageId} 当前为 ${stage.status}，不能开始制作`);
  }
  if (!allDependenciesApproved(state, stage)) {
    throw new Error(`阶段 ${stageId} 的上游尚未全部确认`);
  }
  state.artifacts = state.artifacts.filter((artifact) => artifact.stage_id !== stageId);
  stage.status = "in-progress";
  stage.artifact_ids = [];
  stage.artifact_set_sha256 = null;
  stage.submitted_at = null;
  stage.approval = null;
  stage.invalidation = null;
  return refreshProjectState(state, timestamp);
}

export function submitStage(
  state,
  projectRoot,
  stageId,
  artifactInputs,
  timestamp = nowIso(),
) {
  const stage = stageById(state, stageId);
  if (!["ready", "in-progress", "rejected", "invalidated"].includes(stage.status)) {
    throw new Error(`阶段 ${stageId} 当前为 ${stage.status}，不能提交成果`);
  }
  if (!allDependenciesApproved(state, stage)) {
    throw new Error(`阶段 ${stageId} 的上游尚未全部确认`);
  }
  if (!Array.isArray(artifactInputs) || artifactInputs.length === 0) {
    throw new Error("提交阶段必须至少提供一个真实产物");
  }
  const artifacts = artifactInputs.map((input, index) => {
    const role = String(input.role || "");
    const kind = String(input.kind || "");
    if (!ID_PATTERN.test(role)) throw new Error(`产物 ${index + 1} role 格式不合法`);
    const file = resolvedProjectFile(projectRoot, input.file, `产物 ${index + 1}`);
    const id = input.id || `${stageId}-${role}`;
    if (!ID_PATTERN.test(id)) throw new Error(`产物 ${index + 1} id 格式不合法`);
    return {
      id,
      stage_id: stageId,
      role,
      kind,
      file: file.relative,
      sha256: sha256File(file.absolute),
    };
  });
  if (new Set(artifacts.map((item) => item.id)).size !== artifacts.length) {
    throw new Error("同一次提交不能包含重复产物 id");
  }
  const roles = new Set(artifacts.map((item) => item.role));
  const missing = stage.required_artifact_roles.filter((role) => !roles.has(role));
  if (missing.length) throw new Error(`阶段 ${stageId} 缺少产物角色：${missing.join(", ")}`);
  const otherIds = new Set(
    state.artifacts.filter((item) => item.stage_id !== stageId).map((item) => item.id),
  );
  const collision = artifacts.find((item) => otherIds.has(item.id));
  if (collision) throw new Error(`产物 id 已被其它阶段使用：${collision.id}`);
  state.artifacts = [
    ...state.artifacts.filter((item) => item.stage_id !== stageId),
    ...artifacts,
  ];
  stage.artifact_ids = artifacts.map((item) => item.id);
  stage.artifact_set_sha256 = artifactSetSha256(artifacts);
  stage.submitted_at = timestamp;
  stage.invalidation = null;
  if (state.execution_policy.mode === "full-auto") {
    stage.status = "approved";
    stage.approval = {
      decision: "approved",
      decided_by: "system",
      decided_at: timestamp,
      evidence: `用户已授权全自动生产：${state.execution_policy.evidence}`,
      artifact_set_sha256: stage.artifact_set_sha256,
    };
  } else {
    stage.status = "waiting-approval";
    stage.approval = null;
  }
  return refreshProjectState(state, timestamp);
}

export function decideStage(
  state,
  stageId,
  decision,
  evidence,
  {decidedBy = "user", timestamp = nowIso()} = {},
) {
  const stage = stageById(state, stageId);
  if (stage.status !== "waiting-approval") {
    throw new Error(`阶段 ${stageId} 当前为 ${stage.status}，没有等待确认的成果`);
  }
  if (!stage.artifact_set_sha256 || !stage.artifact_ids.length) {
    throw new Error(`阶段 ${stageId} 没有绑定成果集合`);
  }
  const currentSha = artifactSetSha256(stageArtifacts(state, stage));
  if (currentSha !== stage.artifact_set_sha256) {
    throw new Error(`阶段 ${stageId} 的成果集合已经变化，必须重新提交`);
  }
  if (!String(evidence || "").trim()) throw new Error("阶段确认必须记录依据");
  if (!new Set(["user", "profile", "system"]).has(decidedBy)) {
    throw new Error("decided-by 必须是 user、profile 或 system");
  }
  if (!new Set(["approved", "rejected"]).has(decision)) {
    throw new Error("decision 必须是 approved 或 rejected");
  }
  stage.status = decision;
  stage.approval = {
    decision,
    decided_by: decidedBy,
    decided_at: timestamp,
    evidence: String(evidence).trim(),
    artifact_set_sha256: stage.artifact_set_sha256,
  };
  if (decision === "rejected") {
    invalidateDownstream(state, stageId, `上游阶段 ${stageId} 被拒绝`, timestamp, false);
  }
  return refreshProjectState(state, timestamp);
}

function descendants(state, stageId) {
  const selected = new Set([stageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of state.stages) {
      if (!selected.has(stage.id) && stage.depends_on.some((id) => selected.has(id))) {
        selected.add(stage.id);
        changed = true;
      }
    }
  }
  return selected;
}

function invalidateDownstream(
  state,
  stageId,
  reason,
  timestamp,
  includeSource,
) {
  const affected = descendants(state, stageId);
  if (!includeSource) affected.delete(stageId);
  for (const stage of state.stages) {
    if (!affected.has(stage.id) || ["blocked", "ready"].includes(stage.status)) continue;
    const previous = stage.artifact_set_sha256;
    state.artifacts = state.artifacts.filter((artifact) => artifact.stage_id !== stage.id);
    stage.status = "invalidated";
    stage.artifact_ids = [];
    stage.artifact_set_sha256 = null;
    stage.submitted_at = null;
    stage.approval = null;
    stage.invalidation = {
      reason,
      invalidated_at: timestamp,
      previous_artifact_set_sha256: previous,
      caused_by_stage: stageId,
    };
  }
}

export function invalidateStage(state, stageId, reason, timestamp = nowIso()) {
  if (!String(reason || "").trim()) throw new Error("失效操作必须说明原因");
  stageById(state, stageId);
  invalidateDownstream(state, stageId, String(reason).trim(), timestamp, true);
  return refreshProjectState(state, timestamp);
}

export function setExecutionPolicy(
  state,
  mode,
  {authorizedBy = null, authorizedAt = nowIso(), evidence = ""} = {},
) {
  if (mode === "staged") {
    state.execution_policy = {
      mode: "staged",
      authorized_by: null,
      authorized_at: null,
      evidence: "",
    };
  } else if (mode === "full-auto") {
    if (authorizedBy !== "user" || !String(evidence).trim()) {
      throw new Error("全自动生产必须记录用户授权和依据");
    }
    state.execution_policy = {
      mode: "full-auto",
      authorized_by: "user",
      authorized_at: authorizedAt,
      evidence: String(evidence).trim(),
    };
  } else {
    throw new Error("执行策略只能是 staged 或 full-auto");
  }
  return refreshProjectState(state, authorizedAt);
}

export function setProjectContract(
  state,
  projectRoot,
  name,
  value,
  timestamp = nowIso(),
) {
  if (!CONTRACT_KEYS.includes(name)) throw new Error(`未知合同入口：${name}`);
  if (name === "media_sources" && (value == null || value === "")) {
    throw new Error("media_sources 不能设为 null");
  }
  if (value == null || value === "null") {
    state.contracts[name] = null;
  } else {
    state.contracts[name] = resolvedProjectFile(
      projectRoot,
      value,
      `合同 ${name}`,
    ).relative;
  }
  return refreshProjectState(state, timestamp);
}

export function assertStageApproved(state, stageId) {
  const stage = stageById(state, stageId);
  if (stage.status !== "approved") {
    throw new Error(`阶段 ${stageId} 尚未确认，当前状态为 ${stage.status}`);
  }
  return stage;
}

function resolveContract(projectRoot, value, label, errors) {
  if (value === null) return null;
  try {
    return resolvedProjectFile(projectRoot, value, label).absolute;
  } catch (error) {
    errors.push(error.message);
    return null;
  }
}

function validateTemplateBinding(state, errors) {
  let loaded;
  try {
    loaded = loadStageTemplate();
  } catch (error) {
    errors.push(error.message);
    return null;
  }
  if (
    state.stage_template?.id !== loaded.template.id
    || state.stage_template?.version !== loaded.template.template_version
    || state.stage_template?.sha256 !== loaded.sha256
  ) {
    errors.push("stage_template 与当前注册的时间型媒体阶段模板不一致");
  }
  if (!loaded.template.media_kinds.includes(state.media_kind)) {
    errors.push(`阶段模板不支持 media_kind=${state.media_kind}`);
  }
  if (state.stages?.length !== loaded.template.stages.length) {
    errors.push("stages 数量与阶段模板不一致");
    return loaded;
  }
  for (let index = 0; index < loaded.template.stages.length; index += 1) {
    const expected = loaded.template.stages[index];
    const actual = state.stages[index];
    for (const key of ["id", "order", "label"]) {
      if (actual?.[key] !== expected[key]) errors.push(`stages[${index}].${key} 与模板不一致`);
    }
    for (const key of ["depends_on", "required_artifact_roles"]) {
      if (JSON.stringify(actual?.[key]) !== JSON.stringify(expected[key])) {
        errors.push(`stages[${index}].${key} 与模板不一致`);
      }
    }
  }
  return loaded;
}

export function validateProjectState(statePath) {
  const absolute = path.resolve(statePath);
  const errors = [];
  let state;
  try {
    state = readJson(absolute);
  } catch (error) {
    return {ok: false, file: absolute, errors: [`无法读取项目状态：${error.message}`]};
  }
  errors.push(...validateJsonSchema(state, PROJECT_STATE_SCHEMA));
  if (state.version !== 3) {
    return {ok: false, file: absolute, errors: [...errors, "只接受活动 v3 项目状态；v2 只能经过 migrate-v2 一次性迁移"]};
  }
  validateTemplateBinding(state, errors);
  const projectRoot = path.dirname(absolute);
  const resolvedContracts = {};
  for (const key of CONTRACT_KEYS) {
    resolvedContracts[key] = resolveContract(
      projectRoot,
      state.contracts?.[key],
      `contracts.${key}`,
      errors,
    );
  }
  if (resolvedContracts.media_sources) {
    const validation = validateMediaSources(resolvedContracts.media_sources);
    validation.errors.forEach((message) => errors.push(`contracts.media_sources：${message}`));
  }
  if (resolvedContracts.resource_adoptions) {
    const validation = validateMediaResourceAdoptions(resolvedContracts.resource_adoptions, {
      projectId: state.project_id,
      mediaSourcesPath: resolvedContracts.media_sources,
    });
    validation.errors.forEach((message) => errors.push(`contracts.resource_adoptions：${message}`));
  }
  if (resolvedContracts.sound_profile) {
    const validation = validateSoundProductionProfile(resolvedContracts.sound_profile, {
      projectId: state.project_id,
      mediaSourcesPath: resolvedContracts.media_sources,
    });
    validation.errors.forEach((message) => errors.push(`contracts.sound_profile：${message}`));
  }
  if (resolvedContracts.promotion_candidates) {
    const validation = validateResourcePromotionCandidates(
      resolvedContracts.promotion_candidates,
      {projectId: state.project_id},
    );
    validation.errors.forEach((message) => errors.push(`contracts.promotion_candidates：${message}`));
  }
  const stageIds = new Set(state.stages?.map((stage) => stage.id));
  const artifactsById = new Map();
  for (const artifact of state.artifacts || []) {
    if (artifactsById.has(artifact.id)) errors.push(`产物 id 重复：${artifact.id}`);
    artifactsById.set(artifact.id, artifact);
    if (!stageIds.has(artifact.stage_id)) errors.push(`产物 ${artifact.id} 的 stage_id 不存在`);
    try {
      const file = resolvedProjectFile(projectRoot, artifact.file, `产物 ${artifact.id}`);
      if (sha256File(file.absolute) !== artifact.sha256) {
        errors.push(`产物 ${artifact.id} 的 sha256 与当前文件不一致`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  const decisionsById = new Map();
  for (const decision of state.production_decisions || []) {
    if (decisionsById.has(decision.id)) errors.push(`制作决策 id 重复：${decision.id}`);
    decisionsById.set(decision.id, decision);
    const evidenceIds = decision.evidence_artifact_ids || [];
    for (const artifactId of evidenceIds) {
      if (!artifactsById.has(artifactId)) {
        errors.push(`制作决策 ${decision.id} 引用了不存在的产物 ${artifactId}`);
      }
    }
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      errors.push(`制作决策 ${decision.id} 的 evidence_artifact_ids 不能重复`);
    }
    if (decision.status === "active" && decision.superseded_by !== null) {
      errors.push(`制作决策 ${decision.id} 为 active 时 superseded_by 必须为 null`);
    }
    if (decision.status === "superseded" && decision.superseded_by === null) {
      errors.push(`制作决策 ${decision.id} 为 superseded 时必须指向替代决策`);
    }
  }
  for (const decision of decisionsById.values()) {
    if (decision.status !== "superseded" || decision.superseded_by === null) continue;
    const replacement = decisionsById.get(decision.superseded_by);
    if (!replacement) {
      errors.push(`制作决策 ${decision.id} 的 superseded_by 指向不存在的替代决策`);
      continue;
    }
    if (replacement.category !== decision.category) {
      errors.push(`制作决策 ${decision.id} 的替代决策必须属于同一分类`);
    }
    const visited = new Set([decision.id]);
    let cursor = replacement;
    while (cursor?.status === "superseded") {
      if (visited.has(cursor.id)) {
        errors.push(`制作决策 ${decision.id} 的 superseded_by 替代链不能成环`);
        break;
      }
      visited.add(cursor.id);
      cursor = decisionsById.get(cursor.superseded_by);
    }
  }
  for (const stage of state.stages || []) {
    const artifacts = [];
    for (const id of stage.artifact_ids) {
      const artifact = artifactsById.get(id);
      if (!artifact) errors.push(`阶段 ${stage.id} 引用了不存在的产物 ${id}`);
      else if (artifact.stage_id !== stage.id) errors.push(`阶段 ${stage.id} 引用了其它阶段的产物 ${id}`);
      else artifacts.push(artifact);
    }
    const roles = new Set(artifacts.map((item) => item.role));
    if (["waiting-approval", "approved", "rejected"].includes(stage.status)) {
      const missing = stage.required_artifact_roles.filter((role) => !roles.has(role));
      if (missing.length) errors.push(`阶段 ${stage.id} 缺少产物角色：${missing.join(", ")}`);
      const actualSetSha = artifactSetSha256(artifacts);
      if (stage.artifact_set_sha256 !== actualSetSha) {
        errors.push(`阶段 ${stage.id} 的 artifact_set_sha256 不一致`);
      }
      if (!stage.submitted_at) errors.push(`阶段 ${stage.id} 必须记录 submitted_at`);
    } else if (stage.artifact_ids.length || stage.artifact_set_sha256 || stage.submitted_at) {
      errors.push(`阶段 ${stage.id} 当前状态不能持有活动成果集合`);
    }
    if (["approved", "rejected"].includes(stage.status)) {
      if (stage.approval?.decision !== stage.status) {
        errors.push(`阶段 ${stage.id} 的 approval.decision 与状态不一致`);
      }
      if (stage.approval?.artifact_set_sha256 !== stage.artifact_set_sha256) {
        errors.push(`阶段 ${stage.id} 的批准没有绑定当前成果集合`);
      }
    } else if (stage.approval !== null) {
      errors.push(`阶段 ${stage.id} 当前状态不能保留 approval`);
    }
    if (stage.status === "invalidated" && stage.invalidation === null) {
      errors.push(`阶段 ${stage.id} 失效时必须记录原因`);
    }
    if (stage.status !== "invalidated" && stage.invalidation !== null) {
      errors.push(`阶段 ${stage.id} 非失效状态不能保留 invalidation`);
    }
    if (["ready", "in-progress", "waiting-approval", "approved", "rejected"].includes(stage.status)) {
      const dependenciesApproved = stage.depends_on.every(
        (id) => state.stages.find((item) => item.id === id)?.status === "approved",
      );
      if (!dependenciesApproved) errors.push(`阶段 ${stage.id} 的上游尚未全部确认`);
    }
  }
  const expected = JSON.parse(JSON.stringify(state));
  refreshProjectState(expected, state.updated_at);
  for (const key of ["status", "current_stage", "next_action"]) {
    if (expected[key] !== state[key]) errors.push(`${key} 与阶段状态推导结果不一致`);
  }
  if (state.execution_policy?.mode === "staged") {
    if (
      state.execution_policy.authorized_by !== null
      || state.execution_policy.authorized_at !== null
      || state.execution_policy.evidence !== ""
    ) errors.push("staged 执行策略不能携带全自动授权");
  } else if (
    state.execution_policy?.mode === "full-auto"
    && (
      state.execution_policy.authorized_by !== "user"
      || !state.execution_policy.authorized_at
      || !state.execution_policy.evidence
    )
  ) {
    errors.push("full-auto 执行策略缺少明确用户授权");
  }
  if (state.status === "complete" && !state.contracts.delivery) {
    errors.push("complete 项目必须绑定 delivery 合同");
  }
  return {
    ok: errors.length === 0,
    file: absolute,
    project_id: state.project_id,
    media_kind: state.media_kind,
    profile: state.profile,
    status: state.status,
    execution_policy: state.execution_policy,
    current_stage: state.current_stage,
    stages: state.stages,
    artifacts: state.artifacts,
    contracts: resolvedContracts,
    next_action: state.next_action,
    errors,
  };
}

function migratedArtifactKind(oldKind) {
  if (oldKind === "final" || oldKind === "preview") return "video";
  if (oldKind === "timeline") return "timeline";
  if (oldKind.endsWith("sample")) return "image";
  return "document";
}

function oldArtifactStage(oldKind) {
  if (oldKind === "script") return ["content", "content-contract"];
  if (["style-sample", "composition-sample", "motion-sound-sample", "timeline"].includes(oldKind)) {
    return ["direction", "direction-package"];
  }
  if (oldKind === "preview") return ["integrated-sample", "integrated-sample"];
  if (oldKind === "final") return ["final-delivery", "final-delivery"];
  return ["content", "content-contract"];
}

export function migrateV2State(oldState, projectRoot, options = {}) {
  if (oldState?.protocol !== "visual-multimedia-media-project-state" || oldState?.version !== 2) {
    throw new Error("migrate-v2 只接受 media-project-state v2");
  }
  const timestamp = options.timestamp || nowIso();
  const state = createProjectState({
    projectId: oldState.project_id,
    mediaKind: options.mediaKind || "video",
    profile: options.profile ?? null,
    contracts: oldState.contracts,
    timestamp,
  });
  state.production_decisions = oldState.production_decisions || [];
  const mapped = [];
  for (const oldArtifact of oldState.artifacts || []) {
    const [stageId, role] = oldArtifactStage(oldArtifact.kind);
    const file = resolvedProjectFile(projectRoot, oldArtifact.file, `旧产物 ${oldArtifact.id}`);
    const actual = sha256File(file.absolute);
    if (actual !== oldArtifact.sha256) throw new Error(`旧产物 ${oldArtifact.id} 哈希不一致`);
    mapped.push({
      id: oldArtifact.id,
      stage_id: stageId,
      role,
      kind: migratedArtifactKind(oldArtifact.kind),
      file: file.relative,
      sha256: actual,
    });
  }
  state.artifacts = mapped;
  if (oldState.status === "complete") {
    const evidence = mapped.find((item) => item.role === "final-delivery") || mapped.at(-1);
    if (!evidence) throw new Error("完整 v2 项目没有任何真实产物，不能迁移为 complete");
    for (const stage of state.stages) {
      const id = `migration-${stage.id}`;
      const artifact = {
        ...evidence,
        id,
        stage_id: stage.id,
        role: stage.required_artifact_roles[0],
      };
      state.artifacts = state.artifacts.filter((item) => item.stage_id !== stage.id);
      state.artifacts.push(artifact);
      stage.status = "approved";
      stage.artifact_ids = [id];
      stage.artifact_set_sha256 = artifactSetSha256([artifact]);
      stage.submitted_at = oldState.updated_at || timestamp;
      stage.approval = {
        decision: "approved",
        decided_by: "system",
        decided_at: oldState.updated_at || timestamp,
        evidence: "一次性迁移：v2 项目已经完成交付，以真实最终产物绑定历史阶段。",
        artifact_set_sha256: stage.artifact_set_sha256,
      };
    }
  } else {
    for (const stage of state.stages) {
      const artifacts = state.artifacts.filter((item) => item.stage_id === stage.id);
      const oldApproved = (oldState.creative_approvals || []).some((item) => (
        item.status === "approved"
        && (
          (stage.id === "content" && item.scope === "script")
          || (stage.id === "direction" && ["style", "composition", "motion-sound"].includes(item.scope))
        )
      ));
      const roles = new Set(artifacts.map((item) => item.role));
      if (oldApproved && stage.required_artifact_roles.every((role) => roles.has(role))) {
        stage.status = "approved";
        stage.artifact_ids = artifacts.map((item) => item.id);
        stage.artifact_set_sha256 = artifactSetSha256(artifacts);
        stage.submitted_at = oldState.updated_at || timestamp;
        stage.approval = {
          decision: "approved",
          decided_by: "system",
          decided_at: oldState.updated_at || timestamp,
          evidence: "一次性迁移：保留 v2 已记录的创意确认。",
          artifact_set_sha256: stage.artifact_set_sha256,
        };
      }
    }
  }
  state.blockers = oldState.blockers || [];
  return refreshProjectState(state, timestamp);
}
