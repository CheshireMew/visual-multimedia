import fs from "node:fs";
import path from "node:path";
import {validateSoundProductionProfile} from "./sound-production-profile.mjs";

export function readTimelineSoundProfile(validation, requested = null) {
  const file = requested ? path.resolve(requested) : path.join(validation.project_root, "sound-profile.json");
  if (!fs.existsSync(file)) {
    if (requested) throw new Error(`声音档案不存在：${file}`);
    return null;
  }
  const checked = validateSoundProductionProfile(file, {
    mediaSourcesPath: path.join(validation.project_root, "media-sources.json"),
    projectId: validation.document.project_id,
  });
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  const ledger = JSON.parse(fs.readFileSync(path.join(validation.project_root, "media-sources.json"), "utf8"));
  const timelineSources = new Map(validation.document.sources.map(item => [item.id, item]));
  for (const cue of profile.palette) {
    const adopted = timelineSources.get(cue.source_id);
    const original = ledger.sources.find(item => item.id === cue.source_id);
    if (adopted && adopted.sha256 !== original.integrity.sha256) {
      throw new Error(`声音 ${cue.source_id} 与时间线采用的哈希不一致`);
    }
  }
  return {file, profile, cues: new Map(profile.palette.map(item => [item.source_id, item]))};
}

export function appendAudioMix(filters, records, duration, sound) {
  if (!records.length) return null;
  const groups = new Map();
  records.forEach((record, index) => {
    const role = sound?.cues.get(record.clip.source_id)?.role || "unassigned";
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push(`ac${index}`);
  });
  const roles = new Map();
  let index = 0;
  for (const [role, labels] of groups) {
    const output = `role${index++}`;
    const inputs = labels.map(label => `[${label}]`).join("");
    filters.push(labels.length === 1
      ? `${inputs}apad,atrim=duration=${duration}[${output}]`
      : `${inputs}amix=inputs=${labels.length}:duration=longest:normalize=0,apad,atrim=duration=${duration}[${output}]`);
    roles.set(role, output);
  }
  const duck = sound?.profile.mix.ducking;
  if (duck?.enabled) {
    const triggers = [...roles].filter(([role]) => duck.trigger_roles.includes(role));
    const targets = [...roles].filter(([role]) => duck.target_roles.includes(role));
    if (!triggers.length || !targets.length) throw new Error("ducking 的驱动或目标音频未被当前时间线采用");
    const input = [];
    triggers.forEach(([role, label], i) => {
      filters.push(`[${label}]asplit=2[driverkeep${i}][driverkey${i}]`);
      roles.set(role, `driverkeep${i}`); input.push(`[driverkey${i}]`);
    });
    filters.push(input.length === 1 ? `${input[0]}anull[duckkey]`
      : `${input.join("")}amix=inputs=${input.length}:normalize=0[duckkey]`);
    filters.push(`[duckkey]asplit=${targets.length}${targets.map((_, i) => `[duckkey${i}]`).join("")}`);
    targets.forEach(([role, label], i) => {
      // Wet/dry bounds the maximum attenuation by the configured reduction, including very loud speech.
      const wet = 1 - 10 ** (-duck.reduction_db / 20);
      filters.push(`[${label}][duckkey${i}]sidechaincompress=threshold=0.015:ratio=20:attack=${Math.max(.01, duck.attack_ms)}:release=${Math.max(.01, duck.release_ms)}:mix=${wet}[ducked${i}]`);
      roles.set(role, `ducked${i}`);
    });
  }
  const labels = [...roles.values()].map(label => `[${label}]`);
  filters.push(labels.length === 1 ? `${labels[0]}atrim=duration=${duration}[aout]`
    : `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,atrim=duration=${duration}[aout]`);
  return "aout";
}

export function measureMix(ffmpeg, file, run, settings) {
  const result = run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af",
    `loudnorm=I=${settings.target_lufs}:TP=${settings.true_peak_dbfs}:print_format=json`, "-f", "null", "-"], "测量最终混音");
  const match = result.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!match) throw new Error("FFmpeg 未返回混音响度");
  const values = JSON.parse(match);
  const measured = {integrated_lufs: Number(values.input_i), true_peak_dbtp: Number(values.input_tp), lra_lu: Number(values.input_lra)};
  if (!Object.values(measured).every(Number.isFinite)) throw new Error("混音无可测声音，不能宣称响度通过");
  return measured;
}

export function normalizeMix(ffmpeg, premaster, output, run, settings) {
  const before = measureMix(ffmpeg, premaster, run, settings);
  const gain = settings.target_lufs - before.integrated_lufs;
  const limit = 10 ** ((settings.true_peak_dbfs - .4) / 20);
  const filter = `volume=${gain}dB,alimiter=limit=${limit}:attack=1:release=80:level=0:latency=1,aresample=48000`;
  run(ffmpeg, ["-v", "error", "-y", "-i", premaster, "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy", "-af", filter, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output], "整理混音响度");
  let after = measureMix(ffmpeg, output, run, settings);
  if (Math.abs(after.integrated_lufs - settings.target_lufs) > .5) {
    const corrected = `${output}.corrected.mp4`;
    const adjustment = `volume=${settings.target_lufs-after.integrated_lufs}dB,alimiter=limit=${limit}:level=0:latency=1,aresample=48000`;
    run(ffmpeg, ["-v", "error", "-y", "-i", output, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
      "-af", adjustment, "-c:a", "aac", "-b:a", "192k", corrected], "修正编码后的混音响度");
    fs.copyFileSync(corrected, output);
    after = measureMix(ffmpeg, output, run, settings);
  }
  if (Math.abs(after.integrated_lufs - settings.target_lufs) > 1 || after.true_peak_dbtp > settings.true_peak_dbfs + .2) {
    throw new Error(`实际混音未达到当前声音档案目标：${JSON.stringify(after)}`);
  }
  return {mode: "linear-gain+limiter", before, after, target: settings};
}
