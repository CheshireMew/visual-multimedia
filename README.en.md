<!-- readme-header:start -->

<p align="center">
  <a href="./README.md">中文</a> · <strong>English</strong> · <a href="./README.ja.md">日本語</a> | <a href="./SKILL.md">文档</a> | <a href="./CONTRIBUTING.md">贡献</a> | <a href="https://github.com/CheshireMew/visual-multimedia/issues">反馈</a>
</p>

<p align="center">
  <a href="https://x.com/0xCheshire" title="X"><img src="https://img.shields.io/badge/X-%400xCheshire-000000?logo=x&amp;logoColor=white" alt="X：@0xCheshire"></a>
  <a href="https://t.me/CheshireBTC" title="Telegram"><img src="https://img.shields.io/badge/Telegram-CheshireBTC-26A5E4?logo=telegram&amp;logoColor=white" alt="Telegram：CheshireBTC"></a>
  <a href="https://blog.blacknico.com/" title="Blog"><img src="https://img.shields.io/badge/Blog-blog.blacknico.com-2E7D32?logo=rss&amp;logoColor=white" alt="博客：blog.blacknico.com"></a>
  <a href="https://blacknico.com/" title="Homepage"><img src="https://img.shields.io/badge/Home-blacknico.com-1F6FEB?logo=googlechrome&amp;logoColor=white" alt="个人主页：blacknico.com"></a>
</p>

<p align="center">
  <a href="https://github.com/CheshireMew/visual-multimedia/stargazers"><img src="https://img.shields.io/github/stars/CheshireMew/visual-multimedia?style=flat" alt="GitHub Stars"></a>
  <a href="https://github.com/CheshireMew/visual-multimedia/forks"><img src="https://img.shields.io/github/forks/CheshireMew/visual-multimedia?style=flat" alt="GitHub Forks"></a>
  <a href="https://github.com/CheshireMew/visual-multimedia/blob/main/LICENSE"><img src="https://img.shields.io/github/license/CheshireMew/visual-multimedia?style=flat" alt="Repository License"></a>
</p>

<!-- readme-header:end -->

# Visual Multimedia

Turn confirmed content or existing source material into editable, previewable, and exportable visuals, video, or audio with Codex.

Visual Multimedia is a media-production Agent Skill. It first decides whether the result should be a social card, diagram, web animation, video, audio program, or podcast.

It then develops the title, voiceover, captions, program structure, and companion copy required by that medium, while keeping one active source of truth through preview, render, review, and delivery.

![A real Visual Multimedia case that turns an abstract mechanism into a readable diagram](assets/web-card-cases/editorial-technology-diagram-cover/preview.png)

<p align="center"><sub>Real editable-web case: content, composition, timing, and the exported preview come from the same active source.</sub></p>

It does not research an unverified topic, invent facts, choose what matters in a long source, plan a shoot, or publish on the user's behalf. Those steps need a confirmed content source before media production begins.

## Quick start

Load this repository as a Skill in Codex, invoke `$visual-multimedia`, and provide the confirmed content or source files, the audience, and the result you need.

```text
Use $visual-multimedia to turn this approved article into three 3:4 social cards.
Finish the card copy and one composition sample first; export PNG only after approval.
```

```text
Use $visual-multimedia to cut this interview and its reviewed transcript into a 90-second video.
Keep the speaker's original voice and show me the clip selection and narration plan first.
```

```text
Use $visual-multimedia to turn this final script into a multi-scene HTML explanation
that can be advanced manually and exported as a continuous animation.
```

If the request names the Skill but does not say whether it needs a sample or a finished asset, the default flow recommends one medium, prepares confirmable media copy, and stops for a decision. File creation, external services, and final export begin only when the requested scope allows them.

For fewer clarification rounds, include the confirmed source, intended audience outcome, required format or dimensions, usable assets, and whether external tools, downloads, or paid generation are allowed.

## What it can deliver

