# React editable-media v6 starter

这个目录把 React 当作 editable-media v6 的生产方式，而不是播放器或第二套渲染器。组件从 `useEditableFrame()` 读取绝对 `seconds`、`frame` 与固定 `fps`；React adapter 通过 `window.__hf.registerRenderer()` 同步提交画面，并在 layout effect 完成后解决当前 frame task。

动画只能依赖绝对时间、固定 seed 和包内资源。不要读取真实时钟、发起远程请求、使用未固定随机数或把 React 状态当作项目真源。MediaFlow Pro 只消费 `dist/` 中的普通 editable-media v6 成品包，不安装这里的 Node 依赖。

依赖版本由 `package-lock.json` 精确固定。执行 `npm run build` 生成封闭的 `dist/`，执行 `npm run verify:reproducible` 会在系统临时目录独立构建两次并比较全目录 SHA-256。成品包含 schema 清单、标准 runtime、媒体声明、依赖与源码摘要、sourcemap 以及第三方许可证声明，不包含 `node_modules`。

`frame_delay_ms` 与 `fail_once_frame` 查询参数只用于跨仓库 readiness、动态调度和单帧重试验收；正式成品不要依赖这些测试参数。
