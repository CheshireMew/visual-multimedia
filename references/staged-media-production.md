# 时间型媒体的分阶段生产

用于新的或实质重做的视频、混合视频、音频和播客。只改一个明确且低成本的局部、无需跨轮确认的短任务，不为形式完整走五阶段；一旦任务需要多轮判断、多个中间产物、昂贵生成或长时渲染，就建立唯一的 `media-project-state.json` v3。

## 唯一阶段模板

`assets/media-stage-templates/time-media-production.v1.json` 是通用时间型媒体的唯一阶段模板。普通视频、无实拍视频、角色口播、访谈剪辑、采访原声讲解型、音频和播客都消费它；具体 profile 只能补充每一阶段怎样生产，不能改写阶段顺序、另存批准状态或绕过阶段门。

1. **内容与声音**：确认活动文案、原声范围、声音职责和逐段新增信息。提交 `content-contract`，可以是确认文案、节目结构、采访 draft 或其它当前内容真源。
2. **导演与制作方向**：确认镜头、网页视觉、角色、构图、动效、声音处理与输出方向。提交 `direction-package`，其中要覆盖会反复出现的版式或声音家族，不能只给抽象风格词。
3. **综合样片**：用真实素材、真实声音和主要合成元素制作一段连续样片。提交 `integrated-sample`；它验证主要生产链能否形成预期结果，不是静态效果图或假的消费端输入。
4. **全量代理或预览**：低成本生成完整时长，检查内容、节奏、连续性、字幕、声音和所有重复版式。提交 `full-preview`；不得把综合样片复制拼接成全片。
5. **最终母版与交付**：只从已经确认的完整预览和同一活动真源生成最终规格文件。提交 `final-delivery`，随后绑定评审与交付合同。

每个阶段的成果必须是项目内真实文件并记录 SHA-256。`waiting-approval` 表示已经有可展示成果，Agent 此时向用户说明本阶段验证什么、展示文件并停止。用户确认绑定的是这一组成果哈希；文件变化后旧确认不能继续使用。

从综合样片开始，只要成片包含多个可独立修改的场景、片段或角色区间，就建立 `media-build-plan.json` v1。它把活动内容/时间线合同投影为连续、稳定的构建单元，并记录每个单元的真实依赖、输出规格和装配策略；它不复制内容，也不保存 MediaFlow Pro 工程字段。构建报告统一使用 v2，逐单元记录 `rendered` 或 `reused`、缓存键、文件哈希，以及整条音频母版和最终装配是否复用。一个单元变化只改变该单元与最终装配；输出规格、共享风格或生产模块变化才使所有相关单元失效。

## 默认停止与全自动授权

默认策略是 `staged`。每个阶段提交后停止，只有当前阶段获得明确确认，下一阶段才可开始。用户说“继续”“确认”或对当前展示成果给出明确认可，可以作为批准依据；泛指整个方向的旧消息不能替代对后来变化文件的确认。

只有用户明确要求“一口气完成”“全自动完成”或等义表达时，才把策略设为 `full-auto`，并把用户授权原文或准确摘要写入状态。全自动仍逐阶段生成真实成果、检查前置条件和记录哈希，只是不在阶段间等待。用户撤回授权后立即改回 `staged`，从当前最早未确认阶段停止。

## 修改与失效范围

反馈先定位到最早受影响的阶段，再让该阶段和全部下游失效：

- 只改标题、口播内容、原声范围或节目结构：从 `content` 失效。
- 内容不变，只改构图、角色大小、画面布局、动画语言、声音处理或输出方向：从 `direction` 失效。
- 方向不变，只修综合样片的具体实现：从 `integrated-sample` 失效。
- 样片方向成立，只修全片节奏、个别镜头、字幕或连续性：从 `full-preview` 失效。
- 预览已经确认，只修最终编码、封装或交付文件：从 `final-delivery` 失效。

已经批准且未受影响的上游阶段保留，不重新询问。失效阶段不能保留活动成果集合或批准；修订后重新提交新的真实文件。一次性小改若明确只影响最终文件，可以只重做最后阶段，但仍须重新检查实际成片。

## 公开命令

新项目先有 `media-sources.json`，再建立状态：

```powershell
node scripts/media-project.mjs init --project <项目目录> --project-id <id> --media-kind video
```

提交阶段成果后，默认进入等待用户确认：

```powershell
node scripts/media-project.mjs start-stage --project <项目目录> --stage content
node scripts/media-project.mjs submit-stage --project <项目目录> --stage content `
  --artifact content-contract:document:content.md
node scripts/media-project.mjs approve-stage --project <项目目录> --stage content `
  --evidence <用户确认依据>
```

进入昂贵消费者前显式检查上游：

```powershell
node scripts/media-project.mjs assert-stage --project <项目目录> --stage integrated-sample
```

局部修改、策略切换与状态检查分别使用：

```powershell
node scripts/media-project.mjs invalidate-stage --project <项目目录> `
  --stage direction --reason <变化原因>
node scripts/media-project.mjs set-policy --project <项目目录> --mode full-auto `
  --authorized-by user --evidence <用户授权>
node scripts/media-project.mjs inspect --project <项目目录>
```

旧 v2 项目只允许通过 `migrate-v2` 一次性迁移。迁移器把原状态保存到项目 `archive/`，活动读取器只接受 v3；生产代码不得保留 v2 猜测、恢复分支或双写。

## Profile 接入规则

Profile 负责生产阶段成果，不拥有第二套阶段状态。例如采访原声讲解型的 draft 是内容成果，已确认计划是方向成果，包含真实原声、旁白、网页动画和角色窗的连续短片是综合样片，完整低成本成片是全量预览，最终规格成片是交付成果。普通视频也按相同边界提交自己的文案、导演包、样片、预览和母版。

构建单元同样属于通用边界，不属于采访 profile。普通视频可以按场景、章节或已确认剪辑段建立 `timeline-range` 单元；采访 profile 把原声段和解释段映射成同一种计划；角色窗可以作为单独 `avatar-track` 依赖进入受影响区间。执行器绑定由实际消费者保存，通用计划只引用活动合同和 source unit id。

一个 profile 的 `plan → confirm-plan → render → review → finalize` 等内部命令可以继续存在，但必须映射到通用阶段门：计划确认不能替代内容确认，完整 render 不能在综合样片尚未批准时启动，finalize 不能把同一个最终 MP4 倒填成所有历史阶段的成果。Profile 的专用合同继续保存它独有的事实；通用状态只保存阶段、合同入口、活动决策和成果哈希。

## 验证

`scripts/media_project_state.mjs` 是阶段推导和验证的唯一逻辑源，`scripts/media-project.mjs` 是公开命令入口，`scripts/validate-media-project-state.mjs` 只做 v3 验证。验证至少证明：真实文件被提交；未确认阶段确实阻止下游；每个阶段会停在 `waiting-approval`；用户确认只绑定当前成果；上游变化只使受影响阶段及下游失效；最终状态指向真实交付合同。

运行通用真实链：

```powershell
node scripts/self-test-media-project-stages.mjs
node scripts/validate-media-project-state.mjs <项目目录>/media-project-state.json
```
