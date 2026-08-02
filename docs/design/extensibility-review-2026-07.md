# Extensibility review — is "Extensibility is the Product" actually true?

**Date:** 2026-07-01
**Scope:** Audit of Calcula's extension system against the stated goal (PHILOSOPHY.md,
ARCHITECTURE.md, docs/EXTENSION_GUIDE.md) that users/third parties can customize the app
themselves — with the sandboxing/transparency that VBA never had.
**Method:** Source reading of the API facade, the extension host, the worker sandbox, the
Rust scan/verify path, and the boundary lint. Verified by building a real third-party
extension end-to-end (`docs/examples/hello-world-sandboxed/`).

## Verdict

The architecture is genuinely strong and the *in-repo* (built-in) extension model is
first-class and fully dogfooded. True third-party **runtime** loading (drop a bundle in a
folder, no rebuild) **is real** — but only for **non-UI, sandboxed automation**. The
headline promise of "build your own UI and drop it in" is **not achievable today** for
third parties, by deliberate security design. The shipped docs/example overstate this and
should be corrected (done alongside this review).

| Dimension | State | Evidence |
|---|---|---|
| Facade / boundary enforcement | **Real & enforced** | `app/eslint.boundaries.js` — Alien rule (core ⊄ shell/extensions), Facade rule (extensions ⊂ `@api` only), API neutrality, sibling isolation; raw `invoke`/`invokeBackend` banned in extensions. All at error severity, gated in CI (`npm run lint:boundaries`). |
| Built-in extensibility / dogfooding | **Fully realized** | ~80 features are extensions using only `@api`; `app/extensions/_template/`, `manifest.ts`, `app/src/api/contract.ts` (`ExtensionModule`/`ExtensionContext`). Rich main-thread surface: menus, dialogs, task panes, overlays, ribbon, status/activity bar, cell decorations, style interceptors, custom editors, file formats, formula functions, capability-gated backend door. |
| Third-party runtime loading (no rebuild) | **Real** | `scan_extension_directory` + `get_extensions_directory` (`app/src-tauri/src/lib.rs`) → `%APPDATA%/com.calcula.app/extensions/`; blob-ESM import inside a hardened worker (`app/src/api/scriptHost/worker/extensionBootstrap.ts`); consent gate + TOFU-signed sidecar manifests. |
| Third-party **UI** extensions | **Blocked by design** | `mayActivateOnMainThread` returns true only for `"trusted"` built-ins (`app/src/shell/registries/extensionTrust.ts:32`). A distributed bundle with `workerSupport:false` reaches `activateMainThreadExtension()` and is **blocked, never imported** (`app/src/shell/registries/ExtensionManager.ts:753`). In the worker realm, `ui.taskPanes/dialogs/overlays/panels/activityBar/statusBar`, `grid`, `keyboard`, `keybindings`, `settings`, `cellEditors`, `fileFormats`, `formulas` all throw `unsupported()` (`extensionWorkerContext.ts:44`). |
| Security / sandboxing | **Real & selective** | Hardened worker realm (`workerHardening.ts` neuters fetch/XHR/WS/timers/DOM); capability broker with declared-capability ceiling (`computeExtensionCeiling`); Ed25519 + TOFU signing (`core/calp/src/signing.rs`, `verify_extension_manifest` in `lib.rs`); consent gate (`window.confirm`) surfacing name/trust/capabilities; per-script audit ring + transparency panel. |
| Docs / example accuracy | **Inconsistent (now corrected)** | `docs/examples/hello-extension` uses `workerSupport:false` + a main-thread React Activity-Bar panel + `globalThis.CalculaReact` (published at `app/src/main.tsx:22`). That path is refused by the loader, so the example would be **blocked, not loaded**. `docs/EXTENSION_GUIDE.md` §"Third-Party Extension Installation" implied full parity with built-ins. |

## The trusted vs. distributed capability matrix

| Capability | Built-in ("trusted", `manifest.ts`) | Third-party ("distributed", `%APPDATA%`) |
|---|---|---|
| Runs on | Main thread, full ambient authority | Hardened Web Worker only |
| Commands / events / notifications | ✅ | ✅ |
| Menu items | ✅ (create + add) | ✅ add to existing menus only |
| Dialogs / task panes / overlays / ribbon / activity+status bar | ✅ | ❌ throws |
| Cell decorations / style interceptors / custom cell editors | ✅ | ❌ throws |
| Worksheet formula functions | ✅ | ❌ throws |
| Synchronous grid read/write | ✅ | ❌ (async broker only) |
| Backend (Tauri) | ✅ any command | ⛔ gated door; privileged commands denied |
| net.fetch / bi.query / bi.sql / storage / ui.html / formula.udf | ✅ | ✅ **only if declared AND signed** (unsigned ⇒ deny-by-default) |
| Disable / uninstall at runtime | ❌ (compiled in) | ✅ (Extensions panel) |

