# knowledge.md

## What this is

Windows Electron snapshot/fork of **DeepSeek Harness** — product name "Andrey DS Harness",
current fork version **0.5.3**. It is an unpacked distribution (no asar, no source build):
the app is edited in place under `resources/app` and picked up on restart.

- Repo: `main` → `origin/main` = https://github.com/htsgladiatis/deeph
- The fork's own code is the `lib/andrey` layer; everything else is upstream DeepSeek Harness.
- Feature documentation (in Russian): `Andrey DS Harness/README.md`.

## Layout

| Path | What it is |
|---|---|
| `Andrey DS Harness/` | App root: `DeepSeek Harness.exe`, `resources/`, `README.md` |
| `Andrey DS Harness/resources/app/` | Electron app; `package.json` → `main: lib/andrey/boot.cjs` |
| `Andrey DS Harness/resources/app/lib/andrey/` | **The edit surface** |
| `Andrey DS Harness/resources/app/lib/main.js` | Untouched upstream main (`andreyAgent.hostMain`) |
| `Andrey DS Harness/resources/app/dsh/` | Vendor: dsh runtime 0.2.2-rc.3, node_modules, bundled plugins |
| `Andrey DS Harness/resources/runtime/primary-runtime/dependencies/{node,pnpm,python}` | Vendor binaries |

Inside `lib/andrey/`:

- `boot.cjs` — isolate `DSH_HOME`/`userData`, apply active freePi account, start loopback
  route, install UI injection, then import upstream main.
- `compaction-profile.cjs` — boot-time patch of the `compaction-basic` profile entry, so
  harness auto-compaction starts late instead of the default `min(W×0.8, W−O−65536)`.
  The prompt and the answer share the window: `thresholdRatio` 0.95, `headroomTokens` 1000
  and a 32k answer budget give `min(190000, 200000−32768−1000) = 166232` for a 200k model.
  It also caps every freePi model's `maxTokens` at 32k, because a 120k catalogue value
  is the `O` the formula subtracts and used to pull the trigger down to 79k.
- `pi-profile.cjs` also sets the provider image budget for freePi (4 images per request,
  ≤1 MP and ≤400 KB each, ≤4 MB total). freePi answers `413 context_too_long` on requests
  carrying several screenshots even at ~50k text tokens: the context counter prices an
  image as a reference only, while the provider re-reads every image in every body.
- `ui-inject.cjs` — reads `design/panel.css`, `design/{ops,canvas,panel}.js`,
  `ui-renderer.js`, `pet.js`; concatenates them into one classic script (each segment in
  its own `try`) and runs it on every `did-finish-load`. Exposes `rendererScript()`,
  `bundle()`, `VERSION_LABEL`.
- `ui-renderer.js` — version badge, provider highlight, limits plate, accounts page,
  Hand Off ("Передать агенту").
- `pet.js` — corner canvas "blob" with agent states.
- `design/` — canvas editor: `ops.js` (browser schema/validation), `ops.cjs` (Node twin),
  `canvas.js`, `panel.js`, `panel.css` (all classes prefixed `adz-`).
- `freebuff-route.cjs` — the loopback HTTP server: freePi/Freebuff OpenAI bridges
  (`/freepi/v1/*`, `/v1/models`, `/v1/chat/completions`), `/health`, `/limits`, `/ads/*`,
  `/accounts*`, `/design/*`. Can reach ~1800 lines; search before reading whole.
- `freepi-route.cjs`, `context-compress.cjs`, `route-log.cjs`, `limits.cjs`, `ads.cjs`,
  `accounts.cjs` (+ `accounts/`), `pi-profile.cjs`, `freebuff-profile.cjs`.
- `freebuff/` — vendored free-pi CLI plumbing (`freebuff-cli.cjs`, `freebuff-chat.cjs`,
  `freebuff-models.cjs`, `pty-session.cjs`, `secret.cjs`).
- `test/` — `node:test` suites: `*.test.cjs` plus `dom-fixture.cjs`.

Not part of the project: the root-level `package.json`, `main.js`, `config.js`, `app.js`,
`preload.js`, `dashboard-window.js`, `desktop-mcp-adapter.js` are an **untracked** Pen
desktop source dump. Ignore them; the root `package.json` is not this app's manifest.

## Commands

There is no install, build, lint, typecheck or CI step — do not invent one.

```bash
# syntax check every edited script
node --check "Andrey DS Harness/resources/app/lib/andrey/ui-renderer.js"

# bundle smoke test: reads every injected asset, fails on a missing file
node -e "console.log(require('./Andrey DS Harness/resources/app/lib/andrey/ui-inject.cjs').rendererScript().length)"

# unit tests (node:test; 11 tests, ~1s)
cd "Andrey DS Harness/resources/app/lib/andrey" && node --test test/*.test.cjs
```

Note: `node --test test/` fails on Node 22 (`MODULE_NOT_FOUND`) — pass the file glob.

Run / debug:

```bash
# full restart is mandatory; the injected bundle is cached per process and child
# processes outlive the parent, so stop every "DeepSeek Harness" process first
"Andrey DS Harness/DeepSeek Harness.exe" --remote-debugging-port=9222
```

- Renderer page is `dsh-app://app/`; drive it over CDP via
  `http://127.0.0.1:9222/json/list`. The dsh host inspector on port `9230` is a bare Node
  VM with no `document`.
- A hidden window reports `document.hidden === true` and drops clipboard writes — call
  `Page.bringToFront` before testing copy.
