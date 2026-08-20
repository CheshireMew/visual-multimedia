#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  createBilingualTimelineCaptions,
  serializeBilingualAss,
  serializeCaptionSrt,
} from "./bilingual-video-captions.mjs";

const pairs = [
  {id: "one", start_seconds: 0, end_seconds: 1.25, zh: "先看真实画面。", en: "Start with the real footage."},
  {id: "two", start_seconds: 1.25, end_seconds: 2.8, zh: "再补充必要解释。", en: "Then add only the explanation needed."},
];

const timeline = createBilingualTimelineCaptions(pairs, {width: 1920, height: 1080, maximumDuration: 2.8});
assert.equal(timeline.chinese.length, 2);
assert.equal(timeline.english.length, 2);
assert.equal(timeline.styles[0].font_size > timeline.styles[1].font_size, true);
assert.equal(timeline.styles[0].margin_vertical > timeline.styles[1].margin_vertical, true);
for (let index = 0; index < pairs.length; index += 1) {
  assert.equal(timeline.chinese[index].timeline_start_seconds, timeline.english[index].timeline_start_seconds);
  assert.equal(timeline.chinese[index].duration_seconds, timeline.english[index].duration_seconds);
}

const ass = serializeBilingualAss(pairs, {width: 1920, height: 1080, maximumDuration: 2.8});
assert.equal((ass.match(/^Style: /gmu) || []).length, 2);
assert.equal((ass.match(/^Dialogue: /gmu) || []).length, 4);
assert.match(ass, /Style: caption-zh[^\n]*,49,/u);
assert.match(ass, /Style: caption-en[^\n]*,31,/u);
assert.match(serializeCaptionSrt(pairs, "zh"), /先看真实画面/u);
assert.match(serializeCaptionSrt(pairs, "en"), /Start with the real footage/u);

const root = path.dirname(fileURLToPath(import.meta.url));
assert.equal(fs.existsSync(path.join(root, "bilingual-video-captions.mjs")), true);
console.log("双语字幕共享边界、层级样式、同 cue 时间和 SRT/ASS 派生通过");
