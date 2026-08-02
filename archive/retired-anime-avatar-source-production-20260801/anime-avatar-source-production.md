# 二次元口播角色源素材与语音准备

## 当前正式能力

这条流程只沉淀已经通过真实链路验证的部分：

- 从全新角色图或角色设定建立一张用户确认的母版。
- 用 v3 素材账本保存母版、校准视频、真实文件、输入哈希、来源和授权。
- 为校准视频确定一次固定人物裁切和一次固定嘴部审阅裁切，后续所有帧复用同一组坐标。
- 完整解码校准视频并生成带帧号、时间码的全身与嘴部联系表。
- 由 Agent 或人工直接查看画面，记录口型、动作阶段、人物身份和构图稳定性；代码只准备可审阅画面，不替代视觉判断。
- 保存原始语音、供应方边界、逐字 `speech-timeline.json` 和实际听音复核状态。
- 当项目已经有一条覆盖目标时段、完整看过且确认可用的角色视频轨时，把它放进固定圆形或方形角色窗。

当前口型规划器不可用，也没有通过用户验收的通用口型规划器。角色源素材与语音时间轴准备完成后必须停止，不能因为联系表齐全、报告结构通过或生成了 MP4，就声称已经具备可复用口型合成能力。
正式入口不建立口型库，也不渲染说话视频。

## 默认行为

收到新的二次元口播角色请求时，先判断用户处于哪一层：

1. 只有角色图或设定：建立外部项目、母版和角色源素材合同。
2. 已有母版但没有校准视频：确认母版身份；是否调用外部视频生成服务另行取得授权。当前 Skill 不把任何校准视频提示词或生成结果自动认定为口型库。
3. 已有校准视频：入账、确定固定裁切、生成联系表，由 Agent 直接看图并写视觉观察。
4. 已有语音或文本：保留原始音频与供应方边界，建立并实际听音复核逐字时间轴。
5. 要求生成新的说话视频：明确停止在“源素材已准备、时间轴已准备、口型规划器待修复”，不进入实验规划或渲染。
6. 已有完整角色视频轨，只要求放进底片的圆形或方形窗口：进入可选角色窗流程。

角色资源目录没有默认角色。采用共享角色必须由用户当前请求明确指定稳定 id 和版本。

## 三个真实边界

### Skill 源码

保存方法、schema、脚本、母版提示词和已经注册的只读角色源素材。源码不保存单次台词、单次语音、计划、成片或任务日志。

### 注册角色源素材

`assets/anime-avatar-sources/` 只保存：

- 用户确认的母版；
- 用户接受的校准视频；
- v3 素材账本；
- 固定人物裁切和固定嘴部审阅裁切；
- 视觉审阅报告、联系表和 Agent/人工观察记录；
- 来源、哈希、版本和参数归属。

注册角色源素材不包含 A/I/U/E/O/CLOSED 分类，不声明 `limited`、`general` 或其它口型复用等级，也不代表口型规划器可用。

### 单次媒体项目

可变内容始终位于 Skill 目录之外：

```text
<external-project>/
  media-sources.json
  anime-avatar-source.json
  avatar-source/
    anime-avatar-source-set.json
  prompts/
    master-image.md
  reports/
    avatar-source-review/
      source-review.json
      overview.jpg
      full-4fps-*.jpg
      mouth-8fps-*.jpg
      ai-visual-observations.md
  speech/
    original-audio.*
    provider-boundaries.json
    speech-timeline.json
    speech-timeline-validation.json
  avatar-insets/
    <job-id>.json
  reports/
    avatar-insets/
      <job-id>/
```

采用已注册角色时，`anime-avatar-source.json` 只保存稳定 id 和版本；候选角色才保存项目内 `avatar-source/anime-avatar-source-set.json`。

## 从零建立角色源素材

### 1. 建立外部项目

```powershell
python scripts/anime-avatar-source.py init `
  --project <Skill 目录之外的项目> `
  --source-id <稳定角色 id> `
  --source-version 1.0.0 `
  --display-name <显示名称> `
  --character-id <稳定人物 id> `
  --character-name <人物名称> `
  --origin <reference-image|character-specification|other> `
  --specification "<不会随台词变化的角色身份与外观>"
```

入口建立 v3 `media-sources.json`、候选 source set 和母版提示词副本。母版提示词真源是 `assets/anime-avatar-prompts/master-image.md`；使用时替换角色外观描述，但保留白色纯背景、固定底部、正面头肩、清晰线条和安全边距等已验证约束。

### 2. 导入真实母版和校准视频

使用通用素材导入器把用户提供或已获授权生成的文件写入项目唯一素材账本：

