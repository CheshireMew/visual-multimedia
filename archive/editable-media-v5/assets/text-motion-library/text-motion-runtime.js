(function installTextMotion(global) {
  "use strict";

  const VALUE_DEFAULTS = Object.freeze({
    opacity: 1,
    x_px: 0,
    y_px: 0,
    scale: 1,
    rotate_deg: 0,
    skew_x_deg: 0,
    blur_px: 0,
    brightness: 1,
    clip_top_pct: 0,
    letter_spacing_em: 0,
    shimmer_pct: null,
  });

  const clamp = (value, minimum = 0, maximum = 1) =>
    Math.min(maximum, Math.max(minimum, Number(value) || 0));

  function graphemeSegments(text, locale) {
    const value = String(text ?? "");
    if (typeof Intl.Segmenter === "function") {
      return Array.from(
        new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(value),
        (entry) => entry.segment
      );
    }
    return Array.from(value);
  }

  function wordSegments(text, locale) {
    const value = String(text ?? "");
    if (typeof Intl.Segmenter !== "function") {
      return value.split(/(\s+)/u).filter((part) => part.length > 0)
        .map((part) => ({ text: part, animated: /\S/u.test(part) }));
    }
    const output = [];
    for (const entry of new Intl.Segmenter(locale, { granularity: "word" }).segment(value)) {
      const part = entry.segment;
      if (/^\s+$/u.test(part)) {
        output.push({ text: part, animated: false });
      } else if (entry.isWordLike) {
        output.push({ text: part, animated: true });
      } else if (output.length > 0 && output[output.length - 1].animated) {
        output[output.length - 1].text += part;
      } else {
        output.push({ text: part, animated: true });
      }
    }
    return output;
  }

  function segmentText(text, unit, locale) {
    if (unit === "whole") {
      return [{ text: String(text ?? ""), animated: true }];
    }
    if (unit === "word") return wordSegments(text, locale);
    return graphemeSegments(text, locale).map((part) => ({
      text: part,
      animated: !/^\s+$/u.test(part),
      break: part === "\n",
    }));
  }

  function ease(name, value) {
    const t = clamp(value);
    if (name === "linear") return t;
    if (name === "ease-in") return t * t * t;
    if (name === "ease-in-out") {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    if (name === "back-out") {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    if (name === "spring-out") {
      if (t === 0 || t === 1) return t;
      return Math.pow(2, -8 * t) * Math.sin((t * 8 - 0.75) * Math.PI) + 1;
    }
    if (name === "step-end") return t >= 1 ? 1 : 0;
    return 1 - Math.pow(1 - t, 3);
  }

  function normalizedFrame(frame) {
    return {
      offset: Number(frame.offset),
      values: { ...VALUE_DEFAULTS, ...(frame.values || {}) },
    };
  }

  function sampleTrack(track, progress, easing) {
    const frames = track.map(normalizedFrame);
    const raw = clamp(progress);
    if (raw <= frames[0].offset) return { ...frames[0].values };
    if (raw >= frames[frames.length - 1].offset) {
      return { ...frames[frames.length - 1].values };
    }
    let left = frames[0];
    let right = frames[frames.length - 1];
    for (let index = 1; index < frames.length; index += 1) {
      if (raw <= frames[index].offset) {
        left = frames[index - 1];
        right = frames[index];
        break;
      }
    }
    const span = Math.max(1e-9, right.offset - left.offset);
    const local = ease(easing, (raw - left.offset) / span);
    const values = {};
    for (const key of Object.keys(VALUE_DEFAULTS)) {
      const start = left.values[key];
      const end = right.values[key];
      if (start == null || end == null) {
        values[key] = local < 0.5 ? start : end;
      } else {
        values[key] = start + (end - start) * local;
      }
    }
    values.opacity = clamp(values.opacity);
    values.scale = Math.max(0.001, Number(values.scale) || 1);
    values.blur_px = Math.max(0, Number(values.blur_px) || 0);
    values.brightness = Math.max(0, Number(values.brightness) || 1);
    values.clip_top_pct = clamp(values.clip_top_pct, 0, 100);
    return values;
  }

  function orderRank(index, count, mode) {
    if (count <= 1) return 0;
    if (mode === "reverse") return count - 1 - index;
    if (mode === "center-out") {
      const center = (count - 1) / 2;
      const minimum = Number.isInteger(center) ? 0 : 0.5;
      return Math.abs(index - center) - minimum;
    }
    if (mode === "edges-in") return Math.min(index, count - 1 - index);
    return index;
  }

  function maximumRank(count, mode) {
    let maximum = 0;
    for (let index = 0; index < count; index += 1) {
      maximum = Math.max(maximum, orderRank(index, count, mode));
    }
    return maximum;
  }

  function variedValues(values, variation, index, count) {
    const output = { ...values };
    if (variation === "alternating") {
      const direction = index % 2 === 0 ? -1 : 1;
      output.x_px *= direction;
      output.rotate_deg *= direction;
      output.skew_x_deg *= direction;
    }
    if (variation === "depth") {
      const center = (count - 1) / 2;
      const denominator = Math.max(1, center);
      const signed = (index - center) / denominator;
      const amplitude = 0.7 + Math.abs(signed) * 0.6;
      output.x_px *= signed;
      output.y_px *= amplitude;
      output.blur_px *= amplitude;
      output.scale = 1 + (output.scale - 1) * amplitude;
    }
    return output;
  }

  function applyValues(element, values, baseColor) {
    element.style.opacity = String(clamp(values.opacity));
    element.style.transform = [
      `translate3d(${Number(values.x_px).toFixed(4)}px, ${Number(values.y_px).toFixed(4)}px, 0)`,
      `scale(${Number(values.scale).toFixed(6)})`,
      `rotate(${Number(values.rotate_deg).toFixed(4)}deg)`,
      `skewX(${Number(values.skew_x_deg).toFixed(4)}deg)`,
    ].join(" ");
    element.style.filter =
      `blur(${Number(values.blur_px).toFixed(4)}px) brightness(${Number(values.brightness).toFixed(6)})`;
    element.style.clipPath =
      `inset(${Number(values.clip_top_pct).toFixed(4)}% 0 0 0)`;
    element.style.letterSpacing =
      `${Number(values.letter_spacing_em).toFixed(6)}em`;
    if (Number.isFinite(values.shimmer_pct)) {
      element.style.setProperty("--tm-base-color", baseColor);
      element.style.backgroundImage =
        "linear-gradient(110deg, var(--tm-base-color) 18%, #ffffff 48%, var(--tm-base-color) 78%)";
      element.style.backgroundSize = "220% 100%";
      element.style.backgroundPosition =
        `${Number(values.shimmer_pct).toFixed(4)}% 50%`;
      element.style.backgroundClip = "text";
      element.style.webkitBackgroundClip = "text";
      element.style.color = "transparent";
    } else {
      element.style.removeProperty("--tm-base-color");
      element.style.removeProperty("background-image");
      element.style.removeProperty("background-size");
      element.style.removeProperty("background-position");
      element.style.removeProperty("background-clip");
      element.style.removeProperty("-webkit-background-clip");
      element.style.removeProperty("color");
    }
  }

  function makeLayer(text, segmentation, locale, role) {
    const node = document.createElement("span");
    node.className = "tm-layer";
    node.dataset.motionRole = role;
    Object.assign(node.style, {
      display: "block",
      gridArea: "1 / 1",
      width: "100%",
      whiteSpace: "pre-wrap",
      textAlign: "inherit",
      transformOrigin: "inherit",
    });
    const pieces = segmentText(
      text,
      segmentation.unit === "line" ? "grapheme" : segmentation.unit,
      locale
    );
    const candidates = [];
    for (const piece of pieces) {
      if (piece.break) {
        const br = document.createElement("br");
        br.dataset.motionBreak = "true";
        node.append(br);
        continue;
      }
      const unit = document.createElement("span");
      unit.textContent = piece.text;
      unit.className = "tm-unit";
      unit.dataset.motionAnimated = piece.animated ? "true" : "false";
      Object.assign(unit.style, {
        display: "inline-block",
        whiteSpace: "pre",
        willChange: "transform, opacity, filter, clip-path",
      });
      node.append(unit);
      if (piece.animated) candidates.push(unit);
    }
    return { node, candidates, units: [], unitCount: 0 };
  }

  function measureLayer(layer, segmentation) {
    if (segmentation.unit !== "line") {
      layer.units = layer.candidates.map((element, index) => ({
        element,
        index,
      }));
      layer.unitCount = Math.max(1, layer.units.length);
      return;
    }
    const tops = [];
    for (const element of layer.candidates) {
      const top = Math.round(element.offsetTop * 2) / 2;
      if (!tops.some((candidate) => Math.abs(candidate - top) <= 0.5)) tops.push(top);
    }
    tops.sort((left, right) => left - right);
    layer.units = layer.candidates.map((element) => {
      const top = Math.round(element.offsetTop * 2) / 2;
      let line = 0;
      let distance = Number.POSITIVE_INFINITY;
      tops.forEach((candidate, index) => {
        const nextDistance = Math.abs(candidate - top);
        if (nextDistance < distance) {
          distance = nextDistance;
          line = index;
        }
      });
      element.dataset.motionLine = String(line);
      return { element, index: line };
    });
    layer.unitCount = Math.max(1, tops.length);
  }

  function phaseDuration(effect, operation, unitCount) {
    const timing = effect.timing[operation];
    if (!timing) return 0;
    return timing.duration_ms
      + timing.stagger_ms * maximumRank(unitCount, effect.segmentation.order);
  }

  function operationDuration(effect, operation, counts = {}) {
    const primary = Math.max(1, Number(counts.primary) || 1);
    if (operation === "replace") {
      const outgoing = Math.max(1, Number(counts.outgoing) || primary);
      const incoming = Math.max(1, Number(counts.incoming) || primary);
      const exitDuration = phaseDuration(effect, "exit", outgoing);
      const enterDuration = phaseDuration(effect, "enter", incoming);
      const replace = effect.timing.replace;
      const incomingStart = replace.mode === "crossfade"
        ? Math.max(0, exitDuration - replace.overlap_ms + replace.micro_delay_ms)
        : exitDuration + replace.micro_delay_ms;
      return Math.max(exitDuration, incomingStart + enterDuration);
    }
    return phaseDuration(effect, operation, primary);
  }

  function createPlayer(host, effect, options = {}) {
    if (!(host instanceof Element)) throw new TypeError("text-motion host 必须是 DOM Element");
    let currentEffect = effect;
    let text = String(options.text ?? "");
    let previousText = String(options.previousText ?? text);
    let locale = options.locale || document.documentElement.lang || "zh-CN";
    let reducedMotion = Boolean(options.reducedMotion);
    let layers = {};
    const stack = document.createElement("span");
    stack.className = "tm-stack";
    Object.assign(stack.style, {
      display: "grid",
      placeItems: "center",
      width: "100%",
      height: "100%",
      overflow: currentEffect.host.overflow,
      textAlign: "inherit",
      transformOrigin: currentEffect.renderer.transform_origin,
    });
    host.dataset.textMotionHost = currentEffect.host.sizing;
    host.replaceChildren(stack);

    function rebuild() {
      stack.replaceChildren();
      stack.style.transformOrigin = currentEffect.renderer.transform_origin;
      stack.style.overflow = currentEffect.host.overflow;
      host.dataset.textMotionHost = currentEffect.host.sizing;
      layers = {
        primary: makeLayer(text, currentEffect.segmentation, locale, "primary"),
        outgoing: makeLayer(previousText, currentEffect.segmentation, locale, "outgoing"),
        incoming: makeLayer(text, currentEffect.segmentation, locale, "incoming"),
      };
      for (const layer of Object.values(layers)) stack.append(layer.node);
      for (const layer of Object.values(layers)) measureLayer(layer, currentEffect.segmentation);
    }

    function counts() {
      return {
        primary: layers.primary.unitCount,
        outgoing: layers.outgoing.unitCount,
        incoming: layers.incoming.unitCount,
      };
    }

    function renderLayer(layer, track, timing, elapsed) {
      const baseColor = getComputedStyle(host).color || "rgb(255, 255, 255)";
      layer.node.style.visibility = "visible";
      const count = Math.max(1, layer.unitCount);
      for (const unit of layer.units) {
        const rank = orderRank(unit.index, count, currentEffect.segmentation.order);
        const progress = (elapsed - rank * timing.stagger_ms) / timing.duration_ms;
        const sampled = sampleTrack(track, progress, timing.easing);
        const varied = variedValues(
          sampled,
          currentEffect.renderer.unit_variation,
          unit.index,
          count
        );
        applyValues(unit.element, varied, baseColor);
      }
    }

    function renderReduced(timeMs, operation) {
      const duration = Math.max(1, currentEffect.constraints.reduced_motion.duration_ms);
      const progress = clamp(timeMs / duration);
      const show = (layer, opacity) => {
        layer.node.style.visibility = "visible";
        const baseColor = getComputedStyle(host).color || "rgb(255, 255, 255)";
        for (const unit of layer.units) {
          applyValues(unit.element, { ...VALUE_DEFAULTS, opacity }, baseColor);
        }
      };
      if (currentEffect.constraints.reduced_motion.strategy === "none"
        || operation === "emphasis") {
        show(layers.primary, 1);
        return;
      }
      if (operation === "exit") {
        show(layers.primary, 1 - progress);
      } else if (operation === "replace") {
        show(layers.outgoing, 1 - progress);
        show(layers.incoming, progress);
      } else {
        show(layers.primary, progress);
      }
    }

    function renderAt(milliseconds, operation = currentEffect.intent.default_operation, renderOptions = {}) {
      if (!currentEffect.intent.operations.includes(operation)) {
        throw new Error(`效果 ${currentEffect.id} 不支持操作 ${operation}`);
      }
      const duration = operationDuration(currentEffect, operation, counts());
      let timeMs = Math.max(0, Number(milliseconds) || 0);
      if (renderOptions.previewLoop) {
        if (operation === "emphasis") {
          timeMs = duration > 0 ? timeMs % duration : 0;
        } else {
          const cycle = duration + currentEffect.timing.hold_ms + 300;
          const within = cycle > 0 ? timeMs % cycle : 0;
          timeMs = within <= duration + currentEffect.timing.hold_ms
            ? Math.min(within, duration)
            : 0;
        }
      } else {
        timeMs = Math.min(timeMs, duration);
      }
      for (const layer of Object.values(layers)) layer.node.style.visibility = "hidden";
      if (reducedMotion || renderOptions.reducedMotion) {
        renderReduced(timeMs, operation);
        return timeMs;
      }
      if (operation === "replace") {
        const exitDuration = phaseDuration(
          currentEffect,
          "exit",
          layers.outgoing.unitCount
        );
        const replace = currentEffect.timing.replace;
        const incomingStart = replace.mode === "crossfade"
          ? Math.max(0, exitDuration - replace.overlap_ms + replace.micro_delay_ms)
          : exitDuration + replace.micro_delay_ms;
        renderLayer(
          layers.outgoing,
          currentEffect.renderer.tracks.exit,
          currentEffect.timing.exit,
          timeMs
        );
        renderLayer(
          layers.incoming,
          currentEffect.renderer.tracks.enter,
          currentEffect.timing.enter,
          timeMs - incomingStart
        );
      } else {
        const track = currentEffect.renderer.tracks[operation];
        const timing = currentEffect.timing[operation];
        const elapsed = operation === "emphasis" && duration > 0
          ? timeMs % duration
          : timeMs;
        renderLayer(layers.primary, track, timing, elapsed);
      }
      return timeMs;
    }

    function snapshot() {
      return Object.fromEntries(Object.entries(layers).map(([name, layer]) => [
        name,
        {
          visible: layer.node.style.visibility !== "hidden",
          unitCount: layer.unitCount,
          units: layer.units.map(({ element, index }) => ({
            index,
            text: element.textContent,
            opacity: element.style.opacity,
            transform: element.style.transform,
            filter: element.style.filter,
            clipPath: element.style.clipPath,
            backgroundPosition: element.style.backgroundPosition,
          })),
        },
      ]));
    }

    rebuild();
    return Object.freeze({
      renderAt,
      snapshot,
      getDuration: (operation = currentEffect.intent.default_operation) =>
        operationDuration(currentEffect, operation, counts()),
      getUnitCounts: () => ({ ...counts() }),
      setText(nextText, nextPreviousText = previousText) {
        text = String(nextText ?? "");
        previousText = String(nextPreviousText ?? "");
        rebuild();
      },
      setEffect(nextEffect) {
        currentEffect = nextEffect;
        rebuild();
      },
      setReducedMotion(value) {
        reducedMotion = Boolean(value);
      },
      destroy() {
        host.replaceChildren();
      },
    });
  }

  global.TextMotion = Object.freeze({
    version: 1,
    createPlayer,
    operationDuration,
    segmentText,
    sampleTrack,
  });
})(window);
