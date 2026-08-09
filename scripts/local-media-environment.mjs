import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const require = createRequire(import.meta.url);
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

function optionalFile(value, label) {
  return value == null ? null : existingFile(value, label);
}

function optionalDirectory(value, label) {
  return value == null ? null : existingDirectory(value, label);
}

function discoverCommand(name) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [name], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const candidate = (result.stdout || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  return candidate && fs.existsSync(candidate) ? path.normalize(candidate) : null;
}

function defaultCacheRoot() {
  if (process.platform === "win32" && fs.existsSync("D:\\Tools")) {
    return "D:\\Tools\\visual-multimedia-cache";
  }
  return path.join(os.tmpdir(), "visual-multimedia-cache");
}

function detectPlaywright(configuredRoot = null) {
  const candidates = [
    configuredRoot,
    SKILL_ROOT,
    process.cwd(),
    process.env.NODE_PATH,
    process.env.PLAYWRIGHT_NODE_MODULES,
    process.platform === "win32" ? "D:\\Tools\\NodeJS\\node_modules" : null,
    process.platform === "win32" ? "D:\\Tools\\npm-global\\node_modules" : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const modulePath = require.resolve("playwright", {paths: [candidate]});
      const playwright = require(modulePath);
      const browserExecutable = playwright.chromium?.executablePath?.() || null;
      return {
        available: true,
        module: modulePath,
        search_root: candidate,
        browser_executable: browserExecutable && fs.existsSync(browserExecutable)
          ? browserExecutable
          : null,
      };
    } catch {
      // Continue through configured and common local dependency roots.
    }
  }
  return {
    available: false,
    module: null,
    search_root: configuredRoot,
    browser_executable: null,
  };
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
  const hasConfig = fs.existsSync(configPath) && fs.statSync(configPath).isFile();
  const document = hasConfig
    ? readJson(configPath, "本机配置")
    : {
      protocol: "visual-multimedia-local-environment",
      version: 2,
      providers: {local: {}},
      resources: {voice_reference_roots: []},
      runtime: {cache_root: defaultCacheRoot()},
    };
  if (
    document.protocol !== "visual-multimedia-local-environment"
    || document.version !== 2
  ) {
    fail("本机配置必须使用 visual-multimedia-local-environment v2");
  }
  if (!document.providers || typeof document.providers !== "object") {
    fail("本机配置缺少 providers");
  }
  const localDocument = document.providers.local || {};
  if (typeof localDocument !== "object") fail("providers.local 必须是对象");
  const local = {
    ffmpeg: optionalFile(localDocument.ffmpeg, "providers.local.ffmpeg")
      || discoverCommand("ffmpeg"),
    ffprobe: optionalFile(localDocument.ffprobe, "providers.local.ffprobe")
      || discoverCommand("ffprobe"),
    browser: optionalFile(localDocument.browser, "providers.local.browser")
      || optionalFile(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
    playwrightNodeModules: optionalDirectory(
      localDocument.playwright_node_modules,
      "providers.local.playwright_node_modules",
    ),
  };
  local.playwright = detectPlaywright(local.playwrightNodeModules);

  let mediaflow = null;
  if (document.providers.mediaflow != null) {
    if (typeof document.providers.mediaflow !== "object") {
      fail("providers.mediaflow 必须是对象或 null");
    }
    const python = existingFile(
      document.providers.mediaflow.python,
      "providers.mediaflow.python",
    );
    const sourceRoot = existingDirectory(
      document.providers.mediaflow.source_root,
      "providers.mediaflow.source_root",
    );
    const serviceSettingsPath = existingFile(
      document.providers.mediaflow.service_settings_path,
      "providers.mediaflow.service_settings_path",
    );
    const cliModule = path.join(sourceRoot, "mediaflow", "cli.py");
    if (!fs.existsSync(cliModule) || !fs.statSync(cliModule).isFile()) {
      fail(`providers.mediaflow.source_root 中没有正式 CLI：${cliModule}`);
    }
    mediaflow = {python, sourceRoot, serviceSettingsPath, cliModule};
  }

  let hyperframes = null;
  if (document.providers.hyperframes != null) {
    if (typeof document.providers.hyperframes !== "object") {
      fail("providers.hyperframes 必须是对象或 null");
    }
    hyperframes = {
      command: existingFile(
        document.providers.hyperframes.command,
        "providers.hyperframes.command",
      ),
    };
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
  if (!document.runtime || typeof document.runtime !== "object") fail("本机配置缺少 runtime");
  const cacheRoot = hasConfig
    ? existingDirectory(document.runtime.cache_root, "runtime.cache_root")
    : absolutePath(document.runtime.cache_root, "runtime.cache_root");
  return {
    configPath: hasConfig ? configPath : null,
    protocol: document.protocol,
    version: document.version,
    providers: {local, mediaflow, hyperframes},
    voiceReferenceRoots,
    runtime: {cacheRoot},
  };
}

function requireMediaFlow(environment) {
  const provider = environment.providers?.mediaflow;
  if (!provider) {
    fail("当前本机配置没有启用 MediaFlow Pro；本地制作能力仍可继续使用");
  }
  return provider;
}

function mediaFlowResult(environment, args, input = undefined) {
  const provider = requireMediaFlow(environment);
  const result = run(
    provider.python,
    ["-m", "mediaflow.cli", ...args],
    {
      cwd: provider.sourceRoot,
      env: {
        ...process.env,
        MEDIAFLOW_SERVICE_SETTINGS_PATH: provider.serviceSettingsPath,
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

let mediaFlowContract = null;
const mediaFlowProjectRevisions = new Map();

export function mediaFlowProDescribe(environment) {
  const response = mediaFlowResult(environment, ["describe"]);
  if (!response.ok) {
    fail(`MediaFlow Pro describe 失败：${JSON.stringify(response.error)}`);
  }
  if (response.protocol !== "mediaflow-editor" || response.version !== 4) {
    fail("MediaFlow Pro 没有返回当前 v4 响应合同");
  }
  mediaFlowContract = response.result;
  return mediaFlowContract;
}

export function mediaFlowProExecute(
  environment,
  project,
  operation,
  argumentsValue,
  requestId = null,
) {
  if (!mediaFlowContract) mediaFlowProDescribe(environment);
  const request = {
    protocol: "mediaflow-editor",
    version: 4,
    operation,
    project,
    arguments: argumentsValue,
    actor: {
      kind: "agent",
      id: "visual-multimedia",
      name: "Visual Multimedia",
    },
    client_id: "visual-multimedia",
  };
  if (requestId) request.request_id = requestId;
  const operationContract = (mediaFlowContract?.operations || []).find(
    (item) => item.name === operation,
  );
  if (!operationContract) {
    fail(`MediaFlow Pro describe 没有声明操作：${operation}`);
  }
  if (operationContract.project_access === "write" && !requestId) {
    fail(`MediaFlow Pro ${operation} 写入必须提供稳定 request_id`);
  }
  if (operationContract.project_access === "write" && project) {
    const projectKey = path.resolve(project);
    if (!mediaFlowProjectRevisions.has(projectKey) && operation !== "project.upgrade") {
      fail(
        `MediaFlow Pro ${operation} 写入前必须先读取 project.inspect，`
        + `以取得当前 base_revision：${projectKey}`,
      );
    }
    if (mediaFlowProjectRevisions.has(projectKey)) {
      request.base_revision = mediaFlowProjectRevisions.get(projectKey);
    }
  }
  const response = mediaFlowResult(
    environment,
    ["execute", "--request", "-"],
    JSON.stringify(request),
  );
  if (response.protocol !== "mediaflow-editor" || response.version !== 4) {
    fail(`MediaFlow Pro ${operation} 没有返回当前 v4 响应合同`);
  }
  if (!response.ok) {
    fail(`MediaFlow Pro ${operation} 失败：${JSON.stringify(response.error, null, 2)}`);
  }
  const serviceResult = response.result;
  if (!serviceResult || typeof serviceResult !== "object" || !("result" in serviceResult)) {
    fail(`MediaFlow Pro ${operation} 没有返回 Editor Service 结果信封`);
  }
  const result = serviceResult.result;
  const resultProject = project || result?.path;
  if (
    resultProject
    && Number.isInteger(serviceResult.project_revision)
  ) {
    mediaFlowProjectRevisions.set(
      path.resolve(resultProject),
      serviceResult.project_revision,
    );
  }
  return result;
}

export function mediaFlowProWaitForTask(
  environment,
  project,
  receipt,
  timeout = 3600,
) {
  const taskId = requiredString(receipt?.task?.id, "MediaFlow Pro task receipt id");
  const result = mediaFlowProExecute(
    environment,
    project,
    "task.wait",
    {task_id: taskId, timeout},
  );
  const task = result?.task;
  if (!task || task.id !== taskId) {
    fail(`MediaFlow Pro task.wait 没有返回任务 ${taskId}`);
  }
  if (task.status !== "completed") {
    fail(`MediaFlow Pro 任务 ${taskId} 未完成：${JSON.stringify(task, null, 2)}`);
  }
  return task;
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

export function inspectLocalMediaCapabilities(environment) {
  const local = environment.providers.local;
  const mediaflow = environment.providers.mediaflow;
  const hyperframes = environment.providers.hyperframes;
  const localBrowser = local.browser || local.playwright.browser_executable;
  let mediaFlowProbe = null;
  let mediaFlowProbeError = null;
  if (mediaflow) {
    try {
      if (mediaflow.probe) {
        mediaFlowProbe = mediaflow.probe;
      } else {
        const contract = mediaFlowProDescribe(environment);
        const runtime = mediaFlowProExecute(
          environment,
          null,
          "runtime.inspect",
          {},
        );
        mediaFlowProbe = {
          operations: (contract.operations || []).map((item) => item.name),
          built_in_capabilities: (contract.capabilities || [])
            .filter((item) => item.availability === "built-in")
            .map((item) => item.id),
          runtime_capabilities: (runtime.capabilities || [])
            .filter((item) => item.status === "ready")
            .map((item) => item.id),
        };
      }
    } catch (error) {
      mediaFlowProbeError = error.message;
    }
  }
  const mediaFlowOperations = new Set(mediaFlowProbe?.operations || []);
  const mediaFlowCapabilities = new Set([
    ...(mediaFlowProbe?.built_in_capabilities || []),
    ...(mediaFlowProbe?.runtime_capabilities || []),
  ]);
  const hasMediaFlowOperations = (...names) => (
    names.every((name) => mediaFlowOperations.has(name))
  );
  const hasMediaFlowCapabilities = (...names) => (
    names.every((name) => mediaFlowCapabilities.has(name))
  );
  const providers = {
    local: {
      available: Boolean(local.ffmpeg || local.ffprobe || local.playwright.available),
      ffmpeg: local.ffmpeg,
      ffprobe: local.ffprobe,
      playwright: local.playwright,
      browser: localBrowser,
      capabilities: {
        portable_timeline_render: Boolean(local.ffmpeg && local.ffprobe),
        deterministic_web_render: Boolean(
          local.ffmpeg && local.playwright.available && localBrowser
        ),
      },
    },
    mediaflow: {
      available: Boolean(mediaflow),
      source_root: mediaflow?.sourceRoot ?? null,
      cli_module: mediaflow?.cliModule ?? null,
      probe_error: mediaFlowProbeError,
      ready_operations: [...mediaFlowOperations].sort(),
      ready_capabilities: [...mediaFlowCapabilities].sort(),
      capabilities: {
        native_project: hasMediaFlowOperations(
          "project.create",
          "project.inspect",
          "timeline.get",
        ) && hasMediaFlowCapabilities("project-editing"),
        desktop_handoff: hasMediaFlowOperations(
          "project.version.create",
          "project.changes.list",
          "project.handoff.inspect",
        ) && hasMediaFlowCapabilities("asynchronous-project-handoff"),
        timeline_edit: hasMediaFlowOperations(
          "timeline.get",
          "timeline.clip.add",
          "timeline.clip.move",
          "timeline.clip.split",
          "timeline.clip.delete",
        ) && hasMediaFlowCapabilities("project-editing"),
        timeline_render: hasMediaFlowOperations(
          "timeline.portable.inspect",
          "timeline.portable.import",
          "export.sequence",
        ) && hasMediaFlowCapabilities(
          "portable-timeline-import",
          "ffmpeg",
          "mlt",
        ),
        deterministic_web_render: hasMediaFlowOperations(
          "web.import",
          "web.clip.render",
          "web.clip.export",
        ) && hasMediaFlowCapabilities(
          "editable-web-media",
          "web-multi-format-export",
          "ffmpeg",
          "chromium",
        ),
        subtitle_edit: hasMediaFlowOperations(
          "subtitle.list",
          "subtitle.segment.update",
          "subtitle.track.style.update",
        ),
        audio_edit: hasMediaFlowOperations(
          "audio.inspect",
          "audio.bus.update",
          "timeline.clip.audio",
        ),
        speech_transcribe: hasMediaFlowOperations("speech.transcribe")
          && hasMediaFlowCapabilities("faster-whisper-xxl"),
        speech_synthesize: hasMediaFlowOperations("speech.synthesize")
          && hasMediaFlowCapabilities("gpt-sovits-v2pro"),
        preview: hasMediaFlowOperations("preview.render")
          && hasMediaFlowCapabilities("mlt", "native-preview"),
        export: hasMediaFlowOperations("export.sequence")
          && hasMediaFlowCapabilities("ffmpeg", "mlt"),
        reference_compare: hasMediaFlowOperations("quality.reference.compare")
          && hasMediaFlowCapabilities("reference-video-comparison", "ffmpeg"),
      },
    },
    hyperframes: {
      available: Boolean(hyperframes),
      command: hyperframes?.command ?? null,
      capabilities: {
        deterministic_web_render: Boolean(hyperframes),
      },
    },
  };
  return {
    protocol: "visual-multimedia-provider-capabilities",
    version: 1,
    config_path: environment.configPath,
    cache_root: environment.runtime.cacheRoot,
    providers,
  };
}

export function resolveProviderNeed(environment, need) {
  const inspection = inspectLocalMediaCapabilities(environment);
  const candidates = [];
  if (need === "timeline-render") {
    if (inspection.providers.mediaflow.capabilities.timeline_render) candidates.push("mediaflow");
    if (inspection.providers.local.capabilities.portable_timeline_render) candidates.push("local");
  } else if (need === "timeline-edit") {
    if (inspection.providers.mediaflow.capabilities.timeline_edit) candidates.push("mediaflow");
    if (inspection.providers.local.capabilities.portable_timeline_render) candidates.push("local");
  } else if (need === "web-render") {
    if (inspection.providers.mediaflow.capabilities.deterministic_web_render) candidates.push("mediaflow");
    if (inspection.providers.local.capabilities.deterministic_web_render) candidates.push("local");
    if (inspection.providers.hyperframes.capabilities.deterministic_web_render) candidates.push("hyperframes");
  } else if (need === "subtitle-edit" || need === "audio-edit") {
    if (inspection.providers.mediaflow.capabilities[need.replace("-", "_")]) {
      candidates.push("mediaflow");
    }
    if (inspection.providers.local.capabilities.portable_timeline_render) candidates.push("local");
  } else if (
    need === "speech-transcribe"
    || need === "speech-synthesize"
    || need === "preview"
    || need === "export"
    || need === "reference-compare"
  ) {
    const capability = need.replaceAll("-", "_");
    if (inspection.providers.mediaflow.capabilities[capability]) candidates.push("mediaflow");
    if (
      (need === "preview" || need === "export")
      && inspection.providers.local.capabilities.portable_timeline_render
    ) candidates.push("local");
  } else if (need === "native-project" || need === "desktop-handoff") {
    const capability = need.replace("-", "_");
    if (inspection.providers.mediaflow.capabilities[capability]) candidates.push("mediaflow");
  } else {
    fail(`未知能力需求：${need}`);
  }
  return {
    protocol: "visual-multimedia-provider-candidates",
    version: 1,
    need,
    candidates,
    available: candidates.length > 0,
    preferred_provider: candidates[0] || null,
    selection_policy: "MediaFlow Pro 可用时优先；否则使用完整本地能力；HyperFrames 仅在明确选择时使用。选定后失败不会静默换路",
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
node scripts/local-media-environment.mjs resolve --need timeline-edit|timeline-render|web-render|subtitle-edit|audio-edit|speech-transcribe|speech-synthesize|preview|export|reference-compare|native-project|desktop-handoff [--config <路径>]
node scripts/local-media-environment.mjs cache-root [--config <路径>]
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
    const voices = listVoiceReferences(environment);
    const inspection = inspectLocalMediaCapabilities(environment);
    inspection.voice_reference_roots = environment.voiceReferenceRoots;
    inspection.registered_voice_count = voices.length;
    if (environment.providers.mediaflow) {
      const version = run(environment.providers.mediaflow.python, ["--version"]);
      if (version.status !== 0) fail("配置的 MediaFlow Python 无法启动");
      inspection.providers.mediaflow.python = environment.providers.mediaflow.python;
      inspection.providers.mediaflow.python_version = (
        version.stdout || version.stderr || ""
      ).trim();
      inspection.providers.mediaflow.service_settings_path = (
        environment.providers.mediaflow.serviceSettingsPath
      );
    }
    printJson(inspection);
    return;
  }
  if (command === "resolve") {
    printJson(resolveProviderNeed(environment, requiredString(options.need, "need")));
    return;
  }
  if (command === "cache-root") {
    printJson({cache_root: environment.runtime.cacheRoot});
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
