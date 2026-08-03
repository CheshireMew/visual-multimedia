# 时间型媒体的项目合同

用于视频、音频、播客和带声音的无实拍动画实际进入文件制作、审核与交付时，统一事实、状态与验收边界。合同不替代媒体文案、语义片段图或编辑时间线，也不保存第二份剪辑逻辑。编辑录音、访谈、音频或播客时，同时按本文件的“音频与播客制作”建立唯一音频时间线、完成内容剪辑、声音处理、混音和附属产物。

## 一、各合同各管一件事

| 文件 | 唯一职责 | 不负责 |
| --- | --- | --- |
| `generation-jobs.json` | 素材本地化前的外部生成输入、费用授权、提交锁、远程任务、回执、实际费用和入账 source id | 素材文件事实、场景排列或消费者采用 |
| `media-sources.json` | 素材、原片与代理表示、取得方式、权利、文件完整性和生成过程 | 场景绑定或镜头顺序 |
| `media-resource-adoptions.json` | 某个注册资源版本如何到达当前项目的素材账本或完整网页包 | 素材事实、网页场景或时间线采用 |
| `transcript.json` | 某一原始音视频的事实转写、时间范围、待确认词和听音状态 | 上屏字幕怎样断句与排版 |
| `clip-selections.json` | 从真实原片选择哪些区间，并引用已复核转写片段 | 镜头顺序、转场、混音和字幕样式 |
| `sound-profile.json` | 项目或系列实际采用的声音角色、采用条件、混音与语义同步规则 | 音频路径、逐轨时间线或最终听音结论 |
| `resource-promotion-candidates.json` | 已验证项目成果是否值得晋升为系列档案或注册资源的候选、证据与决定 | 原始日志、聊天记录或注册包内容 |
| `media-project-state.json` | 长任务的通用生产阶段、成果哈希、用户确认、合同入口、活动制作决策、阻塞项和下一步 | 内容、时间线、评审问题详情 |
| `media-review.json` | 对某个不可变预览或成片的制作依据、承诺检查、完整审看结论和时间码问题 | 修改实现或第二套制作状态 |
| `media-delivery.json` | 某个输出的检查档位、预期规格、采用素材、证据入口和报告位置 | 内容、构图、剪辑和编码实现 |

网页的 `editable-media.json`、视频时间线或音频项目仍是素材采用与排列的真源。导入素材只说明候选文件可靠进入项目；消费者显式引用 source id 后，素材才算进入当前成品。语义片段图只描述叙事职责，不能复制一份事实转写；项目状态只索引合同和产物，不能复制时间线；评审只描述问题，不能变成第二个任务系统。

外部生成任务只在实际使用外部供应方时建立，并以 `schemas/generation-jobs.v1.schema.json` 为唯一活动结构；已经本地化后，最终素材事实仍进入 `media-sources.json`。其余活动结构以 `schemas/media-sources.v3.schema.json`、`schemas/media-resource-adoptions.v1.schema.json`、`schemas/media-transcript.v1.schema.json`、`schemas/clip-selections.v2.schema.json`、`schemas/sound-production-profile.v1.schema.json`、`schemas/resource-promotion-candidates.v1.schema.json`、`schemas/media-project-state.v3.schema.json`、`schemas/media-stage-template.v1.schema.json`、`schemas/media-build-plan.v1.schema.json`、`schemas/media-build-report.v2.schema.json`、`schemas/media-review.v3.schema.json` 和 `schemas/media-delivery.v2.schema.json` 为准。注册资源的建立、采用与晋升另读取 `reusable-media-resources.md`，声音档案另读取 `sound-production-profiles.md`。新项目从 `assets/media-project-starter/` 开始，不创建平行的生成状态、素材清单、转写、交付状态或审核记录。

具体视频类型可以在这些基础合同之上增加自己的 draft、不可变计划和确认，但不能再定义一份专用构建报告。例如采访原声讲解型使用 `interview-explainer-draft.json`、`narration-bundle.json`、`interview-explainer-plan.json` 和独立确认：draft 负责当前内容、样式及与事实转写边界一致的原声分段译文字幕，旁白包绑定真实音频，计划冻结 profile 输入；随后投影为通用 `media-build-plan.json`，统一的 v2 构建报告证明每个单元实际生成或复用了什么、连续音频如何处理、最终如何装配。最终审阅、项目状态和交付仍回到上述通用合同，并绑定同一个成片 SHA-256。

