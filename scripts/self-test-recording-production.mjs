#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {loadLocalMediaEnvironment,mediaFlowProExecute,mediaFlowProWaitForTask} from "./local-media-environment.mjs";
import {assertMediaFlowProVideoCapabilities,ensureMediaFlowProVideoProject,exportEditableWebScene} from "./mediaflow_video_common.mjs";
import {measureMix} from "./timeline-audio-mix.mjs";
import {ensureTaskWorkspace,finalizeTaskWorkspace} from "./media-task-workspace.mjs";
import {readRecordingAnalysis,locateRecordingTarget} from "./recording-guidance.mjs";
import {suspiciousWordSegments} from "./recording-tools.mjs";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(import.meta.url);
const environment=loadLocalMediaEnvironment();
const local=environment.providers.local;
const taskId=`recording-${Date.now().toString(36)}-${process.pid}`;
const {path:project}=ensureTaskWorkspace(taskId,512*1024*1024);
const sha=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2));};
const childEnvironment={...process.env,PATH:[path.dirname(local.ffmpeg),path.dirname(local.ffprobe),process.env.PATH].join(path.delimiter),
  NODE_PATH:path.dirname(path.dirname(local.playwright.module)),
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:local.browser||local.playwright.browser_executable,
  MEDIAFLOW_SERVICE_STATE_DIR:path.join(project,"editor-service")};
// This is a test-owned Editor Service; it does not interrupt a user's open editor.
process.env.MEDIAFLOW_SERVICE_STATE_DIR=childEnvironment.MEDIAFLOW_SERVICE_STATE_DIR;
let nativeUsed=false;