| Need | Main input | Observable result |
| --- | --- | --- |
| Social cards, covers, carousels, and charts | Confirmed content, dimensions, and licensed assets | Editable web source, per-ratio previews, and requested images |
| Technical comparisons and system diagrams | Confirmed concepts, relationships, and visual direction | Readable static mechanism diagrams or stable-overview animations with inspected states |
| GIFs, explainers, and code animation | Semantic steps and playback behavior | A deterministic web timeline plus requested GIF or video |
| Explanatory B-roll and packaging | Final voiceover, content relationships, layout, and real audio timing | Selected active templates, timeline-ready segments, and PNG, GIF, video, or transparent outputs |
| Multi-scene HTML presentations | Final copy, scene order, and manual, automatic, or hybrid playback | One editable web source with interactive and continuous-export paths |
| Interview, lecture, screen-recording, and live-action editing | Original media, reviewed transcript, clip bounds, and delivery target | Editable timeline, captions, mix, review evidence, and final media |
| Audio and podcasts | Recordings, program structure, narration, and sound requirements | Audio timeline, mix, and required companion files |
| Reference-video matching | Exact reference range, target media, and desired fidelity | A separated exact-replay or parameterized-rebuild result with frame and viewing evidence |
| Anime presenter video | A registered character or approved master/calibration media, plus real speech | Versioned character resources, reviewed timing, and a complete presenter track or inset |
| Interview-source explainer | Selected original clips, factual transcript, context, and explanation | A source-timecode-bound context → quote → explanation → conclusion video and delivery report |

Task routing, required references, and stop conditions are defined in [SKILL.md](SKILL.md).

## How execution providers are selected

The Skill first identifies the active source: an editable web package, a portable timeline, a native editor project, or an audio source. It then inspects capabilities that are actually available on the current machine. The selected provider is recorded in the delivery contract, and a runtime failure never causes a silent provider switch.

