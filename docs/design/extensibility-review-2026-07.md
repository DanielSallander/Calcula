# Extensibility review — is "Extensibility is the Product" actually true?

**Date:** 2026-07-01
**Scope:** Audit of Calcula's extension system against the stated goal (PHILOSOPHY.md,
ARCHITECTURE.md, docs/EXTENSION_GUIDE.md) that users/third parties can customize the app
themselves — with the sandboxing/transparency that VBA never had.
**Method:** Source reading of the API facade, the extension host, the worker sandbox, the
Rust scan/verify path, and the boundary lint. Verified by building a real third-party
extension end-to-end (`docs/examples/hello-world-sandboxed/`).

## Current as of 2026-08-16 — READ THIS BEFORE THE VERDICT

This review is a **dated snapshot (2026-07-01)** and its headline verdict has been overtaken by
what shipped since. Re-audited 2026-08-16 against source:

- **Recommendation 3(b) was substantially DELIVERED.** The declarative/RPC UI surface this
  review proposed exists: `capabilities.dialog.{alert,confirm,prompt,form}`
  (`app/src/api/scriptHost/worker/extensionWorkerContext.ts:474-489`) — a modal question and a
  data-only form spec "painted by trusted host code … headed by the extension's own name so it
  can never pass itself off as the app". Alongside it: ribbon buttons (`:243`), menu items
  (`:212`), toasts (`:202`), grid cell styles (`:618`), and a native file picker.
- **The capability matrix below is therefore out of date in several rows** — corrected in place,
  each with the row's current evidence. The direction of the error matters: this document
  **undersells** what a third party can build today. A reader following the old matrix would go
  build a surface that already ships.
- **Recommendation 2 is NOT delivered, contrary to what this document claims.** The text says
  "This review adds a dependency-free `docs/examples/sign-extension.mjs`". **That file does not
  exist** — `find . -name "sign-extension*"` returns nothing repo-wide, there is no `sign` script
  in `app/package.json`, and nothing in `app/scripts/`. The gap the recommendation identifies
  (capabilities require a signed sidecar, and no signing tool ships to authors) is **STILL OPEN**.
- **Still true and still the founding constraint:** distributed extensions do not run on the main
  thread and get no DOM handle. `mayActivateOnMainThread` returns true only for `"trusted"`.
- **One safety correction:** the consent gate cited below as evidence of "Real & selective"
  security was, at the time of writing, **failing OPEN**. See the Security row.

## Verdict (as written 2026-07-01 — see the status block above)

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
| Third-party **UI** extensions | **Main-thread UI still blocked by design; a declarative surface has since landed** | `mayActivateOnMainThread` returns true only for `"trusted"` built-ins (`app/src/shell/registries/extensionTrust.ts:46-48` — was `:32`). A distributed bundle with `workerSupport:false` reaches `activateMainThreadExtension()` and is **blocked, never imported** (`ExtensionManager.ts:754`, method at `:834`). **Corrected 2026-08-16:** the "all throw" list was wrong even when narrowed to the worker realm, and is now materially wrong — see the matrix below. Still refused: `ui.taskPanes` (`:264`), `ui.dialogs` (`:271`), `ui.overlays` (`:280`), `ui.panels` (`:283`), `ui.activityBar` (`:289`), `ui.statusBar` (`:292`), `grid.decorations` (`:634`), `grid.styleInterceptors` (`:640`), `keyboard` (`:706`), `settings` (`:712`), `cellEditors` (`:717`), `fileFormats.registerFormat` (`:696`). Now **allowed**: `formulas.registerFunction` (`:549`), `keybindings.register` (`:583`), `fileFormats.registerImporter` (`:674`), `grid.cellStyles.register` (`:618`). |
| Security / sandboxing | **Real & selective — but the gate named here was broken when this was written** | Hardened worker realm (`workerHardening.ts` neuters fetch/XHR/WS/timers/DOM); capability broker with declared-capability ceiling (`computeExtensionCeiling`); Ed25519 + TOFU signing (`core/calp/src/signing.rs`, `verify_extension_manifest` in `lib.rs`); per-script audit ring + transparency panel. **Correction (2026-08-08):** the consent gate cited here as evidence was `window.confirm`, which under Tauri returns a `Promise<boolean>` — so `if (!confirm(...))` tested `!Promise`, was always false, and the gate **failed OPEN**: `ExtensionManager.processPendingConsents` consented to and activated **every unsigned third-party extension at startup**. Fixed by `confirmAsync` (imported `ExtensionManager.ts:61`, used `:981`, which fails closed). See `docs/design/dialog-globals.md`. This row's verdict stands; its *evidence* did not. |
| Docs / example accuracy | **Inconsistent (now corrected)** | `docs/examples/hello-extension` uses `workerSupport:false` + a main-thread React Activity-Bar panel + `globalThis.CalculaReact` (**moved**: now `app/src/api/extensionRuntime.ts:25` `REACT_GLOBAL`, not `main.tsx:22`; covered by `src/api/__tests__/extensionSharedReactRender.test.ts`). That path is refused by the loader, so the example would be **blocked, not loaded**. `docs/EXTENSION_GUIDE.md` §"Third-Party Extension Installation" implied full parity with built-ins. A third example, `docs/examples/addin-tax-tools/`, has since been added and is not described in this review. |

## The trusted vs. distributed capability matrix

