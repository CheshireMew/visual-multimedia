# 采访原声讲解型视频项目起点

此目录只保存可复制的空合同，不保存运行结果或案例内容。正式项目通过
`scripts/interview-explainer.mjs create-project --project <Skill 外部目录> --project-id <id>`
建立。

这里的目录是媒体制作项目，不是 MediaFlow Pro 工程。渲染阶段会通过公开
`project.create` 在 MediaFlow Pro 声明的默认工程根目录中直接创建计划专属工程；
调用端不传工程路径，也不在本目录的 `working/` 下保存工程副本。

项目建立后：

1. 用正式素材导入器登记原片、旁白和其它独立素材。
2. 建立并听音复核 `transcript.json` 与 `clip-selections.json`。
3. 为每段旁白建立一个经过浏览器验证的 `editable-media` v6 场景包。
4. 填写并验证 `narration-bundle.json` 与 `interview-explainer-draft.json`。
5. 依次运行 `plan`、`confirm-plan`、`render`、`review` 和 `finalize`。

starter 中的尺寸、声音、颜色、片段数量和示例文字都只是占位，不是全局默认。
