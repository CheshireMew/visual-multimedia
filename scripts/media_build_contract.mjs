import crypto from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {assertJsonSchema} from "./json_schema_contract.mjs";
import {canonical, sha256File} from "./interview_explainer_common.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(SCRIPT_DIR, "..", "schemas");

export const MEDIA_BUILD_PLAN_SCHEMA = path.join(
  SCHEMA_DIR,
  "media-build-plan.v1.schema.json",
);
export const MEDIA_BUILD_REPORT_SCHEMA = path.join(
  SCHEMA_DIR,
  "media-build-report.v2.schema.json",
);

export function validateMediaBuildPlan(plan) {
  assertJsonSchema(plan, MEDIA_BUILD_PLAN_SCHEMA, "通用媒体构建计划");
  const orders = plan.units.map((item) => item.order);
  const ids = plan.units.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("通用媒体构建计划包含重复单元 id");
  }
  if (orders.some((value, index) => value !== index + 1)) {
    throw new Error("通用媒体构建单元必须按连续 order 排列");
  }
  let cursor = 0;
  for (const unit of plan.units) {
    if (unit.timeline_start_frame !== cursor) {
      throw new Error(`构建单元 ${unit.id} 与上一单元不连续`);
    }
    cursor += unit.duration_frames;
  }
  return plan;
}

export function createMediaBuildPlan({
  projectRoot,
  producerRoot = projectRoot,
  projectId,
  mediaKind,
  profile,
  stageTarget,
  sourceContract,
  producerEntry,
  producerModules = [],
  output,
  units,
  assembly,
  createdAt = new Date().toISOString(),
}) {
  const sourceContractPath = path.join(
    projectRoot,
    ...sourceContract.split("/"),
  );
  const producerEntryPath = path.join(
    producerRoot,
    ...producerEntry.split("/"),
  );
  const modules = [...new Set([producerEntry, ...producerModules])];
  return validateMediaBuildPlan({
    protocol: "visual-multimedia-media-build-plan",
    version: 1,
    project_id: projectId,
    media_kind: mediaKind,
    profile,
    stage_target: stageTarget,
    created_at: createdAt,
    source_contract: sourceContract,
    source_contract_sha256: sha256File(sourceContractPath),
    producer: {
      entry: producerEntry,
      sha256: sha256File(producerEntryPath),
      modules: modules.map((file) => ({
        file,
        sha256: sha256File(path.join(producerRoot, ...file.split("/"))),
      })),
    },
    output,
    units,
    assembly,
  });
}

export function buildUnitCacheKey(plan, unit, executorInput) {
  validateMediaBuildPlan(plan);
  if (!plan.units.some((candidate) => candidate.id === unit.id)) {
    throw new Error(`构建单元不属于当前计划：${unit.id}`);
  }
  return crypto.createHash("sha256").update(canonical({
    protocol: plan.protocol,
    version: plan.version,
    project_id: plan.project_id,
    profile: plan.profile,
    stage_target: plan.stage_target,
    producer: plan.producer,
    output: plan.output,
    unit,
    executor_input: executorInput,
  })).digest("hex");
}

export function assemblyCacheKey(plan, units, audio = null) {
  validateMediaBuildPlan(plan);
  return crypto.createHash("sha256").update(canonical({
    protocol: plan.protocol,
    version: plan.version,
    output: plan.output,
    assembly: plan.assembly,
    units: units.map((item) => ({
      id: item.id,
      sha256: item.sha256,
      frames: item.frames,
    })),
    audio,
  })).digest("hex");
}

export function validateMediaBuildReport(report) {
  assertJsonSchema(report, MEDIA_BUILD_REPORT_SCHEMA, "通用媒体构建报告");
  return report;
}

export function fileDependency(projectRoot, role, relativeFile) {
  return {
    role,
    file: relativeFile,
    sha256: sha256File(path.join(projectRoot, ...relativeFile.split("/"))),
  };
}
