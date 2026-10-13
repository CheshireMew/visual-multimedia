#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {loadLocalMediaEnvironment, mediaFlowProExecute, mediaFlowProWaitForTask} from "./local-media-environment.mjs";
import {assertSkillTaskPath, preflightTaskWorkspace} from "./media-task-workspace.mjs";
import {validateMediaSources} from "./validate-media-sources.mjs";
import {validateSoundProductionProfile} from "./sound-production-profile.mjs";
import {readRecordingAnalysis, locateRecordingTarget, materializeRecordingGuidance} from "./recording-guidance.mjs";
import {measureMix} from "./timeline-audio-mix.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const norm = text => text.toLocaleLowerCase().replace(/[\s，。！？、,.!?「」“”"']/gu, "");

function parse(argv) {
  const args = {command:argv[0]};
  for (let i=1;i<argv.length;i++) {
    if (!argv[i].startsWith("--") || argv[i+1] == null) throw new Error(`参数缺少值：${argv[i]}`);
    args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}
function required(args, key) {if (!args[key]) throw new Error(`缺少 --${key}`); return args[key];}
function save(file, value) {
  file = assertSkillTaskPath(file);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(value,null,2)+"\n",{encoding:"utf8",flag:"wx"});
}
function projectFile(project, name) {
  const file = assertSkillTaskPath(path.resolve(project,name));
  if (!file.startsWith(project+path.sep)) throw new Error("输出必须位于当前制作项目内");
  return file;
}
function execute(environment, command, args) {
  const local = environment.providers.local;
  const result = spawnSync(command,args.map(String),{encoding:"utf8",windowsHide:true,maxBuffer:64*1024*1024,
    env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8",PATH:[path.dirname(local.ffmpeg),path.dirname(local.ffprobe),process.env.PATH].join(path.delimiter)}});
  if (result.error) throw result.error;
  if (result.status!==0) throw new Error(result.stderr || result.stdout || `${command}: ${result.status}`);
  return result.stdout;
}
function python(environment, name, args) {
  if (!environment.providers.local.python) throw new Error("本机配置缺少可用 Python");
  return JSON.parse(execute(environment,environment.providers.local.python,[path.join(ROOT,"scripts",name),...args]));
}
function asset(project,id,environment) {
  const manifest = path.join(project,"media-sources.json");
  const checked = validateMediaSources(manifest,{ffprobe:environment.providers.local.ffprobe});
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  const source = JSON.parse(fs.readFileSync(manifest,"utf8")).sources.find(item=>item.id===id);
  if (!source || source.representation.kind!=="source") throw new Error(`不存在原始 source：${id}`);
  return {...source,absolute:projectFile(project,source.file)};
}
function importAudio(environment,project,file,id,provider,capture,license,status="confirmed") {
  const metadata=JSON.parse(fs.readFileSync(capture,"utf8"));
  return JSON.parse(execute(environment,process.execPath,[path.join(ROOT,"scripts/import-media-asset.mjs"),
    "--project",project,"--input",file,"--id",id,"--media-type","audio","--method","generated-in-project",
    "--provider",provider,"--rights-status",status,"--license",license||"Source audio rights retained",
    "--generation-model",metadata.engine||metadata.model||provider,"--generation-prompt",JSON.stringify(metadata),
    "--usage",provider,"--capture",capture]));
}
function stamp(seconds) {
  const ticks=Math.round(seconds*1000), h=Math.floor(ticks/3600000), m=Math.floor(ticks/60000)%60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(Math.floor(ticks/1000)%60).padStart(2,"0")},${String(ticks%1000).padStart(3,"0")}`;
}

export function suspiciousWordSegments(segments, maximum=1.2) {
  return segments.map((segment,index)=>({segment,index})).filter(({segment})=>(segment.words||[])
    .some(word=>norm(word.text).length>0 && norm(word.text).length<=2 && word.end_seconds-word.start_seconds>maximum));
}

function transcribe(environment,project,args) {
  const source=asset(project,required(args,"source-id"),environment);
  const analysis=args.analysis ? readRecordingAnalysis(project,projectFile(project,args.analysis)) : null;
  const prompt=[args.context,...(analysis?.vocabulary||[])].filter(Boolean).join("、").slice(0,4000);
  const folder=projectFile(project,`work/asr-${source.integrity.sha256.slice(0,12)}-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(folder,{recursive:true});
  process.stderr.write("正在调用公开 speech.transcribe；首次结果完成后仅复核异常区间。\n");
  const result=mediaFlowProExecute(environment,null,"speech.transcribe",{input_path:source.absolute,
    output_path:path.join(folder,"raw.srt"),language:args.language||null,initial_prompt:prompt||null});
  save(path.join(folder,"raw-receipt.json"),result);
  const records=[];
  for (const {segment,index} of suspiciousWordSegments(result.segments)) {
    const start=Math.max(0,segment.start_seconds-1.5), end=segment.end_seconds+1.5;
    const audio=path.join(folder,`window-${index}.wav`);
    execute(environment,environment.providers.local.ffmpeg,["-v","error","-n","-ss",start,"-t",end-start,
      "-i",source.absolute,"-vn","-ac","1","-ar","16000","-c:a","pcm_s16le",audio]);
    const check=mediaFlowProExecute(environment,null,"speech.transcribe",{input_path:audio,output_path:path.join(folder,`window-${index}.srt`),
      language:args.language||null,initial_prompt:prompt||null});
    save(path.join(folder,`window-${index}.json`),check);
    const matches=[];
    for (let i=0;i<check.segments.length;i++) for (let j=i;j<check.segments.length;j++) {
      const run=check.segments.slice(i,j+1);
      if (norm(run.map(item=>item.text).join(""))===norm(segment.text)) matches.push(run);
    }
    const replacement=matches.length===1 && !suspiciousWordSegments(matches[0]).length ? matches[0] : null;
    const previous=result.segments[index-1]?.end_seconds||0, next=result.segments[index+1]?.start_seconds||Infinity;
    if (replacement && replacement[0].start_seconds+start>=previous-.001 && replacement.at(-1).end_seconds+start<=next+.001) {
      const words=replacement.flatMap(item=>(item.words||[]).map(word=>({...word,start_seconds:word.start_seconds+start,end_seconds:word.end_seconds+start})));
      if (words.length) {
        result.segments[index]={...segment,start_seconds:replacement[0].start_seconds+start,
          end_seconds:replacement.at(-1).end_seconds+start,words};
        records.push({index,status:"retimed",window:audio,receipt:path.join(folder,`window-${index}.json`)});
        continue;
      }
    }
    records.push({index,status:"needs-listening",window:audio,receipt:path.join(folder,`window-${index}.json`)});
  }
  const srt=path.join(folder,"captions.srt");
  fs.writeFileSync(srt,result.segments.map((item,index)=>`${index+1}\n${stamp(item.start_seconds)} --> ${stamp(item.end_seconds)}\n${item.text}\n`).join("\n"),{encoding:"utf8",flag:"wx"});
  const receipt=path.join(folder,"receipt.json");
  save(receipt,{...result,output_path:srt,output_sha256:sha(srt),rechecks:records,
    screen_analysis:analysis ? {file:projectFile(project,args.analysis),sha256:sha(projectFile(project,args.analysis))}:null,
    initial_prompt:prompt});
  const output=args.output||`transcript-${sha(receipt).slice(0,16)}.json`;
  const imported=JSON.parse(execute(environment,process.execPath,[path.join(ROOT,"scripts/import-media-transcript.mjs"),
    "--project",project,"--source-id",source.id,"--input",receipt,"--kind","asr","--language",result.language,"--output",output]));
  return {...imported,receipt,rechecks:records,word_count:result.segments.reduce((n,item)=>n+(item.words||[]).length,0)};
}

function applySound(environment,project,args) {
  const file=projectFile(project,args.profile||"sound-profile.json");
  const checked=validateSoundProductionProfile(file,{mediaSourcesPath:path.join(project,"media-sources.json")});
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  const profile=JSON.parse(fs.readFileSync(file,"utf8"));
  const native=path.resolve(required(args,"native-project"));
  const map=JSON.parse(fs.readFileSync(projectFile(project,required(args,"bus-map")),"utf8"));
  mediaFlowProExecute(environment,native,"project.inspect",{});
  const inspected=mediaFlowProExecute(environment,native,"audio.inspect",{});
  const buses=new Map(inspected.buses.map(bus=>[bus.id,bus]));
  if (!map.master || !buses.has(map.master) || buses.get(map.master).parent_bus_id!==null) {
    throw new Error("bus-map.master 必须是公开 audio.inspect 返回的主总线 id");
  }
  const effects=[]; const duck=profile.mix.ducking;
  if (duck.enabled) {
    const drivers=duck.trigger_roles.map(role=>map[role]).filter(Boolean);
    if (drivers.length!==1 || !buses.has(drivers[0]) || drivers[0]===map.master) throw new Error("录屏混音需要唯一独立的实际人声驱动总线");
    for (const role of duck.target_roles) {
      const busId=map[role]; if (!buses.has(busId) || busId===drivers[0] || busId===map.master) throw new Error(`缺少独立的实际 ${role} 总线`);
      effects.push({bus_id:busId,kind:"ducking",parameters:{driver_bus_id:drivers[0],reduction_db:-duck.reduction_db,attack_ms:duck.attack_ms,release_ms:duck.release_ms}});
    }
  }
  effects.push({bus_id:map.master,kind:"limiter",parameters:{ceiling_db:Math.max(-12,profile.mix.loudness.true_peak_dbfs-.4)}});
  const results=[];
  for (const effect of effects) {
    const id=`recording-${effect.kind}-${effect.bus_id}`;
    const existing=buses.get(effect.bus_id).effects;
    const position=existing.find(item=>item.id===id)?.position ?? Math.max(-1,...existing.map(item=>item.position))+1;
    results.push(mediaFlowProExecute(environment,native,"audio.effect.save",{effect:{...effect,id,position,enabled:true}},`${profile.profile_id}-${sha(file).slice(0,12)}-${id}`));
  }
  const folder=projectFile(project,`work/native-mix-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(folder,{recursive:true});
  const measure=(name)=>{
    const output=path.join(folder,`${name}.wav`);
    const receipt=mediaFlowProExecute(environment,native,"export.sequence",{output_path:output,format:"audio",
      preset:{name:"Sound profile measurement",format:"audio",container:"wav",encoder_policy:null,
        audio_codec:"pcm_s24le",pixel_format:null},overwrite:false,timeout:600},`${profile.profile_id}-${path.basename(folder)}-${name}`);
    const completed=mediaFlowProWaitForTask(environment,native,receipt,600);
    save(path.join(folder,`${name}.json`),completed);
    return measureMix(environment.providers.local.ffmpeg,output,(command,argumentsValue)=>{
      const result=spawnSync(command,argumentsValue,{encoding:"utf8",windowsHide:true,maxBuffer:64*1024*1024});
      if(result.error)throw result.error;
      if(result.status!==0)throw new Error(result.stderr);
      return result;
    },profile.mix.loudness);
  };
  const before=measure("before");
  const gain=buses.get(map.master).gain_db+profile.mix.loudness.target_lufs-before.integrated_lufs;
  mediaFlowProExecute(environment,native,"audio.bus.update",{bus_id:map.master,changes:{gain_db:gain}},
    `${profile.profile_id}-${path.basename(folder)}-master-gain`);
  const after=measure("after");
  if(Math.abs(after.integrated_lufs-profile.mix.loudness.target_lufs)>1 || after.true_peak_dbtp>profile.mix.loudness.true_peak_dbfs+.2) {
    throw new Error(`原生混音复测未达到当前声音档案目标：${JSON.stringify(after)}；测量保留在 ${folder}`);
  }
  const outcome={profile:file,profile_sha256:sha(file),project:native,effects:results,
    mastering:{before,after,gain_db:gain,evidence:folder},
    after:mediaFlowProExecute(environment,native,"audio.inspect",{})};
  save(projectFile(project,args.output||`reports/native-sound-${Date.now()}.json`),outcome);
  return outcome;
}

export function main(argv) {
  if (!argv.length || argv.includes("--help")) {
    console.log("recording-tools.mjs analyze|guide|transcribe|align-audio|music|apply-sound --project <Skill task project>\n"
      +"analyze --source-id <video> [--fps 1 --language zh-Hans-CN --output reports/screen.json]\n"
      +"guide --analysis reports/screen.json --text <screen label> --start <seconds> --end <seconds> --output <package>\n"
      +"transcribe --source-id <selected voice/video> [--analysis reports/screen.json --language zh --context <terms> --output transcript.json]\n"
      +"align-audio --source-id <video> --voice-source-id <microphone> --adopt-id <aligned voice> --output <wav>\n"
      +"music --seconds <final duration> --adopt-id <source id> --output <wav> [--profile tutorial_focused --seed 7]\n"
      +"apply-sound --native-project <returned project path> --bus-map <project JSON: role to inspected bus id> [--profile sound-profile.json]");
    return null;
  }
  const args=parse(argv); const project=assertSkillTaskPath(path.resolve(required(args,"project")));
  const environment=loadLocalMediaEnvironment(); const local=environment.providers.local;
  if (!local.ffmpeg || !local.ffprobe) throw new Error("当前本机配置缺少 FFmpeg/FFprobe");
  const taskId=path.relative(path.join(ROOT,"artifacts"),project).split(path.sep)[0];
  preflightTaskWorkspace(taskId,args.command==="music"?Math.ceil(Number(required(args,"seconds"))*48000*12):256*1024*1024);
  if (args.command==="analyze") {
    asset(project,required(args,"source-id"),environment);
    if (process.platform!=="win32") throw new Error("当前正式屏幕 OCR 实现验收平台为 Windows");
    const output=projectFile(project,args.output||"reports/screen.json");
    const result=python(environment,"analyze-screen-recording.py",["--project",project,"--source-id",args["source-id"],
      "--output",output,"--ffmpeg",local.ffmpeg,"--ffprobe",local.ffprobe,"--powershell",
      path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),"--fps",args.fps||1,"--language",args.language||"zh-Hans-CN"]);
    readRecordingAnalysis(project,output); return result;
  }
  if (args.command==="guide") {
    const report=readRecordingAnalysis(project,projectFile(project,required(args,"analysis")));
    const start=Number(required(args,"start")),end=Number(required(args,"end"));
    const location=locateRecordingTarget(report,required(args,"text"),start,end);
    const result=location.status==="stable" ? materializeRecordingGuidance({report,location,
      output:projectFile(project,required(args,"output")),text:args.label||args.text,duration:end-start,color:args.color}) : location;
    return {...result,source_start_seconds:start,source_end_seconds:end,location};
  }
  if (args.command==="transcribe") return transcribe(environment,project,args);
  if (args.command==="align-audio") {
    const original=asset(project,required(args,"source-id"),environment),voice=asset(project,required(args,"voice-source-id"),environment);
    const output=projectFile(project,required(args,"output"));
    const report=python(environment,"align-recording-audio.py",["--project",project,"--source-id",original.id,"--voice-source-id",voice.id,
      "--output",output,"--ffmpeg",local.ffmpeg,"--ffprobe",local.ffprobe]);
    const capture=output.replace(/\.[^.]+$/u,".alignment.json");
    return {alignment:report,adopted:importAudio(environment,project,output,required(args,"adopt-id"),"recording-audio-alignment",capture,voice.rights.license,voice.rights.status)};
  }
  if (args.command==="music") {
    const output=projectFile(project,required(args,"output"));
    const report=python(environment,"generate-background-music.py",["--output",output,"--seconds",required(args,"seconds"),
      "--profile",args.profile||"tutorial_focused","--seed",args.seed||7,...(args.bpm?["--bpm",args.bpm]:[]),...(args.key?["--key",args.key]:[])]);
    return {music:report,adopted:importAudio(environment,project,output,required(args,"adopt-id"),"code-synth",output.replace(/\.[^.]+$/u,".music.json"),"MIT code-composed score; no external samples")};
  }
  if (args.command==="apply-sound") return applySound(environment,project,args);
  throw new Error(`未知命令：${args.command}`);
}

if (path.resolve(process.argv[1]||"")===SCRIPT) {
  try {const result=main(process.argv.slice(2));if(result)console.log(JSON.stringify(result,null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
