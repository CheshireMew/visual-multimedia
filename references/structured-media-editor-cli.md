# 结构化媒体编辑器 CLI 协作

用于把通用可编辑网页包交给 MediaFlow Pro 继续精调、混剪、配音、加字幕和导出，也用于调用它公开的 Faster-Whisper XXL 转写与 GPT-SoVITS v2Pro 声音克隆能力。网页包和媒体项目保持产品无关：它们不包含 MediaFlow Pro 专用代码，Skill 只使用公开 CLI，不读取或写入编辑器内部数据库。MediaFlow Pro 自己负责外部语音进程、浏览器逐帧、缓存、MLT 时间线、编码和最终输出，不调用 HyperFrames。

导入对象必须是已经由 `schemas/editable-media.v6.schema.json` 和包闭包检查共同通过的自包含网页包。MediaFlow Pro 使用由 visual-multimedia 单向同步的同一份 schema 消费清单；它不能接受旧 `image` 数据类型、包外路径或缺字段后再自行补成另一种格式。`data_fields.default`、场景数据覆盖、局部变体图层、`visible`、类型化 `parameters`、语义步骤、条件式镜头与运动、完整质量规则和 `production` 元数据都按 v6 原义进入项目。包内 media-sources v4 素材账本的每个 source 还必须明确声明 `browser`、`native-underlay` 或 `native-audio` 管线。

## 一、先读取能力合同

对 MediaFlow Pro 先运行：

```powershell
node scripts/local-media-environment.mjs inspect
node scripts/local-media-environment.mjs mediaflow describe
node scripts/local-media-environment.mjs mediaflow describe --operation <操作名>
node scripts/local-media-environment.mjs mediaflow describe --catalog <字段目录名>
```

`.env.visual-multimedia.local.json` v2 是当前机器的可选提供方、资源与存储策略定位文件，实际值不随 Skill 发布；公开结构见 `assets/local-media-environment.example.json`。`runtime.cache_root` 只声明缓存物理根，`cache_max_bytes`、`task_max_bytes`、`artifacts_max_bytes` 和 `minimum_free_bytes` 分别约束缓存总量、单任务总量、全部任务产物总量和任一目标卷写入后的安全余量；读取器缺少这些新字段时使用公开示例同值的保守默认，不会把“不用系统盘”解释为其它盘无限可写。其中 `providers.mediaflow` 只定位 MediaFlow Pro Python、源码根目录和设置入口，`resources.voice_reference_roots` 单独定位全局声音。读取器只用这些值启动公开 CLI 并解析声音；XXL、GPT-SoVITS、模型和设备路径仍由 MediaFlow Pro 自己的设置管理，单个声音的音频、准确文本、哈希和审核状态仍由 `voice-reference.json` 管理。MediaFlow Pro 配置缺失或路径失效时只停止这个增强分支，本地基础制作仍可继续；不能回退到旧环境变量、PATH 中的同名 CLI 或硬编码安装位置。

默认 `mediaflow describe` 只读取摘要。先确认它返回的 `product` 精确等于 `MediaFlow Pro`，再根据 `protocol`、`version`、`default_project_root`、`capabilities`、字段目录名称和操作摘要判断本轮实际需要的操作。选中操作后，用 `mediaflow describe --operation <操作名>` 只读取该操作的 `arguments_schema` 与 `result_schema`，再结合摘要中的 `project_access`、`execution_mode`、`idempotency` 和 `required_capabilities` 组装请求；需要视觉或音频效果目录时再用 `--catalog` 读取指定目录。完整 `describe` 只通过 `mediaflow describe --full` 用于诊断和合同归档，不是正式生产的默认入口。需要网页协作时确认当前所需的 `web.*` 操作；需要外部转写或声音克隆时分别确认 `speech.transcribe` 或 `speech.synthesize`。随后通过同一读取器提交 `runtime.inspect`，确认操作依赖的 `runtime-inspected` 能力当前为 `ready`；缺少任一必要能力时保留当前真源并说明缺口，不猜测内部字段，也不直接改 `project.mfp`。文档里的操作名只说明当前工作流，实际可用性、参数和结果仍以本轮摘要及按需读取的精确操作合同为准。