## 二、素材、原片与代理

`media-sources.json` 固定使用 v3。每项素材除稳定 id、媒体类型、文件、用途、取得、权利、完整性、生成、声音身份和来源运行记录外，必须声明 `representation`：

- `source` 表示原始或正式采用文件。
- `proxy` 只表示某个 source 的低成本编辑表示，必须直接指向原片，记录实际生成命令与允许误差，完整继承原片权利，不能形成代理链。

导入独立文件：

```powershell
node scripts/import-media-asset.mjs `
  --project <项目目录> `
  --input <本地文件> `
  --id <稳定素材-id> `
  --media-type <类型> `
  --method <取得方式> `
  --rights-status <状态> `
  --license <许可依据> `
  --usage <实际用途>
```

导入器把文件保存到 `assets/by-sha256/`，相同内容共用同一文件，同 id 不能改指其它内容。生成任务回执使用 `--capture` 一并本地化；合成语音使用 `--speech-text` 绑定实际输入文本哈希。远程输出只有在 `generation-jobs.json` 已经保存费用授权、同一远程 job id、成功回执、实际费用和下载校验后，才能由正式任务管理器调用导入器入账；候选生成完成、素材入账和消费者采用仍是三个独立事实。

需要代理时，从账本中的原片生成：

```powershell
node scripts/create-media-proxy.mjs `
  --project <项目目录> `
  --source-id <原片-id> `
  --proxy-id <代理-id> `
  --height 720
```

脚本会真实比较原片与代理的时长、帧率、画幅、旋转和音轨数量。编辑器不能自己猜文件名或散落保存“代理对应原片”的映射，统一用：

```powershell
node scripts/resolve-media-representation.mjs `
  <项目目录>/media-sources.json `
  --source-id <原片-id> `
  --mode source|proxy
```

预览和编辑可以解析 proxy；正式 `final` 交付只能采用 source。运行 `scripts/validate-media-sources.mjs` 会核对结构、真实文件、哈希、权利继承和代理等价性。

## 三、转写事实、上屏字幕与语义片段

三者必须分开：

- `transcript.json` 是对真实原始音视频的事实记录，绑定 source id、源文件哈希和实际字幕或 ASR 输入哈希。
- 上屏字幕是时间线中的表达层，可以合并、压缩或重新断句，但不能改写事实与关键条件。
- 语义片段图描述当前声音和画面分别承担什么信息，不复制逐字转写。

已有 SRT 时用生产入口导入：

```powershell
node scripts/import-media-transcript.mjs `
  --project <项目目录> `
  --source-id <原始音视频-id> `
  --input <字幕.srt> `
  --language zh-CN `
  --kind user-subtitles
```

需要 Faster-Whisper XXL 生产 SRT 时，先读取 `structured-media-editor-cli.md`，由本轮 `mediaflow-cli describe` 声明的 `speech.transcribe` 生成真实 SRT、输入输出哈希和分段结果；Skill 不直接调用引擎可执行文件，也不把 MediaFlow Pro 设置路径写入项目。ASR 结果使用 `--kind asr`。自动转写一律从 `pending` 开始；实际听过并处理完专有名词、数字和不确定词后，才可用 `--reviewed` 与说明写入通过状态。校验命令：

```powershell
node scripts/validate-media-transcript.mjs <项目目录>/transcript.json
```

事实转写所绑定的 source 哈希变化后，选段和审阅必须失效，不能沿用旧时间码。

## 四、音频与播客制作

先确认听众、节目形式、预期时长、核心主张、说话人、现有录音、音乐与音效授权，以及是否需要章节、转写、节目说明和封面；再检查实际音频的时长、采样率、声道、编码、静音、削波、背景噪声、混响、音量差和可理解度。没有录音时，只有用户明确要求合成旁白或指定声音生产方式后才读取 `speech-synthesis.md`。需要从长录音选择区间时建立 `clip-selections.json`，转写只帮助定位，最终剪切和修复必须回到真实声音核对。

每个项目只有一个活动音频时间线，统一保存源录音与选择范围、说话人和同步关系、章节与剪切点、旁白与音乐、清理和混音处理、目标编码及导出设置。转写稿、波形预览和最终音频都是派生结果；修改回到时间线完成，不直接拼接已压缩成品建立第二个正式版本。

