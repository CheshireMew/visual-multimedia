# 制作能力与提供方选择

visual-multimedia 自己负责内容到媒体的制作方法、产品无关的真源合同和本地基础执行能力。MediaFlow Pro 是存在且能力就绪时的首选综合执行方，HyperFrames 是明确选择的网页渲染器；两者都不是 Skill 能否工作的前提。

## 一、三种提供方

### 本地基础能力

只要环境中有 FFmpeg、FFprobe、浏览器和 Playwright，Skill 就可以独立完成两类正式制作：

- `editable-media` v6 网页包继续作为代码视觉真源，由 `scripts/render-web-media-local.mjs` 按 `window.__hf.seek(seconds)` 逐帧导出 MP4 或 GIF。
- `media-timeline` v1 作为产品无关的视频、音频与字幕时间线，由 `scripts/media-timeline.mjs` 校验、检查并渲染。它支持现有素材剪切、定格、画面位置与缩放、声音、淡入淡出、标记和中英双语字幕。

本地时间线和网页包都是可继续修改的 `source_bundle`，不是因为没有编辑器工程就退化成只能观看的扁平成片。新用户没有安装 MediaFlow Pro 时仍应得到完整、可复现、可修改的制作结果。

### MediaFlow Pro 增强

MediaFlow Pro 是覆盖网页动画渲染、原生混合时间线、素材管理、转场、定格、语义标记、字幕样式、桌面精调、版本和导出的综合增强。选择它时，产品无关的 `media-timeline` v1 可以通过公开的 `timeline.portable.inspect` 和 `timeline.portable.import` 导入空工程；导入成功后，`project.mfp` 成为后续编辑和最终导出的唯一制作真源。

MediaFlow Pro 内部可以按 `web.clip.render.inspect` 的当前计划在逐帧 FFV1 与有界 WebCodecs H.264 之间选择，但这不构成 visual-multimedia 的第二个渲染器。当前自动直接编码范围来自 Windows 实测，严格限于工作量足够的 UHD 3840×2160（或 2160×3840）、30/29.97fps、不透明 SDR 网页；1080p、720p、4K24、4K60、透明画布和原生视频底层继续走逐帧管道。直接尝试通过 HTML in Canvas 生成 `VideoFrame`，核对 Chrome 代表帧、限制队列、使用整数帧时钟、连续合成音频并检查最终包；最后 8 帧的 Chromium 轨迹还必须证明同一个编码器实例实际进入 Windows `MediaFoundationVideoEncodeAccelerator`，否则 MediaFlow Pro 丢弃整次尝试并完整回退。NVIDIA GPU 利用率或显存占用达到 90% 时会在浏览器启动前直接回退；OpenH264 软件路线的完整 4K 压力测试没有净提速，不作为自动替代。Skill 只消费计划后端、实际后端、回退原因和质检证据，不复制编码、回退或视频解码逻辑。当前回执会如实指出 D3D 画面仍回读到内存，因此是“硬件编码已证明、零拷贝未实现”，不得把二者混写。网页内动态视频不进入快路，正式视频素材继续由 MediaFlow Pro 的原生视频管线按时间线时钟处理。

常见协作不是实时共同操作，而是异步交接：AI 建立命名版本并交付工程，用户在桌面端继续调整，之后 AI 用 `project.changes.list` 读取人工改动，用 `project.handoff.inspect` 检查素材、修订和最后导出，再从同一工程继续工作。MCP 只是连接同一个 Editor Service 的可选传输入口；普通的“AI 做完—人微调—AI 继续”用公开 CLI 就能完成，不要求 MCP 或实时协作。

### HyperFrames 渲染

HyperFrames 只用于用户明确选择的独立代码网页动画渲染。它读取从同一 `editable-media` v6 网页真源建立的工作副本，不保存混合时间线，也不消费 MediaFlow Pro 工程中的人工调整。它不是 MediaFlow Pro 的替代项目编辑器，更不能成为本地基础能力的必装依赖。

