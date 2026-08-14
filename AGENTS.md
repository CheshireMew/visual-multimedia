# visual-multimedia 项目协作规则

## 项目定位

本仓库是媒体制作流程和通用媒体合同的生产者。`MediaFlow Pro` 是正式消费者之一，但不是本 Skill 的唯一实现工具。网页包、素材声明和确定性时间边界必须保持产品无关，不能在通用合同中写入 MediaFlow 专用字段、项目数据库结构或内部路径。

维护本仓库本身不等于启用 `visual-multimedia` Skill。除非用户明确要求使用 Skill，否则按普通仓库维护任务处理。

## 共享边界与唯一真源

- `schemas/editable-media.v6.schema.json` 是 `editable-media` v6 清单结构的唯一真源。
- `assets/web-media-starter/` 和 `assets/web-card-cases/` 是生产者真实输出及跨仓库合同案例的唯一来源。`assets/web-layout-templates/catalog.json` 是可实例化布局模板的唯一目录；模板只能引用生产者包，不能反向把案例变成默认模板或视觉源。消费端不得手写等价假数据代替这些输出。
- `window.editableMedia` 是结构化编辑状态入口，`window.__hf.duration/seek(seconds)` 是确定性逐帧时间入口。运行时、校验器和消费者必须读取同一边界，不能增加第二套时钟或恢复逻辑。
- `references/structured-media-editor-cli.md` 只记录 Skill 如何使用公开编辑器能力。MediaFlow Pro 的操作名称、参数和功能可用性以实际 `mediaflow-cli describe` 输出为真源，本仓库不得复制维护另一份 CLI 定义。
- MediaFlow Pro 内嵌的 schema 和测试案例是本仓库真源的同步快照，只能通过 `scripts/sync_visual_multimedia_fixture.py` 从本仓库单向更新。

## 何时必须联动 MediaFlow Pro

修改以下任一边界前，必须同时检查 `E:\Work\BaiduSyncdisk\Code\MediaFlow Pro`：

- `editable-media` schema、协议版本、字段语义、默认继承、场景、变体、图层、质量规则或 production 元数据；
- `assets/web-media-starter/`、作为合同案例使用的 `assets/web-card-cases/`，以及它们的入口、运行时或素材账本；
- `window.editableMedia`、`window.__hf`、随机定位、画布尺寸、透明合成或逐帧稳定性；
- editable-media 所使用的 `media-sources` 字段、`browser`、`native-underlay`、`native-audio` 管线及原片与代理解析；
- `validate-editable-media.mjs`、`editable-media-contract.mjs`、素材导入或表示解析中会改变消费端输入的行为；
- `structured-media-editor-cli.md` 中依赖的公开能力，或任何直接创建、修改、渲染、导出 MediaFlow Pro 项目的正式生产链路；
- 采访原声讲解型等 profile 对 MediaFlow Pro 工程、片段状态、帧范围、字幕或导出结果的约束。

纯媒体文案、视觉配方、声音配方、角色制作或其它没有改变上述输入输出合同的修改，不要求为了形式同时修改 MediaFlow Pro。先判断是否穿过共享边界，不得把两个仓库无条件绑成每次都一起改。

## 联动修改规则

共享边界发生变化时，这次任务必须同时完成生产者、同步边界、消费者和最终可见结果的迁移，不能只在一边留下待办。

1. 先在本仓库确定新的唯一合同，更新 schema、生产运行时、starter、真实案例、校验器和全部调用点。
2. 在 MediaFlow Pro 中运行同步脚本，更新内嵌 schema、真实生产者案例及来源哈希；不得直接手改同步副本。
3. 根据新合同一次性更新 MediaFlow Pro 的解析、项目状态、编辑操作、浏览器渲染、原生媒体管线、缓存、时间线和导出消费者。
4. 回到本仓库核对公开 CLI 能力和正式生产流程，确保 Skill 只使用 `describe` 实际声明的操作。
5. 删除旧字段、旧类型、旧 helper、旧分支、旧恢复逻辑和旧导出。需要破坏性变更时明确升级协议并一次性迁移两边，不在同一活动架构中长期并存新旧合同。

如果 MediaFlow Pro 只是扩展内部实现而没有改变公开消费合同，不反向污染通用网页包。若其它工具也消费同一协议，优先维护产品无关合同和一致性案例，不为单个消费者增加隐式猜测或降级。

## 验证分级

先根据本次实际改动、失败代价和验收主张选择验证档位；默认从直接覆盖改动的最低完整档位开始，只有目标检查失败、影响范围扩大或下列条件成立时才升级，不把最重链路机械套给所有修改。

- 只改 README、许可证、致谢、普通说明、Skill 路由文字、案例证据目录、布局模板目录或不改变运行输入输出的元数据时，运行 `node scripts/check-skill.mjs --fast`。核对相应文档、许可、资源索引和入口后停止，不启动无关浏览器或最终媒体生产。新增或修改模板实例化入口时，另用真实命令写入一个全新目录并运行活动 editable-media 校验器。
- 修改网页案例的视觉、交互、运行时、文字动效、产品宣传片网页采集、确定性时间或其它浏览器可观察结果，但没有改变共享合同和 MediaFlow Pro 消费边界时，运行 `node scripts/check-skill.mjs --browser`，并查看本次改动涉及的真实画面或关键状态。
- 修改 schema、公共运行时、正式生产者、媒体项目或交付链、跨仓库共享边界，准备发布相关运行能力，或者目标测试暴露系统性影响时，运行 `node scripts/check-skill.mjs --full`；穿过 MediaFlow Pro 共享边界时继续执行下一节的跨仓库验证。
- 修改 `scripts/check-skill.mjs` 的档位选择或调度逻辑时，分别运行 `--fast`、`--browser` 和 `--full`，证明低档位没有执行高档位链路，完整档位仍覆盖原有生产和消费结果。

三个档位是递增关系：`browser` 包含 `fast`，`full` 包含 `browser`。验证结论只覆盖实际运行的档位，不把静态检查写成浏览器或完整用户链已经成立。

## 跨仓库验证

共享边界修改完成前，至少验证以下真实链路：

1. 在本仓库运行 `node scripts/check-skill.mjs --full`，并确认 starter 与合同案例确实由生产运行时生成、能够在真实浏览器中切换场景、变体和关键状态。
2. 在 MediaFlow Pro 根目录运行：

   ```powershell
   D:\Tools\MediaFlow\.venv\Scripts\python.exe scripts\sync_visual_multimedia_fixture.py "E:\Work\BaiduSyncdisk\Code\Cheshire-skill\visual-multimedia" --destination tests\fixtures
   ```

3. 运行 MediaFlow Pro 的合同测试以及受影响的导入、网页编辑、渲染、时间线和导出测试。至少包含：

   ```powershell
   D:\Tools\MediaFlow\.venv\Scripts\python.exe -m pytest tests\v2\domain\test_editable_media_v6_contract.py
   ```

4. 使用同步后的真实生产者网页包完成一次 MediaFlow Pro 导入、项目保存、片段读取或修改、逐帧渲染、时间线消费和实际导出；查看最终画面或成片，而不是只检查函数返回值、schema 通过或缓存文件存在。
5. 修改渲染器、时钟、原生媒体合成、缓存或桌面交互时，继续运行对应专项验证和 `D:\Tools\MediaFlow\.venv\Scripts\python.exe -m scripts.verify_real_user_chain`。

不得由消费端手写 manifest、伪造缓存、mock 核心渲染链或用旧 fixture 冒充本次生产者输出。若受环境限制无法完成真实链路，必须明确报告尚未验证的边界，不能宣称兼容已经完成。
