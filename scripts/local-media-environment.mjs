import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_CONFIG_PATH = path.join(
  SKILL_ROOT,
  ".env.visual-multimedia.local.json",
);

function fail(message) {
  throw new Error(message);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function absolutePath(value, label) {
  const candidate = requiredString(value, label);
  if (!path.isAbsolute(candidate)) fail(`${label} 必须是绝对路径：${candidate}`);
  return path.normalize(candidate);
}

function existingFile(value, label) {
  const candidate = absolutePath(value, label);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    fail(`${label} 不存在或不是文件：${candidate}`);
  }
  return candidate;
}

function existingDirectory(value, label) {
  const candidate = absolutePath(value, label);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    fail(`${label} 不存在或不是目录：${candidate}`);
  }
  return candidate;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} 不是有效 JSON：${filePath}\n${error.message}`);
  }
}

function childPath(root, relative, label) {
  const value = requiredString(relative, label);
  if (path.isAbsolute(value)) fail(`${label} 必须是相对路径：${value}`);
  const target = path.resolve(root, value);
  const relation = path.relative(path.resolve(root), target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    fail(`${label} 离开声音目录：${value}`);
  }
  return target;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

export function loadLocalMediaEnvironment(configOverride = null) {
  const configPath = configOverride
    ? path.resolve(configOverride)
    : DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    fail(
      `缺少 visual-multimedia 本机配置：${configPath}。`
      + "不依赖本机工具的任务可以继续；MediaFlow、外部转写和全局声音任务在这里停止。",
    );
  }
  const document = readJson(configPath, "本机配置");
  if (
    document.protocol !== "visual-multimedia-local-environment"
    || document.version !== 1
  ) {
    fail("本机配置必须使用 visual-multimedia-local-environment v1");
  }
  if (!document.mediaflow || typeof document.mediaflow !== "object") {
    fail("本机配置缺少 mediaflow");
  }
  const python = existingFile(document.mediaflow.python, "mediaflow.python");
  const sourceRoot = existingDirectory(
    document.mediaflow.source_root,
    "mediaflow.source_root",
  );
  const settingsPath = existingFile(
    document.mediaflow.settings_path,
    "mediaflow.settings_path",
  );
  const cliModule = path.join(sourceRoot, "mediaflow", "cli.py");
  if (!fs.existsSync(cliModule) || !fs.statSync(cliModule).isFile()) {
    fail(`mediaflow.source_root 中没有正式 CLI：${cliModule}`);
  }
  const roots = document.resources?.voice_reference_roots ?? [];
  if (!Array.isArray(roots)) fail("resources.voice_reference_roots 必须是数组");
  const voiceReferenceRoots = roots.map((root, index) => existingDirectory(
    root,
    `resources.voice_reference_roots[${index}]`,
  ));
  if (new Set(voiceReferenceRoots.map((item) => item.toLowerCase())).size !== voiceReferenceRoots.length) {
    fail("resources.voice_reference_roots 不能重复");
  }
  return {
    configPath,
    protocol: document.protocol,
    version: document.version,
    mediaflow: {python, sourceRoot, settingsPath},
    voiceReferenceRoots,
  };
}

function mediaFlowResult(environment, args, input = undefined) {
  const result = run(
    environment.mediaflow.python,
    ["-m", "mediaflow.cli", ...args],
    {
      cwd: environment.mediaflow.sourceRoot,
      env: {
        ...process.env,
        MEDIAFLOW_SETTINGS_PATH: environment.mediaflow.settingsPath,
      },
      input,
    },
  );
  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    fail(
      `MediaFlow Pro CLI 没有返回 JSON（退出码 ${result.status}）\n`
      + (result.stderr || "").trim(),
    );
  }
  let response;
  try {
    response = JSON.parse(stdout);
  } catch (error) {
    fail(`MediaFlow Pro CLI 返回了无效 JSON：${error.message}\n${stdout}`);
  }
  if (result.status !== 0 && response.ok !== false) {
    fail(
      `MediaFlow Pro CLI 执行失败（退出码 ${result.status}）\n`
      + (result.stderr || "").trim(),
    );
  }
  return response;
}

export function mediaFlowProDescribe(environment) {
  const response = mediaFlowResult(environment, ["describe"]);
  if (!response.ok) {
    fail(`MediaFlow Pro describe 失败：${JSON.stringify(response.error)}`);
  }
  if (response.protocol !== "mediaflow-cli" || response.version !== 2) {
    fail("MediaFlow Pro 没有返回当前 v2 响应合同");
  }
  return response.result;
}

export function mediaFlowProExecute(
  environment,
  project,
  operation,
  argumentsValue,
  requestId = null,
) {
  const request = {
    protocol: "mediaflow-cli",
    version: 2,
    operation,
    project,
    arguments: argumentsValue,
  };
  if (requestId) request.request_id = requestId;
  const response = mediaFlowResult(
    environment,
    ["execute", "--request", "-"],
    JSON.stringify(request),
  );
  if (response.protocol !== "mediaflow-cli" || response.version !== 2) {
    fail(`MediaFlow Pro ${operation} 没有返回当前 v2 响应合同`);
  }
  if (!response.ok) {
    fail(`MediaFlow Pro ${operation} 失败：${JSON.stringify(response.error, null, 2)}`);
  }
  return response.result;
}

function manifestFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
    const target = path.join(current, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fail(`声音库不能包含符号链接：${target}`);
    if (entry.isDirectory()) files.push(...manifestFiles(root, target));
    if (entry.isFile() && entry.name === "voice-reference.json") files.push(target);
  }
  return files;
}

function validateVoiceReference(manifestPath) {
  const manifest = readJson(manifestPath, "全局声音清单");
  if (
    manifest.protocol !== "mediaflow-global-voice-reference"
    || manifest.version !== 1
  ) {
    fail(`全局声音清单必须使用 mediaflow-global-voice-reference v1：${manifestPath}`);
  }
  const directory = path.dirname(manifestPath);
  const id = requiredString(manifest.id, "voice.id");
  const displayName = requiredString(manifest.display_name, `${id}.display_name`);
  if (manifest.scope !== "global") fail(`${id}.scope 必须是 global`);
  if (manifest.consumer_operation !== "speech.synthesize") {
    fail(`${id}.consumer_operation 必须是 speech.synthesize`);
  }
  const language = requiredString(manifest.language, `${id}.language`);
  const aliases = manifest.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${id}.aliases 必须是非空字符串数组`);
  }
  const audioPath = childPath(directory, manifest.audio?.file, `${id}.audio.file`);
  const transcriptPath = childPath(
    directory,
    manifest.transcript?.file,
    `${id}.transcript.file`,
  );
  if (!fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile()) {
    fail(`${id} 的参考音频不存在：${audioPath}`);
  }
  if (!fs.existsSync(transcriptPath) || !fs.statSync(transcriptPath).isFile()) {
    fail(`${id} 的参考文本不存在：${transcriptPath}`);
  }
  const audioSha256 = sha256File(audioPath);
  const expectedAudioSha256 = requiredString(manifest.audio?.sha256, `${id}.audio.sha256`);
  if (audioSha256 !== expectedAudioSha256) fail(`${id} 的参考音频哈希不一致`);
  const transcriptSha256 = sha256File(transcriptPath);
  const expectedTranscriptSha256 = requiredString(
    manifest.transcript?.sha256,
    `${id}.transcript.sha256`,
  );
  if (transcriptSha256 !== expectedTranscriptSha256) fail(`${id} 的参考文本哈希不一致`);
  const referenceText = requiredString(manifest.transcript?.text, `${id}.transcript.text`);
  if (fs.readFileSync(transcriptPath, "utf8").trimEnd() !== referenceText) {
    fail(`${id} 的 transcript.text 与参考文本文件不一致`);
  }
  return {
    id,
    display_name: displayName,
    aliases: aliases.map((item) => item.trim()),
    scope: "global",
    consumer_operation: "speech.synthesize",
    reference_audio: audioPath,
    reference_audio_sha256: audioSha256,
    reference_text: referenceText,
    reference_text_sha256: transcriptSha256,
    reference_language: language,
    manifest_path: manifestPath,
    validation: {
      status: manifest.validation?.status ?? "unknown",
      manual_voice_review: manifest.validation?.manual_voice_review ?? "unknown",
      engine: manifest.validation?.engine ?? null,
      engine_version: manifest.validation?.engine_version ?? null,
      device: manifest.validation?.device ?? null,
    },
  };
}

