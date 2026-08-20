# 确认内容的视频导演合同

用户已经确认完整主语言字幕内容，并明确要求把它制作成需要新视觉导演的视频时，建立项目唯一的 `video-direction-plan.json`。已有原声视频还要先完成复核转写与主语言显示字幕确认。只有现成脚本直接剪辑、只要分镜建议或内容尚未确认时，不为形式完整增加此文件。

专项视频 profile 已经用自己的 authoring 或不可变计划保存并实际消费逐段画面决定时，不再并行建立本合同。产品宣传片的 shots、GitHub 项目介绍的 visual、采访原声讲解的 source-clip/scene，以及素材解说型的 segment visual 都属于这种等价导演结果；它们仍执行下文“继续当前主画面还是采用辅助画面”的判断，但只把结果写进自己的唯一活动计划。

## 一、先锁定内容与出镜边界

确认主语言字幕文件仍是原创视频的唯一内容真源。v3 计划保存不可变快照、字节数、SHA-256、`source_id`、`source_version`、`content_unit_id` 和 `media_script_version`；快照证明当时读取了什么，不是第二份活动文稿。译文和发音文本必须绑定这份快照；主字幕变化后旧计划失效。

进入计划前确认受众、视频承诺、核心主张、支撑点、必要事实和风险，并检查主字幕能否让陌生观众理解对象、问题、价值和结果。内部制作术语不能代替观众内容。旁白必须为 `confirmed`，保存文本哈希和来源引用；主要删减、重排、合并或立场变化逐项记录确认。内容含义变化时先更新主字幕版本并重新确认，再重建译文、声音和计划，不能用分镜掩盖变化。发音表只分开保存原文写法、实际读法和说明，不污染字幕或事实。

导演只能查看用户已经提供或明确允许查看的视觉素材。仓库图片、旧封面、预览图、历史成品和相邻目录图片即使内容相关，也不自动成为证据、参考或候选；未获授权时不得搜索、枚举、打开、生成联系表或从中提取风格。画面确实需要某类图片时先向用户说明用途并取得许可；否则从确认字幕与事实设计原创代码画面，不能暗中借用项目图片。

出镜方式只在这里确认一次：

- `human`：已有真人素材，必须引用 `media-sources.json` 中权利状态为 confirmed 的正式 source。
- `none`：没有固定主讲人物，`source_id` 必须为 null；场景仍可以使用证据、录屏、解释型 B-roll 或包装画面。

角色生成和数字人不由本合同凭空承诺；已有独立生产入口时先完成并入账，再作为正式素材进入时间线。

用户没有点名 B-roll 也不影响导演判断。每个语义段都先比较继续使用当前主画面与切入辅助画面的实际价值：已授权画面能够增加证据、环境、动作、情绪、结果展示或遮盖必要剪切时，主动把它纳入创意提案；没有新增价值时让主画面继续承担完整解释，不按句号换镜头。已有或获准生成的情境 B-roll 按真实素材身份作为 `evidence` 绑定 source id；把流程、因果、比较等内容关系直接做成画面时才使用 `explanatory-broll`。切入和退出跟随声音含义、动作与观看所需时长，不由句子数量决定。

## 二、场景保存导演判断，不复制时间线

每个场景把不可随创意返修漂移的依据和可修改提案分开保存。稳定层包含 `segment_id`、当前来源版本的 `source_refs`、内容目的、确认旁白引用、`required_readable_result`、时长来源与估算及外部生成 job id；创意层使用 `creative_proposal` 保存视觉想法、构图、素材路线、素材怎样进入画面、准备—主动作—依赖跟随—稳定停顿的运动因果、关键状态和前后承接。创意提案可以返修，但内容依据只有内容真源产生新版本时才能改变。

相邻且共享视觉逻辑的场景由顶层 `authoring_groups` 连续覆盖。一个组交给同一个外部 Agent 或创作者在完整上下文中设计和回看；实际渲染、缓存与重做仍按场景或构建单元执行。组大小由语义连续性决定，不按固定镜头数量机械切分。

`visual_plan` 只保存画面职责和已经接受的实现：

- `source_kind`：`human`、`screen-recording`、`evidence`、`explanatory-broll` 或 `packaging`。
- `source_ids`：现有真人、录屏或证据素材的正式 source id；解释型 B-roll 和包装通常为空。
- `relationship_kind`：流程、阶段、层级、因果、工具链、比较、拆解、指标、前后证据或布局；只有关系画面需要它。
- `placement_mode`：全屏、真人分屏或透明叠加。
- `aspect_ratio`：16:9、9:16 或 1:1。
- `selection_reason`：为什么当前来源与结构适合这一段。
- `realization`：解释型 B-roll 或包装的实际实现。`recipe` 只是一种语义骨架和可用回退；项目需要更强画面时可以改为项目专用 `editable-media v6` 包。真人、录屏与证据场景保持 null。

