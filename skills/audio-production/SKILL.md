---
name: audio-production
description: "编辑录音、旁白、对谈和播客，或从已确认文案合成语音，保留音频时间线并完成听音、响度和交付检查。Use for audio-only production or speech synthesis; not for video, static visuals, research, or standalone writing."
---

# Audio Production

## 目标

编辑录音、旁白、对谈和播客，或从已经确认的文案合成语音。默认保留可修改的音频时间线、原始音频和真实参数，并交付经过完整试听的目标音频。

本 Skill 不写独立文章、不研究主题、不制作画面或视频。仓库内资源路径相对于 Visual Multimedia 套件根目录，只加载当前声音路线需要的资源。

## 工作方式

先确认活动文案或录音、说话人、语言、节目结构、目标时长、声音身份、音乐和交付格式。现成口播、主持连接语或节目文案尚未明确确认时，先用 `$clean-copy` 检查并等待确认；本 Skill 不再维护另一套 AI 废话规则。短标签、发音文本和字幕文本可以做不改变含义的确定性处理。

已有录音以真实波形和听音为准，建立音频时间线，处理片段选择、停顿、噪声、响度、声道、音乐和转场。删除口误、设备中断和无意义长空白时，保留承担思考、节奏和情绪的停顿。合成语音从确认文案生成独立发音文本，保存提供方、声音、速度、原始音频和时间标记；后期不把有损成品反过来当作合成真源。

需要声音风格时读取已注册的 sound production profile；需要维护口播私人库时，分别使用口播声音、完整案例和独立口播钩子的既有入口，不把三者混成一份提示词。完整口播的新写或重组不属于本 Skill；只有用户已经提供成稿时才进入清理与制作。

新播客或实质重做按阶段提交内容样稿、声音样稿、综合样片、完整预览和正式交付；小范围降噪、切除、响度或格式转换只重做受影响步骤。完成前用耳机或可用监听从头到尾试听，核对专名、数字、断句、说话人切换、音乐遮挡、头尾和尾句完整性；响度和波形只作为辅助证据。

## 资源

- `../../references/speech-synthesis.md`：合成语音、声音解析、参数和时间标记。
- `../../references/sound-production-profiles.md`：独立声音档案与项目采用。
- `../../references/media-project-contracts.md`、`../../references/staged-media-production.md`、`../../references/review-and-export.md`：音频时间线、阶段成果和交付检查。
- `../../references/voiceover-writing.md`、`../../references/voiceover-reference-library.md`、`../../references/voiceover-hook-library.md`：只在用户明确维护或使用口播参考库时读取。
- `../../scripts/voiceover_reference_library.py` 与 `../../scripts/voiceover_hook_library.py`：口播库维护入口。
- `../../scripts/verify-media-delivery.py`：正式音频交付检查。

## 输出与完成

交付活动音频时间线、原始或合成音频、用户点名的最终格式、实际声音参数和完整试听结论。正式项目附带与当前文件绑定的 `media-delivery` 和审阅报告；没有要求时不制作视频、封面或发布材料。
