# 视频字幕金句拼图

这条路径处理“从已有视频中选择可追溯金句，制作一张或多张字幕拼图”。多张图仍承接同一视频的论述，不扩展为独立静态卡、纯文字卡、社交卡或封面制作，也不负责外部研究。

默认输入视频没有烧录字幕。画面文字来自项目唯一的 `transcript.json` 与 Agent 确认的展示文本；程序只从第一条字幕对应时刻取一张原片背景帧，hero 使用这张图，下方 strip 按规格使用同一帧或纯黑背景。不能因为视频有字幕流就声称画面内已经显示字幕。若视觉检查发现用户指定原片实际带有烧录字幕，必须把 `baked_subtitles_observed` 如实写成 `true`，并在活动字幕区域确定性覆盖旧文字，否则换用无字幕原片。最终文字仍按新合同重绘，旧字幕不成为文字真源。

## 输入与真源

输入可以是本地视频文件，也可以是用户提供的视频链接；不要求原片自带字幕或用户先提供转写。用户给出链接并要求提取金句、制作拼图时，直接下载该视频并转录，不再要求用户手动下载或先指定金句。

项目必须位于 `artifacts/<task-id>/`。先用 `node scripts/media-task-workspace.mjs preflight` 和 `ensure` 做空间预检并建立任务目录，再复制 starter 的 `media-sources.json`。链接输入沿主入口加载的网络媒体下载说明，通过本机配置调用 MediaFlow Pro 的 `download.analyze`、`download.start` 和任务查询操作；下载工程由公开 `project.create` 建在 MediaFlow Pro 已配置的工程根，下载文件保留在其配置的媒体目录，回执保存到本 Skill 任务目录。完成后把真实视频通过 `scripts/import-media-asset.mjs` 导入任务，记录用户提供的来源链接；本地输入直接导入同一个素材账本。

默认用 MediaFlow Pro 当前 `describe` 声明的 `speech.transcribe` 对已入账原片生成任务内的 SRT，再由 `scripts/import-media-transcript.mjs --kind asr` 导入唯一的 `transcript.json`；已经有用户提供、带真实时间码的 SRT 时沿同一导入入口使用。ASR 只提供候选，未实际听音时 `review.status` 保持 `pending`。转录能力未就绪时准确说明缺口，不把空转写当成成功结果。

Agent 先通读完整事实转写。用户指定主题时按要求选择；否则选择值得保留的完整论述，保留必要的铺垫、转折和结论，不习惯性只摘最后几句，也不按固定句数凑内容。双语显示条尽量一行中文、一行英文；能放下一行的文字不插入手动换行，过长时按原句自然停顿拆成对应的中英组，不靠缩小字号塞入。ASR 时间段不是显示条或页面边界。核对原声并翻译；选句和对应翻译由当前 Agent 完成，不交给下载器或关键词打分脚本。需要比较第一条显示字幕范围内的共享背景时，再运行：

```powershell
python scripts/subtitle-quote-image.py candidates `
  --project <artifacts/task-id> `
  --source-id <原片 id> `
  --segment-id <第一条显示字幕的 segment id> `
  --samples 3 `
  --output reports/subtitle-quote-candidates-v1
```

候选命令只接受一个第一条字幕 segment，并只在该时间范围内部取 1–5 张图；它不再扫描全片，也不为后续字幕取帧。联系表只用于挑选最终唯一的原片背景帧；确定 `source_frame.seconds` 后，正式渲染只写回这一帧。Agent 排除闭眼、模糊、转场、嘴型尴尬和主体被裁的画面；每句展示文字仍要回到音频和转写核对。翻译只服务当前已选原句，不扩写新主张。

## 制作合同

活动规格使用 `schemas/subtitle-quote-image.v1.schema.json`。默认宽 1440、`canvas.height="auto"`，按实际文字高度紧凑拼接；内容多时分成多张竖图，不合成一张过长的图，也不为凑固定比例补高。用户明确指定尺寸时采用指定值，正整数高度只保留指定画布，其余白留在整张图底部，不分摊到字幕组之间。每页第一项为 hero，后续为满宽 strip。主画面默认完整保留，`hero_source_top=0`、`hero_source_bottom=1`；只有用户要求裁切时才改变范围，不为排版裁掉节目标题、行情条、地名、台标或原有标识。`primary_px` 和 `secondary_px` 全部页面、hero 与 strip 共用，首句不单独放大。

`pages` 按顺序保存 `{ "id": "page-1", "item_ids": ["quote-1", "quote-2"] }`，每页至少有一个 hero 和一个 strip；所有 item 必须恰好出现一次并保持原文顺序。先运行 `validate` 读取实际换行，中文和英文都计入显示行数，中英组保持成对。时间轴上连续的一段内容默认每张约 18 行（9 个单行双语组），超过时增加张数，按实际行数尽量均分，不按主题、段落或阅读节奏挪动分页点。时间轴上相隔很远的金句按各自原文区间分开成图，不混在一起凑行数；每个连续区间内部需要多张时再按行数分页，用既有 `content_units` 和 `pages` 表达，不设统一秒数阈值。多张任务显式填写 `pages`；省略它只保留单图入口，不作为长内容的默认做法。页面高度不足时增加分页，不删关键内容、缩小字号或添加凑比例的文字。

`canvas.strip_background` 只设置后续 strip 的背景：`shared-frame` 复用第一帧，`black` 直接绘制不透明纯黑。省略时保留既有的 `shared-frame` 行为；用户要求下方黑底时设为 `black`，不改变 hero、第一条字幕、文字、字号、宽度或行高。局部试用不自动成为其它任务的默认风格；修改活动规格后用同一脚本重渲染。

`content_units` 保存按原文顺序排列的完整论述；`items` 保存双语显示条，并用 `content_unit_id` 指回论述。两者均保留 `transcript_segment_ids`，需要在 ASR 段内部断句时增加 `transcript_spans`：`[{ "segment_id": "segment-0001", "start_char": 0, "end_char": 24 }]`。字符位置按 `transcript.json` 中原始 `text` 的 Unicode 字符计数，零起点、左闭右开；不是词级时间码。同一转录段可以拆成多个不重叠的条，也可以把跨段的一个句子合并。省略范围时引用整段。每条英文等于所绑定的原文范围，允许换行；中文只做对应翻译。所有所选论述的非空白字符必须完整进入成品，不遗漏、重复或调序；原始 SRT 和转录时间不改。

唯一的 `source_frame` 保存第一条字幕所引用转录段内的背景秒数、主体焦点和查看状态，各页共用，不逐条或逐页重新选帧。不新增演讲者、出处、年份、时间码或其它卡片元信息，不清除原片已有标识。中文在上、字号更大，英文紧随其下且字号更小，两者居中。脚本按实际宽度与字号测量换行和字形边界，不用固定行数限制代替上述文字安排。`source_text.baked_subtitles_expected` 固定为 `false`，其它字段保存视觉事实和处理。规格绑定原片与转写 SHA-256，真源变化后旧规格失效。

先验证再渲染：

```powershell
python scripts/subtitle-quote-image.py validate --project <artifacts/task-id> --spec subtitle-quote-image.json
python scripts/subtitle-quote-image.py render `
  --project <artifacts/task-id> `
  --spec subtitle-quote-image.json `
  --require-production-reviewed `
  --output renders/subtitle-quote-image-v1
