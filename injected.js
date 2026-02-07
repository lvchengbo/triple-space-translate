(() => {
  if (window.__tripleSpaceTranslateInstalled) {
    return;
  }
  window.__tripleSpaceTranslateInstalled = true;

  const SOURCE = 'triple-space-translate';
  const DEFAULT_MODEL = '';
  const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/generate';
  const MAX_INTERVAL_MS = 200;
  const MIN_LOADING_MS = 1200;
  const SHIMMER_SWEEP_SECONDS = 1.45;

  const DEBUG = localStorage.getItem('tstDebug') === '1';
  const debug = (...args) => {
    if (DEBUG) console.info('[Triple Space Translate]', ...args);
  };

  let spaceCount = 0;
  let lastSpaceAt = 0;
  let inFlight = false;
  let activeEditor = null;
  const editorByNode = new WeakMap();
  let loadingEditorRoot = null;
  let loadingStartedAt = 0;
  let loadingSettleTimer = null;
  let loadingTargetLines = [];
  let loadingTargetSpans = [];
  let pendingTranslationTarget = null;

  function clearLoadingSettleTimer() {
    if (!loadingSettleTimer) return;
    clearTimeout(loadingSettleTimer);
    loadingSettleTimer = null;
  }

  function parseCssColor(value) {
    const parts = String(value || '').match(/[\d.]+/g);
    if (!parts || parts.length < 3) return null;
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    const a = parts.length >= 4 ? Number(parts[3]) : 1;
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return {
      r: Math.max(0, Math.min(255, Math.round(r))),
      g: Math.max(0, Math.min(255, Math.round(g))),
      b: Math.max(0, Math.min(255, Math.round(b))),
      a: Math.max(0, Math.min(1, a)),
    };
  }

  function toRgbString(color) {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  function toRgbaString(color, alpha) {
    const safeAlpha = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${safeAlpha})`;
  }

  function mixRgb(from, to, weight) {
    const ratio = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0.5;
    return {
      r: Math.round(from.r + (to.r - from.r) * ratio),
      g: Math.round(from.g + (to.g - from.g) * ratio),
      b: Math.round(from.b + (to.b - from.b) * ratio),
      a: 1,
    };
  }

  function resolveSpanBaseColor(span) {
    const candidates = [
      span,
      span?.parentElement,
      span?.closest?.('.view-line'),
      document.body,
      document.documentElement,
    ].filter(Boolean);

    for (const node of candidates) {
      const parsed = parseCssColor(getComputedStyle(node).color);
      if (parsed && parsed.a > 0.05) {
        return { r: parsed.r, g: parsed.g, b: parsed.b, a: 1 };
      }
    }

    return { r: 190, g: 200, b: 218, a: 1 };
  }

  function resolveSpanShimmerPalette(span) {
    const base = resolveSpanBaseColor(span);
    const highlight = mixRgb(base, { r: 255, g: 255, b: 255, a: 1 }, 0.62);
    const mid = mixRgb(base, highlight, 0.45);
    return {
      base,
      mid,
      highlight,
      glowStrong: toRgbaString(highlight, 0.45),
      glowSoft: toRgbaString(highlight, 0.2),
    };
  }

  function collectLineShimmerSpans(line) {
    const lineRect = line.getBoundingClientRect();
    const entries = [...line.querySelectorAll('span')].map((span) => {
      const text = span.textContent || '';
      const rect = span.getBoundingClientRect();
      return { span, text, rect };
    }).filter((entry) => {
      return entry.text.trim() && entry.rect.width > 0 && entry.rect.height > 0;
    });
    if (!entries.length) return [];

    let left = Infinity;
    let right = -Infinity;
    for (const entry of entries) {
      left = Math.min(left, entry.rect.left - lineRect.left);
      right = Math.max(right, entry.rect.right - lineRect.left);
    }
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return [];
    const lineWidth = Math.max(1, right - left);

    return entries.map((entry) => {
      const spanLeft = entry.rect.left - lineRect.left;
      const phaseSeconds = (Math.max(0, spanLeft - left) / lineWidth) * SHIMMER_SWEEP_SECONDS;
      return {
        span: entry.span,
        phaseSeconds,
      };
    });
  }

  function showLoadingIndicator(editorRoot) {
    hideLoadingIndicator();
    const anchor = editorRoot || document.querySelector('.monaco-editor');
    if (!anchor) return;
    const lines = [...anchor.querySelectorAll('.view-lines .view-line')];
    let targetLines = lines.filter((line) => hanRegex.test(line.textContent || ''));
    if (!targetLines.length) {
      targetLines = lines.filter((line) => (line.textContent || '').trim());
    }
    if (!targetLines.length) return;

    loadingTargetLines = [];
    loadingTargetSpans = [];
    targetLines.forEach((line, index) => {
      const shimmerSpans = collectLineShimmerSpans(line);
      if (!shimmerSpans.length) return;
      line.classList.add('tst-translating-line');
      loadingTargetLines.push(line);
      shimmerSpans.forEach(({ span, phaseSeconds }) => {
        const palette = resolveSpanShimmerPalette(span);
        span.classList.add('tst-translating-target');
        span.style.setProperty('--tst-base-color', toRgbString(palette.base));
        span.style.setProperty('--tst-mid-color', toRgbString(palette.mid));
        span.style.setProperty('--tst-highlight-color', toRgbString(palette.highlight));
        span.style.setProperty('--tst-glow-strong-color', palette.glowStrong);
        span.style.setProperty('--tst-glow-soft-color', palette.glowSoft);
        span.style.setProperty('--tst-shimmer-delay', `${index * -0.05}s`);
        span.style.setProperty('--tst-sweep-phase', `${phaseSeconds}s`);
        loadingTargetSpans.push(span);
      });
    });
    if (!loadingTargetSpans.length) return;

    loadingEditorRoot = anchor;
    loadingStartedAt = performance.now();
  }

  function hideLoadingIndicator() {
    loadingTargetSpans.forEach((span) => {
      span.classList.remove('tst-translating-target');
      span.style.removeProperty('--tst-base-color');
      span.style.removeProperty('--tst-mid-color');
      span.style.removeProperty('--tst-highlight-color');
      span.style.removeProperty('--tst-glow-strong-color');
      span.style.removeProperty('--tst-glow-soft-color');
      span.style.removeProperty('--tst-shimmer-delay');
      span.style.removeProperty('--tst-sweep-phase');
    });
    loadingTargetLines.forEach((line) => line.classList.remove('tst-translating-line'));
    loadingTargetSpans = [];
    loadingTargetLines = [];
    loadingEditorRoot = null;
    loadingStartedAt = 0;
  }

  function applyTranslationResult(data) {
    inFlight = false;
    hideLoadingIndicator();
    const targetFromRequest = pendingTranslationTarget;
    pendingTranslationTarget = null;

    if (!data.ok || !data.text) return;

    if (applyTranslationToTarget(targetFromRequest, data.text)) return;

    const fallbackTarget = resolveTarget();
    if (applyTranslationToTarget(fallbackTarget, data.text)) return;

    console.warn('[Triple Space Translate] failed to apply translation: no valid target');
  }

  (function injectLoadingStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .tst-translating-line {
        position: relative;
      }
      .tst-translating-target {
        --tst-base-color: currentColor;
        --tst-mid-color: currentColor;
        --tst-highlight-color: currentColor;
        --tst-glow-strong-color: rgba(255, 255, 255, 0.45);
        --tst-glow-soft-color: rgba(255, 255, 255, 0.2);
        color: var(--tst-base-color) !important;
        text-shadow: 0 0 0 transparent;
        will-change: color, filter, text-shadow;
        animation: tst-text-sweep ${SHIMMER_SWEEP_SECONDS}s linear infinite;
        animation-delay: calc(var(--tst-shimmer-delay, 0s) - var(--tst-sweep-phase, 0s));
      }
      @keyframes tst-text-sweep {
        0%,
        34%,
        100% {
          color: var(--tst-base-color);
          filter: brightness(1) saturate(1);
          text-shadow: 0 0 0 transparent;
        }
        47% {
          color: var(--tst-highlight-color);
          filter: brightness(1.26) saturate(1.08);
          text-shadow:
            0 0 0.025em var(--tst-highlight-color),
            0 0 0.5em var(--tst-glow-strong-color);
        }
        58% {
          color: var(--tst-mid-color);
          filter: brightness(1.12) saturate(1.03);
          text-shadow:
            0 0 0.018em var(--tst-mid-color),
            0 0 0.24em var(--tst-glow-soft-color);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .tst-translating-target {
          animation: none;
          color: var(--tst-base-color);
          filter: none;
          text-shadow: none;
        }
      }
    `;
    document.head.appendChild(style);
  })();

  const hanRegex = (() => {
    try {
      return /\p{Script=Han}/u;
    } catch {
      return /[\u4E00-\u9FFF]/;
    }
  })();

  console.info('[Triple Space Translate] injected ready', location.href);

  installMonacoHooks();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data || {};
    if (data.source !== SOURCE || data.type !== 'translation') return;

    clearLoadingSettleTimer();
    const elapsed = loadingStartedAt ? performance.now() - loadingStartedAt : MIN_LOADING_MS;
    const waitMs = Math.max(0, MIN_LOADING_MS - elapsed);
    if (!waitMs) {
      applyTranslationResult(data);
      return;
    }

    loadingSettleTimer = setTimeout(() => {
      loadingSettleTimer = null;
      applyTranslationResult(data);
    }, waitMs);
  });

  function triggerTranslation(editorRoot) {
    if (inFlight) {
      debug('skip: translation already in flight');
      return;
    }
    clearLoadingSettleTimer();
    const target = resolveTarget(editorRoot);
    if (!target) {
      debug('skip: cannot resolve translation target');
      return;
    }
    const modelText = target?.model?.getValue() || '';
    const domText = editorRoot ? extractTextFromDom(editorRoot) : '';
    const text = pickBestText(modelText, domText).trimEnd();
    if (!text || !hasEnoughChinese(text)) {
      debug('skip: no translatable text');
      return;
    }
    inFlight = true;
    pendingTranslationTarget = target;
    showLoadingIndicator(editorRoot);
    debug('translate request', { length: text.length });
    window.postMessage(
      { source: SOURCE, type: 'translate', text, model: DEFAULT_MODEL, endpoint: DEFAULT_ENDPOINT },
      location.origin
    );
  }

  const handleKey = (event) => {
    if (event.isComposing || event.key === 'Process') { resetCounter(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) { resetCounter(); return; }

    const keyCode = typeof event.keyCode === 'number' ? event.keyCode : null;
    if (event.key !== ' ' && event.code !== 'Space' && event.key !== 'Spacebar' && keyCode !== 32) {
      resetCounter();
      return;
    }

    const now = Date.now();
    if (now - lastSpaceAt > MAX_INTERVAL_MS) spaceCount = 0;

    spaceCount += 1;
    lastSpaceAt = now;
    debug('space', { count: spaceCount, target: event.target });

    if (spaceCount < 3) return;

    const editorRoot = findMonacoRoot(event);
    if (!editorRoot) { resetCounter(); return; }

    event.preventDefault();
    event.stopPropagation();
    triggerTranslation(editorRoot);
  };

  document.addEventListener('keydown', handleKey, true);

  function resetCounter() { spaceCount = 0; lastSpaceAt = 0; }

  window.__tstTranslateNow = () => {
    triggerTranslation(findMonacoRoot({ target: document.activeElement }) || findFallbackRoot());
  };

  function findMonacoRoot(event) {
    let containerCandidate = null;
    if (typeof event?.composedPath === 'function') {
      for (const node of event.composedPath()) {
        if (node instanceof Element) {
          if (node.classList.contains('monaco-editor')) return node;
          if (!containerCandidate && node.classList.contains('monaco-editor-container')) {
            containerCandidate = node;
          }
        }
      }
    }

    if (event?.target instanceof Element) {
      const targetRoot = event.target.closest('.monaco-editor');
      if (targetRoot) return targetRoot;
      if (!containerCandidate) containerCandidate = event.target.closest('.monaco-editor-container');
    }

    if (document.activeElement instanceof Element) {
      const activeRoot = document.activeElement.closest('.monaco-editor');
      if (activeRoot) return activeRoot;
      if (!containerCandidate) containerCandidate = document.activeElement.closest('.monaco-editor-container');
    }

    if (containerCandidate?.querySelector) {
      const nestedRoot = containerCandidate.querySelector('.monaco-editor');
      if (nestedRoot) return nestedRoot;
    }

    return containerCandidate;
  }

  function installMonacoHooks() {
    if (window.monaco?.editor) { hookMonaco(window.monaco); return; }

    try {
      Object.defineProperty(window, 'monaco', {
        configurable: true,
        enumerable: true,
        set(value) {
          Object.defineProperty(window, 'monaco', {
            configurable: true, enumerable: true, writable: true, value,
          });
          if (value?.editor) hookMonaco(value);
        },
        get() { return undefined; },
      });
    } catch {
      // ignore
    }
  }

  function hookMonaco(monaco) {
    if (!monaco?.editor || monaco.editor.__tripleSpacePatched) return;
    monaco.editor.__tripleSpacePatched = true;

    const originalCreate = monaco.editor.create.bind(monaco.editor);
    monaco.editor.create = function (...args) {
      const editor = originalCreate(...args);
      registerEditor(editor);
      return editor;
    };

    if (typeof monaco.editor.createDiffEditor === 'function') {
      const originalDiff = monaco.editor.createDiffEditor.bind(monaco.editor);
      monaco.editor.createDiffEditor = function (...args) {
        const editor = originalDiff(...args);
        registerEditor(editor);
        return editor;
      };
    }

    console.info('[Triple Space Translate] monaco hook installed');
  }

  function registerEditor(editor) {
    if (!editor || typeof editor.getModel !== 'function') return;
    const domNode = editor.getDomNode?.();
    const entry = { editor, model: editor.getModel() };
    if (domNode) editorByNode.set(domNode, entry);

    editor.onDidChangeModel?.(() => { entry.model = editor.getModel(); });
    editor.onDidFocusEditorText?.(() => { activeEditor = editor; });
  }

  function resolveTarget(editorRoot) {
    if (editorRoot) {
      const normalizedRoot = editorRoot.classList?.contains('monaco-editor')
        ? editorRoot
        : editorRoot.querySelector?.('.monaco-editor') || editorRoot;
      const entry = editorByNode.get(normalizedRoot);
      if (entry) return { editor: entry.editor, model: entry.model };
      const modelFromRoot = pickActiveModel(normalizedRoot);
      if (modelFromRoot) return { editor: null, model: modelFromRoot };
    }

    if (activeEditor?.getModel) return { editor: activeEditor, model: activeEditor.getModel() };

    const model = pickActiveModel(editorRoot);
    return model ? { editor: null, model } : null;
  }

  function tryReplaceEditorValue(editor, text) {
    try {
      const model = editor.getModel();
      if (!model) return;
      editor.pushUndoStop();
      editor.executeEdits('triple-space-translate', [
        { range: model.getFullModelRange(), text },
      ]);
      editor.pushUndoStop();
    } catch {
      editor.getModel()?.setValue(text);
    }
  }

  function applyTranslationToTarget(target, text) {
    if (!target || !text) return false;
    if (target.editor && typeof target.editor.getModel === 'function') {
      try {
        tryReplaceEditorValue(target.editor, text);
        return true;
      } catch {
        // continue to model fallback
      }
    }
    if (target.model && typeof target.model.setValue === 'function') {
      try {
        target.model.setValue(text);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  const hasEnoughChinese = (text) => text && hanRegex.test(text);

  function extractTextFromDom(root) {
    if (!root) return '';
    return [...root.querySelectorAll('.view-lines .view-line')]
      .map(l => (l.textContent || '').replace(/\u00a0/g, ' ')).join('\n');
  }

  const pickBestText = (m, d) => (m?.trim() ? m : d?.trim() ? d : m || d || '');

  function findFallbackRoot() {
    const c = document.querySelectorAll('.monaco-editor, .monaco-editor-container');
    return c.length ? c[c.length - 1] : null;
  }

  function pickActiveModel(editorRoot) {
    const models = window.monaco?.editor?.getModels?.();
    if (!models?.length) return null;

    if (editorRoot) {
      const uri = editorRoot.getAttribute('data-uri');
      if (uri) {
        const match = models.find(m => m.uri?.toString() === uri);
        if (match) return match;
      }
    }

    return models[models.length - 1];
  }
})();
