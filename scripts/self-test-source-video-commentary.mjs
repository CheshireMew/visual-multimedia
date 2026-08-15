#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLI = path.join(SCRIPT_DIR, "source-video-commentary.mjs");
const TEST_PARENT = path.join(SKILL_ROOT, "artifacts");
const providerIndex = process.argv.indexOf("--provider");
const PROVIDER = providerIndex >= 0 ? process.argv[providerIndex + 1] : "local";
const ROOT = path.join(
  TEST_PARENT,
  `sc-${PROVIDER}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
);

function commandPath(name) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], {encoding: "utf8", windowsHide: true});
  const candidate = (result.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
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

function writeJson(relative, value) {
  const target = path.join(ROOT, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

function writeText(relative, value) {
  const target = path.join(ROOT, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, value, "utf8");
  return target;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceRecord({id, mediaType, file, mimeType, speech = null}) {
  const absolute = path.join(ROOT, ...file.split("/"));
  return {
    id,
    media_type: mediaType,
    file,
    representation: {kind: "source", source_id: null, build: null, verification: null},
    acquisition: {method: "generated-in-project", source_url: "", captured_at: "2026-08-11T00:00:00.000Z"},
    rights: {status: "not-required", license: "self-test synthetic fixture", attribution: "", terms_url: ""},
    usage: "source-video-commentary self-test",
    integrity: {sha256: sha256(absolute), bytes: fs.statSync(absolute).size, mime_type: mimeType},
    generation: {provider: "ffmpeg", model: "lavfi", prompt: "deterministic synthetic self-test media", seed: null, created_at: "2026-08-11T00:00:00.000Z"},
    speech,
    provenance_runs: [{recorded_at: "2026-08-11T00:00:00.000Z", provider: "ffmpeg", job_id: id, capture: null}],
    subject: null,
    crops: {},
    notes: "synthetic test asset",
  };
}

function main() {
  if (!new Set(["local", "mediaflow"]).has(PROVIDER)) throw new Error("--provider 只能是 local 或 mediaflow");
  fs.mkdirSync(ROOT, {recursive: true});
  const ffmpeg = commandPath("ffmpeg");
  const ffprobe = commandPath("ffprobe");
  cli(["create-project", "--project", ROOT, "--project-id", `commentary-${PROVIDER}-test`], "创建素材解说型项目");

  const sourceVideo = path.join(ROOT, "source-video.mp4");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=4",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", sourceVideo,
  ], "生成带原声的源视频");
  const narrationOne = path.join(ROOT, "narration-one.wav");
  const narrationThree = path.join(ROOT, "narration-three.wav");
  const backgroundMusic = path.join(ROOT, "background-music.wav");
  run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", narrationOne], "生成第一段旁白");
  run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", narrationThree], "生成第三段旁白");
  run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=180:sample_rate=48000:duration=0.75", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", backgroundMusic], "生成非整帧长度的循环背景音乐");

  const sourceSubtitle = writeText("source-subtitles.srt", "1\n00:00:01,200 --> 00:00:02,200\n这是需要保留的关键原声\n");
  const timingOne = writeText("narration-one.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n第一段解说\n");
  const timingThree = writeText("narration-three.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n第三段解说\n");
  const scriptText = "# 完整解说稿\n\n第一段用旁白覆盖源片。第二段恢复关键原声。第三段让旁白压在低电平环境声上。\n";
  const script = writeText("source-video-commentary-script.md", scriptText);
  const narrationOneText = "第一段用旁白解释画面";
  const narrationThreeText = "第三段保留低电平环境声";

  writeJson("media-sources.json", {
    protocol: "visual-multimedia-media-sources",
    version: 3,
    sources: [
      sourceRecord({id: "source-video", mediaType: "video", file: "source-video.mp4", mimeType: "video/mp4"}),
      sourceRecord({id: "narration-one-audio", mediaType: "audio", file: "narration-one.wav", mimeType: "audio/wav", speech: {provider_voice_id: "self-test-660", voice_name: "Self Test 660", language: "zh-CN", text_sha256: sha256Text(narrationOneText), exact_identity: true}}),
      sourceRecord({id: "narration-three-audio", mediaType: "audio", file: "narration-three.wav", mimeType: "audio/wav", speech: {provider_voice_id: "self-test-880", voice_name: "Self Test 880", language: "zh-CN", text_sha256: sha256Text(narrationThreeText), exact_identity: true}}),
      sourceRecord({id: "background-music", mediaType: "audio", file: "background-music.wav", mimeType: "audio/wav"}),
    ],
  });
  writeJson("transcript.json", {
    protocol: "visual-multimedia-media-transcript",
    version: 1,
    media_sources: "media-sources.json",
    source_id: "source-video",
    source_sha256: sha256(sourceVideo),
    language: "zh-CN",
    input: {kind: "user-subtitles", file: "source-subtitles.srt", sha256: sha256(sourceSubtitle)},
    review: {status: "passed", listened: true, reviewed_at: "2026-08-11T00:00:00.000Z", notes: "已完整听过合成测试原声并确认边界"},
    segments: [{
      id: "source-spoken-01",
      start_seconds: 1.2,
      end_seconds: 2.2,
      text: "这是需要保留的关键原声",
      words: [{text: "这是需要保留的关键原声", start_seconds: 1.2, end_seconds: 2.2}],
      uncertain_terms: [],
    }],
  });
  writeJson("clip-selections.json", {
    protocol: "visual-multimedia-clip-selections",
    version: 2,
    media_sources: "media-sources.json",
    transcript: "transcript.json",
    maximum_clips: 6,
    clips: [
      {id: "clip-narration-only", source_id: "source-video", start_seconds: 0, end_seconds: 1, purpose: "旁白覆盖下的开场画面", spoken_content: false, transcript_segment_ids: [], semantic_boundary_review: {status: "passed", listened: true, waveform_checked: true, notes: "已复核"}, intentional_repeat_reason: ""},
      {id: "clip-source-only", source_id: "source-video", start_seconds: 1.2, end_seconds: 2.25, purpose: "恢复关键原声作为证据", spoken_content: true, transcript_segment_ids: ["source-spoken-01"], semantic_boundary_review: {status: "passed", listened: true, waveform_checked: true, notes: "已听音确认完整语义"}, intentional_repeat_reason: ""},
      {id: "clip-source-bed", source_id: "source-video", start_seconds: 2.4, end_seconds: 3.4, purpose: "旁白下保留环境声", spoken_content: false, transcript_segment_ids: [], semantic_boundary_review: {status: "passed", listened: true, waveform_checked: true, notes: "已复核"}, intentional_repeat_reason: ""},
    ],
  });
  writeJson("narration-bundle.json", {
    protocol: "visual-multimedia-narration-bundle",
    version: 1,
    media_sources: "media-sources.json",
    language: "zh-CN",
    segments: [
      {id: "narration-one", title: "旁白覆盖", text: narrationOneText, text_sha256: sha256Text(narrationOneText), audio_source_id: "narration-one-audio", audio_sha256: sha256(narrationOne), timing_file: "narration-one.vtt", timing_sha256: sha256(timingOne), duration_seconds: 1, voice: {kind: "synthetic", provider: "ffmpeg", provider_voice_id: "self-test-660", voice_name: "Self Test 660", parameters: {frequency: 660}}, review: {listened: true, text_matches_audio: true, natural_speed: true, notes: "测试音频已完整试听"}},
      {id: "narration-three", title: "旁白与源声混合", text: narrationThreeText, text_sha256: sha256Text(narrationThreeText), audio_source_id: "narration-three-audio", audio_sha256: sha256(narrationThree), timing_file: "narration-three.vtt", timing_sha256: sha256(timingThree), duration_seconds: 1, voice: {kind: "synthetic", provider: "ffmpeg", provider_voice_id: "self-test-880", voice_name: "Self Test 880", parameters: {frequency: 880}}, review: {listened: true, text_matches_audio: true, natural_speed: true, notes: "测试音频已完整试听"}},
    ],
  });
  writeJson("source-video-commentary-draft.json", {
    protocol: "visual-multimedia-source-video-commentary-draft",
    version: 1,
    project_id: `commentary-${PROVIDER}-test`,
    profile: "source-video-commentary@1.0.0",
    target: {audience: "合同自测", editorial_angle: "同一条视频逐段切换三种声音职责", audience_outcome: "证明旁白覆盖、关键原声和源声衬底都进入真实时间线", width: 320, height: 180, fps: 10, audio_sample_rate: 48000, audio_channels: 2, background: "#000000", caption_mode: "burned-in"},
    script: {file: "source-video-commentary-script.md", sha256: sha256(script), confirmed_by: "user", confirmed_at: "2026-08-11T00:00:00.000Z", confirmation_evidence: "自测固定完整稿"},
    contracts: {media_sources: "media-sources.json", transcript: "transcript.json", clip_selections: "clip-selections.json", narration_bundle: "narration-bundle.json", video_direction_plan: null},
    background_music: {source_id: "background-music", loop: true, base_gain_db: -22, narration_reduction_db: -8, source_only_reduction_db: -5, fade_in_seconds: 0.1, fade_out_seconds: 0.1},
    integrated_sample: {segment_ids: ["segment-01", "segment-02", "segment-03"], reason: "三段共同覆盖全部声音职责"},
    segments: [
      {id: "segment-01", order: 1, purpose: "旁白完全覆盖源片声音", visual_role: "hook", visual: {kind: "source-clip", clip_selection_id: "clip-narration-only", fit: "cover", freeze_when_shorter: true}, narration_segment_id: "narration-one", audio: {mode: "narration-only", source_gain_db: 0}, captions: [{id: "caption-01", start_offset_seconds: 0, end_offset_seconds: 1, text: narrationOneText, language: "zh-CN", source_kind: "narration", source_segment_ids: ["narration-one"]}]},
      {id: "segment-02", order: 2, purpose: "恢复关键原声", visual_role: "evidence", visual: {kind: "source-clip", clip_selection_id: "clip-source-only", fit: "cover", freeze_when_shorter: false}, narration_segment_id: null, audio: {mode: "source-only", source_gain_db: 0}, captions: [{id: "caption-02", start_offset_seconds: 0, end_offset_seconds: 1, text: "这是需要保留的关键原声", language: "zh-CN", source_kind: "transcript", source_segment_ids: ["source-spoken-01"]}]},
      {id: "segment-03", order: 3, purpose: "旁白下压低源片环境声", visual_role: "payoff", visual: {kind: "source-clip", clip_selection_id: "clip-source-bed", fit: "cover", freeze_when_shorter: true}, narration_segment_id: "narration-three", audio: {mode: "narration-with-source-bed", source_gain_db: -18}, captions: [{id: "caption-03", start_offset_seconds: 0, end_offset_seconds: 1, text: narrationThreeText, language: "zh-CN", source_kind: "narration", source_segment_ids: ["narration-three"]}]},
    ],
  });

  cli(["validate", "--project", ROOT, "--ffprobe", ffprobe], "验证素材解说合同");
  cli(["confirm-content", "--project", ROOT, "--ffprobe", ffprobe, "--confirmed-by", "user", "--evidence", "自测确认完整内容与声音"], "确认内容阶段");
  cli(["plan", "--project", ROOT, "--ffprobe", ffprobe], "建立素材解说计划");
  cli(["confirm-plan", "--project", ROOT, "--confirmed-by", "user", "--evidence", "自测确认逐段制作计划"], "确认制作计划");
  cli(["sample", "--project", ROOT, "--provider", PROVIDER, "--ffmpeg", ffmpeg, "--ffprobe", ffprobe], "生成综合样片");
  cli(["confirm-sample", "--project", ROOT, "--confirmed-by", "user", "--evidence", "自测确认三种声音职责的综合样片"], "确认综合样片");
  const rendered = cli(["render", "--project", ROOT, "--provider", PROVIDER, "--ffmpeg", ffmpeg, "--ffprobe", ffprobe], "生成全量预览");
  const reviewed = cli(["review", "--project", ROOT, "--ffmpeg", ffmpeg, "--ffprobe", ffprobe, "--agent-status", "passed", "--agent-completed", "true", "--agent-evidence", "自测完整解码并结合联系表审阅了同一三秒成片"], "完整评审全量预览");
  if (reviewed.status !== "passed") throw new Error("完整评审没有通过");
  cli(["confirm-preview", "--project", ROOT, "--confirmed-by", "user", "--evidence", "自测确认全量预览"], "确认全量预览");
  const firstFinalize = cli(["finalize", "--project", ROOT, "--ffprobe", ffprobe], "提交最终交付");
  if (firstFinalize.status !== "waiting-approval") throw new Error("分阶段最终交付没有等待确认");
  cli(["confirm-delivery", "--project", ROOT, "--confirmed-by", "user", "--evidence", "自测确认最终文件"], "确认最终交付");
  const completed = cli(["finalize", "--project", ROOT, "--ffprobe", ffprobe], "收口最终交付");
  if (completed.status !== "complete") throw new Error("最终交付没有完成");

  const timeline = readJson(path.join(ROOT, "media-timeline.json"));
  const sourceAudio = timeline.tracks.find((item) => item.id === "commentary-source-audio").clips;
  const narration = timeline.tracks.find((item) => item.id === "commentary-narration").clips;
  const music = timeline.tracks.find((item) => item.id === "commentary-music").clips;
  if (sourceAudio.length !== 2 || narration.length !== 2 || !sourceAudio.some((item) => item.gain_db === -18)) {
    throw new Error("portable timeline 没有真实表达三种逐段声音职责");
  }
  if (music.length < 5 || !music.some((item) => item.gain_db === -27) || !music.some((item) => item.gain_db === -30)) {
    throw new Error("portable timeline 没有循环背景音乐或逐段人声避让");
  }
  for (const track of timeline.tracks) {
    let previousEndFrames = 0;
    for (const clip of [...track.clips].sort((a, b) => a.timeline_start_seconds - b.timeline_start_seconds)) {
      const startFrames = clip.timeline_start_seconds * timeline.profile.frame_rate;
      const durationFrames = clip.duration_seconds * timeline.profile.frame_rate;
      if (Math.abs(startFrames - Math.round(startFrames)) > 1e-7 || Math.abs(durationFrames - Math.round(durationFrames)) > 1e-7) {
        throw new Error(`portable timeline ${track.id}/${clip.id} 没有对齐整数帧`);
      }
      if (startFrames + 1e-7 < previousEndFrames) throw new Error(`portable timeline ${track.id} 存在片段重叠`);
      previousEndFrames = startFrames + durationFrames;
    }
  }
  const planText = fs.readFileSync(path.join(ROOT, "source-video-commentary-plan.json"), "utf8");
  if (planText.includes('"start_seconds"') || planText.includes('"end_seconds"')) throw new Error("production plan 复制了 selection 时间码");
  run(ffmpeg, ["-v", "error", "-i", completed.output, "-f", "null", "-"], "解码最终素材解说视频");
  const delivery = readJson(path.join(ROOT, "media-delivery.json"));
  if (PROVIDER === "mediaflow" && (delivery.production.truth_kind !== "mediaflow-project" || !delivery.editability.native_project)) {
    throw new Error("MediaFlow 自测没有交付可重新打开的原生工程真源");
  }
  if (PROVIDER === "local" && delivery.production.truth_kind !== "portable-timeline") {
    throw new Error("本地自测没有交付 portable timeline source bundle 真源");
  }
  process.stdout.write(`${JSON.stringify({ok: true, provider: PROVIDER, project: ROOT, output: completed.output, output_sha256: completed.output_sha256, three_segment_audio_modes: true, background_music_loop_and_ducking: true, plan_does_not_duplicate_source_ranges: true, review_passed: true, delivery_truth_kind: delivery.production.truth_kind, native_project: delivery.editability.native_project?.file || null}, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`错误：${error.stack || error.message}\n`);
  process.exitCode = 1;
}