新建工程时，`project.create` 提交合同声明的目录名、显示名称和完整工程 `profile`，不传 `project` 路径。`profile` 是输出尺寸、分数帧率、色彩、位深、48 kHz 音频和声道数的唯一创建边界；时间型生产者必须让它与已经确认的制作计划一致，不能创建默认工程后再把计划帧当成另一种帧率。MediaFlow Pro 在 `default_project_root` 下创建工程并返回绝对 `path`；后续操作只使用这个返回值。自动化调用端不得另设工程根目录，也不得先在媒体项目、缓存或临时目录建立工程后再移动或复制。桌面端只有在用户主动选择其它目录时才偏离默认根目录，自动化不能把这种人工选择推断成自己的权限。

CLI 是一次请求一个进程的 JSON 客户端。请求使用它声明的 `mediaflow-editor` 协议版本，从文件或标准输入交给 `execute --request`；响应只从标准输出读取并检查 `ok`、稳定错误码和结果。CLI 和可选的 stdio MCP 转接器都只连接同一个常驻 Editor Service，不打开项目数据库，也不复制任务实现。Skill 的正式批处理继续使用 CLI；需要 MCP 的宿主可以使用编辑器公开的 `mediaflow-mcp`，但两条入口必须消费同一份 `describe` 合同。MCP 只是另一种传输入口，不是实时人机协作的前提。

产品无关的混合时间线先按 `schemas/media-timeline.v1.schema.json` 建立。MediaFlow Pro 的导入能力经本轮检查确认就绪时，默认先用 `timeline.portable.inspect` 检查合同、相对素材、哈希、轨道和字幕，再在空工程中调用 `timeline.portable.import`；MediaFlow Pro 把视频、音频、图片、定格、画面位置、声音、语义标记和字幕样式映射为原生工程内容。导入成功后 `project.mfp` 成为唯一活动时间线，本地 portable timeline 只保留为迁移输入，不能继续双向修改。没有可用 MediaFlow Pro 时，portable timeline 继续作为完整活动真源。

常用交接是异步的：AI 完成一轮后调用 `project.version.create` 建立命名版本，用户在桌面端继续修改，下一轮 AI 先调用 `project.changes.list` 读取版本之后的人工事件，再用 `project.handoff.inspect` 检查离线素材、当前修订、最后导出和工程是否可继续交接。多项关联修改用 CLI 的 `batch --request` 作为同一个 Editor Service 事务提交；任一操作失败时整批不落盘。这个流程不要求双方同时在线，也不要求 MCP。

MediaFlow Pro 可以在一次 `speech.synthesize` 请求内部启动和关闭官方 GPT-SoVITS 子进程；这仍属于一次公开操作，不授权 Skill 自己常驻 `api_v2.py`、探测端口或保存第二套进程状态。

如果项目操作返回 `upgrade_required`，说明项目仍停留在旧 schema 且当前请求按只读方式打开。先确认本次 `describe` 声明了 `project.upgrade`，再提交一次带唯一 `request_id` 的空参数升级请求；升级成功后重新执行原操作。不要自行读写 `project.mfp`，也不要绕过升级继续操作旧项目。

## 二、职责分配

