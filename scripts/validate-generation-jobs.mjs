#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateMediaSources } from "./validate-media-sources.mjs";
import { validateVideoDirectionPlan } from "./validate-video-direction-plan.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const REMOTE_STATUSES = new Set([
  "not_submitted",
  "prepared",
  "submitted",
  "running",
  "succeeded",
  "failed",
]);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Value(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function generationIdempotencyKey(
  provider,
  operation,
  sourceVersion,
  inputSha256
) {
  return sha256Value(
    Buffer.from(
      `${provider}\n${operation}\n${sourceVersion}\n${inputSha256}`,
      "utf8"
    )
  );
}

function sha256File(filePath) {
  return sha256Value(fs.readFileSync(filePath));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, label, fields, errors) {
  if (!isObject(value)) {
    errors.push(`${label} 必须是对象`);
    return false;
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${label} 缺少字段 ${field}`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) errors.push(`${label} 包含未知字段 ${field}`);
  }
  return true;
}

function string(value, label, errors, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    errors.push(`${label} 必须是${allowEmpty ? "" : "非空"}字符串`);
    return false;
  }
  return true;
}

function id(value, label, errors) {
  if (!string(value, label, errors)) return false;
  if (!ID_PATTERN.test(value)) {
    errors.push(`${label} 不是合法 id`);
    return false;
  }
  return true;
}

function dateTime(value, label, errors, nullable = false) {
  if (nullable && value === null) return true;
  if (!string(value, label, errors)) return false;
  if (!Number.isFinite(new Date(value).getTime())) {
    errors.push(`${label} 不是有效日期时间`);
    return false;
  }
  return true;
}

function projectFile(projectRoot, relative, label, errors) {
  if (!string(relative, label, errors)) return null;
  const absolute = path.resolve(projectRoot, relative);
  const rel = path.relative(projectRoot, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    errors.push(`${label} 必须位于项目目录内`);
    return null;
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    errors.push(`${label} 指向的文件不存在：${absolute}`);
    return null;
  }
  return absolute;
}

function validateCapture(capture, label, projectRoot, errors, nullable = true) {
  if (capture === null && nullable) return null;
  if (!exactObject(capture, label, ["file", "sha256"], errors)) return null;
  if (!SHA_PATTERN.test(capture.sha256 || "")) errors.push(`${label}.sha256 无效`);
  const file = projectFile(projectRoot, capture.file, `${label}.file`, errors);
  if (file && sha256File(file) !== capture.sha256) {
    errors.push(`${label} 的实际 SHA-256 不一致`);
  }
  return file;
}

function validateMoney(value, label, errors) {
  if (!exactObject(value, label, ["amount", "currency", "billable_basis"], errors)) {
    return;
  }
  if (
    typeof value.amount !== "number"
    || !Number.isFinite(value.amount)
    || value.amount < 0
  ) errors.push(`${label}.amount 必须是非负数`);
  string(value.currency, `${label}.currency`, errors);
  string(value.billable_basis, `${label}.billable_basis`, errors);
}

function validateJob(
  job,
  index,
  projectRoot,
  sourceVersion,
  plan,
  planJobToRefs,
  mediaSources,
  errors
) {
  const label = `jobs[${index}]`;
  const fields = [
    "id",
    "intent_refs",
    "provider",
    "operation",
    "normalized_input",
    "estimate",
    "paid_policy",
    "authorization",
    "idempotency_key",
    "remote",
    "outputs",
    "actual_cost",
    "imported_source_id",
    "updated_at",
  ];
  if (!exactObject(job, label, fields, errors)) return;
  id(job.id, `${label}.id`, errors);
  string(job.provider, `${label}.provider`, errors);
  string(job.operation, `${label}.operation`, errors);
  if (!Array.isArray(job.intent_refs) || job.intent_refs.length === 0) {
    errors.push(`${label}.intent_refs 至少需要一项`);
  } else {
    const seen = new Set();
    for (const [refIndex, intentRef] of job.intent_refs.entries()) {
      if (!string(intentRef, `${label}.intent_refs[${refIndex}]`, errors)) continue;
      if (seen.has(intentRef)) errors.push(`${label}.intent_refs 包含重复项`);
      seen.add(intentRef);
      if (plan) {
        const scene = plan.scenes.find((item) => item.segment_id === intentRef);
        if (!scene) {
          errors.push(`${label} 引用未知场景 ${intentRef}`);
        } else if (!scene.generation_job_ids.includes(job.id)) {
          errors.push(`${label} 与场景 ${intentRef} 没有双向引用`);
        }
      }
    }
  }
  if (plan) {
    const plannedRefs = planJobToRefs.get(job.id);
    if (!plannedRefs) {
      errors.push(`${label}.id 没有被导演计划引用`);
    } else if (
      JSON.stringify([...plannedRefs].sort())
        !== JSON.stringify([...(job.intent_refs || [])].sort())
    ) {
      errors.push(`${label}.intent_refs 与导演计划反向引用不一致`);
    }
  }
  let inputHash = null;
  if (exactObject(
    job.normalized_input,
    `${label}.normalized_input`,
    ["file", "sha256", "source_version"],
    errors
  )) {
    const inputFile = projectFile(
      projectRoot,
      job.normalized_input.file,
      `${label}.normalized_input.file`,
      errors
    );
    if (!SHA_PATTERN.test(job.normalized_input.sha256 || "")) {
      errors.push(`${label}.normalized_input.sha256 无效`);
    }
    if (job.normalized_input.source_version !== sourceVersion) {
      errors.push(`${label}.normalized_input.source_version 已偏离当前内容版本`);
    }
    if (inputFile) {
      try {
        inputHash = sha256Value(
          Buffer.from(canonicalJson(JSON.parse(fs.readFileSync(inputFile, "utf8"))), "utf8")
        );
        if (inputHash !== job.normalized_input.sha256) {
          errors.push(`${label} 的规范化输入哈希已失效`);
        }
      } catch (error) {
        errors.push(`${label}.normalized_input.file 不是有效 JSON：${error.message}`);
      }
    }
  }
  validateMoney(job.estimate, `${label}.estimate`, errors);
  if (!["off", "confirm", "auto"].includes(job.paid_policy)) {
    errors.push(`${label}.paid_policy 无效`);
  }
  if (exactObject(
    job.authorization,
    `${label}.authorization`,
    ["status", "evidence", "decided_at"],
    errors
  )) {
    if (!["not_required", "pending", "approved", "denied"].includes(
      job.authorization.status
    )) errors.push(`${label}.authorization.status 无效`);
    dateTime(
      job.authorization.decided_at,
      `${label}.authorization.decided_at`,
      errors,
      true
    );
    validateCapture(
      job.authorization.evidence,
      `${label}.authorization.evidence`,
      projectRoot,
      errors
    );
    const amount = job.estimate?.amount;
    if (amount === 0 && !["not_required", "approved"].includes(
      job.authorization.status
    )) errors.push(`${label} 的零费用任务不应停在待批准或拒绝状态`);
    if (amount > 0 && job.paid_policy === "off"
      && job.authorization.status !== "denied") {
      errors.push(`${label} paid_policy=off 的正费用任务必须是 denied`);
    }
    if (amount > 0 && job.paid_policy === "auto"
      && job.authorization.status !== "approved") {
      errors.push(`${label} paid_policy=auto 必须带范围证据并处于 approved`);
    }
    if (job.authorization.status === "approved") {
      if (!job.authorization.evidence || !job.authorization.decided_at) {
        errors.push(`${label} 的 approved 授权缺少证据或时间`);
      }
    }
  }
  const expectedKey = inputHash
    ? generationIdempotencyKey(
      job.provider,
      job.operation,
      job.normalized_input.source_version,
      inputHash
    )
    : null;
  if (!SHA_PATTERN.test(job.idempotency_key || "")) {
    errors.push(`${label}.idempotency_key 无效`);
  } else if (expectedKey && job.idempotency_key !== expectedKey) {
    errors.push(`${label}.idempotency_key 与供应方、操作、版本和输入不一致`);
  }
  if (exactObject(
    job.remote,
    `${label}.remote`,
    [
      "job_id",
      "status",
      "submit_lock_at",
      "submitted_at",
      "submission_capture",
      "last_polled_at",
      "status_capture",
      "query_count",
      "last_error",
    ],
    errors
  )) {
    const remote = job.remote;
    if (!REMOTE_STATUSES.has(remote.status)) errors.push(`${label}.remote.status 无效`);
    if (remote.job_id !== null) string(remote.job_id, `${label}.remote.job_id`, errors);
    for (const field of ["submit_lock_at", "submitted_at", "last_polled_at"]) {
      dateTime(remote[field], `${label}.remote.${field}`, errors, true);
    }
    validateCapture(
      remote.submission_capture,
      `${label}.remote.submission_capture`,
      projectRoot,
      errors
    );
    validateCapture(
      remote.status_capture,
      `${label}.remote.status_capture`,
      projectRoot,
      errors
    );
    if (!Number.isInteger(remote.query_count) || remote.query_count < 0) {
      errors.push(`${label}.remote.query_count 必须是非负整数`);
    }
    if (typeof remote.last_error !== "string") {
      errors.push(`${label}.remote.last_error 必须是字符串`);
    }
    const authorized = ["not_required", "approved"].includes(
      job.authorization?.status
    );
    if (remote.status !== "not_submitted" && !authorized) {
      errors.push(`${label} 越过了费用授权门`);
    }
    if (remote.status === "not_submitted") {
      if (
        remote.job_id !== null
        || remote.submit_lock_at !== null
        || remote.submitted_at !== null
      ) errors.push(`${label} 未提交状态不应带提交锁或远程 job id`);
    } else if (remote.status === "prepared") {
      if (remote.job_id !== null || !remote.submit_lock_at) {
        errors.push(`${label} prepared 必须只有提交锁，不能已有远程 job id`);
      }
    } else {
      if (
        !remote.job_id
        || !remote.submit_lock_at
        || !remote.submitted_at
        || !remote.submission_capture
      ) errors.push(`${label} 已提交状态缺少远程 id、提交时间或提交回执`);
    }
    if (["running", "succeeded", "failed"].includes(remote.status)) {
      if (!remote.last_polled_at || !remote.status_capture || remote.query_count < 1) {
        errors.push(`${label} 远程状态缺少实际查询回执`);
      }
    }
    if (remote.status === "failed" && remote.last_error.trim().length === 0) {
      errors.push(`${label} failed 状态必须记录错误`);
    }
  }
  if (!Array.isArray(job.outputs) || job.outputs.length > 1) {
    errors.push(`${label}.outputs 必须是最多一项的数组`);
  } else {
    job.outputs.forEach((output, outputIndex) => {
      const outputLabel = `${label}.outputs[${outputIndex}]`;
      if (!exactObject(
        output,
        outputLabel,
        ["remote_uri", "localized", "verified_at"],
        errors
      )) return;
      string(output.remote_uri, `${outputLabel}.remote_uri`, errors);
      dateTime(output.verified_at, `${outputLabel}.verified_at`, errors, true);
      if (output.localized !== null) {
        if (exactObject(
          output.localized,
          `${outputLabel}.localized`,
          ["file", "sha256", "bytes"],
          errors
        )) {
          const localFile = projectFile(
            projectRoot,
            output.localized.file,
            `${outputLabel}.localized.file`,
            errors
          );
          if (!SHA_PATTERN.test(output.localized.sha256 || "")) {
            errors.push(`${outputLabel}.localized.sha256 无效`);
          }
          if (!Number.isInteger(output.localized.bytes) || output.localized.bytes < 1) {
            errors.push(`${outputLabel}.localized.bytes 必须是正整数`);
          }
          if (localFile) {
            if (sha256File(localFile) !== output.localized.sha256) {
              errors.push(`${outputLabel}.localized 实际哈希不一致`);
            }
            if (fs.statSync(localFile).size !== output.localized.bytes) {
              errors.push(`${outputLabel}.localized 实际字节数不一致`);
            }
          }
        }
      }
    });
  }
  if (job.actual_cost !== null) {
    if (exactObject(
      job.actual_cost,
      `${label}.actual_cost`,
      ["amount", "currency", "billable_basis", "capture"],
      errors
    )) {
      validateMoney(
        {
          amount: job.actual_cost.amount,
          currency: job.actual_cost.currency,
          billable_basis: job.actual_cost.billable_basis,
        },
        `${label}.actual_cost`,
        errors
      );
      validateCapture(
        job.actual_cost.capture,
        `${label}.actual_cost.capture`,
        projectRoot,
        errors,
        false
      );
    }
  }
  if (job.remote?.status === "succeeded") {
    if (job.outputs.length !== 1 || job.actual_cost === null) {
      errors.push(`${label} succeeded 必须保存一个远程输出和实际费用凭据`);
    }
  }
  if (job.imported_source_id !== null) {
    id(job.imported_source_id, `${label}.imported_source_id`, errors);
    const output = job.outputs?.[0];
    if (
      job.remote?.status !== "succeeded"
      || !output?.localized
      || !output.verified_at
    ) errors.push(`${label} 声称已入账但本地化校验尚未完成`);
    const source = mediaSources?.sources?.find(
      (item) => item.id === job.imported_source_id
    );
    if (!source) {
      errors.push(`${label}.imported_source_id 不存在于 media-sources.json`);
    } else {
      if (source.integrity?.sha256 !== output?.localized?.sha256) {
        errors.push(`${label} 的本地输出与素材账本哈希不一致`);
      }
      if (source.provenance_runs?.at(-1)?.job_id !== job.remote?.job_id) {
        errors.push(`${label} 的素材账本没有绑定同一远程 job id`);
      }
    }
  }
  dateTime(job.updated_at, `${label}.updated_at`, errors);
}

export function validateGenerationJobs(filePath) {
  const absolute = path.resolve(filePath);
  const projectRoot = path.dirname(absolute);
  const errors = [];
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`无法读取生成任务合同：${error.message}`], contract: null };
  }
  if (!exactObject(
    contract,
    "生成任务合同",
    [
      "protocol",
      "version",
      "media_project_id",
      "source_version",
      "intent",
      "jobs",
    ],
    errors
  )) return { ok: false, errors, contract };
  if (contract.protocol !== "visual-multimedia-generation-jobs") {
    errors.push("protocol 必须是 visual-multimedia-generation-jobs");
  }
  if (contract.version !== 1) errors.push("version 必须是 1");
  id(contract.media_project_id, "media_project_id", errors);
  string(contract.source_version, "source_version", errors);
  let plan = null;
  let intentPath = null;
  if (exactObject(
    contract.intent,
    "intent",
    ["kind", "file", "sha256"],
    errors
  )) {
    if (!["video_direction_plan", "content_source"].includes(contract.intent.kind)) {
      errors.push("intent.kind 必须是 video_direction_plan 或 content_source");
    }
    intentPath = projectFile(
      projectRoot,
      contract.intent.file,
      "intent.file",
      errors
    );
    if (!SHA_PATTERN.test(contract.intent.sha256 || "")) {
      errors.push("intent.sha256 无效");
    }
    if (intentPath) {
      if (sha256File(intentPath) !== contract.intent.sha256) {
        errors.push("生成意图文件哈希已经变化，生成任务合同失效");
      }
      if (contract.intent.kind === "video_direction_plan") {
        const validation = validateVideoDirectionPlan(intentPath);
        if (!validation.ok) {
          validation.errors.forEach((item) => errors.push(`导演计划：${item}`));
        } else {
          plan = validation.plan;
          if (plan.project.media_project_id !== contract.media_project_id) {
            errors.push("media_project_id 与导演计划不一致");
          }
          if (plan.project.source.source_version !== contract.source_version) {
            errors.push("source_version 与导演计划不一致");
          }
        }
      }
    }
  }
  if (!Array.isArray(contract.jobs)) {
    errors.push("jobs 必须是数组");
    return { ok: false, errors, contract };
  }
  const ids = new Set();
  const planJobToRefs = new Map();
  if (plan) {
    for (const scene of plan.scenes) {
      for (const jobId of scene.generation_job_ids) {
        const refs = planJobToRefs.get(jobId) || new Set();
        refs.add(scene.segment_id);
        planJobToRefs.set(jobId, refs);
      }
    }
  }
  const mediaManifestPath = path.join(projectRoot, "media-sources.json");
  let mediaSources = null;
  if (fs.existsSync(mediaManifestPath)) {
    const sourceValidation = validateMediaSources(mediaManifestPath);
    if (!sourceValidation.ok) {
      sourceValidation.errors.forEach((item) => errors.push(`素材账本：${item}`));
    } else {
      mediaSources = JSON.parse(fs.readFileSync(mediaManifestPath, "utf8"));
    }
  }
  contract.jobs.forEach((job, index) => {
    if (isObject(job) && ids.has(job.id)) errors.push(`jobs 包含重复 id：${job.id}`);
    if (isObject(job)) ids.add(job.id);
    validateJob(
      job,
      index,
      projectRoot,
      contract.source_version,
      plan,
      planJobToRefs,
      mediaSources,
      errors
    );
  });
  if (plan) {
    for (const jobId of planJobToRefs.keys()) {
      if (!ids.has(jobId)) errors.push(`导演计划引用的任务尚未初始化：${jobId}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    contract,
    plan,
    intent_file: intentPath,
  };
}

function main() {
  if (
    process.argv.length !== 3
    || process.argv.includes("--help")
    || process.argv.includes("-h")
  ) {
    console.log("用法：node scripts/validate-generation-jobs.mjs <generation-jobs.json>");
    return process.argv.length === 3 ? 0 : 1;
  }
  const result = validateGenerationJobs(process.argv[2]);
  if (!result.ok) {
    result.errors.forEach((error) => console.error(`错误：${error}`));
    return 1;
  }
  console.log(JSON.stringify({
    ok: true,
    file: path.resolve(process.argv[2]),
    media_project_id: result.contract.media_project_id,
    jobs: result.contract.jobs.map((job) => ({
      id: job.id,
      status: job.remote.status,
      imported_source_id: job.imported_source_id,
    })),
  }, null, 2));
  return 0;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
