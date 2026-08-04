#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateGenerationJobs } from "./validate-generation-jobs.mjs";
import { validateMediaSources } from "./validate-media-sources.mjs";
import { validateVideoDirectionPlan } from "./validate-video-direction-plan.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDir);
const caseRoot = path.join(skillRoot, "assets", "video-generation-case");
const fixedTimes = {
  plan: "2026-07-30T00:00:00.000Z",
  approval: "2026-07-30T00:01:00.000Z",
  prepare: "2026-07-30T00:02:00.000Z",
  submit: "2026-07-30T00:03:00.000Z",
  running: "2026-07-30T00:04:00.000Z",
  success: "2026-07-30T00:05:00.000Z",
  localized: "2026-07-30T00:06:00.000Z",
};

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function commandPath(name) {
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [name],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) throw new Error(`找不到 ${name}；自检不会安装工具`);
  return result.stdout.split(/\r?\n/).find(Boolean).trim();
}

function run(command, args, label, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${label}返回 ${result.status}，预期 ${expectedStatus}：`
        + `${(result.stderr || result.stdout || "").trim()}`
    );
  }
  return result;
}

function runJson(command, args, label, cwd) {
  const result = run(command, args, label, cwd);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label}没有返回 JSON：${error.message}\n${result.stdout}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyCaseInput(projectRoot, name) {
  const source = path.join(caseRoot, name);
  const destination = path.join(projectRoot, name);
  fs.copyFileSync(source, destination);
  return destination;
}

function assertValidation(validation, label) {
  if (!validation.ok) {
    throw new Error(
      `${label}未通过：\n${validation.errors.map((item) => `- ${item}`).join("\n")}`
    );
  }
}

function main() {
  const runId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const preferredTestRoot = process.env.VISUAL_MULTIMEDIA_TEST_ROOT
    || (process.platform === "win32" && fs.existsSync("D:\\Tools")
      ? "D:\\Tools\\visual-multimedia-tests"
      : os.tmpdir());
  const projectRoot = path.join(
    preferredTestRoot,
    "visual-multimedia-video-generation-chain",
    runId
  );
  fs.mkdirSync(projectRoot, { recursive: true });
  const source = copyCaseInput(projectRoot, "source.md");
  const draft = copyCaseInput(projectRoot, "direction-draft.json");
  copyCaseInput(projectRoot, "generation-request.json");
  const jobSpec = copyCaseInput(projectRoot, "generation-job-spec.json");
  const approval = copyCaseInput(projectRoot, "approval.txt");
  writeJson(path.join(projectRoot, "media-sources.json"), {
    protocol: "visual-multimedia-media-sources",
    version: 3,
    sources: [],
  });

  const creator = path.join(scriptDir, "create-video-direction-plan.mjs");
  const manager = path.join(scriptDir, "manage-generation-job.mjs");
  runJson(
    process.execPath,
    [
      creator,
      "--project",
      projectRoot,
      "--source",
      source,
      "--draft",
      draft,
      "--created-at",
      fixedTimes.plan,
    ],
    "导演计划生产者",
    projectRoot
  );
  const planPath = path.join(projectRoot, "video-direction-plan.json");
  assertValidation(validateVideoDirectionPlan(planPath), "导演计划");

  runJson(
    process.execPath,
    [
      manager,
      "init",
      "--project",
      projectRoot,
      "--intent",
      planPath,
      "--spec",
      jobSpec,
      "--at",
      fixedTimes.plan,
    ],
    "生成任务初始化",
    projectRoot
  );
  const jobsPath = path.join(projectRoot, "generation-jobs.json");
  assertValidation(validateGenerationJobs(jobsPath), "待批准生成任务");
  const requestPath = path.join(projectRoot, "generation-request.json");
  const originalRequest = fs.readFileSync(requestPath, "utf8");
  const changedRequest = JSON.parse(originalRequest);
  changedRequest.duration_seconds = 4;
  writeJson(requestPath, changedRequest);
  const contractBeforeInputChange = sha256File(jobsPath);
  const changedInput = run(
    process.execPath,
    [
      manager,
      "init",
      "--project",
      projectRoot,
      "--intent",
      planPath,
      "--spec",
      jobSpec,
      "--at",
      fixedTimes.plan,
    ],
    "改变输入后拒绝复用旧任务",
    projectRoot,
    1
  );
  if (
    !changedInput.stderr.includes("绑定了不同计划或输入")
    || sha256File(jobsPath) !== contractBeforeInputChange
  ) throw new Error("规范化输入变化没有使旧任务失效，或错误改写了活动合同");
  fs.writeFileSync(requestPath, originalRequest, "utf8");
  const pendingHash = sha256File(jobsPath);
  const blocked = run(
    process.execPath,
    [
      manager,
      "prepare-submit",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--at",
      fixedTimes.prepare,
    ],
    "未批准费用门",
    projectRoot,
    1
  );
  if (!blocked.stderr.includes("没有通过费用门") || sha256File(jobsPath) !== pendingHash) {
    throw new Error("费用门没有在不改写合同的情况下阻止提交");
  }

  runJson(
    process.execPath,
    [
      manager,
      "authorize",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--evidence",
      approval,
      "--at",
      fixedTimes.approval,
    ],
    "费用批准",
    projectRoot
  );
  const approvalRerun = runJson(
    process.execPath,
    [
      manager,
      "authorize",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--evidence",
      approval,
    ],
    "批准操作幂等恢复",
    projectRoot
  );
  if (approvalRerun.reused !== true) throw new Error("同一批准证据不能幂等复用");
  const prepared = runJson(
    process.execPath,
    [
      manager,
      "prepare-submit",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--at",
      fixedTimes.prepare,
    ],
    "一次性提交准备",
    projectRoot
  );
  if (prepared.should_submit !== true || prepared.action !== "submit_once") {
    throw new Error("第一次准备提交没有返回一次性调用许可");
  }
  const lockedRerun = runJson(
    process.execPath,
    [
      manager,
      "prepare-submit",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--at",
      fixedTimes.prepare,
    ],
    "提交响应未知时再次运行",
    projectRoot
  );
  if (
    lockedRerun.should_submit !== false
    || lockedRerun.action !== "query_by_idempotency_key"
  ) throw new Error("提交锁没有阻止第二次收费调用");

  const ffmpeg = commandPath("ffmpeg");
  const providerOutput = path.join(projectRoot, "provider-output", "generated.mp4");
  fs.mkdirSync(path.dirname(providerOutput), { recursive: true });
  run(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x17324d:s=640x360:r=24:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-vf",
      "drawbox=x=60:y=145:w=140:h=70:color=0xf7c873:t=fill,"
        + "drawbox=x=250:y=145:w=140:h=70:color=0x6bc5d2:t=fill,"
        + "drawbox=x=440:y=145:w=140:h=70:color=0xf1eee6:t=fill,"
        + "format=yuv420p",
      "-c:v",
      "libx264",
      "-r",
      "24",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      "-y",
      providerOutput,
    ],
    "确定性本地供应方生成真实视频",
    projectRoot
  );
  if (!fs.existsSync(providerOutput) || fs.statSync(providerOutput).size === 0) {
    throw new Error("本地供应方没有生成真实视频");
  }
  const remoteJobId = `local-${prepared.idempotency_key.slice(0, 16)}`;
  const submitCapture = path.join(projectRoot, "provider-output", "submit.json");
  writeJson(submitCapture, {
    provider: "deterministic-local-provider",
    remote_job_id: remoteJobId,
    idempotency_key: prepared.idempotency_key,
    accepted: true,
  });
  runJson(
    process.execPath,
    [
      manager,
      "record-submit",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--remote-job-id",
      remoteJobId,
      "--capture",
      submitCapture,
      "--at",
      fixedTimes.submit,
    ],
    "远程提交回执",
    projectRoot
  );
  const submitRerun = runJson(
    process.execPath,
    [
      manager,
      "record-submit",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--remote-job-id",
      remoteJobId,
      "--capture",
      submitCapture,
    ],
    "提交回执幂等恢复",
    projectRoot
  );
  if (submitRerun.reused !== true) throw new Error("同一远程提交回执不能幂等复用");
  const runningCapture = path.join(projectRoot, "provider-output", "running.json");
  writeJson(runningCapture, {
    remote_job_id: remoteJobId,
    status: "running",
    progress: 0.5,
  });
  runJson(
    process.execPath,
    [
      manager,
      "record-status",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--status",
      "running",
      "--capture",
      runningCapture,
      "--at",
      fixedTimes.running,
    ],
    "远程运行状态",
    projectRoot
  );
  const successCapture = path.join(projectRoot, "provider-output", "success.json");
  const costCapture = path.join(projectRoot, "provider-output", "cost.json");
  writeJson(successCapture, {
    remote_job_id: remoteJobId,
    status: "succeeded",
    output_uri: pathToFileURL(providerOutput).href,
    output_sha256: sha256File(providerOutput),
  });
  writeJson(costCapture, {
    remote_job_id: remoteJobId,
    amount: 0.5,
    currency: "USD",
    billable_basis: "one generated clip",
  });
  runJson(
    process.execPath,
    [
      manager,
      "record-status",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--status",
      "succeeded",
      "--capture",
      successCapture,
      "--remote-uri",
      pathToFileURL(providerOutput).href,
      "--actual-amount",
      "0.5",
      "--actual-currency",
      "USD",
      "--actual-basis",
      "one generated clip",
      "--cost-capture",
      costCapture,
      "--at",
      fixedTimes.success,
    ],
    "远程成功与实际费用",
    projectRoot
  );
  const successRerun = runJson(
    process.execPath,
    [
      manager,
      "record-status",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--status",
      "succeeded",
      "--capture",
      successCapture,
      "--remote-uri",
      pathToFileURL(providerOutput).href,
      "--actual-amount",
      "0.5",
      "--actual-currency",
      "USD",
      "--actual-basis",
      "one generated clip",
      "--cost-capture",
      costCapture,
    ],
    "成功状态与实际费用幂等恢复",
    projectRoot
  );
  if (successRerun.reused !== true) {
    throw new Error("同一成功状态与费用凭据不能幂等复用");
  }
  const sourceManifestPath = path.join(projectRoot, "media-sources.json");
  const sourceManifestBeforeBypass = sha256File(sourceManifestPath);
  const bypass = run(
    process.execPath,
    [
      path.join(scriptDir, "import-media-asset.mjs"),
      "--project",
      projectRoot,
      "--input",
      providerOutput,
      "--id",
      "bypass-generated-video",
      "--media-type",
      "video",
      "--method",
      "generated",
      "--rights-status",
      "confirmed",
      "--license",
      "capability-case-owned",
      "--usage",
      "不经过任务管理器的旁路导入",
      "--provider",
      "deterministic-local-provider",
      "--job-id",
      remoteJobId,
    ],
    "拒绝绕过生成任务合同直接导入",
    projectRoot,
    1
  );
  if (
    !bypass.stderr.includes("必须提供 --provider、--job-id 和 --capture")
    || sha256File(sourceManifestPath) !== sourceManifestBeforeBypass
  ) throw new Error("素材导入器仍允许绕过外部生成任务边界");
  runJson(
    process.execPath,
    [
      manager,
      "localize",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--input",
      providerOutput,
      "--source-id",
      "generated-scene-video",
      "--media-type",
      "video",
      "--rights-status",
      "confirmed",
      "--license",
      "capability-case-owned",
      "--usage",
      "导演计划 generation-lifecycle 场景的正式画面",
      "--model",
      "deterministic-color-video-v1",
      "--at",
      fixedTimes.localized,
    ],
    "下载校验并进入素材账本",
    projectRoot
  );
  const localizeRerun = runJson(
    process.execPath,
    [
      manager,
      "localize",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--source-id",
      "generated-scene-video",
    ],
    "本地化入账幂等恢复",
    projectRoot
  );
  if (localizeRerun.reused !== true) throw new Error("同一 source id 不能幂等复用");
  const generationValidation = validateGenerationJobs(jobsPath);
  assertValidation(generationValidation, "已本地化生成任务");
  assertValidation(
    validateMediaSources(sourceManifestPath),
    "已导入素材账本"
  );
  const rerun = runJson(
    process.execPath,
    [
      manager,
      "prepare-submit",
      "--project",
      projectRoot,
      "--job-id",
      "case-scene-video",
      "--at",
      fixedTimes.localized,
    ],
    "完成任务再次运行",
    projectRoot
  );
  if (
    rerun.should_submit !== false
    || rerun.action !== "query_remote_job"
    || rerun.remote_job_id !== remoteJobId
  ) throw new Error("再次运行没有复用同一远程任务");

  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
  const importedSourceId = jobs.jobs[0].imported_source_id;
  const timelinePath = path.join(projectRoot, "video-timeline.json");
  writeJson(timelinePath, {
    protocol: "visual-multimedia-generation-case-timeline",
    version: 1,
    direction_plan: "video-direction-plan.json",
    adopted_source_ids: [importedSourceId],
    segments: plan.scenes.map((scene) => ({
      segment_id: scene.segment_id,
      source_id: scene.generation_job_ids.includes(jobs.jobs[0].id)
        ? importedSourceId
        : null,
    })),
  });
  const resolver = runJson(
    process.execPath,
    [
      path.join(scriptDir, "resolve-media-representation.mjs"),
      path.join(projectRoot, "media-sources.json"),
      "--source-id",
      importedSourceId,
      "--mode",
      "source",
      "--json",
    ],
    "时间线从素材账本解析正式原片",
    projectRoot
  );
  if (resolver.sha256 !== jobs.jobs[0].outputs[0].localized.sha256) {
    throw new Error("时间线解析的素材不是生成任务本地化的同一文件");
  }
  const finalOutput = path.join(projectRoot, "renders", "final.mp4");
  fs.mkdirSync(path.dirname(finalOutput), { recursive: true });
  run(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      resolver.file,
      "-vf",
      "scale=640:360,format=yuv420p",
      "-c:v",
      "libx264",
      "-r",
      "24",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-y",
      finalOutput,
    ],
    "视频时间线消费正式 source id",
    projectRoot
  );
  const deliveryPath = path.join(projectRoot, "media-delivery.json");
  writeJson(deliveryPath, {
    protocol: "visual-multimedia-delivery",
    version: 2,
    profile: "preview",
    output: { file: "renders/final.mp4" },
    editability: {
      classification: "flat_render",
      project_file: null,
      project_file_sha256: null,
      limitations: [
        "能力案例 MP4 是合成结果，不能还原生成任务、素材账本和时间线的独立状态。"
      ],
    },
    project_state: null,
    media_sources: "media-sources.json",
    transcript: null,
    clip_selections: null,
    media_review: null,
    adopted_source_ids: [importedSourceId],
    expected: {
      media_kind: "video",
      audio_required: true,
      duration_seconds: 3,
      duration_tolerance_seconds: 0.15,
      width: 640,
      height: 360,
      frame_rate: 24,
      frame_rate_tolerance: 0.02,
    },
    analysis: {
      loudness: {
        target_lufs: null,
        tolerance_lu: null,
        true_peak_ceiling_dbfs: null,
      },
      silence: {
        noise_db: -50,
        minimum_duration_seconds: 0.5,
        maximum_unacknowledged_seconds: null,
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
        required: false,
        file: "",
        font_status: "not-applicable",
      },
      contact_sheet: {
        file: "reports/contact-sheet.jpg",
        frames: 8,
        columns: 4,
      },
      rights_review: {
        status: "passed",
        notes: "能力案例输出由本地确定性供应方生成，许可记录为 capability-case-owned。",
      },
    },
    report: "reports/media-delivery-report.json",
  });
  const python = process.env.VISUAL_MULTIMEDIA_PYTHON
    || (process.platform === "win32" ? "python.exe" : "python3");
  run(
    python,
    [path.join(scriptDir, "verify-media-delivery.py"), deliveryPath],
    "生成素材到交付消费者的真实链路",
    projectRoot
  );
  const deliveryReport = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "reports", "media-delivery-report.json"), "utf8")
  );
  if (
    deliveryReport.summary.technical_ready !== true
    || deliveryReport.editability.classification !== "flat_render"
    || deliveryReport.output.sha256 !== sha256File(finalOutput)
  ) throw new Error("交付报告没有证明真实成片、技术就绪和扁平化边界");
  const nativeDelivery = JSON.parse(fs.readFileSync(deliveryPath, "utf8"));
  nativeDelivery.editability = {
    classification: "editable_native",
    project_file: "video-timeline.json",
    project_file_sha256: sha256File(timelinePath),
    limitations: [
      "原生时间线可继续调整素材采用与片段关系；外部供应方内部的生成过程仍不可逆。",
    ],
  };
  nativeDelivery.report = "reports/native-media-delivery-report.json";
  const nativeDeliveryPath = path.join(projectRoot, "native-media-delivery.json");
  writeJson(nativeDeliveryPath, nativeDelivery);
  run(
    python,
    [path.join(scriptDir, "verify-media-delivery.py"), nativeDeliveryPath],
    "可编辑原生项目交付分类",
    projectRoot
  );
  const nativeDeliveryReport = JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, "reports", "native-media-delivery-report.json"),
      "utf8"
    )
  );
  if (
    nativeDeliveryReport.summary.technical_ready !== true
    || nativeDeliveryReport.editability.classification !== "editable_native"
    || nativeDeliveryReport.editability.project_file_sha256 !== sha256File(timelinePath)
  ) throw new Error("交付验证器没有读取真实原生项目文件及其哈希");
  const genericRoot = path.join(projectRoot, "generic-content-source-case");
  fs.mkdirSync(genericRoot, { recursive: true });
  fs.copyFileSync(source, path.join(genericRoot, "content-source.md"));
  fs.copyFileSync(
    path.join(projectRoot, "generation-request.json"),
    path.join(genericRoot, "generation-request.json")
  );
  fs.copyFileSync(approval, path.join(genericRoot, "approval.txt"));
  writeJson(path.join(genericRoot, "media-sources.json"), {
    protocol: "visual-multimedia-media-sources",
    version: 3,
    sources: [],
  });
  const genericSpec = path.join(genericRoot, "generation-job-spec.json");
  writeJson(genericSpec, {
    jobs: [
      {
        id: "generic-cover-image",
        intent_refs: ["cover-image-slot"],
        provider: "deterministic-local-provider",
        operation: "generate-image",
        input_file: "generation-request.json",
        estimate: {
          amount: 0,
          currency: "USD",
          billable_basis: "local capability operation",
        },
        paid_policy: "off",
        approval_evidence_file: null,
      },
      {
        id: "generic-paid-disabled",
        intent_refs: ["disabled-paid-slot"],
        provider: "deterministic-local-provider",
        operation: "generate-image",
        input_file: "generation-request.json",
        estimate: {
          amount: 0.25,
          currency: "USD",
          billable_basis: "one generated image",
        },
        paid_policy: "off",
        approval_evidence_file: null,
      },
      {
        id: "generic-auto-approved",
        intent_refs: ["auto-approved-slot"],
        provider: "deterministic-local-provider",
        operation: "generate-image",
        input_file: "generation-request.json",
        estimate: {
          amount: 0.25,
          currency: "USD",
          billable_basis: "one generated image",
        },
        paid_policy: "auto",
        approval_evidence_file: "approval.txt",
      },
    ],
  });
  runJson(
    process.execPath,
    [
      manager,
      "init",
      "--project",
      genericRoot,
      "--intent",
      path.join(genericRoot, "content-source.md"),
      "--spec",
      genericSpec,
      "--media-project-id",
      "generic-generation-case",
      "--source-version",
      "v1",
      "--at",
      fixedTimes.plan,
    ],
    "非视频内容真源的生成任务初始化",
    genericRoot
  );
  const genericValidation = validateGenerationJobs(
    path.join(genericRoot, "generation-jobs.json")
  );
  assertValidation(genericValidation, "非视频生成任务合同");
  if (
    genericValidation.contract.intent.kind !== "content_source"
    || genericValidation.contract.source_version !== "v1"
  ) throw new Error("通用外部生成任务没有绑定项目内容真源和来源版本");
  const genericJobs = new Map(
    genericValidation.contract.jobs.map((job) => [job.id, job])
  );
  if (
    genericJobs.get("generic-cover-image")?.authorization.status !== "not_required"
    || genericJobs.get("generic-paid-disabled")?.authorization.status !== "denied"
    || genericJobs.get("generic-auto-approved")?.authorization.status !== "approved"
    || !genericJobs.get("generic-auto-approved")?.authorization.evidence
  ) throw new Error("off、confirm、auto 三种费用策略没有形成唯一授权状态");
  const disabledHash = sha256File(
    path.join(genericRoot, "generation-jobs.json")
  );
  const disabledPrepare = run(
    process.execPath,
    [
      manager,
      "prepare-submit",
      "--project",
      genericRoot,
      "--job-id",
      "generic-paid-disabled",
      "--at",
      fixedTimes.prepare,
    ],
    "paid_policy=off 阻止正费用提交",
    genericRoot,
    1
  );
  if (
    !disabledPrepare.stderr.includes("没有通过费用门")
    || sha256File(path.join(genericRoot, "generation-jobs.json")) !== disabledHash
  ) throw new Error("paid_policy=off 没有无副作用地阻止正费用提交");
  const autoPrepare = runJson(
    process.execPath,
    [
      manager,
      "prepare-submit",
      "--project",
      genericRoot,
      "--job-id",
      "generic-auto-approved",
      "--at",
      fixedTimes.prepare,
    ],
    "paid_policy=auto 使用已有范围证据",
    genericRoot
  );
  const autoRerun = runJson(
    process.execPath,
    [
      manager,
      "prepare-submit",
      "--project",
      genericRoot,
      "--job-id",
      "generic-auto-approved",
      "--at",
      fixedTimes.prepare,
    ],
    "auto 任务重复运行保持提交锁",
    genericRoot
  );
  if (
    autoPrepare.should_submit !== true
    || autoRerun.should_submit !== false
    || autoRerun.action !== "query_by_idempotency_key"
  ) throw new Error("paid_policy=auto 没有遵循一次性提交锁");
  const humanRoot = path.join(projectRoot, "human-presenter-case");
  fs.mkdirSync(humanRoot, { recursive: true });
  fs.copyFileSync(source, path.join(humanRoot, "source.md"));
  writeJson(path.join(humanRoot, "media-sources.json"), {
    protocol: "visual-multimedia-media-sources",
    version: 3,
    sources: [],
  });
  runJson(
    process.execPath,
    [
      path.join(scriptDir, "import-media-asset.mjs"),
      "--project",
      humanRoot,
      "--input",
      path.join(skillRoot, "assets", "creator-identity", "cheshire-avatar.png"),
      "--id",
      "authorized-human-source",
      "--media-type",
      "photo",
      "--method",
      "project-owned",
      "--rights-status",
      "confirmed",
      "--license",
      "project-owned",
      "--usage",
      "出镜路由验证的已授权人物画面",
      "--captured-at",
      fixedTimes.plan,
    ],
    "已授权人物素材生产者",
    humanRoot
  );
  const humanDraft = JSON.parse(fs.readFileSync(draft, "utf8"));
  humanDraft.media_project_id = "human-presenter-case";
  humanDraft.presenter = {
    mode: "human",
    source_id: "authorized-human-source",
    approval: {
      status: "approved",
      confirmed_at: fixedTimes.plan,
      evidence: "能力案例明确采用已授权人物画面",
    },
  };
  humanDraft.scenes[0].generation_job_ids = [];
  humanDraft.scenes[0].visual_plan = {
    source_kind: "human",
    source_ids: ["authorized-human-source"],
    relationship_kind: null,
    placement_mode: "full-frame",
    aspect_ratio: "16:9",
    selection_reason: "能力案例明确使用已授权真人素材验证出镜路由。",
    recipe: null,
  };
  const humanDraftPath = path.join(humanRoot, "direction-draft.json");
  writeJson(humanDraftPath, humanDraft);
  runJson(
    process.execPath,
    [
      creator,
      "--project",
      humanRoot,
      "--source",
      path.join(humanRoot, "source.md"),
      "--draft",
      humanDraftPath,
      "--created-at",
      fixedTimes.plan,
    ],
    "真人出镜导演计划",
    humanRoot
  );
  assertValidation(
    validateVideoDirectionPlan(path.join(humanRoot, "video-direction-plan.json")),
    "真人出镜素材与授权路由"
  );
  const chainReport = {
    protocol: "visual-multimedia-generation-chain-report",
    version: 1,
    project_root: projectRoot,
    source_snapshot_sha256: plan.project.source.snapshot.sha256,
    direction_plan_sha256: sha256File(planPath),
    blocked_before_approval: true,
    idempotency_key: jobs.jobs[0].idempotency_key,
    remote_job_id: remoteJobId,
    remote_query_count: jobs.jobs[0].remote.query_count,
    actual_cost: jobs.jobs[0].actual_cost,
    imported_source_id: importedSourceId,
    localized_sha256: jobs.jobs[0].outputs[0].localized.sha256,
    timeline: timelinePath,
    final_output: {
      file: finalOutput,
      sha256: sha256File(finalOutput),
      bytes: fs.statSync(finalOutput).size,
    },
    delivery_report: path.join(projectRoot, "reports", "media-delivery-report.json"),
    native_delivery_report: path.join(
      projectRoot,
      "reports",
      "native-media-delivery-report.json"
    ),
    generic_content_intent_validated: true,
    paid_policies_validated: ["off:zero", "off:paid-blocked", "confirm", "auto"],
    presenter_routes_validated: ["none", "human"],
  };
  writeJson(path.join(projectRoot, "reports", "generation-chain-report.json"), chainReport);
  console.log(JSON.stringify(chainReport, null, 2));
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
