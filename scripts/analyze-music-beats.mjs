#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {
  commandPath,
  nowIso,
  parseArgs,
  projectPath,
  relativeProjectPath,
  requireArg,
  sha256File,
  writeJson,
} from "./interview_explainer_common.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCHEMA_PATH = path.join(SKILL_ROOT, "schemas", "music-beat-analysis.v1.schema.json");
const SAMPLE_RATE = 22050;
const WINDOW = 1024;
const HOP = 512;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function decode(ffmpeg, input) {
  const result = spawnSync(ffmpeg, ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], {
    windowsHide: true,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg 无法解码音乐：${Buffer.from(result.stderr || []).toString("utf8")}`);
  const bytes = Buffer.from(result.stdout || []);
  if (bytes.length < SAMPLE_RATE * 4) throw new Error("音乐短于 1 秒，无法建立节拍网格");
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

function onsetEnvelope(samples) {
  const energies = [];
  for (let start = 0; start + WINDOW <= samples.length; start += HOP) {
    let sum = 0;
    for (let index = start; index < start + WINDOW; index += 1) sum += samples[index] * samples[index];
    energies.push(Math.sqrt(sum / WINDOW));
  }
  const onset = energies.map((value, index) => index === 0 ? 0 : Math.max(0, value - energies[index - 1]));
  const sorted = [...onset].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const ceiling = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const scale = Math.max(1e-9, ceiling - floor);
  return onset.map((value) => clamp((value - floor) / scale, 0, 2));
}

function fitGrid(envelope, minimumBpm, maximumBpm) {
  const stepSeconds = HOP / SAMPLE_RATE;
  const duration = envelope.length * stepSeconds;
  const candidates = [];
  for (let bpm = minimumBpm; bpm <= maximumBpm + 1e-9; bpm += 0.25) {
    const interval = 60 / bpm;
    const phaseSteps = Math.max(1, Math.round(interval / stepSeconds));
    let best = {score: -Infinity, phase: 0};
    for (let phaseIndex = 0; phaseIndex < phaseSteps; phaseIndex += 1) {
      const phase = phaseIndex * stepSeconds;
      let score = 0;
      let count = 0;
      for (let time = phase; time < duration; time += interval) {
        const center = Math.round(time / stepSeconds);
        let local = 0;
        for (let offset = -2; offset <= 2; offset += 1) local = Math.max(local, envelope[center + offset] || 0);
        score += local;
        count += 1;
      }
      const normalized = count ? score / Math.sqrt(count) : 0;
      if (normalized > best.score) best = {score: normalized, phase};
    }
    candidates.push({bpm, interval, ...best});
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  const middle = candidates[Math.floor(candidates.length / 2)]?.score || 0;
  const confidence = clamp((best.score - middle) / Math.max(1e-9, best.score), 0, 1);
  const peaks = envelope
    .map((value, index) => ({value, time: index * stepSeconds}))
    .filter((item, index) => item.value >= 0.7 && item.value >= (envelope[index - 1] || 0) && item.value >= (envelope[index + 1] || 0));
  const residuals = peaks.map(({time}) => {
    const nearest = best.phase + Math.round((time - best.phase) / best.interval) * best.interval;
    return Math.abs(time - nearest);
  });
  const residual = residuals.length ? residuals.reduce((sum, value) => sum + value, 0) / residuals.length : best.interval / 2;
  const beats = [];
  for (let time = best.phase; time < duration; time += best.interval) beats.push(Number(time.toFixed(6)));
  if (beats.length < 2) throw new Error("音乐时长不足以生成两个节拍点");
  return {
    bpm: Number(best.bpm.toFixed(3)),
    beat_interval_seconds: Number(best.interval.toFixed(6)),
    phase_seconds: Number(best.phase.toFixed(6)),
    confidence: Number(confidence.toFixed(4)),
    fit_residual_seconds: Number(residual.toFixed(6)),
    beats_seconds: beats,
  };
}

export function analyzeMusicBeats({projectRoot, inputPath, outputPath, ffmpegPath = null, minimumBpm = 70, maximumBpm = 180}) {
  const project = path.resolve(projectRoot);
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  relativeProjectPath(project, input);
  relativeProjectPath(project, output);
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`音乐文件不存在：${input}`);
  if (fs.existsSync(output)) throw new Error(`节拍分析已存在，不会覆盖：${output}`);
  if (!Number.isFinite(minimumBpm) || !Number.isFinite(maximumBpm) || minimumBpm < 30 || maximumBpm > 300 || minimumBpm >= maximumBpm) throw new Error("BPM 范围必须位于 30–300 且最小值小于最大值");
  const ffmpeg = commandPath("ffmpeg", ffmpegPath, "FFMPEG");
  const samples = decode(ffmpeg, input);
  const grid = fitGrid(onsetEnvelope(samples), minimumBpm, maximumBpm);
  const duration = samples.length / SAMPLE_RATE;
  const usable = grid.confidence >= 0.35 && grid.fit_residual_seconds <= grid.beat_interval_seconds * 0.2;
  const report = {
    protocol: "visual-multimedia-music-beat-analysis",
    version: 1,
    created_at: nowIso(),
    source: {
      file: relativeProjectPath(project, input),
      sha256: sha256File(input),
      duration_seconds: Number(duration.toFixed(6)),
      sample_rate: SAMPLE_RATE,
    },
    method: {
      decoder: "ffmpeg-f32le-mono",
      algorithm: "onset-envelope-grid-fit-v1",
      minimum_bpm: minimumBpm,
      maximum_bpm: maximumBpm,
    },
    grid,
    review: {
      status: usable ? "usable" : "manual-review",
      method: "automatic",
      reviewed_by: null,
      reviewed_at: null,
      notes: usable ? "自动网格达到使用阈值；仍需把关键切点与实际听感对照。" : "自动网格置信度或残差未达阈值，进入计划前必须人工复核或校正。",
    },
  };
  assertJsonSchema(report, SCHEMA_PATH, "音乐节拍分析");
  writeJson(output, report);
  return report;
}

function main(argv) {
  const args = parseArgs(argv);
  const project = path.resolve(requireArg(args, "project"));
  if (args.confirm) {
    const analysisPath = projectPath(project, requireArg(args, "analysis"), "beat analysis");
    const report = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    assertJsonSchema(report, SCHEMA_PATH, "音乐节拍分析");
    const reviewedBy = requireArg(args, "reviewed-by");
    if (!["user", "agent"].includes(reviewedBy)) throw new Error("--reviewed-by 必须是 user 或 agent");
    report.review = {
      status: "usable",
      method: "manual",
      reviewed_by: reviewedBy,
      reviewed_at: nowIso(),
      notes: requireArg(args, "notes"),
    };
    assertJsonSchema(report, SCHEMA_PATH, "人工复核后的音乐节拍分析");
    writeJson(analysisPath, report);
    console.log(JSON.stringify({analysis: analysisPath, review: report.review}, null, 2));
    return;
  }
  const report = analyzeMusicBeats({
    projectRoot: project,
    inputPath: projectPath(project, requireArg(args, "input"), "music input"),
    outputPath: projectPath(project, args.output || "reports/music-beats.json", "beat output"),
    ffmpegPath: args.ffmpeg ? path.resolve(args.ffmpeg) : null,
    minimumBpm: Number(args["min-bpm"] || 70),
    maximumBpm: Number(args["max-bpm"] || 180),
  });
  console.log(JSON.stringify({bpm: report.grid.bpm, confidence: report.grid.confidence, review: report.review.status}, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
