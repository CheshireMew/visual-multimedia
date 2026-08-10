(() => {
  const query = new URLSearchParams(location.search);
  if (query.get("capture") === "1") return;

  if (!window.editableMedia) return;
  const app = document.querySelector("[data-editable-media-app]") || document.querySelector(".app");
  const mount = document.querySelector("#editableMediaEditorMount");
  if (!app || !mount) return;
  mount.innerHTML = `
    <aside class="editor-panel" id="editorPanel" data-editable-interactive aria-label="卡片编辑器">
      <header class="editor-header">
        <h2>编辑卡片</h2>
        <p>右侧改字，左侧实时更新。卡片上的文字也可以直接点击修改。</p>
      </header>
      <div class="editor-actions">
        <button class="primary" id="editorExport" type="button">导出 SVG</button>
        <button id="editorDownload" type="button">下载数据</button>
        <button id="editorPreview" type="button">放大预览</button>
        <button id="editorReset" type="button">恢复初始</button>
      </div>
      <div class="editor-scroll">
        <section class="editor-section editor-scene-wrap" id="editorSceneSection">
          <h3>场景</h3>
          <label class="editor-field">当前场景<select id="editorScene"></select></label>
        </section>
        <section class="editor-section" id="typographySection">
          <h3>字体</h3>
          <div id="typographyEditor"></div>
        </section>
        <section class="editor-section" id="colorSection">
          <h3>颜色</h3>
          <div class="editor-color-grid" id="colorEditor"></div>
        </section>
        <section class="editor-section" id="styleSection">
          <h3>其它样式</h3>
          <div id="styleEditor"></div>
        </section>
        <section class="editor-section">
          <h3>文字与数据</h3>
          <div id="contentEditor"></div>
        </section>
        <p class="editor-status" id="editorStatus" role="status">修改会自动保存在当前浏览器。</p>
      </div>
    </aside>
    <button class="editor-return" id="editorReturn" type="button" data-editable-interactive>返回编辑</button>
  `;

  const panel = document.querySelector("#editorPanel");

  const sceneSelect = document.querySelector("#editorScene");
  const contentRoot = document.querySelector("#contentEditor");
  const typographyRoot = document.querySelector("#typographyEditor");
  const colorRoot = document.querySelector("#colorEditor");
  const styleRoot = document.querySelector("#styleEditor");
  const status = document.querySelector("#editorStatus");
  const resetButton = document.querySelector("#editorReset");
  const exportButton = document.querySelector("#editorExport");
  const downloadButton = document.querySelector("#editorDownload");
  const previewButton = document.querySelector("#editorPreview");
  const returnButton = document.querySelector("#editorReturn");
  let manifest = null;
  let initialState = null;
  let storageKey = null;
  let statusTimer = 0;
  let typographyPresets = [];
  const typographyAvailability = new Map();
  let fontProbeCounter = 0;
  const editorInputs = new Map();
  const boundCanvasFields = new WeakSet();

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function showStatus(message) {
    status.textContent = message;
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.textContent = "";
    }, 2800);
  }

  function currentSceneState(state = editableMedia.getState()) {
    return state.scenes?.[state.scene_id] || null;
  }

  function persist(state) {
    localStorage.setItem(storageKey, JSON.stringify(state));
    showStatus("已保存到当前浏览器");
  }

  function commit(mutator) {
    const state = editableMedia.getState();
    mutator(state);
    state.revision = Number(state.revision || 0) + 1;
    const next = editableMedia.setState(state);
    persist(next);
  }

  function parseStructured(value, fallback) {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return fallback;
    }
  }

  function createField(definition, value, onChange) {
    const label = document.createElement("label");
    label.className = "editor-field";
    label.append(document.createTextNode(definition.name || definition.id));

    let input;
    if (definition.kind === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(value);
      input.addEventListener("change", () => onChange(input.checked));
    } else if (definition.kind === "number") {
      input = document.createElement("input");
      input.type = "number";
      const constraints = definition.constraints || definition;
      if (constraints.minimum !== undefined) input.min = String(constraints.minimum);
      if (constraints.maximum !== undefined) input.max = String(constraints.maximum);
      if (constraints.step !== undefined) input.step = String(constraints.step);
      input.value = String(value ?? "");
      input.addEventListener("input", () => onChange(Number(input.value)));
    } else if (
      Array.isArray(definition.options)
      || Array.isArray(definition.constraints?.choices)
    ) {
      input = document.createElement("select");
      const options = definition.options || definition.constraints.choices;
      options.forEach((option) => {
        const item = document.createElement("option");
        const optionValue = typeof option === "object" ? option.value : option;
        item.value = String(optionValue);
        item.textContent = String(typeof option === "object" ? option.label : option);
        input.append(item);
      });
      input.value = String(value ?? "");
      input.addEventListener("change", () => onChange(input.value));
    } else if (definition.kind === "list" || definition.kind === "table") {
      input = document.createElement("textarea");
      input.value = JSON.stringify(value ?? definition.default ?? [], null, 2);
      input.spellcheck = false;
      input.addEventListener("change", () => {
        const parsed = parseStructured(input.value, value);
        input.value = JSON.stringify(parsed, null, 2);
        onChange(parsed);
      });
    } else {
      const text = String(value ?? "");
      input = text.length > 44 || definition.id.includes("summary")
        ? document.createElement("textarea")
        : document.createElement("input");
      if (input instanceof HTMLInputElement) input.type = "text";
      input.value = text;
      input.addEventListener("input", () => onChange(input.value));
    }
    input.dataset.editorField = definition.id;
    editorInputs.set(definition.id, input);
    label.append(input);
    return label;
  }

  function createThemeField(definition, value) {
    if (definition.kind !== "color") {
      return createField(definition, value, (nextValue) => {
        commit((state) => {
          state.theme[definition.id] = nextValue;
        });
      });
    }

    const label = document.createElement("label");
    label.className = "editor-color-field";
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#000000";
    const update = (nextValue) => {
      picker.value = /^#[0-9a-f]{6}$/i.test(nextValue) ? nextValue : picker.value;
      commit((state) => {
        state.theme[definition.id] = nextValue;
      });
    };
    picker.addEventListener("input", () => update(picker.value));
    const name = document.createElement("span");
    name.textContent = definition.name || definition.id;
    picker.dataset.editorField = definition.id;
    label.append(picker, name);
    return label;
  }

  function canvasNodesForField(fieldId) {
    return Array.from(document.querySelectorAll("[data-editable-data]"))
      .filter((node) => node.dataset.editableData === fieldId);
  }

  function contentGroup(fieldId) {
    const node = canvasNodesForField(fieldId)[0];
    return node?.dataset.editorSection
      || node?.closest("[data-editor-section]")?.dataset.editorSection
      || "其它内容";
  }

  function renderContentGroups(definitions, scene) {
    editorInputs.clear();
    const groups = new Map();
    definitions.forEach((definition) => {
      const name = contentGroup(definition.id);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(definition);
    });
    return Array.from(groups, ([name, fields]) => {
      const group = document.createElement("div");
      group.className = "editor-group";
      const heading = document.createElement("p");
      heading.className = "editor-group-title";
      heading.textContent = name;
      group.append(heading, ...fields.map((definition) =>
        createField(definition, scene.data?.[definition.id], (nextValue) => {
          commit((nextState) => {
            nextState.scenes[nextState.scene_id].data[definition.id] = nextValue;
          });
        })
      ));
      return group;
    });
  }

  function escapeLocalFontName(value) {
    return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  }

  async function localFontAvailable(role) {
    for (const localName of role.local_names || []) {
      const probeFamily = `EditableMediaFontProbe${fontProbeCounter += 1}`;
      const face = new FontFace(
        probeFamily,
        `local("${escapeLocalFontName(localName)}")`,
        {weight: String(role.weight)}
      );
      try {
        await face.load();
        if (face.status === "loaded") return true;
      } catch (_error) {
        // Try the next exact local name. A CSS fallback is not proof that this font exists.
      }
    }
    return false;
  }

  async function evaluateTypographyAvailability() {
    typographyAvailability.clear();
    await Promise.all(typographyPresets.map(async (profile) => {
      const roles = await Promise.all([profile.display, profile.body].map(localFontAvailable));
      typographyAvailability.set(profile.id, roles.every(Boolean));
    }));
  }

  function fontAvailable(profile) {
    return typographyAvailability.get(profile.id) === true;
  }

  function applyTypographyPreset(profileId) {
    const profile = typographyPresets.find((item) => item.id === profileId);
    if (!profile || !fontAvailable(profile)) return;
    commit((state) => {
      state.theme.font_display = profile.display.family;
      state.theme.font_body = profile.body.family;
      state.theme.font_display_weight = profile.display.weight;
      state.theme.font_body_weight = profile.body.weight;
    });
    renderEditor();
    showStatus(`已应用字体：${profile.name}`);
  }

  function renderTypographyPreset() {
    if (typographyPresets.length === 0) return null;
    const label = document.createElement("label");
    label.className = "editor-field";
    label.append(document.createTextNode("字体组合"));
    const select = document.createElement("select");
    select.id = "editorTypographyPreset";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择字体组合";
    select.append(placeholder);
    typographyPresets.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.disabled = !fontAvailable(profile);
      option.textContent = option.disabled
        ? `${profile.name}（${profile.unavailable_label || "当前不可用"}）`
        : profile.name;
      select.append(option);
    });
    select.addEventListener("change", () => applyTypographyPreset(select.value));
    label.append(select);
    return label;
  }

  function bindCanvasEditing() {
    const definitions = new Map((manifest.data_fields || []).map((item) => [item.id, item]));
    document.querySelectorAll("[data-editable-data]").forEach((node) => {
      const fieldId = node.dataset.editableData;
      const definition = definitions.get(fieldId);
      if (!definition || definition.kind !== "string" || boundCanvasFields.has(node)) return;
      boundCanvasFields.add(node);
      node.dataset.editorField = fieldId;
      node.contentEditable = "true";
      node.spellcheck = false;
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && node.dataset.editorSingleLine === "true") {
          event.preventDefault();
          node.blur();
        }
      });
      node.addEventListener("input", () => {
        const input = editorInputs.get(fieldId);
        if (input) input.value = node.innerText;
      });
      node.addEventListener("blur", () => {
        const value = node.innerText.replace(/\n{3,}/g, "\n\n").trim();
        commit((state) => {
          state.scenes[state.scene_id].data[fieldId] = value;
        });
        const input = editorInputs.get(fieldId);
        if (input) input.value = value;
      });
    });
  }

  function renderEditor() {
    const state = editableMedia.getState();
    const scene = currentSceneState(state);
    if (!scene) return;
    sceneSelect.value = state.scene_id;
    document.querySelector("#editorSceneSection").hidden = (manifest.scenes || []).length < 2;
    contentRoot.replaceChildren(...renderContentGroups(manifest.data_fields || [], scene));
    const themeVariables = manifest.theme_variables || [];
    const typography = themeVariables.filter((item) => item.kind === "font" || item.id.startsWith("font_"));
    const colors = themeVariables.filter((item) => item.kind === "color");
    const styles = themeVariables.filter((item) => !typography.includes(item) && !colors.includes(item));
    const preset = renderTypographyPreset();
    typographyRoot.replaceChildren(
      ...(preset ? [preset] : []),
      ...typography.map((definition) => createThemeField(definition, state.theme?.[definition.id])),
    );
    colorRoot.replaceChildren(...colors.map((definition) =>
      createThemeField(definition, state.theme?.[definition.id])
    ));
    styleRoot.replaceChildren(...styles.map((definition) =>
      createThemeField(definition, state.theme?.[definition.id])
    ));
    document.querySelector("#typographySection").hidden = typography.length === 0 && !preset;
    document.querySelector("#colorSection").hidden = colors.length === 0;
    document.querySelector("#styleSection").hidden = styles.length === 0;
    bindCanvasEditing();
  }

  function collectCssText() {
    const rules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) rules.push(rule.cssText);
      } catch (_error) {
        // The starter is self-contained; inaccessible remote sheets are not export inputs.
      }
    }
    return rules.join("\n");
  }

  function exportSvg() {
    const canvas = document.querySelector("#mediaCanvas");
    const state = editableMedia.getState();
    const variant = manifest.variants.find((item) => item.id === state.variant.id);
    const width = Number(variant.canvas.width);
    const height = Number(variant.canvas.height);
    const rootVariables = Array.from(document.documentElement.style)
      .map((name) => `${name}:${document.documentElement.style.getPropertyValue(name)};`)
      .join("");
    const clone = canvas.cloneNode(true);
    clone.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
    const markup = new XMLSerializer().serializeToString(clone);
    const documentMarkup = `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" data-editable-variant="${state.variant.id}"><head><meta charset="utf-8"/><style>:root{--canvas-width:${width};--canvas-height:${height};${rootVariables}}${collectCssText()}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}.media-canvas{transform:none!important}</style></head><body class="capture">${markup}</body></html>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%">${documentMarkup}</foreignObject></svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${manifest.component?.id || "editable-media"}-${state.scene_id}-${state.variant.id}.svg`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showStatus("当前画布已导出");
  }

  function downloadData() {
    const state = editableMedia.getState();
    const payload = {
      protocol: "editable-media-scene-data",
      version: 1,
      component_id: manifest.component?.id || null,
      variant_id: state.variant.id,
      scene_id: state.scene_id,
      data: state.scenes[state.scene_id].data,
      theme: state.theme,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${manifest.component?.id || "editable-media"}-${state.scene_id}-data.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showStatus("当前修改数据已下载");
  }

  function setPreviewExpanded(expanded) {
    app.classList.toggle("editor-preview-expanded", expanded);
    previewButton.textContent = expanded ? "返回编辑" : "放大预览";
    window.dispatchEvent(new Event("resize"));
  }

  async function loadTypographyPresets() {
    if (!(manifest.resources || []).includes("typography-presets.json")) return;
    const response = await fetch("typography-presets.json", {cache: "no-store"});
    if (!response.ok) throw new Error(`字体预设返回 ${response.status}`);
    const document = await response.json();
    if (document.protocol !== "visual-multimedia-typography-presets" || document.version !== 2) {
      throw new Error("字体预设协议不正确");
    }
    typographyPresets = Array.isArray(document.profiles) ? document.profiles : [];
    await evaluateTypographyAvailability();
  }

  editableMedia.ready.then(async () => {
    manifest = editableMedia.getManifest();
    initialState = editableMedia.getState();
    const identity = JSON.stringify({
      component: manifest.component?.id,
      scenes: (manifest.scenes || []).map((item) => item.id),
      fields: (manifest.data_fields || []).map((item) => item.id),
    });
    storageKey = `editable-media-preview:${stableHash(identity)}`;
    await loadTypographyPresets();
    sceneSelect.replaceChildren(...(manifest.scenes || []).map((scene) => {
      const option = document.createElement("option");
      option.value = scene.id;
      option.textContent = scene.name || scene.title || scene.id;
      return option;
    }));
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        editableMedia.setState(JSON.parse(saved));
      } catch (_error) {
        localStorage.removeItem(storageKey);
      }
    }
    renderEditor();
    sceneSelect.addEventListener("change", () => {
      editableMedia.pause();
      editableMedia.setScene(sceneSelect.value);
      const state = editableMedia.getState();
      persist(state);
      renderEditor();
    });
    resetButton.addEventListener("click", () => {
      localStorage.removeItem(storageKey);
      editableMedia.pause();
      editableMedia.setState(clone(initialState));
      renderEditor();
      showStatus("已恢复清单初始值");
    });
    exportButton.addEventListener("click", exportSvg);
    downloadButton.addEventListener("click", downloadData);
    previewButton.addEventListener("click", () => {
      setPreviewExpanded(!app.classList.contains("editor-preview-expanded"));
    });
    returnButton.addEventListener("click", () => setPreviewExpanded(false));
    window.addEventListener("editablemediascenechange", renderEditor);
  }).catch((error) => {
    status.textContent = `编辑器载入失败：${error.message}`;
  });
})();
