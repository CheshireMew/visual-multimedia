#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {spawn, spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {once} from "node:events";
import {fileURLToPath} from "node:url";

import {
  assertEditableMediaPackageClosed,
  readEditableMediaPackage,
} from "./editable-media-contract.mjs";
import {listenOnBrowserSafePort} from "./browser-safe-server.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const require = createRequire(import.meta.url);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = {_: []};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      result[name] = true;
      continue;
    }
    result[name] = next;
    index += 1;
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (value == null || value === true || !String(value).trim()) fail(`缺少 --${name}`);
  return String(value).trim();
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function commandPath(name, explicit = null) {
  if (explicit) {
    const candidate = path.resolve(String(explicit));
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      fail(`${name} 不存在：${candidate}`);
    }
    return candidate;
  }
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [name], {encoding: "utf8", windowsHide: true});
  const candidate = (result.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (result.status !== 0 || !candidate) fail(`找不到 ${name}；请使用 --${name} 提供已有可执行文件`);
  return candidate;
}

function loadPlaywright() {
  const candidates = [
    SKILL_ROOT,
    process.cwd(),
    process.env.NODE_PATH,
    process.env.PLAYWRIGHT_NODE_MODULES,
    process.platform === "win32" ? "D:\\Tools\\NodeJS\\node_modules" : null,
    process.platform === "win32" ? "D:\\Tools\\npm-global\\node_modules" : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(require.resolve("playwright", {paths: [candidate]}));
    } catch {
      // Continue through explicit, workspace and common local dependency roots.
    }
  }
  fail("找不到 Playwright；请在已有 Node 依赖目录安装，或设置 PLAYWRIGHT_NODE_MODULES");
}

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".woff2", "font/woff2"],
]);

async function startServer(root) {
  const resolvedRoot = path.resolve(root);
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const target = path.resolve(resolvedRoot, ...relative.split("/"));
      const relation = path.relative(resolvedRoot, target);
      if (relation.startsWith("..") || path.isAbsolute(relation)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": MIME.get(path.extname(target).toLowerCase()) || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(target).pipe(response);
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  const port = await listenOnBrowserSafePort(server);
  return {server, origin: `http://127.0.0.1:${port}`};
}

function outputArguments(format, output, fps, width, height) {
  const common = [
    "-hide_banner", "-loglevel", "error",
    "-f", "image2pipe",
    "-framerate", String(fps),
    "-vcodec", "png",
    "-i", "pipe:0",
  ];
  if (format === "mp4") {
    return [
      ...common,
      "-an",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-s", `${width}x${height}`,
      "-y", output,
    ];
  }
  if (format === "gif") {
    return [
      ...common,
      "-filter_complex",
      `[0:v]fps=${fps},scale=${width}:${height}:flags=lanczos,split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a`,
      "-loop", "0",
      "-y", output,
    ];
  }
  fail(`不支持的输出格式：${format}`);
}

async function waitForChild(child, label) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  if (code !== 0) fail(`${label}失败（退出码 ${code}）\n${stderr.trim()}`);
}

