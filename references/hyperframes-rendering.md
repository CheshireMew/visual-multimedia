# HyperFrames 直接渲染

仅用于用户明确选择 HyperFrames，把独立、无声、完全由代码网页生成的动画直接渲染成视频。需要 MediaFlow Pro 手动精调、项目续改、旁白、音乐、字幕、实拍、录屏或其它时间线轨道时不使用本流程，回到主入口选择结构化编辑与时间线制作路径。

## 一、输入边界

输入必须是已经通过 `schemas/editable-media.v6.schema.json`、包闭包检查和 `scripts/validate-editable-media.mjs` 的自包含 `editable-media` v6 网页包。入口、运行时、素材账本及账本引用的媒体都在包内；任何 `..`、盘符、绝对路径、URL、反斜杠、符号链接或缺失文件都会在启动 HyperFrames 前被拒绝。入口页只有一个 `data-editable-media-root`，运行时暴露 `window.__hf.duration` 与 `window.__hf.seek(seconds)`；这个接口转发到同一 `window.editableMedia` 毫秒时间线，不保存另一份动画或参数状态。

HyperFrames 只消费原网页包的结构和默认场景状态。MediaFlow Pro 项目里的文字、位置、主题、关键帧或其它片段覆盖值不在原网页包中，不能把 HyperFrames 输出说成包含 MediaFlow Pro 修改。需要这些修改时从 MediaFlow Pro 项目导出。

## 二、建立渲染副本

为用户点名的输出变体建立一次性工作副本，不能改写活动网页真源：

```powershell
node scripts/prepare-hyperframes-render.mjs <网页包目录> `
  --variant <variant-id> `
  --output <新的工作目录>
```

脚本先执行唯一 editable-media v6 schema 和包闭包，再只接受不存在的输出目录，复制完整网页包，把副本的默认变体和根节点宽、高、时长、帧率同步为本次渲染规格，并输出实际采用的参数。它不会扩大本地服务器根目录去容纳包外依赖。工作副本是派生输入，不是新的编辑入口。

## 三、能力探测与动态样片门禁

正式入口是 `scripts/hyperframes-provider.mjs`，不能绕过它直接把同名命令当成已经兼容。先为任务建立受容量约束的工作区，渲染副本、样片、报告、帧缓存和成片都写入同一个 `artifacts/<task-id>/`：

```powershell
node scripts/media-task-workspace.mjs preflight --task-id <task-id> --expected-bytes <峰值字节>
node scripts/media-task-workspace.mjs ensure --task-id <task-id> --expected-bytes <同一峰值字节>

node scripts/hyperframes-provider.mjs inspect
node scripts/hyperframes-provider.mjs sample-plan <工作副本>
node scripts/hyperframes-provider.mjs sample <工作副本> `
  --output artifacts/<task-id>/sample-frames `
  --report artifacts/<task-id>/sample-report.json
```

`inspect` 会执行实际帮助与版本探测，返回配置 adapter、实际 adapter、命令与帮助摘要、能力和限制。只允许 `probe_status=ready` 且 `production_web_render=true` 的实现继续；`legacy-untyped` 需要补齐 adapter，`adapter-mismatch` 必须停止。当前 wrapper 的正式样片与渲染执行合同只适配 `generic-hyperframes`。RenderKit 的结构化预检和区间计划可以作为工程参考，但在它补齐指定时间点样片、当前平台运行与本合同的真实验证以前，不能借用 `HyperFrames` 名称绕过门禁。

样片计划覆盖每个场景的开始和结束、所有 `review:true` 语义步骤的前一帧、精确帧和后一帧，以及没有审阅步骤时的中点。必须逐张打开真实 PNG，检查场景、切换状态、边缘裁切、字体、透明或背景、加载结果和控制元素。人工结论写回绑定包摘要和提供方身份的报告：

```powershell
node scripts/hyperframes-provider.mjs review `
  --report artifacts/<task-id>/sample-report.json `
  --decision passed `
  --reviewer <审阅者> `
  --notes <看到的真实结果>
```

没有看图时不能填写 `passed`。页面运行时错误即使伴随退出码 0 也会使样片失败；样片捕获、报告、工作副本或提供方身份发生变化后必须重新捕获和审阅。

## 四、正式渲染

只有已经通过的样片报告才能启动正式渲染：

```powershell
node scripts/hyperframes-provider.mjs render <工作副本> `
  --sample-report artifacts/<task-id>/sample-report.json `
  --frames-cache-dir artifacts/<task-id>/frames-cache `
  --output artifacts/<task-id>/output.mp4
```

wrapper 会再次核对包闭包与摘要、提供方身份、adapter 能力和样片决定；输出与回执必须是尚不存在的新路径。它会读取真实成片的宽高、帧率、时长、编码和音轨，并把命令尾部输出、页面运行时发现、资源警告、快速捕获回退与报告过的捕获模式写入 `*.render-receipt.json`。进程退出成功但出现 `Browser:PAGEERROR` 或 `EditableMediaFrameError` 时，回执状态是 `blocked-runtime-errors`，命令返回失败；生成出的文件只是诊断证据，不是可交付成片。接受了 fast/GPU 参数、出现速度提升或命令打印了某种模式，都不能代替实际后端证据。

没有安装、浏览器不可用或合同不一致时停止，保留工作副本和证据；不自动安装，也不静默切换到 MediaFlow Pro 或本地渲染。只有用户或已确认计划明确改选本地提供方时，才调用现有的 `scripts/render-web-media-local.mjs`。

## 五、真实结果检查与交付

回执通过运行时门禁后，仍要从最终视频抽取与样片计划相同的开始、语义变化邻帧和末尾代表帧，并与已审阅样片逐时刻核对。确认规格、场景状态、非循环结束状态或循环连续性，以及字体、裁切、空白、加载、控制元素和意外音轨。存在透明交付时还要检查真实 alpha，并在明暗底上叠加观看。

完成后交付原 editable-media v6 网页真源、所选变体、通过的样片报告、正式渲染回执、真实视频和最终画面检查结果。最后运行任务工作区的 `inventory` 与 `finalize`，工作副本、样片、帧缓存和失败证据只列为归档或清理候选；未经用户同意不删除。
