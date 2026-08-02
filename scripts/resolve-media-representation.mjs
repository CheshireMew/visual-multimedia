#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  mediaSourcesContractForVersion,
  validateMediaSources,
} from "./validate-media-sources.mjs";

function usage() {
  console.log(
    "用法：node scripts/resolve-media-representation.mjs"
      + " <media-sources.json> --source-id <id> --mode source|proxy"
      + " [--proxy-id <id>] [--json]\n"
      + "从唯一素材账本解析编辑代理或原始素材；不会修改时间线或素材文件。"
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    return args.length === 0 ? 1 : 0;
  }
  const manifestArg = args[0];
  const sourceIndex = args.indexOf("--source-id");
  const modeIndex = args.indexOf("--mode");
  const proxyIndex = args.indexOf("--proxy-id");
  if (!manifestArg || sourceIndex < 0 || modeIndex < 0) {
    throw new Error("必须提供素材账本、--source-id 和 --mode");
  }
  const sourceId = args[sourceIndex + 1];
  const mode = args[modeIndex + 1];
  const proxyId = proxyIndex >= 0 ? args[proxyIndex + 1] : null;
  if (!sourceId || !["source", "proxy"].includes(mode)) {
    throw new Error("--mode 必须是 source 或 proxy");
  }
  const manifestPath = path.resolve(manifestArg);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const validation = validateMediaSources(manifestPath, {
    contract: mediaSourcesContractForVersion(manifest.version),
  });
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }
  const source = manifest.sources.find((item) => item.id === sourceId);
  if (!source || source.representation?.kind !== "source") {
    throw new Error("--source-id 必须指向原始 source 表示");
  }
  let selected = source;
  if (mode === "proxy") {
    const candidates = manifest.sources.filter(
      (item) => item.representation?.kind === "proxy"
        && item.representation.source_id === sourceId
        && (!proxyId || item.id === proxyId)
    );
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? `没有找到 ${sourceId} 的代理`
          : `存在多个代理，请用 --proxy-id 明确选择：${candidates.map((item) => item.id).join(", ")}`
      );
    }
    selected = candidates[0];
  }
  const resolved = path.resolve(path.dirname(manifestPath), selected.file);
  const result = {
    mode,
    source_id: sourceId,
    representation_id: selected.id,
    file: resolved,
    sha256: selected.integrity?.sha256 || null,
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(resolved);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
