# GitHub 项目介绍视频制作

这个流程把已经确认的仓库事实和真实证据制作成一条横版项目介绍视频。它不负责读仓库、研究功能、核查数字或决定什么值得分享；这些内容必须先由用户或上游内容流程确认。正式 profile 是 `github-project-intro@1.0.0`，唯一公开入口是 `scripts/github-project-intro.mjs`。

## 一、适用边界

视频只讲清楚一个核心主张，但“一件事”不等于只说几句话。用户没有指定时长时，建议用 60 至 75 秒建立对象、给出必要证据、展示结果并收口；用户明确指定其它时长时，在 brief 中记录 `duration_user_specified: true`，再按真实旁白和整数帧计划执行。

仓库不需要有图形界面。网页或桌面 UI、终端操作、README 与文档、测试结果、生成文件、图表和实际输出都可以成为证据，只要先进入项目唯一的 `media-sources.json` 并绑定真实文件哈希。不要为了让 CLI 或库项目看起来“像产品”而伪造界面。

## 二、建立项目

默认采用“最近看到一个有意思的 GitHub 项目”银狼开场语音：

```powershell
node scripts/github-project-intro.mjs create `
  --project <项目目录> `
  --project-id <稳定项目-id>
```

只有当前确实是同日发现、并已经确认这项时间事实时，才能改用：

```powershell
node scripts/github-project-intro.mjs create `
  --project <项目目录> `
  --project-id <稳定项目-id> `
  --opening today `
  --same-day-confirmed true
```

入口会从注册表采用对应的不可变音频，写入项目素材账本和 `media-resource-adoptions.json`。如果本机没有默认注册表，使用 `--registry <目录>` 显式指定；不得重新合成一个近似开场后假装复用了注册资产。

创建后填写：

- `github-project-intro-brief.json`：仓库、观众、一个核心主张、确认事实、真实证据 source id、开场选择和输出规格。
- `github-project-intro-draft.json`：连续镜头、画面职责、真实视觉来源、银狼旁白 source id、中英文字幕和审阅承诺。

开场卡和后续网页镜头都按当前项目重新设计。参考案例只能提供视觉语言、关系和质量标准，不能继承旧项目的文案、颜色、坐标、装饰位置、人物窗或表面结构。

## 三、声音、字幕和人物窗

没有用户覆盖要求时，全部合成旁白使用精确声音 `game.honkai-star-rail.silverwolf.default`，在 `speech.synthesize` 时直接传 `speed_factor: 1.25`；不要先按 1.0 生成再在后期拉伸。除已注册开场语音外，每段旁白 source 都要在素材账本保存精确声音身份。

每个镜头同时填写中文主字幕和英文次字幕。渲染器把两层字幕烧录到真实成片，二者都以完整画布水平中心为基准。加入夜希或其它人物窗时，可编辑底片先为人物窗预留排版空间；不能通过扩大单侧字幕边距把字幕推向另一边。真实录屏无法重排时，才调整人物位置、裁切或镜头选择。

夜希不是 GitHub 项目介绍的默认组成。只有用户明确要求或当前项目已经采用时，才把注册角色资源接入画面和计划。

## 四、验证、计划和确认

先把仓库截图、录屏、输出和其余旁白导入素材账本，再运行：

```powershell
node scripts/github-project-intro.mjs validate --project <项目目录>

node scripts/github-project-intro.mjs plan --project <项目目录>

node scripts/github-project-intro.mjs confirm-plan `
  --project <项目目录> `
  --confirmed-by user `
  --evidence <用户确认的计划依据>
```

验证会拒绝占位字段、不存在的 source id、错误开场采用记录、未确认的“今天”、非银狼旁白、非 1.25 倍速合同、缺少任一语言字幕、不连续帧范围，以及网页包或素材哈希变化。计划把 brief 和 draft 的实际哈希冻结下来；确认以后不再由渲染器重写主张或重排镜头。

每个镜头的 `visual.kind` 只能选择一种真实边界：

- `media-source`：使用素材账本中的截图、图片、视频、录屏、文档画面或实际输出。
- `editable-scene`：使用项目内通过验证的 editable-media 网页包、真实 scene id、包哈希和清单哈希。

一个镜头不要同时填写两套来源。可编辑开场、界面复现或解释图优先用网页真源；真实录屏、终端和结果证据保留为媒体 source。

## 五、渲染、审阅和交付

GitHub 项目介绍继续服从通用五阶段。内容、方向和综合样片确认后，运行：

```powershell
node scripts/github-project-intro.mjs render --project <项目目录>
```

入口会自动投影 `media-build-plan.json`，按镜头缓存网页或真实素材画面，把对应真实旁白与双语字幕装配到每个整数帧单元，再通过 MediaFlow Pro 的公开时间线和 `export.sequence.build` 生成全量预览。不会建立另一套播放时钟。`reports/github-project-intro-render-run.json` 记录每步耗时、渲染或复用状态和尝试次数；局部输入改变后只重做受影响单元及必要下游。

机器检查和 Agent 完整观看分开记录：

```powershell
node scripts/github-project-intro.mjs review `
  --project <项目目录> `
  --agent-status passed `
  --agent-evidence <完整观看依据>
```

如果当前项目需要用户观看确认，再增加 `--user-required true --user-status approved --user-evidence <依据>`。只生成联系表、字幕文件或通过编码检查，不能替代完整播放。全量预览批准后运行：

```powershell
node scripts/github-project-intro.mjs finalize --project <项目目录>
```

第一次 finalize 会建立交付合同并提交最终阶段；最终阶段批准后再次运行，才会执行真实交付验证并返回 `complete`。

## 六、进度条与装饰限制

GitHub 项目介绍不因为“看起来像技术视频”就自动加入底部进度条、伪下载条、百分比、状态轨道或粉色细线。只有内容本身存在经过确认的章节节点、观众确实需要持续定位全片位置，而且该导航会贯穿主要时长时，才考虑 `video-chapter-progress` 配方。局部等待、加载或任务完成状态使用当前界面的真实反馈，不借章节进度条代替。

每个装饰元素都要能回答它承担哪项信息、结构或时间职责。回答不出来就不进入计划，不用“增强科技感”作为理由。
