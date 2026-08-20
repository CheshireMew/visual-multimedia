# 视频字幕金句拼图

这条路径只处理“从一条已有视频中选出可追溯金句，并制作一张紧凑连续画面拼图”的明确请求。它是从视频素材派生的窄范围静态交付，不恢复独立静态卡、纯文字卡、轮播图、社交卡或封面入口，也不负责从长材料研究什么值得分享。

默认输入视频没有烧录字幕。画面文字来自项目唯一的 `transcript.json` 与 Agent 确认的展示文本；程序只从第一条字幕对应时刻写回一张共享背景帧，hero 与后续所有 strip 都复用这张图，再沿字幕区域裁成连续拼图。不能因为视频有字幕流就声称画面内已经显示字幕。若视觉检查发现用户指定原片实际带有烧录字幕，必须把 `baked_subtitles_observed` 如实写成 `true`，并在活动字幕区域确定性覆盖旧文字，否则换用无字幕原片。最终文字仍按新合同重绘，旧字幕不成为文字真源。

## 输入与真源

项目必须位于 `artifacts/<task-id>/`。先用 `scripts/media_task_workspace.py` 做空间预检，再复制 starter 的 `media-sources.json`，通过 `scripts/import-media-asset.mjs` 导入原片。默认用 MediaFlow Pro 当前 `describe` 声明的 `speech.transcribe` 生成 SRT，再由 `scripts/import-media-transcript.mjs` 导入唯一的 `transcript.json`；环境没有该能力时，可以导入用户提供、带真实时间码的 SRT。ASR 只提供候选，未实际听音时 `review.status` 保持 `pending`。

Agent 先通读事实转写，按用户已经确认的主题或明确选择标准形成完整观点，再决定每个观点需要几条显示字幕。需要比较第一条显示字幕范围内的共享背景时，再运行：

```powershell
python scripts/subtitle-quote-image.py candidates `
  --project <artifacts/task-id> `
  --source-id <原片 id> `
  --segment-id <第一条显示字幕的 segment id> `
  --samples 3 `
  --output reports/subtitle-quote-candidates-v1
```

候选命令只接受一个第一条字幕 segment，并只在该时间范围内部取 1–5 张图；它不再扫描全片，也不为后续字幕取帧。联系表只用于挑选最终唯一的共享背景帧；确定 `source_frame.seconds` 后，正式渲染只写回这一帧。Agent 排除闭眼、模糊、转场、嘴型尴尬、主体被裁和原片已有大段文字的画面；每句展示文字仍要回到音频和转写核对。翻译只服务当前已选原句，不扩写新主张。

## 制作合同

活动规格使用 `schemas/subtitle-quote-image.v1.schema.json`。输出宽度可配置，默认 1440；`height` 必须是 `auto`，不设置 3:4、9:16 或其它目标成品比例。主画面高度保留原片裁切比例；后续每条 strip 的高度只等于该条中英文实际排版高度加 `vertical_padding_px` 指定的最小上下内边距。单行内容不得占用固定高度字幕带，只有真实换行才允许该条增高。第一项是 hero，后续项是满宽 strip；显示行数量由内容和可读性决定。`primary_px` 和 `secondary_px` 对 hero 与所有 strip 一视同仁，禁止第一句单独放大。

`content_units` 保存按原片时间排列、语义完整的观点及其全部事实转写段；`items` 保存实际显示行，并用 `content_unit_id` 指回所属观点。同一观点可以因参考版式与可读性分成多行，但每个转写 segment 只进入一行，全部观点段都必须进入成品。这样程序核对的是“观点—显示行”关系，不再用固定行数冒充信息量。英文副字幕完整保留每行绑定的转写原文；中文主字幕只做对应翻译。可以选择一段足够丰富的连续论述，也可以选择多个时间点，始终按转写时间排列。

每个 item 只保存所属观点、一个或多个转写 segment id、中文主字幕和英文小号副字幕，不保存各自取帧时间或焦点。唯一的 `source_frame` 保存第一条显示字幕范围内的共享背景秒数、主体焦点和该帧查看状态；不显示演讲者、出处、年份、时间码或其它卡片元信息。中文在上、字号更大，英文紧随其下且字号更小，两者居中显示。`source_text.baked_subtitles_expected` 固定为 `false`，`baked_subtitles_observed` 保存视觉事实，`existing_text_handling` 保存实际处理。规格同时绑定原片与转写 SHA-256，任一真源变化后旧规格失效。

先验证再渲染：

```powershell
python scripts/subtitle-quote-image.py validate --project <artifacts/task-id> --spec subtitle-quote-image.json
python scripts/subtitle-quote-image.py render `
  --project <artifacts/task-id> `
  --spec subtitle-quote-image.json `
  --require-production-reviewed `
  --output renders/subtitle-quote-image-v1
