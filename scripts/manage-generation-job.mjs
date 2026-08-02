#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  generationIdempotencyKey,
  sha256Value,
  validateGenerationJobs,
} from "./validate-generation-jobs.mjs";
import { validateVideoDirectionPlan } from "./validate-video-direction-plan.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const JOB_SPEC_FIELDS = [
  "id",
  "intent_refs",
  "provider",
  "operation",
  "input_file",
  "estimate",
  "paid_policy",
  "approval_evidence_file",
];

function usage() {
  console.log(`用法：
node scripts/manage-generation-job.mjs init
  --project <项目目录> --intent <项目内内容或导演计划> --spec <任务说明.json>
  [--media-project-id <项目 id> --source-version <来源版本>]
node scripts/manage-generation-job.mjs authorize
  --project <项目目录> --job-id <id> --evidence <批准证据文件> [--at <ISO>]
node scripts/manage-generation-job.mjs prepare-submit
  --project <项目目录> --job-id <id> [--at <ISO>]
node scripts/manage-generation-job.mjs record-submit
  --project <项目目录> --job-id <id> --remote-job-id <id>
  --capture <提交回执> [--at <ISO>]
node scripts/manage-generation-job.mjs record-status
  --project <项目目录> --job-id <id> --status running|succeeded|failed
  --capture <状态回执> [--remote-uri <输出位置>]
  [--actual-amount <金额> --actual-currency <币种> --actual-basis <计费依据>
   --cost-capture <费用凭据>] [--error <错误>] [--at <ISO>]
node scripts/manage-generation-job.mjs localize
  --project <项目目录> --job-id <id> --input <已下载文件>
  --source-id <素材 id> --media-type <素材类型> --rights-status <状态>
  --license <依据> --usage <用途> [--model <模型>] [--at <ISO>]
  [--speech-text <实际合成输入文件> --voice-id <供应方声音 id>
   --voice-name <显示名称> --language <语言> --exact-voice]

init 的任务说明格式为 {"jobs":[...]}。每项必须完整包含：
${JOB_SPEC_FIELDS.join(", ")}

prepare-submit 第一次只建立一次性提交锁并返回幂等键；再次运行不会允许第二次提交。
实际供应方调用在工具或连接器中完成，再用 record-submit / record-status 保存原始回执。`);
}

