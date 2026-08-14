<!-- readme-header:start -->

<p align="center">
  <img src="./assets/readme/visual-multimedia-logo.svg" width="144" alt="Visual Multimedia">
</p>

<h1 align="center">Visual Multimedia</h1>

<p align="center">
  <strong>Turn confirmed content or source material into editable, previewable, and exportable visuals, video, or audio.</strong>
</p>

<p align="center">
  <a href="./README.md">中文</a> · <strong>English</strong> · <a href="./README.ja.md">日本語</a> | <a href="./skills/visual-multimedia/SKILL.md">文档</a> | <a href="./CONTRIBUTING.md">贡献</a> | <a href="https://github.com/CheshireMew/visual-multimedia/issues">反馈</a>
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

Visual Multimedia is now a suite of focused media-production Skills. Static cards, web motion, video, audio, and anime-presenter work each have a direct entry point. The root `$visual-multimedia` Skill only selects and coordinates the smallest set of child Skills for carrier-selection or composite requests.

Approved audience-facing copy goes straight into production. A draft or proposed card/voiceover script first goes through `$clean-copy` for hierarchy, repetition, unclear references, and AI filler, then enters media production after the edits are approved.

![A real Visual Multimedia case that turns an abstract mechanism into a readable diagram](assets/web-card-cases/editorial-technology-diagram-cover/preview.png)

<p align="center"><sub>Real editable-web case: content, composition, timing, and the exported preview come from the same active source.</sub></p>

It does not research an unverified topic, invent facts, choose what matters in a long source, plan a shoot, or publish on the user's behalf. Those steps need a confirmed content source before media production begins.

## Quick start

Install the suite to expose the orchestrator and all five production Skills:

```powershell
npx skills add CheshireMew/visual-multimedia --all
```

Use the matching child Skill for one output, and reserve `$visual-multimedia` for composite work.

```text
Use $visual-cards to turn this approved article into three 3:4 social cards.
Confirm the exact visible copy, canvas dimensions, and visual direction before production.
```

```text
Use $video-production to cut this interview and its reviewed transcript into a 90-second video.
Keep the speaker's original voice and show me the clip selection and narration plan first.
```

```text
Use $web-motion to turn this final script into a multi-scene HTML explanation
that can be advanced manually and exported as a continuous animation.
```

If the carrier is unknown, `$visual-multimedia` selects one route and loads only that child Skill. Static visual production stops once before drawing to confirm visible copy, hierarchy, content-derived dimensions, and visual direction unless the user explicitly skips that visual gate.

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
| GitHub project intro video | Confirmed repository facts, one core claim, and UI, terminal, documentation, or real-output evidence | An approximately one-minute landscape video with Silver Wolf speech at 1.25×, Chinese and English captions, plus traceable build, review, and delivery reports |
| Media copy and voice-reference maintenance | Confirmed claims and authorial voice, or an explicit library-maintenance request | Production-ready active copy, or a traceable reference library outside the Skill |

Task routing, required references, and stop conditions are defined by the matching entry under [skills](skills).

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

### Choosing a video execution provider

The Skill identifies the active source first, then inspects capabilities that are actually available on the current machine. The selected provider is recorded in the delivery contract, and a runtime failure never causes a silent provider switch.

