#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  hyperframesCommandInvocation,
  probeHyperframesProvider,
} from "./hyperframes-provider-contract.mjs";
import {
  buildDynamicSamplePlan,
  classifyHyperframesRuntime,
} from "./hyperframes-provider.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_ROOT, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = JSON.parse(fs.readFileSync(
  path.join(SKILL_ROOT, "assets", "web-media-starter", "editable-media.json"),
  "utf8",
));
const plan = buildDynamicSamplePlan(manifest);
assert(plan.frames.length > manifest.scenes.length * 2, "动态样片没有覆盖审阅步骤邻帧");
for (const scene of manifest.scenes) {
  for (const step of scene.steps.filter((item) => item.review)) {
    const reasons = plan.frames.flatMap((item) => item.reasons);
    for (const phase of ["before", "exact", "after"]) {
      assert(
        reasons.includes(`${scene.id}:${step.id}:${phase}`),
        `动态样片缺少 ${scene.id}:${step.id}:${phase}`,
      );
    }
  }
}

const genericRunner = (_command, args) => {
  const key = args.join(" ");
  if (key === "--help") {
    return {
      status: 0,
      stdout: "Create and render HTML video compositions\nrender\nsnapshot\n",
      stderr: "",
    };
  }
  if (key === "--version") return {status: 0, stdout: "0.7.82\n", stderr: ""};
  if (key === "render --help") {
    return {
      status: 0,
      stdout: "--output --fps --format --frames-cache-dir transparent WebM MOV",
      stderr: "",
    };
  }
  if (key === "snapshot --help") {
    return {
      status: 0,
      stdout: "--output --at --no-end --describe",
      stderr: "",
    };
  }
  return {status: 1, stdout: "", stderr: "unexpected"};
};
const generic = probeHyperframesProvider(
  {command: "synthetic-hyperframes", adapter: "generic-hyperframes"},
  genericRunner,
);
assert(generic.probe_status === "ready", "generic HyperFrames 合同探测失败");
assert(generic.capabilities.production_web_render, "generic HyperFrames 没有通过样片门禁");
assert(generic.capabilities.transparent_output, "generic HyperFrames 透明格式能力丢失");

const renderKit = probeHyperframesProvider(
  {command: "synthetic-hf-render", adapter: "renderkit"},
  () => ({
    status: 0,
    stdout: [
      "HyperFrames AI production CLI",
      "hf-render check",
      "hf-render plan",
      "hf-render run",
      "--json",
      "--report",
    ].join("\n"),
    stderr: "",
  }),
);
assert(renderKit.detected_adapter === "renderkit", "RenderKit adapter 探测失败");
assert(!renderKit.capabilities.dynamic_sample, "RenderKit 被误报为支持指定时刻样片");
assert(!renderKit.capabilities.production_web_render, "RenderKit 绕过了正式样片门禁");

const runtimeFailure = classifyHyperframesRuntime(
  "fast capture: falling back because backdrop-filter is unsupported",
  "[Browser:PAGEERROR] EditableMediaFrameError: Frame generation 2 was superseded by 3",
);
assert(runtimeFailure.blocking, "页面运行时错误没有阻断正式渲染");
assert(runtimeFailure.page_error_count === 1, "页面运行时错误计数不正确");
assert(runtimeFailure.fast_capture_fallbacks.length === 1, "快速捕获回退没有进入证据");

const cleanRuntime = classifyHyperframesRuntime(
  "render complete captureMode:canvas-stream",
  "",
);
assert(!cleanRuntime.blocking, "无页面错误的运行被误判为失败");

const mismatch = probeHyperframesProvider(
  {command: "synthetic-hyperframes", adapter: "renderkit"},
  genericRunner,
);
assert(mismatch.probe_status === "failed", "adapter 错配没有失败");

const powershellInvocation = hyperframesCommandInvocation("D:\\Tools\\hyperframes.ps1", ["--help"]);
if (process.platform === "win32") {
  assert(powershellInvocation.command === "powershell.exe", "Windows PS1 没有通过 PowerShell 调用");
  assert(powershellInvocation.args.includes("-File"), "Windows PS1 缺少 -File 调用合同");
}

console.log(JSON.stringify({
  ok: true,
  dynamic_sample_frames: plan.frames.length,
  generic,
  renderkit: renderKit,
  mismatch,
}, null, 2));
