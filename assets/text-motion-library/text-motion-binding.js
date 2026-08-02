(function installTextMotionBinding(global) {
  "use strict";

  async function fetchText(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`无法读取 ${url}：HTTP ${response.status}`);
    return response.text();
  }

  async function sha256(value) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }

  async function ensureRuntime(runtimePath) {
    if (global.TextMotion) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = runtimePath;
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error(`无法加载文字动效运行时 ${runtimePath}`)),
        { once: true }
      );
      document.head.append(script);
    });
    if (!global.TextMotion) throw new Error("文字动效运行时加载后没有暴露 TextMotion");
  }

  function sceneData(api) {
    const state = api.getState();
    return state.scenes?.[state.scene_id]?.data || {};
  }

  async function attach(options = {}) {
    const api = options.editableMedia || global.editableMedia;
    if (!api) throw new Error("文字动效绑定需要 window.editableMedia");
    await api.ready;
    const host = typeof options.host === "string"
      ? document.querySelector(options.host)
      : options.host;
    if (!(host instanceof Element)) throw new Error("文字动效绑定找不到 host");
    const selectionUrl = options.selectionUrl || "text-motion/selection.json";
    const selection = JSON.parse(await fetchText(selectionUrl));
    if (
      selection.protocol !== "visual-multimedia-text-motion-selection"
      || selection.version !== 1
      || selection.time_source !== "editable-media"
    ) {
      throw new Error("文字动效 selection 不是受支持的 editable-media 绑定");
    }
    await ensureRuntime(selection.runtime_path);
    const effectText = await fetchText(selection.effect_path);
    const actualHash = await sha256(effectText);
    if (actualHash !== selection.effect_sha256) {
      throw new Error(`文字动效 ${selection.effect_id} 与 selection 哈希不一致`);
    }
    const effect = JSON.parse(effectText);
    if (effect.id !== selection.effect_id) {
      throw new Error("文字动效 selection 的 effect_id 与效果文件不一致");
    }
    const textField = options.textField || "preview_text";
    const previousTextField = options.previousTextField || "previous_text";
    const data = sceneData(api);
    const player = global.TextMotion.createPlayer(host, effect, {
      text: data[textField] ?? options.text ?? "",
      previousText: data[previousTextField] ?? options.previousText ?? "",
      locale: options.locale || document.documentElement.lang || "zh-CN",
      reducedMotion: Boolean(options.reducedMotion),
    });
    const render = (playback = api.getPlayback()) => player.renderAt(
      playback.localTimeMs,
      selection.operation,
      {
        previewLoop: Boolean(options.previewLoop),
        reducedMotion: Boolean(options.reducedMotion),
      }
    );
    const handleTime = (event) => render(event.detail);
    const handleData = () => {
      const current = sceneData(api);
      player.setText(
        current[textField] ?? options.text ?? "",
        current[previousTextField] ?? options.previousText ?? ""
      );
      render();
    };
    global.addEventListener("editablemediatime", handleTime);
    global.addEventListener("editablemediadata", handleData);
    render();
    return Object.freeze({
      selection,
      effect,
      player,
      render,
      destroy() {
        global.removeEventListener("editablemediatime", handleTime);
        global.removeEventListener("editablemediadata", handleData);
        player.destroy();
      },
    });
  }

  global.TextMotionBinding = Object.freeze({ version: 1, attach });
})(window);
