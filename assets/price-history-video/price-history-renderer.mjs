import {prepareSeries, frameState, dateLabel, amountLabel, spaceMixedText} from "./price-history-math.mjs";

const svg = document.querySelector(".chart svg");
const title = document.querySelector("h1");
const metrics = document.querySelector(".metrics");
const summary = document.querySelector(".summary");
const NS = "http://www.w3.org/2000/svg";
let cacheKey = "", series;
function tag(name, attributes = {}, text = "") {
  const node = document.createElementNS(NS, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text) node.textContent = text;
  return node;
}
function percentage(value) { return `${value >= 0 ? "+" : ""}${value.toLocaleString("en-US", {minimumFractionDigits:2,maximumFractionDigits:2})}%`; }

function render(seconds) {
  if (!window.editableMedia?.getManifest()) return;
  const state = window.editableMedia.getState();
  const data = state.scenes[state.scene_id].data;
  const parameters = window.editableMedia.getParameters();
  const principal = Number(parameters.principal);
  const windowDays = Number(parameters.window_days);
  const key = JSON.stringify([data.prices, principal, windowDays]);
  if (key !== cacheKey) { series = prepareSeries(data.prices, principal, windowDays); cacheKey = key; }
  const duration = window.__hf.duration;
  const frame = frameState(series, seconds, duration, Number(parameters.end_hold_seconds));
  const currency = data.display_currency;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const muted = css.getPropertyValue("--muted").trim();
  const line = css.getPropertyValue("--line").trim();
  const negative = css.getPropertyValue("--negative").trim();
  const manifest = window.editableMedia.getManifest();
  let headline = (state.scenes[state.scene_id].layers.title?.content ?? data.title)
    .replaceAll("{principal}", amountLabel(principal, currency))
    .replaceAll("{start_year}", dateLabel(series.prices[0].timestamp).slice(0,4))
    .replaceAll("{asset}", data.asset_name);
  const basePrincipal=manifest.parameters.find(p=>p.descriptor.id==="principal").descriptor.default;
  if (headline===manifest.scenes[0].data.title) headline=headline.replace(amountLabel(basePrincipal,currency),amountLabel(principal,currency));
  headline=spaceMixedText(headline);
  const split = headline.split(data.asset_name);
  title.replaceChildren();
  split.forEach((part, i) => {
    if (i) { const emphasis = document.createElement("em"); emphasis.textContent = data.asset_name; title.append(emphasis); }
    title.append(document.createTextNode(part));
  });
  metrics.querySelector(".caption").textContent = spaceMixedText(`${amountLabel(principal, currency)}全程持有`);
  metrics.querySelector(".value").textContent = amountLabel(frame.value, "").trim();
  metrics.querySelector(".return").textContent = percentage(frame.returnPct);
  metrics.querySelector(".return").style.color = frame.returnPct >= 0 ? accent : negative;
  metrics.querySelector(".date").textContent = dateLabel(frame.timestamp);
  const width = document.querySelector(".chart").clientWidth;
  const height = document.querySelector(".chart").clientHeight;
  const left = 108, right = width - 260, top = 40, bottom = height - 72;
  const x = (timestamp) => left + (timestamp - frame.leftTime) / (frame.rightTime - frame.leftTime) * (right - left);
  const y = (value) => bottom - value / frame.top * (bottom - top);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const defs = tag("defs");
  const gradient = tag("linearGradient", {id:"area",x1:0,y1:0,x2:0,y2:1});
  gradient.append(tag("stop",{offset:"0%","stop-color":accent,"stop-opacity":.16}),tag("stop",{offset:"100%","stop-color":accent,"stop-opacity":0}));
  const glow = tag("filter",{id:"glow",x:"-20%",y:"-50%",width:"140%",height:"200%"});
  glow.append(tag("feGaussianBlur",{stdDeviation:3}));
  const clip = tag("clipPath",{id:"plot-clip"}); clip.append(tag("rect",{x:left,y:top-10,width:right-left,height:bottom-top+20}));
  defs.append(gradient,glow,clip); svg.append(defs);
  for (let i = 0; i <= 4; i += 1) {
    const value = frame.top * i / 4, yy = y(value);
    svg.append(tag("line",{x1:left,x2:right,y1:yy,y2:yy,stroke:line,"stroke-width":1}),
      tag("text",{x:left-16,y:yy+6,fill:muted,"font-size":20,"text-anchor":"end"},amountLabel(value,"",true).trim()));
  }
  svg.append(tag("text",{x:left-16,y:top-17,fill:muted,"font-size":18,"text-anchor":"end"},currency));
  const dates = [];
  for (let i = 0; i < 4; i += 1) {
    const timestamp = frame.leftTime + (frame.rightTime-frame.leftTime)*i/4;
    // Future axis labels are hidden during the opening; the curve never uses future points.
    if (timestamp > frame.timestamp || Math.abs(x(timestamp)-x(frame.timestamp))<160) continue;
    dates.push(timestamp);
    svg.append(tag("text",{x:x(timestamp),y:bottom+45,fill:muted,"font-size":20,"text-anchor":"middle"},dateLabel(timestamp).slice(0,7)));
  }
  const coords = series.prices.slice(frame.firstIndex,frame.index+1).map((p,i)=>[x(p.timestamp),y(series.values[frame.firstIndex+i])]);
  const d = coords.map(([xx,yy],i)=>`${i ? "L" : "M"}${xx.toFixed(3)},${yy.toFixed(3)}`).join(" ");
  const group = tag("g",{"clip-path":"url(#plot-clip)"});
  if (coords.length) {
    group.append(tag("path",{d:`${d} L${coords.at(-1)[0]},${bottom} L${coords[0][0]},${bottom} Z`,fill:"url(#area)"}),
      tag("path",{d,stroke:accent,"stroke-width":7,fill:"none",filter:"url(#glow)",opacity:.38}),
      tag("path",{d,stroke:accent,"stroke-width":2.7,fill:"none","stroke-linejoin":"round","stroke-linecap":"round"}));
  }
  const xx = x(frame.timestamp), yy = y(frame.value);
  group.append(tag("circle",{cx:xx,cy:yy,r:7,fill:accent})); svg.append(group);
  svg.append(tag("text",{x:Math.min(right+16,xx+20),y:yy+9,fill:"#f4f6f5","font-size":29,"font-weight":700},amountLabel(frame.value,"",true).trim()));
  const stampX = Math.min(right-70,Math.max(left+70,xx));
  svg.append(tag("rect",{x:stampX-70,y:bottom+19,width:140,height:37,rx:6,fill:accent}),
    tag("text",{x:stampX,y:bottom+45,fill:"#080f12","font-size":20,"font-weight":700,"text-anchor":"middle"},dateLabel(frame.timestamp)));
  document.querySelector(".chart").style.opacity = 1 - frame.summaryOpacity * .64;
  metrics.style.opacity = 1 - frame.summaryOpacity * .7;
  summary.style.opacity = frame.summaryOpacity;
  summary.style.visibility = frame.summaryOpacity > 0 ? "visible" : "hidden";
  summary.querySelector(".label").textContent = `${amountLabel(principal,currency)}，${dateLabel(series.prices[0].timestamp)} 买入后持有`;
  summary.querySelector(".value").textContent = amountLabel(series.finalValue,currency);
  summary.querySelector(".return").textContent = `收益率 ${percentage(series.returnPct)}`;
  summary.querySelector(".return").style.color = series.returnPct >= 0 ? accent : negative;
  summary.querySelector(".detail").textContent = `截至 ${dateLabel(series.prices.at(-1).timestamp)}　｜　期间最高 ${amountLabel(series.maximum,currency)}`;
  document.querySelector("#seek").max = duration;
  document.querySelector("#seek").value = seconds;
  document.querySelector("#time").textContent = `${seconds.toFixed(1)} / ${duration.toFixed(0)} s`;
  // Diagnostic attributes describe this frame; production state remains editableMedia.
  svg.dataset.candleIndex = frame.index; svg.dataset.price = frame.close; svg.dataset.value = frame.value;
}

