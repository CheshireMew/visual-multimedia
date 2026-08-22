import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";

export const HYPERFRAMES_ADAPTERS = new Set([
  "generic-hyperframes",
  "renderkit",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

export function hyperframesCommandInvocation(command, args) {
  if (process.platform === "win32" && path.extname(command).toLowerCase() === ".ps1") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...args,
      ],
    };
  }
  return {command, args};
}

export function runHyperframesCommand(command, args, options = {}) {
  const invocation = hyperframesCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    return {
      status: null,
      stdout: "",
      stderr: result.error.message,
      error: result.error.message,
    };
  }
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: null,
  };
}

function includesAll(value, markers) {
  return markers.every((marker) => value.includes(marker));
}

function probeGeneric(command, baseHelp, runner) {
  const versionResult = runner(command, ["--version"]);
  const renderResult = runner(command, ["render", "--help"]);
  const snapshotResult = runner(command, ["snapshot", "--help"]);
  const renderHelp = `${renderResult.stdout}\n${renderResult.stderr}`;
  const snapshotHelp = `${snapshotResult.stdout}\n${snapshotResult.stderr}`;
  const deterministic = renderResult.status === 0 && includesAll(renderHelp, [
    "--output",
    "--fps",
    "--format",
    "--frames-cache-dir",
  ]);
  const dynamicSample = snapshotResult.status === 0 && includesAll(snapshotHelp, [
    "--output",
    "--at",
    "--no-end",
    "--describe",
  ]);
  return {
    detected_adapter: "generic-hyperframes",
    version: (versionResult.stdout || versionResult.stderr || "").trim() || null,
    help_sha256: sha256([baseHelp, renderHelp, snapshotHelp].join("\n")),
    capabilities: {
      deterministic_web_render: deterministic,
      dynamic_sample: dynamicSample,
      production_web_render: deterministic && dynamicSample,
      transparent_output: /transparen(?:t|cy)/iu.test(renderHelp)
        && /(?:webm|mov|png-sequence)/iu.test(renderHelp),
      structured_preflight_report: false,
      interval_backend_plan: false,
      direct_encode: false,
    },
    constraints: [
      "正式渲染前必须由 visual-multimedia 生成并审阅动态样片",
      "CLI 接受 GPU 或 fast-capture 参数不等于实际后端已经得到证明",
      "失败后不得静默切换提供方或把回退路线写成快速路线",
    ],
  };
}

function probeRenderKit(command, baseHelp) {
  const platformReady = process.platform === "linux" && process.arch === "x64";
  const contractReady = includesAll(baseHelp, [
    "hf-render check",
    "hf-render plan",
    "hf-render run",
    "--json",
    "--report",
  ]);
  return {
    detected_adapter: "renderkit",
    version: null,
    help_sha256: sha256(baseHelp),
    capabilities: {
      deterministic_web_render: platformReady && contractReady,
      dynamic_sample: false,
      production_web_render: false,
      transparent_output: false,
      structured_preflight_report: contractReady,
      interval_backend_plan: contractReady,
      direct_encode: platformReady && contractReady,
    },
    constraints: [
      "当前公开构建与运行目标是 Linux x86_64，且依赖固定的自编译 Electron/Chromium",
      "主 CLI 没有按指定时间点输出动态样片的合同，尚不能通过 visual-multimedia 正式渲染门禁",
      "已验证的直接编码路线是 Intel VAAPI 不透明 H.264；透明输出需要另一条已证明管线",
    ],
  };
}

function normalizeInjectedProbe(provider) {
  const probe = provider.probe;
  const detected = probe?.detected_adapter;
  if (!HYPERFRAMES_ADAPTERS.has(detected)) {
    throw new Error("注入的 HyperFrames probe 缺少有效 detected_adapter");
  }
  return {
    detected_adapter: detected,
    version: probe.version ?? null,
    help_sha256: probe.help_sha256 ?? sha256(JSON.stringify(probe)),
    capabilities: {
      deterministic_web_render: probe.capabilities?.deterministic_web_render === true,
      dynamic_sample: probe.capabilities?.dynamic_sample === true,
      production_web_render: probe.capabilities?.production_web_render === true,
      transparent_output: probe.capabilities?.transparent_output === true,
      structured_preflight_report: probe.capabilities?.structured_preflight_report === true,
      interval_backend_plan: probe.capabilities?.interval_backend_plan === true,
      direct_encode: probe.capabilities?.direct_encode === true,
    },
    constraints: Array.isArray(probe.constraints) ? probe.constraints : [],
  };
}

