(() => {
  if (window.__tripleSpaceTranslateInstalled) {
    return;
  }
  window.__tripleSpaceTranslateInstalled = true;

  const SOURCE = 'triple-space-translate';
  const DEFAULT_MODEL = '';
  const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/generate';
  const MAX_INTERVAL_MS = 200;
  const MIN_CHINESE_CHARS = 1;

  const DEBUG = localStorage.getItem('tstDebug') === '1';
  const debug = (...args) => {
    if (DEBUG) {
      console.info('[Triple Space Translate]', ...args);
    }
  };

  let spaceCount = 0;
  let lastSpaceAt = 0;
  let inFlight = false;
  let activeEditor = null;
  const editorRegistry = [];
  let spinnerEl = null;

  function showSpinner(editorRoot) {
    hideSpinner();
    const anchor = editorRoot || document.querySelector('.monaco-editor');
    if (!anchor) return;

    const lines = anchor.querySelectorAll('.view-lines .view-line');
    let lastLine = null;
    if (lines && lines.length > 0) {
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

  function hideSpinner() {
    if (spinnerEl && spinnerEl.parentNode) {
      spinnerEl.parentNode.removeChild(spinnerEl);
    }
    spinnerEl = null;
  }

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
    if (event.source !== window || event.origin !== location.origin) {
      return;
    }
    const data = event.data || {};
    if (data.source !== SOURCE || data.type !== 'translation') {
      return;
    }

    inFlight = false;
    hideSpinner();

    if (!data.ok || !data.text) {
      return;
    }

    const target = resolveTarget();
    if (!target) {
      return;
    }

    if (target.editor) {
      tryReplaceEditorValue(target.editor, data.text);
    } else if (target.model) {
      target.model.setValue(data.text);
    }
  });

  const handleKey = (event) => {
      if (event.isComposing || event.key === 'Process') {
        resetCounter();
        return;
      }

      const editorRoot = findMonacoRoot(event);
      if (!editorRoot) {
        resetCounter();
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        resetCounter();
        return;
      }

      const keyCode = typeof event.keyCode === 'number' ? event.keyCode : null;
      if (
        event.key !== ' ' &&
        event.code !== 'Space' &&
        event.key !== 'Spacebar' &&
        keyCode !== 32
      ) {
        resetCounter();
        return;
      }

      const now = Date.now();
      if (now - lastSpaceAt > MAX_INTERVAL_MS) {
        spaceCount = 0;
      }

      spaceCount += 1;
      lastSpaceAt = now;
      debug('space', { count: spaceCount, target: event.target });

      if (spaceCount < 3) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const target = resolveTarget(editorRoot);
      const modelText = target && target.model ? (target.model.getValue() || '') : '';
      const domText = editorRoot ? extractTextFromDom(editorRoot) : '';
      const text = pickBestText(modelText, domText).trimEnd();
      if (!text) {
        debug('no text found');
        return;
      }
      if (!hasEnoughChinese(text, MIN_CHINESE_CHARS)) {
        debug('no chinese text found');
        return;
      }

      inFlight = true;
      showSpinner(editorRoot);
      debug('translate request', { length: text.length });
      window.postMessage(
        {
          source: SOURCE,
          type: 'translate',
          text,
          model: DEFAULT_MODEL,
          endpoint: DEFAULT_ENDPOINT,
        },
        location.origin
      );
  };

  document.addEventListener('keydown', handleKey, true);

  function resetCounter() {
    spaceCount = 0;
    lastSpaceAt = 0;
  }

  window.__tstTranslateNow = () => {
    const editorRoot = findMonacoRoot({ target: document.activeElement }) || findFallbackRoot();
    const target = resolveTarget(editorRoot);
    const modelText = target && target.model ? (target.model.getValue() || '') : '';
    const domText = editorRoot ? extractTextFromDom(editorRoot) : '';
    const text = pickBestText(modelText, domText).trimEnd();
    if (!text) {
      console.warn('[Triple Space Translate] no text to translate');
      return;
    }
    if (!hasEnoughChinese(text, MIN_CHINESE_CHARS)) {
      console.warn('[Triple Space Translate] no chinese text to translate');
      return;
    }
    inFlight = true;
    showSpinner(editorRoot);
    debug('manual translate request', { length: text.length });
    window.postMessage(
      {
        source: SOURCE,
        type: 'translate',
        text,
        model: DEFAULT_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      },
      '*'
    );
  };

  function isEditorTarget(target) {
    if (!target || !(target instanceof Element)) {
      return false;
    }
    return Boolean(target.closest('.monaco-editor'));
  }

  function findMonacoRoot(event) {
    let containerCandidate = null;
    if (event && typeof event.composedPath === 'function') {
      const path = event.composedPath();
      for (const node of path) {
        if (node instanceof Element) {
          if (node.classList.contains('monaco-editor')) {
            return node;
          }
          if (!containerCandidate && node.classList.contains('monaco-editor-container')) {
            containerCandidate = node;
          }
        }
      }
    }

    if (event && event.target instanceof Element) {
      const targetRoot = event.target.closest('.monaco-editor');
      if (targetRoot) {
        return targetRoot;
      }
      if (!containerCandidate) {
        containerCandidate = event.target.closest('.monaco-editor-container');
      }
    }

    if (document.activeElement instanceof Element) {
      const activeRoot = document.activeElement.closest('.monaco-editor');
      if (activeRoot) {
        return activeRoot;
      }
      if (!containerCandidate) {
        containerCandidate = document.activeElement.closest('.monaco-editor-container');
      }
    }

    return containerCandidate;
  }

  function installMonacoHooks() {
    if (window.monaco && window.monaco.editor) {
      hookMonaco(window.monaco);
      return;
    }

    try {
      Object.defineProperty(window, 'monaco', {
        configurable: true,
        enumerable: true,
        set(value) {
          Object.defineProperty(window, 'monaco', {
            configurable: true,
            enumerable: true,
            writable: true,
            value,
          });
          if (value && value.editor) {
            hookMonaco(value);
          }
        },
        get() {
          return undefined;
        },
      });
    } catch {
      // ignore
    }
  }

  function hookMonaco(monaco) {
    if (!monaco || !monaco.editor || monaco.editor.__tripleSpacePatched) {
      return;
    }

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
    if (!editor || typeof editor.getModel !== 'function') {
      return;
    }

    const domNode = editor.getDomNode ? editor.getDomNode() : null;
    const entry = { editor, root: domNode, model: editor.getModel() };
    editorRegistry.push(entry);

    if (typeof editor.onDidChangeModel === 'function') {
      editor.onDidChangeModel(() => {
        entry.model = editor.getModel();
      });
    }

    if (typeof editor.onDidFocusEditorText === 'function') {
      editor.onDidFocusEditorText(() => {
        activeEditor = editor;
      });
    }
  }

  function resolveTarget(editorRoot) {
    if (activeEditor && typeof activeEditor.getModel === 'function') {
      return { editor: activeEditor, model: activeEditor.getModel() };
    }

    if (editorRoot) {
      for (const entry of editorRegistry) {
        if (
          entry.root &&
          (entry.root.contains(editorRoot) || editorRoot.contains(entry.root))
        ) {
          return { editor: entry.editor, model: entry.model };
        }
      }
    }

    const model = pickActiveModel(editorRoot);
    if (model) {
      return { editor: null, model };
    }

    return null;
  }

  function tryReplaceEditorValue(editor, text) {
    try {
      const model = editor.getModel();
      if (!model) {
        return;
      }
      editor.pushUndoStop();
      editor.executeEdits('triple-space-translate', [
        { range: model.getFullModelRange(), text },
      ]);
      editor.pushUndoStop();
    } catch {
      const model = editor.getModel();
      if (model) {
        model.setValue(text);
      }
    }
  }

  function hasEnoughChinese(text, minChars) {
    if (!text) {
      return false;
    }
    if (hanRegex.test(text)) {
      return true;
    }
    return false;
  }

  function extractTextFromDom(editorRoot) {
    if (!editorRoot) {
      return '';
    }
    const lines = editorRoot.querySelectorAll('.view-lines .view-line');
    if (!lines || lines.length === 0) {
      return '';
    }
    const output = [];
    for (const line of lines) {
      const text = (line.textContent || '').replace(/\u00a0/g, ' ');
      output.push(text);
    }
    return output.join('\n');
  }

  function pickBestText(modelText, domText) {
    if (modelText && modelText.trim()) {
      return modelText;
    }
    if (domText && domText.trim()) {
      return domText;
    }
    return modelText || domText || '';
  }

  function findFallbackRoot() {
    const candidates = document.querySelectorAll('.monaco-editor, .monaco-editor-container');
    if (!candidates || candidates.length === 0) {
      return null;
    }
    return candidates[candidates.length - 1];
  }

  function pickActiveModel(editorRoot) {
    const monaco = window.monaco;
    if (!monaco || !monaco.editor || typeof monaco.editor.getModels !== 'function') {
      return null;
    }

    const models = monaco.editor.getModels();
    if (!models || models.length === 0) {
      return null;
    }

    if (editorRoot) {
      const uri = editorRoot.getAttribute('data-uri');
      if (uri) {
        for (const model of models) {
          if (model.uri && typeof model.uri.toString === 'function' && model.uri.toString() === uri) {
            return model;
          }
        }
      }
    }

    return models[models.length - 1];
  }
})();