```

程序只取一次 `shared-background.png`；每页 hero 按规格保留原画面比例，在底部放置该页首条字幕。strip 高度始终等于真实中英文字形高度、语言间距与最小上下内边距之和，连续拼接；默认上下内边距各 8px。字形坐标按实际包围盒定位，英文下伸部分完整保留，不靠加大黑边避免截字。`auto` 画布只取实际内容高度，固定画布的余白也不进入 strip。主画面不因页面比例被拉伸或裁切。`shared-frame` 裁出相应原图背景，`black` 建立不透明纯黑带，不裁切或重复原图。所有格子无外边距、无间距、无左图右文。

输出目录必须是全新目录。显式 `pages` 输出 `subtitle-quote-collage-page-01.png`、`page-02.png` 等（也支持 JPG），每页有对应检查图；省略 `pages` 保留单图文件名。目录内只保存必要原始帧、带字分区、成品、检查图与 `render-report.json`。报告记录各页尺寸、内容高度、真实换行、条高、原文范围、背景事实和每张输出哈希，只写 `technical_ready` 与生产前核对。

渲染后逐页查看原始像素和实际展示宽度，建立符合 `schemas/subtitle-quote-image-review.v1.schema.json` 的复核文件。多页用 `finals: [{ "file": "renders/subtitle-quote-image-v1/subtitle-quote-collage-page-01.png", "sha256": "<真实哈希>" }, ...]` 按输出顺序绑定全部图片；旧单图 `final`、`final_sha256` 仍可读取。复核同时绑定当前 `render-report.json`，记录整套图片的视觉、内容复核与必要用户判断，然后运行：

```powershell
python scripts/subtitle-quote-image.py finalize `
  --project <artifacts/task-id> `
  --render-report renders/subtitle-quote-image-v1/render-report.json `
  --review reports/subtitle-quote-image-review-v1.json `
  --output reports/subtitle-quote-image-delivery-v1.json
```

`finalize` 同时读取 `media-sources.json` 中当前原片的权利状态。最终图片技术就绪、生产前核对、Agent 视觉复核、内容复核、必要用户确认和权利状态全部通过，独立交付报告才得到 `delivery_ready=true`。用户尚未判断画面或原片发布权仍为 pending 时，可以交付本地候选与准确报告，但不能称为最终可交付。

交付时按页序展示全部图片，给出每张图片与完整转录 SRT 的绝对路径；完整 SRT 保留全部转录段。说明是否实际听校，按用户要求展示全文或翻译。已有转录直接交付，不为提供路径重新下载、转录或另生成未要求的字幕格式。

## 通过标准

- 原片默认按无烧录字幕处理；实际发现旧字幕时如实记录并由不透明文字带完整覆盖。最终只看到活动规格的文字。
- 唯一原片背景帧能回到素材 source id、真实哈希和第一条字幕的准确时间，人物表情与构图经过查看；报告如实区分原片背景与纯黑字幕带，纯黑条不伪称复用了原图。
- hero 按完整原片或用户指定范围保留画面和第一句字幕；后续 strip 按规格使用同一帧或纯黑背景并保持满宽，不得改成后续时间点取帧、左图右文、独立文字卡或带间隙的列表。
- 中文主字幕在上且明显大于英文副字幕；没有出处行、黄色说明行或额外英文标题。
- 原文已经听音核对，中文译文已经核对。尚未完成时可以交付视觉候选，但报告必须保持未就绪。
- 每页尺寸、字幕行数和实际换行经过查看，分页符合上面的时间区间与行数安排。条高始终等于实际字形、语言间距和最小内边距，不含固定画布余白。所有页面共用字号，没有溢出、截断、乱码或与人物五官重叠。
- 完整论述有必要上下文；显示条与转录分段独立。英文逐条等于绑定的原文字符范围，中文经过核对；翻页顺序自然，全部页面内容无遗漏、重复或调序。
- 输入视频和生成图片的使用权分别复核；源项目的开源许可不会替输入视频授予发布权。
