#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(process.argv[2] || ".");
const outputRoot = path.resolve(process.argv[3] || path.join(projectRoot, "exports"));
const frameRate = 30;
const durationMs = 14000;
const outputWidth = 1440;
const outputHeight = 900;
const frameCount = Math.round(durationMs / 1000 * frameRate);

function loadPlaywright() {
  const candidates = [process.cwd(), projectRoot, "D:\\Tools\\NodeJS\\node_modules", "D:\\Tools\\codex-artifact-deps\\node_modules", "D:\\Tools\\visual-multimedia-node-runtime\\node_modules"];
  for (const candidate of candidates) {
    try { return require(require.resolve("playwright", { paths: [candidate] })); } catch {}
  }
  throw new Error("找不到 Playwright，无法逐帧捕获网页动画");
}

const mime = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".png", "image/png"], [".svg", "image/svg+xml"]]);
function serveFile(request, response) {
  const raw = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const relative = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
  const file = path.resolve(projectRoot, relative);
  if (!file.startsWith(projectRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404); response.end("Not found"); return;
  }
  response.writeHead(200, { "Content-Type": mime.get(path.extname(file).toLowerCase()) || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(response);
}

async function startServer() {
  for (let port = 43127; port < 43157; port += 1) {
    const server = http.createServer(serveFile);
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      return { server, port };
    } catch { server.close(); }
  }
  throw new Error("找不到可用的本地预览端口");
}

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function findExecutable(name) {
  const result = spawnSync("where.exe", [name], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim().split(/\r?\n/)[0];
  throw new Error(`找不到 ${name}`);
}

function spawnChecked(command, args, options = {}) {
  const child = spawn(command, args, { stdio: [options.stdin || "ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} 退出码 ${code}\n${stderr.trim()}`)));
  });
  return { child, done };
}

async function writeFrame(child, done, buffer) {
  if (child.exitCode !== null) throw new Error("FFmpeg 在网页帧写入完成前退出");
  if (child.stdin.write(buffer)) return;
  await Promise.race([once(child.stdin, "drain"), done.then(() => { throw new Error("FFmpeg 在等待输入时提前结束"); })]);
}

async function main() {
  fs.mkdirSync(outputRoot, { recursive: true });
  const videoPath = path.join(outputRoot, "mcp-human-collaboration-loop.mp4");
  const posterPath = path.join(outputRoot, "mcp-human-collaboration-loop-poster.png");
  const capturePath = path.join(outputRoot, "mcp-human-collaboration-loop-master.mkv");
  const reportPath = path.join(outputRoot, "video-export-report.json");
  const ffmpeg = findExecutable("ffmpeg");
  const ffprobe = findExecutable("ffprobe");
  const { server, port } = await startServer();
  const playwright = loadPlaywright();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: outputWidth, height: outputHeight }, deviceScaleFactor: 1 });
  const sampleHashes = [];

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html?capture=1&variant=landscape&scene=mcp-collaboration-loop`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.editableMedia && window.__hf);
    await page.evaluate(() => window.editableMedia.ready);
    await page.evaluate(() => window.editableMedia.pause());
    const canvas = page.locator("#mediaCanvas");
    const capture = spawnChecked(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(frameRate), "-vcodec", "png", "-i", "pipe:0",
      "-c:v", "ffv1", "-level", "3", "-g", "1", capturePath
    ], { stdin: "pipe" });
    capture.child.stdin.on("error", (error) => { if (error.code !== "EPIPE") process.stderr.write(`${error.message}\n`); });

    const sampleFrames = new Set([0, 39, 92, 128, 177, 249, 303, 354, frameCount - 1]);
    for (let index = 0; index < frameCount; index += 1) {
      const timeMs = index * 1000 / frameRate;
      await page.evaluate(async (value) => {
        window.editableMedia.setTime(value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, timeMs);
      const buffer = await canvas.screenshot({ type: "png" });
      if (sampleFrames.has(index)) sampleHashes.push({ frame: index, time_ms: Number(timeMs.toFixed(3)), sha256: crypto.createHash("sha256").update(buffer).digest("hex") });
      await writeFrame(capture.child, capture.done, buffer);
      if ((index + 1) % 30 === 0) process.stdout.write(`网页逐帧捕获：${index + 1}/${frameCount}\n`);
    }
    capture.child.stdin.end();
    await capture.done;
    process.stdout.write("无损母版完成，正在编码微信兼容视频。\n");

    const encode = spawnChecked(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", capturePath,
      "-c:v", "libx264", "-preset", "slow", "-crf", "15",
      "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1", "-tag:v", "avc1",
      "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
      "-x264-params", "keyint=30:min-keyint=30:scenecut=0:open-gop=0:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-movflags", "+faststart", "-an", videoPath
    ]);
    await encode.done;

    await page.evaluate(async () => {
      window.editableMedia.setTime(8300);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await canvas.screenshot({ path: posterPath, type: "png" });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const probe = spawnSync(ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_read_frames,color_space,color_transfer,color_primaries,color_range:format=duration,size", "-of", "json", videoPath], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(probe.stderr.trim());
  const probeData = JSON.parse(probe.stdout);
  const report = {
    source: path.join(projectRoot, "index.html"),
    output: videoPath,
    video: { width: outputWidth, height: outputHeight, fps: frameRate, frames: frameCount, duration_ms: durationMs, compatibility_target: "手机微信内置播放器", sha256: sha256(videoPath), bytes: fs.statSync(videoPath).size },
    probe: probeData,
    poster: { path: posterPath, time_ms: 8300, sha256: sha256(posterPath), bytes: fs.statSync(posterPath).size },
    master: { path: capturePath, codec: "ffv1", sha256: sha256(capturePath), bytes: fs.statSync(capturePath).size },
    sampled_source_frames: sampleHashes,
    sampled_unique_frame_count: new Set(sampleHashes.map((item) => item.sha256)).size,
    generated_at: new Date().toISOString()
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