- Skill 首次决定内容、结构、风格、稳定图层 ID 和复杂动画。
- 编辑器项目保存网页片段当前采用的输出变体，以及每个场景的文字、图片 source id、颜色、位置、尺寸、旋转、透明度、层级、显隐、图层关键帧、自定义参数、参数关键帧、数据快照和逐字段锁定状态。图片实际文件继续由网页包的 media-sources v4 `media-sources.json` 解析，编辑器不能把 source id 展开成另一份长期保存的绝对路径。
- MediaFlow Pro 的浏览器渲染器只通过 `window.__hf.seek(seconds)` 定位网页帧，再从当前项目中的片段状态覆盖网页默认值。项目保存过一次修改后，项目状态是后续预览、缓存和成片的唯一来源；原网页包仍是组件结构真源，但不包含这些实例修改。
- AI 与人工都调用能力合同声明的 `web.clip.*` 状态操作。所有项目写请求都带最近一次读取返回的 `base_revision`、稳定 `request_id`、`actor` 和 `client_id`；自动化写入前优先调用合同提供的差异操作，发现锁定字段或修订冲突时重新读取并展示差异。
- `web.clip.edit.describe` 是属性面板和自动化共同读取的编辑描述真源。它按当前变体、场景、运行时状态和锁定状态返回稳定路径、值类型、控件、范围、单位、选项、当前值、默认值、是否可动画及时间线类型；调用端不再维护另一份“标准字段 + 特例参数”表。
- 用户锁定的字段不由自动化修改。需要新增、删除或重构图层时回到网页源；换版先调用 `web.asset.rebind.plan` 取得不可变计划摘要、逐路径冲突和允许选择，再把每个冲突的明确决定连同原摘要交给 `web.asset.rebind.commit`。源包、片段修订或计划内容在两步之间变化时必须重新规划；不存在 `allow_conflicts`、隐式猜测或“尽量迁移”入口。

## 三、进入编辑器的时机

以下情况导入结构化编辑器：

- 网页画面需要与实拍、录屏、旁白、音乐或字幕混剪。
- 用户希望直接拖动图层或在属性面板中快速精调。
- 用户需要把网页动效导出为可在目标剪辑软件中叠加的透明视频或覆盖层。
- 最终需要统一的视频时间线、短视频派生序列或批量导出任务。

只需要 PNG、GIF、视频或独立网页时仍以网页包为内容真源；MediaFlow Pro 的网页导出能力就绪时优先用 `web.clip.export`，没有可用 MediaFlow Pro 时才从同一网页真源本地导出。独立无声代码动画只有在用户明确选择 HyperFrames 时才进入对应的直接渲染路径。提供方只负责读取同一真源和导出，不能因此增加与成品无关的项目步骤。

## 四、典型请求顺序

1. `web.import` 导入完整包含入口、运行时、素材账本和媒体文件的 `editable-media.json` 本地目录，读取返回的素材 ID。
2. `timeline.get` 读取目标序列和轨道，再用合同声明的时间线操作把网页素材放入视频轨道。
3. `web.clip.get` 读取片段覆盖值和修订号，`web.clip.edit.describe` 读取当前可编辑路径和控件合同。
4. 标准图层字段用 `web.clip.update`，自定义参数用 `web.clip.parameter.update`；两者都只提交本次真正改变的路径，不提交整份 HTML。
5. 图层或参数需要随时间变化时，分别使用 `web.clip.keyframe.set/remove` 与 `web.clip.parameter.keyframe.set/remove`。时间使用当前场景毫秒值，仍由同一个 `window.__hf` 时间边界渲染。
6. `web.clip.render` 生成与当前修订一致的浏览器缓存。
7. 只导出当前网页片段时使用 `web.clip.export`；短序列或一次性整片使用 `preview.render` 或 `export.sequence`。多场景、长时或高成本视频把已确认的通用构建单元映射为连续 `start_frame/end_frame` 后使用 `export.sequence.build`。它只接受真实时间线范围：MediaFlow Pro 自己计算区间指纹、逐单元返回 `rendered/reused`，整条音频单独连续处理，再返回装配状态和可保存的构建报告。调用端把这些事实写回 v2 构建报告，不能自造命中结果。

合同声明对应能力时，可以继续使用：

