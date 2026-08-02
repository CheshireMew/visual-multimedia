(() => {
  "use strict";

  const runtimeScript = document.currentScript;
  let nodes = new Map();
  const defaults = new Map();
  let manifest = null;
  let mediaSourcesManifest = null;
  let mediaSourcesUrl = null;
  let mediaSources = new Map();
  let state = {
    scenes: {}, theme: {}, theme_bindings: {},
    parameters: {}, parameter_bindings: {}, parameter_locks: [],
    variant: {},
    scene_id: null, playback: { mode: "manual" }, revision: 0,
  };
  let lastDataSignature = null;
  let lastParameterSignature = null;
  let currentGlobalTimeMs = 0;
  let currentLocalTimeMs = 0;
  let playing = false;
  let startedAt = 0;
  let playbackEndMs = 0;
  let animationFrame = 0;
  let editMode = false;
  let selectedLayerId = null;
  let drag = null;
  let capabilities = {};
  let overviewOpen = false;
  let wheelLockedUntil = 0;
  let touchStart = null;
  const cameraStyledLayerIds = new Set();
  const overlay = document.createElement("div");
  const resizeHandle = document.createElement("button");
  const rotateHandle = document.createElement("button");
  const guideX = document.createElement("div");
  const guideY = document.createElement("div");
  const overview = document.createElement("div");

  function refreshNodes() {
    nodes = new Map(
      Array.from(document.querySelectorAll("[data-editable-id]")).map((node) => [
        node.dataset.editableId,
        node,
      ])
    );
  }

  refreshNodes();

  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed", pointerEvents: "none", border: "2px solid #315efb",
    zIndex: "2147483645", display: "none",
  });
  [resizeHandle, rotateHandle].forEach((handle) => Object.assign(handle.style, {
    position: "absolute", width: "14px", height: "14px", padding: "0",
    border: "2px solid white", borderRadius: "50%", background: "#315efb",
    pointerEvents: "auto",
  }));
  Object.assign(resizeHandle.style, { right: "-8px", bottom: "-8px", cursor: "nwse-resize" });
  Object.assign(rotateHandle.style, { left: "calc(50% - 7px)", top: "-28px", cursor: "grab" });
  [guideX, guideY].forEach((guide) => Object.assign(guide.style, {
    position: "fixed", display: "none", background: "#ff3b7f",
    zIndex: "2147483644", pointerEvents: "none",
  }));
  Object.assign(guideX.style, { top: "0", bottom: "0", width: "1px" });
  Object.assign(guideY.style, { left: "0", right: "0", height: "1px" });
  overlay.append(resizeHandle, rotateHandle);
  Object.assign(overview.style, {
    position: "fixed", inset: "0", display: "none",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    alignContent: "center", gap: "16px", padding: "min(8vw, 96px)",
    background: "rgb(15 18 24 / 92%)", zIndex: "2147483643",
    overflow: "auto",
  });
  overview.setAttribute("role", "dialog");
  overview.setAttribute("aria-label", "Scene overview");
  document.body.append(guideX, guideY, overlay, overview);

  function clone(value) {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function mergeLayerMaps(base, override) {
    const ids = new Set([
      ...Object.keys(base || {}),
      ...Object.keys(override || {}),
    ]);
    return Object.fromEntries(
      Array.from(ids, (id) => [id, {
        ...(base?.[id] || {}),
        ...(override?.[id] || {}),
      }])
    );
  }

  function manifestLayerDefaults() {
    return Object.fromEntries(
      (manifest?.layers || []).map((layer) => [
        layer.id,
        clone(layer.default_bounds || {}),
      ])
    );
  }

  function layerDifferences(current, base) {
    return Object.fromEntries(
      Object.entries(current || {}).flatMap(([layerId, values]) => {
        const changed = Object.fromEntries(
          Object.entries(values || {}).filter(
            ([field, value]) => !Object.is(value, base?.[layerId]?.[field])
          )
        );
        return Object.keys(changed).length ? [[layerId, changed]] : [];
      })
    );
  }

  function sceneDefinition(sceneId = state.scene_id) {
    return manifest?.scenes?.find((scene) => scene.id === sceneId) || null;
  }

  function sceneState(sceneId = state.scene_id) {
    return state.scenes?.[sceneId] || {
      layers: {}, animations: {}, data: {}, locks: {},
      parameters: {}, parameter_animations: {}, parameter_locks: [],
    };
  }

  function resolveMediaSource(sourceId) {
    if (typeof sourceId !== "string" || !sourceId) return "";
    const source = mediaSources.get(sourceId);
    if (!source) {
      throw new Error(`Unknown media source id: ${sourceId}`);
    }
    return new URL(source.file, mediaSourcesUrl).href;
  }

  function resolveImageSource(sourceId) {
    const source = mediaSources.get(sourceId);
    if (!source
      || !["photo", "screenshot", "video-frame", "icon", "generated"]
        .includes(source.media_type)
      || source.acquisition?.method === "generated-in-project") {
      throw new Error(`Media source cannot be used by an image element: ${sourceId}`);
    }
    return resolveMediaSource(sourceId);
  }

  function totalDuration() {
    return (manifest?.scenes || []).reduce(
      (sum, scene) => sum + Number(scene.duration_ms || 0),
      0
    );
  }

  function sceneStartTime(sceneId) {
    let start = 0;
    for (const scene of manifest?.scenes || []) {
      if (scene.id === sceneId) return start;
      start += Number(scene.duration_ms || 0);
    }
    return 0;
  }

  function resolveTime(milliseconds) {
    const duration = totalDuration();
    const bounded = Math.max(0, Math.min(duration, Number(milliseconds) || 0));
    const scenes = manifest?.scenes || [];
    let start = 0;
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      const sceneDuration = Number(scene.duration_ms || 0);
      const end = start + sceneDuration;
      if (bounded < end || index === scenes.length - 1) {
        return {
          globalTimeMs: bounded,
          localTimeMs: Math.max(0, Math.min(sceneDuration, bounded - start)),
          scene,
          sceneIndex: index,
          sceneStartMs: start,
        };
      }
      start = end;
    }
    return {
      globalTimeMs: 0, localTimeMs: 0,
      scene: scenes[0] || null, sceneIndex: 0, sceneStartMs: 0,
    };
  }

  function cubicCoordinate(t, p1, p2) {
    const inverse = 1 - t;
    return 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t;
  }

  function easingProgress(progress, easing) {
    const bounded = Math.max(0, Math.min(1, progress));
    const kind = easing?.kind || "linear";
    if (kind === "step") return bounded < 1 ? 0 : 1;
    if (kind === "ease_in") return bounded * bounded * bounded;
    if (kind === "ease_out") return 1 - Math.pow(1 - bounded, 3);
    if (kind === "ease_in_out") {
      return bounded < .5 ? 4 * bounded * bounded * bounded
        : 1 - Math.pow(-2 * bounded + 2, 3) / 2;
    }
    if (kind !== "cubic_bezier") return bounded;
    const x1 = Number(easing.x1 ?? .25);
    const y1 = Number(easing.y1 ?? .1);
    const x2 = Number(easing.x2 ?? .25);
    const y2 = Number(easing.y2 ?? 1);
    let low = 0;
    let high = 1;
    let parameter = bounded;
    for (let index = 0; index < 18; index += 1) {
      parameter = (low + high) / 2;
      const x = cubicCoordinate(parameter, x1, x2);
      if (x < bounded) low = parameter;
      else high = parameter;
    }
    return cubicCoordinate(parameter, y1, y2);
  }

  function cameraKeyframes(camera) {
    const stepTimes = new Map(
      (sceneDefinition()?.steps || []).map((step) => [
        step.id,
        Number(step.at_ms || 0),
      ])
    );
    return (camera?.keyframes || []).map((keyframe) => ({
      ...keyframe,
      time_ms: stepTimes.get(keyframe.step_id),
    })).filter((keyframe) => Number.isFinite(keyframe.time_ms))
      .sort((left, right) => left.time_ms - right.time_ms);
  }

  function currentCameraState() {
    const scene = sceneDefinition();
    const camera = scene?.motion?.camera;
    if (!camera) return null;
    const keyframes = cameraKeyframes(camera);
    if (!keyframes.length) return null;
    let values = keyframes[0];
    if (currentLocalTimeMs >= keyframes.at(-1).time_ms) {
      values = keyframes.at(-1);
    } else if (currentLocalTimeMs > keyframes[0].time_ms) {
      for (let index = 0; index < keyframes.length - 1; index += 1) {
        const left = keyframes[index];
        const right = keyframes[index + 1];
        if (currentLocalTimeMs < left.time_ms || currentLocalTimeMs > right.time_ms) continue;
        const duration = Math.max(1, right.time_ms - left.time_ms);
        const progress = easingProgress(
          (currentLocalTimeMs - left.time_ms) / duration,
          { kind: right.easing || "linear" }
        );
        values = {
          step_id: progress < 1 ? left.step_id : right.step_id,
          x: Number(left.x) + (Number(right.x) - Number(left.x)) * progress,
          y: Number(left.y) + (Number(right.y) - Number(left.y)) * progress,
          zoom: Number(left.zoom) + (Number(right.zoom) - Number(left.zoom)) * progress,
          focus_depth: Number(left.focus_depth)
            + (Number(right.focus_depth) - Number(left.focus_depth)) * progress,
          aperture: Number(left.aperture)
            + (Number(right.aperture) - Number(left.aperture)) * progress,
        };
        break;
      }
    }
    const x = Number(values.x);
    const y = Number(values.y);
    const zoom = Number(values.zoom);
    const focusDepth = Number(values.focus_depth);
    const aperture = Number(values.aperture);
    return {
      sceneId: scene.id,
      rootLayerId: camera.root_layer_id,
      x,
      y,
      zoom,
      focusDepth,
      aperture,
      readabilityLayerIds: clone(camera.readability_layer_ids || []),
      depthLayers: (camera.depth_layers || []).map((item) => ({
        layerId: item.layer_id,
        depth: Number(item.depth),
        x: -x * Number(item.depth) * 0.6,
        y: -y * Number(item.depth) * 0.6,
        scale: Math.max(0.5, 1 + (zoom - 1) * Number(item.depth) * 0.65),
        blur: Math.max(0, aperture * Math.abs(Number(item.depth) - focusDepth)),
      })),
    };
  }

  function clearCameraNode(id) {
    const node = nodes.get(id);
    if (!node) return;
    [
      "transform",
      "filter",
      "transform-origin",
      "will-change",
      "--editable-camera-blur",
    ].forEach(
      (property) => node.style.removeProperty(property)
    );
    node.removeAttribute("data-editable-camera-layer");
  }

  function clearCameraStyles() {
    cameraStyledLayerIds.forEach(clearCameraNode);
    cameraStyledLayerIds.clear();
    delete document.documentElement.dataset.editableCamera;
    [
      "--editable-camera-x",
      "--editable-camera-y",
      "--editable-camera-zoom",
      "--editable-camera-focus-depth",
      "--editable-camera-aperture",
    ].forEach((property) => document.documentElement.style.removeProperty(property));
  }

  function applyCamera() {
    const camera = currentCameraState();
    if (!camera) {
      clearCameraStyles();
      return;
    }
    const root = nodes.get(camera.rootLayerId);
    if (!root) {
      clearCameraStyles();
      return;
    }
    const nextLayerIds = new Set([
      camera.rootLayerId,
      ...camera.depthLayers
        .filter((layer) => nodes.has(layer.layerId))
        .map((layer) => layer.layerId),
    ]);
    cameraStyledLayerIds.forEach((id) => {
      if (!nextLayerIds.has(id)) clearCameraNode(id);
    });
    root.style.transform =
      `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
    root.style.removeProperty("filter");
    root.style.transformOrigin = "50% 50%";
    root.style.removeProperty("will-change");
    root.dataset.editableCameraLayer = "root";
    camera.depthLayers.forEach((layer) => {
      const node = nodes.get(layer.layerId);
      if (!node) return;
      node.style.transform =
        `translate(${layer.x}px, ${layer.y}px) scale(${layer.scale})`;
      node.style.transformOrigin = "50% 50%";
      node.style.removeProperty("will-change");
      const renderedBlur = layer.blur < 0.05
        ? 0
        : Number(layer.blur.toFixed(4));
      node.style.filter = renderedBlur === 0
        ? "none"
        : `blur(${renderedBlur}px)`;
      node.style.setProperty("--editable-camera-blur", String(renderedBlur));
      node.dataset.editableCameraLayer = "depth";
    });
    cameraStyledLayerIds.clear();
    nextLayerIds.forEach((id) => cameraStyledLayerIds.add(id));
    document.documentElement.dataset.editableCamera = "active";
    document.documentElement.style.setProperty("--editable-camera-x", String(camera.x));
    document.documentElement.style.setProperty("--editable-camera-y", String(camera.y));
    document.documentElement.style.setProperty("--editable-camera-zoom", String(camera.zoom));
    document.documentElement.style.setProperty(
      "--editable-camera-focus-depth",
      String(camera.focusDepth)
    );
    document.documentElement.style.setProperty(
      "--editable-camera-aperture",
      String(camera.aperture)
    );
  }

  function animatedValue(track) {
    const keyframes = track?.keyframes || [];
    if (!keyframes.length) return undefined;
    if (currentLocalTimeMs <= keyframes[0].time_ms) return keyframes[0].value;
    const last = keyframes[keyframes.length - 1];
    if (currentLocalTimeMs >= last.time_ms) return last.value;
    for (let index = 0; index < keyframes.length - 1; index += 1) {
      const left = keyframes[index];
      const right = keyframes[index + 1];
      if (currentLocalTimeMs < left.time_ms || currentLocalTimeMs > right.time_ms) continue;
      if (track.interpolation === "discrete") return left.value;
      const duration = Math.max(1, right.time_ms - left.time_ms);
      const progress = easingProgress(
        (currentLocalTimeMs - left.time_ms) / duration,
        left.easing
      );
      return Number(left.value) + (Number(right.value) - Number(left.value)) * progress;
    }
    return last.value;
  }

  function effectiveParameters(sceneId = state.scene_id) {
    const current = sceneState(sceneId);
    const values = {
      ...(state.parameters || {}),
      ...(current.parameters || {}),
    };
    Object.entries(current.parameter_animations || {}).forEach(
      ([parameterId, track]) => {
        const animated = animatedValue(track);
        if (animated !== undefined) values[parameterId] = animated;
      }
    );
    return values;
  }

  function applyParameters() {
    const values = effectiveParameters();
    Object.entries(state.parameter_bindings || {}).forEach(
      ([parameterId, cssVariable]) => {
        if (Object.prototype.hasOwnProperty.call(values, parameterId)) {
          document.documentElement.style.setProperty(
            cssVariable,
            String(values[parameterId])
          );
        } else {
          document.documentElement.style.removeProperty(cssVariable);
        }
      }
    );
    const signature = JSON.stringify({
      sceneId: state.scene_id,
      values,
    });
    if (signature !== lastParameterSignature) {
      emit("editablemediaparameters", {
        sceneId: state.scene_id,
        values: clone(values),
      });
      lastParameterSignature = signature;
    }
  }

  function effectiveLayer(id) {
    const current = sceneState();
    const value = { ...(current.layers[id] || {}) };
    const tracks = current.animations[id] || {};
    Object.entries(tracks).forEach(([field, track]) => {
      const animated = animatedValue(track);
      if (animated !== undefined) value[field] = animated;
    });
    return value;
  }

  function fieldLocked(id, field) {
    return (sceneState().locks[id] || []).includes(field);
  }

  function applyThemeAndData() {
    applyParameters();
    Object.entries(state.theme_bindings || {}).forEach(([id, cssVariable]) => {
      if (Object.prototype.hasOwnProperty.call(state.theme, id)) {
        document.documentElement.style.setProperty(cssVariable, String(state.theme[id]));
      }
    });
    const current = sceneState();
    document.querySelectorAll("[data-editable-data]").forEach((node) => {
      const value = current.data[node.dataset.editableData];
      if (value !== undefined) node.textContent = typeof value === "string" ? value : JSON.stringify(value);
    });
    document.querySelectorAll("[data-editable-image]").forEach((node) => {
      const value = current.data[node.dataset.editableImage];
      if (node instanceof HTMLImageElement && typeof value === "string" && value) {
        node.src = resolveImageSource(value);
      }
    });
    const titleField = manifest?.accessibility?.title_data_field;
    if (titleField && typeof current.data[titleField] === "string") {
      const accessibleTitle = current.data[titleField].replace(/\s+/g, " ").trim();
      if (accessibleTitle) {
        document.title = accessibleTitle;
        const canvas = document.querySelector(
          manifest.accessibility.canvas_selector || ".media-canvas"
        );
        if (canvas) canvas.setAttribute("aria-label", accessibleTitle);
      }
    }
    const dataSignature = JSON.stringify({
      sceneId: state.scene_id,
      data: current.data || {},
    });
    if (dataSignature !== lastDataSignature) {
      emit("editablemediadata", {
        sceneId: state.scene_id,
        data: current.data,
      });
      lastDataSignature = dataSignature;
      const previousNodes = nodes;
      refreshNodes();
      nodes.forEach((node, id) => {
        if (previousNodes.get(id) !== node && defaults.size > 0) {
          captureDefault(id, node);
        }
      });
      Array.from(defaults.keys()).forEach((id) => {
        if (!nodes.has(id)) defaults.delete(id);
      });
    }
    if (state.variant?.id) {
      document.documentElement.dataset.editableVariant = state.variant.id;
      document.documentElement.style.setProperty(
        "--editable-canvas-width",
        String(state.variant.width)
      );
      document.documentElement.style.setProperty(
        "--editable-canvas-height",
        String(state.variant.height)
      );
      document.documentElement.style.setProperty("--canvas-width", String(state.variant.width));
      document.documentElement.style.setProperty("--canvas-height", String(state.variant.height));
    }
    if (state.scene_id) {
      document.documentElement.dataset.editableScene = state.scene_id;
      const layoutId = sceneDefinition()?.layout_id;
      if (layoutId) document.documentElement.dataset.editableLayoutContract = layoutId;
    }
  }

  function captureDefault(id, node) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    defaults.set(id, {
      content: node.textContent,
      image: node instanceof HTMLImageElement ? node.getAttribute("src") : null,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      opacity: style.opacity,
      zIndex: style.zIndex,
      display: style.display,
      visibility: style.visibility,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }

  function captureDefaults() {
    defaults.clear();
    nodes.forEach((node, id) => captureDefault(id, node));
  }

  function declaredLayerBaseline(id) {
    const layer = manifest?.layers?.find((item) => item.id === id);
    const variant = manifest?.variants?.find(
      (item) => item.id === state.variant?.id
    );
    return {
      ...(layer?.default_bounds || {}),
      ...(variant?.layers?.[id] || {}),
    };
  }

  function clearRuntimeStyles() {
    clearCameraStyles();
    nodes.forEach((node) => {
      [
        "color", "font-family", "font-size", "width", "height", "translate",
        "rotate", "opacity", "z-index", "display", "visibility",
        "--editable-delay-ms", "--editable-duration-ms",
      ].forEach((property) => node.style.removeProperty(property));
    });
  }

  function applyLayer(id) {
    const node = nodes.get(id);
    const base = defaults.get(id);
    if (!node || !base) return;
    const value = effectiveLayer(id);
    const declared = declaredLayerBaseline(id);
    if (Object.prototype.hasOwnProperty.call(value, "content")) {
      node.textContent = value.content ?? base.content;
    } else if (!node.dataset.editableData
      && node.children.length === 0
      && !(node instanceof HTMLImageElement)) {
      node.textContent = base.content;
    }
    if (node instanceof HTMLImageElement) {
      if (Object.prototype.hasOwnProperty.call(value, "image")) {
        node.src = value.image ? resolveImageSource(value.image) : (base.image ?? "");
      } else if (!node.dataset.editableImage) {
        node.src = base.image ?? "";
      }
    }
    node.style.color = value.color == null || value.color === base.color
      ? ""
      : value.color;
    node.style.fontFamily = value.font_family == null
      || value.font_family === base.fontFamily
      ? ""
      : value.font_family;
    const baseFontSize = Number.parseFloat(base.fontSize);
    const declaredFontSize = declared.font_size ?? baseFontSize;
    node.style.fontSize = value.font_size == null
      || value.font_size === declaredFontSize
      ? ""
      : `${value.font_size}px`;
    node.style.width = value.width == null || value.width === declared.width
      ? ""
      : `${value.width}px`;
    node.style.height = value.height == null || value.height === declared.height
      ? ""
      : `${value.height}px`;
    const translateX = (
      (value.x ?? declared.x ?? base.rect.x) - (declared.x ?? base.rect.x)
    );
    const translateY = (
      (value.y ?? declared.y ?? base.rect.y) - (declared.y ?? base.rect.y)
    );
    node.style.translate = translateX === 0 && translateY === 0
      ? ""
      : `${translateX}px ${translateY}px`;
    const declaredRotation = Number(declared.rotation || 0);
    node.style.rotate = value.rotation == null || value.rotation === declaredRotation
      ? ""
      : `${value.rotation - declaredRotation}deg`;
    const declaredOpacity = Number(declared.opacity ?? base.opacity);
    node.style.opacity = value.opacity == null || value.opacity === declaredOpacity
      ? ""
      : String(value.opacity);
    const declaredZIndex = declared.z_index == null
      ? base.zIndex
      : String(declared.z_index);
    node.style.zIndex = value.z_index == null || String(value.z_index) === declaredZIndex
      ? ""
      : String(value.z_index);
    const insideTime = (value.enter_ms == null || currentLocalTimeMs >= value.enter_ms)
      && (value.exit_ms == null || currentLocalTimeMs <= value.exit_ms);
    const declaredVisible = declared.visible
      ?? (base.display !== "none" && base.visibility !== "hidden");
    const requestedVisible = value.visible ?? declaredVisible;
    node.style.display = requestedVisible && !declaredVisible && base.display === "none"
      ? "block"
      : !requestedVisible && declaredVisible
        ? "none"
        : "";
    node.style.visibility = requestedVisible && insideTime
      ? requestedVisible === declaredVisible ? "" : "visible"
      : "hidden";
    if (value.delay_ms == null) node.style.removeProperty("--editable-delay-ms");
    else node.style.setProperty("--editable-delay-ms", String(value.delay_ms));
    if (value.duration_ms == null) node.style.removeProperty("--editable-duration-ms");
    else node.style.setProperty("--editable-duration-ms", String(value.duration_ms));
    node.toggleAttribute("data-editable-selected", selectedLayerId === id);
    if (selectedLayerId === id) updateOverlay();
  }

  function applyState() {
    applyThemeAndData();
    nodes.forEach((_node, id) => applyLayer(id));
    applyCamera();
  }

  function getState() {
    return clone(state);
  }

  function setState(nextState) {
    const nextVariant = clone(nextState?.variant || state.variant || {});
    const variantChanged = nextVariant.id && nextVariant.id !== state.variant?.id;
    const previousSceneId = state.scene_id;
    state = {
      scenes: clone(nextState?.scenes || state.scenes || {}),
      theme: clone(nextState?.theme || {}),
      theme_bindings: clone(nextState?.theme_bindings || {}),
      parameters: clone(nextState?.parameters || {}),
      parameter_bindings: clone(nextState?.parameter_bindings || {}),
      parameter_locks: clone(nextState?.parameter_locks || []),
      variant: nextVariant,
      scene_id: nextState?.scene_id || state.scene_id,
      playback: {
        mode: nextState?.playback?.mode || state.playback?.mode || "manual",
      },
      revision: Number(nextState?.revision || 0),
    };
    if (variantChanged) {
      applyThemeAndData();
      clearRuntimeStyles();
      refreshNodes();
      captureDefaults();
    }
    if (state.scene_id !== previousSceneId) {
      currentGlobalTimeMs = sceneStartTime(state.scene_id);
      currentLocalTimeMs = 0;
    }
    applyState();
    if (state.scene_id !== previousSceneId) emitSceneChange();
    return getState();
  }

  function buildSceneState(scene, variant, previous = null, previousVariant = null) {
    const dataDefaults = Object.fromEntries(
      (manifest.data_fields || []).map((item) => [item.id, clone(item.default)])
    );
    const defaults = manifestLayerDefaults();
    const nextBase = mergeLayerMaps(defaults, variant.layers || {});
    const previousBase = mergeLayerMaps(defaults, previousVariant?.layers || {});
    const previousOverrides = previous
      ? layerDifferences(previous.layers, previousBase)
      : {};
    const parameterDefaults = Object.fromEntries(
      (manifest.parameters || [])
        .filter((item) => item.scope === "scene")
        .map((item) => [item.id, clone(item.default)])
    );
    return {
      layers: mergeLayerMaps(nextBase, previousOverrides),
      animations: clone(previous?.animations || {}),
      parameters: {
        ...parameterDefaults,
        ...(scene.parameters || {}),
        ...(previous?.parameters || {}),
      },
      parameter_animations: clone(previous?.parameter_animations || {}),
      parameter_locks: clone(previous?.parameter_locks || []),
      data: {
        ...dataDefaults,
        ...(scene.data || {}),
        ...(previous?.data || {}),
      },
      locks: clone(previous?.locks || {}),
    };
  }

  function setVariant(variantId) {
    const variant = manifest?.variants?.find((item) => item.id === variantId);
    if (!variant) throw new Error(`Unknown editable-media variant: ${variantId}`);
    const previousVariant = manifest?.variants?.find(
      (item) => item.id === state.variant?.id
    );
    const nextScenes = Object.fromEntries(
      manifest.scenes.map((scene) => [
        scene.id,
        buildSceneState(
          scene,
          variant,
          state.scenes?.[scene.id],
          previousVariant
        ),
      ])
    );
    return setState({
      ...state,
      variant: {
        id: variant.id,
        width: variant.canvas.width,
        height: variant.canvas.height,
      },
      scenes: nextScenes,
    });
  }

  function setTime(milliseconds) {
    const resolved = resolveTime(milliseconds);
    const previousSceneId = state.scene_id;
    currentGlobalTimeMs = resolved.globalTimeMs;
    currentLocalTimeMs = resolved.localTimeMs;
    if (resolved.scene) state.scene_id = resolved.scene.id;
    document.documentElement.style.setProperty(
      "--editable-media-time-ms",
      String(currentGlobalTimeMs)
    );
    document.documentElement.style.setProperty(
      "--editable-scene-time-ms",
      String(currentLocalTimeMs)
    );
    applyState();
    if (state.scene_id !== previousSceneId) emitSceneChange();
    emit("editablemediatime", getPlayback());
    return currentGlobalTimeMs;
  }

  function currentStep() {
    const steps = sceneDefinition()?.steps || [];
    let active = steps[0] || null;
    for (const step of steps) {
      if (Number(step.at_ms) <= currentLocalTimeMs + 0.5) active = step;
      else break;
    }
    return active;
  }

  function getPlayback() {
    const scene = sceneDefinition();
    const camera = currentCameraState();
    return {
      mode: state.playback?.mode || "manual",
      playing,
      globalTimeMs: currentGlobalTimeMs,
      localTimeMs: currentLocalTimeMs,
      totalDurationMs: totalDuration(),
      sceneDurationMs: Number(scene?.duration_ms || 0),
      sceneId: scene?.id || null,
      sceneIndex: Math.max(
        0,
        (manifest?.scenes || []).findIndex((item) => item.id === scene?.id)
      ),
      sceneCount: manifest?.scenes?.length || 0,
      stepId: currentStep()?.id || null,
      motionComplexity: scene?.motion?.complexity || null,
      motionDriver: scene?.motion?.driver || null,
      keyStateReview: scene?.motion?.key_state_review || null,
      cameraActive: camera !== null,
    };
  }

  function emitSceneChange() {
    emit("editablemediascenechange", {
      ...getPlayback(),
      scene: clone(sceneDefinition()),
    });
  }

  function setScene(sceneId, options = {}) {
    const scene = sceneDefinition(sceneId);
    if (!scene) throw new Error(`Unknown editable-media scene: ${sceneId}`);
    const step = options.stepId
      ? scene.steps?.find((item) => item.id === options.stepId)
      : null;
    const localTime = step
      ? Number(step.at_ms || 0)
      : Number(options.timeMs || 0);
    pause();
    return setTime(sceneStartTime(sceneId) + localTime);
  }

  function setPlaybackMode(mode) {
    if (!["manual", "autoplay", "hybrid"].includes(mode)) {
      throw new Error(`Unknown editable-media playback mode: ${mode}`);
    }
    pause();
    state.playback.mode = mode;
    emit("editablemediaplaybackchange", getPlayback());
    return mode;
  }

  function frame(now) {
    if (!playing) return;
    const nextTime = startedAt + now;
    if (nextTime >= playbackEndMs) {
      setTime(playbackEndMs);
      if (state.playback.mode === "autoplay"
        && manifest.playback?.loop === "repeat"
        && playbackEndMs >= totalDuration()) {
        startedAt = -performance.now();
        setTime(0);
        animationFrame = requestAnimationFrame(frame);
        return;
      }
      pause();
      return;
    }
    setTime(nextTime);
    animationFrame = requestAnimationFrame(frame);
  }

  function play() {
    if (playing || state.playback.mode === "manual") return false;
    const scene = sceneDefinition();
    if (!scene) return false;
    const sceneEnd = sceneStartTime(scene.id) + Number(scene.duration_ms || 0);
    playbackEndMs = state.playback.mode === "hybrid" ? sceneEnd : totalDuration();
    if (currentGlobalTimeMs >= playbackEndMs) {
      if (state.playback.mode === "autoplay"
        && manifest.playback?.loop === "repeat") {
        setTime(0);
      } else if (state.playback.mode === "hybrid") {
        setTime(sceneStartTime(scene.id));
      } else {
        return false;
      }
    }
    playing = true;
    startedAt = currentGlobalTimeMs - performance.now();
    animationFrame = requestAnimationFrame(frame);
    emit("editablemediaplaybackchange", getPlayback());
    return true;
  }

  function pause() {
    const wasPlaying = playing;
    playing = false;
    cancelAnimationFrame(animationFrame);
    if (wasPlaying) emit("editablemediaplaybackchange", getPlayback());
    return currentGlobalTimeMs;
  }

  async function seekSeconds(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) {
      throw new TypeError("Editable media seek time must be a finite number");
    }
    pause();
    const duration = totalDuration();
    let milliseconds = value * 1000;
    if (manifest?.playback?.loop === "repeat"
      && duration > 0
      && milliseconds >= duration) {
      milliseconds %= duration;
    }
    const resolved = setTime(milliseconds) / 1000;
    await new Promise((resolve) => requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    }));
    return resolved;
  }

  function installFrameProtocol() {
    const frameProtocol = (
      window.__hf && typeof window.__hf === "object"
        ? window.__hf
        : {}
    );
    Object.defineProperty(frameProtocol, "duration", {
      configurable: true,
      enumerable: true,
      get: () => totalDuration() / 1000,
    });
    frameProtocol.seek = seekSeconds;
    window.__hf = frameProtocol;
    return frameProtocol;
  }

  function registerHyperFramesTimeline() {
    const root = document.querySelector("[data-editable-media-root]");
    const compositionId = root?.dataset.compositionId || "editable-media";
    const timeline = {
      duration: () => totalDuration() / 1000,
      time: () => currentGlobalTimeMs / 1000,
      seek: (seconds) => {
        seekSeconds(seconds);
        return timeline;
      },
      totalTime: (seconds) => {
        if (seconds === undefined) return currentGlobalTimeMs / 1000;
        seekSeconds(seconds);
        return timeline;
      },
      play: () => timeline,
      pause: () => {
        pause();
        return timeline;
      },
      paused: () => true,
      add: () => timeline,
      set: () => timeline,
      getChildren: () => [],
    };
    window.__timelines = window.__timelines || {};
    window.__timelines[compositionId] = timeline;
    window.dispatchEvent(new CustomEvent("hf-timelines-built"));
    if (typeof window.__hfForceTimelineRebind === "function") {
      window.__hfForceTimelineRebind();
    }
    return timeline;
  }

  function next() {
    pause();
    const scene = sceneDefinition();
    if (!scene) return currentGlobalTimeMs;
    const steps = scene.steps || [];
    const nextStep = steps.find(
      (step) => Number(step.at_ms) > currentLocalTimeMs + 0.5
    );
    if (nextStep) {
      return setTime(sceneStartTime(scene.id) + Number(nextStep.at_ms));
    }
    const scenes = manifest.scenes || [];
    const index = scenes.findIndex((item) => item.id === scene.id);
    if (index < scenes.length - 1) return setScene(scenes[index + 1].id);
    if (manifest.playback?.loop === "repeat") return setScene(scenes[0].id);
    return setTime(totalDuration());
  }

  function previous() {
    pause();
    const scene = sceneDefinition();
    if (!scene) return currentGlobalTimeMs;
    const steps = (scene.steps || []).filter(
      (step) => Number(step.at_ms) < currentLocalTimeMs - 0.5
    );
    if (steps.length) {
      return setTime(
        sceneStartTime(scene.id) + Number(steps[steps.length - 1].at_ms)
      );
    }
    const scenes = manifest.scenes || [];
    const index = scenes.findIndex((item) => item.id === scene.id);
    if (index <= 0) return setScene(scenes[0].id);
    const previousScene = scenes[index - 1];
    const previousSteps = previousScene.steps || [];
    const localTime = previousSteps.length
      ? Number(previousSteps[previousSteps.length - 1].at_ms)
      : 0;
    return setScene(previousScene.id, { timeMs: localTime });
  }

  function renderOverview() {
    overview.replaceChildren(...(manifest?.scenes || []).map((scene, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${String(index + 1).padStart(2, "0")}  ${scene.name || scene.id}`;
      Object.assign(button.style, {
        minHeight: "96px", padding: "18px", border: "1px solid rgb(255 255 255 / 35%)",
        borderRadius: "12px", background: scene.id === state.scene_id
          ? "rgb(49 94 251 / 90%)" : "rgb(255 255 255 / 8%)",
        color: "white", font: "600 16px/1.4 system-ui", cursor: "pointer",
      });
      button.addEventListener("click", () => {
        setScene(scene.id);
        toggleOverview(false);
      });
      return button;
    }));
  }

  function toggleOverview(force) {
    if (!manifest?.playback?.controls?.overview) return false;
    overviewOpen = force == null ? !overviewOpen : Boolean(force);
    if (overviewOpen) renderOverview();
    overview.style.display = overviewOpen ? "grid" : "none";
    document.documentElement.toggleAttribute("data-editable-overview", overviewOpen);
    emit("editablemediaoverviewchange", { open: overviewOpen });
    return overviewOpen;
  }

  function getBounds() {
    return Object.fromEntries(
      Array.from(nodes, ([id, node]) => {
        const rect = node.getBoundingClientRect();
        return [id, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          rotation: Number(effectiveLayer(id).rotation || 0),
        }];
      })
    );
  }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: clone(detail) }));
  }

  function updateOverlay() {
    if (!editMode || !selectedLayerId || !nodes.has(selectedLayerId)) {
      overlay.style.display = "none";
      return;
    }
    const rect = nodes.get(selectedLayerId).getBoundingClientRect();
    Object.assign(overlay.style, {
      display: "block", left: `${rect.x}px`, top: `${rect.y}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
      transform: `rotate(${Number(effectiveLayer(selectedLayerId).rotation || 0)}deg)`,
    });
    const fields = capabilities[selectedLayerId] || [];
    resizeHandle.style.display = fields.includes("width") && fields.includes("height") ? "block" : "none";
    rotateHandle.style.display = fields.includes("rotation") ? "block" : "none";
  }

  function snapMove(x, y, width, height) {
    const tolerance = 6;
    const xTargets = [0, innerWidth / 2, innerWidth];
    const yTargets = [0, innerHeight / 2, innerHeight];
    const xPoints = [x, x + width / 2, x + width];
    const yPoints = [y, y + height / 2, y + height];
    guideX.style.display = "none";
    guideY.style.display = "none";
    for (let pointIndex = 0; pointIndex < xPoints.length; pointIndex += 1) {
      const target = xTargets.find((candidate) => Math.abs(candidate - xPoints[pointIndex]) <= tolerance);
      if (target !== undefined) {
        x += target - xPoints[pointIndex];
        guideX.style.left = `${target}px`;
        guideX.style.display = "block";
        break;
      }
    }
    for (let pointIndex = 0; pointIndex < yPoints.length; pointIndex += 1) {
      const target = yTargets.find((candidate) => Math.abs(candidate - yPoints[pointIndex]) <= tolerance);
      if (target !== undefined) {
        y += target - yPoints[pointIndex];
        guideY.style.top = `${target}px`;
        guideY.style.display = "block";
        break;
      }
    }
    return { x, y };
  }

  function selectLayer(id) {
    selectedLayerId = nodes.has(id) ? id : null;
    applyState();
    emit("editablemediaselection", { layerId: selectedLayerId });
  }

  function setEditMode(enabled) {
    editMode = Boolean(enabled);
    document.documentElement.toggleAttribute("data-editable-mode", editMode);
    updateOverlay();
    return editMode;
  }

  function setEditCapabilities(value) {
    capabilities = clone(value || {});
    updateOverlay();
  }

  resizeHandle.addEventListener("pointerdown", (event) => {
    if (!selectedLayerId || fieldLocked(selectedLayerId, "width")
      || fieldLocked(selectedLayerId, "height")) return;
    const fields = capabilities[selectedLayerId] || [];
    if (!fields.includes("width") || !fields.includes("height")) return;
    const bounds = getBounds()[selectedLayerId];
    drag = {
      type: "resize", id: selectedLayerId, startX: event.clientX, startY: event.clientY,
      width: bounds.width, height: bounds.height,
    };
    resizeHandle.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  });

  rotateHandle.addEventListener("pointerdown", (event) => {
    if (!selectedLayerId || fieldLocked(selectedLayerId, "rotation")) return;
    if (!(capabilities[selectedLayerId] || []).includes("rotation")) return;
    const bounds = getBounds()[selectedLayerId];
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    drag = {
      type: "rotate", id: selectedLayerId, centerX, centerY,
      startAngle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
      rotation: Number(sceneState().layers[selectedLayerId]?.rotation || 0),
    };
    rotateHandle.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!editMode) return;
    const node = document.elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest("[data-editable-id]"))
      .find((candidate) => {
        const id = candidate?.dataset?.editableId;
        return id && (capabilities[id] || []).length > 0;
      });
    if (!node) return;
    const id = node.dataset.editableId;
    selectLayer(id);
    if (fieldLocked(id, "x") || fieldLocked(id, "y")) return;
    const fields = capabilities[id] || [];
    if (!fields.includes("x") || !fields.includes("y")) return;
    const bounds = getBounds()[id];
    drag = {
      type: "move", id, startX: event.clientX, startY: event.clientY,
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    };
    node.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  document.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const current = sceneState();
    const layer = { ...(current.layers[drag.id] || {}) };
    if (drag.type === "move") {
      const snapped = snapMove(
        drag.x + event.clientX - drag.startX,
        drag.y + event.clientY - drag.startY,
        drag.width,
        drag.height
      );
      layer.x = snapped.x;
      layer.y = snapped.y;
    } else if (drag.type === "resize") {
      layer.width = Math.max(8, drag.width + event.clientX - drag.startX);
      layer.height = Math.max(8, drag.height + event.clientY - drag.startY);
    } else if (drag.type === "rotate") {
      const angle = Math.atan2(event.clientY - drag.centerY, event.clientX - drag.centerX);
      layer.rotation = drag.rotation + (angle - drag.startAngle) * 180 / Math.PI;
    }
    current.layers[drag.id] = layer;
    applyLayer(drag.id);
    emit("editablemediapreviewchange", { layerId: drag.id, state: getState() });
  });

  document.addEventListener("pointerup", () => {
    if (!drag) return;
    const layerId = drag.id;
    drag = null;
    guideX.style.display = "none";
    guideY.style.display = "none";
    emit("editablemediachange", { layerId, state: getState() });
  });

  function interactiveTarget(target) {
    return Boolean(target?.closest?.(
      "input, textarea, select, button, a, [contenteditable], [data-editable-interactive]"
    ));
  }

  document.addEventListener("keydown", (event) => {
    if (!manifest?.playback?.controls?.keyboard || editMode
      || interactiveTarget(event.target)) return;
    const actions = {
      ArrowRight: next,
      ArrowDown: next,
      PageDown: next,
      " ": next,
      ArrowLeft: previous,
      ArrowUp: previous,
      PageUp: previous,
      Home: () => setScene(manifest.scenes[0].id),
      End: () => setTime(totalDuration()),
      Escape: () => toggleOverview(),
    };
    const action = actions[event.key];
    if (!action) return;
    action();
    event.preventDefault();
  });

  document.addEventListener("wheel", (event) => {
    if (!manifest?.playback?.controls?.wheel || editMode
      || interactiveTarget(event.target) || Math.abs(event.deltaY) < 30
      || performance.now() < wheelLockedUntil) return;
    wheelLockedUntil = performance.now() + 400;
    if (event.deltaY > 0) next();
    else previous();
    event.preventDefault();
  }, { passive: false });

  document.addEventListener("pointerdown", (event) => {
    if (!manifest?.playback?.controls?.touch || editMode
      || event.pointerType !== "touch" || interactiveTarget(event.target)) return;
    touchStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
  });

  document.addEventListener("pointerup", (event) => {
    if (!touchStart || event.pointerId !== touchStart.id) return;
    const deltaX = event.clientX - touchStart.x;
    const deltaY = event.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(deltaX) < 50 || Math.abs(deltaX) < Math.abs(deltaY)) return;
    if (deltaX < 0) next();
    else previous();
  });

  async function loadManifest() {
    const manifestReference = runtimeScript?.dataset.manifest || "editable-media.json";
    const manifestUrl = new URL(manifestReference, document.baseURI);
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      throw new Error(`Unable to load editable-media manifest: ${response.status} ${manifestUrl}`);
    }
    manifest = await response.json();
    if (manifest.protocol !== "editable-media" || manifest.version !== 5) {
      throw new Error("editable-media manifest must use protocol v5");
    }
    if (typeof manifest.media_sources !== "string" || !manifest.media_sources) {
      throw new Error("editable-media manifest must declare media_sources");
    }
    mediaSourcesUrl = new URL(manifest.media_sources, manifestUrl);
    const mediaResponse = await fetch(mediaSourcesUrl);
    if (!mediaResponse.ok) {
      throw new Error(
        `Unable to load media sources: ${mediaResponse.status} ${mediaSourcesUrl}`
      );
    }
    mediaSourcesManifest = await mediaResponse.json();
    if (
      mediaSourcesManifest.protocol !== "visual-multimedia-media-sources"
      || mediaSourcesManifest.version !== 4
      || !Array.isArray(mediaSourcesManifest.sources)) {
      throw new Error("media_sources must use visual-multimedia media-sources v4");
    }
    mediaSources = new Map(
      mediaSourcesManifest.sources.map((source) => [source.id, source])
    );
    const query = new URLSearchParams(location.search);
    const requestedVariantId = query.get("variant") || manifest.default_variant_id;
    const variant = manifest.variants?.find((item) => item.id === requestedVariantId)
      || manifest.variants?.find((item) => item.id === manifest.default_variant_id);
    const requestedSceneId = query.get("scene") || manifest.scenes?.[0]?.id;
    const requestedScene = manifest.scenes?.find((item) => item.id === requestedSceneId)
      || manifest.scenes?.[0];
    const requestedMode = query.get("mode");
    const themeVariables = Array.isArray(manifest.theme_variables)
      ? manifest.theme_variables
      : [];
    const parameterDefinitions = Array.isArray(manifest.parameters)
      ? manifest.parameters
      : [];
    state = {
      scenes: Object.fromEntries(
        manifest.scenes.map((scene) => [
          scene.id,
          buildSceneState(scene, variant),
        ])
      ),
      theme: Object.fromEntries(themeVariables.map((item) => [item.id, item.default])),
      theme_bindings: Object.fromEntries(
        themeVariables
          .filter((item) => item.css_variable)
          .map((item) => [item.id, item.css_variable])
      ),
      parameters: Object.fromEntries(
        parameterDefinitions
          .filter((item) => item.scope === "global")
          .map((item) => [item.id, clone(item.default)])
      ),
      parameter_bindings: Object.fromEntries(
        parameterDefinitions
          .filter((item) => item.css_variable)
          .map((item) => [item.id, item.css_variable])
      ),
      parameter_locks: [],
      variant: {
        id: variant.id,
        width: variant.canvas.width,
        height: variant.canvas.height,
      },
      scene_id: requestedScene.id,
      playback: {
        mode: ["manual", "autoplay", "hybrid"].includes(requestedMode)
          ? requestedMode
          : manifest.playback.mode,
      },
      revision: 0,
    };
    capabilities = Object.fromEntries(
      (manifest.layers || []).map((layer) => [layer.id, clone(layer.editable || [])])
    );
    applyThemeAndData();
    Object.entries(sceneState().layers).forEach(([id, value]) => {
      const node = nodes.get(id);
      if (node instanceof HTMLImageElement && value.image) {
        node.src = resolveImageSource(value.image);
      }
    });
    const requestedStepId = query.get("step");
    const requestedStep = requestedScene.steps?.find((item) => item.id === requestedStepId);
    currentLocalTimeMs = requestedStep
      ? Number(requestedStep.at_ms || 0)
      : Number(query.get("time") || 0);
    currentGlobalTimeMs = sceneStartTime(requestedScene.id) + currentLocalTimeMs;
  }

  installFrameProtocol();

  const ready = (async () => {
    await loadManifest();
    registerHyperFramesTimeline();
    installFrameProtocol();
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((image) => image.decode()));
    refreshNodes();
    captureDefaults();
    setTime(currentGlobalTimeMs);
    if (state.playback.mode === "autoplay"
      && new URLSearchParams(location.search).get("capture") !== "1") {
      play();
    }
    return true;
  })();

  window.editableMedia = Object.freeze({
    ready,
    getManifest: () => clone(manifest),
    getMediaSources: () => clone(mediaSourcesManifest),
    getMediaSourceUrl: (sourceId) => resolveMediaSource(sourceId),
    getState,
    setState,
    setVariant,
    setScene,
    setTime,
    getPlayback,
    getCamera: () => clone(currentCameraState()),
    getParameters: () => clone(effectiveParameters()),
    setPlaybackMode,
    play,
    pause,
    next,
    previous,
    toggleOverview,
    getBounds,
    setEditMode,
    setEditCapabilities,
    selectLayer,
  });
})();
