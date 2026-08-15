#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateProjectState } from "./media_project_state.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDir);
const publicEntry = path.join(scriptDir, "interview-explainer.mjs");
const mediaProjectEntry = path.join(scriptDir, "media-project.mjs");
const importer = path.join(scriptDir, "import-media-asset.mjs");
const transcriptImporter = path.join(scriptDir, "import-media-transcript.mjs");
const clipValidator = path.join(scriptDir, "validate-clip-selections.mjs");
const caseRoot = path.join(skillRoot, "assets", "media-delivery-case");

function parseArgs(argv) {
  const result = { render: false, project: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--render") result.render = true;
    else if (token === "--project") result.project = path.resolve(argv[++index]);
    else throw new Error(`未知参数：${token}`);
  }
  return result;
}

function executable(name) {
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status !== 0) throw new Error(`找不到 ${name}`);
  return probe.stdout.trim().split(/\r?\n/)[0];
}

function run(command, args, cwd = skillRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `命令失败（${result.status}）：${command} ${args.join(" ")}\n`
      + `${result.stderr?.trim() || result.stdout?.trim() || "没有输出"}`,
    );
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function prepareProject(project, ffmpeg) {
  if (fs.existsSync(project) && fs.readdirSync(project).length > 0) {
    throw new Error(`自检项目必须不存在或为空：${project}`);
  }
  fs.mkdirSync(project, { recursive: true });
  run(process.execPath, [
    publicEntry,
    "create-project",
    "--project",
    project,
    "--project-id",
    "interview-v2-real-chain",
  ]);

  const caseManifest = readJson(path.join(caseRoot, "media-sources.json"));
  const narrationFixture = caseManifest.sources.find((item) => item.id === "case-narration");
  if (!narrationFixture) throw new Error("媒体交付案例缺少已经听音复核的旁白素材");
  const narrationInput = path.resolve(caseRoot, narrationFixture.file);
  const captionsInput = path.join(caseRoot, "captions.srt");
  const sourceVideo = path.join(project, "source-interview.mp4");
  run(ffmpeg, [
    "-v", "error",
    "-f", "lavfi",
    "-i", "color=c=0x34495e:s=1280x720:r=12:d=4.75",
    "-i", narrationInput,
    "-shortest",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-y",
    sourceVideo,
  ]);

  const speechText = "大家好，我是夜希，现在来测试嘴型同步。";
  const speechFile = path.join(project, "speech.txt");
  fs.writeFileSync(speechFile, speechText, "utf8");
  const commonImport = [
    "--method", "project-owned",
    "--rights-status", "confirmed",
    "--license", "deterministic-skill-fixture",
  ];
  run(process.execPath, [
    importer,
    "--project", project,
    "--input", sourceVideo,
    "--id", "interview-source",
    "--media-type", "video",
    ...commonImport,
    "--usage", "采访 v2 原声构图与渲染链路验证",
  ]);
  run(process.execPath, [
    importer,
    "--project", project,
    "--input", narrationInput,
    "--id", "reviewed-narration",
    "--media-type", "audio",
    ...commonImport,
    "--usage", "采访 v2 旁白网页渲染链路验证",
    "--voice-id", "local-poc-voice-a794c1a9",
    "--voice-name", "本地 POC 测试声音",
    "--language", "zh-CN",
    "--speech-text", speechFile,
    "--exact-voice",
  ]);

  run(process.execPath, [
    transcriptImporter,
    "--project", project,
    "--source-id", "interview-source",
    "--input", captionsInput,
    "--language", "zh-CN",
    "--kind", "user-subtitles",
    "--reviewed",
    "--review-notes", "复用固定案例已完整听音的同一音频，并验证封装后起止边界。",
  ]);

  const clips = {
    protocol: "visual-multimedia-clip-selections",
    version: 2,
    media_sources: "media-sources.json",
    transcript: "transcript.json",
    maximum_clips: 1,
    clips: [
      {
        id: "source-01",
        source_id: "interview-source",
        start_seconds: 0,
        end_seconds: 4.75,
        purpose: "验证 viewer_title、contain 构图、焦点和来源时间码的实际消费",
        spoken_content: true,
        transcript_segment_ids: ["segment-0001"],
        semantic_boundary_review: {
          status: "passed",
          listened: true,
          waveform_checked: true,
          notes: "采用固定案例完整一句，从真实音轨零点到自然结束。",
        },
        intentional_repeat_reason: "",
      },
    ],
  };
  writeJson(path.join(project, "clip-selections.json"), clips);
  run(process.execPath, [clipValidator, path.join(project, "clip-selections.json")]);

  const mediaSources = readJson(path.join(project, "media-sources.json"));
  const narrationSource = mediaSources.sources.find((item) => item.id === "reviewed-narration");
  if (!narrationSource) throw new Error("正式导入器没有生成旁白素材记录");
  const timingDirectory = path.join(project, "timings");
  fs.mkdirSync(timingDirectory, { recursive: true });
  const timingFile = path.join(timingDirectory, "reviewed-narration.srt");
  fs.copyFileSync(captionsInput, timingFile);
  const narrationIds = ["context", "explanation-01", "summary"];
  const narrationBundle = {
    protocol: "visual-multimedia-narration-bundle",
    version: 1,
    media_sources: "media-sources.json",
    language: "zh-CN",
    segments: narrationIds.map((id) => ({
      id,
      title: `${id} 真实链路验证`,
      text: speechText,
      text_sha256: narrationSource.speech.text_sha256,
      audio_source_id: narrationSource.id,
      audio_sha256: narrationSource.integrity.sha256,
      timing_file: "timings/reviewed-narration.srt",
      timing_sha256: sha256File(timingFile),
      duration_seconds: 4.75,
      voice: {
        kind: "recorded",
        provider: "project-owned",
        provider_voice_id: narrationSource.speech.provider_voice_id,
        voice_name: narrationSource.speech.voice_name,
        parameters: { fixture: "media-delivery-case" },
      },
      review: {
        listened: true,
        text_matches_audio: true,
        natural_speed: true,
        notes: "复用已经完整听音通过的固定媒体交付案例。",
      },
    })),
  };
  writeJson(path.join(project, "narration-bundle.json"), narrationBundle);

  const draftPath = path.join(project, "interview-explainer-draft.json");
  const draft = readJson(draftPath);
  draft.output.fps = 12;
  draft.style.source_card.footage_box = { x: 0.05, y: 0.18, width: 0.9, height: 0.68 };
  draft.style.source_card.fit = "contain";
  draft.style.source_card.focus = { x: 0.35, y: 0.5 };
  draft.sequence[1] = {
    id: "source-01",
    kind: "source-clip",
    role: "source-evidence",
    viewer_title: "采访原声构图 v2 验证",
    clip_id: "source-01",
    source_label: "LOCAL FIXTURE",
    translation: speechText,
    original_text: speechText,
    subtitle_cues: [
      { source_start_seconds: 0, source_end_seconds: 4.75, text: speechText },
    ],
  };
  writeJson(draftPath, draft);

  for (const packageId of narrationIds) {
    const manifestPath = path.join(project, "editable-media", packageId, "editable-media.json");
    const manifest = readJson(manifestPath);
    manifest.playback.fps = 12;
    writeJson(manifestPath, manifest);
    const htmlPath = path.join(project, "editable-media", packageId, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8")
      .replace(/data-fps="[^"]+"/, 'data-fps="12"');
    fs.writeFileSync(htmlPath, html, "utf8");
    const defaultVariant = manifest.variants.find(
      (item) => item.id === manifest.default_variant_id,
    );
    if (
      defaultVariant?.canvas?.width !== draft.output.width
      || defaultVariant?.canvas?.height !== draft.output.height
      || !html.includes(`data-width="${draft.output.width}"`)
      || !html.includes(`data-height="${draft.output.height}"`)
      || !html.includes('data-fps="12"')
      || !html.includes('data-duration="30"')
    ) {
      throw new Error(`场景包 ${packageId} 的默认变体与网页捕获根没有同步`);
    }
  }
}

function validatePlan(project) {
  const plan = readJson(path.join(project, "interview-explainer-plan.json"));
  if (plan.version !== 2 || plan.profile?.version !== "1.4.0") {
    throw new Error("正式计划器没有生成 v2 / 1.4.0 计划");
  }
  const source = plan.sequence.find((item) => item.kind === "source-clip");
  if (
    source?.content?.viewer_title !== "采访原声构图 v2 验证"
    || plan.style?.source_card?.fit !== "contain"
    || plan.style?.source_card?.focus?.x !== 0.35
  ) {
    throw new Error("正式计划没有消费 viewer_title、fit 和 focus");
  }
  const narrationHasTitle = plan.sequence
    .filter((item) => item.kind === "narration")
    .some((item) => Object.hasOwn(item.content, "title"));
  if (narrationHasTitle) throw new Error("v2 旁白计划仍携带可能误上屏的通用 title");
  return plan;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const ffmpeg = executable("ffmpeg");
  const ffprobe = executable("ffprobe");
  const automaticTemp = options.project == null;
  const testRoot = path.join(skillRoot, "artifacts");
  fs.mkdirSync(testRoot, {recursive: true});
  const project = options.project || path.join(
    testRoot,
    `iv-${Date.now().toString(36)}-${process.pid}`,
  );
  prepareProject(project, ffmpeg);
  const stateValidation = validateProjectState(path.join(project, "media-project-state.json"));
  if (
    !stateValidation.ok
    || stateValidation.media_kind !== "mixed-video"
    || stateValidation.profile !== "interview-explainer"
    || stateValidation.current_stage !== "content"
  ) {
    throw new Error(
      `采访 profile 没有接入通用 v3 阶段状态：${stateValidation.errors.join("; ")}`,
    );
  }
  run(process.execPath, [
    mediaProjectEntry,
    "submit-stage",
    "--project", project,
    "--stage", "content",
    "--artifact", "content-contract:document:interview-explainer-draft.json:interview-content-contract",
  ]);
  run(process.execPath, [
    mediaProjectEntry,
    "approve-stage",
    "--project", project,
    "--stage", "content",
    "--evidence", "固定生产案例确认采访内容合同",
  ]);
  run(process.execPath, [publicEntry, "plan", "--project", project, "--ffprobe", ffprobe]);
  const plan = validatePlan(project);
  const plannedState = validateProjectState(path.join(project, "media-project-state.json"));
  if (
    !plannedState.ok
    || plannedState.current_stage !== "direction"
    || plannedState.stages.find((stage) => stage.id === "direction")?.status
      !== "waiting-approval"
  ) {
    throw new Error("采访计划没有作为通用 direction 成果停下等待确认");
  }
  run(process.execPath, [
    publicEntry,
    "confirm-plan",
    "--project",
    project,
    "--confirmed-by",
    "user",
    "--evidence",
    "固定生产案例确认采访导演计划",
  ]);
  const blockedRender = spawnSync(process.execPath, [
    publicEntry,
    "render",
    "--project",
    project,
    "--ffmpeg",
    ffmpeg,
    "--ffprobe",
    ffprobe,
  ], {
    cwd: skillRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (
    blockedRender.status === 0
    || !`${blockedRender.stderr || ""}${blockedRender.stdout || ""}`.includes("integrated-sample")
  ) {
    throw new Error("采访完整渲染没有在综合样片确认前被通用阶段门阻止");
  }

  let output = null;
  if (options.render) {
    run(process.execPath, [
      mediaProjectEntry,
      "submit-stage",
      "--project",
      project,
      "--stage",
      "integrated-sample",
      "--artifact",
      "integrated-sample:video:source-interview.mp4:interview-integrated-sample",
    ]);
    run(process.execPath, [
      mediaProjectEntry,
      "approve-stage",
      "--project",
      project,
      "--stage",
      "integrated-sample",
      "--evidence",
      "固定生产案例确认真实连续样片",
    ]);
    run(process.execPath, [
      publicEntry,
      "render",
      "--project",
      project,
      "--ffmpeg",
      ffmpeg,
      "--ffprobe",
      ffprobe,
    ]);
    output = path.resolve(project, plan.output.file);
    run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new Error("正式采访渲染器没有生成可解码成片");
    }
  }

  console.log(JSON.stringify({
    status: "passed",
    project,
    temporary_project: automaticTemp,
    plan_version: plan.version,
    profile_version: plan.profile.version,
    source_viewer_title: plan.sequence.find((item) => item.kind === "source-clip").content.viewer_title,
    source_card: plan.style.source_card,
    generic_stage_state: {
      version: 3,
      media_kind: stateValidation.media_kind,
      profile: stateValidation.profile,
      current_stage: stateValidation.current_stage,
      plan_stage_status: plannedState.stages.find(
        (stage) => stage.id === "direction",
      ).status,
      full_render_blocked_before_sample_approval: true,
    },
    rendered_output: output,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
