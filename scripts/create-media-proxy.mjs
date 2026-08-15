#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mediaSourcesContractForVersion,
  validateMediaSources,
} from "./validate-media-sources.mjs";
import { assertSkillTaskPath } from "./media-task-workspace.mjs";

function usage() {
  console.log(`用法：
node scripts/create-media-proxy.mjs --project <项目目录> --source-id <原片 id>
  --proxy-id <代理 id> [--height 720] [--crf 23] [--preset veryfast]
  [--ffmpeg <路径>] [--ffprobe <路径>] [--node <路径>]

脚本从通用 media-sources v3 或网页 media-sources v4 素材账本读取原片，生成单一代理表示，移动到内容寻址仓库，
再由素材校验器真实比较时长、帧率、画幅、旋转和音轨数量。
media-sources v4 代理完整继承原片渲染管线。已有同 id 且验证通过的代理会直接复用；
脚本不覆盖原片或现有代理。`);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`${token} 缺少值`);
    }
    args.set(token.slice(2), argv[index + 1]);
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}

function commandPath(name, override) {
  if (override) {
    const absolute = path.resolve(override);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`${name} 不存在：${absolute}`);
    }
    return absolute;
  }
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [name],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(`找不到 ${name}；脚本不会自动安装工具`);
  }
  return result.stdout.split(/\r?\n/).find(Boolean).trim();
}

function projectPath(projectRoot, value, label) {
  const absolute = path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 不能离开项目目录`);
  }
  return absolute;
}

function numeric(args, key, fallback, minimum, integer = false) {
  const value = args.has(key) ? Number(args.get(key)) : fallback;
  if (
    !Number.isFinite(value)
    || value < minimum
    || (integer && !Number.isInteger(value))
  ) {
    throw new Error(`--${key} 必须是${integer ? "整数" : "数字"}且不小于 ${minimum}`);
  }
  return value;
}

function run(command, values, label) {
  const result = spawnSync(command, values, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${label}失败：${detail}`);
  }
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const args = parseArgs(argv);
  const projectRoot = assertSkillTaskPath(path.resolve(required(args, "project")), "--project");
  const sourceId = required(args, "source-id");
  const proxyId = required(args, "proxy-id");
  const height = numeric(args, "height", 720, 2, true);
  const crf = numeric(args, "crf", 23, 0, true);
  const preset = args.get("preset") || "veryfast";
  const ffmpeg = commandPath("ffmpeg", args.get("ffmpeg"));
  const ffprobe = commandPath("ffprobe", args.get("ffprobe"));
  const node = commandPath("node", args.get("node"));
  const manifestPath = path.join(projectRoot, "media-sources.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const contract = mediaSourcesContractForVersion(manifest.version);
  const initial = validateMediaSources(manifestPath, { ffprobe, contract });
  if (!initial.ok) {
    throw new Error(
      "活动素材账本无效：\n" + initial.errors.map((item) => `- ${item}`).join("\n")
    );
  }
  const original = manifest.sources.find((item) => item.id === sourceId);
  if (!original) throw new Error(`素材账本不存在 source id：${sourceId}`);
  if (original.representation?.kind !== "source") {
    throw new Error("--source-id 必须指向原始 source 表示");
  }
  if (original.media_type !== "video") {
    throw new Error("当前代理生成器只处理 video");
  }
  const existing = manifest.sources.find((item) => item.id === proxyId);
  if (existing) {
    if (
      existing.representation?.kind !== "proxy"
      || existing.representation?.source_id !== sourceId
    ) {
      throw new Error(`proxy id ${proxyId} 已被其它素材占用`);
    }
    console.log(
      JSON.stringify(
        {
          created: false,
          reused: true,
          source_id: sourceId,
          proxy_id: proxyId,
          file: projectPath(projectRoot, existing.file, "proxy file"),
          equivalence: initial.proxies.find((item) => item.proxy_id === proxyId),
        },
        null,
        2
      )
    );
    return 0;
  }
  const sourceFile = projectPath(projectRoot, original.file, "source file");
  const buildRoot = path.join(projectRoot, ".proxy-build");
  fs.mkdirSync(buildRoot, { recursive: true });
  const temporary = path.join(buildRoot, `${proxyId}.mp4`);
  if (fs.existsSync(temporary)) {
    throw new Error(`代理临时文件已存在，未覆盖：${temporary}`);
  }
  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourceFile,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    `scale=-2:${height}`,
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-map_metadata",
    "0",
    "-movflags",
    "+faststart",
    temporary,
  ];
  run(ffmpeg, ffmpegArgs, "代理转码");
  if (!fs.existsSync(temporary) || fs.statSync(temporary).size === 0) {
    throw new Error("代理转码没有生成可用文件");
  }
  const createdAt = new Date().toISOString();
  const importer = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "import-media-asset.mjs"
  );
  const importArgs = [
    importer,
    "--project",
    projectRoot,
    "--input",
    temporary,
    "--id",
    proxyId,
    "--media-type",
    "video",
    "--method",
    "generated-in-project",
    "--rights-status",
    original.rights.status,
    "--license",
    original.rights.license,
    "--attribution",
    original.rights.attribution,
    "--terms-url",
    original.rights.terms_url,
    "--usage",
    `供 ${sourceId} 的低成本预览与编辑使用`,
    "--provider",
    "ffmpeg",
    "--captured-at",
    createdAt,
    "--proxy-of",
    sourceId,
    "--proxy-tool",
    "ffmpeg",
    "--duration-tolerance",
    "0.05",
    "--frame-rate-tolerance",
    "0.02",
    "--aspect-ratio-tolerance",
    "0.002",
    "--move-input",
  ];
  for (const value of ffmpegArgs) {
    importArgs.push("--proxy-command-arg", value);
  }
  const imported = run(node, importArgs, "代理入账");
  const finalValidation = validateMediaSources(manifestPath, {
    ffprobe,
    contract,
  });
  if (!finalValidation.ok) {
    throw new Error(
      "代理入账后真实等价检查失败：\n"
        + finalValidation.errors.map((item) => `- ${item}`).join("\n")
    );
  }
  const proxy = JSON.parse(imported.stdout).source;
  console.log(
    JSON.stringify(
      {
        created: true,
        reused: false,
        source_id: sourceId,
        proxy_id: proxyId,
        file: projectPath(projectRoot, proxy.file, "proxy file"),
        equivalence: finalValidation.proxies.find(
          (item) => item.proxy_id === proxyId
        ),
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