function parseArgs(argv) {
  const args = new Map();
  const booleans = new Set(["exact-voice"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    if (booleans.has(key)) {
      args.set(key, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    args.set(key, argv[index + 1]);
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少必需参数 --${key}`);
  }
  return value;
}

function isoDate(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("日期时间参数无效");
  return date.toISOString();
}

function sha256File(filePath) {
  return sha256Value(fs.readFileSync(filePath));
}

function absoluteFile(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${label}不存在：${absolute}`);
  }
  return absolute;
}

function projectRelative(projectRoot, absolute, label) {
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label}必须位于项目目录内`);
  }
  return relative.split(path.sep).join("/");
}

function contentAddressedCopy(projectRoot, sourcePath, folder) {
  const buffer = fs.readFileSync(sourcePath);
  if (buffer.length === 0) throw new Error(`证据或文件为空：${sourcePath}`);
  const digest = sha256Value(buffer);
  const extension = path.extname(sourcePath).toLowerCase() || ".bin";
  const destination = path.join(
    projectRoot,
    folder,
    "by-sha256",
    digest.slice(0, 2),
    `${digest}${extension}`
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    if (sha256File(destination) !== digest) {
      throw new Error(`内容寻址文件冲突：${destination}`);
    }
  } else {
    fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
  }
  return {
    file: projectRelative(projectRoot, destination, folder),
    sha256: digest,
  };
}

function storeNormalizedInput(projectRoot, inputPath) {
  const value = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const normalized = `${canonicalJson(value)}\n`;
  const digest = sha256Value(Buffer.from(normalized.trimEnd(), "utf8"));
  const destination = path.join(
    projectRoot,
    "generation-inputs",
    "by-sha256",
    digest.slice(0, 2),
    `${digest}.json`
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const existing = JSON.parse(fs.readFileSync(destination, "utf8"));
    const existingHash = sha256Value(Buffer.from(canonicalJson(existing), "utf8"));
    if (existingHash !== digest) throw new Error(`规范化输入冲突：${destination}`);
  } else {
    fs.writeFileSync(destination, normalized, { encoding: "utf8", flag: "wx" });
  }
  return {
    file: projectRelative(projectRoot, destination, "规范化输入"),
    sha256: digest,
  };
}

function readContract(projectRoot) {
  const contractPath = path.join(projectRoot, "generation-jobs.json");
  if (!fs.existsSync(contractPath)) {
    throw new Error(`生成任务合同不存在：${contractPath}`);
  }
  const validation = validateGenerationJobs(contractPath);
  if (!validation.ok) {
    throw new Error(
      "现有生成任务合同无效，操作已停止：\n"
        + validation.errors.map((item) => `- ${item}`).join("\n")
    );
  }
  return {
    path: contractPath,
    text: fs.readFileSync(contractPath, "utf8"),
    value: validation.contract,
  };
}

function jobById(contract, jobId) {
  const job = contract.jobs.find((item) => item.id === jobId);
  if (!job) throw new Error(`生成任务不存在：${jobId}`);
  return job;
}

function saveValidated(record) {
  fs.writeFileSync(record.path, `${JSON.stringify(record.value, null, 2)}\n`, "utf8");
  const validation = validateGenerationJobs(record.path);
  if (!validation.ok) {
    fs.writeFileSync(record.path, record.text, "utf8");
    throw new Error(
      "操作后的生成任务合同无效，活动合同已恢复：\n"
        + validation.errors.map((item) => `- ${item}`).join("\n")
    );
  }
}

function exactSpecJob(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`任务说明 jobs[${index}] 必须是对象`);
  }
  const missing = JOB_SPEC_FIELDS.filter((field) => !Object.hasOwn(value, field));
  const unknown = Object.keys(value).filter((field) => !JOB_SPEC_FIELDS.includes(field));
  if (missing.length > 0) {
    throw new Error(`任务说明 jobs[${index}] 缺少字段：${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    throw new Error(`任务说明 jobs[${index}] 包含未知字段：${unknown.join(", ")}`);
  }
}

function buildInitialJob(projectRoot, spec, intentContext, at) {
  if (!ID_PATTERN.test(spec.id || "")) throw new Error(`任务 id 不合法：${spec.id}`);
  if (
    !Array.isArray(spec.intent_refs)
    || spec.intent_refs.length === 0
    || new Set(spec.intent_refs).size !== spec.intent_refs.length
    || spec.intent_refs.some(
      (item) => typeof item !== "string" || item.trim().length === 0
    )
  ) throw new Error(`任务 ${spec.id} 的 intent_refs 必须是不重复的非空字符串数组`);
  if (intentContext.plan) {
    const plannedRefs = intentContext.plan.scenes
      .filter((scene) => scene.generation_job_ids.includes(spec.id))
      .map((scene) => scene.segment_id)
      .sort();
    if (
      JSON.stringify(plannedRefs)
        !== JSON.stringify([...spec.intent_refs].sort())
    ) throw new Error(`任务 ${spec.id} 的场景引用与导演计划不一致`);
  }
  for (const field of ["provider", "operation"]) {
    if (typeof spec[field] !== "string" || spec[field].trim().length === 0) {
      throw new Error(`任务 ${spec.id} 的 ${field} 必须是非空字符串`);
    }
  }
  if (!["off", "confirm", "auto"].includes(spec.paid_policy)) {
    throw new Error(`任务 ${spec.id} 的 paid_policy 无效`);
  }
  const estimate = spec.estimate;
  if (
    estimate === null
    || typeof estimate !== "object"
    || Array.isArray(estimate)
    || Object.keys(estimate).sort().join(",")
      !== ["amount", "billable_basis", "currency"].sort().join(",")
    || typeof estimate.amount !== "number"
    || !Number.isFinite(estimate.amount)
    || estimate.amount < 0
    || typeof estimate.currency !== "string"
    || estimate.currency.length === 0
    || typeof estimate.billable_basis !== "string"
    || estimate.billable_basis.length === 0
  ) throw new Error(`任务 ${spec.id} 的 estimate 无效`);
  const normalized = storeNormalizedInput(
    projectRoot,
    absoluteFile(spec.input_file, `任务 ${spec.id} 的 input_file`)
  );
  let authorization = {
    status: "not_required",
    evidence: null,
    decided_at: null,
  };
  if (estimate.amount > 0 && spec.paid_policy === "off") {
    authorization = {
      status: "denied",
      evidence: null,
      decided_at: at,
    };
  } else if (estimate.amount > 0 && spec.paid_policy === "confirm") {
    authorization = {
      status: "pending",
      evidence: null,
      decided_at: null,
    };
  } else if (estimate.amount > 0 && spec.paid_policy === "auto") {
    if (typeof spec.approval_evidence_file !== "string"
      || spec.approval_evidence_file.length === 0) {
      throw new Error(`任务 ${spec.id} 的 auto 策略必须提供 approval_evidence_file`);
    }
    authorization = {
      status: "approved",
      evidence: contentAddressedCopy(
        projectRoot,
        absoluteFile(spec.approval_evidence_file, `任务 ${spec.id} 的授权证据`),
        "generation-approvals"
      ),
      decided_at: at,
    };
  } else if (spec.approval_evidence_file !== null) {
    throw new Error(`任务 ${spec.id} 当前不应携带 approval_evidence_file`);
  }
  return {
    id: spec.id,
    intent_refs: [...spec.intent_refs],
    provider: spec.provider,
    operation: spec.operation,
    normalized_input: {
      ...normalized,
      source_version: intentContext.sourceVersion,
    },
    estimate: {
      amount: estimate.amount,
      currency: estimate.currency,
      billable_basis: estimate.billable_basis,
    },
    paid_policy: spec.paid_policy,
    authorization,
    idempotency_key: generationIdempotencyKey(
      spec.provider,
      spec.operation,
      intentContext.sourceVersion,
      normalized.sha256
    ),
    remote: {
      job_id: null,
      status: "not_submitted",
      submit_lock_at: null,
      submitted_at: null,
      submission_capture: null,
      last_polled_at: null,
      status_capture: null,
      query_count: 0,
      last_error: "",
    },
    outputs: [],
    actual_cost: null,
    imported_source_id: null,
    updated_at: at,
  };
}

function init(projectRoot, args) {
  const intentPath = absoluteFile(required(args, "intent"), "生成意图");
  const intentRelative = projectRelative(projectRoot, intentPath, "生成意图");
  let planValidation = null;
  let parsedIntent = null;
  try {
    parsedIntent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
  } catch {
    parsedIntent = null;
  }
  if (parsedIntent?.protocol === "visual-multimedia-video-direction") {
    planValidation = validateVideoDirectionPlan(intentPath);
    if (!planValidation.ok) {
      throw new Error(
        "导演计划无效：\n"
          + planValidation.errors.map((item) => `- ${item}`).join("\n")
      );
    }
  }
  const intentContext = planValidation
    ? {
      kind: "video_direction_plan",
      file: intentRelative,
      sha256: sha256File(intentPath),
      mediaProjectId: planValidation.plan.project.media_project_id,
      sourceVersion: planValidation.plan.project.source.source_version,
      plan: planValidation.plan,
    }
    : {
      kind: "content_source",
      file: intentRelative,
      sha256: sha256File(intentPath),
      mediaProjectId: required(args, "media-project-id"),
      sourceVersion: required(args, "source-version"),
      plan: null,
    };
  if (!ID_PATTERN.test(intentContext.mediaProjectId)) {
    throw new Error("--media-project-id 不是合法项目 id");
  }
  const specPath = absoluteFile(required(args, "spec"), "任务说明");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  if (
    spec === null
    || typeof spec !== "object"
    || Array.isArray(spec)
    || Object.keys(spec).length !== 1
    || !Array.isArray(spec.jobs)
    || spec.jobs.length === 0
  ) throw new Error("任务说明根节点必须只包含非空 jobs 数组");
  spec.jobs.forEach(exactSpecJob);
  if (new Set(spec.jobs.map((item) => item.id)).size !== spec.jobs.length) {
    throw new Error("任务说明包含重复 job id");
  }
  const at = isoDate(args.get("at"));
  const jobs = spec.jobs.map((item) =>
    buildInitialJob(projectRoot, item, intentContext, at)
  );
  if (intentContext.plan) {
    const planJobIds = new Set(
      intentContext.plan.scenes.flatMap((scene) => scene.generation_job_ids)
    );
    if (
      JSON.stringify([...planJobIds].sort())
        !== JSON.stringify(jobs.map((job) => job.id).sort())
    ) throw new Error("任务说明必须一次性初始化导演计划引用的全部外部生成任务");
  }
  const contractPath = path.join(projectRoot, "generation-jobs.json");
  const intent = {
    kind: intentContext.kind,
    file: intentContext.file,
    sha256: intentContext.sha256,
  };
  if (fs.existsSync(contractPath)) {
    const existing = readContract(projectRoot).value;
    const expectedDefinitions = jobs.map((job) => ({
      id: job.id,
      intent_refs: job.intent_refs,
      provider: job.provider,
      operation: job.operation,
      normalized_input: job.normalized_input,
      estimate: job.estimate,
      paid_policy: job.paid_policy,
      idempotency_key: job.idempotency_key,
      auto_approval_evidence_sha256:
        job.paid_policy === "auto"
          ? job.authorization.evidence?.sha256 || null
          : null,
    }));
    const actualDefinitions = existing.jobs.map((job) => ({
      id: job.id,
      intent_refs: job.intent_refs,
      provider: job.provider,
      operation: job.operation,
      normalized_input: job.normalized_input,
      estimate: job.estimate,
      paid_policy: job.paid_policy,
      idempotency_key: job.idempotency_key,
      auto_approval_evidence_sha256:
        job.paid_policy === "auto"
          ? job.authorization.evidence?.sha256 || null
          : null,
    }));
    if (
      existing.media_project_id !== intentContext.mediaProjectId
      || existing.source_version !== intentContext.sourceVersion
      || JSON.stringify(existing.intent) !== JSON.stringify(intent)
      || canonicalJson(actualDefinitions) !== canonicalJson(expectedDefinitions)
    ) {
      throw new Error(
        "现有 generation-jobs.json 绑定了不同计划或输入；请建立新任务 id，脚本不会覆盖"
      );
    }
    console.log(JSON.stringify({
      created: false,
      reused: true,
      file: contractPath,
      jobs: existing.jobs.map((job) => ({
        id: job.id,
        status: job.remote.status,
      })),
    }, null, 2));
    return;
  }
  const contract = {
    protocol: "visual-multimedia-generation-jobs",
    version: 1,
    media_project_id: intentContext.mediaProjectId,
    source_version: intentContext.sourceVersion,
    intent,
    jobs,
  };
  const candidate = `${contractPath}.candidate`;
  fs.writeFileSync(candidate, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  const validation = validateGenerationJobs(candidate);
  if (!validation.ok) {
    throw new Error(
      "生成任务合同候选无效，活动合同未写入：\n"
        + validation.errors.map((item) => `- ${item}`).join("\n")
    );
  }
  fs.renameSync(candidate, contractPath);
  console.log(JSON.stringify({
    created: true,
    reused: false,
    file: contractPath,
    jobs: jobs.map((job) => ({ id: job.id, status: job.remote.status })),
  }, null, 2));
}

function authorize(projectRoot, args) {
  const record = readContract(projectRoot);
  const job = jobById(record.value, required(args, "job-id"));
  if (job.estimate.amount === 0) throw new Error("零费用任务不需要额外授权");
  if (job.paid_policy !== "confirm") {
    throw new Error("authorize 只用于 paid_policy=confirm 的任务");
  }
  const evidence = contentAddressedCopy(
    projectRoot,
    absoluteFile(required(args, "evidence"), "批准证据"),
    "generation-approvals"
  );
  const at = isoDate(args.get("at"));
  if (job.authorization.status === "approved") {
    if (job.authorization.evidence.sha256 !== evidence.sha256) {
      throw new Error("任务已由不同证据批准，拒绝改写");
    }
    console.log(JSON.stringify({ approved: true, reused: true, job_id: job.id }, null, 2));
    return;
  }
  if (job.authorization.status !== "pending") {
    throw new Error(`任务当前授权状态不能批准：${job.authorization.status}`);
  }
  job.authorization = {
    status: "approved",
    evidence,
    decided_at: at,
  };
  job.updated_at = at;
  saveValidated(record);
  console.log(JSON.stringify({
    approved: true,
    reused: false,
    job_id: job.id,
    evidence,
  }, null, 2));
}

function prepareSubmit(projectRoot, args) {
  const record = readContract(projectRoot);
  const job = jobById(record.value, required(args, "job-id"));
  if (!["not_required", "approved"].includes(job.authorization.status)) {
    throw new Error(
      `任务没有通过费用门：authorization.status=${job.authorization.status}`
    );
  }
  if (job.remote.status === "not_submitted") {
    const at = isoDate(args.get("at"));
    job.remote.status = "prepared";
    job.remote.submit_lock_at = at;
    job.updated_at = at;
    saveValidated(record);
    console.log(JSON.stringify({
      job_id: job.id,
      action: "submit_once",
      should_submit: true,
      idempotency_key: job.idempotency_key,
      provider: job.provider,
      operation: job.operation,
      normalized_input: job.normalized_input.file,
    }, null, 2));
    return;
  }
  if (job.remote.status === "prepared") {
    console.log(JSON.stringify({
      job_id: job.id,
      action: "query_by_idempotency_key",
      should_submit: false,
      idempotency_key: job.idempotency_key,
      reason: "提交锁已经存在；先向供应方查询，不能再次产生收费调用。",
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    job_id: job.id,
    action: "query_remote_job",
    should_submit: false,
    idempotency_key: job.idempotency_key,
    remote_job_id: job.remote.job_id,
    remote_status: job.remote.status,
  }, null, 2));
}

function recordSubmit(projectRoot, args) {
  const record = readContract(projectRoot);
  const job = jobById(record.value, required(args, "job-id"));
  const remoteJobId = required(args, "remote-job-id");
  const capture = contentAddressedCopy(
    projectRoot,
    absoluteFile(required(args, "capture"), "提交回执"),
    "generation-captures"
  );
  const at = isoDate(args.get("at"));
  if (job.remote.job_id !== null) {
    if (
      job.remote.job_id !== remoteJobId
      || job.remote.submission_capture?.sha256 !== capture.sha256
    ) throw new Error("任务已经绑定不同的远程 job id 或提交回执");
    console.log(JSON.stringify({
      recorded: true,
      reused: true,
      job_id: job.id,
      remote_job_id: remoteJobId,
    }, null, 2));
    return;
  }
  if (job.remote.status !== "prepared" || !job.remote.submit_lock_at) {
    throw new Error("必须先通过 prepare-submit 建立一次性提交锁");
  }
  job.remote.job_id = remoteJobId;
  job.remote.status = "submitted";
  job.remote.submitted_at = at;
  job.remote.submission_capture = capture;
  job.updated_at = at;
  saveValidated(record);
  console.log(JSON.stringify({
    recorded: true,
    reused: false,
    job_id: job.id,
    remote_job_id: remoteJobId,
  }, null, 2));
}

function nonNegativeAmount(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} 必须是非负数`);
  }
  return number;
}

function recordStatus(projectRoot, args) {
  const record = readContract(projectRoot);
  const job = jobById(record.value, required(args, "job-id"));
  const status = required(args, "status");
  if (!["running", "succeeded", "failed"].includes(status)) {
    throw new Error("--status 必须是 running、succeeded 或 failed");
  }
  if (!job.remote.job_id || !["submitted", "running", "failed", "succeeded"].includes(
    job.remote.status
  )) throw new Error("任务还没有可查询的远程 job id");
  const capture = contentAddressedCopy(
    projectRoot,
    absoluteFile(required(args, "capture"), "状态回执"),
    "generation-captures"
  );
  const at = isoDate(args.get("at"));
  if (job.remote.status === "succeeded") {
    const requestedAmount = nonNegativeAmount(
      required(args, "actual-amount"),
      "--actual-amount"
    );
    const requestedCurrency = required(args, "actual-currency");
    const requestedBasis = required(args, "actual-basis");
    const requestedUri = required(args, "remote-uri");
    const sameCostCapture = job.actual_cost?.capture?.sha256
      === sha256File(absoluteFile(required(args, "cost-capture"), "费用凭据"));
    if (
      status !== "succeeded"
      || job.remote.status_capture?.sha256 !== capture.sha256
      || !sameCostCapture
      || job.outputs[0]?.remote_uri !== requestedUri
      || job.actual_cost?.amount !== requestedAmount
      || job.actual_cost?.currency !== requestedCurrency
      || job.actual_cost?.billable_basis !== requestedBasis
    ) throw new Error("成功任务只能幂等复用同一状态与费用凭据");
    console.log(JSON.stringify({
      recorded: true,
      reused: true,
      job_id: job.id,
      remote_status: "succeeded",
    }, null, 2));
    return;
  }
  job.remote.status = status;
  job.remote.last_polled_at = at;
  job.remote.status_capture = capture;
  job.remote.query_count += 1;
  job.remote.last_error = status === "failed" ? required(args, "error") : "";
  if (status === "succeeded") {
    const remoteUri = required(args, "remote-uri");
    const amount = nonNegativeAmount(required(args, "actual-amount"), "--actual-amount");
    const currency = required(args, "actual-currency");
    const basis = required(args, "actual-basis");
    const costCapture = contentAddressedCopy(
      projectRoot,
      absoluteFile(required(args, "cost-capture"), "费用凭据"),
      "generation-captures"
    );
    job.outputs = [{
      remote_uri: remoteUri,
      localized: null,
      verified_at: null,
    }];
    job.actual_cost = {
      amount,
      currency,
      billable_basis: basis,
      capture: costCapture,
    };
  }
  job.updated_at = at;
  saveValidated(record);
  console.log(JSON.stringify({
    recorded: true,
    reused: false,
    job_id: job.id,
    remote_status: status,
    query_count: job.remote.query_count,
  }, null, 2));
}

function localize(projectRoot, args) {
  const record = readContract(projectRoot);
  const job = jobById(record.value, required(args, "job-id"));
  const sourceId = required(args, "source-id");
  if (job.imported_source_id !== null) {
    if (job.imported_source_id !== sourceId) {
      throw new Error("任务已入账到另一个 source id，不能改绑");
    }
    console.log(JSON.stringify({
      localized: true,
      reused: true,
      job_id: job.id,
      source_id: sourceId,
      output: job.outputs[0].localized,
    }, null, 2));
    return;
  }
  if (
    job.remote.status !== "succeeded"
    || job.outputs.length !== 1
    || job.actual_cost === null
    || !job.remote.status_capture
  ) throw new Error("只有带成功回执、远程输出和实际费用凭据的任务才能本地化");
  const input = absoluteFile(required(args, "input"), "已下载输出");
  if (fs.statSync(input).size === 0) throw new Error("已下载输出不能为空");
  const importer = path.join(scriptDir, "import-media-asset.mjs");
  const at = isoDate(args.get("at") || job.remote.submitted_at);
  const importerArgs = [
    importer,
    "--project",
    projectRoot,
    "--input",
    input,
    "--id",
    sourceId,
    "--media-type",
    required(args, "media-type"),
    "--method",
    "generated",
    "--rights-status",
    required(args, "rights-status"),
    "--license",
    required(args, "license"),
    "--usage",
    required(args, "usage"),
    "--provider",
    job.provider,
    "--job-id",
    job.remote.job_id,
    "--capture",
    path.resolve(projectRoot, job.remote.status_capture.file),
    "--captured-at",
    at,
    "--created-at",
    at,
  ];
  if (args.has("model")) {
    importerArgs.push("--generation-model", args.get("model"));
  }
  if (args.has("speech-text")) {
    importerArgs.push(
      "--speech-text",
      absoluteFile(args.get("speech-text"), "实际合成输入"),
      "--voice-id",
      required(args, "voice-id"),
      "--voice-name",
      required(args, "voice-name"),
      "--language",
      required(args, "language")
    );
    if (args.has("exact-voice")) importerArgs.push("--exact-voice");
  } else if (
    ["voice-id", "voice-name", "language"].some((key) => args.has(key))
    || args.has("exact-voice")
  ) {
    throw new Error("声音身份参数必须与 --speech-text 一起提供");
  }
  const result = spawnSync(process.execPath, importerArgs, {
    cwd: projectRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `素材本地化导入失败：${(result.stderr || result.stdout || "").trim()}`
    );
  }
  const importResult = JSON.parse(result.stdout);
  const source = importResult.source;
  const localizedPath = path.resolve(projectRoot, source.file);
  job.outputs[0].localized = {
    file: source.file,
    sha256: source.integrity.sha256,
    bytes: source.integrity.bytes,
  };
  if (sha256File(localizedPath) !== job.outputs[0].localized.sha256) {
    throw new Error("素材导入后的真实文件哈希不一致");
  }
  job.outputs[0].verified_at = at;
  job.imported_source_id = sourceId;
  job.updated_at = at;
  saveValidated(record);
  console.log(JSON.stringify({
    localized: true,
    reused: importResult.reused === true,
    job_id: job.id,
    source_id: sourceId,
    output: job.outputs[0].localized,
    consumer_changed: false,
    next_action: "由活动网页清单、视频时间线或音频项目显式采用该 source id。",
  }, null, 2));
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const projectRoot = path.resolve(required(args, "project"));
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`项目目录不存在：${projectRoot}`);
  }
  if (command === "init") init(projectRoot, args);
  else if (command === "authorize") authorize(projectRoot, args);
  else if (command === "prepare-submit") prepareSubmit(projectRoot, args);
  else if (command === "record-submit") recordSubmit(projectRoot, args);
  else if (command === "record-status") recordStatus(projectRoot, args);
  else if (command === "localize") localize(projectRoot, args);
  else throw new Error(`未知命令：${command}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
