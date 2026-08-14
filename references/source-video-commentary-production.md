# 素材解说型视频生产

## 能力结果与适用边界

`source-video-commentary@1.0.0` 可以从一条未经处理但权利边界已经确认的源视频开始，完成素材入账、镜头与声音分析、可用转写、解说写作、选段、真实配音、背景音乐、混音、可编辑工程和最终成片。电影片段、纪录素材、游戏录像、课程、产品实拍、活动记录和录屏都属于同一种输入；profile 不建立电影专用抓取器、供应商静态资源编号或不可追踪的远程素材库。

交付结果不是单独一条 MP4。MediaFlow Pro 可用时，交付包含可重新打开的原生工程快照、通用 portable timeline、构建计划与真实构建回执、解说稿、旁白包、字幕、全量预览、完整评审和最终母版。没有 MediaFlow Pro 时，本地路线仍能用 portable timeline 完整渲染；此时 portable timeline 与项目内全部源文件共同构成可迁移的 source bundle。

采访、演讲或课程中以真实人物表达为主要证据，且结构必须围绕“关键原声—解释—关键原声”推进时，继续使用 `interview-explainer`。素材解说型视频可以保留人物原声，但不会把这一种结构强加给电影、游戏、产品实拍或旁白主导的项目。

## 五阶段生产链

完整生产按主入口已经确定的统一五阶段推进：

1. 内容与声音：`prepare` 把真实源片入账，执行媒体检查、镜头变化检测、联系表与可用转写；Agent 必须查看联系表、转写和必要的实际片段，再写 `source-video-commentary-authoring.json`，明确完整解说稿、正式选段、逐段声音职责、声音身份和可选背景音乐。用户确认 authoring 后，`synthesize` 通过 MediaFlow Pro 公开的 `speech.synthesize` 生成真实旁白；完整试听确认后，`materialize` 才生成正式解说稿、`clip-selections.json`、`narration-bundle.json` 和 `source-video-commentary-draft.json`。不能把空模板交给用户补完，也不能只提交提纲。
2. 导演与制作方向：把已确认 draft 投影成绑定真实哈希、整数帧和逐段职责的 production plan。计划确认后冻结，不让渲染器重写角度、解说、选段、声音模式或字幕来源。
3. 综合样片：使用与全片相同的 portable timeline 投影和声音混合方式，渲染 draft 指定的代表性连续片段。样片必须同时暴露源画面、旁白或原声、字幕和必要的解释画面。
4. 全量代理或预览：综合样片确认后生成完整 portable timeline、通用 media-build-plan、可编辑 MediaFlow Pro 工程或本地 source bundle、全量预览和真实 build report。
5. 最终母版与交付：机器检查之后，Agent 必须完整播放同一文件；需要用户确认时继续等待。通过后生成 media-delivery，绑定制作真源、素材账本、转写、片段选择、评审、最终文件和全部哈希。

任一上游合同哈希变化都使最早受影响阶段及下游失效，不能靠宽松解析、旧文件回退或继续使用旧工程掩盖变化。

项目还没有提交内容阶段成果时，如果仓库中的同版本 profile 得到补充，可以显式运行 `migrate-profile`。命令先把旧 snapshot 移入项目内 `archive/profile-migrations/`，再写入当前 snapshot；已经进入正式五阶段生产或已经生成 plan、timeline 的项目会拒绝迁移，避免用新合同解释旧计划。

## 逐段声音职责

每个语义片段明确选择一种声音职责，同一条视频可以任意混用：

- `narration-only`：旁白推动内容，源片声音关闭。画面可以是源片、定格或 editable scene。
- `source-only`：保留关键原声，不叠加旁白。人物表达必须引用已听音通过的 transcript 与完整语义 selection。
- `narration-with-source-bed`：旁白推动内容，同时保留低电平源片环境声。`source_gain_db` 是该片段明确确认的混音值，不从整个项目的“模式”推断。

`source-only` 不允许引用 narration segment；另外两种模式必须引用 narration bundle 中实际试听通过的 segment。源片没有音轨时不能声明需要源声。源片比旁白短时，只在 draft 明确允许的 `source-clip.freeze_when_shorter` 下冻结 selection 的最后一帧；不能循环原片、重复 selection 或擅自拉伸速度。源片比片段长时只消费 selection 范围内所需的部分。

## 唯一真源和计划边界

`media-sources.json` v3 保存所有源文件、来源、权利与哈希。`transcript.json` 保存事实转写；自动转写只有实际听音复核后才能通过。`clip-selections.json` v2 是源素材真实入点和出点的唯一真源。`narration-bundle.json` v1 保存旁白文本、声音身份、音频、时间标记、时长和试听结论。

`source-video-commentary-draft.json` 只写每个语义片段要讲清什么、引用哪个 selection、画面职责、旁白 segment、声音模式、字幕呈现和综合样片范围。它不复制源片时间码。

`source-video-commentary-analysis.json` 是绑定真实源片哈希的派生分析，保存媒体属性、候选场景、联系表和可选转写入口。候选场景始终标记为 `suggestion-only`，Agent 只有查看实际证据后才能在 authoring 中采用、调整或放弃。`source-video-commentary-authoring.json` 是写稿与选段确认对象；它保存源片建议范围，确认后由 `materialize` 投影到唯一正式 `clip-selections.json`，不会直接成为渲染时间线。

