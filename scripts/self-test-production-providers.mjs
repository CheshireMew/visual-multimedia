#!/usr/bin/env node

import {
  inspectLocalMediaCapabilities,
  resolveProviderNeed,
} from "./local-media-environment.mjs";

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
    "web.clip.render.inspect",
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

const GENERIC_HYPERFRAMES_PROBE = {
  detected_adapter: "generic-hyperframes",
  version: "0.7.82",
  command_sha256: "a".repeat(64),
  help_sha256: "b".repeat(64),
  capabilities: {
    deterministic_web_render: true,
    dynamic_sample: true,
    production_web_render: true,
    transparent_output: true,
    structured_preflight_report: false,
    interval_backend_plan: false,
    direct_encode: false,
  },
};

const RENDERKIT_PROBE = {
  detected_adapter: "renderkit",
  command_sha256: "c".repeat(64),
  help_sha256: "d".repeat(64),
  capabilities: {
    deterministic_web_render: true,
    dynamic_sample: false,
    production_web_render: false,
    transparent_output: false,
    structured_preflight_report: true,
    interval_backend_plan: true,
    direct_encode: true,
  },
};

function environment({mediaflow = false, hyperframes = null} = {}) {
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
      hyperframes,
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
  environment({
    mediaflow: true,
    hyperframes: {
      command: "hyperframes",
      adapter: "generic-hyperframes",
      probe: GENERIC_HYPERFRAMES_PROBE,
    },
  }),
  "web-render",
);
assert(enhancedWeb.preferred_provider === "mediaflow", "网页渲染没有优先 MediaFlow Pro");
assert(
  enhancedWeb.candidates.join(",") === "mediaflow,local,hyperframes",
  "网页渲染提供方优先级错误",
);

const untypedGeneric = inspectLocalMediaCapabilities(environment({
  hyperframes: {
    command: "hyperframes",
    probe: GENERIC_HYPERFRAMES_PROBE,
  },
})).providers.hyperframes;
assert(untypedGeneric.probe_status === "ready", "未声明 adapter 时没有执行真实能力探测");
assert(
  untypedGeneric.configuration_status === "legacy-untyped",
  "旧配置没有明确标记为未声明 adapter",
);

const renderKit = inspectLocalMediaCapabilities(environment({
  hyperframes: {
    command: "hf-render",
    adapter: "renderkit",
    probe: RENDERKIT_PROBE,
  },
})).providers.hyperframes;
assert(renderKit.capabilities.interval_backend_plan, "RenderKit 结构化区间计划能力丢失");
assert(!renderKit.capabilities.production_web_render, "没有动态样片能力的 RenderKit 被误报为正式提供方");
const renderKitResolution = resolveProviderNeed(environment({
  hyperframes: {
    command: "hf-render",
    adapter: "renderkit",
    probe: RENDERKIT_PROBE,
  },
}), "web-render");
assert(!renderKitResolution.candidates.includes("hyperframes"), "RenderKit 绕过了动态样片门禁");

const mismatch = inspectLocalMediaCapabilities(environment({
  hyperframes: {
    command: "hyperframes",
    adapter: "renderkit",
    probe: GENERIC_HYPERFRAMES_PROBE,
  },
})).providers.hyperframes;
assert(mismatch.probe_status === "failed", "adapter 声明与真实命令不一致时没有失败");
assert(!mismatch.capabilities.production_web_render, "adapter 不一致仍暴露正式渲染能力");

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
  generic_hyperframes: untypedGeneric,
  renderkit: renderKit,
  adapter_mismatch: mismatch,
  mediaflow_preferred_for_all_supported_needs: mediaFlowFirst,
}, null, 2));
