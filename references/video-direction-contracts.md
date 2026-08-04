# 确认内容的视频导演合同

用户已经确认内容或旁白，并明确要求把它制作成需要新视觉导演的视频时，建立项目唯一的 `video-direction-plan.json`。只有现成脚本直接剪辑、只要分镜建议或内容尚未确认时，不为形式完整增加此文件。

## 一、先锁定内容与出镜边界

内容文件仍是唯一内容真源。v2 计划保存不可变快照、字节数、SHA-256、`source_id`、`source_version`、`content_unit_id` 和 `media_script_version`；快照证明当时读取了什么，不是第二份活动文稿。

进入计划前确认受众、视频承诺、核心主张、支撑点、必要事实和风险。旁白必须为 `confirmed`，保存文本哈希和来源引用；主要删减、重排、合并或立场变化逐项记录确认。内容含义变化时先更新文案版本，再重建计划，不能用分镜掩盖变化。发音表只分开保存原文写法、实际读法和说明，不污染字幕或事实。

出镜方式只在这里确认一次：

- `human`：已有真人素材，必须引用 `media-sources.json` 中权利状态为 confirmed 的正式 source。
- `none`：没有固定主讲人物，`source_id` 必须为 null；场景仍可以使用证据、录屏、解释型 B-roll 或包装画面。

角色生成和数字人不由本合同凭空承诺；已有独立生产入口时先完成并入账，再作为正式素材进入时间线。

## 二、场景保存导演判断，不复制时间线

每个场景保存稳定 `segment_id`、当前来源版本的 `source_refs`、内容目的、确认旁白引用、时长来源与估算、外部生成 job id，以及结构化 `visual_plan`：

- `source_kind`：`human`、`screen-recording`、`evidence`、`explanatory-broll` 或 `packaging`。
- `source_ids`：现有真人、录屏或证据素材的正式 source id；解释型 B-roll 和包装通常为空。
- `relationship_kind`：流程、阶段、层级、因果、工具链、比较、拆解、指标、前后证据或布局；只有关系画面需要它。
- `placement_mode`：全屏、真人分屏或透明叠加。
- `aspect_ratio`：16:9、9:16 或 1:1。
- `selection_reason`：为什么当前来源与结构适合这一段。
- `recipe`：解释型 B-roll 或包装的活动配方绑定；导演输入可以为 null，正式生产者负责自动选择并冻结完整 selection。

真人、录屏和已有证据必须绑定素材账本 source id。证据由外部任务生成时，导演阶段可以暂时没有 source id，但必须有 `generation_job_ids`；任务下载、校验并入账后，时间线再显式采用返回的 source id。

计划不保存绝对起止时间、轨道、转场、素材入出点、音量曲线或最终镜头顺序。真实语音、原片或固定规格到位后，MediaFlow Pro 或当前视频项目仍是时序和装配的唯一真源。每个 `source_ref` 使用 `<source_id>@<source_version>#<位置>`，确保导演判断能回到当前内容版本。

## 三、正式生产入口

导演输入只写创意判断，再由生产者绑定真实内容并物化活动配方：

```powershell
node scripts/create-video-direction-plan.mjs `
  --project <项目目录> `
  --source <已确认内容文件> `
  --draft <导演输入.json>
```

生产者建立内容寻址快照，计算导演输入与旁白哈希，按 `schemas/video-direction-plan.v2.schema.json` 生成唯一计划。解释型 B-roll 和包装画面会同时调用 shot-recipe v2 生产者，按来源、关系、布局和比例唯一选择活动实现，并把 selection、网页包、scene、variant 和哈希绑定回计划。相同输入幂等复用；来源、版本、导演判断或实现包变化时拒绝静默覆盖。

校验命令：

```powershell
node scripts/validate-video-direction-plan.mjs `
  <项目目录>/video-direction-plan.json
```

验证器沿真实边界读取源快照、素材账本、selection、editable-media 包、manifest、场景和变体；消费端手写 recipe id 或假 selection 不能通过。

## 四、进入制作

1. 真人、录屏、图片、证据和声音先由 `media-sources.json` 管理，再由视频时间线显式采用。
2. 外部模型或服务生成的场景完成费用、幂等、远程恢复、下载校验和入账；导演计划只引用 job id。
3. 解释型 B-roll 进入 Gallery Studio；真实声音或视频时间线形成后，用绑定真源哈希的 timing projection 把场景接到实际帧范围。
4. 用户改变核心主张、旁白、来源版本、画面来源或出镜方式时重建计划；只改变剪切点、转场和混音时修改活动时间线。

## 五、检查

- 源快照、导演输入与确认旁白哈希是否和实际一致？
- 主张、支撑、事实、风险和场景是否都能回到当前来源版本？
- `visual_plan` 是否明确选了画面来源、关系、布局、比例和理由？
- 真人、录屏和现有证据是否绑定正式素材；待生成证据是否绑定 job id？
- 活动配方 selection 是否由生产者生成，真实包、scene 和 variant 是否仍可读取？
- 计划是否只描述语义和导演职责，没有复制剪辑时间线？
- 发音表是否只改变读法；主要内容变化是否已经确认？
