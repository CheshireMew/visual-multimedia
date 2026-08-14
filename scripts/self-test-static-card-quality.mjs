import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const validator = path.join(scriptDir, "validate-editable-media.mjs");
const source = path.join(
  skillRoot,
  "assets",
  "web-layout-template-packages",
  "portrait-four-sections-neutral"
);
const testRoot = "D:\\Tools\\visual-multimedia-tests\\static-card-quality";

const sourceManifest = JSON.parse(
  fs.readFileSync(path.join(source, "editable-media.json"), "utf8")
);
if (Number(sourceManifest.quality?.thumbnail?.minimum_text_px) < 14) {
  throw new Error(
    "默认静态卡模板把主要阅读文字的实际显示下限设在 14px 以下"
  );
}

function prepareFixture(name, mutate) {
  const fixtureRoot = path.join(testRoot, name);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.cpSync(source, fixtureRoot, { recursive: true, force: true });
  const manifestPath = path.join(fixtureRoot, "editable-media.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  mutate(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return fixtureRoot;
}

function expectFailure(fixtureRoot, expectedRule, expectedText) {
  const result = spawnSync(process.execPath, [validator, fixtureRoot], {
    cwd: skillRoot,
    encoding: "utf8",
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0
    || !output.includes(`FAIL ${expectedRule}`)
    || !output.includes(expectedText)) {
    throw new Error(
      `静态卡质量回归没有按预期失败：${fixtureRoot}\n${output}`
    );
  }
}

const missingThumbnail = prepareFixture("missing-thumbnail", (manifest) => {
  delete manifest.quality.thumbnail;
});
expectFailure(missingThumbnail, "S7", "quality.thumbnail");

const unreadableThumbnail = prepareFixture("unreadable-thumbnail", (manifest) => {
  manifest.quality.thumbnail.minimum_text_px = 20;
});
expectFailure(unreadableThumbnail, "Q7", "缩到 360px 宽时");

console.log(
  "静态卡质量回归通过：默认模板主要文字不低于 14px；缺少完整缩略图合同会触发 S7，实际显示字过小会触发 Q7 硬失败。"
);
