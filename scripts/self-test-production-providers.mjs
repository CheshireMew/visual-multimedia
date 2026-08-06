#!/usr/bin/env node

import {resolveProviderNeed} from "./local-media-environment.mjs";

const MEDIAFLOW_PROBE = {
  operations: [
    "audio.bus.update",
    "audio.inspect",
    "export.sequence",
    "preview.render",
    "project.changes.list",
    "project.create",
    "project.handoff.inspect",
    "project.inspect",
    "project.version.create",
    "quality.reference.compare",
    "speech.synthesize",
    "speech.transcribe",
    "subtitle.list",
    "subtitle.segment.update",
    "subtitle.track.style.update",
    "timeline.clip.add",
    "timeline.clip.audio",
    "timeline.clip.delete",
    "timeline.clip.move",
    "timeline.clip.split",
    "timeline.get",
    "timeline.portable.import",
    "timeline.portable.inspect",
    "web.clip.export",
    "web.clip.render",
    "web.import",
  ],
  built_in_capabilities: [
    "asynchronous-project-handoff",
    "editable-web-media",
    "portable-timeline-import",
    "project-editing",
    "reference-video-comparison",
    "web-multi-format-export",
  ],
  runtime_capabilities: [
    "chromium",
    "faster-whisper-xxl",
    "ffmpeg",
    "gpt-sovits-v2pro",
    "mlt",
    "native-preview",
  ],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function environment({mediaflow = false, hyperframes = false} = {}) {
  return {
    configPath: null,
    runtime: {cacheRoot: "D:/Tools/visual-multimedia-cache"},
    providers: {
      local: {
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        browser: "chromium",
        playwright: {available: true, browser_executable: "chromium"},
      },
      mediaflow: mediaflow ? {sourceRoot: "MediaFlow Pro", probe: MEDIAFLOW_PROBE} : null,
      hyperframes: hyperframes ? {command: "hyperframes"} : null,
    },
  };
}

const independent = resolveProviderNeed(environment(), "timeline-render");
assert(independent.preferred_provider === "local", "没有 MediaFlow Pro 时没有保留本地完整时间线");
assert(independent.candidates.join(",") === "local", "本地独立环境出现了虚假提供方");

const enhancedTimeline = resolveProviderNeed(
  environment({mediaflow: true}),
  "timeline-render",
);
assert(enhancedTimeline.preferred_provider === "mediaflow", "时间线没有优先 MediaFlow Pro");
assert(
  enhancedTimeline.candidates.join(",") === "mediaflow,local",
  "时间线没有保留有序本地后备能力",
);

const enhancedWeb = resolveProviderNeed(
  environment({mediaflow: true, hyperframes: true}),
  "web-render",
);
assert(enhancedWeb.preferred_provider === "mediaflow", "网页渲染没有优先 MediaFlow Pro");
assert(
  enhancedWeb.candidates.join(",") === "mediaflow,local,hyperframes",
  "网页渲染提供方优先级错误",
);

const mediaFlowFirstNeeds = [
  "timeline-edit",
  "subtitle-edit",
  "audio-edit",
  "speech-transcribe",
  "speech-synthesize",
  "preview",
  "export",
  "reference-compare",
  "native-project",
  "desktop-handoff",
];
const mediaFlowFirst = Object.fromEntries(mediaFlowFirstNeeds.map((need) => {
  const result = resolveProviderNeed(environment({mediaflow: true}), need);
  assert(result.preferred_provider === "mediaflow", `${need} 没有优先 MediaFlow Pro`);
  return [need, result.preferred_provider];
}));

console.log(JSON.stringify({
  ok: true,
  local_without_mediaflow: independent,
  mediaflow_preferred_timeline: enhancedTimeline,
  mediaflow_preferred_web: enhancedWeb,
  mediaflow_preferred_for_all_supported_needs: mediaFlowFirst,
}, null, 2));