| Provider | Use it when | Active source and delivery |
| --- | --- | --- |
| Local production | MediaFlow Pro is not configured, a required capability is unavailable, or the user explicitly chooses independent local production | `editable-media` v6 or `media-timeline` v1 remains editable; the formal local path can fully produce web media, MP4, GIF, existing-media edits, audio, and captions |
| [MediaFlow Pro](https://github.com/CheshireMew/MediaFlow-Pro) | It is configured and the required operations are verified ready; it is especially useful for native projects, desktop refinement, multitrack editing, versions, or handoff | Product-neutral sources are imported; after a successful import, `project.mfp` becomes the only active timeline and produces the final export |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | The user explicitly chooses deterministic rendering for an independent, silent code-driven web animation | It consumes the same `editable-media` v6 time boundary; the web package stays authoritative and the render copy is derived |

Provider choice changes who performs deterministic processing and how the work is handed off. The Skill remains responsible for content, structure, style, production judgment, and final review. MediaFlow Pro is not a required dependency, and HyperFrames is never selected merely because a page uses HTML.

### Editable sources and delivery contracts

- **Web packages:** use the [DOM starter](assets/web-media-starter) unless React is explicitly requested or the source is already a React project. The [React starter](assets/react-media-starter) is a deterministic React 19, TypeScript 5.9, and Vite 7 producer. Both build self-contained editable-media v6 packages; React does not enter MediaFlow Pro project state or its export pipeline.
- **Web contract:** `schemas/editable-media.v6.schema.json` is the only manifest contract. Local rendering, structured editors, and HyperFrames consume the same `window.editableMedia` and `window.__hf.duration/seek(seconds)` boundary.
- **Media contracts:** images, video, audio, and generated material first enter a ledger with hashes, provenance, rights, and original/proxy relationships. `media-timeline` v1 defines the portable timeline; `media-delivery` v3 binds the provider, editable sources, render receipt, and SHA-256 values to the output.
- **Long-running state:** `media-project-state.json` records production stages, artifact hashes, approvals, decisions, blockers, and the next action. It is not an editor project. After MediaFlow Pro import, assets, timeline revisions, and operation history live only in `project.mfp`; the production state only indexes related contracts and artifacts.

## Repository map

| Path | Responsibility |
| --- | --- |
| [skills/visual-multimedia/SKILL.md](skills/visual-multimedia/SKILL.md) | Lightweight composite routing, content gate, and artifact handoff |
| [references](references) | Production methods loaded only for the current media task |
| [assets](assets) | Web starter, real contract cases, production profiles, and reusable resources |
| [schemas](schemas) | Contracts for sources, timelines, review, delivery, characters, and editable web packages |
| [scripts](scripts) | Import, validation, planning, rendering, review, and delivery tools |
| `skills/<name>/agents/openai.yaml` | Per-Skill Agent-host adapter metadata |
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

`--full` adds real non-GUI and editable-web GitHub project intro cases with bilingual captions and MediaFlow Pro assembly, plus producer-to-consumer chains for direction, portable timelines, provider routing, Node and Python media processing, review, and final delivery.

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

- Original source code, the Skill, scripts, schemas, templates, and documentation are licensed under the [Mozilla Public License 2.0](LICENSE).
- Personal avatars, characters, brand material, project-owned or project-generated media, renders, and previews are excluded from MPL-2.0 and remain reserved under [ASSET-LICENSE](ASSET-LICENSE). Third-party material remains subject to its own terms.
- The React starter's direct dependencies, exact versions, and licenses are recorded in its [third-party notices](assets/react-media-starter/THIRD_PARTY_NOTICES.md), which are also included in every sealed build. The starter contains no Remotion source, Composition, Renderer, or other Remotion runtime component.

[LICENSING.md](LICENSING.md) is the authoritative path-level statement of scope, exclusions, and third-party coverage.

## Third-party resources and acknowledgements

- [Vincentwei1021/video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft): semantic material for 104 shot cards and 161 style variants under `assets/shot-recipe-library/recipes/` was rewritten from the Apache-2.0 upstream, Copyright 2026 Wei Yihao. Upstream Remotion TSX, product screenshots, audio, preview MP4 files, and Gallery implementation are not copied. See the [shot-recipe notices](assets/shot-recipe-library/THIRD_PARTY_NOTICES.md).
- `sakura-animate-text`: the text-motion families in `assets/text-motion-library/text-motion-runtime.js` are a deterministic reimplementation under the MIT License, Copyright 2026 Sakura. The upstream WAAPI loop, random delays, CDN loader, framework adapters, sample copy, fonts, and site design are not copied. See the [text-motion notices](assets/text-motion-library/THIRD_PARTY_NOTICES.md).
- [Xiaolai](https://github.com/lxgw/kose-font): `assets/web-card-cases/handdrawn-system-collaboration-flow/assets/fonts/Xiaolai-Regular.ttf` is used by the real hand-drawn Chinese case under the SIL Open Font License 1.1; the complete license is stored beside the font.
- [Lucide](https://github.com/lucide-icons/lucide): the same case embeds selected Lucide Static 1.28.0 paths. Lucide's original icons use ISC; Feather-derived icons including Server, Monitor, and Database also retain Cole Bemis's MIT terms. See the [case notices](assets/web-card-cases/handdrawn-system-collaboration-flow/THIRD_PARTY_NOTICES.md).
