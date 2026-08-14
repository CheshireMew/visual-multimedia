---
name: web-motion
description: "把已经确认的内容制作成可编辑网页动画、动态图解、GIF、短动画或解释型 B-roll，并从同一确定性时间线预览和导出。Use when meaning depends on state change, sequence, motion, or interaction; not for ordinary static cards, existing-footage video editing, audio, or research."
---

# Web Motion

## 目标

把需要“变化过程”才能成立的内容做成可编辑网页动画、动态图解、GIF、短动画或解释型 B-roll。默认保留一份网页真源和一条可确定定位的时间线，再从它派生用户点名的媒体。

本 Skill 不负责普通静态卡、已有实拍素材剪辑、音频节目或主题研究。仓库内资源路径相对于 Visual Multimedia 套件根目录，只按当前路线读取。

## 工作方式

确认内容真源、受众、输出比例、播放方式和真实时长来源。观众可见的标题、标签、字幕或旁白草稿尚未明确确认时，先交给 `$clean-copy` 检查并等待它自己的确认；本 Skill 不再维护 AI 句式清单。

正式实现前提交一次可确认方案：准确可见文案、场景或状态顺序、运动载体、开始—变化—结果、画布规格、字体与配色方向、需要的真实素材和来源，然后停止。只有用户明确跳过确认才直接实现。运动必须表达推进、因果、比较、反馈或状态变化；只换标题、整页淡入或轮流出现卡片不能冒充动态图解。

将确认内容拆成语义片段，每段记录新增信息、声音范围、画面职责和时间依据。使用一份 `editable-media` v6 网页真源，让 `window.editableMedia` 保存结构化状态，让 `window.__hf.duration/seek(seconds)` 提供确定性时间；手动、自动和混合播放都读取同一语义时间线，不建立第二套时钟。

根据任务只选择必要路线：文字动效读取文字动效库；技术机制变化读取语义图形运动规则；解释型 B-roll 使用已注册活动模板；只有用户明确选择 HyperFrames 时才建立独立渲染副本。需要与实拍或声音装配成完整视频时，把网页片段和真实时间边界交给 `$video-production`，不要在本 Skill 中接管现有素材剪辑。

实现后查看开始、所有关键变化与结果状态，再完整播放。检查随机定位一致、结果不会被局部循环重置、文字始终可读、镜头和对象不争夺同一 transform、GIF 或视频解码帧与浏览器源帧一致。导出失败时保留网页真源并报告具体环节，不静默换路线。

## 资源

- `../../references/web-visual-production.md`：网页真源、场景、播放与本地导出。
- `../../references/semantic-graphic-motion-production.md`：对象关系与状态变化怎样成为运动。
- `../../references/text-motion-production.md`、`../../scripts/text-motion-library.mjs`、`../../assets/text-motion-library/text-motion-runtime.js`、`../../assets/text-motion-library/text-motion-binding.js`：确定性文字动效路线。
- `../../references/explanatory-broll-production.md`：解释型 B-roll 的模板选择、真实时间投影和透明输出。
- `../../references/technical-diagram-production.md`：技术图解与稳定全貌动画。
- `../../references/hyperframes-rendering.md`：只在用户明确选择 HyperFrames 时读取。
- `../../scripts/validate-editable-media.mjs` 与 `../../scripts/render-web-media-local.mjs`：结构校验和本地正式导出。

## 输出与完成

交付网页真源、当前时间线、关键状态检查图、用户点名的 GIF/视频/透明覆盖层，以及浏览器源帧与最终文件的核对结果。没有要求时不额外制作静态卡、完整剪辑视频或其它比例。