function run(command,args,label) {
  process.stderr.write(`${label}\n`);
  const result=spawnSync(command,args.map(String),{cwd:project,env:childEnvironment,encoding:"utf8",windowsHide:true,maxBuffer:64*1024*1024});
  fs.mkdirSync(path.join(project,"logs"),{recursive:true});
  fs.writeFileSync(path.join(project,"logs",`${label.replace(/[^a-z0-9-]/gi,"_")}.log`),`${result.stdout||""}\n${result.stderr||""}`);
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${label}: ${result.stderr||result.stdout}`);
  return result.stdout;
}
function node(file,args,label){return run(process.execPath,[path.join(ROOT,"scripts",file),...args],label);}
function tools(command,args,label){return JSON.parse(node("recording-tools.mjs",[command,"--project",project,...args],label));}
function importAsset(file,id,type){return JSON.parse(node("import-media-asset.mjs",["--project",project,"--input",file,"--id",id,
  "--media-type",type,"--method","project-owned","--rights-status","confirmed","--license","project-owned synthetic test material",
  "--usage","recording production verification"],`import-${id}`));}

async function main(){
  fs.mkdirSync(path.join(project,"inputs"),{recursive:true});
  write(path.join(project,"media-sources.json"),{protocol:"visual-multimedia-media-sources",version:3,sources:[]});
  const playwright=require(local.playwright.module);
  const browser=await playwright.chromium.launch({headless:true,executablePath:local.browser||undefined});
  try{
    const page=await browser.newPage({viewport:{width:960,height:540}});
    await page.setContent(`<html><style>body{margin:0;background:#eef2f7;font:26px Arial;color:#202733}header{background:#20314a;color:white;padding:24px}article{padding:35px}button{position:absolute;left:320px;top:280px;font:26px Arial;padding:15px;background:#315efb;color:white;border:0;border-radius:8px}aside{font:20px Arial;line-height:2;color:#536275}</style><header>MediaFlow Pro</header><article><h2>Qwen3 local recording</h2><aside>Project settings · Video timeline · Chinese subtitles<br>Real screen evidence · Audio mixing · Editable source</aside></article><button>Export video</button></html>`);
    for(let i=0;i<12;i++){
      await page.locator("button").evaluate((button,x)=>button.style.left=`${x}px`,i<6?320:320+(i-5)*45);
      await page.screenshot({path:path.join(project,"inputs",`frame-${String(i).padStart(2,"0")}.png`)});
    }
  }finally{await browser.close();}
  const voice=path.join(project,"inputs","speech.wav");
  const speechScript=path.join(project,"inputs","speech.ps1");
  fs.writeFileSync(speechScript,`$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Speech\n$s=New-Object System.Speech.Synthesis.SpeechSynthesizer\n$s.SetOutputToWaveFile('${voice.replaceAll("'","''")}')\n$s.Speak('Media Flow Pro. Click export video. The local recording stays editable.')\n$s.Dispose()\n`);
  const powershell=path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe");
  run(powershell,["-NoProfile","-File",speechScript],"generate-real-speech");
  const recording=path.join(project,"inputs","recording.mp4");
  run(local.ffmpeg,["-v","error","-framerate","1","-i",path.join(project,"inputs","frame-%02d.png"),"-i",voice,
    "-vf","fps=24","-af","apad","-t","12","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",recording],"generate-real-browser-recording");
  const microphone=path.join(project,"inputs","microphone.wav");
  run(local.ffmpeg,["-v","error","-i",voice,"-af","adelay=450:all=1,apad,atrim=duration=12","-ar","48000","-c:a","pcm_s16le",microphone],"generate-offset-microphone");
  importAsset(recording,"recording","video");importAsset(microphone,"microphone","audio");
  tools("analyze",["--source-id","recording","--language","en-US","--output","reports/screen.json"],"analyze-actual-screen");
  const report=readRecordingAnalysis(project,path.join(project,"reports/screen.json"));
  assert(report.vocabulary.includes("Qwen3"));
  assert.equal(locateRecordingTarget(report,"Export video",1,4).status,"stable");
  assert.equal(locateRecordingTarget(report,"Export video",7,10).status,"moving");
  const guide=tools("guide",["--analysis","reports/screen.json","--text","Export video","--label","Click Export",
    "--start","1","--end","4","--output","editable-media/export-guide"],"materialize-actual-guide");
  node("validate-editable-media.mjs",[guide.manifest],"validate-v6-guide");
  const overlay=path.join(project,"work","guide.mov");fs.mkdirSync(path.dirname(overlay),{recursive:true});
  node("render-web-media-local.mjs",["render","--package",guide.package,"--output",overlay,"--format","mov","--variant","source",
    "--fps","24","--ffmpeg",local.ffmpeg],"render-guide-from-v6-clock");
  const aligned=tools("align-audio",["--source-id","recording","--voice-source-id","microphone","--adopt-id","aligned-voice",
    "--output","work/aligned.wav"],"align-real-microphone");
  assert(Math.abs(aligned.alignment.offset_seconds-.45)<.025,JSON.stringify(aligned.alignment));
  tools("music",["--seconds","12","--output","work/music.wav","--adopt-id","bgm-code","--profile","tutorial_focused"],"generate-and-adopt-code-music");
  importAsset(overlay,"guide","video");
  const ledger=JSON.parse(fs.readFileSync(path.join(project,"media-sources.json")));
  const source=id=>ledger.sources.find(item=>item.id===id);
  const profileArgs=["--project",project];
  node("sound-production-profile.mjs",["create",...profileArgs,"--profile-id","recording-mix","--name","Recording mix","--scope","project"],"create-sound-profile");
  for(const [id,role,gain] of [["aligned-voice","voice-anchor","0"],["bgm-code","music","-14"]]){
    node("sound-production-profile.mjs",["add-cue",...profileArgs,"--cue-id",id,"--source-id",id,"--role",role,
      "--usage",role,"--gain-db",gain,"--loop","false"],`adopt-${role}`);
  }
  node("sound-production-profile.mjs",["set-ducking",...profileArgs,"--enabled","true","--trigger-role","voice-anchor",
    "--target-role","music","--reduction-db","8","--attack-ms","80","--release-ms","260"],"configure-ducking");
  const timeline={protocol:"visual-multimedia-timeline",version:1,project_id:path.basename(project),
    profile:{width:960,height:540,frame_rate:24,sample_rate:48000,channel_layout:"stereo",background:"#000000",duration_seconds:12},
    sources:["recording","aligned-voice","bgm-code","guide"].map(id=>({id,kind:id==="recording"||id==="guide"?"video":"audio",file:source(id).file,sha256:source(id).integrity.sha256,duration_seconds:id==="guide"?3:12})),
    tracks:[{id:"recording",kind:"video",name:"Recording",muted:false,clips:[{id:"recording",type:"media",source_id:"recording",timeline_start_seconds:0,source_in_seconds:0,duration_seconds:12,audio_enabled:false}]},
      {id:"guide",kind:"video",name:"Guide",muted:false,clips:[{id:"guide",type:"media",source_id:"guide",timeline_start_seconds:1,source_in_seconds:0,duration_seconds:3,audio_enabled:false}]},
      ...["aligned-voice","bgm-code"].map(id=>({id,kind:"audio",name:id,muted:false,clips:[{id,type:"media",source_id:id,timeline_start_seconds:0,source_in_seconds:0,duration_seconds:12,fade_out:{kind:"fade",duration_seconds:id==="bgm-code"?2:0}}]}))],subtitle_styles:[],markers:[]};
  write(path.join(project,"media-timeline.json"),timeline);
  const output=path.join(project,"output","local.mp4");
  node("media-timeline.mjs",["render","--timeline",path.join(project,"media-timeline.json"),"--output",output,
    "--ffmpeg",local.ffmpeg,"--ffprobe",local.ffprobe],"render-actual-mix");
  const rendered=JSON.parse(fs.readFileSync(`${output}.render.json`));
  assert(Math.abs(rendered.audio_mix.after.integrated_lufs+16)<=1);
  assert(rendered.audio_mix.after.true_peak_dbtp<=-.8);
  run(local.ffmpeg,["-v","error","-ss","2","-i",output,"-frames:v","1",path.join(project,"output","guide-frame.png")],"decode-final-guide-frame");
  // A heuristic only nominates a window; actual re-recognition uses the public ASR below.
  assert.equal(suspiciousWordSegments([{words:[{text:"啊",start_seconds:1,end_seconds:3}]}]).length,1);
  let transcription=null, native=null;
  if(process.argv.includes("--mediaflow")){
    nativeUsed=true;
    transcription=tools("transcribe",["--source-id","aligned-voice","--analysis","reports/screen.json","--language","en","--output","transcript.json"],"transcribe-real-aligned-voice");
    assert(transcription.word_count>0,"Public ASR must preserve actual word times");
    assert.equal(transcription.review_status,"pending");
    const transcript=JSON.parse(fs.readFileSync(path.join(project,"transcript.json")));
    assert.equal(transcript.source_sha256,source("aligned-voice").integrity.sha256);
    assert(transcript.segments.some(item=>/export/i.test(item.text)));
    const contract=assertMediaFlowProVideoCapabilities(environment);
    const {editorProject,inspected}=ensureMediaFlowProVideoProject(environment,contract,
      {name:taskId,directoryName:taskId,requestId:`${taskId}-create`},
      {width:960,height:540,fps:24,audio_sample_rate:48000,audio_channels:2});
    const sequenceId=inspected.project.main_sequence_id;
    // The assembly owns clip gains; the shared sound consumer owns ducking and mastering.
    const nativeTimeline=structuredClone(timeline);
    nativeTimeline.tracks.find(track=>track.id==="bgm-code").clips[0].gain_db=-14;
    const speechDuration=Number(JSON.parse(run(local.ffprobe,["-v","error","-show_entries","format=duration","-of","json",voice],"probe-real-speech-range")).format.duration);
    nativeTimeline.tracks.find(track=>track.id==="aligned-voice").clips[0].duration_seconds=Math.ceil(speechDuration*24)/24;
    const nativeInput=path.join(project,"native-timeline.json");
    nativeTimeline.tracks=nativeTimeline.tracks.filter(track=>track.id!=="guide");
    write(nativeInput,nativeTimeline);
    process.stderr.write("import-real-timeline-into-native-project\n");
    const imported=mediaFlowProExecute(environment,editorProject,"timeline.portable.import",
      {sequence_id:sequenceId,timeline_path:nativeInput},`${taskId}-timeline-import`);
    const audio=mediaFlowProExecute(environment,editorProject,"audio.inspect",{sequence_id:sequenceId});
    const busMap={master:audio.buses.find(bus=>bus.parent_bus_id===null).id};
    for(const [trackId,role] of [["aligned-voice","voice-anchor"],["bgm-code","music"]]) {
      const nativeTrack=imported.timeline.tracks.find(track=>track.name===trackId);
      assert(nativeTrack,`Actual ${trackId} track is required`);
      const bus=mediaFlowProExecute(environment,editorProject,"audio.bus.add",{sequence_id:sequenceId,
        name:role,parent_bus_id:busMap.master},`${taskId}-${role}-bus`).bus;
      mediaFlowProExecute(environment,editorProject,"timeline.track.audio.route",{sequence_id:sequenceId,
        track_id:nativeTrack.id,bus_id:bus.id},`${taskId}-${role}-route`);
      busMap[role]=bus.id;
    }
    write(path.join(project,"reports","audio-buses.json"),busMap);
    const sound=tools("apply-sound",["--native-project",editorProject,"--bus-map","reports/audio-buses.json"],"apply-profile-through-public-audio-api");
    assert(sound.after.buses.find(bus=>bus.id===busMap.music).effects.some(effect=>effect.kind==="ducking"));
    const nativeGuide=path.join(project,"output","native-guide.mkv");
    const web=exportEditableWebScene({environment,editorProject,projectId:taskId,unitId:"guide",
      packageRoot:guide.package,durationFrames:72,timelineStart:24,outputPath:nativeGuide,background:"#00000000",
      format:"alpha_video",requestKey:"actual-v6",trackName:"Editable guide"});
    assert(web.sourceHash);
    const nativeOutput=path.join(project,"output","native.mp4");
    process.stderr.write("export-real-native-sequence\n");
    const exported=mediaFlowProExecute(environment,editorProject,"export.sequence",{sequence_id:sequenceId,
      output_path:nativeOutput,format:"h264",preset:{name:"Recording verification",format:"h264",container:"mp4",
        encoder_policy:{mode:"software",vendor:"auto"},audio_codec:"aac",pixel_format:"yuv420p"},overwrite:false,timeout:600},`${taskId}-export`);
    const exportTask=mediaFlowProWaitForTask(environment,editorProject,exported,600);
    assert.equal(exportTask.outcome.outcome_type,"export");
    run(local.ffmpeg,["-v","error","-ss","2","-i",nativeOutput,"-frames:v","1",path.join(project,"output","native-frame.png")],"decode-native-final-guide-frame");
    const settings=JSON.parse(fs.readFileSync(path.join(project,"sound-profile.json"))).mix.loudness;
    const measured=measureMix(local.ffmpeg,nativeOutput,(exe,args)=>{
      const result=spawnSync(exe,args,{encoding:"utf8",windowsHide:true,maxBuffer:64*1024*1024});
      assert.equal(result.status,0,result.stderr);return result;
    },settings);
    assert(Math.abs(measured.integrated_lufs-settings.target_lufs)<=1,JSON.stringify(measured));
    assert(measured.true_peak_dbtp<=settings.true_peak_dbfs+.2,JSON.stringify(measured));
    native={project:editorProject,output:nativeOutput,web_source_hash:web.sourceHash,audio_mix:measured};
  }
  const result={project,output,analysis:path.join(project,"reports/screen.json"),guide:guide.package,
    alignment:aligned.alignment.offset_seconds,audio_mix:rendered.audio_mix,transcription,native,
    material:"actual browser screenshots and Windows speech, generated for technical verification"};
  write(path.join(project,"verification.json"),result);
  finalizeTaskWorkspace(taskId,"completed");console.log(JSON.stringify(result,null,2));
}

try{await main();}catch(error){finalizeTaskWorkspace(taskId,"failed");console.error(error.stack);process.exitCode=1;}
finally{
  if(nativeUsed && environment.providers.mediaflow){
    const provider=environment.providers.mediaflow;
    const ended=spawnSync(provider.python,["-m","mediaflow.cli","service","shutdown"],{cwd:provider.sourceRoot,
      env:{...childEnvironment,MEDIAFLOW_SERVICE_SETTINGS_PATH:provider.serviceSettingsPath},encoding:"utf8",windowsHide:true});
    fs.writeFileSync(path.join(project,"logs","editor-service-shutdown.log"),`${ended.stdout}\n${ended.stderr}`);
    if(ended.status!==0){console.error("Test-owned Editor Service shutdown was not confirmed");process.exitCode=1;}
  }
}
