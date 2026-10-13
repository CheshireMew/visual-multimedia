#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {ensureTaskWorkspace, resolveTaskPath, finalizeTaskWorkspace} from "./media-task-workspace.mjs";
import {loadLocalMediaEnvironment} from "./local-media-environment.mjs";
import {assertJsonSchema} from "./json_schema_contract.mjs";
import {validatePrices, prepareSeries, dateLabel, amountLabel, spaceMixedText} from "../assets/price-history-video/price-history-math.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const write = (file, document) => fs.writeFileSync(file, `${JSON.stringify(document,null,2)}\n`, "utf8");
const read = file => JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/u,""));
function run(command,args,cwd=ROOT) {
  const result = spawnSync(command,args,{cwd,encoding:"utf8",windowsHide:true,maxBuffer:16*1024*1024});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function argsOf(argv) {
  const args={};
  for (let i=0;i<argv.length;i+=1) {
    if (!argv[i].startsWith("--")) throw new Error(`Unexpected argument: ${argv[i]}`);
    const key=argv[i].slice(2);
    if (key==="overwrite") args[key]=true;
    else { if (!argv[i+1] || argv[i+1].startsWith("--")) throw new Error(`Missing --${key} value`); args[key]=argv[++i]; }
  }
  return args;
}
function required(args,key) { if (!args[key]) throw new Error(`Missing --${key}`); return args[key]; }
function parameter(id,label,value,unit,minimum,maximum) {
  return {descriptor:{id,label,description:label,group:"价格回放",kind:"number",control:"number",default:value,unit,
    constraints:{minimum,maximum,step:unit==="seconds"?.1:1},options_source:null,timeline:"none"},binding:{scope:"global",css_variable:null}};
}

export function createPackage(args) {
  const id=required(args,"task-id");
  ensureTaskWorkspace(id,512*1024*1024);
  const project=resolveTaskPath(id);
  const input=path.resolve(required(args,"input"));
  const snapshot=read(input);
  if (snapshot.protocol!=="visual-multimedia-price-history" || snapshot.version!==1 || !snapshot.source?.url
    || !snapshot.symbol || !snapshot.quote_currency || !snapshot.price_basis || !snapshot.timezone) {
    throw new Error("价格快照缺少来源、币种、报价单位、价格口径或时区");
  }
  const start=args["start-date"] ? Date.parse(`${args["start-date"]}T00:00:00Z`) : -Infinity;
  const end=args["end-date"] ? Date.parse(`${args["end-date"]}T00:00:00Z`)+86400000 : Infinity;
  if (Number.isNaN(start)||Number.isNaN(end)||start>=end) throw new Error("日期范围无效");
  const all=snapshot.rows.map(row=>({timestamp:row[0],close:row[4]}));
  validatePrices(all);
  const prices=all.filter(point=>point.timestamp>=start && point.timestamp<end);
  validatePrices(prices);
  const duration=Number(args.duration||59), principal=Number(args.principal||1e6), windowDays=Number(args["window-days"]||730);
  const hold=Math.min(Number(args["hold-seconds"]||4),duration/2);
  if (!Number.isFinite(duration)||duration<2||duration>3600||!Number.isFinite(hold)||hold<0) throw new Error("时长无效");
  const series=prepareSeries(prices,principal,windowDays);
  const packageRoot=resolveTaskPath(id,"web");
  if (fs.existsSync(packageRoot) && !args.overwrite) throw new Error("网页包已存在；使用 --overwrite 明确覆盖");
  fs.mkdirSync(packageRoot,{recursive:true});
  for (const name of ["index.html","price-history-math.mjs","price-history-renderer.mjs"]) {
    fs.copyFileSync(path.join(ROOT,"assets/price-history-video",name),path.join(packageRoot,name));
  }
  for (const name of ["editable-media-runtime.js","editable-media-editor.js","editable-media-editor.css"]) {
    fs.copyFileSync(path.join(ROOT,"assets/web-media-starter",name),path.join(packageRoot,name));
  }
  fs.copyFileSync(input,path.join(packageRoot,"price-history.json"));
  const assetName=args["asset-name"]||snapshot.asset_name||snapshot.symbol.split("/")[0];
  const displayCurrency=args["display-currency"]||snapshot.quote_currency;
  const sourceName=snapshot.source.exchange==="binance" ? "币安" : snapshot.source.provider;
  const displayBasis=snapshot.quote_currency==="USDT" && ["美元","USD"].includes(displayCurrency)
    ? "金额按 1 USDT = 1 美元展示" : `报价单位 ${snapshot.quote_currency}`;
  const footer=`数据：${sourceName} · ${assetName} · ${snapshot.timezone} 日收盘价 · ${dateLabel(prices[0].timestamp)} — ${dateLabel(prices.at(-1).timestamp)}\n按首日收盘价买入并全程持有；不计手续费、滑点和税费；${displayBasis}`;
  const title=spaceMixedText((args.title||"假如你在{start_year}年买入{principal}的{asset}")
    .replaceAll("{start_year}",dateLabel(prices[0].timestamp).slice(0,4)).replaceAll("{principal}",amountLabel(principal,displayCurrency)).replaceAll("{asset}",assetName));
  const data={title,footer,
    asset_name:assetName,display_currency:displayCurrency,prices};
  const definitions=[
    ["title","标题","text",[120,64,1680,90],54],
    ["metrics","持仓数值","group",[1280,180,530,210],null],
    ["chart","连续走势图","component",[45,350,1830,575],null],
    ["footer","来源与计算口径","text",[160,978,1600,67],17],
    ["summary","最终汇总","group",[370,380,1180,400],null],
  ];
  const layers=definitions.map(([id,name,kind,bounds,font])=>({id,name,kind,selector:`[data-editable-id='${id}']`,
    default_bounds:{x:bounds[0],y:bounds[1],width:bounds[2],height:bounds[3],rotation:0},
    editable:[...(kind==="text"?["content","color","font_family","font_size"]:[]),"x","y","width","height","rotation","opacity","z_index","visible"],constraints:font?{font_size:{minimum:12,maximum:120,step:1}}:{}}));
  const persistentLayerIds=layers.filter(layer=>layer.id!=="summary").map(layer=>layer.id);
  const layerState=Object.fromEntries(definitions.map(([id,,kind,b,font])=>[id,{x:b[0],y:b[1],width:b[2],height:b[3],rotation:0,opacity:1,z_index:id==="summary"?20:1,visible:true,...(font?{font_size:font}:{})}]));
  fs.writeFileSync(path.join(packageRoot,"price-history-layout.css"),definitions.map(([id,,kind,b,font])=>
    `[data-editable-id='${id}']{left:${b[0]}px;top:${b[1]}px;width:${b[2]}px;height:${b[3]}px;z-index:${id==="summary"?20:1};${font?`font-size:${font}px;`:""}}`).join("\n"));
  const htmlPath=path.join(packageRoot,"index.html");
  fs.writeFileSync(htmlPath,fs.readFileSync(htmlPath,"utf8").replace('data-duration="59"',`data-duration="${duration}"`));
  const movingSeconds=duration-hold;
  const timestampToSeconds=timestamp=>(timestamp-prices[0].timestamp)/(prices.at(-1).timestamp-prices[0].timestamp)*movingSeconds;
  const afterPeak=series.values.slice(series.peakIndex);
  const troughIndex=series.peakIndex+afterPeak.indexOf(Math.min(...afterPeak));
  const step=(id,seconds,kind,label)=>({id,at_ms:Math.round(seconds*1000),label,state_kind:kind,review:true,description:label});
  const steps=[step("start",0,"start","首日买入"),step("peak",timestampToSeconds(prices[series.peakIndex].timestamp),"change","历史最高持仓价值"),
    step("drawdown",timestampToSeconds(prices[troughIndex].timestamp),"change","高点后的最低持仓价值"),
    step("last-close",movingSeconds,"result","最新完整日收盘结果"),step("summary",Math.min(duration-.05,movingSeconds+.9),"hold","最终汇总")]
    .sort((a,b)=>a.at_ms-b.at_ms).filter((item,i,items)=>!i||item.at_ms!==items[i-1].at_ms);
  const manifest={
    protocol:"editable-media",version:6,entry:"index.html",media_sources:"media-sources.json",
    playback:{mode:"autoplay",fps:30,loop:"none",controls:{keyboard:true,wheel:false,touch:false,overview:false}},
    frame_readiness:{default_timeout_ms:10000,maximum_timeout_ms:30000,retry_limit:1},
    accessibility:{title_data_field:"title",canvas_selector:"#mediaCanvas"},layers,
    component:{id:"price-history",name:"历史价格回放",category:"data",tags:["price-history","buy-and-hold"]},
    theme_variables:Object.entries({background:"#080f12",text:"#f4f6f5",muted:"#899498",line:"#1a2529",accent:args.accent||"#96ed00",negative:"#ff7979"}).map(([id,value])=>({id,name:id,kind:"color",css_variable:`--${id}`,default:value})),
    parameters:[parameter("principal","初始本金",principal,displayCurrency,.01,1e15),parameter("window_days","可见历史窗口",windowDays,"days",1,36500),parameter("end_hold_seconds","结尾汇总停留",hold,"seconds",0,duration/2)],
    scenes:[{id:"history",name:"价格历史",page_role:"data-replay",content_shape:"continuous-price-series",layout_id:"price-replay",duration_ms:Math.round(duration*1000),primary_blocks:1,steps,
      motion:{complexity:"complex",driver:"object",semantic_purpose:"连续历史价格推动曲线、日期、资产价值、收益率和坐标范围",key_state_review:"required",camera:null},parameters:{},data,asset_slots:{}}],
    layout_contracts:[{id:"price-replay",name:"连续价格回放",page_roles:["data-replay"],content_shapes:["continuous-price-series"],required_data_fields:["title","prices","display_currency"],required_layer_ids:persistentLayerIds,title_layer_ids:["title"],content_layer_ids:["metrics","chart","footer"],capacity:{maximum_primary_blocks:1},asset_slots:[]}],
    variants:[{id:"landscape",name:"1080p 横版",canvas:{width:1920,height:1080,background_mode:"opaque",background_color:"#080f12"},layers:layerState}],default_variant_id:"landscape",
    data_fields:[{id:"title",name:"标题",kind:"string",default:data.title},{id:"footer",name:"来源与计算口径",kind:"string",default:data.footer},{id:"asset_name",name:"资产名称",kind:"string",default:assetName},{id:"display_currency",name:"显示货币",kind:"string",default:data.display_currency},
      {id:"prices",name:"真实收盘价格",kind:"table",default:prices,columns:[{id:"timestamp",name:"UTC 时间戳（毫秒）",kind:"number"},{id:"close",name:"收盘价",kind:"number"}]}],
    quality:{canvas_selector:"#mediaCanvas",roundtrip:{data_field:"title",layer_id:"title"},required_layer_ids:persistentLayerIds,bounds_tolerance_px:1,minimum_font_px:{title:24,footer:12},minimum_gaps:[{above:"title",below:"chart",min_px:40}],navigation_safe_area:{bottom:24,layer_ids:["title","metrics","chart","footer"]}},
    delivery:{preview:"local-server",remote_dependencies:"forbid"},resources:["editable-media-runtime.js","editable-media-editor.js","editable-media-editor.css","price-history-renderer.mjs","price-history-math.mjs","price-history-layout.css","price-history.json"]};
  assertJsonSchema(manifest,path.join(ROOT,"schemas/editable-media.v6.schema.json"),"price-history editable-media");
  write(path.join(packageRoot,"editable-media.json"),manifest);
  write(path.join(packageRoot,"media-sources.json"),{protocol:"visual-multimedia-media-sources",version:4,sources:[]});
  fs.mkdirSync(path.join(project,"reports"),{recursive:true});
  const report={protocol:"visual-multimedia-price-history-build",version:1,source_snapshot:input,source_sha256:hash(input),source:snapshot.source,
    package:packageRoot,first_date:dateLabel(prices[0].timestamp),last_date:dateLabel(prices.at(-1).timestamp),candles:prices.length,
    principal,quote_currency:snapshot.quote_currency,display_currency:displayCurrency,display_basis:displayBasis,first_close:prices[0].close,last_close:prices.at(-1).close,units:series.units,
    final_value:series.finalValue,return_pct:series.returnPct,peak_value:series.maximum,peak_date:dateLabel(prices[series.peakIndex].timestamp),
    calculation:"units = principal / first_close; value = units * close; return_pct = (close / first_close - 1) * 100",
    timeline_seconds:duration,window_days:windowDays,fees_included:false};
  write(path.join(project,"reports/price-history-build.json"),report);
  return report;
}

function renderProject(args) {
  const id=required(args,"task-id"), project=resolveTaskPath(id);
  const web=path.join(project,"web"), manifest=read(path.join(web,"editable-media.json"));
  const local=loadLocalMediaEnvironment().providers.local;
  const duration=manifest.scenes.reduce((sum,s)=>sum+s.duration_ms,0)/1000;
  const video=path.join(project,"price-history-silent.mp4"), output=path.join(project,"price-history.mp4");
  const renderArgs=[path.join(ROOT,"scripts/render-web-media-local.mjs"),"render","--package",web,"--output",video,"--ffmpeg",local.ffmpeg,"--browser",local.browser];
  if (args.overwrite) renderArgs.push("--overwrite");
  const rendered=JSON.parse(run(process.execPath,renderArgs));
  if (!args["bgm-source"]) return rendered;
  if (args["bgm-gain-db"]===undefined || !Number.isFinite(Number(args["bgm-gain-db"]))) throw new Error("配乐增益必须按本次实测传入 --bgm-gain-db");
  const ledger=read(path.join(project,"media-sources.json"));
  const music=ledger.sources.find(s=>s.id===args["bgm-source"]);
  if (!music || music.media_type!=="audio" || music.rights.status!=="confirmed") throw new Error("配乐必须已入账且权利已确认");
  const musicFile=path.resolve(project,music.file);
  if (hash(musicFile)!==music.integrity.sha256) throw new Error("配乐哈希与素材账本不符");
  const probe=JSON.parse(run(local.ffprobe,["-v","error","-show_format","-of","json",musicFile]));
  const audioDuration=Number(probe.format.duration), audioIn=Number(args["bgm-in-seconds"]||0);
  if (!(audioIn>=0 && audioDuration-audioIn>=duration)) throw new Error("所选配乐区间短于成片；请选足够长的真实音乐区间");
  const timeline={protocol:"visual-multimedia-timeline",version:1,project_id:id,
    profile:{width:1920,height:1080,frame_rate:30,sample_rate:48000,channel_layout:"stereo",background:"#080f12",duration_seconds:duration},
    sources:[{id:"price-chart",kind:"web-render",file:path.basename(video),sha256:hash(video),duration_seconds:duration},
      {id:music.id,kind:"audio",file:music.file,sha256:hash(musicFile),duration_seconds:audioDuration}],
    subtitle_styles:[],markers:[],
    tracks:[{id:"video",kind:"video",name:"历史价格动画",muted:false,clips:[{id:"chart",type:"media",source_id:"price-chart",timeline_start_seconds:0,source_in_seconds:0,duration_seconds:duration,speed:1,placement:{fit:"contain",x:0,y:0,width:1920,height:1080},opacity:1,audio_enabled:false,fade_in:{kind:"none",duration_seconds:0},fade_out:{kind:"none",duration_seconds:0}}]},
      {id:"music",kind:"audio",name:"背景音乐",muted:false,clips:[{id:"bgm",type:"media",source_id:music.id,timeline_start_seconds:0,source_in_seconds:audioIn,duration_seconds:duration,speed:1,gain_db:Number(args["bgm-gain-db"]),fade_in:{kind:"fade",duration_seconds:.6},fade_out:{kind:"fade",duration_seconds:2}}]}]};
  const timelinePath=path.join(project,"media-timeline.json");
  write(timelinePath,timeline);
  const command=[path.join(ROOT,"scripts/media-timeline.mjs"),"render","--timeline",timelinePath,"--output",output,"--ffmpeg",local.ffmpeg,"--ffprobe",local.ffprobe];
  if (args.overwrite) command.push("--overwrite");
  const result=JSON.parse(run(process.execPath,command));
  return {...result,web_source:web,music_source:music.id};
}

if (process.argv[1] && path.resolve(process.argv[1])===SCRIPT) {
  try {
    const [command,...rest]=process.argv.slice(2);
    if (!command || command==="--help" || command==="help") {
      console.log("create --task-id <id> --input <price-history.json> [--principal 1000000 --duration 59 --window-days 730 --start-date YYYY-MM-DD --end-date YYYY-MM-DD --asset-name UNI --display-currency <显示货币> --title <text> --accent <color> --overwrite]\nrender --task-id <id> [--bgm-source <ledger-id> --bgm-gain-db <measured-gain> --bgm-in-seconds 0 --overwrite]");
    } else {
      const args=argsOf(rest);
      if (!new Set(["create","render"]).has(command)) throw new Error(`Unknown command: ${command}`);
      const result=command==="create"?createPackage(args):renderProject(args);
      if (command==="render") finalizeTaskWorkspace(args["task-id"],"completed");
      console.log(JSON.stringify({ok:true,...result},null,2));
    }
  } catch (error) { console.error(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; }
}
