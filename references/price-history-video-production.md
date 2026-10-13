# 历史价格回放视频

用于把股票、代币或其它已有真实价格序列做成连续的历史走势图视频，也可以展示“一笔本金买入后一直持有”的资产价值。参考视频决定本次画面与节奏，真实价格决定曲线和数值。Agent 使用下列公开脚本制作；不需要在产品里增加 Agent、聊天界面或模型服务。

用户已经明确要求这种视频时直接进入本功能。输入是资产、价格来源或价格文件，以及用户给出的参考和成品规格。本金、日期、报价单位和价格口径会改变结果，必须在画面和真源中写清楚。没有旁白的标题与数字走轻量媒体文字路径；用户另要旁白时沿已有主字幕和声音流程处理。配乐沿根入口已有 BGM 能力取得并进入当前任务素材账本。

## 价格与计算

正式输入 `price-history.json` 使用 `protocol="visual-multimedia-price-history"`、`version=1`，包含 `symbol`、`asset_name`、`quote_currency`、`timeframe`、`timezone`、`price_basis`、`source` 和 `rows`。`source.provider` 保存实际提供价格的交易所或数据机构，`source.collector` 记录抓取工具；Heimdall 是抓取软件，画面中的数据来源应标注币安等实际来源。`source` 还保存准确来源 URL、取得时间与实际覆盖范围；`rows` 是 `[timestamp, open, high, low, close, volume]`，时间戳单位为毫秒。制作脚本读取真实收盘价，时间严格递增且价格为正。

Heimdall 已有交易所抓取实现时，用它的 Python 环境运行薄导出入口。它只调用现有现货 K 线抓取器，不启动应用、数据库或后台采集进程，也不修改 Heimdall 代码。输入的来源仓库由 `--heimdall-root` 指定；输出根由本脚本位置决定，始终进入本 Skill 的 `artifacts/<task-id>/price-history.json`。交易所日 K 线只保留已经结束的 UTC 日；最早返回的交易日前保持没有数据，不能把代币发行日或空投价值补成成交价格。真实覆盖区间内的缺日会明确报错。

其它来源也可以按同一格式提供价格快照。股票复权、分红再投、外汇换算和持仓数量变化属于价格或投资计算口径，不能从未复权收盘价自行推导；本入口计算固定持仓数量下的价格收益。画面可按用户要求用“美元”等名称显示货币；USDT 以美元展示时注明按 1 USDT = 1 美元展示，原始交易对和报价币种继续保留在价格快照中，不把显示名称替换当成真实汇率换算。

固定持仓的计算只有一份：`数量 = 本金 / 首日收盘价`，`当日资产价值 = 数量 × 当日收盘价`，`收益率 = (当日收盘价 / 首日收盘价 − 1) × 100%`。这是假设按该价格买入并持有，不计手续费、滑点和税费；需要其它口径时先提供对应事实和计算输入。

## 制作入口

先沿现有任务工作区入口通过容量检查并建立任务，随后抓取、生成网页和导出。例如：

```powershell
node scripts/media-task-workspace.mjs preflight --task-id uni-history --expected-bytes 536870912
node scripts/media-task-workspace.mjs ensure --task-id uni-history --expected-bytes 536870912

# 用 Heimdall 已配置的 Python 运行，不下载第二套交易所依赖。
& '<Heimdall Python 的绝对路径>' scripts/fetch-heimdall-price-history.py `
  --heimdall-root '<Heimdall 仓库绝对路径>' --task-id uni-history `
  --symbol UNI/USDT --start-date 2020-09-16

node scripts/price-history-video.mjs create --task-id uni-history `
  --input '<Skill 根目录>/artifacts/uni-history/price-history.json' `
  --principal 1000000 --duration 59 --window-days 730 `
  --asset-name '$UNI' --display-currency 美元

node scripts/validate-editable-media.mjs '<Skill 根目录>/artifacts/uni-history/web'
node scripts/self-test-price-history-video.mjs --task-id uni-history

# 配乐须先经现有素材导入器入账；增益由本次真实音频实测决定。
node scripts/price-history-video.mjs render --task-id uni-history `
  --bgm-source bgm-main --bgm-gain-db '<本次实测的增益 dB>'
```

`create` 支持 `--start-date`、`--end-date`、`--asset-name`、`--display-currency`、`--title`、`--accent` 和 `--hold-seconds`；例如 `--display-currency 美元`。标题中的 `{principal}`、`{start_year}`、`{asset}` 在创建时由本次真实输入填入。已有网页只有显式 `--overwrite` 才覆盖。未指定音乐时 `render` 导出无声版；用户要配乐时沿当前任务素材账本显式引用 source id，并传入 `--bgm-gain-db` 和按需指定的 `--bgm-in-seconds`。音乐区间必须实际覆盖成片时长，不自动拉伸或循环。

画面排版沿 [轻量媒体文字](media-writing.md) 的统一规则处理。`--asset-name '$UNI'` 只决定显示名称，价格快照仍保存原始交易对。显示货币同时用于标题、金额、坐标、汇总与清单中的本金单位，计算口径继续保留原始报价币种。

网页位于 `artifacts/<task-id>/web/`，沿现有 editable-media v6 合同保留文字、布局、样式、价格表、初始本金、历史窗口和结尾停留参数。图表 renderer 使用标准 `__hf.registerRenderer` 与 `editablemediatime`，从同一个 `editableMedia` 状态计算画面；不修改公共 runtime，也不另建时钟。曲线逐步显示真实历史点，末端金额、日期与收益率使用同一个已显示日。坐标范围只读取已经显示的历史数据，结尾保持最后一个真实收盘结果。

本机已有 FFmpeg、FFprobe 和浏览器的路径由 `.env.visual-multimedia.local.json` 解析。现有 `render-web-media-local.mjs` 逐帧读取同一网页，生成 `price-history-silent.mp4`。使用配乐时，现有 `media-timeline` v1 保存网页渲染结果和音轨的装配关系，再由 `media-timeline.mjs` 生成 `price-history.mp4`。网页负责图形与数据，时间线负责声音装配；后续修改对应真源后重新导出。

## 真实核对与交付

核对最早和最后价格、日期、峰值及持仓计算；从网页中读取同一价格表，在开始、峰值、下跌、滚动边界和结尾检查实际画面。随机往返定位必须返回同一状态和同一帧；修改本金、标题与颜色后应真实反映在画面中。最后完整解码导出，检查尺寸、帧率、时长、音轨与结尾，并查看从成片解码的连续画面。

技术通过只证明数据、合同与导出成立。用户未看过成片前，视觉与配乐适配保留为待判断的验证片。交付视频、可编辑网页和必要的价格来源与计算报告，不附送额外比例或压缩包。结束时使用现有工作区 `inventory` 与 `finalize` 记录真实终态；外部交付仍只复制点名成品。
