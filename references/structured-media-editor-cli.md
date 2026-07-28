# 结构化媒体编辑器 CLI 协作

用于把通用可编辑网页包交给 MediaFlow Pro 或其它提供自描述 JSON CLI 的媒体编辑器继续精调、混剪、配音、加字幕和导出。网页包与编辑器都保持产品无关边界：网页包不包含产品专用代码，Skill 不读取或写入编辑器内部数据库。

## 一、先读取能力合同

对 MediaFlow Pro 先运行：

```powershell
mediaflow-cli describe
```

只根据返回的 `protocol`、`version`、`features`、`operations` 和每项 `arguments_schema` 组装请求。需要网页协作时至少确认存在 `web.import`、`web.inspect`、`web.clip.get`、`web.clip.update` 和 `web.clip.render`；缺少任一必要能力时保留网页真源并说明缺口，不猜测内部字段，也不直接改 `project.mfp`。

CLI 是一次请求一个进程的 JSON 接口。请求使用它声明的协议版本，从文件或标准输入交给 `execute --request`；响应只从标准输出读取并检查 `ok`、稳定错误码和结果。不要增加 MCP、后台守护进程或另一套任务实现。

## 二、职责分配

- Skill 首次决定内容、结构、风格、稳定图层 ID 和复杂动画。
- 编辑器项目保存网页片段当前采用的输出变体，以及每个场景的文字、图片 source id、颜色、位置、尺寸、旋转、透明度、层级、显隐、关键帧、数据快照和逐字段锁定状态。图片实际文件继续由网页包的 v2 `media-sources.json` 解析，编辑器不能把 source id 展开成另一份长期保存的绝对路径。
- AI 与人工都调用能力合同声明的 `web.clip.*` 状态操作，并带当前 `expected_revision`；自动化写入前优先调用合同提供的差异操作，发现锁定字段或修订冲突时重新读取并展示差异。
- 用户锁定的字段不由自动化修改。需要新增、删除或重构图层时回到网页源；编辑器声明 `web.asset.rebind` 时先执行 `dry_run`，按稳定 ID 检查迁移和冲突后再换版。

## 三、进入编辑器的时机

以下情况导入结构化编辑器：

- 网页画面需要与实拍、录屏、旁白、音乐或字幕混剪。
- 用户希望直接拖动图层或在属性面板中快速精调。
- 最终需要统一的视频时间线、短视频派生序列或批量导出任务。

只需要 PNG、GIF、独立网页或无声动画时继续从网页真源直接导出。不要因为 CLI 可用就增加无意义的项目步骤。

## 四、典型请求顺序

1. `web.import` 导入包含 `editable-media.json` 的本地目录，读取返回的素材 ID。
2. `timeline.get` 读取目标序列和轨道，再用合同声明的时间线操作把网页素材放入视频轨道。
3. `web.clip.get` 读取片段覆盖值和修订号。
4. `web.clip.update` 只提交本次真正改变的场景、图层或数据字段；不提交整份 HTML。
5. `web.clip.render` 生成与当前修订一致的浏览器缓存。
6. 需要预览或最终视频时使用合同中声明的 `preview.render` 或 `export.sequence`，再按 `review-and-export.md` 检查真实成品。

合同声明对应能力时，可以继续使用：

- `web.clip.keyframe.set/remove` 调整位置、大小、透明度、文字等随时间的变化和缓动。
- 使用合同声明的主题操作替换品牌变量，使用合同声明的输出变体操作选择或自动匹配比例；命令名称以 `describe` 的实际结果为准。
- `web.clip.data.update` 写入内联数据，`web.clip.data.snapshot` 从本地 JSON/CSV 固化一次性快照；不要把远程 API 变成运行依赖。
- `web.batch.create` 从记录和显式字段绑定生成多个短序列，不复制或改写 HTML。
- `web.component.install/list/import` 复用带 `component` 元数据的通用网页包。
- `web.clip.export` 从同一组场景状态派生 PNG、GIF、透明视频、普通视频或时间线覆盖层。

如果能力合同声明 `cooperative_desktop_updates: true`，桌面界面保持项目打开时也可以运行短进程 CLI。CLI 提交后，桌面端会读取同一份项目状态并刷新；双方仍需使用 `expected_revision`，冲突时重新读取并展示差异。未声明该能力的编辑器仍按其写锁规则工作，不直接操作项目数据库。

## 五、真实链路验收

验收不能由调用端手写场景状态或伪造缓存。必须让真实网页包生产场景、结构和画面，让编辑器仓储保存覆盖值，让浏览器渲染器逐场景逐帧读取，让时间线编译器消费缓存，最后从导出文件抽帧核对。至少覆盖导入失败、重复图层 ID、缺少资源、修订冲突、场景切换、输出变体切换、复制、分割、撤销、重做、短序列复制、锁定字段和缓存失效。
