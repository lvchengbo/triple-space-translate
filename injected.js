(() => {
  if (window.__tripleSpaceTranslateInstalled) {
    return;
  }
  window.__tripleSpaceTranslateInstalled = true;

  const SOURCE = 'triple-space-translate';
  const DEFAULT_MODEL = '';
  const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/generate';
  const MAX_INTERVAL_MS = 200;

  const DEBUG = localStorage.getItem('tstDebug') === '1';
  const debug = (...args) => {
    if (DEBUG) console.info('[Triple Space Translate]', ...args);
  };

  let spaceCount = 0;
  let lastSpaceAt = 0;
  let inFlight = false;
  let activeEditor = null;
  const editorByNode = new WeakMap();
  let spinnerEl = null;

  function showSpinner(editorRoot) {
    hideSpinner();
    const anchor = editorRoot || document.querySelector('.monaco-editor');
    if (!anchor) return;

    const lines = anchor.querySelectorAll('.view-lines .view-line');
    let lastLine = null;
    if (lines?.length) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const text = (lines[i].textContent || '').trim();
        if (text) { lastLine = lines[i]; break; }
      }
    }

    const el = document.createElement('div');
    el.className = 'tst-spinner';
    el.innerHTML = '<div class="tst-dot"></div><div class="tst-dot"></div><div class="tst-dot"></div>';

    if (lastLine) {
      const editorRect = anchor.getBoundingClientRect();
      const lastSpan = lastLine.querySelector('span:last-child') || lastLine;
      const spanRect = lastSpan.getBoundingClientRect();
      el.style.top = (spanRect.top - editorRect.top + (spanRect.height - 6) / 2) + 'px';
      el.style.left = (spanRect.right - editorRect.left + 8) + 'px';
    }

    anchor.appendChild(el);
    spinnerEl = el;
  }

  function hideSpinner() { spinnerEl?.remove(); spinnerEl = null; }

  (function injectSpinnerStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .tst-spinner {
        position: absolute;
        display: flex;
        gap: 3px;
        align-items: center;
        z-index: 9999;
        pointer-events: none;
      }
      .tst-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #e87;
        opacity: 0.3;
        animation: tst-pulse 1s ease-in-out infinite;
      }
      .tst-dot:nth-child(2) { animation-delay: 0.15s; }
      .tst-dot:nth-child(3) { animation-delay: 0.3s; }
      @keyframes tst-pulse {
        0%, 100% { opacity: 0.3; transform: scale(1); }
        50% { opacity: 1; transform: scale(1.3); }
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

    inFlight = false;
    hideSpinner();

    if (!data.ok || !data.text) return;

    const target = resolveTarget();
    if (!target) return;

    if (target.editor) {
      tryReplaceEditorValue(target.editor, data.text);
    } else if (target.model) {
      target.model.setValue(data.text);
    }
  });

  function triggerTranslation(editorRoot) {
    const target = resolveTarget(editorRoot);
    const modelText = target?.model?.getValue() || '';
    const domText = editorRoot ? extractTextFromDom(editorRoot) : '';
    const text = pickBestText(modelText, domText).trimEnd();
    if (!text || !hasEnoughChinese(text)) {
      debug('skip: no translatable text');
      return;
    }
    inFlight = true;
    showSpinner(editorRoot);
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