| Capability | Built-in ("trusted", `manifest.ts`) | Third-party ("distributed", `%APPDATA%`) |
|---|---|---|
| Runs on | Main thread, full ambient authority | Hardened Web Worker only |
| Commands / events / notifications | ✅ | ✅ |
| Menu items | ✅ (create + add) | ✅ add to existing menus only |
| Ribbon buttons | ✅ | ✅ `ui.ribbon.registerButton` (`extensionWorkerContext.ts:243`) |
| Toasts / notifications | ✅ | ✅ `ui.notifications.showToast` (`:202`) |
| Modal question / declarative form | ✅ | ✅ `capabilities.dialog.{alert,confirm,prompt,form}` (`:474-489`) — host-painted from a data-only spec, headed by the extension's name |
| Task panes / overlays / panels / activity+status bar / `ui.dialogs` | ✅ | ❌ throws (`:264`, `:280`, `:283`, `:289`, `:292`, `:271`) |
| Cell **styles** (background/text) | ✅ | ✅ `grid.cellStyles.register` (`:618`) + declarative `contributes.cellStyles` (`:176`) |
| Cell decorations / style interceptors / custom cell editors | ✅ | ❌ throws (`:634`, `:640`, `:717`) — a decoration draws on the shared canvas synchronously |
| Worksheet formula functions | ✅ | ✅ `formulas.registerFunction(name, options, impl)` (`:549-575`), registered into the host as `kind: "formula"` |
| Keybindings | ✅ | ✅ `keybindings.register` (`:583`) — the sanctioned route; raw `keyboard` is refused (`:706`) so an extension cannot observe every keystroke |
| File formats | ✅ import + export | ✅ `registerImporter` only (`:674`); `registerFormat` refused (`:696`) — an exporter needs whole-workbook read authority no capability grants |
| Synchronous grid read/write | ✅ | ❌ (async broker only) |
| Backend (Tauri) | ✅ any command | ⛔ gated door; privileged commands denied |
| Capabilities (`ALL_CAPABILITY_IDS`) | ✅ | ✅ **only if declared AND signed** (unsigned ⇒ deny-by-default) |

**Matrix corrected 2026-08-16.** The four ✅→ rows that changed side (formula functions, ribbon,
cell styles, keybindings) plus the whole dialog row shipped after 2026-07-01. The capability list
originally read "net.fetch / bi.query / bi.sql / storage / ui.html / formula.udf" — **6 ids**;
there are now **16**, and the canonical list is `ALL_CAPABILITY_IDS`
(`app/src/api/scriptHost/capabilityIds.ts:217-232`), never re-typed elsewhere: the original six
plus `bi.model`, `bi.connector`, `ui.dialog`, `distribution.writeback`, `schedule`, `file.picker`,
`ui.shortcut`, `grid.read`, `distribution.publish`, `distribution.subscribe`.
| Disable / uninstall at runtime | ❌ (compiled in) | ✅ (Extensions panel) |

## Why the gap exists (and why it's defensible)

The refusal of distributed main-thread code is not an oversight — it is the founding
constraint: *"custom code must never run with full machine access like VBA."* A single modal
consent prompt cannot be allowed to authorize full ambient window/Tauri/`@api` authority, so
untrusted UI code (which needs the DOM) has no safe path yet. **This reasoning still holds and
is why option (a) was never built** — only the mechanism's name has changed: the gate is now
`confirmAsync` (`@api/dialogs`), because the `window.confirm` this paragraph names was itself
found to fail open under Tauri. If anything the argument got stronger: a modal that could not
even be relied on to *refuse* is plainly not a foundation for granting ambient authority. The
`globalThis.CalculaReact` shared-React singleton and `docs/examples/hello-extension`
anticipate a *future* sanctioned main-thread-UI path, but it is currently unreachable for
third parties. This is honest to state and is the single biggest gap between the marketed
promise ("build your own UI, drop it in") and the shipped reality.

## Recommendations

1. **Docs (done with this review):** Correct `docs/EXTENSION_GUIDE.md` §third-party and
   add a status note to `docs/examples/hello-extension`. Add a working, honest reference:
   `docs/examples/hello-world-sandboxed/` (loads today).
2. **Ship a signing CLI. — STILL OPEN (2026-08-16). The claim below is false.** Capabilities
   require a signed sidecar, yet no signing tool exists (only `.calp` uses
   `core/calp/src/signing.rs` internally). ~~This review adds a dependency-free
   `docs/examples/sign-extension.mjs`~~ — **it does not; that file was never written.**
   Verified 2026-08-16: no `sign-extension*` anywhere in the repo, no `sign` script in
   `app/package.json`, nothing in `app/scripts/`. So a third-party author still has **no
   supported way to sign an extension**, which means capabilities remain effectively
   unreachable outside the repo. This is the single highest-value open item in this document.
   Consider a first-class `npm run sign-extension` or a Tauri dev command.
3. **Decide the third-party UI story. — DECIDED: (b), and substantially shipped.** Either
   (a) design the sanctioned main-thread-UI path the shared-React infra hints at (with a
   stronger-than-`confirm` trust gate), or (b) give worker extensions a *declarative*/RPC UI
   surface (host-rendered panels driven by worker data) so third parties can present UI
   without a DOM handle. ~~Until one lands, market third-party extensibility as "automation +
   data + capabilities," not "UI."~~
   **Outcome (2026-08-16):** option (b) was taken and is live — ribbon buttons, menu items,
   toasts, cell styles, a native file picker, and `capabilities.dialog.{alert,confirm,prompt,
   form}`, all painted by trusted host code from data-only specs. Option (a) was **not** built
   and remains deliberately unbuilt: distributed code still never touches the main thread. The
   marketing guidance above is superseded — a third party can present real UI today; what it
   cannot do is render arbitrary DOM.
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
