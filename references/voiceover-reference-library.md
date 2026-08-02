# 口播私人库

用于在完整口播写作前取得三类职责不同的资源：当前口播声音真源、经过确认的完整口播案例、可迁移的开头钩子。也用于用户明确要求时初始化、接入和维护 visual-multimedia 自己的私人库。普通写作只读；保存、更新声音或写入案例必须由用户明确要求。

私人库是运行资源，不是随 Skill 发布的 assets 或示例。默认放在用户指定的位置；位于 visual-multimedia 目录内时只能使用已经从 Git 排除的 `口播私人库/`，不能混入 references、scripts、assets 或正式案例。

## 一、定位唯一根目录

普通写作先运行：

```powershell
D:\Tools\Python310\python.exe scripts\voiceover_reference_library.py show
```

返回的 `library_root` 是本次唯一根目录。配置不存在、目录不可达或库无效时，把“当前没有可用口播私人库”返回主流程。普通写作不为完成一次文案而初始化库，也不根据当前仓库、客户端或项目猜第二个位置。

当前用户已经指定的正式根目录是：

```text
E:\Work\BaiduSyncdisk\Code\Cheshire-skill\visual-multimedia\口播私人库
```

首次建立时运行：

```powershell
D:\Tools\Python310\python.exe scripts\voiceover_reference_library.py init --root "E:\Work\BaiduSyncdisk\Code\Cheshire-skill\visual-multimedia\口播私人库"
```

接入已经存在的 v2 私人库时使用 `adopt --root <位置>`。脚本把唯一根目录保存在当前用户的 `.visual-multimedia/voiceover-reference-library-config.json`；配置只是指针，正文资源仍全部位于私人库。

初始化只建立 v2 库标识和真实索引，不生成示范声音、占位案例、占位钩子或假装真实的创作材料。

## 二、三类资源不能互相冒充

### 口播声音真源

`<私人库>/口播声音/voice.md` 只保存当前已经确认的稳定口播声音：视角、判断力度、信息推进、句段与停顿、自然毛边、幽默和收束。它不选择本次主题、主张、结构、案例或事实，也不能证明作者经历。

当前明确指令和当前有效声音样稿优先于长期声音真源。只有用户明确要求建立或更新声音时，才把已经确认的声音说明写入临时 UTF-8 文件并运行：

```powershell
D:\Tools\Python310\python.exe scripts\voiceover_reference_library.py set-voice --input "<声音说明.md>" --source "<用户确认或可核对来源>"
```

没有声音真源不影响普通口播写作；用户要求贴近个人声音时，缺少声音真源和有效样稿会改变主要结果，应当返回这一缺口。

### 完整口播案例

完整案例保存一份已经确认、可以直接朗读或配音的全文及可核对来源。短视频旁白、长视频旁白、播客独白、主持连接和采访讲解都可以成为案例；文章、普通短帖、事实转写、字幕派生、镜头说明、未确认草稿和只因状态写着“confirmed”但仍不适合作参考的稿件不自动入库。

案例按主要写作任务进入 `<私人库>/完整口播案例/<写作任务>/`。除了任务、成品语境、主题和推进动作，还必须记录：

- `writing_origin`：`human`、`human-edited`、`ai-generated` 或 `unknown`；
- `voice_eligible`：是否可以证明当前作者声音。

只有来源可靠的 `human` 或 `human-edited` 成品才能标为声音证据。作者本人发布、用户确认终稿或案例本身可用，都不自动使 `voice_eligible` 成立；AI 初稿、来源不明文字和外部案例不得标为声音证据。

保存确认案例时运行：

```powershell
D:\Tools\Python310\python.exe scripts\voiceover_reference_library.py add-case --input "<确认全文.md>" --title "案例标题" --script-task "解释机制" --source "<来源>" --context "短视频旁白" --writing-origin human-edited --voice-eligible --topic "可选主题" --move "可选推进动作"
```

不是作者声音证据时省略 `--voice-eligible`，但仍必须如实填写 `--writing-origin`。

### 开头钩子

开头钩子位于 `<私人库>/开头钩子/<钩子类型>/`。它保存稳定的 `hook_pattern_id`、开头实际做了什么、希望产生的听众反应，以及来源开头和紧接内容。

来源已经是完整案例时，钩子通过相对路径引用该案例，写作时打开原文，不复制全文：

```powershell
D:\Tools\Python310\python.exe scripts\voiceover_reference_library.py add-hook --title "钩子标题" --pattern-id "stable-pattern-id" --hook-type "结果钩子" --script-task "解释机制" --context "短视频旁白" --technique "先给可见结果" --listener-effect "迅速理解变化" --source-case "完整口播案例/解释机制/案例标题.md"
```

来源尚未作为完整案例保存时，使用 `--input <连续开头.md> --source <来源>`。只截取第一句、抽象成一句公式或没有紧接内容的材料不能成为独立钩子。

## 三、声音检索与创意检索分开

读取声音时先运行：

```powershell
D:\Tools\Python310\python.exe scripts\voiceover_reference_library.py voice-candidates --context "短视频旁白" --script-task "解释机制" --limit 5
```

这个入口返回口播声音真源路径和同成品语境、同职责中经过确认的声音候选。它不接受主题 query，不按内容相似度评分，也不把外部案例或钩子放进声音结果。没有同职责候选时可以只使用声音真源；两者都没有时保持普通直接。

寻找创作参考时先打开 `<私人库>/口播文案参考索引.md`，按写作任务和成品语境浏览。范围仍大时用普通文本搜索标题、全文和隐藏标签：

```powershell
rg -n -i "主题|动作|结果" "<私人库>\完整口播案例"
rg -n -i "结果|问题|反差|场景" "<私人库>\开头钩子"
```

打开多份方向不同且真正相关的完整口播，以及多份钩子来源的开头和紧接内容，再把实际路径交给完整口播写作。参考数量由差异、质量和上下文容量决定；索引不评分、不预先淘汰候选，也不选择唯一模仿对象。没有合适参考时沿当前材料继续，不凑数。

创作案例和钩子可以改善进入、推进、节奏与收束，但不提供当前事实、作者身份和立场。声音真源和合格声音候选可以证明表达习惯，但不提供本次事实。两条检索结果必须保持分开。

## 四、验证与完成

维护后运行：

```powershell
D:\Tools\Python310\python.exe scripts\voiceover_reference_library.py validate
D:\Tools\Python310\python.exe scripts\voiceover_reference_library.py build-index --check
```

验证必须证明：

- 配置能够重新定位唯一根目录；
- v2 manifest、声音真源、完整案例、钩子与索引结构一致；
- `voice_eligible` 只出现在允许的写作来源；
- 完整口播没有同文重复，钩子 id 没有重复；
- 钩子引用的案例真实存在，且没有复制第二份全文；
- 索引来自真实资源，不含占位正文。

脚本自测只证明私人库协议、写入、资格约束、索引、引用和去重，不证明模型已经读过资源，也不证明一份生成口播自然。真实写作验证还必须运行 `show` 和 `voice-candidates` 读取正式私人库，再对一项真实口播请求交付可观察的审查或成稿结果。

完成维护后返回私人库根目录、声音真源状态、案例数、声音候选数、钩子数和索引实际路径。除非用户同时要求写作或制作，库维护完成后停止。