内容剪辑先按 `content-to-media.md` 确认节目承诺、开场、章节和收束。保留理解主张所需的提问、回答、故事、理由与转折，删除不增加含义的重复、口误、设备中断和过长空白，同时保留承担思考、节奏和情绪的停顿；章节连接语只补足无画面收听所需的人物、对象和问题语境。片头片尾服务识别与收束，不拖延进入正文，也不重复整期内容。

声音处理以可理解度为先：先清理明显故障和不可用片段，再控制稳定噪声与低频干扰、校正严重音量差，最后进行均衡、动态、响度和必要空间处理。处理不能产生明显失真、抽吸、金属噪声或人声距离突变；不同说话人保留自然差异，音乐与音效低于关键人声。严重削波、混响、串音或缺失内容无法可靠恢复时说明限制，不用合成内容冒充原声。

合成旁白从已经确认的媒体文案派生，并按 `speech-synthesis.md` 保存供应方式、声音、输入文本哈希、原始音频与实际时间信息；声音身份仍是高影响且未确认的变量时先生成短试听。生成后以实际音频时长更新章节、停顿和其它声音关系。EdgeTTS 只是用户点名或当前条件适合时的在线选择，不等同于声音克隆；GPT-SoVITS 克隆必须有合法参考声音、准确参考文本和明确使用授权。

转写和字幕从最终时间线生成或校正，章节标题与节目说明只能反映成品。播客封面、章节卡、波形动画和宣传卡片属于代码生成视觉时按 `web-visual-production.md` 建立网页真源。导出前完整试听章节连接、关键名字与数字、人声可懂度、响度变化、音乐遮挡、静音和结尾；合成旁白逐句检查专有名词、数字、停顿、重音和尾句完整性，不能只看波形或字幕。最后建立 `media-delivery.json`，用真实播放器核对文件，并按当前档位运行交付验证。

## 五、真实片段选择

需要从长视频、访谈、课程、录屏或音频选择区间时建立 `clip-selections.json` v2。`maximum_clips` 只表示上限，不设凑数目标。人物表达片段必须引用已通过听音复核的 `transcript_segment_ids`，不能在片段合同内手写另一份 transcript。

每个片段记录原始 source id、真实起止秒数、当前内容职责、转写片段引用、是否包含人物表达、语义边界审听和确有必要的重复理由。校验器用 FFprobe 读取真实源时长，并拒绝代理 source、越界、重复区间、无理由的重复表达、不完整转写覆盖和没有实际听取就声称语义完整的片段：

```powershell
node scripts/validate-clip-selections.mjs <项目目录>/clip-selections.json
```

联系表只帮助发现构图、主体、黑帧和大致区间，不能证明动作过程、声音边界或语义完整。

## 六、长任务状态与阶段确认

新的或实质重做的长视频、混合视频、音频和播客使用 `media-project-state.json` v3，并读取 `staged-media-production.md`。通用阶段固定为内容与声音、导演与制作方向、综合样片、全量代理或预览、最终母版与交付；具体视频 profile 只能生产这些阶段的成果，不能建立平行批准状态。默认每阶段提交真实文件后等待用户确认，只有用户明确授权全自动时才连续推进。短小且确定的单点修改不为形式完整经过全部阶段。

状态保存阶段、成果集合哈希、确认依据、合同入口、活动制作决策、阻塞项和下一步；内容和时间线继续留在各自真源。制作决策只记录会改变后续脚本、画面、声音、技术规格或交付的选择，必须写明影响范围、依据产物、决策主体和时间；选择被推翻时形成无环替代链，不覆盖历史，也不让已替代决定继续生效。项目采用过注册资源、建立声音档案或产生晋升候选时，分别填写相应合同入口，没有时为 `null`。

上游内容变化使受影响阶段和全部下游失效，未受影响且已批准的上游继续有效。综合样片必须使用真实素材、真实声音和主要合成元素；人物口播或多版式视频要覆盖实际重复出现的版式家族，不能用一张静态图代表整条生产链。

```powershell
node scripts/validate-media-project-state.mjs `
  <项目目录>/media-project-state.json