真人、录屏和已有证据必须绑定素材账本 source id。证据由外部任务生成时，导演阶段可以暂时没有 source id，但必须有 `generation_job_ids`；任务下载、校验并入账后，时间线再显式采用返回的 source id。

计划不保存绝对起止时间、轨道、转场、素材入出点、音量曲线或最终镜头顺序。真实语音、原片或固定规格到位后，MediaFlow Pro 或当前视频项目仍是时序和装配的唯一真源。每个 `source_ref` 使用 `<source_id>@<source_version>#<位置>`，确保导演判断能回到当前内容版本。

## 三、正式生产入口

导演输入必须把已确认内容、完整旁白、内容 brief、发音、出镜边界、连续创作组、每段可读结果和创意提案一次交给实际创作者，不能把“原始要求”“设计摘要”“镜头 checklist”分层转述到只剩通用风格词。生产者随后绑定真实内容；尚无项目专用实现的关系画面才物化配方骨架：

```powershell
node scripts/create-video-direction-plan.mjs `
  --project <项目目录> `
  --source <已确认内容文件> `
  --draft <导演输入.json>
```

生产者建立内容寻址快照，计算导演输入与旁白哈希，按 `schemas/video-direction-plan.v3.schema.json` 生成唯一计划。解释型 B-roll 和包装画面会调用 shot-recipe v2 生产者，按来源、关系、布局和比例唯一选择一个可运行骨架，并把 selection、网页包、scene、variant 和哈希绑定回计划；它不会把自动选中写成已经看过实际效果。相同输入幂等复用；来源、版本或初始导演输入变化时拒绝静默覆盖。

校验命令：

```powershell
node scripts/validate-video-direction-plan.mjs `
  <项目目录>/video-direction-plan.json
```

验证器沿真实边界读取源快照、素材账本、创作组、创意提案、selection 或项目专用 editable-media 包、manifest、场景和变体；消费端手写 recipe id、假 selection、项目外目录或没有实际包哈希的“已完成”不能通过。

实际创作者先查看关键状态和同一创作组的连续预览，再给出简短 `accepted` 或 `revised` 结论。接受现有配方，或采纳项目专用包：

```powershell
node scripts/review-video-scene-realization.mjs `
  --plan <项目目录>/video-direction-plan.json `
  --segment <segment id> --status accepted `
  --summary <查看实际画面后的结论>
```

若结论是 `revised`，必须同时提交已经改过源码的项目专用包和带 `revision_reason` 的新提案；脚本校验 editable-media、scene、variant、比例与整包哈希，保留上一版计划，再原子替换活动计划。只改评语、只改 JSON 提案或仍提交相同包都不算返修：

```powershell
node scripts/review-video-scene-realization.mjs `
  --plan <项目目录>/video-direction-plan.json `
  --segment <segment id> --status revised `
  --summary <返修结论> `
  --package <项目内 editable-media v6 包> `
  --scene <scene id> --variant <variant id> `
  --proposal <返修后的 creative_proposal.json>
```

## 四、进入制作

1. 真人、录屏、图片、证据和声音先由 `media-sources.json` 管理，再由视频时间线显式采用。
2. 外部模型或服务生成的场景完成费用、幂等、远程恢复、下载校验和入账；导演计划只引用 job id。
3. 解释型 B-roll 先由同一创作者查看与返修；只有 realization 已绑定当前实际包的 review，Studio 才会用真实声音或视频时间线的 timing projection 接入实际帧范围。
4. 用户改变核心主张、旁白、来源版本、画面来源或出镜方式时重建计划；只改变剪切点、转场和混音时修改活动时间线。

## 五、检查

- 源快照、导演输入与确认旁白哈希是否和实际一致？
- 主张、支撑、事实、风险和场景是否都能回到当前来源版本？
- 每个场景是否同时写清不可变依据、停住仍能读懂的结果和可返修创意提案？连续创作组是否按场景顺序完整覆盖而没有按固定数量切碎？
- `visual_plan` 是否明确选了画面来源、关系、布局、比例、理由和实际 realization？
- 真人、录屏和现有证据是否绑定正式素材；待生成证据是否绑定 job id？
- 配方 selection 是否由生产者生成，或项目专用包是否位于项目内；真实包、scene、variant、比例和哈希是否仍成立？
- 同一创作者是否实际查看关键状态与连续预览；revised 是否真的改变了包源码并保留返修原因？
- 计划是否只描述语义和导演职责，没有复制剪辑时间线？
- 发音表是否只改变读法；主要内容变化是否已经确认？
