#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const LUT_ROOT = path.join(ROOT, "assets", "editor-luts");
const PREVIEW_ROOT = path.join(ROOT, "assets", "editor-resource-previews");
const SOUND_EFFECT_ROOT = path.join(ROOT, "assets", "editor-sound-effects");
const CATALOG_PATH = path.join(ROOT, "media-resource-catalog.json");
const LUT_SIZE = 17;

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function format(value) {
  return clamp(value).toFixed(6);
}

function lutDocument(title, transform) {
  const lines = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${LUT_SIZE}`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0",
  ];
  for (let blueIndex = 0; blueIndex < LUT_SIZE; blueIndex += 1) {
    for (let greenIndex = 0; greenIndex < LUT_SIZE; greenIndex += 1) {
      for (let redIndex = 0; redIndex < LUT_SIZE; redIndex += 1) {
        const source = [redIndex, greenIndex, blueIndex].map(
          (value) => value / (LUT_SIZE - 1),
        );
        lines.push(transform(...source).map(format).join(" "));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function softCinema(red, green, blue) {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const curve = (value) => 0.018 + 0.962 * (value * value * (3 - 2 * value));
  const saturation = 0.92;
  return [
    luma + (curve(red) - luma) * saturation + 0.018 * luma,
    luma + (curve(green) - luma) * saturation + 0.004 * luma,
    luma + (curve(blue) - luma) * saturation - 0.014 * luma,
  ];
}

function cleanCool(red, green, blue) {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const contrast = (value) => 0.5 + (value - 0.5) * 1.08;
  const shadow = 1 - luma;
  const saturation = 1.04;
  return [
    luma + (contrast(red) - luma) * saturation - 0.006 * shadow,
    luma + (contrast(green) - luma) * saturation + 0.006 * shadow,
    luma + (contrast(blue) - luma) * saturation + 0.024 * shadow,
  ];
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function packageEntries(packageRoot) {
  const entries = [];
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) walk(absolute);
      else if (item.isFile()) {
        entries.push({
          absolute,
          relative: path.relative(packageRoot, absolute).split(path.sep).join("/"),
        });
      } else {
        throw new Error(`资源包不能包含符号链接或特殊文件：${absolute}`);
      }
    }
  };
  walk(packageRoot);
  return entries.sort((left, right) =>
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
  );
}

function sha256Tree(packageRoot) {
  const hash = crypto.createHash("sha256");
  for (const entry of packageEntries(packageRoot)) {
    hash.update(entry.relative);
    hash.update("\0");
    hash.update(sha256File(entry.absolute));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function imagePreview(filePath) {
  return { type: "image", path: relative(filePath), mime_type: "image/svg+xml" };
}

function svgPreview({ title, subtitle, accent, secondary, motif }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#101827"/><stop offset="1" stop-color="#17233a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="${accent}"/><stop offset="1" stop-color="${secondary}"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" rx="26" fill="url(#bg)"/>
  <rect x="28" y="28" width="584" height="304" rx="20" fill="none" stroke="#ffffff" stroke-opacity=".12"/>
  ${motif}
  <text x="52" y="260" fill="#f7f9ff" font-family="Segoe UI, sans-serif" font-size="34" font-weight="700">${title}</text>
  <text x="52" y="300" fill="#aab7cf" font-family="Segoe UI, sans-serif" font-size="20">${subtitle}</text>
</svg>\n`;
}

