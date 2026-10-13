#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  ensureTaskWorkspace,
  finalizeTaskWorkspace,
} from "./media-task-workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SCRIPT_DIR, "background-music-sources.mjs");
const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
const CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wavBuffer(durationSeconds = 0.4, sampleRate = 48000) {
  const channels = 2;
  const bitsPerSample = 16;
  const samples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataBytes = samples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    const amplitude = Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 3200);
    const offset = 44 + index * channels * 2;
    buffer.writeInt16LE(amplitude, offset);
    buffer.writeInt16LE(amplitude, offset + 2);
  }
  return buffer;
}

function json(response, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  response.end(body);
}

function openverseItem(baseUrl, license = "cc0") {
  const valid = license === "cc0";
  return {
    id: valid ? "ov-cc0" : "ov-by",
    title: valid ? "Quiet Circuit Instrumental" : "Attribution Track",
    creator: valid ? "Fixture Artist" : "BY Artist",
    description: "restrained electronic background music",
    duration: 12.5,
    tags: [{name: "instrumental"}, {name: "technology"}],
    foreign_landing_url: `${baseUrl}/landing/${valid ? "ov-cc0" : "ov-by"}`,
    url: `${baseUrl}/files/test.wav`,
    filetype: "wav",
    license,
    license_url: valid ? CC0_URL : CC_BY_URL,
  };
}

function wikimediaPage(baseUrl, valid = true) {
  return {
    pageid: valid ? 42 : 43,
    title: valid ? "File:Commons CC0 Instrumental.wav" : "File:Commons BY Music.wav",
    imageinfo: [{
      url: `${baseUrl}/files/test.wav`,
      descriptionurl: `${baseUrl}/landing/commons-${valid ? "cc0" : "by"}`,
      mime: "audio/wav",
      extmetadata: {
        LicenseShortName: {value: valid ? "CC0" : "CC BY 4.0"},
        LicenseUrl: {value: valid ? CC0_URL : CC_BY_URL},
        Artist: {value: "Fixture Commons Artist"},
        ImageDescription: {value: "Instrumental technology loop"},
        Categories: {value: "CC-Zero|Electronic music"},
      },
    }],
  };
}

function wikimediaWarningPage(baseUrl) {
  const page = wikimediaPage(baseUrl, true);
  page.pageid = 44;
  page.title = "File:Unreviewed CC0 claim.wav";
  page.imageinfo[0].descriptionurl = `${baseUrl}/landing/commons-unreviewed`;
  page.imageinfo[0].extmetadata.Categories.value = "CC-Zero|License review needed (audio)";
  return page;
}

function ccMixterItem(baseUrl, valid = true) {
  return {
    upload_id: valid ? 77 : 78,
    upload_name: valid ? "CC0 Interface Bed" : "BY Interface Bed",
    user_real_name: "Fixture Mixter Artist",
    upload_description: "instrumental background loop",
    upload_tags: "instrumental,electronic,technology",
    file_page_url: `${baseUrl}/landing/ccmixter-${valid ? "cc0" : "by"}`,
    license_url: valid ? CC0_URL : CC_BY_URL,
    upload_license: valid ? "Public Domain" : "Attribution",
    files: [{
      file_name: "test.wav",
      file_type: "audio/wav",
      download_url: `${baseUrl}/files/test.wav`,
      file_duration: 12.5,
    }],
  };
}

async function startServer() {
  const audio = wavBuffer();
  let baseUrl = "";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, baseUrl);
    if (url.pathname === "/files/test.wav") {
      response.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": audio.length,
      });
      response.end(audio);
      return;
    }
    if (url.pathname === "/openverse/ov-cc0/") {
      json(response, openverseItem(baseUrl, "cc0"));
      return;
    }
    if (url.pathname === "/openverse/") {
      json(response, {results: [
        openverseItem(baseUrl, "cc0"),
        openverseItem(baseUrl, "by"),
      ]});
      return;
    }
    if (url.pathname === "/wikimedia") {
      const pageId = url.searchParams.get("pageids");
      json(response, {
        query: {
          pages: pageId === "42"
            ? [wikimediaPage(baseUrl, true)]
            : [
              wikimediaPage(baseUrl, true),
              wikimediaPage(baseUrl, false),
              wikimediaWarningPage(baseUrl),
            ],
        },
      });
      return;
    }
    if (url.pathname === "/ccmixter") {
      const id = url.searchParams.get("ids");
      json(response, id === "77"
        ? [ccMixterItem(baseUrl, true)]
        : [ccMixterItem(baseUrl, true), ccMixterItem(baseUrl, false)]);
      return;
    }
    if (url.pathname.startsWith("/landing/")) {
      response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
      response.end("<p>fixture landing page</p>");
      return;
    }
    response.writeHead(404, {"content-type": "text/plain"});
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {server, baseUrl};
}