async function render(args) {
  const source = path.resolve(required(args, "package"));
  const output = path.resolve(required(args, "output"));
  const format = String(args.format || path.extname(output).slice(1)).toLowerCase();
  if (!new Set(["mp4", "gif"]).has(format)) fail("输出格式必须是 mp4 或 gif");
  if (fs.existsSync(output) && !args.overwrite) {
    fail(`输出已经存在；明确传入 --overwrite 才会覆盖：${output}`);
  }
  const packageDocument = readEditableMediaPackage(source);
  const {packageRoot, manifest, manifestPath} = packageDocument;
  assertEditableMediaPackageClosed(packageRoot, manifest);
  const variantId = String(args.variant || manifest.default_variant_id);
  const variant = (manifest.variants || []).find((item) => item.id === variantId);
  if (!variant) fail(`找不到网页输出变体：${variantId}`);
  const duration = (manifest.scenes || []).reduce(
    (sum, scene) => sum + Number(scene.duration_ms || 0),
    0,
  ) / 1000;
  if (!(duration > 0)) fail("网页包总时长必须大于 0");
  const fps = Number(args.fps || manifest.playback?.fps || 30);
  if (!(fps > 0) || fps > 120) fail("fps 必须大于 0 且不超过 120");
  const width = Number(variant.canvas?.width);
  const height = Number(variant.canvas?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) fail("输出变体缺少整数画布尺寸");
  const frameCount = Math.max(1, Math.ceil(duration * fps));
  const ffmpeg = commandPath("ffmpeg", args.ffmpeg);
  const playwright = loadPlaywright();
  const executablePath = args.browser
    ? path.resolve(String(args.browser))
    : (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined);
  if (executablePath && (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile())) {
    fail(`浏览器不存在：${executablePath}`);
  }
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const {server, origin} = await startServer(packageRoot);
  let browser;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      ...(executablePath ? {executablePath} : {}),
    });
    const page = await browser.newPage({
      viewport: {width, height},
      deviceScaleFactor: 1,
    });
    const entryUrl = new URL(manifest.entry, `${origin}/`);
    entryUrl.searchParams.set("variant", variantId);
    await page.goto(entryUrl.href, {waitUntil: "networkidle"});
    await page.waitForFunction(() => (
      window.__hf
      && typeof window.__hf.seek === "function"
      && Number(window.__hf.duration) > 0
    ));
    await page.evaluate((selected) => {
      document.body.classList.add("capture");
      if (window.editableMedia?.setVariant) window.editableMedia.setVariant(selected);
    }, variantId);

    const child = spawn(
      ffmpeg,
      outputArguments(format, output, fps, width, height),
      {cwd: packageRoot, stdio: ["pipe", "ignore", "pipe"], windowsHide: true},
    );
    const completion = waitForChild(child, "编码本地网页动画");
    for (let frame = 0; frame < frameCount; frame += 1) {
      const seconds = Math.min(duration, frame / fps);
      await page.evaluate(async (time) => {
        await Promise.resolve(window.__hf.seek(time));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, seconds);
      const buffer = await page.screenshot({
        type: "png",
        omitBackground: variant.canvas.background_mode === "transparent",
      });
      if (!child.stdin.write(buffer)) await once(child.stdin, "drain");
    }
    child.stdin.end();
    await completion;
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    fail(`本地网页渲染没有生成输出：${output}`);
  }
  const decode = spawnSync(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (decode.status !== 0) fail(`本地网页渲染输出无法解码：${decode.stderr}`);
  const reportPath = args.report ? path.resolve(String(args.report)) : `${output}.render.json`;
  const report = {
    protocol: "visual-multimedia-local-web-render",
    version: 1,
    source_package: packageRoot,
    manifest: manifestPath,
    manifest_sha256: sha256File(manifestPath),
    variant: variantId,
    width,
    height,
    fps,
    duration_seconds: duration,
    frame_count: frameCount,
    output,
    output_sha256: sha256File(output),
    format,
    renderer: "playwright-ffmpeg",
    rendered_at: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {...report, report: reportPath};
}

function printHelp() {
  process.stdout.write(`用法：
node scripts/render-web-media-local.mjs render --package <网页包目录或清单>
  --output <文件.mp4|文件.gif> [--variant <id>] [--fps <数字>]
  [--ffmpeg <路径>] [--browser <Chromium路径>] [--report <路径>] [--overwrite]

直接读取 editable-media v6 网页真源，以 window.__hf.seek(seconds) 确定性逐帧渲染。
`);
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === "help" || args.help || args.h) {
    printHelp();
    return command ? 0 : 1;
  }
  if (command !== "render") fail(`未知命令：${command}`);
  const result = await render(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (path.resolve(process.argv[1] || "") === path.resolve(SCRIPT_PATH)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`错误：${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