```powershell
node scripts/import-media-asset.mjs --project <项目> --input <母版> `
  --id avatar-master --media-type generated --method generated-in-project `
  --rights-status confirmed --license <权利依据> --usage "用户确认的角色母版"

node scripts/import-media-asset.mjs --project <项目> --input <校准视频> `
  --id avatar-calibration --media-type video --method user-provided `
  --rights-status confirmed --license <权利依据> --usage "固定机位角色校准视频"
```

导入后，素材文件位于内容寻址目录，账本记录真实哈希、字节数、来源和授权。不要把临时下载路径或 `artifacts/` 绝对路径写进共享资源。

### 3. 绑定一次固定裁切

Agent 查看母版和校准视频代表帧，确定：

- `source-crop`：整个审阅期间固定使用的人物画面；
- `mouth-review-crop`：相对 `source-crop` 的嘴部审阅区域。

```powershell
python scripts/anime-avatar-source.py configure `
  --project <项目> `
  --master-source-id avatar-master `
  --calibration-source-id avatar-calibration `
  --source-crop x,y,width,height `
  --mouth-review-crop x,y,width,height
```

角色身份与外观以完整人物帧为单位。后续任何系统都不得重绘嘴部、替换下半张脸或用独立嘴贴图重新拼脸。

### 4. 生成审阅资料

```powershell
python scripts/anime-avatar-source.py prepare-review --project <项目>
```

脚本完成的工作只有：

- 解码校准视频的全部画面帧；
- 对全部帧应用同一人物裁切；
- 生成带真实帧号和时间码的 overview、完整人物和嘴部联系表；
- 记录输入 source id、真实哈希、视频探测结果和固定裁切。

脚本不得根据像素面积、嘴洞大小或其它代码指标分类 CLOSED/A/I/U/E/O，也不得给出“口型可复用”结论。

### 5. Agent 直接视觉审阅

Agent 必须实际打开联系表，必要时查看原始视频或单帧，并在
`reports/avatar-source-review/ai-visual-observations.md`
写观察记录。观察至少包括：

- 角色身份、服装、发饰、发型、脸型和构图是否保持一致；
- 人物底部、头部、肩部和尺度是否固定，有无整体漂移或跳变；
- 眼睛、眉毛、耳朵、头发、呆毛、饰品、肩膀和呼吸的动作阶段；
- 嘴唇形状、张口幅度、下巴和脸颊是否作为同一结构自然运动；
- 可能属于闭合、小开口、横向、圆唇或大开口的候选画面；
- 哪些画面只是诊断候选，不能当成已确认口型类别或通用动作。

机器联系表和 Agent 视觉判断职责分离：机器保证帧号、时间码、完整解码和固定裁切；Agent 负责画面语义。Agent 观察记录不是口型库，不能被当前渲染器消费。

完成实际查看后绑定观察记录：

```powershell
python scripts/anime-avatar-source.py confirm-review `
  --project <项目> `
  --observations-file <项目内观察记录> `
  --reviewer <Agent 或人工身份> `
  --notes "<确认了什么，以及仍未确认什么>"

python scripts/anime-avatar-source.py validate `
  --project <项目> `
  --require-confirmed-review
```

### 6. 明确确认后注册或采用

只有用户明确要求长期复用，且母版、校准视频、固定裁切和视觉审阅均确认后，才注册 source-only 资源：

```powershell
python scripts/anime-avatar-source.py register `
  --project <项目> `
  --confirm-long-term-reuse
```

注册使用内容寻址文件、稳定 id 和版本，不覆盖同版本。注册后当前项目自动改为读取刚注册的只读包，证明生产者与正式消费者使用同一资源。

列出和采用资源：

```powershell
python scripts/anime-avatar-source.py list-sources

python scripts/anime-avatar-source.py adopt `
  --project <新的 Skill 外部项目> `
  --source-id <角色 id> `
  --source-version <x.y.z>

python scripts/anime-avatar-source.py validate `
  --project <新的 Skill 外部项目> `
  --require-confirmed-review
```

## 为真实语音建立时间轴

### 文本转语音

只有用户明确要求并且当前声音入口已获授权时，才合成语音。EdgeTTS 入口同时保留原始音频、供应方 `WordBoundary` 和待复核逐字时间轴：

```powershell
python scripts/synthesize-avatar-speech.py `
  --text-file <确切合成文本> `
  --voice <供应方声音 id> `
  --audio-source-id <准备写入素材账本的 id> `
  --output-audio <项目内原始音频> `
  --output-boundaries <项目内 provider-boundaries.json> `
  --output-timeline <项目内 speech-timeline.json>
```

合成结果随后必须通过 `scripts/import-media-asset.mjs` 写入同一 v3 素材账本，并保存声音 id、声音名称、语言、文本哈希和精确声音身份。

供应方边界只是生产者输出。Agent 或人工必须实际听原始语音，确认：

- `text` 与真实发音一致；
- 前置静音和尾部裁切边界正确；
- 每个汉字的开始、结束时间按实际听感成立；
- 供应方把多个汉字合成一个边界时，细分没有越过真实语音；
- `timing.reviewed` 只在听音完成后改为 `true`。