| Provider | Use it when | Active source and delivery |
| --- | --- | --- |
| Local production | MediaFlow Pro is unavailable, or the result only needs self-contained web media, MP4, GIF, existing-media editing, audio, and captions | `editable-media` v5 or `media-timeline` v1 remains the editable source; Playwright, a browser, FFmpeg, and FFprobe produce the media and receipt |
| [MediaFlow Pro](https://github.com/CheshireMew/MediaFlow-Pro) | It is configured, the required operations are verified ready, and the work benefits from a native project, desktop refinement, multitrack editing, versions, or handoff | Product-neutral sources are imported; after a successful import, `project.mfp` becomes the only active timeline and produces the final export |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | The user explicitly chooses deterministic rendering for an independent, silent code-driven web animation | It consumes the same `editable-media` v5 time boundary; the web package stays authoritative and the render copy is derived |

Local production is a complete path, not a placeholder fallback. MediaFlow Pro is preferred only when both its public operations and runtime capabilities prove the requested work is ready. HyperFrames is never selected merely because a page uses HTML.

## Real outputs

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/web-card-cases/warm-paper-project-list/preview.png" alt="Warm paper-style project-list social card">
      <br><sub>Social card: a dense project list reorganized for vertical reading.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="assets/web-card-cases/social-evidence-variants/preview-landscape-21x9.png" alt="Landscape variant of a structured social-evidence card">
      <br><sub>Multi-ratio output: the same structured content is recomposed for a wide canvas.</sub>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/web-card-cases/technical-interface-comparison/preview.png" alt="Technical comparison diagram for MCP, CLI, and API">
      <br><sub>Mechanism comparison: each column explains an interface with a small process diagram and a shared capability boundary.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="assets/web-card-cases/handdrawn-system-collaboration-flow/preview.png" alt="Hand-drawn dark system-collaboration overview">
      <br><sub>Stable-overview animation: the structure stays fixed while same-color motion traces each semantic event.</sub>
    </td>
  </tr>
</table>

## Production model

1. Confirm content before choosing a medium. Visuals and sound clarify a claim; they do not become a second source of facts.
2. Write medium-specific copy before building visuals or audio. Already approved copy is split only where the medium requires it.
3. Sample the earliest unconfirmed layer. Copy, style, composition, motion, and sound are approved separately before a full build.
4. Keep one active production source for each result. Web media stays in its web package; video and audio stay in their active timelines.
5. Verify the real consumer. A valid schema or successful script is not delivery evidence until the browser, player, editor, or export chain reads the result.

Code-generated cards, diagrams, and animation start from [assets/web-media-starter](assets/web-media-starter). `schemas/editable-media.v5.schema.json` is the only web-manifest contract; local rendering, structured editors, and HyperFrames consume the same `window.editableMedia` and `window.__hf.duration/seek(seconds)` boundary.

Images, video, audio, and generated material first enter a source ledger with hashes, provenance, rights, and original/proxy relationships. `schemas/media-timeline.v1.schema.json` defines the portable timeline. `schemas/media-delivery.v3.schema.json` binds the actual provider, editable source files, render receipt, and their SHA-256 values to the final output.

## Repository map

| Path | Responsibility |
| --- | --- |
| [SKILL.md](SKILL.md) | Applicability, default workflow, task routing, and delivery standards |
| [references](references) | Production methods loaded only for the current media task |
| [assets](assets) | Web starter, real contract cases, production profiles, and reusable resources |
| [schemas](schemas) | Contracts for sources, timelines, review, delivery, characters, and editable web packages |
| [scripts](scripts) | Import, validation, planning, rendering, review, and delivery tools |
| [agents/openai.yaml](agents/openai.yaml) | Codex display name, description, and default prompt |
| [.project-steward/project.json](.project-steward/project.json) | Repository governance baseline and version |

`archive/` stores retired routes and migration evidence only. Active production never restores an old protocol or helper from it.

## Maintenance and validation

Run the smallest validation tier that covers the changed public boundary. No argument is equivalent to `--fast`.

```powershell
node scripts/check-skill.mjs --fast
node scripts/check-skill.mjs --browser
node scripts/check-skill.mjs --full
```

`--fast` checks the Skill, README, licensing, schemas, indexes, static real-case contracts, and script syntax. `--browser` adds Playwright packages, deterministic time, explanatory B-roll, text motion, local web video, and product-promo checks.

`--full` adds real producer-to-consumer chains for direction, portable timelines, provider routing, Node and Python media processing, review, and final delivery.

Changes to editable-media, source representation, deterministic time, portable timelines, delivery contracts, or MediaFlow Pro consumers must migrate every active producer and consumer together. The exact repository rules are in [AGENTS.md](AGENTS.md); public MediaFlow Pro operations are documented in [references/structured-media-editor-cli.md](references/structured-media-editor-cli.md).

## Not a fit for

- researching a topic or deciding what matters in a long source;
- writing a standalone long-form article, newsletter, short post, or thread;
- planning a physical shoot, crew, equipment, or production day;
- creating PowerPoint, Keynote, or other slide-deck files;
- account operations, scheduling, uploading, sending, or publishing.

Use the appropriate upstream capability to establish confirmed content, or a downstream publishing workflow after the media is finished.

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CheshireMew/visual-multimedia/star-history/star-history-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CheshireMew/visual-multimedia/star-history/star-history.svg">
  <img alt="Visual Multimedia GitHub Star History" src="https://raw.githubusercontent.com/CheshireMew/visual-multimedia/star-history/star-history.svg">
</picture>

## License

Original source code, the Skill, scripts, schemas, templates, and documentation are licensed under the [Mozilla Public License 2.0](LICENSE).

Personal avatars, characters, brand material, project-owned or project-generated images, audio, video, renders, and preview media are not licensed under MPL-2.0 and remain reserved under [ASSET-LICENSE](ASSET-LICENSE). Third-party material remains subject to its own terms.

[LICENSING.md](LICENSING.md) is the authoritative path-level statement of scope, exclusions, and third-party coverage.

## Third-party resources and acknowledgements

- [Vincentwei1021/video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft): semantic material for 104 shot cards and 161 style variants under `assets/shot-recipe-library/recipes/` was rewritten from the Apache-2.0 upstream, Copyright 2026 Wei Yihao. Upstream Remotion TSX, product screenshots, audio, preview MP4 files, and Gallery implementation are not copied. See the [shot-recipe notices](assets/shot-recipe-library/THIRD_PARTY_NOTICES.md).
- `sakura-animate-text`: the text-motion families in `assets/text-motion-library/text-motion-runtime.js` are a deterministic reimplementation under the MIT License, Copyright 2026 Sakura. The upstream WAAPI loop, random delays, CDN loader, framework adapters, sample copy, fonts, and site design are not copied. See the [text-motion notices](assets/text-motion-library/THIRD_PARTY_NOTICES.md).
- [Xiaolai](https://github.com/lxgw/kose-font): `assets/web-card-cases/handdrawn-system-collaboration-flow/assets/fonts/Xiaolai-Regular.ttf` is used by the real hand-drawn Chinese case under the SIL Open Font License 1.1; the complete license is stored beside the font.
- [Lucide](https://github.com/lucide-icons/lucide): the same case embeds selected Lucide Static 1.28.0 paths. Lucide's original icons use ISC; Feather-derived icons including Server, Monitor, and Database also retain Cole Bemis's MIT terms. See the [case notices](assets/web-card-cases/handdrawn-system-collaboration-flow/THIRD_PARTY_NOTICES.md).
