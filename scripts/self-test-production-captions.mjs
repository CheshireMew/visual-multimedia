#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProductionCaptions } from "./production-captions.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptRoot);
const caseRoot = path.join(skillRoot, "assets", "production-caption-case");
const transcript = path.join(skillRoot, "assets", "media-delivery-case", "transcript.json");
const sourceSrt = path.join(caseRoot, "source.srt");
const expectedFiles = ["captions.json", "captions.srt", "captions.vtt", "caption-qc.json"];

function normalizedBytes(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/gu, "\n");
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "visual-caption-test-"));
try {
  const result = buildProductionCaptions({transcript, inputSrt: sourceSrt, outputDir: temporary});
  assert.equal(result.ok, true);
  assert.equal(result.qc.status, "passed");
  assert.equal(result.captions.cues.length, 1);
  for (const relative of expectedFiles) {
    assert.equal(
      normalizedBytes(path.join(temporary, relative)),
      normalizedBytes(path.join(caseRoot, relative)),
      `${relative} 与真实生产案例不一致`,
    );
  }

  const invalidSrt = path.join(temporary, "invalid.srt");
  fs.writeFileSync(
    invalidSrt,
    "1\n00:00:00,000 --> 00:00:00,200\n但是\n\n"
      + "2\n00:00:00,200 --> 00:00:00,400\nMedia\n\n"
      + "3\n00:00:00,400 --> 00:00:00,600\nFlow\n",
    "utf8",
  );
  const invalidOutput = path.join(temporary, "invalid-output");
  const invalid = buildProductionCaptions({
    transcript,
    inputSrt: invalidSrt,
    outputDir: invalidOutput,
    minimumTimeCoverage: 0,
    protectedTokens: ["MediaFlow"],
  });
  assert.equal(invalid.ok, false);
  const codes = new Set(invalid.qc.issues.map((item) => item.code));
  assert.equal(codes.has("connector-split"), true);
  assert.equal(codes.has("protected-token-split"), true);
  assert.equal(codes.has("short-duration"), true);
  assert.equal(codes.has("reading-speed"), true);
  console.log("生产字幕真实转写—唯一时间线—SRT/VTT—短语质检链路通过");
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}