- `web.clip.keyframe.set/remove` 调整位置、大小、透明度、文字等随时间的变化和缓动；`web.clip.parameter.keyframe.set/remove` 调整回弹强度、错峰间隔、轨道半径、镜头幅度、阈值等清单已声明且允许动画的共享参数。
- `web.clip.lock.update` 锁定标准图层字段，`web.clip.parameter.lock.update` 锁定自定义参数。锁只阻止自动或人工写入，不复制值。
- `web.clip.theme.update` 替换品牌变量，`web.clip.variant.select` 选择输出变体；不存在 `web.clip.layout.select`。
- `web.clip.data.update` 写入内联数据，`web.clip.data.snapshot` 从本地 JSON/CSV 固化一次性快照；不要把远程 API 变成运行依赖。
- `web.batch.create` 从记录和显式字段绑定生成多个短序列，不复制或改写 HTML。
- 带 `component` 元数据的共享网页包先从不可变 `web-components` 注册版本采用到当前项目，再通过 `web.import` 把采用后的完整包交给编辑器；当前公开合同没有 `web.component.*` 操作，编辑器内部目录也不成为第二份组件注册表。
- `web.clip.export` 从同一组场景状态派生 PNG、GIF、透明视频、普通视频或时间线覆盖层。透明输出只在本轮 `describe` 明确声明相应格式时使用；所选输出变体必须声明透明画布，HTML 的 body 与媒体画布也要真实透明。容器、编码和像素格式服从当前操作合同与目标剪辑软件，不能照搬固定格式。完成后检查实际文件的透明通道，并在目标软件中叠加到明、暗底片上观看。
- 用户明确要求参考视频复刻、匹配或逐帧对齐，并且 `describe` 声明 `quality.reference.compare` 时，用该操作比较最终参考文件和候选文件；它不依赖项目数据库，也不改变网页或时间线。
- 执行大范围自动修改前可用 `project.version.create` 建立命名恢复版本；`project.version.list/restore` 负责查看和恢复，不把项目版本塞进网页清单。

桌面界面保持项目打开时也可以运行短进程 CLI 或 stdio MCP 客户端，但这只是同一 Editor Service 的可选即时投影，不是正式工作流的依赖。所有调用方仍使用 `base_revision`、持久事件和命名版本；冲突时重新读取并交给用户决定，任何调用方都不直接操作项目数据库。

需要把可保真的时间线交给 Final Cut Pro 时，只在 `describe` 声明 `export.fcpxml` 与 `fcpxml-export` 后调用该操作。它会先检查转场、音频总线、网页缓存等语义能否可靠交接；拒绝结果表示当前时间线不能无损映射，调用端不得绕过预检另写一份低保真 XML。

采访原声讲解型 profile 当前采用“一段旁白一个已经验证的网页包”，并把每个片段以 `source_in=0` 和计划中的精确帧数加入 MediaFlow Pro。这是活动 profile 对当前消费者能力的适配，不是 MediaFlow Pro 或所有视频的全局规则。只有多场景任意入点经过真实链路验证，并通过新 profile 版本与新计划显式启用后，才可改用单包非零入点；调用端不能在渲染阶段自行试错或回退。

`export.sequence.build` 是普通视频与 profile 共用的消费者能力，不保存 visual-multimedia 的阶段批准、文案或 profile 私有字段。输入单元必须有唯一 id、按顺序连续且位于真实序列范围内；输出规格来自当前请求的 preset。相同区间、素材、网页状态、字幕、全局视觉设置和规格才命中画面缓存；音频素材、路由或效果变化只失效连续音频母版和最终装配。变更构建单元划分时先更新通用构建计划，不在消费者内部猜场景边界。

导入角色轨或其它由多个连续片段组成的覆盖轨时，先逐个导入真实素材，再使用本轮 `describe` 中的 `timeline.clip.batch.add` 一次提交全部已对齐片段。这个操作在应用层形成一项原子编辑：任何一项无效时整批不落盘，成功后可一次撤销，带相同 `request_id` 的重试不会重复摆放。它是普通时间线能力，不读取 `avatar-track-clips.json` 私有字段；调用端只把清单中的项目相对文件、起始帧和时长映射成公开参数。

## 五、外部转写与声音克隆

需要 Faster-Whisper XXL 转写时，先确认 `speech.transcribe` 及其依赖的 `faster-whisper-xxl` 能力可用，再严格按返回 schema 提交真实音视频输入、SRT 输出位置和本次需要覆盖的语言、模型、设备、计算类型或覆盖选项。操作返回的引擎版本、输入与输出哈希、语言、实际时长和分段结果必须与真实 SRT 一起保存；随后用 `scripts/import-media-transcript.mjs --kind asr` 把 SRT 绑定到原始 source id 与哈希。自动转写仍从待复核状态开始，完整听音和纠错不能由引擎成功代替。

