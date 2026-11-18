# AGENTS.md

## Overview
- Windows Electron desktop app snapshot/fork (**Andrey DS Harness V 0.5**), an unpacked distribution with no source build. Tracked on `main` -> `origin/main`: https://github.com/htsgladiatis/deeph
- There are no build, lint, typecheck, test, or CI commands in this repo; do not invent them.
- `resources/app` is unpacked (no asar). Changes apply only after a **full restart** of `Andrey DS Harness\DeepSeek Harness.exe`: `ui-inject.cjs` caches the injected bundle per process, so reloading a window is not enough.

## Architecture
- App root: `Andrey DS Harness/`. The edit surface is `resources/app/lib/andrey/`. A client plugin at `resources/app/dsh/node_modules/@andrey/dsh-andrey-extra/` is declared by the `desktop` profile, but it never loads: in this build a newly inserted plugin package never reaches `__DSH_BOOT__.entries` (the note at the top of `ui-inject.cjs` explains why), so that package is inert. Everything else under `dsh/` is vendor.
- `resources/app/package.json` -> `main: lib/andrey/boot.cjs`. Boot isolates data, applies the active freePi account, starts loopback routes, installs UI injection, then imports the original `../main.js` (`andreyAgent.hostMain`).
- `ui-inject.cjs` concatenates `design/panel.css` + `design/{ops,canvas,panel}.js` + `ui-renderer.js` + `pet.js` into one classic script run on every `did-finish-load`. Additions must stay additive/idempotent and never throw into boot (errors are swallowed).
- Local loopback HTTP on `127.0.0.1:39147`: freePi/freeBuff OpenAI bridges, accounts/limits/ads, and the design API (see `Andrey DS Harness/README.md`, "Дизайн/API").
- Vendor/upstream, avoid casual edits: `resources/app/dsh/` (desktop runtime `0.2.2-rc.3`) and `resources/runtime/primary-runtime/dependencies/{node,pnpm,python}`.

## UI conventions & traps
- **Design** ("Дизайн") has exactly one entry point: a row in the sidebar **More** popup. `findDesignMenu` matches `[role="menu"]` with class `moreMenu` (geometry fallback to the sidebar launcher). Do not append it to arbitrary menus and do not re-add the old pill next to the limits plate.
- **Pet** (`pet.js`): fixed canvas blob with states idle/working/replying/waiting/celebrate/error. State comes from `fetch` calls to LLM routes plus a 600 ms DOM poll (stop button, `aria-busy`/`data-streaming`, permission dialogs); keep it silent when both signals are absent. Toggle lives in the More menu; `localStorage` keys `andrey-pet-enabled`, `andrey-pet-pos`.
- Injected files are classic scripts (no `import`/`export`); design exposes `window.AndreyDesign` (`Ctrl+Shift+D`).
- **Hand Off** ("Передать агенту") lives in `ui-renderer.js`, not in a plugin. Two entries open the same small menu: a capture-phase `contextmenu` listener on `[data-conversation-session]` (skipped over inputs and over a non-empty selection, so native copy stays) and a row in the More menu. The menu fetches `api/session.markdown?sessionId=…` (a relative URL resolves through `dsh-app://app`), builds a compact handoff (goal + last 12k chars + task), then copies it with `navigator.clipboard.writeText` — clipboard writes need a focused window — or copies it and clicks "New Session". The session id comes from the `data-conversation-session` attribute, with `localStorage['dsh.sessions.current']` as fallback.
- Cyrillic strings: edit only with Read/Edit/Write tools. PowerShell 5.1 `Set-Content`/`Out-File`/here-strings add a BOM and mojibake — this already corrupted these files once.

## Verification
- `node --check <file>` for every edited `.js`/`.cjs`.
- Bundle smoke test: `node -e "console.log(require('./Andrey DS Harness/resources/app/lib/andrey/ui-inject.cjs').rendererScript().length)"` — this reads all injected files and fails on a missing asset.
- The real check is restarting `Andrey DS Harness\DeepSeek Harness.exe`.

## Runtime data, updates, host copies
- Isolated data (set in `boot.cjs`): `%APPDATA%\andrey-ds-harness\{dsh-home,desktop}`; design docs in `...\design\<id>.json`; route log `...\freebuff-route.log`. `ANDREY_DATA_ROOT` overrides the data root in `accounts.cjs`/`freebuff-route.cjs`; `freebuff-cli.cjs` passes `USERPROFILE`/`HOME`/`XDG_CONFIG_HOME` to the spawned CLI (relevant to portable builds).
- Updates run only when packaged and `resources/app-update.yml` exists (feed: DeepSeek nightly), so a lower fork version can be overwritten by upstream. Removing that file disables updates.
- On this workstation a second, installed copy at `%LOCALAPPDATA%\Programs\Andrey DS Harness` is not in git. The repo copy is canonical; sync `resources/app/lib/andrey`, `package.json` and `README.md` there when the user needs the change in the installed app, then restart it.

## Versioning (Andrey fork)
- Bump together: `resources/app/package.json` `"version"`, `VERSION_LABEL` in `resources/app/lib/andrey/ui-inject.cjs`, `ui-renderer.js` and `@andrey/dsh-andrey-extra/lib/client.js`, the README title, and `versionLabel` in `%APPDATA%\andrey-ds-harness\dsh-home\profiles\desktop\cordis.patch.yml`. Keep `resources/app/dsh/*` manifests unchanged unless intentionally upgrading upstream.

## Git & large files
- `.gitignore` excludes `.freebuff/project-id`, logs/caches (`Cache`, `GPUCache`, `Code Cache`), and OS artifacts. `.gitattributes` tracks via Git LFS: `Andrey DS Harness/DeepSeek Harness.exe` and `.../dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/dsoffice.exe`.
- `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` (~89 MB) is a regular blob (GitHub size warning); moving it to LFS needs history rewrite. Never commit secrets/tokens.
