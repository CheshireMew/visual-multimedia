# 素材解说型视频 starter

只有一条未经处理的源视频时，先运行 `prepare`。它会创建项目、把源片内容寻址入账，生成媒体检查、候选场景、联系表、写作包，并在 MediaFlow Pro 转写能力可用时生成待复核 transcript。Agent 查看真实联系表、转写和必要原片后创建 `source-video-commentary-authoring.json`，不能让用户手工补 starter。

人物原声必须先完成 transcript 听音确认。authoring 由用户确认后，`synthesize` 使用其中已经确认的注册声音和语速生成真实 WAV；完整试听通过后，`materialize` 才把 authoring 投影为完整解说稿、正式 `clip-selections.json`、`narration-bundle.json` 和本目录中的 draft。背景音乐必须先用 `import-bgm` 入账并在 authoring 中明确采用；没有音乐时保存 `null`。

`source-video-commentary-draft.json` 只写语义片段、使用哪段已复核 selection、画面职责、逐段声音职责和字幕呈现，不复制源片入点、出点或项目时间线。运行公开入口：

```powershell
node scripts/source-video-commentary.mjs prepare --project <项目目录> --project-id <id> --source <源视频> --source-id source-video --rights-status confirmed --license <依据> --transcription-mode auto --language zh
node scripts/source-video-commentary.mjs confirm-transcript --project <项目目录> --confirmed-by user --evidence "已完整听音并修正转写"
# Agent 创建 source-video-commentary-authoring.json
node scripts/source-video-commentary.mjs validate-authoring --project <项目目录>
node scripts/source-video-commentary.mjs confirm-authoring --project <项目目录> --confirmed-by user --evidence "已确认完整稿、选段、声音和音乐"
node scripts/source-video-commentary.mjs synthesize --project <项目目录>
node scripts/source-video-commentary.mjs confirm-narration --project <项目目录> --confirmed-by user --evidence "已完整试听全部旁白"
node scripts/source-video-commentary.mjs materialize --project <项目目录>
node scripts/source-video-commentary.mjs validate --project <项目目录>
node scripts/source-video-commentary.mjs confirm-content --project <项目目录> --confirmed-by user --evidence "已确认完整解说稿、片段选择和旁白"
node scripts/source-video-commentary.mjs plan --project <项目目录>
node scripts/source-video-commentary.mjs confirm-plan --project <项目目录> --confirmed-by user --evidence "已确认导演与制作计划"
node scripts/source-video-commentary.mjs sample --project <项目目录>
```

三种声音职责按 segment 混用：`narration-only` 关闭源片声音；`source-only` 保留关键原声且不允许旁白；`narration-with-source-bed` 保留压低后的源片环境声并叠加旁白。

如果项目尚未提交内容阶段，但仓库内同版本 profile 已经补充，可以显式运行 `migrate-profile`。旧 snapshot 会保存在项目自己的 `archive/profile-migrations/`；已经生成正式计划或进入五阶段生产的项目不会被覆盖。
