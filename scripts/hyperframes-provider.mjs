#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {
  assertEditableMediaPackageClosed,
  readEditableMediaPackage,
} from "./editable-media-contract.mjs";
import {
  probeHyperframesProvider,
  runHyperframesCommand,
} from "./hyperframes-provider-contract.mjs";
import {loadLocalMediaEnvironment} from "./local-media-environment.mjs";
import {
  assertSkillTaskPath,
  TASK_WORKSPACE_ROOT,
} from "./media-task-workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SAMPLE_PROTOCOL = "visual-multimedia-hyperframes-sample";
const RENDER_RECEIPT_PROTOCOL = "visual-multimedia-hyperframes-render-receipt";

function fail(message) {
  throw new Error(message);
}

function required(value, label) {
  if (value == null || value === true || !String(value).trim()) {
    fail(`缺少 ${label}`);
  }
  return String(value).trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function packageDigest(root) {
  const hash = crypto.createHash("sha256");
  const visit = (current) => {
    const entries = fs.readdirSync(current, {withFileTypes: true})
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (entry.isSymbolicLink()) fail(`HyperFrames 工作副本不能包含符号链接：${relative}`);
      hash.update(entry.isDirectory() ? "D" : "F");
      hash.update(relative);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) hash.update(fs.readFileSync(target));
      else fail(`HyperFrames 工作副本包含不支持的文件类型：${relative}`);
    }
  };
  visit(root);
  return hash.digest("hex");
}

function parseArgs(values) {
  const positional = [];
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = values[index + 1];
    if (next == null || next.startsWith("--")) options[name] = true;
    else {
      options[name] = next;
      index += 1;
    }
  }
  return {positional, options};
}

function preparedPackage(sourceValue) {
  const source = assertSkillTaskPath(path.resolve(sourceValue), "HyperFrames 工作副本");
  const document = readEditableMediaPackage(source);
  assertEditableMediaPackageClosed(document.packageRoot, document.manifest);
  const variant = (document.manifest.variants || []).find(
    (item) => item.id === document.manifest.default_variant_id,
  );
  if (!variant) fail("HyperFrames 工作副本缺少有效 default_variant_id");
  const durationMs = (document.manifest.scenes || []).reduce(
    (sum, scene) => sum + Number(scene.duration_ms || 0),
    0,
  );
  if (!(durationMs > 0)) fail("HyperFrames 工作副本总时长必须大于 0");
  return {
    root: document.packageRoot,
    manifest: document.manifest,
    variant,
    durationMs,
    digest: packageDigest(document.packageRoot),
  };
}

function roundedSeconds(milliseconds) {
  return Number((milliseconds / 1000).toFixed(6));
}

export function buildDynamicSamplePlan(manifest) {
  const fps = Number(manifest.playback?.fps);
  if (!(fps > 0)) fail("动态样片计划缺少有效 fps");
  const frameMs = 1000 / fps;
  const points = new Map();
  const add = (milliseconds, reason) => {
    const selected = Math.max(0, milliseconds);
    const timeSeconds = roundedSeconds(selected);
    const key = timeSeconds.toFixed(6);
    const record = points.get(key) || {time_seconds: timeSeconds, reasons: []};
    if (!record.reasons.includes(reason)) record.reasons.push(reason);
    points.set(key, record);
  };
  let sceneStartMs = 0;
  for (const scene of manifest.scenes || []) {
    const durationMs = Number(scene.duration_ms || 0);
    if (!(durationMs > 0)) fail(`场景 ${scene.id} 缺少有效 duration_ms`);
    const lastFrameMs = Math.max(sceneStartMs, sceneStartMs + durationMs - frameMs);
    add(sceneStartMs, `${scene.id}:scene-start`);
    add(lastFrameMs, `${scene.id}:scene-end`);
    const reviewedSteps = (scene.steps || []).filter((step) => step.review === true);
    for (const step of reviewedSteps) {
      const exact = Math.min(
        lastFrameMs,
        Math.max(sceneStartMs, sceneStartMs + Number(step.at_ms || 0)),
      );
      add(Math.max(sceneStartMs, exact - frameMs), `${scene.id}:${step.id}:before`);
      add(exact, `${scene.id}:${step.id}:exact`);
      add(Math.min(lastFrameMs, exact + frameMs), `${scene.id}:${step.id}:after`);
    }
    if (!reviewedSteps.length) {
      add(sceneStartMs + durationMs / 2, `${scene.id}:unreviewed-midpoint`);
    }
    sceneStartMs += durationMs;
  }
  const frames = [...points.values()].sort(
    (left, right) => left.time_seconds - right.time_seconds,
  );
  if (!frames.length) fail("动态样片计划没有代表帧");
  return {
    fps,
    duration_seconds: roundedSeconds(sceneStartMs),
    frames,
  };
}