```

程序只用 FFmpeg 在 `source_frame.seconds` 写回一次 `shared-background.png`。hero 按 `hero_source_top`–`hero_source_bottom` 裁切这张共享帧并在底部放置一条紧贴文字的字幕层；后续各条继续复用同一张共享帧，先测量统一字号下的真实中英文行数和高度，以文字总高加最小上下内边距得到该条最终高度，再围绕 `strip_source_center_y` 裁出与这个高度相符的背景。程序不得为后续字幕重新取帧，不得为 strip 预留固定画面带，也不得在相邻文字之间留下没有信息作用的大块背景。所有格子无外边距、无间距、无左图右文、无独立纯色文案区。输出目录必须不存在；每次修改使用新目录，不覆盖已检查版本。渲染目录只保存一张共享原始帧、带字分区、最终 JPG 或 PNG、检查图和 `render-report.json`。报告记录完整观点与显示行的对应、共享帧时间和哈希、真实文字高度、上下内边距、最终条高、裁切范围和输出哈希；它只写 `technical_ready` 与生产前核对，不写 `delivery_ready`。

渲染后打开最终图片原始像素和检查图，建立符合 `schemas/subtitle-quote-image-review.v1.schema.json` 的复核文件。它必须绑定当前 `render-report.json` 与最终图片 SHA-256，分别记录 Agent 视觉复核、内容复核和必要用户确认。然后运行：

```powershell
python scripts/subtitle-quote-image.py finalize `
  --project <artifacts/task-id> `
  --render-report renders/subtitle-quote-image-v1/render-report.json `
  --review reports/subtitle-quote-image-review-v1.json `
  --output reports/subtitle-quote-image-delivery-v1.json
```

`finalize` 同时读取 `media-sources.json` 中当前原片的权利状态。最终图片技术就绪、生产前核对、Agent 视觉复核、内容复核、必要用户确认和权利状态全部通过，独立交付报告才得到 `delivery_ready=true`。用户尚未判断画面或原片发布权仍为 pending 时，可以交付本地候选与准确报告，但不能称为最终可交付。

## 通过标准

- 原片默认按无烧录字幕处理；实际发现旧字幕时如实记录并由不透明文字带完整覆盖。最终只看到活动规格的文字。
- 唯一共享背景帧能回到素材 source id、真实哈希和第一条字幕的准确时间，人物表情与构图经过查看；报告证明所有 item 使用同一个背景帧哈希。
- hero 保留完整人物和第一句字幕；后续 strip 全部重复第一条的背景画面并保持满宽，不得改成后续时间点取帧、左图右文、独立文字卡或带间隙的列表。
- 中文主字幕在上且明显大于英文副字幕；没有出处行、黄色说明行或额外英文标题。
- 原文已经听音核对，中文译文已经核对。尚未完成时可以交付视觉候选，但报告必须保持未就绪。
- 最终文件以实际自动高度检查；每条 strip 的高度必须精确等于该条文字总高加上下内边距，不能出现无用途的大块背景。第一句和后续句使用同一组中英文字号，文字没有溢出、截断、乱码、替换字体或与人物五官重叠。
- 信息量由完整观点承担；显示行可以按参考版式拆分同一观点，但不能把行数写成观点数量。英文逐行等于所绑定的事实转写，中文译文经过核对。
- 输入视频和生成图片的使用权分别复核；源项目的开源许可不会替输入视频授予发布权。
