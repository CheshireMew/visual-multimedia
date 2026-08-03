# 可注册媒体资源、采用与项目成果晋升

用于用户或系列已经积累可复用照片、视频、声音、字体、图标、纹理、背景、音效、音乐或完整 editable-media 网页包，并希望后续项目能按稳定名称查找和采用时。注册资源不是项目素材账本的替代品；它只保存不可变版本与复用元数据，项目采用后仍回到当前项目原有的唯一消费者边界。

## 一、先分清三类资源

`creator-media` 保存某位创作者或系列真实拥有、已经确认权利的工作、生活、教学、出镜或环境照片与视频。它与 `assets/creator-identity/` 不同：身份资源只提供作者署名、整理说明或制作水印需要的头像、名称和角色语义，不能充当创作者全部素材库。

`production-assets` 保存不绑定某位创作者身份的字体、图标、纹理、背景、音效、音乐和其它通用制作素材。库中每项都要说明媒体类型、实际职责、权利和采用条件；不同消费者仍按素材类型处理，不能用一套“万能素材”规则替代字体加载、图片槽位、视频时间线或声音混音。

`web-components` 保存完整、自包含、已经通过真实浏览器验证的 editable-media v5 网页包。它可以是组件或完整案例，但不能只复制一段 HTML、截图或消费者内部 ID。项目采用后得到的仍是通用网页包，MediaFlow Pro、HyperFrames 或独立网页预览继续通过同一 `window.editableMedia` 与 `window.__hf` 边界读取。

注册表没有默认资源。未点名资源、没有项目历史或无法从当前内容判断时，不暗选某张照片、某段音乐或某个组件。

## 二、建立和注册不可变版本

使用 `scripts/media-resource-library.mjs`。资源库草稿与注册表都放在 Skill 源码之外；库的 `library_id` 稳定，内容变化必须提升 `library_version`，已经注册的同一版本不可覆盖。

```powershell
node scripts/media-resource-library.mjs init-registry `
  --registry <注册表目录>

node scripts/media-resource-library.mjs init-library `
  --library <草稿库目录> `
  --id <库 id> `
  --version 1.0.0 `
  --kind creator-media `
  --name <名称>
```

文件素材通过 `add-file` 进入库内内容寻址目录，并记录实际字节数、MIME、SHA-256、职责、标签、权利以及取得方式、来源地址、提供方和采集时间。网页包通过 `add-component` 进入库；命令会先运行活动 editable-media 校验器，再保存完整包哈希。

```powershell
node scripts/media-resource-library.mjs add-file `
  --library <草稿库目录> `
  --input <真实文件> `
  --item-id <素材 id> `
  --name <名称> `
  --media-type photo `
  --role <实际职责> `
  --rights-status confirmed `
  --license <权利依据> `
  --method <取得方式> `
  --source-url <原始来源，可留空> `
  --provider <提供方，可留空> `
  --captured-at <ISO 时间>

node scripts/media-resource-library.mjs add-component `
  --library <组件库目录> `
  --package <editable-media 包目录> `
  --item-id <组件 id> `
  --name <名称> `
  --role <实际职责>

node scripts/media-resource-library.mjs register `
  --registry <注册表目录> `
  --library <草稿库目录>
```

`schemas/media-resource-library.v1.schema.json` 约束库包，`schemas/media-resource-registry.v1.schema.json` 约束注册表。注册记录保存整个库包哈希，而不是指向一个可以原地变化的工作目录。

## 三、项目显式采用

先用 `search` 按职责、名称、媒体类型和标签检索具体 item；只有需要查看库版本清单时才用 `list`。再用稳定库 id、版本和 item id 采用。文件素材不会直接把库路径写进场景或时间线；`adopt` 调用现有 `scripts/import-media-asset.mjs`，让真实文件和原始采集来源进入当前项目唯一的 v3 `media-sources.json`，之后由网页、视频或音频消费者显式引用新的 source id。历史生成素材采用到新项目时不会伪装成当前项目的生成任务：项目账本按已有注册成品导入，同时在 notes 中保留注册包哈希和原始取得方式。

```powershell
node scripts/media-resource-library.mjs search `
  --registry <注册表目录> `
  --kind production-assets `
  --query <名称或职责> `
  --tag <标签>

node scripts/media-resource-library.mjs adopt `
  --registry <注册表目录> `
  --library-id <库 id> `
  --version <版本> `
  --item-id <素材 id> `
  --project <项目目录> `
  --source-id <当前项目 source id>
```

完整网页包采用到项目的内容寻址 `components/` 目录，并由活动 editable-media 校验器重新打开和消费。采用事实写入 `media-resource-adoptions.json`，由 `schemas/media-resource-adoptions.v1.schema.json` 约束；它只记录注册版本如何到达现有消费者，不复制素材文件事实、场景绑定或时间线。长任务在 `media-project-state.json.contracts.resource_adoptions` 中索引该文件。

采用完成必须证明：

1. 注册包哈希仍与注册记录一致。
2. 文件素材经正式导入器进入 `media-sources.json`，实际 source 哈希与注册 item 一致。
3. 网页包在项目目录中仍自包含，真实浏览器可以读取、播放和修改。
4. 最终网页、视频或音频消费者显式引用采用结果；只有采用记录而没有消费者引用，不算进入成品。

## 四、从项目晋升可复用成果

原始日志、一次性提示、未确认反馈、临时中间文件和只对当前素材成立的修补不晋升。只有当前项目已经产生并真实使用、权利收口、能说明复用条件且有可读证据的结果，才写入 `resource-promotion-candidates.json`。候选可以指向注册资源，也可以指向项目或系列的视觉、声音档案。

```powershell
node scripts/media-resource-library.mjs propose `
  --project <项目目录> `
  --candidate-id <候选 id> `
  --target-kind creator-media `
  --scope series `
  --target-library-id <目标库 id> `
  --target-item-id <目标 item id> `
  --rationale <为什么可复用> `
  --source-id <当前项目 source id> `
  --evidence <项目内采用或审阅证据>
```

文件候选用 `promote-file` 从项目唯一素材账本读取当前 source、原始采集来源和权利信息，写入一个提升了版本的草稿库，并在同一次命令中发布不可变注册版本。只有注册成功后，候选才会变成 `accepted` 并记录包含注册包 SHA-256 的稳定目标；注册失败时不得提前接受候选。视觉或声音档案先在项目或系列位置保存新的版本化目标，再用 `decide --status accepted --published-target ...` 记录决定。拒绝候选必须保留结论，但不会产生注册资源。

```powershell
node scripts/media-resource-library.mjs promote-file `
  --project <项目目录> `
  --candidate-id <候选 id> `
  --library <提升版本后的草稿库目录> `
  --registry <注册表目录> `
  --name <名称> `
  --role <实际职责>
```

`schemas/resource-promotion-candidates.v1.schema.json` 约束候选、证据与决定。源文件或证据变化后旧候选失效，不能只改哈希继续发布。长任务在 `media-project-state.json.contracts.promotion_candidates` 中索引活动候选文件。

## 五、完成条件

完整回归使用 `scripts/self-test-reusable-production-resources.mjs`。它必须通过公开命令真实建立注册表、注册创作者素材与通用声音素材、让正式导入器写入项目账本、建立并消费声音档案、从项目晋升下一不可变版本、注册并采用完整网页包，再让项目状态和最终消费者读取这些结果。消费端手写一份看似相同的 source 或网页包不能代替这条链路。
