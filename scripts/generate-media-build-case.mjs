import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {
  createMediaBuildPlan,
  fileDependency,
} from "./media_build_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const CASE_ROOT = "assets/media-build-cases/segmented-video";
const CONTRACT_FILE = `${CASE_ROOT}/source-contract.json`;
const PLAN_FILE = `${CASE_ROOT}/media-build-plan.json`;

function readJson(relativeFile) {
  return JSON.parse(fs.readFileSync(
    path.join(SKILL_ROOT, ...relativeFile.split("/")),
    "utf8",
  ));
}

export function createSegmentedVideoBuildCase() {
  const contract = readJson(CONTRACT_FILE);
  let timelineStart = 0;
  const units = contract.scenes.map((scene, index) => {
    const sourceFile = `${CASE_ROOT}/${scene.source}`;
    const avatarFile = `${CASE_ROOT}/${scene.avatar_overlay}`;
    const source = readJson(sourceFile);
    const avatar = readJson(avatarFile);
    if (source.id !== scene.id || source.duration_frames < 1) {
      throw new Error(`构建案例素材声明无效：${scene.source}`);
    }
    if (
      avatar.protocol !== "visual-multimedia-synthetic-avatar-overlay"
      || avatar.duration_frames !== source.duration_frames
    ) {
      throw new Error(`角色覆盖轨声明无效：${scene.avatar_overlay}`);
    }
    const unit = {
      id: scene.id,
      order: index + 1,
      kind: "pre-rendered-media",
      source_unit_id: source.id,
      timeline_start_frame: timelineStart,
      duration_frames: source.duration_frames,
      dependencies: [
        fileDependency(SKILL_ROOT, "source", sourceFile),
        fileDependency(SKILL_ROOT, "avatar-track", avatarFile),
      ],
    };
    timelineStart += source.duration_frames;
    return unit;
  });
  return createMediaBuildPlan({
    projectRoot: SKILL_ROOT,
    projectId: contract.project_id,
    mediaKind: "video",
    profile: "generic-segmented-video",
    stageTarget: "full-preview",
    sourceContract: CONTRACT_FILE,
    producerEntry: "scripts/generate-media-build-case.mjs",
    producerModules: [
      "scripts/media_build_contract.mjs",
      "scripts/interview_explainer_common.mjs",
    ],
    createdAt: contract.created_at,
    output: {
      file: `${CASE_ROOT}/output/segmented-video.mp4`,
      ...contract.output,
      quality_profile: "proxy",
    },
    units,
    assembly: {
      strategy: "ordered-concat",
      audio_strategy: "continuous-master",
      caption_strategy: "none",
    },
  });
}

function main() {
  const plan = createSegmentedVideoBuildCase();
  const planPath = path.join(SKILL_ROOT, ...PLAN_FILE.split("/"));
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(planPath) || fs.readFileSync(planPath, "utf8") !== serialized) {
      throw new Error(`通用媒体构建案例没有由当前生产者生成：${planPath}`);
    }
  } else {
    fs.mkdirSync(path.dirname(planPath), {recursive: true});
    fs.writeFileSync(planPath, serialized, "utf8");
  }
  process.stdout.write(`${JSON.stringify({
    protocol: "visual-multimedia-media-build-case-result",
    version: 1,
    plan: PLAN_FILE,
    units: plan.units.map((item) => item.id),
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
