(() => {
  if (window.__tripleSpaceTranslateInstalled) {
    return;
  }
  window.__tripleSpaceTranslateInstalled = true;

  const SOURCE = 'triple-space-translate';
  const DEFAULT_MODEL = '';
  const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/generate';
  const MAX_INTERVAL_MS = 200;
  const MIN_LOADING_MS = 700;

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

  function clearLoadingSettleTimer() {
    if (!loadingSettleTimer) return;
    clearTimeout(loadingSettleTimer);
    loadingSettleTimer = null;
  }

  function showLoadingIndicator(editorRoot) {
    hideLoadingIndicator();
    const anchor = editorRoot || document.querySelector('.monaco-editor');
    if (!anchor) return;
    const lines = [...anchor.querySelectorAll('.view-lines .view-line')];
    loadingTargetLines = lines.filter((line) => hanRegex.test(line.textContent || ''));
    if (!loadingTargetLines.length) {
      loadingTargetLines = lines.filter((line) => (line.textContent || '').trim());
    }
    const spans = loadingTargetLines.flatMap((line) => [...line.querySelectorAll('span')]);
    loadingTargetSpans = spans.filter((span) => (span.textContent || '').trim());
    loadingTargetLines.forEach((line) => line.classList.add('tst-translating-line'));
    loadingTargetSpans.forEach((span) => span.classList.add('tst-translating-target'));
    loadingEditorRoot = anchor;
    loadingStartedAt = Date.now();
  }

  function hideLoadingIndicator() {
    if (!loadingEditorRoot) return;
    loadingTargetLines.forEach((line) => line.classList.remove('tst-translating-line'));
    loadingTargetSpans.forEach((span) => span.classList.remove('tst-translating-target'));
    loadingTargetLines = [];
    loadingTargetSpans = [];
    loadingEditorRoot = null;
    loadingStartedAt = 0;
  }

  function applyTranslationResult(data) {
    inFlight = false;
    hideLoadingIndicator();

    if (!data.ok || !data.text) return;

    const target = resolveTarget();
    if (!target) return;

    if (target.editor) {
      tryReplaceEditorValue(target.editor, data.text);
    } else if (target.model) {
      target.model.setValue(data.text);
    }
  }

  (function injectLoadingStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .tst-translating-line {
        position: relative;
      }
      .tst-translating-line::after {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image: linear-gradient(
          90deg,
          rgba(0, 0, 0, 0) 43%,
          rgba(0, 0, 0, 0.1) 48%,
          rgba(255, 255, 255, 0.42) 50%,
          rgba(0, 0, 0, 0.1) 52%,
          rgba(0, 0, 0, 0) 57%
        );
        background-size: 240% 100%;
        background-position: 150% 0;
        background-repeat: no-repeat;
        animation: tst-line-sweep 1.35s ease-in-out infinite;
      }
      .tst-translating-target {
        background-image:
          linear-gradient(0deg, currentColor, currentColor),
          linear-gradient(
            90deg,
            rgba(255, 255, 255, 0) 46%,
            rgba(255, 255, 255, 1) 50%,
            rgba(255, 255, 255, 0) 54%
          );
        background-size: 100% 100%, 320% 100%;
        background-repeat: no-repeat;
        background-position: 0 0, 170% 0;
        -webkit-background-clip: text;
        background-clip: text;
        color: inherit !important;
        -webkit-text-fill-color: transparent;
        text-shadow: 0 0 10px rgba(255, 255, 255, 0.2);
        animation: tst-text-sweep 1.35s ease-in-out infinite;
        will-change: background-position;
      }
      @keyframes tst-line-sweep {
        0% { background-position: 150% 0; }
        100% { background-position: -150% 0; }
      }
      @keyframes tst-text-sweep {
        0% { background-position: 0 0, 170% 0; }
        100% { background-position: 0 0, -170% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .tst-translating-line::after {
          animation: none;
          background-position: 0 0;
        }
        .tst-translating-target {
          animation: none;
          background-position: 0 0, 0 0;
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
    const elapsed = loadingStartedAt ? Date.now() - loadingStartedAt : MIN_LOADING_MS;
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
    const modelText = target?.model?.getValue() || '';
    const domText = editorRoot ? extractTextFromDom(editorRoot) : '';
    const text = pickBestText(modelText, domText).trimEnd();
    if (!text || !hasEnoughChinese(text)) {
      debug('skip: no translatable text');
      return;
    }
    inFlight = true;
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
    if (activeEditor?.getModel) return { editor: activeEditor, model: activeEditor.getModel() };

    if (editorRoot) {
      const entry = editorByNode.get(editorRoot);
      if (entry) return { editor: entry.editor, model: entry.model };
    }

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