window.__hf.registerRenderer("price-history",({seconds})=>render(seconds));
window.addEventListener("editablemediatime",event=>render(event.detail.globalTimeMs/1000));
window.addEventListener("editablemediachange",()=>render(window.editableMedia.getPlayback().globalTimeMs/1000));
window.addEventListener("editablemediadata",()=>queueMicrotask(()=>render(window.editableMedia.getPlayback().globalTimeMs/1000)));
document.querySelector("#play").onclick=()=>window.editableMedia.getPlayback().playing ? window.editableMedia.pause() : window.editableMedia.play();
document.querySelector("#seek").oninput=event=>window.__hf.seek(Number(event.target.value));
function setEditorOpen(open) {
  document.body.classList.toggle("editor-open",open);
  document.querySelector(".app").classList.remove("editor-preview-expanded");
  document.querySelector("#edit").setAttribute("aria-expanded",String(open));
  document.querySelector("#editLabel").textContent=open ? "收起" : "编辑";
  const previewButton=document.querySelector("#editorPreview");
  if (previewButton) previewButton.textContent="放大预览";
  if (!open && document.activeElement?.closest("#editorPanel")) document.querySelector("#edit").focus();
}
document.querySelector("#edit").onclick=()=>setEditorOpen(!document.body.classList.contains("editor-open"));
document.addEventListener("click",event=>{ if (event.target.closest("#editorPreview")) setEditorOpen(false); });
document.addEventListener("keydown",event=>{ if (event.key==="Escape") setEditorOpen(false); });
function resize() {
  if (document.body.classList.contains("capture")) return;
  const viewport = document.querySelector(".viewport");
  const scale=Math.min(viewport.clientWidth/1920,viewport.clientHeight/1080,1);
  const shell=document.querySelector(".canvas-shell");
  shell.style.width=`${1920*scale}px`;shell.style.height=`${1080*scale}px`;
  document.querySelector(".media-canvas").style.transform=`scale(${scale})`;
}
window.addEventListener("resize",resize);
await window.editableMedia.ready;
new ResizeObserver(resize).observe(document.querySelector(".viewport"));
resize();
render(window.editableMedia.getPlayback().globalTimeMs/1000);
