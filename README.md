# Triple Space Translate

A Chrome extension that translates Chinese to English in Monaco editors by rapidly pressing the spacebar three times. Uses a local [Ollama](https://ollama.com) LLM for translation.

Built for [solve.it.com](https://solve.it.com).

## How It Works

1. Type Chinese text in a Monaco editor
2. Rapidly press **Space** three times (within 200ms each)
3. A shimmer light-sweep animation appears on translatable Monaco text while translating
4. The editor content is replaced with the English translation

Press a 4th time (still rapid) to re-translate.

## Requirements

- **Google Chrome** (Manifest V3)
- **Ollama** running locally on port 11434
- At least one model installed (auto-detected via `/api/tags`)

## Install

1. Install and start [Ollama](https://ollama.com)
2. Pull a model:
   ```
   ollama pull translategemma:4b
   ```
3. If Ollama blocks extension requests, allow all origins:
   ```
   launchctl setenv OLLAMA_ORIGINS "*"
   ```
   Then restart Ollama.
4. Clone this repo:
   ```
   git clone https://github.com/lvchengbo/triple-space-translate.git
   ```
5. Open `chrome://extensions` and enable **Developer mode**
6. Click **Load unpacked** and select the cloned folder
7. Navigate to any `solve.it.com` page with a Monaco editor

## Configuration

Edit `injected.js` to adjust:

| Constant | Default | Description |
|----------|---------|-------------|
| `MAX_INTERVAL_MS` | `200` | Max ms between each space press |
| `MIN_LOADING_MS` | `700` | Minimum shimmer visibility time in ms |

Edit `sw.js` to adjust:

| Constant | Default | Description |
|----------|---------|-------------|
| `DEFAULT_MODEL` | `translategemma:4b` | Fallback model if auto-detect fails |
| `DEFAULT_ENDPOINT` | `http://127.0.0.1:11434/api/generate` | Ollama API endpoint |
| `REQUEST_TIMEOUT_MS` | `30000` | Request timeout in ms |

## Debug

Enable debug logging in the browser console:

```js
localStorage.setItem('tstDebug', '1')
```

Manually trigger translation:

```js
__tstTranslateNow()
```

## Troubleshooting

- `Extension context invalidated`: the extension was reloaded while the page still had an old content script. Reload the page to attach the latest extension context.
- Shimmer is hard to notice: current default keeps it visible for at least `700ms` (`MIN_LOADING_MS` in `injected.js`).

## Architecture

```
injected.js (MAIN world)  ─── window.postMessage ───>  content.js (ISOLATED world)
     ^                                                        |
     |                                                chrome.runtime.sendMessage
     |                                                        |
     └──── window.postMessage <────────────────────     sw.js (service worker)
                                                          |
                                                    Ollama API (localhost)
```

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension config and permissions |
| `sw.js` | Service worker — Ollama API calls, model detection |
| `content.js` | Message bridge between page and service worker |
| `injected.js` | Monaco editor hooks, triple-space detection, shimmer loading UI |

## License

MIT