```

## 七、结构化审阅

先冻结一个不可变的 review 或 final 文件，再完整观看或试听并写 `media-review.json`。评审时先记录问题，不边看边改；修改完成后生成新文件或新哈希，再重新完整审看。旧评审只能证明旧文件。

问题的规范时间使用秒；帧范围只是按当前帧率推导的辅助定位。每个问题写清严重度、类别、开始和结束时间、相关时间线元素 id、可观察证据和精确改动要求。精确改动要求至少说明要改什么；涉及动画或层级时补充改前值、改后值、持续时间、缓动、层级、不变量和不受影响的对象，避免“更自然”“再高级一点”之类无法执行的反馈。

```powershell
node scripts/validate-media-review.mjs <项目目录>/media-review.json
```

`media-review.json` v3 先用 `review_basis` 保存计划、确认、构建报告、机器报告或交付合同的项目相对路径、文件哈希和整个依据清单摘要。`promise_checks` 的每一项必须通过 `basis_artifact_id + source_pointer` 指回其中一份 JSON 依据，并原样保存该位置的 `expected_value`；依据文件、承诺值或成片变化后，旧评审立即失效。`machine_review` 只记录编码、帧数、黑场、静音、响度、字幕交付方式等自动检查及其报告哈希；`agent_review` 记录 Agent 对同一媒体的完整观看方法和结论；`user_confirmation` 只在当前项目要求用户观看确认时决定能否正式收口。失败的承诺检查必须关联可处理 finding；`passed` 必须绑定当前媒体哈希和当前依据摘要，全部承诺检查完成，机器检查与 Agent 全片审看分别通过，所需用户确认已经完成，而且不存在未关闭问题。联系表和检测数值是证据，不等于完整观看；机器检查通过也不能表述成视觉效果通过。

## 八、分级交付

`media-delivery.json` v2 是单个实际输出的验收合同。它必须指向素材账本，并按实际项目指向转写、选段和评审；跨多轮项目再指向项目状态，短任务使用 `null`。结构化评审同样只在存在项目状态时反向绑定它。这些入口必须彼此读取同一个账本和同一份事实转写。所有尺寸、帧率、时长、响度、允许静音和允许黑场来自当前用户、项目或平台规格，不成为跨项目默认值。

每个交付必须同时声明可编辑性：

- `editable_native` 表示交付中确有可继续编辑的原生项目文件，合同保存它的路径和 SHA-256，验证器检查真实文件。
- `flat_render` 表示 MP4、音频或其它输出只保留合成结果，项目文件字段必须为 `null`，并明确列出无法反向恢复的图层、轨道、动画参数或其它限制。

扁平成片不能因为项目曾经有可编辑真源就声称自身可编辑；原生项目文件也不能只靠扩展名声明，必须真实存在并通过哈希绑定。

| 档位 | 使用时机 | 自动检查 |
| --- | --- | --- |
| `preview` | 内容、结构、节奏和字幕迭代 | 文件存在、FFprobe、预期规格和完整解码 |
| `review` | 内部审阅、常规交付前检查 | `preview` 全部内容，加响度、异常静音和视频联系表 |
| `final` | 用户点名的正式交付 | `review` 全部内容，加全片黑场、原片采用、结构化审阅和最终证据状态 |

```powershell
python scripts/verify-media-delivery.py <项目目录>/media-delivery.json
```

正式交付增加 `--require-delivery-ready`。报告分别给出：

- `technical_ready`：文件、真实媒体流、原片采用、规格和当前档位自动检查。
- `human_review_passed`：当前文件哈希绑定的结构化完整审阅是否通过。
- `rights_review_passed`：采用素材账本状态和当前项目权利复核是否通过。
- `delivery_ready`：以上三项是否同时通过。

## 九、能力案例

`assets/media-delivery-case/` 从素材账本中的真实头像与语音生成 MP4，再让转写、选段、项目状态、结构化审阅、FFprobe、FFmpeg、联系表和交付报告读取同一批文件：

```powershell
node scripts/validate-media-sources.mjs assets/media-delivery-case/media-sources.json
node scripts/validate-media-transcript.mjs assets/media-delivery-case/transcript.json
node scripts/validate-clip-selections.mjs assets/media-delivery-case/clip-selections.json
node assets/media-delivery-case/build.mjs
node scripts/validate-media-project-state.mjs assets/media-delivery-case/media-project-state.json
node scripts/validate-media-review.mjs assets/media-delivery-case/media-review.json
python scripts/verify-media-delivery.py `
  assets/media-delivery-case/media-delivery.json `
  --require-delivery-ready
```

`scripts/self-test-media-contracts.mjs` 还会真实生成代理、入账并分别解析原片与代理，证明生产者、账本边界和消费者使用的是同一关系。案例状态只证明固定案例已经检查，新项目必须从 `pending` 开始。
