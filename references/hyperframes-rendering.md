# HyperFrames 直接渲染

仅用于用户明确选择 HyperFrames，把独立、无声、完全由代码网页生成的动画直接渲染成视频。需要 MediaFlow Pro 手动精调、项目续改、旁白、音乐、字幕、实拍、录屏或其它时间线轨道时不读取本文件，改走 `structured-media-editor-cli.md`。

## 一、输入边界

输入必须是已经通过 `schemas/editable-media.v5.schema.json`、包闭包检查和 `scripts/validate-editable-media.mjs` 的自包含 `editable-media` v5 网页包。入口、运行时、素材账本及账本引用的媒体都在包内；任何 `..`、盘符、绝对路径、URL、反斜杠、符号链接或缺失文件都会在启动 HyperFrames 前被拒绝。入口页只有一个 `data-editable-media-root`，运行时暴露 `window.__hf.duration` 与 `window.__hf.seek(seconds)`；这个接口转发到同一 `window.editableMedia` 毫秒时间线，不保存另一份动画或参数状态。

HyperFrames 只消费原网页包的结构和默认场景状态。MediaFlow Pro 项目里的文字、位置、主题、关键帧或其它片段覆盖值不在原网页包中，不能把 HyperFrames 输出说成包含 MediaFlow Pro 修改。需要这些修改时从 MediaFlow Pro 项目导出。

## 二、建立渲染副本

为用户点名的输出变体建立一次性工作副本，不能改写活动网页真源：

```powershell
node scripts/prepare-hyperframes-render.mjs <网页包目录> `
  --variant <variant-id> `
  --output <新的工作目录>
```

脚本先执行唯一 v3 schema 和包闭包，再只接受不存在的输出目录，复制完整网页包，把副本的默认变体和根节点宽、高、时长、帧率同步为本次渲染规格，并输出实际采用的参数。它不会扩大本地服务器根目录去容纳包外依赖。工作副本是派生输入，不是新的编辑入口。

## 三、渲染

先确认当前环境已经提供 HyperFrames，再按其当前 CLI 自描述或帮助信息核对参数。常用入口为：

```powershell
$env:HYPERFRAMES_BROWSER_PATH = "<已经存在的 Chromium 或 Chrome 可执行文件>"
$env:TEMP = "<非系统盘临时目录>"
$env:TMP = $env:TEMP
$env:HYPERFRAMES_EXTRACT_CACHE_DIR = "<非系统盘帧缓存目录>"
$hyperframes = (Get-Command hyperframes -CommandType Application -ErrorAction Stop).Source

& $hyperframes render <工作目录> `
  --fps <fps> `
  --frames-cache-dir $env:HYPERFRAMES_EXTRACT_CACHE_DIR `
  -o <输出视频>
```

工作目录根部的 `index.html` 是默认 composition，不另传 composition 参数。命令只解析已经安装并进入 PATH 的 HyperFrames，不通过 `npx` 临时下载；浏览器、临时目录和帧缓存都必须先指向用户允许的位置。实际参数以已安装版本声明为准。没有安装、没有可用浏览器或命令能力不一致时停止，保留已验证的 v5 网页包并报告当前所选提供方的缺口；不自动安装，也不静默切换到 MediaFlow Pro 或本地渲染。只有用户或已确认计划明确改选本地提供方时，才调用现有的 `scripts/render-web-media-local.mjs`，不能临时另写捕获脚本。

## 四、真实结果检查

渲染后使用 FFprobe 读取实际宽高、帧率、时长、编码和音轨，再从真实视频抽取开始、关键变化和末尾代表帧。逐项核对：

- 宽高、帧率和时长与工作副本输出的参数一致。
- 同一秒数的网页预览和视频帧表达同一场景状态。
- 非循环动画到达确认的结束状态；循环动画首尾关系连续。
- 没有字体替换、空白帧、错误裁切、捕获控件、加载失败或意外音轨。

完成后交付原 v5 网页真源、所选变体、真实视频和检查结果。工作副本与帧缓存保持为可归档的派生产物；未经用户同意不删除。
