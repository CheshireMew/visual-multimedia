# 解释型 B-roll 制作

B-roll 是不以连续主讲人物为唯一主体、用来补充说明、提供证据、建立场景或遮盖剪切点的辅助画面。这里的“解释型 B-roll”范围更窄：它把口播中的流程、阶段、层级、因果、输入输出、比较、拆解、指标或前后变化直接变成可读关系。它不是逐句装饰，也不是把标题和卡片轮流淡入。

## 一、先决定画面来源

导演场景只从五类来源中选择一种主要职责：

- `human`：已授权真人画面承担表达，必须绑定 `media-sources.json` 中的 source id。
- `screen-recording`：真实界面操作或录屏承担证据，必须绑定 source id。
- `evidence`：用户已经提供或明确允许查看的图片、视频、生成结果或其它可核对证据；获准现有素材绑定 source id，尚未完成的外部生成结果绑定 `generation_job_ids`，入账后再由时间线采用。项目里未经点名的图片不能因为“可能是证据”而被打开。
- `explanatory-broll`：内容关系本身需要可视化，必须选择一种关系类型，并最终绑定已查看的配方实例或项目专用网页包。
- `packaging`：全屏标题卡、全片进度栏等视频包装，不冒充当前语义段落的解释画面。已经确认的短文字整段只承担开场、章节路标、功能出场前的短价值主张或呼吸位时，选择 `full-frame` 标题卡；已经确认多个章节且观众需要持续定位全片时，选择 `transparent-overlay` 进度栏。

真人、录屏和证据素材不足时不能用解释模板伪造“已经发生过”的证据。解释模板只表达当前内容真源已经支持的关系。

## 二、先用内容关系确定语义骨架

十种关系模板按内容关系建立，不按行业题材建立。它们负责提供语义骨架、可运行回退和构图起点，不是所有项目必须套用的最终整镜造型：

| 关系 | `relationship_kind` | 活动场景 |
| --- | --- | --- |
| 流程与 SOP | `process` | `process-flow` |
| 时间线与阶段演进 | `phase-timeline` | `phase-timeline` |
| 框架与层级 | `layered-framework` | `layered-framework` |
| 因果链与反馈循环 | `causal-loop` | `causal-loop` |
| 输入输出与工具链 | `input-output-toolchain` | `input-output-toolchain` |
| 对比与决策矩阵 | `comparison-matrix` | `comparison-matrix` |
| 概念拆解与组装 | `decompose-assemble` | `decompose-assemble` |
| 排名、进度、KPI 与数据看板 | `metric-dashboard` | `metric-dashboard` |
| 案例证据与前后对比 | `evidence-before-after` | `evidence-before-after` |
| 全屏、真人分屏和透明叠加布局 | `layout` | `layout-shell` |

同一语义模板支持 `full-frame`、`presenter-split`、`transparent-overlay` 三种职责和 16:9、9:16、1:1 三种比例。布局变化不能改变内容关系；真人分屏只预留并列职责，人物仍由视频时间线中的真实素材提供。模板预览已经达到当前项目要求时可以接受；模板使构图、素材、运动或相邻场景趋同，则由外部 Agent 直接制作项目内 `editable-media v6` 包，Studio 不把它压回整镜模板。

`schemas/shot-recipe.v2.schema.json` 是配方、目录和选择记录的唯一合同。正式选择必须冻结 `segment_id`、来源类型、关系、布局、比例、选择理由、recipe/style/variant、配方与实现包哈希、场景和确定性时间来源。只有 `status=active` 且绑定真实 editable-media 包的样式可以物化；`reference-only` 只能学习方法。

包装画面不设置 `relationship_kind`。`packaging + full-frame` 唯一选择原创 `editorial-title-card`，默认物化实色样式；用户明确要让底层视频继续可见时指定透明样式。标题、副标题、字体、颜色、位置、实色或透明画布都由同一网页包继续编辑。`packaging + transparent-overlay` 仍唯一选择全片章节进度条；这两类包装不会改变十种解释关系的选择。

## 三、连续创作与实际画面返修

主语言字幕内容确认后才建立 v3 导演输入。每段先写可读结果和可返修创意提案；共享对象、构图逻辑或承接关系的相邻段落放进同一个 `authoring_group`，交给同一个外部 Agent 在完整确认内容、设计要求、已授权素材和相邻场景上下文中制作。创作组只决定谁在同一上下文里创作，真正渲染和局部失效仍按 scene 或 build unit 执行。

解释型场景的 `visual_plan.realization` 初始可以为 `null`；生产者会按来源、关系、布局和比例选择活动配方，物化网页包，并把完整选择记录回写计划，但 review 保持 null：

```powershell
node scripts/create-video-direction-plan.mjs `
  --project <媒体项目目录> `
  --source <已确认内容文件> `
  --draft <导演输入.json>
