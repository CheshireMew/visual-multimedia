# 文字动效制作

只有文字本身的进入、退出、替换、强调或逐字、逐词、逐行构建承担主要表达职责时，才使用本流程。普通标题淡入、整个场景的对象运动或镜头推进继续由已经确定的视觉配方与网页时间线处理，不为每段文字套用效果。

## 唯一真源

`assets/text-motion-library/effects/*.json` 是正式文字动效记录。每个真实不同的运动只有一个稳定 ID，同一记录同时保存语义用途、分段、进入与退出时间、替换顺序、确定性关键帧、使用约束和审阅状态。`catalog.json`、画廊清单和搜索结果都由这些记录生成，不手写第二份名称或参数表。

使用 `scripts/text-motion-library.mjs`：

```powershell
node scripts/text-motion-library.mjs list
node scripts/text-motion-library.mjs search "逐字 克制"
node scripts/text-motion-library.mjs get per-character-rise
node scripts/text-motion-library.mjs validate
node scripts/text-motion-library.mjs materialize per-character-rise --project <editable-media-网页包> --operation enter
```

先按当前文字的表达任务筛选 `enter`、`exit`、`replace` 或 `emphasis`，再按 `whole`、`grapheme`、`word` 或 `line` 选择分段。随后检查能量、真实字素数、实际排版行数、布局敏感性和降低运动方案。别名只帮助搜索，不证明画面中存在粒子、水墨、玻璃或其它没有写进执行配方的视觉材料。

## 制作边界

文字内容继续来自当前媒体文案。示例文字只用于画廊，不覆盖用户已经确认的标题、字幕或正文。字体、字号、颜色、字重、对齐和版式继续由项目视觉档案与网页样式负责；文字动效只控制分段、时间和运动属性。

逐字必须按用户看见的完整字素分段，优先使用 `Intl.Segmenter(..., {granularity: "grapheme"})`。逐词使用真实语言分词并保留空白与标点。逐行必须在字体加载和最终宽度成立后读取实际换行位置，不能只按换行符拆分。动态文字使用“可编辑外层 + 动画内层”：编辑器修改外层的位置、尺寸、旋转和可见性，文字动效只修改内部单元的 transform、opacity、filter、clip-path 或字距。

`text-motion-runtime.js` 不启动定时器、WAAPI 动画或第二条时间线。生产网页把场景局部毫秒数直接传给 `player.renderAt(milliseconds, operation)`；同一文字、效果、操作和时间必须得到同一组样式。播放、暂停和逐帧捕获仍全部经过 `window.editableMedia.setTime(milliseconds)` 与 `window.__hf.seek(seconds)`。

效果选择属于制作阶段。使用 `materialize` 把选中的效果记录、确定性运行时、正式绑定器、来源与许可记录，以及绑定来源哈希的 `text-motion/selection.json` 复制进当前自包含网页包，并登记到该包的 `editable-media.json.resources`。网页入口加载包内 `text-motion/text-motion-binding.js`，再用 `await TextMotionBinding.attach({host, textField, previousTextField})` 连接动画内层；绑定器会核对效果哈希、加载运行时，并把 editable-media 的场景局部毫秒数交给 `renderAt`。消费者仍只需要读取既有 editable-media v6 边界。只有当正式消费者也必须查看或更换 effect ID、分段或错峰方式时，才修改产品无关的 editable-media 合同，并同时迁移 MediaFlow Pro；不能把编辑器专用字段藏进入口 HTML。

## 审阅

先用当前真实文字检查每个效果记录声明的关键状态，再完整播放进入、保持、退出或替换过程。至少确认：

- 相同时间定位两次得到相同单元、样式和活动文字；
- emoji、组合附加符号和中文没有被拆坏；
- 逐行效果使用最终宽度下的真实行；
- 替换期间旧文字与新文字的挂载顺序符合 `replace.mode`、`overlap_ms` 和 `micro_delay_ms`；
- 降低运动时只保留必要淡入淡出或静态结果；
- 长文、过多行或高强度效果超出当前记录的建议范围时重新选型，不靠压缩字号掩盖问题。

`assets/text-motion-library/` 本身是由正式记录、正式运行时和现有 editable-media 通用运行时组成的真实画廊消费者。修改效果、运行时或目录生成逻辑后，先运行 `node scripts/text-motion-library.mjs build`，再运行 `node scripts/check-skill.mjs --browser`；该档位已经包含文字动效的确定性浏览器消费者检查，不重复单独运行同一 self-test。实际用于交付时继续按主入口已经加载的交付规则检查关键状态和最终媒体。