export function listVoiceReferences(environment) {
  const voices = environment.voiceReferenceRoots.flatMap((root) => (
    manifestFiles(root).sort().map(validateVoiceReference)
  ));
  const owners = new Map();
  for (const voice of voices) {
    for (const value of [voice.id, voice.display_name, ...voice.aliases]) {
      const key = value.trim().toLocaleLowerCase();
      const previous = owners.get(key);
      if (previous && previous !== voice.id) {
        fail(`全局声音名称或别名不唯一：${value} 同时属于 ${previous} 和 ${voice.id}`);
      }
      owners.set(key, voice.id);
    }
  }
  return voices.sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveVoiceReference(environment, selector) {
  const expected = requiredString(selector, "voice").toLocaleLowerCase();
  const matches = listVoiceReferences(environment).filter((voice) => (
    [voice.id, voice.display_name, ...voice.aliases]
      .some((value) => value.toLocaleLowerCase() === expected)
  ));
  if (!matches.length) fail(`没有找到全局声音：${selector}`);
  if (matches.length > 1) {
    fail(`全局声音选择不唯一：${selector} -> ${matches.map((item) => item.id).join(", ")}`);
  }
  return {
    protocol: "visual-multimedia-voice-reference-resolution",
    version: 1,
    ...matches[0],
  };
}

function parseOptions(argv) {
  const options = {_: []};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) fail(`--${name} 缺少值`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function printHelp() {
  process.stdout.write(`用法：
node scripts/local-media-environment.mjs inspect [--config <路径>]
node scripts/local-media-environment.mjs voice-list [--config <路径>]
node scripts/local-media-environment.mjs voice-resolve --voice <id或名称> [--config <路径>]
node scripts/local-media-environment.mjs mediaflow describe [--config <路径>]
node scripts/local-media-environment.mjs mediaflow execute --request <JSON文件或-> [--config <路径>]
`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main(argv) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const options = parseOptions(argv);
  const [command, subcommand] = options._;
  const environment = loadLocalMediaEnvironment(options.config || null);
  if (command === "inspect") {
    const version = run(environment.mediaflow.python, ["--version"]);
    if (version.status !== 0) fail("配置的 MediaFlow Python 无法启动");
    const voices = listVoiceReferences(environment);
    printJson({
      protocol: "visual-multimedia-local-environment-inspection",
      version: 1,
      config_path: environment.configPath,
      mediaflow: {
        python: environment.mediaflow.python,
        python_version: (version.stdout || version.stderr || "").trim(),
        source_root: environment.mediaflow.sourceRoot,
        settings_path: environment.mediaflow.settingsPath,
        cli_module: path.join(environment.mediaflow.sourceRoot, "mediaflow", "cli.py"),
      },
      voice_reference_roots: environment.voiceReferenceRoots,
      registered_voice_count: voices.length,
    });
    return;
  }
  if (command === "voice-list") {
    printJson({voices: listVoiceReferences(environment)});
    return;
  }
  if (command === "voice-resolve") {
    printJson(resolveVoiceReference(environment, options.voice));
    return;
  }
  if (command === "mediaflow" && subcommand === "describe") {
    printJson(mediaFlowResult(environment, ["describe"]));
    return;
  }
  if (command === "mediaflow" && subcommand === "execute") {
    const requestPath = requiredString(options.request, "request");
    const payload = requestPath === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(path.resolve(requestPath), "utf8");
    JSON.parse(payload);
    const response = mediaFlowResult(
      environment,
      ["execute", "--request", "-"],
      payload,
    );
    printJson(response);
    if (!response.ok) process.exitCode = 1;
    return;
  }
  fail(`未知命令：${options._.join(" ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {code: "local_environment_error", message: error.message},
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