需要 GPT-SoVITS v2Pro 时，先确认用户已经授权声音克隆和参考音频，再确认 `speech.synthesize` 及其依赖的 `gpt-sovits-v2pro` 能力可用。按返回 schema 提交确认目标文本与语言、真实参考音频、参考音频的准确文本与语言、WAV 输出位置及必要的可选参数。响应中的输出哈希、实际时长、采样率、声道、参考音频哈希、引擎版本和设备是本次私有生成回执；WAV 只有经实际试听并由素材导入器写入 `media-sources.json` 后，才成为时间线可消费的声音 source。操作成功不等于声音身份、读音或情绪已经通过。

用户按名称、id 或别名点名已经注册的全局声音时，先运行 `node scripts/local-media-environment.mjs voice-resolve --voice <选择>`。读取器递归读取本机配置声明的声音根目录，要求选择唯一，核对清单协议、参考音频与文本文件及其 SHA-256，再把返回的 `reference_audio`、`reference_text` 和 `reference_language` 原样交给本轮 `speech.synthesize`。没有点名时不得取第一个或最近使用的声音；解析结果的 `manual_voice_review` 不是 `passed` 时只能先生成试听并保留待人工听音状态，不能把声音身份写成已经确认。

两个操作都不要求 `project`，也不把外部引擎路径写进媒体项目。组件路径只由 MediaFlow Pro 设置和运行组件目录管理；Skill 不把本机路径、下载地址或第三方参数表复制进项目合同。

## 六、参考视频比较

`quality.reference.compare` 是通用文件比较操作，不是 editable-media 字段，也不把参考素材写进 `project.mfp`。调用前先从 `describe` 确认 `reference-video-comparison`、`ffmpeg` 和 `ffprobe` 能力可用，再严格按返回的参数 schema 提交参考文件、候选文件、各自起始帧、可选比较帧数、邻帧搜索半径、边界帧数量、联系表行数、输出目录、可选验收条件和显式覆盖选择。

不提供验收条件时，操作只返回 `measured` 和真实测量结果；提供条件时才返回 `passed` 或 `failed`。验收条件可以约束剩余帧数一致、完全一致帧比例、平均绝对误差、边界误差、最低 PSNR 和时间错位数量，它们由当前还原目标决定，不从 MediaFlow Pro 或某个示例继承固定阈值。操作产出的报告、最差帧和联系表都从最终候选文件解码，调用端必须打开这些证据并完成参考对齐所需的视觉与风格层人工检查。

## 七、真实链路验收

验收不能由调用端手写场景状态或伪造缓存。必须让 visual-multimedia 实际生成的 starter 和 v6 合同案例生产场景、参数、结构、默认继承、局部变体和画面，让编辑器仓储保存覆盖值，让浏览器渲染器通过 `window.__hf.seek(seconds)` 逐场景逐帧读取，让时间线编译器消费缓存，最后从导出文件抽帧核对。至少覆盖导入失败、包外路径、已移除的数据类型、重复图层 ID、缺少资源、修订冲突、默认数据继承、局部变体切换、`visible`、参数更新与关键帧、复制、分割、撤销、重做、短序列复制、锁定字段、严格换版冲突和缓存失效。桌面端还要实际拖动区间、端点和关键帧，确认拖动中浏览器按同一时钟预览、释放后只提交一次，并能吸附帧网格和语义步骤。

语音操作的真实链路另行从真实本机配置贯穿外部生产者和正式消费者：读取器必须实际定位 MediaFlow Pro 设置和已注册声音，`speech.transcribe` 必须实际启动 XXL、生成 SRT、返回分段，再由 transcript 导入器绑定原片并通过听音；`speech.synthesize` 必须使用解析出的同一参考音频与准确文本启动 GPT-SoVITS、生成 WAV、验证音频帧与哈希，再由素材导入器和时间线读取。只检查配置、`describe`、组件目录或返回 JSON 不能声称外部能力可用。
