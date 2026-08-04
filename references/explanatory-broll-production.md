# 解释型 B-roll 制作

B-roll 是不以连续主讲人物为唯一主体、用来补充说明、提供证据、建立场景或遮盖剪切点的辅助画面。这里的“解释型 B-roll”范围更窄：它把口播中的流程、阶段、层级、因果、输入输出、比较、拆解、指标或前后变化直接变成可读关系。它不是逐句装饰，也不是把标题和卡片轮流淡入。

## 一、先决定画面来源

导演场景只从五类来源中选择一种主要职责：

- `human`：已授权真人画面承担表达，必须绑定 `media-sources.json` 中的 source id。
- `screen-recording`：真实界面操作或录屏承担证据，必须绑定 source id。
- `evidence`：图片、视频、生成结果或其它可核对证据；现有素材绑定 source id，尚未完成的外部生成结果绑定 `generation_job_ids`，入账后再由时间线采用。
- `explanatory-broll`：内容关系本身需要可视化，必须选择一种关系类型并绑定活动镜头配方。
- `packaging`：全片进度栏等视频包装，不冒充当前语义段落的解释画面。

真人、录屏和证据素材不足时不能用解释模板伪造“已经发生过”的证据。解释模板只表达当前内容真源已经支持的关系。

## 二、按内容关系选模板

活动模板按关系建立，不按行业题材建立：

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

同一语义模板支持 `full-frame`、`presenter-split`、`transparent-overlay` 三种职责和 16:9、9:16、1:1 三种比例。布局变化不能改变内容关系；真人分屏只预留并列职责，人物仍由视频时间线中的真实素材提供。

`schemas/shot-recipe.v2.schema.json` 是配方、目录和选择记录的唯一合同。正式选择必须冻结 `segment_id`、来源类型、关系、布局、比例、选择理由、recipe/style/variant、配方与实现包哈希、场景和确定性时间来源。只有 `status=active` 且绑定真实 editable-media 包的样式可以物化；`reference-only` 只能学习方法。

## 三、导演计划自动接线

先建立 v2 导演输入。解释型场景的 `visual_plan` 只写导演判断，`recipe` 可以为 `null`；生产者会按来源、关系、布局和比例唯一选择活动配方，物化网页包，并把完整选择记录回写计划：

```powershell
node scripts/create-video-direction-plan.mjs `
  --project <媒体项目目录> `
  --source <已确认内容文件> `
  --draft <导演输入.json>
```

不能由剪辑端手写一份“看起来等价”的 selection，也不能只把 recipe id 放进分镜后让消费者猜 scene 或 variant。计划校验会重新读取 selection、包、manifest、场景、变体和哈希，证明生产者输出仍然完整。

## 四、Gallery 与 Studio

直接打开 `assets/shot-recipe-library/index.html` 是静态 Gallery：活动卡显示真实确定性动画，参考卡明确标为仅参考，所有项目写入按钮保持禁用。它不会把浏览器本地状态伪装成项目编辑器。

需要编辑和导出时，从媒体项目启动 Studio：

```powershell
node scripts/explanatory-broll-studio.mjs serve `
  --project <媒体项目目录> `
  --plan <媒体项目目录>/video-direction-plan.json
```

Studio 读取导演段落，选择实际 style/variant，把标题、说明、数据和主题写入 MediaFlow Pro 的公开网页片段状态；“加入时间线”会生成项目内 selection、导入真实网页素材、建立视频轨和片段。PNG、GIF、普通视频、透明视频和 overlay 都由同一片段与 `window.__hf` 确定性时间导出。网页包仍是组件结构与动画真源，MediaFlow Pro 只保存当前片段覆盖值和实际装配状态。

## 五、用真实时间装配

导演计划只保存时长来源与估算，不保存另一条绝对剪辑时间线。真实声音、原片或现有视频时间线形成后，生成 `schemas/video-direction-timing-projection.v1.schema.json` 对应的投影；它必须绑定当前导演计划和真实时间源文件的路径、字节数与 SHA-256，再把 `segment_id` 映射为实际起始帧和持续帧：

```powershell
node scripts/explanatory-broll-studio.mjs apply-plan `
  --project <媒体项目目录> `
  --timings <video-direction-timing-projection.json>
```

消费者只把这个投影用于将导演语义绑定到活动时间线，不把它变成第二个可编辑时间真源。相同 selection 已经绑定其它真实时间时必须拒绝静默移动。Studio 状态写入 `explanatory-broll-studio.json`，保存 MediaFlow Pro 工程、序列、轨道、片段、selection 和时间投影绑定；跨进程重试先读取真实工程状态，再决定复用或继续，不重复导入、收费或堆叠片段。

装配时不会把包含十个场景的模板母版整段塞进时间线。Studio 会按投影中的帧率和持续帧派生只含所选场景的项目运行包，等比调整该场景的语义步骤时间，再从第 0 帧读取。selection 与母版哈希仍保持不变，运行包的 manifest 和整包哈希单独写入 Studio 状态；因此实际镜头比母版场景更长时也不会串入下一个模板。

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
- selection 是否由 v2 生产者生成，包、manifest、scene 和 variant 哈希是否仍成立？
- 文字、数据和主题是否已经写入实际 MediaFlow Pro 片段，而不是只改了 Gallery 表单？
- 时间是否来自绑定真实声音或视频时间线的投影，最终轨道是否读取同一段起止帧？
- 全屏、分屏和透明叠加是否都在目标比例下可读；透明输出是否保留 alpha？
- PNG、GIF、普通视频、透明视频或 overlay 中，用户要求的真实文件是否已生成并实际查看？

外部案例只用于学习“按关系组织 B-roll”和“模板可编辑、可预览、可导出”的能力结构。目标实现不得复制来源不明的卡片造型、头像、代码或素材；来源、许可证和致谢继续按当前仓库的第三方边界处理。
