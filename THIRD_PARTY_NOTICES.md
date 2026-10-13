# Third-party notices

## Qiaomu Screen2Video

`scripts/generate-background-music.py` 的编曲、音符合成和节奏函数改编自 [joeseesun/qiaomu-screen2video](https://github.com/joeseesun/qiaomu-screen2video) 的 `scripts/music_synth.py`（MIT，Copyright (c) 2026 向阳乔木）。本仓库改为受控任务工作区、分窗口合成和通用素材入账，不采用上游品牌、默认倍速、SoundFont 自动选择或 macOS 运行路径。屏幕词表、指引稳定性和局部时间复核借鉴其方法，在本仓库独立实现并通过 MediaFlow Pro 公开入口使用；未复制专有剪映库、模型或角色素材。研究归档为 `qiaomu-screen2video-main.zip`，SHA-256：`2c53b9366ea6cd1c81355ef6005ffe349118070af86b3024dae9ce8070dd0529`。

MIT License

Copyright (c) 2026 向阳乔木

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## native-subtitle-quote-image

视频字幕金句拼图的精确取帧、一个主画面加多个横条的拼接思路，改编自 [chengyi-ai/native-subtitle-quote-image](https://github.com/chengyi-ai/native-subtitle-quote-image)。原项目采用固定 3:4 成品比例；本仓库改为统一字号，并按每条实际文字高度加最小内边距计算总高度。本次研究输入为 `native-subtitle-quote-image-main.zip`，SHA-256 为 `7c86aed3b9af5f0f5a799eaf232d62e82757598d951099e00a15f91e2a2a9e50`。

改编内容进入 `scripts/subtitle-quote-image.py`、`schemas/subtitle-quote-image.v1.schema.json`、`references/subtitle-quote-image-production.md` 和 `scripts/self-test-subtitle-quote-image.py`。本仓库没有吸收上游“原片必须已有烧录字幕”的产品边界、交互式脚本入口或目录约定，而是把事实转写、候选检查、无烧录字幕默认值、旧字幕显式观察与覆盖、哈希绑定、不覆盖输出和人工审核门槛接入 Visual Multimedia 的活动媒体合同。后续默认不自动跟随上游；如需采用新的上游变化，按新的来源与许可审计处理。

MIT License

Copyright (c) 2026 程意

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