`HyperFrames` 不是一个可由命令名证明的单一提供方。当前适配器分为 `generic-hyperframes` 和 `renderkit`：前者必须从实际 `--help`、`render --help`、`snapshot --help` 和版本输出证明确定性渲染与指定时刻样片能力；后者必须从自己的结构化检查、分段计划和运行合同证明能力。配置声明与实际探测不一致时直接失败，不能把一个实现的参数、限制或性能结论套给另一个实现。推荐的本机配置为：

```json
{
  "providers": {
    "hyperframes": {
      "adapter": "generic-hyperframes",
      "command": "D:/Tools/npm-global/hyperframes.ps1"
    }
  }
}
```

旧配置只写 `command` 时会继续探测，但结果标记为 `legacy-untyped`，应在确认实现后补上 adapter。RenderKit 值得吸收的是静态预检、按区间选择后端、直接编码实验、背压、结构化回执和失败保留证据；它当前公开实现面向 Linux x86_64、依赖固定的自编译 Electron/Chromium，并且主 CLI 没有指定时间点样片合同，所以在 Windows 与本 Skill 的正式渲染门禁下不是可用生产提供方。支持的命令或操作名只是候选能力；正式可用还必须经过动态样片、页面运行时和成片检查。

## 二、选择顺序

先确认本次真源属于网页包、产品无关时间线、原生编辑器工程还是音频源，再判断用户是否需要原生桌面工程与后续人工微调。运行：

```powershell
node scripts/local-media-environment.mjs inspect
node scripts/local-media-environment.mjs resolve --need timeline-edit
node scripts/local-media-environment.mjs resolve --need timeline-render
node scripts/local-media-environment.mjs resolve --need web-render
node scripts/local-media-environment.mjs resolve --need subtitle-edit
node scripts/local-media-environment.mjs resolve --need audio-edit
node scripts/local-media-environment.mjs resolve --need speech-transcribe
node scripts/local-media-environment.mjs resolve --need speech-synthesize
node scripts/local-media-environment.mjs resolve --need preview
node scripts/local-media-environment.mjs resolve --need export
```

结果按默认优先级列出候选，并给出 `preferred_provider`：

1. 已配置 MediaFlow Pro 时，路由器实际读取它的 `describe` 摘要；确定本轮操作后再按需读取精确操作合同并调用 `runtime.inspect`，同时核对正式操作和运行时状态。所需能力确实就绪才把 MediaFlow Pro 放在第一候选，用它完成网页渲染、剪辑、字幕、声音、语音识别、语音合成、预览、导出、参考视频比较和工程交接。不能仅凭配置文件中出现了 MediaFlow Pro 就假定它能做，也不能把完整合同作为每次探测的默认输入。
2. 没有 MediaFlow Pro，或检查后确认它不提供本次所需能力时，使用本地完整能力，不把这条路径写成残缺降级。
3. 用户明确指定 HyperFrames 渲染独立网页动画时，只把 `production_web_render=true` 的实际 adapter 列为候选。选择后先完成动态样片门禁；任何页面运行时错误、提供方身份变化或样片绑定失效都会阻断正式渲染。

同一轮完成能力检查并选定提供方后不因执行失败静默换路。保留当前真源，说明缺少的能力；只有用户或已经确认的计划明确改选，才建立另一提供方的派生输入。最终成品必须从当前声明的活动真源导出，交付合同记录真实提供方、真源种类、文件、哈希和导出回执。

## 三、交接规则

- 本地制作交付网页包或 `media-timeline` v1、引用素材、哈希、渲染结果与回执，分类为 `source_bundle`。
- MediaFlow Pro 制作交付当前 `project.mfp`、工程标识、内容修订、文件哈希、最后导出与交接检查，分类为 `native_project`。
- HyperFrames 制作仍交付原网页包，渲染工作副本只是派生输入，分类为 `source_bundle`。
- 只有确实不再保留可编辑网页、时间线、音频源或原生工程时才使用 `flat_render`，并写清无法恢复的内容。

提供方只决定谁执行和怎样交接，不改变剪辑、声音、视觉、字幕和审阅标准。网页动画的状态机规则也不能套用到已有素材剪辑；视频剪辑的切点、定格和镜头对应规则同样不能改写网页动画的场景时间。
