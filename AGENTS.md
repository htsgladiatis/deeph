# AGENTS.md

## Overview
- Windows Electron desktop app snapshot/fork (**Andrey DS Harness V 0.5.2**), an unpacked distribution with no source build. Tracked on `main` -> `origin/main`: https://github.com/htsgladiatis/deeph
- There are no build, lint, typecheck, test, or CI commands in this repo; do not invent them.
- `resources/app` is unpacked (no asar). Changes apply only after a **full restart** of `DeepSeek Harness.exe`: `ui-inject.cjs` caches the injected bundle per process, and stopping the parent leaves child processes alive, so kill every `DeepSeek Harness` process before relaunching.

## Architecture
- App root: `Andrey DS Harness/`. The edit surface is `resources/app/lib/andrey/`. A client plugin at `resources/app/dsh/node_modules/@andrey/dsh-andrey-extra/` is declared by the `desktop` profile but never loads: a newly inserted plugin package never reaches `__DSH_BOOT__.entries` (the note at the top of `ui-inject.cjs` explains why), so that package is inert — verify UI work in `ui-renderer.js`/`pet.js`, not there. Everything else under `dsh/` is vendor.
- `resources/app/package.json` -> `main: lib/andrey/boot.cjs`. Boot isolates data, applies the active freePi account, starts loopback routes, installs UI injection, then imports the original `../main.js` (`andreyAgent.hostMain`).
- `ui-inject.cjs` concatenates `design/panel.css` + `design/{ops,canvas,panel}.js` + `ui-renderer.js` + `pet.js` into one classic script run on every `did-finish-load`. Additions must stay additive/idempotent and never throw into boot (errors are swallowed).
- Loopback HTTP starts at `127.0.0.1:39147` (freePi/Freebuff OpenAI bridges, accounts/limits/ads, design API — see `Andrey DS Harness/README.md`, "Дизайн/API"). On `EADDRINUSE` it increments the port (`freebuff-route.cjs`), so do not assume 39147 is live.
- Vendor/upstream, avoid casual edits: `resources/app/dsh/` (runtime `0.2.2-rc.3`) and `resources/runtime/primary-runtime/dependencies/{node,pnpm,python}`.

## UI conventions & traps
- **Design** ("Дизайн") has exactly one entry point: a row in the sidebar **More** popup. `findDesignMenu` matches `[role="menu"]` with class `moreMenu` (geometry fallback to the sidebar launcher). Do not append it to arbitrary menus and do not re-add the old pill next to the limits plate.
- **Pet** (`pet.js`): fixed canvas blob with states idle/working/replying/waiting/celebrate/error. State comes from `fetch` calls to LLM routes plus a 600 ms DOM poll (stop button, `aria-busy`/`data-streaming`, permission dialogs); keep it silent when both signals are absent. Toggle lives in the More menu; `localStorage` keys `andrey-pet-enabled`, `andrey-pet-pos`.
- Injected files are classic scripts (no `import`/`export`); design exposes `window.AndreyDesign` (`Ctrl+Shift+D`).
- **Hand Off** ("Передать агенту") lives in `ui-renderer.js`. Two entries open one small menu: a capture-phase `contextmenu` listener on `[data-conversation-session]` (skipped over `textarea`/`input`/`contenteditable` and over a non-empty selection, so native copy stays) and a row in the More menu. It fetches `api/session.markdown?sessionId=…` — a relative URL resolves through `dsh-app://app`, so keep it relative — builds a compact handoff (goal + last 12k chars + task), then copies with `navigator.clipboard.writeText` or copies and clicks "New Session". Session id: `data-conversation-session`, fallback `localStorage['dsh.sessions.current']`.
- Theme: use the app's real tokens — `--dsw-alias-bg-layer-1` (popup bg), `--dsw-alias-label-primary` (text), `--dsw-alias-border-l2`, `--dsw-alias-bg-layer-3` (hover), `--dsw-alias-state-error-primary`. Guessed names like `--dsw-alias-bg-l2` or `--dsw-alias-text-l1` do not exist, and an inline style with a dark fallback silently renders an unreadable dark menu on the light theme.
- Cyrillic strings: edit only with Read/Edit/Write tools. PowerShell 5.1 `Set-Content`/`Out-File`/here-strings add a BOM and mojibake — this already corrupted these files once; after writing, check `charCodeAt(0) !== 0xFEFF` and no `\uFFFD`.

## Verification
- `node --check <file>` for every edited `.js`/`.cjs`.
- Bundle smoke test: `node -e "console.log(require('./Andrey DS Harness/resources/app/lib/andrey/ui-inject.cjs').rendererScript().length)"` — reads all injected assets and fails on a missing file.
- Real UI checks: launch `DeepSeek Harness.exe --remote-debugging-port=9222`, then drive the renderer page (`dsh-app://app/`) over CDP from `http://127.0.0.1:9222/json/list`. The dsh host inspector on `9230` is a bare Node VM (no `document`). A hidden window reports `document.hidden === true` and silently drops clipboard writes — call `Page.bringToFront` before testing copy.
- Right-click tests must land inside the transcript; the composer is excluded by the input guard.

## Runtime data, updates, host copies
- Isolated data (set in `boot.cjs`): `%APPDATA%\andrey-ds-harness\{dsh-home,desktop}`; design docs in `...\design\<id>.json`; route log `...\freebuff-route.log`. `ANDREY_DATA_ROOT` overrides the data root in `accounts.cjs`/`freebuff-route.cjs`; `freebuff-cli.cjs` passes `USERPROFILE`/`HOME`/`XDG_CONFIG_HOME` to the spawned CLI (relevant to portable builds).
- Updates run only when packaged and `resources/app-update.yml` exists (feed: DeepSeek nightly), so a lower fork version can be overwritten by upstream. Removing that file disables updates.
- On this workstation a second, installed copy at `%LOCALAPPDATA%\Programs\Andrey DS Harness` is not in git and is what the user actually runs. The repo copy is canonical; sync the edited files (at least `resources/app/lib/andrey`, `resources/app/package.json`, plugin `lib/client.js`, `README.md`) there and compare SHA256, then restart.

## Versioning (Andrey fork)
- Bump together: `resources/app/package.json` `"version"`, `VERSION_LABEL` in `ui-inject.cjs`, `ui-renderer.js` and `@andrey/dsh-andrey-extra/lib/client.js`, the README title, and `versionLabel` in `%APPDATA%\andrey-ds-harness\dsh-home\profiles\desktop\cordis.patch.yml`. Keep `resources/app/dsh/*` manifests unchanged unless intentionally upgrading upstream.

## Git & large files
- `.gitignore` excludes `.freebuff/project-id`, logs/caches (`Cache`, `GPUCache`, `Code Cache`), and OS artifacts. `.gitattributes` tracks via Git LFS: `Andrey DS Harness/DeepSeek Harness.exe` and `.../dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/dsoffice.exe`.
- `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` (~89 MB) is a regular blob (GitHub size warning); moving it to LFS needs history rewrite. Never commit secrets/tokens.