function providerEnvironment(configPath = null) {
  const environment = loadLocalMediaEnvironment(configPath);
  const provider = probeHyperframesProvider(environment.providers.hyperframes);
  return {environment, provider};
}

function assertGenericProductionProvider(provider) {
  if (provider.probe_status !== "ready") {
    fail(`HyperFrames 能力探测失败：${provider.probe_error || "unknown"}`);
  }
  if (provider.detected_adapter !== "generic-hyperframes") {
    fail(
      `当前 adapter ${provider.detected_adapter || "unknown"} 没有动态样片执行合同；`
      + "不能进入 visual-multimedia 正式渲染",
    );
  }
  if (!provider.capabilities.production_web_render) {
    fail("HyperFrames 没有同时通过确定性渲染与动态样片能力探测");
  }
}

function taskRootFor(target) {
  const selected = assertSkillTaskPath(path.resolve(target));
  const relative = path.relative(TASK_WORKSPACE_ROOT, selected);
  return path.join(TASK_WORKSPACE_ROOT, relative.split(path.sep)[0]);
}

function runtimeEnvironment(environment, target) {
  const taskRoot = taskRootFor(target);
  const temporary = path.join(taskRoot, "temp", "hyperframes");
  fs.mkdirSync(temporary, {recursive: true});
  return {
    ...process.env,
    TEMP: temporary,
    TMP: temporary,
    HYPERFRAMES_BROWSER_PATH: environment.providers.local.browser
      || environment.providers.local.playwright.browser_executable
      || "",
  };
}