## Why the gap exists (and why it's defensible)

The refusal of distributed main-thread code is not an oversight — it is the founding
constraint: *"custom code must never run with full machine access like VBA."* A
`window.confirm` cannot be allowed to authorize full ambient window/Tauri/`@api`
authority, so untrusted UI code (which needs the DOM) has no safe path yet. The
`globalThis.CalculaReact` shared-React singleton and `docs/examples/hello-extension`
anticipate a *future* sanctioned main-thread-UI path, but it is currently unreachable for
third parties. This is honest to state and is the single biggest gap between the marketed
promise ("build your own UI, drop it in") and the shipped reality.

## Recommendations

1. **Docs (done with this review):** Correct `docs/EXTENSION_GUIDE.md` §third-party and
   add a status note to `docs/examples/hello-extension`. Add a working, honest reference:
   `docs/examples/hello-world-sandboxed/` (loads today).
2. **Ship a signing CLI.** Capabilities require a signed sidecar, yet no signing tool
   exists (only `.calp` uses `core/calp/src/signing.rs` internally). This review adds a
   dependency-free `docs/examples/sign-extension.mjs`; consider promoting it to a
   first-class `npm run sign-extension` or a Tauri dev command.
3. **Decide the third-party UI story.** Either (a) design the sanctioned main-thread-UI
   path the shared-React infra hints at (with a stronger-than-`confirm` trust gate), or
   (b) give worker extensions a *declarative*/RPC UI surface (host-rendered panels driven
   by worker data) so third parties can present UI without a DOM handle. Until one lands,
   market third-party extensibility as "automation + data + capabilities," not "UI."
4. **Nice-to-have:** a `calcula ext scaffold` that emits the worker-sandboxed skeleton +
   a pre-wired signer, mirroring `app/extensions/_template/` for the third-party case.

## Addendum — gaps found (and fixed) while building the demo

Building the drop-in demo surfaced two real bugs, both now fixed:

1. **`app:selection-changed` had no production emitter.** The event is declared
   (`app/src/api/events.ts`), allowlisted for scripts
   (`SCRIPT_SUBSCRIBABLE_APP_EVENTS`), documented, and subscribed by `_template` — but
   nothing ever emitted it. Selection changes flowed only through the *main-thread*
   `ExtensionRegistry.onSelectionChange` callback registry, which is not bridged to the
   worker realm, so **no worker/script extension could observe the selection** (the demo
   showed "(no cell)"). **Fix:** `ExtensionRegistry.notifySelectionChange` now also emits
   `AppEvents.SELECTION_CHANGED` with `{ row, col, startRow, startCol, endRow, endCol }`.
   This is the general fix — it gives every worker/script extension a working selection
   signal, not just the demo.

2. **Ctrl+C over non-grid UI text copied the cell instead.** `Ctrl+C` is dispatched from
   *four* independent keydown handlers: the menu-accelerator handler in
   `app/src/shell/MenuBar/MenuBar.tsx` (the one actually firing — it matches the Edit ▸
   Copy shortcut and runs `core.clipboard.copy`), the two global keybinding dispatchers
   (`app/src/api/keybindings.ts`, `app/src/api/keyboard.ts`), and the grid keydown handler
   (`app/src/core/hooks/useGridKeyboard.ts`). The dispatchers only deferred to native copy
   when focus was *outside* the grid, but selecting text in a non-focusable toast leaves
   focus on the grid, so the command still ran. **Fix:** all four paths now defer
   `core.clipboard.copy`/`core.clipboard.cut` to the browser's native copy whenever
   `window.getSelection()` is non-collapsed. Grid cells are canvas-drawn and never yield a
   DOM text selection, so this is safe. (That a single shortcut had four independent
   handlers was itself a smell — **subsequently consolidated**: `keyboard.ts` deleted,
   MenuBar's keydown dispatcher removed, the grid's dead clipboard/undo/fill cases
   removed, and undo/redo re-scoped to "not-editing" so the keybinding registry
   (`app/src/api/keybindings.ts`) is now the single dispatcher. See the
   `refactor(keybindings): consolidate keyboard dispatch` change + its jsdom dispatch
   test harness.)

Both illustrate the review's theme: the extension *contract* is broad and well-typed, but
some declared surface is not fully wired. The demo is exactly the kind of end-to-end
exercise that flushes such gaps out.

## Try it

`docs/examples/hello-world-sandboxed/` is a complete, signed, drop-in extension that
demonstrates exactly the supported third-party surface (command + View-menu item + toast
+ selection read + persistent `storage` counter). See its README to install and run.
