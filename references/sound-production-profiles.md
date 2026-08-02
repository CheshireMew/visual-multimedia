# 声音制作档案

用于同一项目或系列需要复用声音身份、音乐与环境声选择、转场或强调音效、混音优先级以及与语义事件的同步规则时。声音档案与 `style-profile.json` 独立：视觉档案只决定画面与动效语言，声音档案只决定声音素材怎样被选择和混合；两者可以分别调整和提升版本。

## 一、进入条件

只有当前项目确实存在可复用声音判断时才建立 `sound-profile.json`。单次剪掉噪声、一次性修复爆音、某个片段的精确入点和当前成片时间线仍留在音频或视频项目中，不为了形式完整写入档案。用户只提供视觉参考时不能从画面颜色推导音乐；只提供一段音乐时也不能反向改写视觉档案。

档案只引用当前项目 v3 `media-sources.json` 中已经入账、权利为 `confirmed` 或 `not-required` 的 `audio` source id，不保存音频路径。合成旁白仍先按 `speech-synthesis.md` 生成、听音和入账；外部音乐或音效仍先完成来源、费用和权利边界。

## 二、活动结构

`schemas/sound-production-profile.v1.schema.json` 是唯一结构合同：

- `profile_id`、`name`、`scope` 和 `project_id` 说明当前档案属于项目还是系列。
- `palette` 中每条 cue 绑定一个真实音频 source id，并声明 `voice-anchor`、`music`、`ambient`、`transition`、`emphasis`、`foley` 或 `identity` 职责、采用条件、是否循环、默认增益和标签。
- `mix` 单独保存人声优先、ducking、目标响度、峰值与语义停顿规则。它不替代最终成片的逐轨自动化和交付检查。
- `motion_sync` 只把 cue 与语义事件连接，并声明在状态变化前、当下或之后触发；它不复制网页步骤或视频时间线的绝对时间。

创建档案：

```powershell
node scripts/sound-production-profile.mjs create `
  --project <项目目录> `
  --profile-id <id> `
  --name <名称> `
  --scope project
```

采用已经入账的音频：

```powershell
node scripts/sound-production-profile.mjs add-cue `
  --project <项目目录> `
  --cue-id <cue id> `
  --source-id <audio source id> `
  --role transition `
  --usage <在什么语义条件下使用> `
  --gain-db 0 `
  --loop false
```

需要人声触发音乐避让时显式写入：

```powershell
node scripts/sound-production-profile.mjs set-ducking `
  --project <项目目录> `
  --enabled true `
  --trigger-role voice-anchor `
  --target-role music `
  --reduction-db 8 `
  --attack-ms 80 `
  --release-ms 260
```

语义同步使用 `link-motion`。`semantic-event` 写可读事件名，例如“证据出现”或“结论落定”；最终网页步骤或视频时间线消费档案时再把事件解析到活动时间边界，档案不保存一份易漂移的绝对毫秒表。

## 三、继承、修改与晋升

当前项目已有声音档案时先继承，再检查新的内容、说话人、平台响度和素材权利是否仍适用。新的 cue、混音规则或同步规则只在当前项目真实使用并完成听音后，才通过 `resource-promotion-candidates.json` 提升为系列档案；原始试听、未采用版本和修改聊天不进入系列配置。

长任务在 `media-project-state.json.contracts.sound_profile` 中索引活动档案。档案变化后需要重新检查实际时间线、混音和最终成片；项目状态只保存入口，不复制 palette 或 mix。

## 四、验收

先运行：

```powershell
node scripts/sound-production-profile.mjs validate `
  --project <项目目录>
```

校验必须证明 cue id 唯一、所有 source id 真实存在且是已收口的音频、voice anchor 不循环、ducking 条件完整、运动同步引用现有 cue。随后仍要在实际音频或视频消费者中从头试听，确认档案中的采用条件、增益、避让、停顿和语义触发确实可听；只验证 JSON、波形或响度数字不能证明声音结果成立。
