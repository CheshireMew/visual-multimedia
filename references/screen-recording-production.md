# 已有录屏的识别与界面指引

用于用户已经提供或授权处理的录屏，需要识别专名、双语字幕、界面指引、异常词时间复核，或提供同一次讲述的外置麦克风录音时。保持原有内容、规格与当前制作阶段；不自动改变速度、增加封面或片尾。分析报告只是原片证据，覆盖层只是图形真源，剪辑和声音始终进入当前视频时间线。

## 输入与正式入口

先按主入口创建 `artifacts/<task-id>/`，以同一个素材导入器入账录屏和麦克风录音。所有命令从代码自身位置定位 Skill 和本机配置，项目输出必须位于本 Skill 的任务目录。Python、FFmpeg、FFprobe 从 `local-media-environment.mjs` 解析；Windows OCR 使用系统已安装的 Windows.Media.Ocr 语言，不安装或调用 macOS 剪映专有库。

Agent 读取用户的原始要求、录屏真实帧和讲述、已确认主字幕及项目规格，直接判断要校正哪些词、指向哪个控件和保留哪些时间区间。分析输出不成为新的创作简报，不把标题、配乐风格或动效数量提前规定给模型。

## 先看真实屏幕

```powershell
node scripts/recording-tools.mjs analyze --project <项目目录> --source-id recording --output reports/screen.json
```

`recording-analysis.v1` 绑定原片 id、路径与哈希，保留带时间的真实帧、帧哈希、镜头运动、Windows OCR 文字与归一化位置，并提取重复出现的产品词和短界面标签。`--fps` 可调整采样密度，`--language` 选择本机已安装的 OCR 语言。只有已实际读到的屏幕文字进入词表；Agent 对照原始帧校正识别结果，不把 OCR 当作内容事实。

## 选择同一讲述音轨

本地混音的 `voice-anchor` cue 必须引用音频 source。人声仍封装在录屏里时，先用现有媒体工具提取同一音轨并统一入账，再让转写和混音引用这份选定来源；只做事实转写、尚未装配声音档案时，可以直接识别录屏 source。

用户提供同一次讲述的外置麦克风录音时，先运行：

```powershell
node scripts/recording-tools.mjs align-audio --project <项目目录> --source-id recording --voice-source-id microphone --adopt-id aligned-voice --output work/aligned-voice.wav
```

生产者从真实声音估计固定偏移，再以采样级相关性复核，按录屏范围裁切或补静音。低相关性时保留原声并报告无法对齐；该模型不校正长期时钟漂移。对齐 WAV 和报告在项目内保留，由同一素材导入器登记为新的 audio source。随后识别、时间线人声轨和混音驱动都显式引用这个 `aligned-voice`；原始录音保留，旧音轨的转写与成片不能转用到新音轨。

## 公开识别与局部复核

```powershell
node scripts/recording-tools.mjs transcribe --project <项目目录> --source-id aligned-voice --analysis reports/screen.json --language zh
```

没有独立录音时使用录屏的 source id。入口将屏幕词表作为本轮公开 `speech.transcribe` 的提示，保留实际句级与逐词结果、输入输出哈希和 SRT。短词持续数秒等异常只触发附近真实声音的重识别；只有文本唯一匹配、候选不再异常且不覆盖相邻句子的真实边界才采用候选时间，其它情况保留原结果并标记需要核听。匹配保留数字内部的小数点与分隔符，不把 `12` 和 `1.2` 当作同一句。原始回执与每次局部回执都保留。

返回的 transcript 文件是当前事实转写入口，默认为 `pending`。Agent 完成实际听音与专名、数字校正后，继续现有主字幕确认、双语派生和 `production-captions.mjs`；重识别不会改写已确认主字幕，不按文字长度估计词时间。

## 定位并制作指引

```powershell
node scripts/recording-tools.mjs guide --project <项目目录> --analysis reports/screen.json --text "导出视频" --start 3 --end 6 --output editable-media/export-guide
```

入口核对分析中的原片与帧哈希，在整个出现区间查找唯一目标，并比较位置漂移。目标缺失、同名目标不唯一、采样不足或移动过大时返回实际证据，不生成错误固定框，也不自动改成另一种动效。Agent 回到真实画面选择合适区间、提高采样密度或修订指引方式。

稳定目标生成自包含 editable-media v6 透明覆盖层，保留可编辑标签、位置、尺寸和颜色；只消费标准 runtime 的场景时间与 `window.__hf.seek`。它不重新播放或控制原片。当前视频时间线在返回的真实源区间采用覆盖层；有剪切或速度变化时由同一活动时间线换算，不能让覆盖层维护第二条剪辑时钟。普通录屏原片继续播放，指引不代替真实操作。

## 声音与结果检查

代码配乐沿主入口同时加载的 BGM 可选入口生成和入账；同一声音档案由本地渲染或公开 MediaFlow Pro 音频操作消费，不复制混音参数表。使用原生工程时，Agent 读取 `audio.inspect` 与当前轨道关系，在项目内准备 role → 实际 bus id 的映射，再执行：

```powershell
node scripts/recording-tools.mjs apply-sound --project <制作目录> --native-project <公开返回的工程路径> --bus-map reports/audio-buses.json
```

映射包含 `master` 和当前档案使用的人声、音乐职责。如果声轨仍共用主总线，先通过公开 `audio.bus.add` 建立独立总线，再用 `timeline.track.audio.route` 分配真实轨道；以当次 `describe` 和回读为准。cue 基础增益由当前时间线的片段装配承担，不能在总线上再加一次。原生避让使用工程内人声音轨的实际片段范围，先按真实说话和停顿整理片段，不能用一条含长静音的整片冒充连续讲话。命令先导出当前原生混音测量，把增益和限幅写回主总线，再导出复测；测量文件与回执保留，未达标直接报错。后续修改和导出仍走同一工程，不返回 portable timeline 双向编辑。

实际检查原片帧与指引的进入、停留和退出，听重点词与字幕是否同步，检查处理后的同一讲述音轨是否进入成片、讲话与配乐避让及停顿恢复是否成立。最终文件仍走主入口的审阅交付路径，技术通过不代替视觉、听感或用户风格判断。
