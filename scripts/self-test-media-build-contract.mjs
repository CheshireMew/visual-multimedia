#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assemblyCacheKey,
  buildUnitCacheKey,
  validateMediaBuildPlan,
  validateMediaBuildReport,
} from "./media_build_contract.mjs";

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-media-build-contract-"));

const units = ["opening", "middle", "ending"].map((id, index) => ({
  id,
  order: index + 1,
  kind: "timeline-range",
  source_unit_id: id,
  timeline_start_frame: index * 30,
  duration_frames: 30,
  dependencies: [
    {role: `scene:${id}`, file: `inputs/${id}.json`, sha256: sha(`${id}:v1`)},
  ],
}));
const plan = validateMediaBuildPlan({
  protocol: "visual-multimedia-media-build-plan",
  version: 1,
  project_id: "generic-video-test",
  media_kind: "video",
  profile: "generic-video",
  stage_target: "full-preview",
  created_at: "2026-08-03T00:00:00.000Z",
  source_contract: "timeline.json",
  source_contract_sha256: sha("timeline:v1"),
  producer: {
    entry: "scripts/media-build.mjs",
    sha256: sha("entry:v1"),
    modules: [{file: "scripts/media_build_contract.mjs", sha256: sha("module:v1")}],
  },
  output: {
    file: "renders/preview.mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    audio_sample_rate: 48000,
    audio_channels: 2,
    quality_profile: "proxy",
  },
  units,
  assembly: {
    strategy: "ordered-concat",
    audio_strategy: "continuous-master",
    caption_strategy: "burned-in",
  },
});
const firstKeys = plan.units.map((unit) => buildUnitCacheKey(plan, unit, {
  scene: unit.source_unit_id,
  value: "v1",
}));
const changedPlan = structuredClone(plan);
changedPlan.source_contract_sha256 = sha("timeline:v2");
changedPlan.units[1].dependencies[0].sha256 = sha("middle:v2");
const secondKeys = changedPlan.units.map((unit, index) => buildUnitCacheKey(
  changedPlan,
  unit,
  {scene: unit.source_unit_id, value: index === 1 ? "v2" : "v1"},
));
if (firstKeys[0] !== secondKeys[0] || firstKeys[2] !== secondKeys[2]) {
  throw new Error("未变化单元被全局合同哈希错误失效");
}
if (firstKeys[1] === secondKeys[1]) {
  throw new Error("变化单元没有生成新缓存键");
}
const renderedUnits = plan.units.map((unit, index) => ({
  id: unit.id,
  file: `renders/segments/${unit.id}.mp4`,
  sha256: sha(`render:${unit.id}`),
  bytes: 100 + index,
  frames: unit.duration_frames,
  status: "rendered",
  cache_key: firstKeys[index],
}));
const assemblyKey = assemblyCacheKey(plan, renderedUnits, {
  strategy: "continuous-master",
  sha256: sha("audio:v1"),
});
validateMediaBuildReport({
  protocol: "visual-multimedia-media-build-report",
  version: 2,
  profile: "generic-video",
  build_plan: "media-build-plan.json",
  build_plan_sha256: sha("build-plan:v1"),
  producer: {
    entry: "scripts/media-build.mjs",
    sha256: sha("entry:v1"),
    tools: {node: process.version, mediaflow_pro: "2"},
  },
  units: renderedUnits,
  audio: {
    strategy: "continuous-master",
    status: "rendered",
    file: "renders/audio/master.wav",
    sha256: sha("audio:v1"),
    cache_key: sha("audio-key:v1"),
  },
  captions: {
    mode: "burned-in",
    file: "captions.srt",
    sha256: sha("captions:v1"),
    render_file: "captions.ass",
    render_sha256: sha("captions-render:v1"),
    visible_in_standalone_output: true,
  },
  assembly: {status: "assembled", cache_key: assemblyKey},
  output: {
    file: "renders/preview.mp4",
    sha256: sha("preview:v1"),
    bytes: 1000,
    frames: 90,
    duration_seconds: 3,
    width: 1920,
    height: 1080,
    fps: 30,
    audio_sample_rate: 48000,
    audio_channels: 2,
  },
  completed_at: "2026-08-03T00:00:03.000Z",
});

process.stdout.write(`${JSON.stringify({
  status: "passed",
  temporary_project: root,
  first_keys: firstKeys,
  second_keys: secondKeys,
  localized_invalidation: [false, true, false],
  assembly_key: assemblyKey,
}, null, 2)}\n`);
