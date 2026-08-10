# 产品功能宣传片制作

用于把已经确认的产品主张和真实功能证据制作成网页、桌面应用或移动产品宣传片。这里解决的是“怎样把功能证明给观众看”，不是市场研究、卖点发现、品牌战略或拍摄规划。没有确认的产品主张，或没有任何可复现界面、截图、录屏与结果证据时停止，不用概念动画冒充真实功能。

## 一、唯一生产链

产品宣传片使用 `product-promo@1.0.0` profile，并继续服从通用五阶段和媒体项目合同。活动事实按以下边界分开：

- `product-promo-brief.json` 冻结产品、观众、主张、必选功能、真实 source id、声音策略与输出规格。
- `product-ui-capture.json` 证明哪些页面和元素由真实浏览器取得，并把截图写入项目 `media-sources.json`。手工提供的录屏或截图仍用通用素材导入器入账。
- `shot-recipe-selections/*.json` 只冻结“为什么选这个镜头职责”及物化实现包。`reference-only` 只能提供语义启发，不能进入构建计划。
- `product-promo-plan.json` 冻结方向、功能覆盖、镜头顺序、实现包、场景、语义状态、声音和审阅承诺。
- `product-promo-plan-confirmation.json` 绑定不可变计划哈希；确认后输入改变就重新计划和确认。
- `media-build-plan.json` 是正式渲染、视频时间线和导出共同消费的通用投影。`product-promo.mjs render` 只负责执行这份计划，并复用公共 MediaFlow Pro 网页镜头与时间线边界，不建立第二套时钟。

先查看正式 profile 和可用镜头配方：

```powershell
node scripts/video-production-profile-catalog.mjs list
node scripts/product-promo.mjs list-recipes
node scripts/product-promo.mjs search-recipes 产品 功能 焦点
node scripts/product-promo.mjs get-recipe feature-focus-tour
```

配方库中的 `status` 必须逐条读取。上游 `video-shotcraft` 语义记录全部是 `reference-only`：它们保留意图、采用条件、风格差异、已知坑和来源证据，但不复制上游 TSX、音频、MP4 或截图，也不声称目标仓库已经实现。只有绑定完整 `editable-media` 网页包且通过目标校验的 `active` 风格可以物化。

## 二、建立项目和内容合同

从正式入口建立项目：

```powershell
node scripts/product-promo.mjs create-project `
  --project <项目目录> `
  --project-id <稳定项目-id>
```

随后替换 `product-promo-brief.json` 中所有占位文字。每个必选功能至少绑定一个真实 `media-sources.json` source id，并写清观众价值和可观察证明；不要把“丝滑、智能、高级”当作证据。产品主张和功能取舍在内容阶段确认，导演阶段不重新发明卖点。

```powershell
node scripts/product-promo.mjs validate-brief --project <项目目录>
```

## 三、取得真实产品证据

能通过 URL 复现的产品页面使用 `schemas/product-ui-capture.v1.schema.json` 建立采集规格。每页声明 viewport、等待条件、是否截整页以及要测量或截图的唯一 selector。采集前确认当前账号、页面状态和可公开范围正确；需要登录且无可复现会话时，由用户提供截图或录屏，不用匿名页面替代。

```powershell
node scripts/capture-product-ui.mjs `
  --project <项目目录> `
  --spec captures/product-ui-capture-spec.json `
  --output reports/product-ui-capture.json
```

脚本在真实浏览器中等待页面与字体，测量页面和元素边界，保存截图，再通过通用素材导入器写入 v3 素材账本。采集报告绑定规格、截图和 source id 的哈希。录屏、用户提供截图和正式产品素材也必须先入账；导入只证明素材进入项目，镜头计划仍需显式采用它们。

## 四、方向、镜头与实现

导演阶段先提交当前产品的方向摘要和少量 style frame，确认信息密度、产品证据在画面中的占比、字体、色彩、空间关系和运动强度。镜头配方不保存审美默认值，也不能覆盖当前产品的品牌和可读性要求。

按镜头职责搜索配方，完整读取候选的目的、采用条件、时长、能量、变体和已知坑。若候选是 `active`，先物化到项目：

```powershell
node scripts/product-promo.mjs materialize-recipe `
  --project <项目目录> `
  --recipe-id feature-focus-tour `
  --style-id semantic-focus-tour
```

物化只是复制内容寻址的网页包与生成选择记录。必须把示例内容改为当前产品真实内容，并用通用网页合同重新验证；不得直接交付 starter 示例。若最合适的候选是 `reference-only`，根据当前项目从语义重新实现完整 `editable-media` 包，接通 `window.editableMedia` 与 `window.__hf.duration/seek(seconds)`，完成真实浏览器验证后，再把该实现登记为目标原生活动配方。不能绕过状态判断，把上游 demo 路径当作本地实现。