function wavBuffer(durationSeconds, sampleAt) {
  const sampleRate = 48_000;
  const frameCount = Math.round(durationSeconds * sampleRate);
  const buffer = Buffer.alloc(44 + frameCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frameCount * 2, 40);
  for (let index = 0; index < frameCount; index += 1) {
    const time = index / sampleRate;
    const sample = Math.max(-1, Math.min(1, sampleAt(time, durationSeconds)));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return buffer;
}

function softConfirm(time, duration) {
  const attack = Math.min(1, time / 0.018);
  const release = Math.max(0, Math.min(1, (duration - time) / 0.18));
  const frequency = time < 0.24 ? 659.25 : 880;
  return 0.34 * attack * release * Math.sin(2 * Math.PI * frequency * time);
}

function markerPop(time, duration) {
  const envelope = Math.exp(-11 * time) * Math.min(1, time / 0.004);
  const phase = 2 * Math.PI * (980 * time - 760 * time * time);
  const tail = Math.max(0, Math.min(1, (duration - time) / 0.025));
  return 0.5 * envelope * tail * Math.sin(phase);
}

function builtinOrigin() {
  return {
    type: "builtin",
    library_id: null,
    library_version: null,
    item_id: null,
    content_sha256: null,
  };
}

function rights(license, attribution) {
  return {
    status: "confirmed",
    license,
    attribution,
    terms_url: "https://www.mozilla.org/MPL/2.0/",
  };
}

function editableMediaItem({
  id,
  name,
  description,
  packageRoot,
  tags,
  capabilities,
  rank,
  duration,
  license,
  attribution,
  previewPath,
}) {
  return {
    id,
    resource_version: "1.1.0",
    category: "motion-graphic",
    name,
    description,
    provider: "visual-multimedia",
    tags,
    capabilities,
    featured_rank: rank,
    preview: imagePreview(previewPath),
    rights: rights(license, attribution),
    origin: builtinOrigin(),
    adoption: {
      type: "editable-media-package",
      package: relative(packageRoot),
      manifest_sha256: sha256File(path.join(packageRoot, "editable-media.json")),
      package_sha256: sha256Tree(packageRoot),
      default_duration_frames: duration,
    },
  };
}

function lutItem({ id, name, description, filePath, previewPath, tags, rank }) {
  const bytes = fs.readFileSync(filePath);
  return {
    id,
    resource_version: "1.1.0",
    category: "lut",
    name,
    description,
    provider: "visual-multimedia",
    tags,
    capabilities: ["color-grade", "clip-effect", "cube-lut"],
    featured_rank: rank,
    preview: imagePreview(previewPath),
    rights: rights("MPL-2.0", "Original LUT authored by visual-multimedia."),
    origin: builtinOrigin(),
    adoption: {
      type: "media-file",
      file: relative(filePath),
      sha256: sha256Buffer(bytes),
      bytes: bytes.length,
      mime_type: "application/x-cube-lut",
      media_type: "lut",
      placement: "clip-effect",
    },
  };
}

function soundEffectItem({ id, name, description, filePath, tags, rank }) {
  const bytes = fs.readFileSync(filePath);
  return {
    id,
    resource_version: "1.0.0",
    category: "sound-effect",
    name,
    description,
    provider: "visual-multimedia",
    tags,
    capabilities: ["audio-preview", "timeline-ready", "original-audio"],
    featured_rank: rank,
    preview: { type: "audio", path: relative(filePath), mime_type: "audio/wav" },
    rights: rights("MPL-2.0", "Original sound effect authored by visual-multimedia."),
    origin: builtinOrigin(),
    adoption: {
      type: "media-file",
      file: relative(filePath),
      sha256: sha256Buffer(bytes),
      bytes: bytes.length,
      mime_type: "audio/wav",
      media_type: "audio",
      placement: "audio-track",
    },
  };
}

fs.mkdirSync(LUT_ROOT, { recursive: true });
fs.mkdirSync(PREVIEW_ROOT, { recursive: true });
fs.mkdirSync(SOUND_EFFECT_ROOT, { recursive: true });
const softCinemaPath = path.join(LUT_ROOT, "soft-cinema-17.cube");
const cleanCoolPath = path.join(LUT_ROOT, "clean-cool-17.cube");
const progressPreviewPath = path.join(PREVIEW_ROOT, "segmented-progress-rail.svg");
const textMotionPreviewPath = path.join(PREVIEW_ROOT, "text-motion-gallery.svg");
const softCinemaPreviewPath = path.join(PREVIEW_ROOT, "soft-cinema-17.svg");
const cleanCoolPreviewPath = path.join(PREVIEW_ROOT, "clean-cool-17.svg");
const softConfirmPath = path.join(SOUND_EFFECT_ROOT, "soft-confirm.wav");
const markerPopPath = path.join(SOUND_EFFECT_ROOT, "marker-pop.wav");
fs.writeFileSync(softCinemaPath, lutDocument("Visual Multimedia Soft Cinema", softCinema));
fs.writeFileSync(cleanCoolPath, lutDocument("Visual Multimedia Clean Cool", cleanCool));
fs.writeFileSync(progressPreviewPath, svgPreview({
  title: "分段视频进度栏",
  subtitle: "章节、游标与进度都可编辑",
  accent: "#55d6be",
  secondary: "#5b8cff",
  motif: '<rect x="52" y="104" width="536" height="18" rx="9" fill="#ffffff" fill-opacity=".12"/><rect x="52" y="104" width="356" height="18" rx="9" fill="url(#accent)"/><circle cx="408" cy="113" r="18" fill="#f7f9ff"/><path d="M52 152h112m20 0h112m20 0h112m20 0h140" stroke="#ffffff" stroke-opacity=".38" stroke-width="4"/>',
}));
fs.writeFileSync(textMotionPreviewPath, svgPreview({
  title: "确定性文字动效库",
  subtitle: "逐帧定位的可编辑文字动画",
  accent: "#ff8a65",
  secondary: "#ffd166",
  motif: '<text x="52" y="142" fill="url(#accent)" font-family="Segoe UI, sans-serif" font-size="76" font-weight="800">MOTION</text><path d="M54 171h420" stroke="#ffffff" stroke-opacity=".22" stroke-width="5"/><circle cx="510" cy="171" r="13" fill="#ffd166"/>',
}));
fs.writeFileSync(softCinemaPreviewPath, svgPreview({
  title: "柔和电影感",
  subtitle: "暖高光、柔和对比、轻微抬黑",
  accent: "#ffb36b",
  secondary: "#d67861",
  motif: '<rect x="52" y="72" width="536" height="122" rx="15" fill="#9a5f47"/><circle cx="195" cy="133" r="54" fill="#e7b27e"/><path d="M52 194 190 114l116 80 92-58 190 58" fill="#243342" fill-opacity=".84"/>',
}));
fs.writeFileSync(cleanCoolPreviewPath, svgPreview({
  title: "清透冷调",
  subtitle: "科技与产品画面的克制冷色",
  accent: "#54d2e8",
  secondary: "#6c8cff",
  motif: '<rect x="52" y="72" width="536" height="122" rx="15" fill="#173d57"/><circle cx="474" cy="110" r="30" fill="#8fe7f5"/><path d="M52 194 182 96l108 98 76-64 86 64 70-82 66 82" fill="#2e6f83"/><path d="M52 194h536" stroke="#b8f3ff" stroke-opacity=".65" stroke-width="4"/>',
}));
fs.writeFileSync(softConfirmPath, wavBuffer(0.62, softConfirm));
fs.writeFileSync(markerPopPath, wavBuffer(0.34, markerPop));

const catalog = {
  protocol: "visual-multimedia-media-resource-catalog",
  version: 1,
  catalog_id: "visual-multimedia-core-resources",
  catalog_version: "1.1.0",
  name: "Visual Multimedia Core Editor Resources",
  description: "Audited editable motion graphics, original LUTs, and original sound effects for compatible editors.",
  items: [
    editableMediaItem({
      id: "segmented-progress-rail",
      name: "分段视频进度栏",
      description: "透明背景、可替换章节与游标、跟随全片时间的可编辑视频包装组件。",
      packageRoot: path.join(ROOT, "assets", "video-progress-bar"),
      tags: ["progress", "chapter", "overlay", "transparent"],
      capabilities: ["editable-fields", "deterministic-seek", "multi-aspect"],
      rank: 10,
      duration: 1800,
      license: "MPL-2.0",
      attribution: "Original editable-media template by visual-multimedia.",
      previewPath: progressPreviewPath,
    }),
    editableMediaItem({
      id: "deterministic-text-motion-gallery",
      name: "确定性文字动效库",
      description: "可逐帧定位、可编辑文案和动效参数的文字动画组件与效果目录。",
      packageRoot: path.join(ROOT, "assets", "text-motion-library"),
      tags: ["text", "motion", "kinetic-type", "deterministic"],
      capabilities: ["editable-fields", "deterministic-seek", "text-animation"],
      rank: 20,
      duration: 180,
      license: "MPL-2.0 AND MIT",
      attribution: "visual-multimedia deterministic implementation; effect families adapted from Sakura under MIT. See the package THIRD_PARTY_NOTICES.md.",
      previewPath: textMotionPreviewPath,
    }),
    lutItem({
      id: "soft-cinema-17",
      name: "柔和电影感",
      description: "轻微抬黑、柔和对比与暖高光，适合人物和叙事类画面。",
      filePath: softCinemaPath,
      previewPath: softCinemaPreviewPath,
      tags: ["cinematic", "warm", "soft-contrast", "sdr"],
      rank: 30,
    }),
    lutItem({
      id: "clean-cool-17",
      name: "清透冷调",
      description: "克制提升对比，在暗部加入轻微冷色，适合科技与产品画面。",
      filePath: cleanCoolPath,
      previewPath: cleanCoolPreviewPath,
      tags: ["clean", "cool", "technology", "sdr"],
      rank: 40,
    }),
    soundEffectItem({
      id: "soft-confirm",
      name: "柔和确认音",
      description: "双音阶的轻柔确认提示，适合完成、保存和状态确认。",
      filePath: softConfirmPath,
      tags: ["audio", "interface", "confirmation", "soft"],
      rank: 50,
    }),
    soundEffectItem({
      id: "marker-pop",
      name: "标记弹点",
      description: "短促清晰的弹点音，适合字幕重点、标记出现和信息切换。",
      filePath: markerPopPath,
      tags: ["audio", "marker", "pop", "interface"],
      rank: 60,
    }),
  ],
};

fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
process.stdout.write(`${CATALOG_PATH}\n`);