验证器只读取时间轴和素材账本中的真实音频，不改写、拉长、减速或吸收发音锚点：

```powershell
python scripts/validate-avatar-speech-timeline.py `
  --project <项目> `
  --timeline speech/speech-timeline.json `
  --require-reviewed `
  --output-report speech/speech-timeline-validation.json
```

用户录音或视频中的声音同样先入账；从视频取音时保留原视频 source id 和派生关系。逐字边界可来自强制对齐或人工确认，但最终都必须绑定真实音频哈希并经过听音。

## 当前停止位置

当角色源素材和语音时间轴都准备好后，用户可见状态应明确写成：

```text
角色源素材：ready
母版与校准视频来源：verified
固定裁切：verified
Agent 视觉审阅：confirmed
语音时间轴：reviewed
口型规划器：unavailable / 待另一会话修复
说话视频：not rendered
```

不能进入任何会拉长或减速时间轴、强制每个普通话发音走完整“低→峰→低”、大量前后跳帧、全画面光流掩盖接缝、把小开口误作闭嘴，或容许低匹配率仍通过的旧实验路径。

未来重新启用口型规划时，必须重新经过用户链路验证，并满足：

- 计划是独立、可查看、不可变的产物；
- 计划绑定角色资源、语音时间轴、媒体输入和代码哈希；
- 用户确认后才能渲染；
- 任一输入变化都使计划失效；
- 渲染只消费确认计划，不重新规划；
- “生成 MP4”不等于口型和自然度通过；
- 机器报告与绑定当前成片哈希的完整人工观看分开。

这些是未来实现的验收合同，不代表当前存在可用规划器。

## 可选：固定圆形或方形角色窗

只有项目已经有一条完整覆盖目标时段、经过完整观看且确认可用的角色视频轨时，才能进入角色窗。它可以是用户已有角色视频，也可以是未来其它已验证生产者的输出；角色窗脚本不生成、延长、冻结或修复角色动作。

先把底片和角色轨作为两个真实视频 source id 写入同一 v3 素材账本。Agent 查看代表帧后确定一次正方形 `avatar-crop`、一次窗口位置和尺寸：

```powershell
python scripts/compose-anime-avatar-inset.py init `
  --project <项目> `
  --job-id <稳定任务 id> `
  --base-source-id <底片 source id> `
  --avatar-source-id <已验证角色轨 source id> `
  --avatar-crop x,y,width,height `
  --shape circle `
  --x <left> --y <top> --size <diameter> `
  --end-behavior require-full-track

python scripts/compose-anime-avatar-inset.py validate `
  --project <项目> `
  --job avatar-insets/<job-id>.json
```

`require-full-track` 要求角色轨实际覆盖整个角色窗区间。角色窗需要全程存在时，不允许角色轨提前结束后留下空白圆框；不说话区间的动态待机必须已经存在于输入角色轨中。只有用户明确要求在某个时间隐藏，才使用 `hide`。

渲染只做固定裁切、固定遮罩、固定坐标、边框、阴影和音轨选择：

```powershell
python scripts/compose-anime-avatar-inset.py render `
  --project <项目> `
  --job avatar-insets/<job-id>.json `
  --output outputs/<name>.mp4
```

渲染后联系表和机器报告只证明固定几何、素材解析、完整时长和文件可读。仍需完整观看角色是否持续存在、圆弧底部是否被衣服填满、是否有黑角或白色楔形、人物是否漂移，以及输入角色轨自身的口型和动作是否可接受。

## 质量门

### 角色源素材

- 母版由用户确认，角色身份和构图清楚。
- 母版和校准视频都通过 v3 素材账本解析到真实文件，哈希一致。
- 校准视频完整解码；不是只抽查开头几帧。
- 人物裁切和嘴部审阅裁切在整段视频中固定。
- 联系表带真实帧号和时间码。
- Agent/人工实际查看并留下绑定报告哈希的观察记录。
- 报告不声称已经具备可复用口型库或口型合成能力。

### 语音时间轴

- 原始语音、确切文本、供应方边界和逐字时间轴分别保存。
- 时间轴绑定素材账本中的真实音频 source id 和哈希。
- 文本汉字序列与逐字边界完全一致，时间单调且位于真实音频与裁切范围内。
- `timing.reviewed=true` 来自实际听音，不来自结构检查。
- 不改写语速来迁就动画。

### 角色窗

- 输入角色轨本身已经完整观看和确认；角色窗脚本不替上游背书。
- 一条任务只使用一组固定裁切、坐标和尺寸。
- 角色轨覆盖要求出现的完整时段。
- 圆形或方形遮罩、角色画面、边框和阴影使用同一时间边界。
- 机器报告和完整人工观看分开。
