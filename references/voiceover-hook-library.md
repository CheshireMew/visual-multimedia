# 独立口播钩子库

用于在完整口播写作前定位用户已经明确保存的钩子原文，也用于用户明确要求时新增或更新钩子。它与完整口播案例使用不同脚本、目录、数据类型和索引；案例入口不会生成钩子。

## 真源与索引

钩子库位于 `<口播私人库>/独立口播钩子/<成品形态>/`，索引位于 `<口播私人库>/独立口播钩子/口播钩子索引.md`。每个文件只有稳定 `hook_id`、成品形态、使用语境、用户指定的连续原始开头与紧接内容，以及来源。目录只按成品形态组织。

写作时先浏览索引，再打开多份与当前成品语境相关的原文。上层可以把这些原文与多份完整口播案例共同交给写作；两类资源在生产、存储和索引时保持独立。没有合适钩子时沿当前材料继续，不从案例临时抽取，也不为满足数量创建新资源。

## 创建和验证

只有用户明确要求把一段独立材料保存为钩子时才写入。输入文件必须包含需要保存的连续开头与紧接内容：

```powershell
D:\Tools\Python310\python.exe scripts\voiceover_hook_library.py add-hook --input "<钩子原文.md>" --title "钩子标题" --hook-id "stable-hook-id" --delivery-format "短视频旁白" --context "解释机制" --source "<来源>"
D:\Tools\Python310\python.exe scripts\voiceover_hook_library.py build-index
D:\Tools\Python310\python.exe scripts\voiceover_hook_library.py validate
```

更新已有钩子时直接修改唯一文件并重建索引。完成后返回独立钩子数与索引实际路径；除非用户同时要求写作或制作，库维护完成后停止。