`source-video-commentary-plan.json` 冻结 profile、draft、完整解说稿、素材账本、片段选择、转写、旁白包和可选导演计划的哈希，并解析到真实文件和整数帧。它仍只引用 `clip_selection_id`，不保存 selection 的 start/end。实际节目位置由 plan 的连续整数帧和投影后的 `media-timeline.json` 负责；导入 MediaFlow Pro 后，`project.mfp` 成为唯一活动编辑状态。

背景音乐不是仓库中的不明曲库。用户或项目提供的音乐先进入 `media-sources.json`，保存权利、来源和文件哈希；authoring 再确认是否采用、是否循环、基础增益、旁白时和原声时分别降低多少，以及淡入淡出。计划绑定真实音频与时长，portable timeline 生成独立音乐轨并按片段拆分增益；音乐变化会使计划、样片和下游失效。

字幕是呈现合同，不是第二份事实转写。每条字幕必须标记 `source_kind`：`narration` 绑定旁白 segment，`transcript` 绑定已审核 transcript segment，`editorial` 表示经内容确认的解释性标题或压缩文案。烧录、嵌入或 sidecar 只改变交付方式，不改变文字来源。

## editable scene 与通用构建

解释动画、标注或补充画面使用 `editable-media` v6 网页包。draft 引用项目内 package 和可选 variant；计划绑定 manifest 与整个包的哈希。渲染前先把网页包确定性逐帧导出为项目内临时视频，再像普通视频 source 一样投影到 portable timeline。源网页包仍随项目保留，预渲染文件不是新的内容真源。

全量计划同时投影为 `media-build-plan.json` v1。每个语义 segment 是一个通用构建 unit，MediaFlow Pro 的 `export.sequence.build` 从真实时间线范围计算缓存与连续音频母版；本地路线由同一 portable timeline 生成完整文件和可核验 build report。MediaFlow Pro 不认识 commentary、电影或游戏，只消费通用素材、轨道、音量、定格、字幕、标记、预览和导出。

## 提供方与失败边界

运行前按主入口已经读取的运行时规则，用 `scripts/local-media-environment.mjs inspect` 检查本机提供方。`--provider auto` 只在 MediaFlow Pro 的 portable timeline、原生工程和导出能力真实就绪时选择它，否则选择完整本地路线；一旦本轮已经选择提供方，执行失败就停止，不在中途静默切换。

外部 Narrator 一类服务最多作为素材分析、转写、配音或可选生成供应方。它返回的任务状态、静态资源 id 或 MP4 只能作为项目素材和来源记录进入现有合同，不能取代 draft、plan、portable timeline、MediaFlow Pro 工程、评审和交付真源。

## 从原片开始的正式命令链

```powershell
node scripts/source-video-commentary.mjs prepare --project <项目目录> --project-id <id> --source <源视频> --source-id source-video --rights-status confirmed --license <权利依据> --transcription-mode auto --language zh
node scripts/source-video-commentary.mjs confirm-transcript --project <项目目录> --confirmed-by user --evidence <完整听音依据>
# Agent 查看联系表、转写和实际片段，创建 source-video-commentary-authoring.json
node scripts/source-video-commentary.mjs import-bgm --project <项目目录> --input <已授权音乐> --source-id bgm-main --rights-status confirmed --license <权利依据>
node scripts/source-video-commentary.mjs validate-authoring --project <项目目录>
node scripts/source-video-commentary.mjs confirm-authoring --project <项目目录> --confirmed-by user --evidence <完整稿、选段、声音和音乐确认依据>
node scripts/source-video-commentary.mjs synthesize --project <项目目录>
node scripts/source-video-commentary.mjs confirm-narration --project <项目目录> --confirmed-by user --evidence <完整试听依据>
node scripts/source-video-commentary.mjs materialize --project <项目目录>
node scripts/source-video-commentary.mjs validate --project <项目目录>
```

没有人物讲话、不会采用任何原声文字，或用户已提供可靠字幕时，可以按真实情况使用 `--transcription-mode skip` 或导入现成字幕；不能为了省略复核而把需要保留的人物表达改写成无转写片段。用户不采用背景音乐时 authoring 明确保存 `background_music: null`，不会自动挑选一首不明音乐。

## 验收

静态检查必须覆盖 profile catalog、分析、authoring、authoring 确认、旁白候选、draft、plan、starter、公开 CLI、计划与确认哈希、三种声音模式的互斥关系、音乐循环与避让，以及“plan 不出现 selection start/end”这一边界。上游验收必须从未入账的真实源片开始，实际生成联系表和转写，解析已注册声音并用 `speech.synthesize` 生成可解码 WAV，再把已授权背景音乐投影到时间线。完整端到端自测还要混用三种声音职责，完成内容确认、计划确认、综合样片、全量预览、完整播放式 Agent 评审和交付，并实际解码最终文件。MediaFlow Pro 就绪时还要导入 portable timeline、生成原生 `project.mfp`、重新读取工程并真实导出；不能用手写 manifest、伪造缓存或只检查文件存在代替。
