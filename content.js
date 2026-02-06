const SOURCE = 'triple-space-translate';
const CONTEXT_INVALIDATED = 'Extension context invalidated';
let runtimeAvailable = true;
let runtimeInvalidWarned = false;

console.info('[Triple Space Translate] content script ready', location.href);
requestInjection();

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) {
    return;
  }

  const data = event.data || {};
  if (data.source !== SOURCE || data.type !== 'translate') {
    return;
  }

  console.info('[Triple Space Translate] translate request received', {
    length: data.text?.length || 0,
  });

  if (!runtimeAvailable) {
    postTranslationResult({ ok: false, text: '', error: CONTEXT_INVALIDATED });
    return;
  }

  safeSendMessage({ type: 'translate', text: data.text }, (response, runtimeError) => {
    if (runtimeError) {
      console.warn('[Triple Space Translate] translate response error', runtimeError);
      postTranslationResult({ ok: false, text: '', error: runtimeError });
      return;
    }
    console.info('[Triple Space Translate] translate response', response);
    postTranslationResult({
      ok: Boolean(response?.ok),
      text: response?.text || '',
      error: response?.error || '',
    });
  });
});

function requestInjection() {
  safeSendMessage({ type: 'inject' }, (response, runtimeError) => {
    if (runtimeError) {
      console.warn('Triple Space Translate inject failed', runtimeError);
      return;
    }
    if (!response?.ok) {
      console.warn('Triple Space Translate inject failed', response?.error);
    }
  });
}

function safeSendMessage(message, onDone) {
  if (!runtimeAvailable) {
    onDone?.(null, CONTEXT_INVALIDATED);
    return;
  }

  try {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        const errorMessage = normalizeError(lastError.message);
        markRuntimeUnavailableIfInvalidated(errorMessage);
        onDone?.(null, errorMessage);
        return;
      }
      onDone?.(response, '');
    });
  } catch (error) {
    const errorMessage = normalizeError(error);
    markRuntimeUnavailableIfInvalidated(errorMessage);
    onDone?.(null, errorMessage);
  }
}

function postTranslationResult(payload) {
  window.postMessage({
    source: SOURCE,
    type: 'translation',
    ok: Boolean(payload?.ok),
    text: payload?.text || '',
    error: payload?.error || '',
  }, location.origin);
}

function normalizeError(error) {
  if (!error) return 'unknown runtime error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

function markRuntimeUnavailableIfInvalidated(errorMessage) {
  if (!errorMessage || !errorMessage.includes(CONTEXT_INVALIDATED)) {
    return;
  }
  runtimeAvailable = false;
  if (runtimeInvalidWarned) {
    return;
  }
  runtimeInvalidWarned = true;
  console.warn('[Triple Space Translate] runtime unavailable until page reload');
}
