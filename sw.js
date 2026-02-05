const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/generate';
const DEFAULT_MODEL = 'deepseek-r1:14b';
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;

let cachedModels = [];
let cachedAt = 0;


chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'inject') {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    const frameId = typeof _sender.frameId === 'number' ? _sender.frameId : 0;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'missing tab id' });
      return false;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        files: ['injected.js'],
      },
      () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true });
      }
    );

    return true;
  }

  if (!message || message.type !== 'translate') {
    return false;
  }

  console.info('[Triple Space Translate] background translate start', {
    length: message && message.text ? message.text.length : 0,
  });

  const endpoint = DEFAULT_ENDPOINT;
  const text = typeof message.text === 'string' ? message.text : '';

  if (!text.trim()) {
    sendResponse({ ok: false, error: 'empty text' });
    return false;
  }

  const prompt = [
    'Translate the following Chinese text to natural English.',
    'Preserve line breaks and punctuation.',
    'Output only the translation.',
    '',
    text,
  ].join('\n');

  (async () => {
    const requestedModel =
      typeof message.model === 'string' && message.model ? message.model : '';
    let model = await resolveModel(endpoint, requestedModel);
    if (!model) {
      model = DEFAULT_MODEL;
    }

    console.info('[Triple Space Translate] using model', model, 'endpoint', endpoint);

    try {
      const translation = await generate(endpoint, model, prompt);
      console.info('[Triple Space Translate] background translate done', {
        model,
        length: translation.length,
      });
      sendResponse({ ok: true, text: translation });
      return;
    } catch (error) {
      console.warn('[Triple Space Translate] generate failed', { model, error: String(error) });
      const status = error && typeof error.status === 'number' ? error.status : null;
      if (status === 404 || String(error).includes('404')) {
        cachedModels = [];
        cachedAt = 0;
        const models = await listModels(endpoint);
        console.info('[Triple Space Translate] available models for fallback', models);
        const fallback = models.find((m) => m !== model);
        if (fallback) {
          try {
            const translation = await generate(endpoint, fallback, prompt);
            console.info('[Triple Space Translate] background translate done (fallback)', {
              model: fallback,
              length: translation.length,
            });
            sendResponse({ ok: true, text: translation });
            return;
          } catch (fallbackError) {
            console.warn(
              '[Triple Space Translate] fallback also failed',
              { model: fallback, error: String(fallbackError) }
            );
          }
        }
      }
      sendResponse({ ok: false, error: `${error} (model=${model}, endpoint=${endpoint})` });
    }
  })();

  return true;
});

async function generate(endpoint, model, prompt) {
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });

  if (!response.ok) {
    const error = new Error(`Ollama error: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const raw = typeof data.response === 'string' ? data.response.trim() : '';
  return raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

async function resolveModel(endpoint, requestedModel) {
  if (requestedModel) {
    return requestedModel;
  }

  const models = await listModels(endpoint);
  if (models.length > 0) {
    if (models.includes(DEFAULT_MODEL)) {
      return DEFAULT_MODEL;
    }
    return models[0];
  }

  return '';
}

async function listModels(endpoint) {
  const now = Date.now();
  if (cachedModels.length > 0 && now - cachedAt < MODEL_CACHE_TTL_MS) {
    return cachedModels;
  }

  const baseUrl = getBaseUrl(endpoint);
  const tagsUrl = `${baseUrl}/api/tags`;
  try {
    const response = await fetchWithTimeout(tagsUrl, {});
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const names = models
      .map((model) => (model && typeof model.name === 'string' ? model.name : ''))
      .filter(Boolean);
    cachedModels = names;
    cachedAt = now;
    return names;
  } catch (error) {
    console.warn('[Triple Space Translate] listModels failed', error);
    return [];
  }
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function getBaseUrl(endpoint) {
  try {
    const url = new URL(endpoint);
    const apiIndex = url.pathname.indexOf('/api/');
    url.pathname = apiIndex >= 0 ? url.pathname.slice(0, apiIndex) : '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return endpoint.replace(/\/api\/.*$/, '');
  }
}
