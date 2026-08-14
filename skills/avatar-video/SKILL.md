---
name: avatar-video
description: "建立、校准并使用无需 Live2D 的二次元口播角色，把已确认声音与嘴形、方向、状态和视频装配对齐。Use for anime presenter assets, lipsync, tracking, inset presenter video, or avatar-led media; not for generic video editing, static cards, audio-only work, or 3D/Live2D."
---

# Avatar Video

## 目标

建立、校准并使用无需 Live2D 的二次元口播角色，让真实语音、嘴形、朝向、状态和角色窗在同一时间轴上成立。默认交付版本化角色资源、可复核计划、角色轨或透明角色窗，以及真实预览。

本 Skill 不做通用视频剪辑、静态卡、3D 或 Live2D。仓库内资源路径相对于 Visual Multimedia 套件根目录，只读取角色生产所需资源。

## 工作方式

先确认使用已有注册角色还是建立新角色，读取角色母版、方向和嘴部联系表、校准视频、真实语音、目标构图与遮挡要求。用户提供的角色外观或声音尚未确认时停在对应样稿，不从视频风格推导角色身份。

所有活动项目读取 `../../references/anime-avatar-production.md`，通过 `../../scripts/anime-avatar-project.py` 管理版本与计划，按 `plan → confirm-plan → render` 执行。正常加载器只接受当前活动协议；旧项目只经显式迁移读取，不让旧嘴形库、旧整轨渲染或隐藏兼容分支进入当前结果。

语音已存在时直接使用；需要合成或编辑声音时把确认文案交给 `$audio-production`。角色轨完成后，如果还要与实拍、录屏、字幕或完整节目装配，把透明角色窗和时间边界交给 `$video-production`；本 Skill 不接管通用剪辑。

渲染前检查嘴形开合、闭嘴段、方向、焦点、边缘、透明通道、动作边界和角色窗安全区。渲染后逐段观看，核对语音时间轴、状态切换、遮挡、字幕冲突与尾句；仅有帧数或文件存在不能证明口型成立。内置注册角色“夜希数字人”按同一活动流程使用，不走特例。

## 资源

- `../../references/anime-avatar-production.md`：当前角色协议、母版、校准、迁移、口型和角色窗完整流程。
- `../../references/speech-synthesis.md`：需要合成语音时的声音与时间标记边界。
- `../../references/structured-media-editor-cli.md` 与 `../../references/review-and-export.md`：角色窗进入结构化编辑和最终审阅时读取。
- `../../scripts/anime-avatar-project.py`、`../../scripts/render-anime-avatar.py`、`../../scripts/compose-anime-avatar-inset.py`、`../../scripts/self-test-anime-avatar-inset.py`：项目、渲染、装配和真实链路检查。
- `../../assets/anime-avatar-libraries/`：活动角色库与版本目录。

## 输出与完成

交付角色项目、确认计划、版本化角色资源、角色轨或透明角色窗、预览和检查证据。完整节目另由视频时间线交付；没有要求时不自动生成其它角色、方向、动作或平台版本。