- Right-click tests must land in the transcript; the composer is excluded by the input guard.

## Conventions & gotchas

- **Classic scripts only.** Files injected by `ui-inject.cjs` must not use `import`/`export`;
  they talk through `window`. Keep additions additive, idempotent, marked `data-andrey` or a
  known id, and never let them throw into boot (errors are swallowed by the segment wrapper).
- **API base is dynamic.** `ui-inject.cjs` injects `window.__ANDREY_API_BASE__`; the route
  starts on `127.0.0.1:39147` and increments the port on `EADDRINUSE`. Read the base from
  that global, never hardcode 39147 in renderer code.
- **Hand Off URL stays relative**: `api/session.markdown?sessionId=…` resolves through
  `dsh-app://app`; an absolute URL breaks it.
- **Design has one entry point**: a row in the sidebar **More** menu (`[role="menu"]` with
  class `moreMenu`, geometry fallback to the sidebar launcher). Do not add it to other menus
  and do not resurrect the old pill next to the limits plate.
- **Pet** state comes from `fetch` calls to the LLM routes plus a 600 ms DOM poll
  (stop button, `aria-busy`/`data-streaming`, permission dialogs); stay silent when both
  signals are absent. `localStorage`: `andrey-pet-enabled`, `andrey-pet-pos`.
- **Theme tokens** that actually exist: `--dsw-alias-bg-layer-1` (popup bg),
  `--dsw-alias-label-primary` (text), `--dsw-alias-border-l2`, `--dsw-alias-bg-layer-3`
  (hover), `--dsw-alias-state-error-primary`, `--dsw-alias-fg-secondary`.
  `--dsw-alias-bg-l2` / `--dsw-alias-text-l1` do not exist; an inline dark fallback makes
  the menu unreadable on the light theme.
- **Cyrillic text**: edit only with Read/Edit/Write tools. PowerShell 5.1
  `Set-Content`/`Out-File`/here-strings add a BOM and mojibake (already corrupted these files
  once). Afterwards check `charCodeAt(0) !== 0xFEFF` and that there is no `\uFFFD`.
- **The `@andrey/dsh-andrey-extra` client plugin is inert**: it is declared by the
  `desktop` profile but never reaches `__DSH_BOOT__.entries`, so it never loads. Verify UI
  work in `ui-renderer.js`/`pet.js`, not there.
- **Vendor, don't touch casually**: `resources/app/dsh/**` and
  `resources/runtime/primary-runtime/dependencies/**`.

## Runtime data

- Fork data root: `%APPDATA%\andrey-ds-harness\` → `dsh-home/`, `desktop/` (Electron
  userData), `design/<id>.json` (max 50 docs, atomic writes),
  `freebuff-route.log`, `freebuff-runs/<account>/<ts>`.
- `ANDREY_DATA_ROOT` overrides the root (`accounts.cjs`, `freebuff-route.cjs`).
  `ANDREY_DSH_RUNTIME` overrides the bundled runtime dir used for `node-pty`/`@xterm/headless`.
- Useful env vars: `FREEBUFF_CWD`, `FREEBUFF_PROMPT_CHARS` (24000),
  `FREEBUFF_SYSTEM_CHARS` (4000), `FREEBUFF_RUN_TIMEOUT_MS` (600000),
  `FREEBUFF_QUEUE_TIMEOUT_MS` (900000), `ANDREY_CONTEXT_TOKENS` (166232),
  `ANDREY_CONTEXT_ENABLED` (1), `ANDREY_REQUEST_MAX_BYTES` (900000).
- freePi answers `413 context_too_long` on request bodies above ~1 MiB, and images
  dominate that: every screenshot is re-encoded into every body while the token counter
  prices it as a reference. `context-compress.cjs` drops the oldest image payloads
  (text note instead) until the body fits `ANDREY_REQUEST_MAX_BYTES`.
- `resources/app-update.yml` points at the DeepSeek nightly feed, so a lower fork version can
  be overwritten by upstream; deleting that file disables updates.

## Versioning (fork release)

Bump together:

1. `Andrey DS Harness/resources/app/package.json` → `"version"`
2. `VERSION_LABEL` in `ui-inject.cjs` and `ui-renderer.js`
3. `VERSION_LABEL` in `resources/app/dsh/node_modules/@andrey/dsh-andrey-extra/lib/client.js`
4. README title (`# Andrey DS Harness V x.y.z`)
5. `versionLabel` in `%APPDATA%\andrey-ds-harness\dsh-home\profiles\desktop\cordis.patch.yml`

Leave `resources/app/dsh/*` manifests alone unless intentionally upgrading upstream.

## Installed copy on this workstation

The repo copy is canonical, but the user actually runs a separate installed copy at
`%LOCALAPPDATA%\Programs\Andrey DS Harness` (not in git). After editing, copy at least
`resources/app/lib/andrey`, `resources/app/package.json`, the plugin `lib/client.js` and
`README.md` there, compare SHA256, then restart the app.

## Git

- `.gitattributes` routes through Git LFS: `Andrey DS Harness/DeepSeek Harness.exe` and
  `.../dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/dsoffice.exe`.
- `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` (~89 MB) is a plain
  blob; moving it to LFS needs a history rewrite.
- `.gitignore` covers `.freebuff/project-id`, `*.log`, caches (`Cache`, `GPUCache`,
  `Code Cache`), and OS artifacts. Never commit secrets or tokens.
