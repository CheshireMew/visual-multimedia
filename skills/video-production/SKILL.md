---
name: video-production
description: "剪辑和制作实拍、访谈、录屏、产品功能宣传片、GitHub 项目介绍与素材解说视频，保留可修改时间线并检查真实成片。Use for existing-footage or mixed-media video production and the bundled production profiles; not for static cards, standalone web animation, audio-only work, research, or publishing."
---

# Video Production

## 目标

把实拍、访谈、讲课、录屏、产品界面、仓库证据或其它现有素材剪成可继续修改并能真实播放的成片。产品功能宣传片、GitHub 项目介绍、采访原声讲解和素材解说是同一视频能力下的生产档案，不拆成彼此重复的 Skill。

本 Skill 不制作普通静态卡、不把独立网页动画当作视频剪辑、不研究主题，也不上传或发布。仓库内资源路径相对于 Visual Multimedia 套件根目录，只读取选中生产档案所需的文件。

## 工作方式

先核对原片、事实转写、允许使用的片段、核心主张、旁白与字幕草稿、目标时长和交付规格。观众会看到或听到的现成文案尚未明确确认时，先使用 `$clean-copy` 检查并等待确认；不能借视频制作从零改写立场或补事实。

用户未另行指定的带合成旁白视频，默认显示中英文双语字幕；原语言为主层、译文为次层。需要生成旁白时默认使用已注册声音 `game.honkai-star-rail.silverwolf.default`，通过 `speech.synthesize` 以 `speed_factor: 1.25` 生成。现有真人原声、用户指定声音、语速、字幕语言或无字幕要求覆盖默认值。

先选择一个生产档案并停在它规定的最早确认点：

- 普通实拍、访谈、讲课和录屏剪辑读取视频后期路线。
- 产品功能宣传片读取 `../../references/product-promo-production.md`，由真实界面、操作和结果证明主张。
- GitHub 项目介绍读取 `../../references/github-project-intro-production.md`，执行 `create → validate → plan → confirm-plan → render → review → finalize`。
- 采访原声讲解读取 `../../references/interview-explainer-production.md`，执行 `plan → confirm-plan → render → review → finalize`，并通过 `list-profiles` 选择活动档案。
- 素材解说读取 `../../references/source-video-commentary-production.md` 和 `source-video-commentary@1.0.0`，先分析原片职责，再决定旁白、原声床和选段。
- 参考视频对齐只读取用户指定区间和层级，不把参考内容、风格、运动与精确回放混为一谈。

视频项目以 `media-timeline` v1 为产品无关真源；MediaFlow Pro 已配置且本轮能力探测支持所需操作时才迁移为 `project.mfp`。网页动画或动态图形由 `$web-motion` 生成后，只把真实文件、时间边界和采用记录交给视频时间线。二次元角色由 `$avatar-video` 交付角色轨或透明角色窗。需要独立合成或编辑声音时才调用 `$audio-production`，不能因为视频有声音就加载全部音频流程。

新项目或实质重做按 `../../references/staged-media-production.md` 的阶段提交真实成果并停止；小范围修改只使最早受影响层和必要下游失效。旁白时长来自实际声音，已有素材边界来自真实帧；不靠重复镜头、无关慢放或手写估时填满固定时长。

导出前查看原片联系表、关键剪辑边界、字幕最密处、网页插入点、音画同步、音乐与人声、结尾和黑帧。正式 MP4 默认使用移动端友好的 H.264、yuv420p、BT.709、偶数宽高和 faststart。机器报告不能代替从头到尾实际观看。

## 资源

- `../../references/video-post-production.md`、`../../references/media-project-contracts.md`、`../../references/staged-media-production.md`：普通视频时间线、项目合同和阶段确认。
- `../../references/product-promo-production.md`、`../../references/github-project-intro-production.md`、`../../references/interview-explainer-production.md`、`../../references/source-video-commentary-production.md`：四类活动生产档案。
- `../../references/reference-video-alignment.md` 与 `../../references/subtitle-production.md`：参考对齐和字幕生产。
- `../../references/production-providers.md`、`../../references/video-direction-contracts.md`、`../../references/review-and-export.md`：提供方、导演计划和正式审阅。
- `../../assets/video-production-profiles/`：活动档案与版本目录。
- `../../scripts/media-timeline.mjs`、`../../scripts/standard_video_delivery.mjs`、`../../scripts/interview-explainer.mjs` 和各档案同名入口：实际规划、渲染、审阅与交付。

## 输出与完成

交付活动时间线或原生工程、采用的素材与文案版本、预览或成片、字幕与声音文件，以及绑定当前文件哈希的构建、审阅和 `media-delivery` 报告。用户没有要求时不生成平台标题、封面变体、短版或发布动作。