function runNode(args, expectedStatus = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.dirname(SCRIPT_DIR),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => {
      if (status !== expectedStatus) {
        reject(new Error(
          `命令退出码应为 ${expectedStatus}，实际为 ${status}\n${stderr || stdout}`,
        ));
        return;
      }
      resolve({stdout, stderr, status});
    });
  });
}

async function main() {
  const taskId = `bgm-test-${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const workspace = ensureTaskWorkspace(taskId, 5 * 1024 * 1024).path;
  const reports = path.join(workspace, "reports");
  fs.mkdirSync(reports, {recursive: true});
  const reportPath = path.join(reports, "background-music-candidates.json");
  const {server, baseUrl} = await startServer();
  try {
    await runNode([
      ENTRY,
      "search",
      "--query", "restrained technology instrumental",
      "--providers", "all",
      "--limit", "10",
      "--duration-min", "5",
      "--duration-max", "90",
      "--project", workspace,
      "--output", path.relative(workspace, reportPath),
      "--openverse-api", `${baseUrl}/openverse/`,
      "--wikimedia-api", `${baseUrl}/wikimedia`,
      "--ccmixter-api", `${baseUrl}/ccmixter`,
    ]);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert(report.candidates.length === 3, "三个来源应各保留一个精确 CC0 候选");
    assert(
      report.candidates.every(
        (candidate) => candidate.license === "CC0-1.0"
          && candidate.license_url === CC0_URL
          && candidate.attribution_required === false,
      ),
      "候选报告不能保留要求署名或非 CC0 音乐",
    );
    assert(
      !report.candidates.some((candidate) => candidate.title.includes("Attribution") || candidate.title.includes("BY ")),
      "CC BY 结果没有被拒绝",
    );

    await runNode([
      ENTRY,
      "validate",
      "--project", workspace,
      "--report", path.relative(workspace, reportPath),
    ]);

    const invalidPath = path.join(reports, "invalid-attribution-candidate.json");
    const invalid = structuredClone(report);
    invalid.candidates[0].license = "CC-BY-4.0";
    invalid.candidates[0].license_url = CC_BY_URL;
    invalid.candidates[0].attribution_required = true;
    fs.writeFileSync(invalidPath, `${JSON.stringify(invalid, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await runNode([
      ENTRY,
      "validate",
      "--project", workspace,
      "--report", path.relative(workspace, invalidPath),
    ], 1);

    const selected = report.candidates.find((candidate) => candidate.provider === "openverse");
    const acquisition = await runNode([
      ENTRY,
      "acquire",
      "--project", workspace,
      "--report", path.relative(workspace, reportPath),
      "--candidate-id", selected.id,
      "--source-id", "bgm-cc0-fixture",
      "--usage", "BGM 自动检索、下载与素材账本测试",
    ]);
    const result = JSON.parse(acquisition.stdout);
    assert(result.acquired === true, "BGM acquire 没有返回成功状态");
    assert(result.probe.audio_streams.length === 1, "下载音频没有真实音轨");
    assert(result.probe.duration_seconds > 0, "下载音频没有真实时长");
    assert(result.downloaded.file.startsWith(workspace), "下载文件越过了任务工作区");

    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "media-sources.json"), "utf8"));
    const source = manifest.sources.find((item) => item.id === "bgm-cc0-fixture");
    assert(source, "下载音乐没有进入 media-sources.json v3");
    assert(source.acquisition.method === "external-download", "取得方式不是 external-download");
    assert(source.rights.status === "confirmed", "CC0 权利没有收口");
    assert(source.rights.license === "CC0-1.0", "素材账本没有保存精确 CC0 许可");
    assert(source.rights.attribution === "", "免署名音乐不应写入公开署名要求");
    assert(source.rights.terms_url === CC0_URL, "素材账本没有保存 CC0 条款地址");

    finalizeTaskWorkspace(taskId, "completed");
    console.log(JSON.stringify({
      passed: true,
      workspace,
      providers: report.provider_runs.map((item) => item.provider),
      candidates: report.candidates.length,
      imported_source_id: source.id,
    }, null, 2));
  } catch (error) {
    finalizeTaskWorkspace(taskId, "failed");
    throw error;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

try {
  await main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