export function probeHyperframesProvider(provider, runner = runHyperframesCommand) {
  if (!provider) {
    return {
      available: false,
      command: null,
      configured_adapter: null,
      detected_adapter: null,
      configuration_status: "not-configured",
      probe_status: "not-configured",
      probe_error: null,
      version: null,
      identity: null,
      capabilities: {
        deterministic_web_render: false,
        dynamic_sample: false,
        production_web_render: false,
        transparent_output: false,
        structured_preflight_report: false,
        interval_backend_plan: false,
        direct_encode: false,
      },
      constraints: [],
    };
  }
  const configuredAdapter = provider.adapter ?? null;
  if (configuredAdapter != null && !HYPERFRAMES_ADAPTERS.has(configuredAdapter)) {
    throw new Error(`未知 HyperFrames adapter：${configuredAdapter}`);
  }
  try {
    let detected;
    if (provider.probe) {
      detected = normalizeInjectedProbe(provider);
    } else {
      const baseResult = runner(provider.command, ["--help"]);
      if (baseResult.status !== 0) {
        throw new Error(
          `--help 失败（exit=${baseResult.status}）：`
          + `${baseResult.stderr || baseResult.stdout || "没有输出"}`.trim(),
        );
      }
      const baseHelp = `${baseResult.stdout}\n${baseResult.stderr}`;
      if (/HyperFrames AI production CLI/u.test(baseHelp)) {
        detected = probeRenderKit(provider.command, baseHelp);
      } else if (
        /Create and render HTML video compositions/u.test(baseHelp)
        && includesAll(baseHelp, ["render", "snapshot"])
      ) {
        detected = probeGeneric(provider.command, baseHelp, runner);
      } else {
        throw new Error("帮助信息不符合 generic HyperFrames 或 RenderKit 合同");
      }
    }
    const configurationStatus = configuredAdapter == null
      ? "legacy-untyped"
      : configuredAdapter === detected.detected_adapter
        ? "typed"
        : "adapter-mismatch";
    const mismatch = configurationStatus === "adapter-mismatch";
    const commandSha256 = provider.probe?.command_sha256
      || (fs.existsSync(provider.command) && fs.statSync(provider.command).isFile()
        ? sha256File(provider.command)
        : null);
    return {
      available: !mismatch,
      command: provider.command,
      configured_adapter: configuredAdapter,
      detected_adapter: detected.detected_adapter,
      configuration_status: configurationStatus,
      probe_status: mismatch ? "failed" : "ready",
      probe_error: mismatch
        ? `配置声明 ${configuredAdapter}，实际探测为 ${detected.detected_adapter}`
        : null,
      version: detected.version,
      identity: {
        adapter: detected.detected_adapter,
        version: detected.version,
        command_sha256: commandSha256,
        help_sha256: detected.help_sha256,
      },
      capabilities: mismatch
        ? Object.fromEntries(Object.keys(detected.capabilities).map((key) => [key, false]))
        : detected.capabilities,
      constraints: detected.constraints,
    };
  } catch (error) {
    return {
      available: false,
      command: provider.command,
      configured_adapter: configuredAdapter,
      detected_adapter: null,
      configuration_status: configuredAdapter == null ? "legacy-untyped" : "typed",
      probe_status: "failed",
      probe_error: error.message,
      version: null,
      identity: null,
      capabilities: {
        deterministic_web_render: false,
        dynamic_sample: false,
        production_web_render: false,
        transparent_output: false,
        structured_preflight_report: false,
        interval_backend_plan: false,
        direct_encode: false,
      },
      constraints: [],
    };
  }
}
