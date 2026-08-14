import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const contractPath = path.join(root, "assets", "skill-suite-routing-regressions.json");
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

expect(contract.protocol === "visual-multimedia-skill-suite-routing-regressions", "路由回归协议错误");
expect(contract.version === 1, "路由回归版本错误");
expect(Array.isArray(contract.cases) && contract.cases.length >= 8, "路由回归案例不足");

const productionSkills = [
  "visual-cards",
  "web-motion",
  "video-production",
  "audio-production",
  "avatar-video",
];
const skillNames = ["visual-multimedia", ...productionSkills];
const texts = new Map();

for (const name of skillNames) {
  const file = path.join(root, "skills", name, "SKILL.md");
  expect(fs.existsSync(file), `缺少 Skill：${name}`);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  texts.set(name, text);
  expect(!text.includes("[待填写"), `${name} 仍有待填写占位`);
  expect(!/write-this/iu.test(text), `${name} 错误包含无关写作路线`);
  for (const match of text.matchAll(/`(\.\.\/\.\.\/(?:references|assets|scripts)\/[^`]+)`/gu)) {
    const resolved = path.resolve(path.dirname(file), match[1]);
    expect(fs.existsSync(resolved), `${name} 引用不存在：${match[1]}`);
  }
}

const rootText = texts.get("visual-multimedia") || "";
for (const name of productionSkills) {
  expect(rootText.includes(`$${name}`), `编排入口没有路由 ${name}`);
}
expect(rootText.includes("$clean-copy"), "编排入口没有 clean-copy 内容门");
expect(rootText.includes("不要为了“完整”同时读取全部子 Skill"), "编排入口没有最少加载规则");

const cardsText = texts.get("visual-cards") || "";
expect(cardsText.includes("普通单卡默认交付一份轻量、自包含、固定画布的 HTML"), "静态卡没有轻量默认交付");
expect(cardsText.includes("不要创建 `editable-media.json`"), "静态卡没有阻止默认重型工程");
expect(cardsText.includes("画布宽高由筛选后的内容"), "静态卡没有内容决定尺寸规则");
expect(cardsText.includes("主要正文以约 16px 为舒适目标"), "静态卡没有真实展示字号规则");

const seenIds = new Set();
for (const item of contract.cases || []) {
  expect(typeof item.id === "string" && item.id.length > 0, "案例缺少 id");
  expect(!seenIds.has(item.id), `案例 id 重复：${item.id}`);
  seenIds.add(item.id);
  const selected = item.selected_skills || [];
  const forbidden = item.forbidden_skills || [];
  expect(selected.length > 0, `${item.id} 没有选择 Skill`);
  expect(new Set(selected).size === selected.length, `${item.id} 重复选择 Skill`);
  for (const name of selected) {
    expect(contract.available_skills.includes(name), `${item.id} 选择未知 Skill：${name}`);
    expect(!forbidden.includes(name), `${item.id} 同时选择并禁止 ${name}`);
  }
  if (item.copy_status.startsWith("confirmed")) {
    expect(!selected.includes("clean-copy"), `${item.id} 对确认文案重复运行 clean-copy`);
  }
  if (item.copy_status === "draft-visible-copy") {
    expect(selected[0] === "clean-copy", `${item.id} 没有先运行 clean-copy`);
    expect((item.required_stops || []).includes("clean-copy-approval"), `${item.id} 缺少 clean-copy 确认停点`);
  }
  if (item.production_mode === "single-self-contained-html") {
    expect(selected.includes("visual-cards"), `${item.id} 轻量卡没有走 visual-cards`);
    expect((item.forbidden_outputs || []).includes("editable-media.json"), `${item.id} 没有阻止 v6 默认输出`);
  }
  if (selected.length > 1 && !selected.includes("clean-copy")) {
    expect(Array.isArray(item.handoff) && item.handoff.length > 0, `${item.id} 缺少真实产物交接`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  status: "passed",
  protocol: contract.protocol,
  skills: skillNames,
  cases: contract.cases.map((item) => item.id),
}, null, 2));
