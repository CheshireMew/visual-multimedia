# 时间型媒体的项目合同

用于视频、音频、播客和带声音的无实拍动画实际进入文件制作、审核与交付时，统一素材、片段选择和交付检查的机器可读边界。它不替代媒体文案、语义片段图或编辑时间线，也不提供另一套剪辑逻辑。

## 一、三个合同各自负责什么

| 文件 | 唯一职责 | 不负责 |
|---|---|---|
| `media-sources.json` | 素材取得方式、权利、文件完整性、生成过程、声音身份、主体与裁切 | 场景或时间线采用关系 |
| `clip-selections.json` | 从真实视频或音频选择哪些区间，并留下完整语义审核与去重依据 | 镜头顺序、转场、混音和字幕样式 |
| `media-delivery.json` | 当前输出文件、检查档位、采用素材、预期规格、检测参数和人工审核状态 | 内容、构图、剪辑和编码实现 |

网页的 `editable-media.json`、视频时间线或音频项目是素材采用关系的真源。导入素材只说明候选文件已经可靠进入项目；只有消费者显式引用 `source id`，素材才算进入当前成品。禁止在 `media-sources.json` 中再保存一份场景绑定或时间线顺序。

结构分别以 `schemas/media-sources.v3.schema.json`、`schemas/clip-selections.v1.schema.json` 和 `schemas/media-delivery.v1.schema.json` 为准。新项目从 `assets/media-project-starter/` 开始，不创建第二套 `assets-manifest.json`、供应商清单或交付状态文件。

## 二、素材账本

`media-sources.json` 固定使用：

```json
{
  "protocol": "visual-multimedia-media-sources",
  "version": 3,
  "sources": []
}
```

每项素材记录：

- 稳定 `id`、媒体类型、项目相对文件路径和实际用途。
- `acquisition`：用户提供、项目自有、外部下载、外部生成或项目内动态生成，以及来源地址和取得时间。
- `rights`：`confirmed`、`pending` 或 `not-required`，以及许可、署名和条款地址。
- `integrity`：独立文件的 SHA-256、字节数和 MIME；项目内由 HTML/CSS/SVG 动态生成且没有独立文件时为 `null`。
- `generation`：可复用的生成配方，包括生成入口、模型、提示词、seed 和生成时间；不是生成素材时为 `null`。
- `speech`：供应方声音 ID、显示名称、语言、实际合成文本哈希以及是否要求精确声音身份；不是语音时为 `null`。
- `provenance_runs`：每次实际取得该素材的运行证据，任务 ID 和私有回执只保存在这里，不在生成配方中重复。
- 主体位置、各输出变体裁切和说明。

使用以下入口导入独立文件：

```powershell
node scripts/import-media-asset.mjs `
  --project <项目目录> `
  --input <本地文件> `
  --id <稳定素材-id> `
  --media-type <类型> `
  --method <取得方式> `
  --rights-status <状态> `
  --license <许可依据> `
  --usage <实际用途>
```

导入器把文件保存到 `assets/by-sha256/`，相同内容共用同一文件，已存在的同名素材不能改指其它内容。生成任务回执使用 `--capture` 一并本地化；合成语音使用 `--speech-text` 记录实际输入文本哈希。导入成功后仍要在网页清单、视频时间线或音频项目中显式采用。

使用下面的命令核对结构、真实文件、字节数和哈希：

```powershell
node scripts/validate-media-sources.mjs <项目目录>/media-sources.json
```

远程生成入口只有在当前任务已获调用授权时才使用。完整顺序是“提交任务 → 在私有状态中等待 → 下载到本地 → 校验并导入素材账本 → 在活动时间线显式采用”。候选生成完成不能自动修改成片；付费调用、上传用户素材和改变发布状态继续按各自动作边界确认。

## 三、真实片段选择

长视频、采访、课程、录屏或音频素材需要从源文件选择区间时建立 `clip-selections.json`。`maximum_clips` 只表示上限；没有最低数量、目标数量或重复补齐字段。

每个片段必须记录：

- 素材账本中的 `source_id` 和真实起止秒数。
- 片段在当前内容中的职责。
- 是否包含人物表达及对应转录文本。
- `semantic_boundary_review`：实际听取、必要的波形检查、审核状态和说明。
- 确有表达需要而重复时的明确理由。

运行：

```powershell
node scripts/validate-clip-selections.mjs <项目目录>/clip-selections.json
```

校验器会用 FFprobe 读取真实源时长，拒绝越界范围、重复文件与时间段、无理由的重复转录文本，以及没有实际听取就声称语义完整的人物表达片段。字幕标点、转写时间和自动句界只能帮助产生候选，不能替代试听。

联系表负责发现构图、主体、黑帧和大致区间，不证明动作过程、声音边界或语义完整。不得因为联系表只有少量代表帧，就把未实际听过或未检查完整区间的片段标为通过。

## 四、分级交付

`media-delivery.json` 是某一个实际输出的验收合同。使用真实选段时，`clip_selections` 指向同项目的 `clip-selections.json`；不需要选段时为 `null`。交付验证器会重新运行片段检查，并确认它与交付合同读取同一个 `media-sources.json`。所有尺寸、帧率、时长、响度目标、允许静音和允许黑场都来自当前用户、项目或平台规格，不写成跨项目默认值。

三个档位固定承担不同工作：

| 档位 | 使用时机 | 自动检查 |
|---|---|---|
| `preview` | 内容、结构、节奏和字幕迭代 | 文件存在、FFprobe、预期规格和完整解码 |
| `review` | 内部审阅、常规交付前检查 | `preview` 全部内容，加响度、异常静音和视频联系表 |
| `final` | 用户点名的正式交付 | `review` 全部内容，加全片黑场扫描和最终证据状态 |

执行：

```powershell
python scripts/verify-media-delivery.py <项目目录>/media-delivery.json
```

技术检查失败时返回非零状态，但仍尽量写出 `media-delivery-report.json` 供定位。正式交付时使用：

```powershell
python scripts/verify-media-delivery.py `
  <项目目录>/media-delivery.json `
  --require-delivery-ready
```

报告分开保存：

- `technical_ready`：文件、真实媒体流、采用素材、规格和当前档位自动检查是否通过。
- `human_review_passed`：人是否已经从头到尾看完或听完，并核对内容、节奏、字幕、同步和头尾。
- `rights_review_passed`：采用素材的账本状态以及当前项目权利复核是否都通过。
- `delivery_ready`：以上三项同时为真。

机器报告不能自行把人工审核或素材权利改成通过。`contact-sheet.jpg` 和检测数值属于审核证据，不是制作真源，也不能代替打开最终媒体。

## 五、能力案例

`assets/media-delivery-case/` 是完整的本地案例。它由素材账本中的真实头像与语音生成最终 MP4，然后让片段校验器、FFprobe、FFmpeg、联系表和交付报告读取同一批文件。运行顺序：

```powershell
node scripts/validate-media-sources.mjs assets/media-delivery-case/media-sources.json
node scripts/validate-clip-selections.mjs assets/media-delivery-case/clip-selections.json
node assets/media-delivery-case/build.mjs
python scripts/verify-media-delivery.py `
  assets/media-delivery-case/media-delivery.json `
  --require-delivery-ready
```

案例中的人工和权利状态只证明该固定案例已经检查，不得复制到新项目。新项目必须从 `pending` 开始，并在实际检查当前成品后更新。
