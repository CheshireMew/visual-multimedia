#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {validateSourceVideoCommentaryAuthoring} from "./source_video_commentary_preproduction.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLI = path.join(SCRIPT_DIR, "source-video-commentary.mjs");
const TEST_PARENT = process.platform === "win32" && fs.existsSync("D:\\Tools")
  ? "D:\\Tools\\visual-multimedia-tests"
  : os.tmpdir();
const ROOT = path.join(
  path.resolve(process.env.VISUAL_MULTIMEDIA_TEST_ROOT || TEST_PARENT),
  "source-video-commentary-preproduction",
  `contract-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
);
const PROJECT = path.join(ROOT, "project");
const INPUTS = path.join(ROOT, "inputs");

function commandPath(name) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], {encoding: "utf8", windowsHide: true});
  const candidate = (result.stdout || "").split(/\r?\n/u).map((item) => item.trim()).find(Boolean);
  if (result.status !== 0 || !candidate) throw new Error(`找不到 ${name}`);
  return candidate;
}

function run(command, args, label) {
  const result = spawnSync(command, args, {cwd: SKILL_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label}失败\n${result.stdout}\n${result.stderr}`);
  return result;
}

function cli(args, label) {
  return JSON.parse(run(process.execPath, [CLI, ...args], label).stdout);
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT, ...relative.split("/")), "utf8"));
}

function writeJson(relative, value) {
  const target = path.join(PROJECT, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  fs.mkdirSync(INPUTS, {recursive: true});
  const ffmpeg = commandPath("ffmpeg");
  const ffprobe = commandPath("ffprobe");
  const source = path.join(INPUTS, "raw-source.mp4");
  const music = path.join(INPUTS, "licensed-music.wav");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2.2",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=2.2",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "25",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", source,
  ], "生成原始测试视频");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=180:sample_rate=48000:duration=0.75",
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", music,
  ], "生成测试背景音乐");

  cli([
    "prepare", "--project", PROJECT, "--project-id", "commentary-preproduction-test",
    "--source", source, "--source-id", "raw-source", "--method", "user-provided",
    "--rights-status", "not-required", "--license", "deterministic self-test fixture",
    "--transcription-mode", "skip", "--contact-sheet-frames", "4",
    "--ffmpeg", ffmpeg, "--ffprobe", ffprobe,
  ], "从未入账源片准备项目");
  cli([
    "import-bgm", "--project", PROJECT, "--input", music, "--source-id", "licensed-music",
    "--method", "user-provided", "--rights-status", "not-required",
    "--license", "deterministic self-test fixture",
  ], "导入背景音乐");

  const analysisPath = path.join(PROJECT, "source-video-commentary-analysis.json");
  const analysis = readJson("source-video-commentary-analysis.json");
  if (analysis.transcript !== null || analysis.options.transcription_mode !== "skip") throw new Error("跳过转写的分析仍伪造了 transcript");
  if (!analysis.scene_candidates.length || analysis.scene_candidates.some((item) => item.status !== "suggestion-only")) {
    throw new Error("镜头候选没有保持 suggestion-only 边界");
  }
  for (const evidence of Object.values(analysis.visual_evidence)) {
    const absolute = path.join(PROJECT, ...evidence.file.split("/"));
    if (!fs.existsSync(absolute) || sha256(absolute) !== evidence.sha256) throw new Error(`分析证据失效：${evidence.file}`);
  }
  const packet = path.join(PROJECT, ...analysis.authoring_packet.file.split("/"));
  const packetText = fs.readFileSync(packet, "utf8");
  if (!packetText.includes("source-video-commentary-authoring.json") || !packetText.includes("候选场景只是检索提示")) {
    throw new Error("写作包没有说明正式 authoring 和候选镜头边界");
  }

  writeJson("source-video-commentary-authoring.json", {
    protocol: "visual-multimedia-source-video-commentary-authoring",
    version: 1,
    project_id: "commentary-preproduction-test",
    profile: "source-video-commentary@1.0.0",
    analysis: {file: "source-video-commentary-analysis.json", sha256: sha256(analysisPath)},
    target: {
      audience: "合同自测",
      editorial_angle: "从未入账源片形成解说 authoring",
      audience_outcome: "证明分析、写作、声音和音乐选择可以进入正式确认前检查",
      width: 320,
      height: 180,
      fps: 25,
      audio_sample_rate: 48000,
      audio_channels: 2,
      background: "#000000",
      caption_mode: "burned-in",
    },
    voice: {
      provider: "mediaflow-gpt-sovits-v2pro",
      voice_id: "game.honkai-star-rail.silverwolf.default",
      language: "zh",
      speed_factor: 1.25,
    },
    background_music: {
      source_id: "licensed-music",
      loop: true,
      base_gain_db: -22,
      narration_reduction_db: -8,
      source_only_reduction_db: -5,
      fade_in_seconds: 0.1,
      fade_out_seconds: 0.1,
    },
    integrated_sample: {segment_ids: ["segment-01"], reason: "唯一片段覆盖旁白与背景音乐"},
    segments: [{
      id: "segment-01",
      order: 1,
      purpose: "用旁白解释实际源片",
      visual_role: "hook",
      selection: {
        source_id: "raw-source",
        start_seconds: 0,
        end_seconds: 1.83,
        fit: "cover",
        freeze_when_shorter: true,
        spoken_content: false,
        transcript_segment_ids: [],
        intentional_repeat_reason: "",
      },
      narration: {title: "开场解说", text: "这段解说来自已经分析并登记的真实源视频。"},
      audio: {mode: "narration-with-source-bed", source_gain_db: -18},
      captions: [{
        id: "caption-01",
        start_ratio: 0,
        end_ratio: 1,
        text: "这段解说来自已经分析并登记的真实源视频。",
        language: "zh-CN",
        source_kind: "narration",
        source_segment_ids: [],
      }],
    }],
  });
  const authoring = validateSourceVideoCommentaryAuthoring({project: PROJECT, ffprobe, requireReviewedTranscript: true});
  if (authoring.music?.id !== "licensed-music" || authoring.authoring.segments.length !== 1) throw new Error("authoring 没有绑定真实音乐或片段");

  const current = cli(["migrate-profile", "--project", PROJECT], "检查当前 profile snapshot");
  if (current.status !== "current" || current.archive !== null) throw new Error("当前 profile snapshot 被错误迁移");
  const profileSnapshot = path.join(PROJECT, "contracts", "source-video-commentary-profile.json");
  fs.appendFileSync(profileSnapshot, "\n", "utf8");
  const staleSha = sha256(profileSnapshot);
  const migrated = cli(["migrate-profile", "--project", PROJECT], "迁移过期 profile snapshot");
  const archive = path.join(PROJECT, ...migrated.archive.split("/"));
  const profileSource = path.join(SKILL_ROOT, "assets", "video-production-profiles", "source-video-commentary", "1.0.0", "profile.json");
  if (migrated.status !== "migrated" || migrated.previous_sha256 !== staleSha || !fs.existsSync(archive)) {
    throw new Error("profile 迁移没有保留旧 snapshot");
  }
  if (sha256(profileSnapshot) !== sha256(profileSource)) throw new Error("profile 迁移没有写入当前 snapshot");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    project: PROJECT,
    raw_source_analysis: true,
    suggestion_only_scenes: analysis.scene_candidates.length,
    contact_sheet: analysis.visual_evidence.contact_sheet.file,
    background_music_imported: true,
    authoring_validated: true,
    profile_migration_archived: migrated.archive,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`错误：${error.stack || error.message}\n`);
  process.exitCode = 1;
}
