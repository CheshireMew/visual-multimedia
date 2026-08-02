#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateMediaSources } from "./validate-media-sources.mjs";
import { validateMediaProjectState } from "./validate-media-project-state.mjs";
import {
  reviewBasisSha256,
  validateMediaReview,
} from "./validate-media-review.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDir);
const defaultTestRoot = (
  process.platform === "win32" && fs.existsSync("D:\\Tools")
)
  ? "D:\\Tools\\visual-multimedia-tests"
  : os.tmpdir();
const testRoot = path.resolve(
  process.env.VISUAL_MULTIMEDIA_TEST_ROOT || defaultTestRoot
);
const projectRoot = path.join(
  testRoot,
  "visual-multimedia-media-contracts",
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
);
const manifestPath = path.join(projectRoot, "media-sources.json");
const sourceInput = path.join(
  skillRoot,
  "assets",
  "media-delivery-case",
  "renders",
  "final.mp4"
);

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: skillRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${label}失败：${detail}`);
  }
  return result;
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label}没有返回可读 JSON：${error.message}`);
  }
}

function ensureProject() {
  fs.mkdirSync(projectRoot, { recursive: true });
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          protocol: "visual-multimedia-media-sources",
          version: 3,
          sources: [],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }
}

function writeGeneratedContract(fileName, value) {
  const filePath = path.join(projectRoot, fileName);
  const serialized = JSON.stringify(value, null, 2) + "\n";
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, "utf8");
    if (current !== serialized) {
      throw new Error(`既有自检合同与当前真实输入不一致，未覆盖：${filePath}`);
    }
    return filePath;
  }
  fs.writeFileSync(filePath, serialized, "utf8");
  return filePath;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  ensureProject();
  if (!fs.existsSync(sourceInput) || fs.statSync(sourceInput).size === 0) {
    throw new Error(`真实视频输入不存在：${sourceInput}`);
  }
  const initial = validateMediaSources(manifestPath);
  if (!initial.ok) {
    throw new Error(`自检素材账本无效：${initial.errors.join("\n")}`);
  }

  const importer = path.join(scriptDir, "import-media-asset.mjs");
  const imported = parseJson(
    run(
      process.execPath,
      [
        importer,
        "--project",
        projectRoot,
        "--input",
        sourceInput,
        "--id",
        "selfcheck-source",
        "--media-type",
        "video",
        "--method",
        "project-owned",
        "--rights-status",
        "confirmed",
        "--license",
        "project-owned",
        "--usage",
        "代理表示生产与解析链路的真实视频输入",
      ],
      "原片入账"
    ),
    "原片入账"
  );
  if (
    imported.source?.id !== "selfcheck-source"
    || imported.source?.representation?.kind !== "source"
  ) {
    throw new Error("原片生产者没有写入 source 表示");
  }

  const proxyResult = parseJson(
    run(
      process.execPath,
      [
        path.join(scriptDir, "create-media-proxy.mjs"),
        "--project",
        projectRoot,
        "--source-id",
        "selfcheck-source",
        "--proxy-id",
        "selfcheck-proxy-360p",
        "--height",
        "360",
      ],
      "代理生产"
    ),
    "代理生产"
  );
  if (
    proxyResult.proxy_id !== "selfcheck-proxy-360p"
    || proxyResult.equivalence?.passed !== true
  ) {
    throw new Error("代理生产者没有通过真实媒体等价检查");
  }

  const resolver = path.join(scriptDir, "resolve-media-representation.mjs");
  const resolvedSource = parseJson(
    run(
      process.execPath,
      [
        resolver,
        manifestPath,
        "--source-id",
        "selfcheck-source",
        "--mode",
        "source",
        "--json",
      ],
      "原片解析"
    ),
    "原片解析"
  );
  const resolvedProxy = parseJson(
    run(
      process.execPath,
      [
        resolver,
        manifestPath,
        "--source-id",
        "selfcheck-source",
        "--mode",
        "proxy",
        "--proxy-id",
        "selfcheck-proxy-360p",
        "--json",
      ],
      "代理解析"
    ),
    "代理解析"
  );
  for (const [label, resolved] of [
    ["原片", resolvedSource],
    ["代理", resolvedProxy],
  ]) {
    if (!fs.existsSync(resolved.file) || fs.statSync(resolved.file).size === 0) {
      throw new Error(`${label}消费者没有解析到可读文件`);
    }
  }
  if (
    resolvedSource.representation_id === resolvedProxy.representation_id
    || resolvedSource.file === resolvedProxy.file
    || resolvedSource.sha256 === resolvedProxy.sha256
  ) {
    throw new Error("source 与 proxy 没有保持独立表示");
  }

  const finalValidation = validateMediaSources(manifestPath);
  const proxyEvidence = finalValidation.proxies.find(
    (item) => item.proxy_id === "selfcheck-proxy-360p"
  );
  if (!finalValidation.ok || proxyEvidence?.passed !== true) {
    throw new Error(
      `最终素材账本没有证明代理等价：${finalValidation.errors.join("\n")}`
    );
  }
  const proxyRelative = path
    .relative(projectRoot, resolvedProxy.file)
    .split(path.sep)
    .join("/");
  writeGeneratedContract("media-project-state.json", {
    protocol: "visual-multimedia-media-project-state",
    version: 2,
    project_id: "media-contract-selfcheck-v2",
    status: "complete",
    current_checkpoint: "delivery",
    contracts: {
      media_sources: "media-sources.json",
      resource_adoptions: null,
      transcript: null,
      clip_selections: null,
      timeline: null,
      style_profile: null,
      sound_profile: null,
      promotion_candidates: null,
      review: "media-review.json",
      delivery: "media-delivery.json",
    },
    creative_approvals: [],
    production_decisions: [],
    artifacts: [
      {
        id: "proxy-as-final-negative-case",
        kind: "final",
        file: proxyRelative,
        sha256: resolvedProxy.sha256,
      },
    ],
    blockers: [],
    next_action: "",
    updated_at: "2026-07-29T00:00:00.000Z",
  });
  const reviewBasisArtifacts = [
    {
      id: "media-sources",
      role: "source-contract",
      file: "media-sources.json",
      sha256: sha256File(manifestPath),
    },
  ];
  writeGeneratedContract("media-review.json", {
    protocol: "visual-multimedia-media-review",
    version: 3,
    project_state: "media-project-state.json",
    review_basis: {
      created_at: "2026-07-29T00:00:00.000Z",
      basis_sha256: reviewBasisSha256(reviewBasisArtifacts),
      artifacts: reviewBasisArtifacts,
    },
    reviewed_media: {
      file: proxyRelative,
      sha256: resolvedProxy.sha256,
      duration_seconds: proxyEvidence.proxy.duration_seconds,
      frame_rate: proxyEvidence.proxy.frame_rate,
    },
    status: "pending",
    machine_review: {
      status: "pending",
      report: "reports/pending-machine-review.json",
      report_sha256: null,
      completed_at: null,
      notes: "",
    },
    agent_review: {
      status: "pending",
      completed: false,
      reviewed_at: null,
      method: "",
      notes: "",
    },
    user_confirmation: {
      required: false,
      status: "not-requested",
      confirmed_at: null,
      evidence: "",
    },
    promise_checks: [
      {
        id: "media-sources-version",
        basis_artifact_id: "media-sources",
        source_pointer: "/version",
        promise: "自检素材账本使用当前 v3 合同。",
        expected_value: 3,
        status: "passed",
        actual: "3",
        evidence: "直接读取不可变 media-sources.json 的 version。",
        finding_id: null,
      },
    ],
    findings: [],
  });
  writeGeneratedContract("media-delivery.json", {
    protocol: "visual-multimedia-delivery",
    version: 2,
    profile: "final",
    output: {
      file: proxyRelative,
    },
    editability: {
      classification: "flat_render",
      project_file: null,
      project_file_sha256: null,
      limitations: [
        "自检 MP4 是扁平化成片，不能恢复为独立原片与代理表示。",
      ],
    },
    project_state: "media-project-state.json",
    media_sources: "media-sources.json",
    transcript: null,
    clip_selections: null,
    media_review: "media-review.json",
    adopted_source_ids: ["selfcheck-proxy-360p"],
    expected: {
      media_kind: "video",
      audio_required: true,
      duration_seconds: proxyEvidence.proxy.duration_seconds,
      duration_tolerance_seconds: 0.05,
      width: proxyEvidence.proxy.width,
      height: proxyEvidence.proxy.height,
      frame_rate: proxyEvidence.proxy.frame_rate,
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
        maximum_unacknowledged_seconds: 1,
        allowed_ranges: [],
      },
      black_frames: {
        picture_black_ratio: 0.98,
        pixel_threshold: 0.1,
        minimum_duration_seconds: 0.1,
        maximum_unacknowledged_seconds: 1,
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
        file: "reports/proxy-contact-sheet.jpg",
        frames: 8,
        columns: 4,
      },
      rights_review: {
        status: "passed",
        notes: "仅用于验证 final 不能采用代理表示。",
      },
    },
    report: "reports/proxy-delivery-report.json",
  });
  const statePath = path.join(projectRoot, "media-project-state.json");
  const reviewPath = path.join(projectRoot, "media-review.json");
  const stateValidation = validateMediaProjectState(statePath);
  if (!stateValidation.ok) {
    throw new Error(
      `项目状态 v2 自检失败：${stateValidation.errors.join("\n")}`
    );
  }
  const reviewValidation = validateMediaReview(reviewPath);
  if (!reviewValidation.ok) {
    throw new Error(
      `媒体评审 v3 自检失败：${reviewValidation.errors.join("\n")}`
    );
  }
  const originalManifest = fs.readFileSync(manifestPath, "utf8");
  fs.writeFileSync(manifestPath, `${originalManifest}\n`, "utf8");
  const tamperedBasis = validateMediaReview(reviewPath);
  fs.writeFileSync(manifestPath, originalManifest, "utf8");
  if (
    tamperedBasis.ok
    || !tamperedBasis.errors.some((message) => message.includes("review_basis"))
  ) {
    throw new Error("媒体评审错误接受了哈希已经变化的制作依据");
  }
  const invalidStatePath = path.join(projectRoot, "invalid-superseded-state.json");
  const invalidState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  invalidState.production_decisions = [
    {
      id: "invalid-superseded-decision",
      category: "delivery",
      status: "superseded",
      decision: "这条决定不应继续生效。",
      rationale: "验证替代关系不能缺失。",
      applies_to: ["contracts.delivery"],
      evidence_artifact_ids: [],
      decided_by: "agent",
      decided_at: "2026-07-29T00:00:00.000Z",
      superseded_by: null,
    },
  ];
  fs.writeFileSync(
    invalidStatePath,
    `${JSON.stringify(invalidState, null, 2)}\n`,
    "utf8"
  );
  const invalidStateValidation = validateMediaProjectState(invalidStatePath);
  if (
    invalidStateValidation.ok
    || !invalidStateValidation.errors.some((message) => message.includes("superseded"))
  ) {
    throw new Error("项目状态错误接受了没有替代目标的 superseded 决策");
  }
  const python = process.env.VISUAL_MULTIMEDIA_PYTHON
    || (process.platform === "win32" ? "python.exe" : "python3");
  const rejectedDelivery = spawnSync(
    python,
    [
      path.join(scriptDir, "verify-media-delivery.py"),
      path.join(projectRoot, "media-delivery.json"),
    ],
    {
      cwd: skillRoot,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
    }
  );
  if (rejectedDelivery.status === 0) {
    throw new Error("final 交付错误接受了代理表示");
  }
  const rejectedReportPath = path.join(
    projectRoot,
    "reports",
    "proxy-delivery-report.json"
  );
  if (!fs.existsSync(rejectedReportPath)) {
    throw new Error("代理 final 被拒绝后没有保留可诊断交付报告");
  }
  const rejectedReport = JSON.parse(
    fs.readFileSync(rejectedReportPath, "utf8")
  );
  const proxyRejection = rejectedReport.checks?.find(
    (item) => item.id === "final-source-representations"
  );
  if (proxyRejection?.status !== "failed") {
    throw new Error("交付报告没有明确记录 final 代理表示拒绝");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        project: projectRoot,
        producer: {
          source: resolvedSource,
          proxy: resolvedProxy,
        },
        boundary: manifestPath,
        consumer: "resolve-media-representation.mjs",
        equivalence: proxyEvidence,
        final_proxy_rejected: true,
      },
      null,
      2
    )
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
