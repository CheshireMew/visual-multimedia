import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {assertSkillTaskPath} from "./media-task-workspace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const normalize = text => text.toLocaleLowerCase().replace(/\s+/gu, "");

export function readRecordingAnalysis(project, file) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  assertJsonSchema(report, path.join(ROOT, "schemas/recording-analysis.v1.schema.json"), "录屏分析");
  const ledger=JSON.parse(fs.readFileSync(path.join(project,"media-sources.json"),"utf8"));
  const original=ledger.sources.find(source=>source.id===report.source_id);
  if (!original || original.representation.kind!=="source" || original.file!==report.source.file
      || original.integrity.sha256!==report.source.sha256) {
    throw new Error("录屏分析与当前素材账本中的原片不一致");
  }
  for (const binding of [report.source, ...report.frames.map(row => row.image)]) {
    const target = path.resolve(project, binding.file);
    if (!target.startsWith(path.resolve(project) + path.sep) || sha(target) !== binding.sha256) {
      throw new Error(`录屏分析已过期或引用错误：${binding.file}`);
    }
  }
  return report;
}

export function locateRecordingTarget(report, text, start, end, maximumDrift = .25) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > report.duration_seconds) {
    throw new Error("指引时间必须位于真实录屏范围");
  }
  const frames = report.frames.filter(row => row.t >= start - .5/report.sample_fps && row.t <= end + .5/report.sample_fps);
  const hits = frames.map(frame => ({t: frame.t, matches: frame.items.filter(item => normalize(item.text).includes(normalize(text)))}));
  if (hits.length < 2 || hits.some(hit => hit.matches.length !== 1)) {
    return {status: "unresolved", reason: "目标缺失、同名目标不唯一或采样不足", hits};
  }
  const boxes = hits.map(hit => hit.matches[0].box);
  if (frames.some(frame => frame.motion && !frame.stable)) {
    return {status:"moving", reason:"采样区间存在镜头位移或缩放", hits};
  }
  const centers = boxes.map(([x,y,w,h]) => [x+w/2,y+h/2]);
  const drift = Math.max(...[0,1].map(axis => Math.max(...centers.map(point=>point[axis]))-Math.min(...centers.map(point=>point[axis]))));
  const width = Math.max(...boxes.map(box=>box[2]));
  if (drift > Math.max(.01, width*maximumDrift)) return {status: "moving", drift, hits};
  const x = Math.max(0, Math.min(...boxes.map(box=>box[0]))-.012);
  const y = Math.max(0, Math.min(...boxes.map(box=>box[1]))-.012);
  const right = Math.min(1, Math.max(...boxes.map(box=>box[0]+box[2]))+.012);
  const bottom = Math.min(1, Math.max(...boxes.map(box=>box[1]+box[3]))+.012);
  return {status: "stable", drift, target: {x,y,w:right-x,h:bottom-y}, hits,
    warnings: bottom>.76 ? ["指引进入字幕区域，需检查实际合成画面"] : []};
}