```

不能由剪辑端手写一份“看起来等价”的 selection，也不能只把 recipe id 放进分镜后让消费者猜 scene 或 variant。计划校验会重新读取 selection、包、manifest、场景、变体和哈希，证明生产者输出仍然完整。

实际创作者查看所负责创作组的关键状态与连续预览后，只返回简短的接受或返修结论。接受配方时运行 `review-video-scene-realization.mjs --status accepted`；需要返修时直接修改项目专用网页包源码，同时提交新提案和 `--status revised`。返修脚本会保留上一版计划并验证真实源码发生变化；评语不能替代修改。素材不能只被塞进通用卡片槽，它至少要实际改变构图、裁切与遮罩、运动路径、空间层次、配色、标注或状态推进中的一项。需要搜索或生成素材时仍先取得用户对当前任务的明确授权。

## 四、Gallery 与 Studio

直接打开 `assets/shot-recipe-library/index.html` 是静态 Gallery：活动卡显示真实确定性动画，参考卡明确标为仅参考，所有项目写入按钮保持禁用。它不会把浏览器本地状态伪装成项目编辑器。

需要编辑和导出时，从媒体项目启动 Studio：

```powershell
node scripts/explanatory-broll-studio.mjs serve `
  --project <媒体项目目录> `
  --plan <媒体项目目录>/video-direction-plan.json
```

Studio 读取导演段落、连续创作组、可读结果、创意提案和已经查看的 realization。静态 Gallery 仍可选择配方；正式 `apply-plan` 只消费 review 已绑定当前整包哈希的配方实例或项目专用包。Studio 把标题、说明、数据和主题写入 MediaFlow Pro 的公开网页片段状态，导入真实网页素材并建立视频轨和片段。PNG、GIF、普通视频、透明视频和 overlay 都由同一片段与 `window.__hf` 确定性时间导出。网页包仍是组件结构与动画真源，MediaFlow Pro 只保存当前片段覆盖值和实际装配状态。

## 五、用真实时间装配

导演计划只保存时长来源与估算，不保存另一条绝对剪辑时间线。真实声音、原片或现有视频时间线形成后，生成 `schemas/video-direction-timing-projection.v1.schema.json` 对应的投影；它必须绑定当前导演计划和真实时间源文件的路径、字节数与 SHA-256，再把 `segment_id` 映射为实际起始帧和持续帧：

```powershell
node scripts/explanatory-broll-studio.mjs apply-plan `
  --project <媒体项目目录> `
  --timings <video-direction-timing-projection.json>
```

消费者只把这个投影用于将导演语义绑定到活动时间线，不把它变成第二个可编辑时间真源。相同 realization 已经绑定其它真实时间时必须拒绝静默移动。Studio v2 状态写入 `explanatory-broll-studio.json`，保存 MediaFlow Pro 工程、序列、轨道、片段、配方 selection 或项目专用包、源包和运行包哈希及时间投影绑定；旧 v1 状态只做一次内容寻址归档迁移，活动读写统一使用 v2。跨进程重试先读取真实工程状态，再决定复用或继续，不重复导入、收费或堆叠片段。

装配时不会把包含多个场景的模板或项目母版整段塞进时间线。Studio 会按投影中的帧率和持续帧派生只含所选场景的项目运行包，等比调整该场景的语义步骤时间，再从第 0 帧读取。源包哈希保持不变，运行包的 manifest 和整包哈希单独写入 Studio 状态；因此实际镜头比母版场景更长时也不会串入下一个场景。

命令行导出用于自动制作和回归：

```powershell
node scripts/explanatory-broll-studio.mjs export `
  --project <媒体项目目录> `
  --selection-id <selection id> `
  --format <png|gif|video|alpha_video|overlay>
```

## 六、检查

- 当前片段是否真的需要解释关系，还是应该使用真人、录屏或证据素材？
- 关系类型、布局、比例和选择理由是否与确认口播一致？
- 连续创作组是否保持共享视觉逻辑，并让同一创作者看到完整原始内容、设计要求、素材与相邻场景？
- realization 是生产者生成的配方实例还是项目专用包；包、manifest、scene、variant、比例和 review 哈希是否仍成立？
- 素材是否真的参与构图、路径、层次或状态，而不是被装进与内容无关的通用卡片？
- 运动是否由准备引出主动作，让依赖变化随后发生并停在可读结果；全段是否只有一个注意力峰值？
- 相邻场景是否在构图、进入方式、素材职责或节奏上形成有意义的差异，而不只是换标题和颜色？
- 文字、数据和主题是否已经写入实际 MediaFlow Pro 片段，而不是只改了 Gallery 表单？
- 时间是否来自绑定真实声音或视频时间线的投影，最终轨道是否读取同一段起止帧？
- 全屏、分屏和透明叠加是否都在目标比例下可读；透明输出是否保留 alpha？
- PNG、GIF、普通视频、透明视频或 overlay 中，用户要求的真实文件是否已生成并实际查看？

外部案例只用于学习“按关系组织 B-roll”和“模板可编辑、可预览、可导出”的能力结构。目标实现不得复制来源不明的卡片造型、头像、代码或素材；来源、许可证和致谢继续按当前仓库的第三方边界处理。
