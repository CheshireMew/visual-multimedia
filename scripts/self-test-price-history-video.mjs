#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {resolveTaskPath} from "./media-task-workspace.mjs";
import {loadLocalMediaEnvironment} from "./local-media-environment.mjs";
import {listenOnBrowserSafePort} from "./browser-safe-server.mjs";
import {DAY_MS, validatePrices, prepareSeries, frameState} from "../assets/price-history-video/price-history-math.mjs";

const require=createRequire(import.meta.url);
const taskIndex=process.argv.indexOf("--task-id");
if (taskIndex<0 || !process.argv[taskIndex+1]) throw new Error("--task-id must name a real generated task");
const project=resolveTaskPath(process.argv[taskIndex+1]), root=path.join(project,"web");
const manifest=JSON.parse(fs.readFileSync(path.join(root,"editable-media.json"),"utf8"));
const snapshot=JSON.parse(fs.readFileSync(path.join(root,"price-history.json"),"utf8"));
const displayCurrency=manifest.scenes[0].data.display_currency;
const prices=manifest.scenes[0].data.prices;
const principal=manifest.parameters.find(p=>p.descriptor.id==="principal").descriptor.default;
const windowDays=manifest.parameters.find(p=>p.descriptor.id==="window_days").descriptor.default;
const hold=manifest.parameters.find(p=>p.descriptor.id==="end_hold_seconds").descriptor.default;
const duration=manifest.scenes[0].duration_ms/1000;
assert.throws(()=>validatePrices([{timestamp:0,close:1},{timestamp:0,close:2}]),/递增/);
assert.throws(()=>validatePrices([{timestamp:0,close:1},{timestamp:DAY_MS,close:0}]),/正数/);
const irregular=[{timestamp:0,close:10},{timestamp:DAY_MS,close:5},{timestamp:DAY_MS*4,close:20}];
const sample=prepareSeries(irregular,100,2);
assert.equal(frameState(sample,2,4,0).index,1,"non-trading days must use date spacing");
assert.equal(sample.finalValue,200);
assert.equal(sample.returnPct,100);
assert.equal(frameState(sample,4,4,0).value,200);
const causal=prepareSeries([...irregular,{timestamp:DAY_MS*5,close:2000}],100,2);
assert.deepEqual(causal.tops.slice(0,3),sample.tops,"future prices must not alter the historical axis");
const expected=principal/prices[0].close*prices.at(-1).close;
const series=prepareSeries(prices,principal,windowDays);
assert.ok(Math.abs(series.finalValue-expected)<1e-8);
assert.equal(manifest.parameters.find(p=>p.descriptor.id==="principal").descriptor.unit,displayCurrency);

function checkMixedSpacing(text) {
  assert.doesNotMatch(text, /\p{Script=Han}(?:\$?[A-Za-z0-9])|[A-Za-z0-9](?:[%％])?\p{Script=Han}/u, `missing space: ${text}`);
  assert.doesNotMatch(text, /\p{Script=Han}[ \t\u00a0]+\p{Script=Han}|\$\s+[A-Za-z]/u, `extra space: ${text}`);
}