export function materializeRecordingGuidance({report, location, output, text, duration, color = "#315EFB"}) {
  if (location.status !== "stable") throw new Error("不能给未定位或移动目标生成固定指示框");
  output = assertSkillTaskPath(output);
  if (fs.existsSync(output)) throw new Error(`覆盖层目录已经存在：${output}`);
  const {width, height} = report;
  const target = location.target;
  const bounds = {x:Math.round(target.x*width), y:Math.round(target.y*height), width:Math.round(target.w*width), height:Math.round(target.h*height), rotation:0};
  const label = {x:Math.max(8,Math.min(bounds.x,width-280)), y:Math.max(8,bounds.y-45), width:Math.min(280,width-16), height:36, rotation:0};
  const geometry = Object.entries({target:bounds,label}).map(([id,b])=>`#${id}{left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px}`).join("");
  const layer = (id,kind,b) => ({id,name:id,kind,selector:`[data-editable-id='${id}']`,default_bounds:b,editable:["x","y","width","height","visible","opacity",...(kind==="text"?["content","color","font_size"]:[])],constraints:{}});
  const manifest = {
    protocol:"editable-media",version:6,entry:"index.html",media_sources:"media-sources.json",
    playback:{mode:"autoplay",fps:30,loop:"none",controls:{keyboard:false,wheel:false,touch:false,overview:false}},
    accessibility:{title_data_field:"title",canvas_selector:"#mediaCanvas"},
    component:{id:"screen-guidance",name:"真实录屏界面指引",category:"overlays",tags:["screen","callout"]},
    layers:[layer("target","shape",bounds),layer("label","text",label)],
    theme_variables:[{id:"accent",name:"Accent",kind:"color",css_variable:"--accent",default:color}],parameters:[],
    data_fields:[{id:"title",name:"Label",kind:"string",default:text}],
    scenes:[{id:"guidance",name:"界面指引",page_role:"explanation",content_shape:"screen-target",layout_id:"screen-target",
      duration_ms:Math.round(duration*1000),primary_blocks:1,
      steps:[{id:"enter",at_ms:0,label:"进入",state_kind:"start",review:true,description:"指引进入"},
             {id:"hold",at_ms:Math.min(150,Math.floor(duration*500)),label:"定位",state_kind:"result",review:true,description:"定位实际屏幕目标"}],
      motion:{complexity:"simple",driver:"object",semantic_purpose:"引导观众找到正在讲述的界面对象",key_state_review:"none",camera:null},
      parameters:{},data:{title:text},asset_slots:{}}],
    layout_contracts:[{id:"screen-target",name:"Screen target",page_roles:["explanation"],content_shapes:["screen-target"],
      required_data_fields:["title"],required_layer_ids:["target","label"],title_layer_ids:["label"],content_layer_ids:["target"],
      capacity:{maximum_primary_blocks:1},asset_slots:[]}],
    variants:[{id:"source",name:"Source",canvas:{width,height,background_mode:"transparent",background_color:"#000000"},layers:{}}],
    default_variant_id:"source",quality:{canvas_selector:"#mediaCanvas",roundtrip:{data_field:"title",layer_id:"label"},
      required_layer_ids:["target","label"],bounds_tolerance_px:1,minimum_font_px:{label:18}},
    delivery:{preview:"local-server",remote_dependencies:"forbid"},resources:["editable-media-runtime.js"],
    frame_readiness:{default_timeout_ms:10000,maximum_timeout_ms:30000,retry_limit:1},
  };
  assertJsonSchema(manifest, path.join(ROOT,"schemas/editable-media.v6.schema.json"), "录屏覆盖层");
  fs.mkdirSync(output,{recursive:true});
  fs.copyFileSync(path.join(ROOT,"assets/web-media-starter/editable-media-runtime.js"),path.join(output,"editable-media-runtime.js"));
  fs.writeFileSync(path.join(output,"editable-media.json"),JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(output,"media-sources.json"),JSON.stringify({protocol:"visual-multimedia-media-sources",version:4,sources:[]}));
  fs.writeFileSync(path.join(output,"index.html"),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>界面指引</title>
<style>*{box-sizing:border-box}html,body{margin:0;background:transparent}#mediaCanvas{position:relative;overflow:hidden;width:${width}px;height:${height}px;background:transparent}.layer{position:absolute}${geometry}#target{border:3px solid var(--accent);border-radius:8px}#target::after{content:"";position:absolute;left:-22px;top:50%;border-left:14px solid var(--accent);border-top:8px solid transparent;border-bottom:8px solid transparent;transform:translateY(-50%)}#label{font:600 20px "Microsoft YaHei",sans-serif;color:white;background:var(--accent);border-radius:6px;padding:4px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style>
<body><main id="mediaCanvas" class="media-canvas" data-editable-media-root data-composition-id="editable-media" data-no-timeline data-start="0" data-duration="${manifest.scenes[0].duration_ms/1000}" data-width="${width}" data-height="${height}" data-fps="30"><div id="motion"><div id="target" class="layer" data-editable-id="target"></div><div id="label" class="layer" data-editable-id="label" data-editable-data="title"></div></div></main>
<script src="editable-media-runtime.js"></script><script>window.addEventListener('editablemediatime',e=>{const p=e.detail,fade=Math.min(150,p.sceneDurationMs/2);document.querySelector('#motion').style.opacity=Math.max(0,Math.min(1,p.localTimeMs/fade,(p.sceneDurationMs-p.localTimeMs)/fade));});</script></body></html>`);
  return {package:output,manifest:path.join(output,"editable-media.json"),target:location.target};
}
