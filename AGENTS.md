# AGENTS.md

## Overview
- Windows Electron desktop app snapshot/fork (**Andrey DS Harness V 0.2**) of DeepSeek Harness, tracked in git (`main` -> `origin/main`, repo: https://github.com/htsgladiatis/deeph`). This is an unpacked distribution, not a source workspace with build/test scripts.
- `resources/app` is unpacked (no asar): edits take effect after restarting the app.

## Key paths & architecture
- App root: `Andrey DS Harness/` (`DeepSeek Harness.exe`, Electron runtime files, `resources/app`, `resources/runtime`).
- Custom layer (primary edit surface): `Andrey DS Harness/resources/app/lib/andrey/`.
  - Entry: `resources/app/package.json` `"main": "lib/andrey/boot.cjs"` -> boot applies profile/route/UI setup, then imports original `../main.js` (`andreyAgent.hostMain`).
  - UI injection: `ui-inject.cjs` runs `ui-renderer.js`, `pet.js` + `design/*` on every window load (`did-finish-load`); additions must stay additive/idempotent and must not break boot (failures are swallowed).
  - Pet overlay: `pet.js` draws one fixed canvas blob (states idle/working/replying/waiting/celebrate/error) from fetch traffic to LLM routes plus a DOM poll; toggled by the «…» menu item, state persisted in `localStorage` (`andrey-pet-enabled`, `andrey-pet-pos`). Keep it silent when both signals are absent.
  - Local loopback routes/services (port `39147`): freePi/freeBuff OpenAI-compatible bridges, accounts/limits/ads, and design APIs (see `Andrey DS Harness/README.md` "Дизайн/API").
- Bundled/upstream runtime (avoid casual edits): `resources/app/dsh/` (desktop runtime, large `node_modules`, manifests like `desktop-runtime.json`/`package.json` at `0.2.2-rc.3`) and `resources/runtime/primary-runtime/dependencies/{node,pnpm,python}`.

## Runtime data & logs
- Isolated per-copy data (set in `boot.cjs`): `%APPDATA%\andrey-ds-harness\dsh-home` and `%APPDATA%\andrey-ds-harness\desktop` (overridable via `DSH_HOME`/`ANDREY_DATA_ROOT` patterns used in code).
- Design documents: `%APPDATA%\andrey-ds-harness\design\<id>.json` (per README). Route log: `%APPDATA%\andrey-ds-harness\freebuff-route.log`.

## Development & verification
- No repo build/lint/typecheck/test commands or CI config are present in this snapshot; do not invent them. Verify changes by restarting `Andrey DS Harness\DeepSeek Harness.exe`.
- Prefer changes in `resources/app/lib/andrey/` (and app `package.json`/`README.md` when relevant). Treat bundled binaries, `resources/runtime`, and `resources/app/dsh` vendor/runtime trees as generated/vendor unless the task explicitly targets them.

## Versioning (Andrey fork)
- When bumping the fork version, update together (pattern established): `Andrey DS Harness/resources/app/package.json` `"version"`, `VERSION_LABEL` in `resources/app/lib/andrey/ui-inject.cjs` and `resources/app/lib/andrey/ui-renderer.js`, and README title if applicable. Keep bundled upstream runtime versions (`resources/app/dsh/*` manifests) unchanged unless intentionally upgrading upstream.

## Git & large files
- `.gitignore` excludes `.freebuff/project-id`, logs/caches (`Cache`, `GPUCache`, `Code Cache`), OS artifacts, etc. `.gitattributes` tracks via Git LFS: `Andrey DS Harness/DeepSeek Harness.exe` and `.../dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/dsoffice.exe`.
- `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` (~89 MB) is committed as a regular blob (GitHub size warning); moving it to LFS requires history rewrite considerations. Do not commit secrets/tokens.
