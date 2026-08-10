import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const validator = path.join(scriptDir, "validate-editable-media.mjs");

function runValidator(relativeProject) {
  const result = spawnSync(
    process.execPath,
    [validator, path.join(skillRoot, relativeProject)],
    {
      cwd: skillRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `editable-media 校验失败：${relativeProject}\n${result.stdout || ""}\n${result.stderr || ""}`
    );
  }
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

const governedCase = runValidator("assets/web-card-cases/text-card-glossary");
if (
  !governedCase.includes("WARN Q12")
  || !governedCase.includes("有 1 处颜色/字体声明绕过 theme_variables")
  || !governedCase.includes("$canvas 的 box-shadow")
) {
  throw new Error("真实风格档案案例没有只报告当前唯一的未登记画布阴影");
}

const starter = runValidator("assets/web-media-starter");
if (starter.includes("WARN Q12")) {
  throw new Error("尚未锁定 style-profile.json 的 starter 不应触发视觉变量漂移提醒");
}

console.log("PASS 真实网页包的视觉变量漂移提醒与未锁定项目边界");