const server=http.createServer((request,response)=>{
  const url=new URL(request.url,"http://localhost");
  const file=path.resolve(root,`.${decodeURIComponent(url.pathname==="/"?"/index.html":url.pathname)}`);
  if (path.relative(root,file).startsWith("..") || !fs.existsSync(file)) {response.writeHead(404).end();return;}
  const mime={".html":"text/html",".json":"application/json",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css"};
  response.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream"});fs.createReadStream(file).pipe(response);
});
const local=loadLocalMediaEnvironment().providers.local;
const pw=require(local.playwright.module);
const port=await listenOnBrowserSafePort(server);
let browser;
try {
  browser=await pw.chromium.launch({headless:true,executablePath:local.browser});
  const page=await browser.newPage({viewport:{width:1920,height:1080}}), errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?capture=1`);
  await page.evaluate(()=>window.editableMedia.ready);
  const initial=await page.evaluate(()=>window.editableMedia.getState());
  assert.equal(await page.locator(".summary").isVisible(),false,"the final summary must stay hidden at the start");
  const times=[0,...manifest.scenes[0].steps.map(s=>s.at_ms/1000),...Array.from({length:16},(_,i)=>duration*(i+1)/17),duration-1/30];
  const records=[];
  for (const seconds of times) {
    await page.evaluate(t=>window.__hf.seek(t),seconds);
    const actual=await page.locator(".chart svg").evaluate(svg=>({index:Number(svg.dataset.candleIndex),price:Number(svg.dataset.price),value:Number(svg.dataset.value),svg:svg.outerHTML}));
    const cursor=prices[0].timestamp+Math.min(1,seconds/(duration-hold))*(prices.at(-1).timestamp-prices[0].timestamp);
    const expectedIndex=prices.findLastIndex(p=>p.timestamp<=cursor+.01);
    assert.equal(actual.index,expectedIndex);
    assert.equal(actual.price,prices[expectedIndex].close);
    assert.ok(Math.abs(actual.value-principal/prices[0].close*actual.price)<1e-8);
    records.push({seconds,index:actual.index,price:actual.price,value:actual.value});
  }
  assert.equal(await page.locator(".summary").isVisible(),true,"the final summary must appear at the end");
  const labels=await page.evaluate(()=>({
    title:document.querySelector("h1").textContent,
    caption:document.querySelector(".metrics .caption").textContent,
    summary:document.querySelector(".summary .value").textContent,
    detail:document.querySelector(".summary .detail").textContent,
    footer:document.querySelector(".footer").textContent,
    axis:[...document.querySelectorAll(".chart svg text")].map(n=>n.textContent),
  }));
  for (const text of [labels.title,labels.caption,labels.summary,labels.detail,labels.footer,...labels.axis]) checkMixedSpacing(text);
  assert.equal(labels.title,manifest.scenes[0].data.title);
  assert.ok(labels.title.includes(manifest.scenes[0].data.asset_name));
  assert.ok(labels.caption.includes(displayCurrency));
  assert.ok(labels.summary.endsWith(displayCurrency));
  assert.ok(labels.axis.includes(displayCurrency));
  if (snapshot.source.exchange==="binance") {
    assert.equal(snapshot.source.provider,"Binance");
    assert.match(labels.footer,/^数据：币安 ·/u);
    assert.doesNotMatch(labels.footer,/Heimdall/u);
  }
  if (snapshot.quote_currency==="USDT" && ["美元","USD"].includes(displayCurrency)) {
    assert.match(labels.footer,/1 USDT = 1 美元/u);
    assert.equal(snapshot.symbol.split("/")[1],"USDT");
  }
  const displayedFinal=Number(labels.summary.match(/[\d,.]+/u)[0].replaceAll(",",""));
  const amountScale=labels.summary.includes("亿")?1e8:labels.summary.includes("万")?1e4:1;
  assert.ok(Math.abs(displayedFinal*amountScale-expected)<=amountScale*(amountScale===1?.5:.005),"displayed amount must match the actual calculation after rounding");
  const time=duration*.6;
  await page.evaluate(t=>window.__hf.seek(t),time);
  const before=crypto.createHash("sha256").update(await page.screenshot()).digest("hex");
  const sourceSvg=await page.locator(".chart svg").evaluate(svg=>svg.outerHTML);
  const sourceTitle=await page.locator("h1").innerText();
  await page.evaluate(()=>window.__hf.seek(0));
  await page.evaluate(t=>window.__hf.seek(t),time);
  const after=crypto.createHash("sha256").update(await page.screenshot()).digest("hex");
  assert.equal(after,before,"backward then forward seek must reproduce the frame");
  await page.evaluate(()=>{
    const state=window.editableMedia.getState();state.parameters.principal*=2;state.theme.accent="#ff4cb2";
    state.scenes.history.data.title="UNI 真实价格编辑验证";window.editableMedia.setState(state);
  });
  await page.evaluate(t=>window.__hf.seek(t),time);
  const edited=await page.locator(".chart svg").evaluate(svg=>({value:Number(svg.dataset.value),color:svg.querySelector('path[stroke]')?.getAttribute("stroke")}));
  assert.ok(Math.abs(edited.value-frameState(series,time,duration,hold).value*2)<1e-8);
  assert.equal(edited.color,"#ff4cb2");
  assert.equal(await page.locator("h1").innerText(),"UNI 真实价格编辑验证");
  await page.evaluate(state=>window.editableMedia.setState(state),initial);
  await page.evaluate(t=>window.__hf.seek(t),time);
  assert.equal(await page.locator(".chart svg").evaluate(svg=>svg.outerHTML),sourceSvg,"restoring edits must reproduce the complete chart");
  assert.equal(await page.locator("h1").innerText(),sourceTitle);
  await page.evaluate(()=>{
    const state=window.editableMedia.getState();
    state.scenes.history.data.title="假如你在 2020 年买入 100万美元 的 $ UNI";
    window.editableMedia.setState(state);
  });
  assert.equal(await page.locator("h1").innerText(),"假如你在 2020 年买入 100 万美元的 $UNI");
  await page.evaluate(state=>window.editableMedia.setState(state),initial);
  // Check actual editor mounting and state editing through its existing UI.
  const editor=await browser.newPage({viewport:{width:1600,height:1000}});
  editor.on("pageerror",e=>errors.push(e.message));
  await editor.goto(`http://127.0.0.1:${port}/?mode=manual`);
  await editor.waitForFunction(()=>document.querySelector("#contentEditor input") && window.editableMedia.getManifest());
  assert.equal(await editor.locator("#editorPanel").isVisible(),false);
  await editor.locator("#edit").click();
  await editor.locator("#contentEditor textarea").first().waitFor({state:"visible"});
  assert.equal(await editor.locator("#editorPanel").count(),1);
  await editor.getByRole("textbox",{name:"标题",exact:true}).fill("假如你在 2020 年买入 100万美元 的 $ UNI");
  assert.equal(await editor.locator("h1").innerText(),"假如你在 2020 年买入 100 万美元的 $UNI","paused editor changes must immediately update the formatted title");
  await editor.locator("#edit").click();
  assert.equal(await editor.locator("#editorPanel").isVisible(),false);
  assert.deepEqual(errors,[]);
  const result={ok:true,real_source:path.join(root,"price-history.json"),candles:prices.length,
    final_value:expected,observed_frames:records,seek_reproduced_sha256:before,
    capital_edit:true,title_edit:true,color_edit:true,editor_mounted:true,typography_edit:true,visible_labels:labels,page_errors:errors};
  fs.writeFileSync(path.join(project,"reports/price-history-self-test.json"),`${JSON.stringify(result,null,2)}\n`);
  console.log(JSON.stringify({ok:true,candles:prices.length,checked_frames:records.length,final_value:expected,deterministic_seek:true,editing:true}));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
