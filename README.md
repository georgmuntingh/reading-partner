# reading-partner

## Run
On Linux, a separate Chrome instance with webgpu can be started with:
```bash
google-chrome --enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE --user-data-dir=/tmp/chrome-webgpu
```

## Testing

`npm test` runs the full vitest suite (happy-dom + fake-indexeddb). The
build is gated on these specs.

### Knowledge Graph verification matrix

The KG pipeline can't be fully verified without a real browser (no live
WebWorker, no real cytoscape canvas, no real OpenRouter), so the
verification gate is split between `npm test` and a short manual run.

| # | Check | How |
|---|---|---|
| 1 | Clean install | `rm -rf node_modules dist && npm ci` |
| 2 | Unit + integration tests pass | `npm test` (7 spec files, 65 cases) |
| 3 | DB v3 → v4 migration | Auto: `test/storage.test.js` ("opens DB at version 4 with kg_nodes and kg_edges stores"). Browser: DevTools → Application → IndexedDB → `reading-partner-db` shows version 4. |
| 4 | KG settings round-trip | Auto: `test/storage.test.js` ("persists and reads KG settings via the existing settings store"). Browser: Settings → Knowledge Graph section, change a value, close + reopen modal. |
| 5 | Embedding worker boots | Auto: `test/embedding-provider.test.js` (worker protocol via MockWorker). Browser: trigger a build; the `kg-status` toast shows "Downloading embedding model …" on first run. |
| 6 | Cloud extraction round-trip | Auto: `test/kg-controller.test.js` ("happy path: extracts, embeds, resolves, persists nodes + edges"). Browser: with an OpenRouter key, click *Build graph*; `kg_nodes`/`kg_edges` populate. |
| 7 | Local extraction (transformers.js LLM) | Browser only: switch `kgExtractionBackend` to `local`, click *Build graph*. Confirm two transformers.js workers in DevTools → Sources → Threads. |
| 8 | Cross-chapter resolution | Auto: `test/kg-pipeline.integration.test.js` ("cross-chapter resolution: Arthur in ch0 and ch1 share one node id with growing aliases and contexts"). |
| 9 | Edge dedup on rebuild | Auto: `test/kg-pipeline.integration.test.js` ("rebuilding the same chapter does not double-count edges"). |
| 10 | Bad-JSON resilience | Auto: `test/kg-pipeline.integration.test.js` ("bad-JSON resilience: one malformed chunk does not crash the chapter; pipeline reaches DONE with partial graph"). |
| 11 | Graph UI render + click-through | Auto: `test/graph-explorer.test.js` (lazy import, side-panel render, context-link → onJumpToSentence + close, XSS-escape, destroy on close, fresh instance on reopen). Browser: click *Open graph*, tap a node, click a context link to jump back into the reader. |
| 12 | Cytoscape lazy-loaded into its own chunk | `npm run build && du -k dist/assets/*.js \| sort -n` — confirm a separate `cytoscape.esm-*.js` chunk (~440 KB) and that the main `index-*.js` does not contain the cytoscape source. |
| 13 | Capacitor app build | `npm run build:app` |

For a one-shot verification run:

```bash
rm -rf node_modules dist
npm ci
npm test           # 65/65 expected
npm run build      # cytoscape splits into its own chunk
npm run build:app  # capacitor variant
```
