#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateMediaSources } from "./validate-media-sources.mjs";
import { validateMediaTranscript } from "./validate-media-transcript.mjs";

function usage() {
  console.log(`用法：
node scripts/import-media-transcript.mjs --project <项目目录> --source-id <原片 id>
  --input <SRT 文件> --language <语言> --kind user-subtitles|asr
  [--output transcript.json] [--reviewed --review-notes <说明>]

脚本把 SRT 输入保存到项目内的内容寻址目录，生成绑定原片哈希的转写合同。
默认审核状态为 pending；只有实际听音后才能使用 --reviewed。`);
}

function parseArgs(argv) {
  const values = new Map();
  const booleans = new Set(["reviewed"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    if (booleans.has(key)) {
      values.set(key, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    values.set(key, argv[index + 1]);
    index += 1;
  }
  return values;
}

function required(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function timestamp(value) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) throw new Error(`SRT 时间格式无效：${value}`);
  return (
    Number(match[1]) * 3600
    + Number(match[2]) * 60
    + Number(match[3])
    + Number(match[4]) / 1000
  );
}

function parseSrt(text) {
  const blocks = text.replace(/^\uFEFF/, "").trim().split(/\r?\n\r?\n+/);
  return blocks.map((block, index) => {
    const lines = block.split(/\r?\n/);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) throw new Error(`第 ${index + 1} 个字幕块缺少时间范围`);
    const [startText, endText] = lines[timeIndex].split("-->").map((item) => item.trim());
    const textValue = lines.slice(timeIndex + 1).join("\n").trim();
    if (!textValue) throw new Error(`第 ${index + 1} 个字幕块没有文字`);
    return {
      id: `segment-${String(index + 1).padStart(4, "0")}`,
      start_seconds: timestamp(startText),
      end_seconds: timestamp(endText),
      text: textValue,
      words: [],
      uncertain_terms: [],
    };
  });
}

function projectPath(projectRoot, value, label) {
  const absolute = path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 不能离开项目目录`);
  }
  return absolute;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const args = parseArgs(argv);
  const projectRoot = path.resolve(required(args, "project"));
  const sourceId = required(args, "source-id");
  const inputPath = path.resolve(required(args, "input"));
  const language = required(args, "language");
  const kind = required(args, "kind");
  if (!["user-subtitles", "asr"].includes(kind)) {
    throw new Error("--kind 必须是 user-subtitles 或 asr");
  }
  if (path.extname(inputPath).toLowerCase() !== ".srt") {
    throw new Error("当前导入器只接受带真实时间码的 SRT");
  }
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`输入字幕不存在：${inputPath}`);
  }
  const manifestPath = path.join(projectRoot, "media-sources.json");
  const sourceValidation = validateMediaSources(manifestPath);
  if (!sourceValidation.ok) {
    throw new Error(sourceValidation.errors.join("\n"));
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const source = manifest.sources.find((item) => item.id === sourceId);
  if (!source || source.representation?.kind !== "source") {
    throw new Error("--source-id 必须指向素材账本中的原始 source");
  }
  if (!["video", "audio"].includes(source.media_type)) {
    throw new Error("转写只能绑定 video 或 audio");
  }
  const inputSha = sha256File(inputPath);
  const inputDestination = path.join(
    projectRoot,
    "transcript",
    "by-sha256",
    `${inputSha}.srt`
  );
  fs.mkdirSync(path.dirname(inputDestination), { recursive: true });
  if (!fs.existsSync(inputDestination)) {
    fs.copyFileSync(inputPath, inputDestination, fs.constants.COPYFILE_EXCL);
  } else if (sha256File(inputDestination) !== inputSha) {
    throw new Error(`内容寻址字幕路径发生冲突：${inputDestination}`);
  }
  const reviewed = args.has("reviewed");
  const reviewNotes = args.get("review-notes") || "";
  if (reviewed && !reviewNotes) {
    throw new Error("--reviewed 必须同时提供 --review-notes，说明实际听音依据");
  }
  const outputPath = projectPath(
    projectRoot,
    args.get("output") || "transcript.json",
    "output"
  );
  const outputExisted = fs.existsSync(outputPath);
  let existingDocument = null;
  if (outputExisted) {
    try {
      existingDocument = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch (error) {
      throw new Error(`既有转写输出无法读取，未覆盖：${outputPath}（${error.message}）`);
    }
  }
  const document = {
    protocol: "visual-multimedia-media-transcript",
    version: 1,
    media_sources: "media-sources.json",
    source_id: sourceId,
    source_sha256: source.integrity.sha256,
    language,
    input: {
      kind,
      file: path.relative(projectRoot, inputDestination).split(path.sep).join("/"),
      sha256: inputSha,
    },
    review: {
      status: reviewed ? "passed" : "pending",
      listened: reviewed,
      reviewed_at: reviewed
        ? existingDocument?.review?.reviewed_at || new Date().toISOString()
        : null,
      notes: reviewNotes,
    },
    segments: parseSrt(fs.readFileSync(inputDestination, "utf8")),
  };
  if (outputExisted) {
    const existing = fs.readFileSync(outputPath, "utf8");
    const candidate = `${JSON.stringify(document, null, 2)}\n`;
    if (existing !== candidate) {
      throw new Error(`转写输出已存在且内容不同，未覆盖：${outputPath}`);
    }
  } else {
    fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  const validation = validateMediaTranscript(outputPath);
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }
  console.log(
    JSON.stringify(
      {
        created: !outputExisted,
        reused: outputExisted,
        file: outputPath,
        source_id: sourceId,
        segments: document.segments.length,
        review_status: document.review.status,
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