function writeNewJson(filePath, payload, label) {
  const selected = assertSkillTaskPath(path.resolve(filePath), label);
  if (fs.existsSync(selected)) fail(`${label} 已经存在：${selected}`);
  fs.mkdirSync(path.dirname(selected), {recursive: true});
  fs.writeFileSync(selected, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return selected;
}

export function classifyHyperframesRuntime(stdout, stderr) {
  const combined = `${stdout || ""}\n${stderr || ""}`;
  const lines = combined.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  const pageErrors = lines.filter((line) => (
    line.includes("[Browser:PAGEERROR]") || line.includes("EditableMediaFrameError")
  ));
  const resourceWarnings = lines.filter((line) => (
    line.includes("Failed to load resource") || line.includes("[non-blocking]")
  ));
  const fallbackReasons = lines.filter((line) => (
    line.includes("fast capture: falling back")
  ));
  const captureModes = [...new Set(
    [...combined.matchAll(/captureMode\\?"?\s*:\\?"([^"\\]+)/gu)]
      .map((match) => match[1]),
  )];
  return {
    blocking: pageErrors.length > 0,
    page_error_count: pageErrors.length,
    page_errors: [...new Set(pageErrors)].slice(0, 20),
    resource_warning_count: resourceWarnings.length,
    resource_warnings: [...new Set(resourceWarnings)].slice(0, 20),
    fast_capture_fallbacks: [...new Set(fallbackReasons)].slice(0, 20),
    reported_capture_modes: captureModes,
  };
}

function readJson(filePath, label) {
  const selected = assertSkillTaskPath(path.resolve(filePath), label);
  try {
    return {path: selected, value: JSON.parse(fs.readFileSync(selected, "utf8"))};
  } catch (error) {
    fail(`${label} 不是有效 JSON：${error.message}`);
  }
}

function captureSample(source, options) {
  const prepared = preparedPackage(source);
  const reportPath = assertSkillTaskPath(
    path.resolve(required(options.report, "--report")),
    "动态样片报告",
  );
  const framesDirectory = assertSkillTaskPath(
    path.resolve(required(options.output, "--output")),
    "动态样片目录",
  );
  if (fs.existsSync(reportPath)) fail(`动态样片报告已经存在：${reportPath}`);
  if (fs.existsSync(framesDirectory)) fail(`动态样片目录已经存在：${framesDirectory}`);
  const {environment, provider} = providerEnvironment(options.config || null);
  assertGenericProductionProvider(provider);
  const plan = buildDynamicSamplePlan(prepared.manifest);
  const times = plan.frames.map((item) => item.time_seconds).join(",");
  const result = runHyperframesCommand(
    provider.command,
    [
      "snapshot",
      prepared.root,
      "--at",
      times,
      "--no-end",
      "--describe",
      "false",
      "--output",
      framesDirectory,
    ],
    {
      cwd: prepared.root,
      env: runtimeEnvironment(environment, framesDirectory),
    },
  );
  const runtime = classifyHyperframesRuntime(result.stdout, result.stderr);
  if (result.status !== 0 || runtime.blocking) {
    const failure = {
      protocol: SAMPLE_PROTOCOL,
      version: 1,
      status: "capture-failed",
      prepared_package: prepared.root,
      package_sha256: prepared.digest,
      provider: provider.identity,
      plan,
      runtime_findings: runtime,
      command: {
        exit_code: result.status,
        stdout: result.stdout.slice(-4000),
        stderr: result.stderr.slice(-4000),
      },
    };
    writeNewJson(reportPath, failure, "动态样片失败报告");
    fail(`HyperFrames 动态样片失败；证据已写入 ${reportPath}`);
  }
  const images = fs.readdirSync(framesDirectory, {withFileTypes: true})
    .filter((entry) => entry.isFile() && /\.png$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, {numeric: true}));
  if (images.length !== plan.frames.length) {
    fail(`动态样片数量不一致：计划 ${plan.frames.length}，实际 ${images.length}`);
  }
  const frames = plan.frames.map((item, index) => {
    const imagePath = path.join(framesDirectory, images[index]);
    return {
      ...item,
      image: path.relative(path.dirname(reportPath), imagePath).split(path.sep).join("/"),
      sha256: sha256File(imagePath),
      bytes: fs.statSync(imagePath).size,
    };
  });
  const report = {
    protocol: SAMPLE_PROTOCOL,
    version: 1,
    status: "awaiting-review",
    prepared_package: prepared.root,
    package_sha256: prepared.digest,
    variant_id: prepared.variant.id,
    width: prepared.variant.canvas.width,
    height: prepared.variant.canvas.height,
    fps: plan.fps,
    duration_seconds: plan.duration_seconds,
    provider: provider.identity,
    frames,
    runtime_findings: runtime,
    review: null,
  };
  writeNewJson(reportPath, report, "动态样片报告");
  return {report: reportPath, frames_directory: framesDirectory, sample: report};
}

function validateSampleImages(reportPath, report) {
  if (report.protocol !== SAMPLE_PROTOCOL || report.version !== 1) {
    fail("动态样片报告协议无效");
  }
  if (!Array.isArray(report.frames) || !report.frames.length) {
    fail("动态样片报告没有代表帧");
  }
  for (const frame of report.frames) {
    const imagePath = path.resolve(path.dirname(reportPath), required(frame.image, "frame.image"));
    assertSkillTaskPath(imagePath, "动态样片图片");
    if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
      fail(`动态样片图片不存在：${imagePath}`);
    }
    if (sha256File(imagePath) !== frame.sha256) {
      fail(`动态样片图片哈希不一致：${imagePath}`);
    }
  }
}

function reviewSample(options) {
  const selected = readJson(required(options.report, "--report"), "动态样片报告");
  const report = selected.value;
  if (report.status !== "awaiting-review") {
    fail(`动态样片只能从 awaiting-review 审阅，当前是 ${report.status}`);
  }
  validateSampleImages(selected.path, report);
  const decision = required(options.decision, "--decision");
  if (!new Set(["passed", "failed"]).has(decision)) {
    fail("--decision 只能是 passed 或 failed");
  }
  const notes = required(options.notes, "--notes");
  const reviewer = required(options.reviewer, "--reviewer");
  const updated = {
    ...report,
    status: decision,
    review: {
      decision,
      reviewer,
      notes,
      reviewed_at: new Date().toISOString(),
      evidence_digest: sha256(JSON.stringify(report.frames)),
    },
  };
  const pending = `${selected.path}.pending-${process.pid}`;
  if (fs.existsSync(pending)) fail(`动态样片审阅临时文件已存在：${pending}`);
  fs.writeFileSync(pending, `${JSON.stringify(updated, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  fs.renameSync(pending, selected.path);
  return {report: selected.path, sample: updated};
}

function validatePassedSample(source, reportPath, provider) {
  const prepared = preparedPackage(source);
  const selected = readJson(reportPath, "动态样片报告");
  const report = selected.value;
  if (report.status !== "passed" || report.review?.decision !== "passed") {
    fail("正式渲染必须消费已通过审阅的动态样片报告");
  }
  validateSampleImages(selected.path, report);
  if (path.resolve(report.prepared_package) !== prepared.root) {
    fail("动态样片报告绑定了另一个 HyperFrames 工作副本");
  }
  if (report.package_sha256 !== prepared.digest) {
    fail("动态样片之后工作副本发生变化；必须重新抓取和审阅样片");
  }
  if (JSON.stringify(report.provider) !== JSON.stringify(provider.identity)) {
    fail("动态样片之后 HyperFrames 提供方身份发生变化；必须重新验证");
  }
  return {prepared, report: selected};
}

function probeOutput(ffprobe, output) {
  const result = runHyperframesCommand(ffprobe, [
    "-v",
    "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    output,
  ]);
  if (result.status !== 0) fail(`FFprobe 无法读取 HyperFrames 成片：${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`FFprobe 返回无效 JSON：${error.message}`);
  }
}

function render(source, options) {
  const output = assertSkillTaskPath(
    path.resolve(required(options.output, "--output")),
    "HyperFrames 成片",
  );
  const framesCache = assertSkillTaskPath(
    path.resolve(required(options["frames-cache-dir"], "--frames-cache-dir")),
    "HyperFrames 帧缓存",
  );
  if (fs.existsSync(output)) fail(`HyperFrames 成片已经存在：${output}`);
  const receiptPath = `${output}.render-receipt.json`;
  if (fs.existsSync(receiptPath)) fail(`HyperFrames 渲染回执已经存在：${receiptPath}`);
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.mkdirSync(framesCache, {recursive: true});
  const {environment, provider} = providerEnvironment(options.config || null);
  assertGenericProductionProvider(provider);
  const evidence = validatePassedSample(
    source,
    required(options["sample-report"], "--sample-report"),
    provider,
  );
  const extension = path.extname(output).slice(1).toLowerCase();
  if (!new Set(["mp4", "webm", "mov", "gif"]).has(extension)) {
    fail("HyperFrames 成片扩展名只能是 mp4、webm、mov 或 gif");
  }
  const result = runHyperframesCommand(
    provider.command,
    [
      "render",
      evidence.prepared.root,
      "--fps",
      String(evidence.prepared.manifest.playback.fps),
      "--format",
      extension,
      "--frames-cache-dir",
      framesCache,
      "--no-best-effort",
      "--strict",
      "--output",
      output,
    ],
    {
      cwd: evidence.prepared.root,
      env: runtimeEnvironment(environment, output),
    },
  );
  const runtime = classifyHyperframesRuntime(result.stdout, result.stderr);
  if (result.status !== 0 || !fs.existsSync(output)) {
    const failure = {
      protocol: RENDER_RECEIPT_PROTOCOL,
      version: 1,
      status: "failed",
      output,
      provider: provider.identity,
      sample_report: evidence.report.path,
      runtime_findings: runtime,
      command: {
        exit_code: result.status,
        stdout: result.stdout.slice(-8000),
        stderr: result.stderr.slice(-8000),
      },
    };
    writeNewJson(receiptPath, failure, "HyperFrames 失败回执");
    fail(`HyperFrames 正式渲染失败；证据已写入 ${receiptPath}`);
  }
  const probe = probeOutput(
    required(environment.providers.local.ffprobe, "本机 FFprobe"),
    output,
  );
  const receipt = {
    protocol: RENDER_RECEIPT_PROTOCOL,
    version: 1,
    status: runtime.blocking
      ? "blocked-runtime-errors"
      : "rendered-awaiting-final-visual-review",
    output,
    output_sha256: sha256File(output),
    output_bytes: fs.statSync(output).size,
    prepared_package: evidence.prepared.root,
    package_sha256: evidence.prepared.digest,
    provider: provider.identity,
    sample_report: evidence.report.path,
    sample_evidence_digest: evidence.report.value.review.evidence_digest,
    runtime_findings: runtime,
    probe,
    command: {
      exit_code: result.status,
      stdout: result.stdout.slice(-8000),
      stderr: result.stderr.slice(-8000),
    },
  };
  writeNewJson(receiptPath, receipt, "HyperFrames 渲染回执");
  if (runtime.blocking) {
    fail(
      `HyperFrames 虽然生成了文件，但出现 ${runtime.page_error_count} 条页面运行时错误；`
      + `成片被门禁阻断，证据已写入 ${receiptPath}`,
    );
  }
  return {output, receipt: receiptPath, render: receipt};
}

function usage() {
  return [
    "用法：",
    "  node scripts/hyperframes-provider.mjs inspect [--config <本机配置>]",
    "  node scripts/hyperframes-provider.mjs sample-plan <工作副本>",
    "  node scripts/hyperframes-provider.mjs sample <工作副本> --output <新图片目录> --report <新报告.json>",
    "  node scripts/hyperframes-provider.mjs review --report <报告.json> --decision passed|failed --reviewer <名称> --notes <说明>",
    "  node scripts/hyperframes-provider.mjs render <工作副本> --sample-report <passed报告> --frames-cache-dir <目录> --output <成片>",
  ].join("\n");
}

function main(argv) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);
  if (command === "inspect") {
    const {provider} = providerEnvironment(parsed.options.config || null);
    console.log(JSON.stringify(provider, null, 2));
    return;
  }
  if (command === "sample-plan") {
    const prepared = preparedPackage(required(parsed.positional[0], "工作副本"));
    console.log(JSON.stringify(buildDynamicSamplePlan(prepared.manifest), null, 2));
    return;
  }
  let result;
  if (command === "sample") {
    result = captureSample(required(parsed.positional[0], "工作副本"), parsed.options);
  } else if (command === "review") {
    result = reviewSample(parsed.options);
  } else if (command === "render") {
    result = render(required(parsed.positional[0], "工作副本"), parsed.options);
  } else {
    fail(`未知命令：${command}\n${usage()}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (path.resolve(process.argv[1] || "") === path.resolve(SCRIPT_PATH)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
