const SOURCE = 'triple-space-translate';

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
    length: data.text ? data.text.length : 0,
  });

  chrome.runtime.sendMessage(
    {
      type: 'translate',
      text: data.text,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn(
          '[Triple Space Translate] translate response error',
          chrome.runtime.lastError.message
        );
        return;
      }
      console.info('[Triple Space Translate] translate response', response);
      const payload = {
        source: SOURCE,
        type: 'translation',
        ok: Boolean(response && response.ok),
        text: response && response.text ? response.text : '',
        error: response && response.error ? response.error : '',
      };
      window.postMessage(payload, location.origin);
    }
  );
});

function requestInjection() {
  chrome.runtime.sendMessage({ type: 'inject' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Triple Space Translate inject failed', chrome.runtime.lastError.message);
      return;
    }
    if (!response || !response.ok) {
      console.warn('Triple Space Translate inject failed', response && response.error);
    }
  });
}