计划中每个镜头必须绑定：选择记录及其哈希、物化包及树哈希、`editable-media.json` 哈希、真实 scene id、连续整数帧范围，以及该场景中存在的至少两个语义状态。镜头只承担一个清楚职责；需要持续阅读的标题、字幕和说明不应被景深、旋转或高速移动破坏。

功能覆盖表必须让每个必选功能指向至少一个镜头。镜头数量由证明职责决定，不按固定模板凑开场、转场和片尾。

## 五、声音与强节拍

无音乐、只用音效、音乐与音效三种策略必须在 brief 中明确。可复用的音乐、环境声、强调音和混音关系进入 `sound-profile.json`；具体切点仍由当前计划和实际声音决定。音效连接“结果出现、状态确认、切换完成”等语义事件，不复制网页绝对毫秒表。

正式 `render` 只消费已经按确认计划完成并听音验证的声音结果。`none` 会为剪辑器生成不可听的结构性静音轨，保证视频单元能够稳定组装；`sfx` 或 `music-and-sfx` 在连续混音母带尚未生成和验证时必须停止，不能用这条静音轨冒充计划中的实际声音。

只有用户已经确认音乐要强驱动剪辑时才分析节拍：

```powershell
node scripts/analyze-music-beats.mjs `
  --project <项目目录> `
  --input <素材账本中的音乐文件> `
  --output reports/music-beats.json
```

分析记录真实音频哈希、解码方法、BPM、相位、置信度和节拍点。低置信度结果必须人工听音复核；确认网格确实可用后运行 `node scripts/analyze-music-beats.mjs --project <项目目录> --confirm --analysis reports/music-beats.json --reviewed-by user --notes <听音依据>`，再让计划绑定更新后的文件哈希。节拍网格只是从音乐派生的剪辑证据，不能成为网页或渲染器的第二套播放时钟；最终仍把确认切点换算成通用计划的整数帧，并回放核对画面落点与听感。

## 六、计划、确认与构建投影

按 `schemas/product-promo.v1.schema.json` 写 `product-promo-plan.json`。审阅承诺必须能指回计划中的具体 JSON Pointer，例如必选功能覆盖、输出尺寸、镜头包哈希或声音策略，不能写无法自动定位的“更有质感”。

```powershell
node scripts/product-promo.mjs validate-plan --project <项目目录>

node scripts/product-promo.mjs confirm-plan `
  --project <项目目录> `
  --confirmed-by user `
  --evidence <确认依据>

node scripts/product-promo.mjs build-plan `
  --project <项目目录> `
  --stage full-preview
```

正式入口会核对 brief、profile、采集报告、节拍分析、选择记录、实现包、场景、语义状态、功能覆盖和连续帧范围；随后生成通用 `media-build-plan.json`。结构化编辑消费者只读取这一计划，不在执行时重新选择镜头、重排功能或猜测包路径。

综合样片确认后，沿正式入口继续执行：

```powershell
node scripts/product-promo.mjs render --project <项目目录>

node scripts/product-promo.mjs review `
  --project <项目目录> `
  --agent-status passed `
  --agent-evidence <完整观看依据>

node scripts/product-promo.mjs finalize --project <项目目录>
```

`render` 按镜头生成可缓存单元，经 MediaFlow Pro 公开时间线装配成完整预览，并写入通用构建报告和 `reports/product-promo-render-run.json` 耗时记录。`review` 重新读取真实成片、构建报告和审阅承诺，生成联系表，同时把机器检查与 Agent 完整观看分开记录。`finalize` 只接受绑定当前成片哈希且已经通过的评审；第一次调用提交最终阶段，批准后再次调用才完成真实交付验证。

## 七、阶段验收与停止条件

内容阶段展示 brief 和真实产品证据；导演阶段展示方向摘要与 style frame；综合样片必须包含真实产品内容、主要镜头机制和真实声音；全量预览覆盖全部功能、字幕、声音、节奏和连续性；最终交付建立结构化审阅和交付报告。

机器检查要证明网页包可打开、随机定位稳定、帧范围连续、素材与计划哈希一致、音画和编码规格正确。Agent 仍需完整观看同一不可变预览或成片，逐项核对功能证明是否看得懂、文字是否能读、运动是否抢内容、节拍是否真的成立。用户需要观看确认时单独记录。只有 schema 通过、截图存在、联系表正常或节拍置信度高，都不能替代完整观看。

遇到以下情况立即停止：主张仍未确认；必选功能没有真实 source；`reference-only` 配方没有目标原生实现；页面采集与当前产品状态不一致；计划确认后输入哈希改变；强节拍分析需要人工复核；任一网页包无法在真实浏览器显示计划场景；最终文件尚未完整观看；公开使用权利仍未收口。
