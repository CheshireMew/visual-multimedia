import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少 --${name}`);
  }
  return value.trim();
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function slash(value) {
  return String(value).replaceAll("\\", "/");
}

export function projectPath(projectRoot, relative, label = "项目路径") {
  if (typeof relative !== "string" || !relative) {
    throw new Error(`${label} 必须是非空相对路径`);
  }
  if (
    relative.includes("\\")
    || path.isAbsolute(relative)
    || /^[A-Za-z]:/.test(relative)
    || relative.split("/").includes("..")
  ) {
    throw new Error(`${label} 必须是项目内使用 / 的相对路径：${relative}`);
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, ...relative.split("/"));
  const check = path.relative(root, resolved);
  if (check.startsWith("..") || path.isAbsolute(check)) {
    throw new Error(`${label} 离开了项目目录：${relative}`);
  }
  return resolved;
}

export function relativeProjectPath(projectRoot, absolute) {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(absolute));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`文件不在项目目录：${absolute}`);
  }
  return slash(relative);
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function listFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`不能对包含符号链接的目录建立生产哈希：${target}`);
    }
    if (entry.isDirectory()) files.push(...listFiles(root, target));
    if (entry.isFile()) files.push(target);
  }
  return files;
}

export function hashPath(target) {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) throw new Error(`输入不存在：${absolute}`);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    return {sha256: sha256File(absolute), bytes: stat.size};
  }
  if (!stat.isDirectory()) throw new Error(`输入不是文件或目录：${absolute}`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const files = listFiles(absolute).sort((a, b) => slash(a).localeCompare(slash(b)));
  for (const file of files) {
    const relative = slash(path.relative(absolute, file));
    const payload = fs.readFileSync(file);
    hash.update(relative);
    hash.update("\0");
    hash.update(payload);
    hash.update("\0");
    bytes += payload.length;
  }
  return {sha256: hash.digest("hex"), bytes};
}

export function commandPath(name, override = null, envName = null) {
  const candidate = override || (envName ? process.env[envName] : null);
  if (candidate) {
    if (path.isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")) {
      const absolute = path.resolve(candidate);
      if (!fs.existsSync(absolute)) throw new Error(`${name} 不存在：${absolute}`);
      return absolute;
    }
    const explicitLookup = spawnSync(
      process.platform === "win32" ? "where.exe" : "which",
      [candidate],
      {encoding: "utf8", windowsHide: true},
    );
    if (explicitLookup.status !== 0) {
      throw new Error(`${name} 命令不存在：${candidate}`);
    }
    return explicitLookup.stdout.split(/\r?\n/).find(Boolean).trim();
  }
  const lookup = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [name],
    {encoding: "utf8", windowsHide: true},
  );
  if (lookup.status !== 0) {
    throw new Error(`找不到 ${name}；可通过参数或 ${envName || "对应环境变量"} 指定，不会自动安装。`);
  }
  return lookup.stdout.split(/\r?\n/).find(Boolean).trim();
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} 执行失败 (${result.status})\n`
      + `${result.stdout || ""}\n${result.stderr || ""}`.trim(),
    );
  }
  return result;
}

function rate(value) {
  const [numerator, denominator = "1"] = String(value || "").split("/");
  const number = Number(numerator) / Number(denominator);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function probeMedia(ffprobe, filePath, countFrames = false) {
  const args = [
    "-v", "error",
    ...(countFrames ? ["-count_frames"] : []),
    "-show_format",
    "-show_streams",
    "-of", "json",
    filePath,
  ];
  const result = run(ffprobe, args);
  const payload = JSON.parse(result.stdout);
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video") || null;
  const audio = streams.find((stream) => stream.codec_type === "audio") || null;
  const subtitle = streams.find((stream) => stream.codec_type === "subtitle") || null;
  const duration = Number(payload?.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: video ? Number(video.width) : null,
    height: video ? Number(video.height) : null,
    fps: video ? rate(video.avg_frame_rate) ?? rate(video.r_frame_rate) : null,
    frames: video && video.nb_read_frames != null
      ? Number(video.nb_read_frames)
      : (video && video.nb_frames != null ? Number(video.nb_frames) : null),
    audio_sample_rate: audio ? Number(audio.sample_rate) : null,
    audio_channels: audio ? Number(audio.channels) : null,
    has_video: Boolean(video),
    has_audio: Boolean(audio),
    has_subtitle: Boolean(subtitle),
    raw: payload,
  };
}

export function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label}不存在：${filePath}`);
  }
}

export function ensureDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label}不存在：${directory}`);
  }
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:`
    + `${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function formatAssTime(seconds) {
  const totalCs = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(totalCs / 360000);
  const minutes = Math.floor((totalCs % 360000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:`
    + `${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function escapeAssText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r?\n/g, "\\N");
}

export function ffmpegFilterPath(filePath) {
  return slash(path.resolve(filePath))
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

export function parseVtt(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const cues = [];
  function seconds(value) {
    const match = value.trim().match(/(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)/);
    if (!match) throw new Error(`无法解析 VTT 时间：${value}`);
    return Number(match[1] || 0) * 3600
      + Number(match[2]) * 60
      + Number(match[3].replace(",", "."));
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("-->")) continue;
    const [startRaw, endRaw] = lines[index].split("-->").map((item) => item.trim().split(/\s+/)[0]);
    const payload = [];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      payload.push(lines[index].trim());
      index += 1;
    }
    if (payload.length) {
      cues.push({start: seconds(startRaw), end: seconds(endRaw), text: payload.join(" ")});
    }
  }
  if (!cues.length) throw new Error(`VTT 没有可用字幕：${filePath}`);
  return cues;
}

export function nowIso() {
  return new Date().toISOString();
}

export function toolVersion(command, args = ["-version"]) {
  try {
    const result = run(command, args);
    return (result.stdout || result.stderr || "").split(/\r?\n/).find(Boolean) || path.basename(command);
  } catch {
    return path.basename(command);
  }
}
