# Third-Party Add-in Authoring — the trust-escalation decision

**Date:** 2026-07-31 (decision) / 2026-08-01 (slice 1 shipped) / 2026-08-01 (G0 on-ramp shipped)
**Status:** Decision below stands unchanged. **Slice 1 is implemented — see §6. The signing +
install on-ramp is implemented — see §7.**
**Answers:** `docs/design/scripting-vba-review.md` §6.1 + roadmap item 15.
**Related:** `docs/design/extensibility-review-2026-07.md` (2026-07-01) recommendation 3, which
raised the same fork and deliberately left it open.

---

## 1. Decision

**Do not escalate third-party code onto the main thread. Grow the worker-extension API instead,
using the realm Calcula already has and is not exploiting: the opaque-origin `srcdoc` iframe.**

Concretely, the recommendation is a three-part answer:

| | Answer | Why |
|---|---|---|
| **Primary** | **Richer worker-extension API** (option O3 below): host-mediated formula registration, host-rendered declarative UI, host-rendered iframe UI, keybindings, and argument-taking grid/structural ops — all data-only across the boundary. | Preserves the security pillar *unchanged*. The sandbox stays the sandbox; the API grows to the point where main-thread access is unnecessary for the overwhelming majority of add-ins. |
| **Secondary** | **Developer mode** (O2), narrowly scoped: a per-session, per-bundle, explicitly-armed main-thread load for the author's *own* bundle, loudly badged and never persisted. | Authoring loop only. It is a debugging affordance, not a distribution channel. |
| **Rejected as the primary answer** | **Signed-publisher main-thread escalation** (O1). | A signature proves *who*, not *what*. Ed25519 + TOFU is identity, not containment; using it to unlock ambient `window`/Tauri/`@api` authority reintroduces exactly the VBA failure mode the project exists to fix. A signature should raise the *capability ceiling* and reduce *consent friction* — never change the *execution realm*. |

The one-line rule this doc adds to the architecture: **trust changes what you may ask the host to
do; it never changes who is holding the pointer.**

---

## 2. The problem, with evidence

### 2.1 Trust is binary and the classification is hardcoded

`app/src/shell/registries/extensionTrust.ts:32-34`:

```ts
export function mayActivateOnMainThread(trust: ExtensionTrust): boolean {
  return trust === "trusted";
}
```

`ExtensionTrust` has exactly two members — `"trusted" | "distributed"`
(`app/src/api/extensionManager.ts:23`). Built-ins from `extensions/manifest.ts` are activated as
`"trusted"` (`ExtensionManager.ts:384-386`); *every* bundle scanned from
`%APPDATA%/com.calcula.app/extensions/` is `"distributed"` — there is no code path that constructs
any other value for a scanned bundle (`ExtensionManager.ts:590-674`, `recordWorkerExtension:887-919`,
`recordBlockedExtension:764-785`, `recordPendingConsent:791-826`, all hardcode `trust: "distributed"`).

The refusal is not merely a policy call — the call site passes a literal:

`app/src/shell/registries/ExtensionManager.ts:748-759`

```ts
private async activateMainThreadExtension(_source: string, name: string, ...): Promise<void> {
  if (!mayActivateOnMainThread("distributed")) {
    ... this.recordBlockedExtension(name, reason, trustStatus, fileName);
    return;
  }
  // No main-thread activation path exists for distributed code by design.
}
```

The bundle is never imported. Consent cannot change this: the consent gate
(`ExtensionManager.ts:623-635`, `processPendingConsents:858-882`) runs *before* this point and only
decides whether to attempt a mount at all.

### 2.2 The sandboxed realm refuses every UI and formula surface

`app/src/api/scriptHost/worker/extensionWorkerContext.ts` throws `unsupported()` (defined 51-58) on:

| Surface | Line |
|---|---|
| `ui.taskPanes` | 168-170 |
| `ui.dialogs` | 171-176 |
| `ui.overlays` | 177-179 |
| `ui.panels` | 180-182 |
| `ui.activityBar` | 183-185 |
| `ui.statusBar` | 186-188 |
| `grid` (decorations, style interceptors, overlays, edit/range guards, cell clicks, cell types, layers) | 358-360 |
| `keyboard` | 361-363 |
| `keybindings` | 364-366 |
| `settings` | 367-369 |
| `cellEditors` | 370-372 |
| `fileFormats` | 373-375 |
| `formulas` | 376-378 |

There is no ribbon surface in the worker context at all — not even a throwing getter.

### 2.3 What a third party *can* actually ship today (verified)

From the same file, the complete affirmative surface is:

- `commands.register` / `commands.executeCommand` (117-130) — and `executeCommand` only reaches
  commands flagged `scriptSafe` (`extensionWorkerHost.ts:505-515`); the review counted **three**
  such commands repo-wide.
- `ui.menus.registerMenuItem` (138-167) — items added to *existing* menus; a worker extension
  cannot create a menu.
- `ui.notifications.showToast` (133-137).
- `events.onAppEvent` / `emitAppEvent` (191-204), payloads thinned (`extensionWorkerHost.ts:363-374`).
- `capabilities.*` (206-355): `fetch`, `storage.get/set`, `biQuery`, `biSql`, `listBiConnections`,
  `cube.value/kpi/members`, `biModel.*`, `writeback.*`, `dialog.alert/confirm/prompt/form`.

The whole reachable method set is the 30-row allowlist `EXTENSION_BROKER_METHODS`
(`extensionProtocol.ts:107-150`). The backend door is separately denied for distributed callers
(`ExtensionManager.ts:513`, `createScopedInvokeBackend(trust === "trusted", …)`).

### 2.4 Net effect

A third party can ship *automation*: a menu item that queries a BI model, fetches an allowlisted
origin, asks the user a question through a host-rendered dialog, and writes storage. They cannot
ship: a worksheet function, a ribbon group, a task pane, a custom cell editor, a file format, a
grid decoration, a keyboard shortcut, or a settings page. The vision statement names "formulas,
VBA, add-ins" as what Calcula exists to restore; a `.xlam` function library — the single most
common third-party Excel artifact — is not expressible. There is also no install command
(`uninstall_extension` exists at `app/src-tauri/src/lib.rs:3850`; there is no counterpart), so the
distribution story is "copy a `.js` and two sidecar files into `%APPDATA%` by hand".

---

## 3. The options

### O1 — Signed-publisher trust escalation

Reuse the existing Ed25519 + TOFU machinery (`core/calp/src/signing.rs:85-287`;
`verify_extension_manifest` at `app/src-tauri/src/lib.rs:3573-3622`, pinning under `ext:<id>` at
3609) to introduce a third trust class — say `"publisher"` — that *does* pass
`mayActivateOnMainThread`, gated on a `verified` signature plus an emphatic consent dialog.

- **Security pillar:** ✗ **Fails.** The signature authenticates the author and detects tampering.
  It says nothing about behaviour. A main-thread extension holds ambient `window`, `document`,
  `__TAURI_INTERNALS__` and the full `@api` object — no ceiling, no broker, no audit ring, because
  none of those are in the call path. `computeExtensionCeiling` returns `[]` for anything not
  ceiling-bound (`extensionTrust.ts:46`) and the R19 ceiling check lives in the broker
  (`broker.ts:162-168`), which main-thread code never enters. A compromised or coerced signing key
  is then equivalent to a machine compromise — the VBA outcome, with a certificate stapled to it.
  Excel's own history is the proof: signed macros did not stop macro malware.
- **Transparency pillar:** ✗ Partial at best. The transparency panel and audit ring are fed by
  broker calls (`broker.ts:209-232` write-through) and mounted handles
  (`registerMountedHandle`, `broker.ts:473`). Main-thread code produces no such records, so the
  "one audit trail spans all script activity" claim would acquire a silent hole exactly where the
  most powerful code runs.
- **Effort:** **S.** Add a trust member, thread it from `trustStatus`, restore a main-thread import
  path. Deceptively cheap — which is the danger.
- **Unlocks:** Everything, immediately. Full API parity with built-ins.
- **Verdict:** Reject as the escalation mechanism. **Keep the underlying idea in a narrower role:**
  a verified signature already gates whether the declared capability ceiling is honored at all
  (`ExtensionManager.ts:644-652` — unsigned/invalid/changed ⇒ empty ceiling). Extend *that*: a
  verified publisher may declare a wider ceiling, may pre-declare capability grants that consent
  approves in one step, and may skip re-prompting on a version bump whose signature chain is intact.
  Signature buys *reach and quiet*, never *the main thread*.

### O2 — Explicit developer mode

A setting (or launch flag) that, for a single session, loads one nominated bundle on the main
thread with a persistent, unmissable badge, no persistence, and a hard refusal to co-exist with a
subscribed `.calp` or a real workbook flagged as such.

- **Security pillar:** ⚠ Acceptable *only* if it cannot be socially engineered. The failure mode is
  "paste this into the box and click Yes" — which is how every "enable macros" attack works. It
  must therefore be armed out-of-band (a settings toggle behind a typed confirmation, or a CLI
  flag), never armed by anything an incoming file can trigger, and must reset on restart.
- **Transparency pillar:** ✓ if the badge is genuinely persistent and the session is recorded in
  the workbook audit log.
- **Effort:** **S–M.** The blocked path already exists at `ExtensionManager.ts:748-759`; dev mode is
  a condition on it, plus a badge and the arming UX. `globalThis.CalculaReact`
  (`app/src/main.tsx:22`, `exposeExtensionRuntimeGlobals`) already exists to let a runtime-loaded
  bundle render with the host React — that infrastructure is currently unreachable and would
  finally be exercised.
- **Unlocks:** Nothing for end users. Everything for the author's inner loop.
- **Verdict:** **Adopt as a secondary, clearly-labelled authoring affordance.** It is not a
  distribution answer and must never be described as one. Its real value is that it makes O3
  developable: an author can prototype against the full API and then discover, mechanically, which
  parts of their add-in need a worker-safe equivalent.

### O3 — Richer worker-extension API (recommended)

Stop treating "the worker can't do X" as a fact about the sandbox and start treating it as a gap in
the protocol. The boundary rule is not "no UI" — it is **no ambient authority**. Anything
expressible as *data crossing a structured-clone boundary, rendered or executed by trusted host
code* is compatible with the sandbox by construction.

Calcula already has all three mechanisms this needs, in production, for a *different* consumer:

1. **Relayed registration with a host-installed proxy** — the existing pattern for commands, menu
   items and events (`extensionWorkerHost.ts:341-398`). The handler never leaves the worker; the
   host owns the registry entry.
2. **Host-rendered declarative UI from a data-only spec** — `capabilities.dialog.form` takes a
   `ScriptDialogFormSpec` and the *host* paints the modal, headed by the extension's own name
   (`extensionWorkerContext.ts:336-354`, `extensionWorkerHost.ts:694-746`,
   `app/src/api/scriptHost/scriptDialogSpec.ts`). This is a working proof that third-party UI does
   not require third-party DOM access.
3. **An opaque-origin sandboxed iframe** — `ui.html` / `render.setHtml`
   (`allowlist.ts:69`) renders script-authored HTML in `sandbox="allow-scripts"` `srcdoc` frames
   with a `postMessage` bridge as the only channel
   (`app/extensions/ControlsPane/components/CustomControlHost.tsx:413-470, 847-850` — "with srcdoc
   this gives the iframe an opaque origin: no same-origin access, no cookies, no storage, no
   `__TAURI__`"). **This is the third realm the extension host is not using.** It sits precisely
   between "worker, no pixels" and "main thread, full authority", and it already carries a consent
   capability (`ui.html`).

So the answer to "third parties can't build UI" is not the main thread. It is: *host-owned chrome,
extension-owned content*. The host renders the panel frame, the tab, the task-pane shell; the
content is either a declarative widget tree the worker serialized, or an opaque-origin iframe the
worker feeds over the existing bridge.

- **Security pillar:** ✓ **Unchanged.** Every new surface is broker-mediated, ceiling-checked at
  `broker.ts:162-168`, grant-checked at 171-177, and audited. No new ambient authority exists at any
  point.
- **Transparency pillar:** ✓ **Improved.** Every registration becomes an auditable, enumerable
  host-side record — a formula registered by an extension can be attributed in the function
  catalog, which is strictly better than the status quo where the only way to get a third-party
  formula into the grid is for the *user* to paste a body into Custom Functions and own it
  personally.
- **Effort:** **L overall, but strictly incremental** — each surface is an independent slice, and
  the first slice is S–M. No architectural change; the protocol grows two message variants per
  surface.
- **Unlocks, by slice:** function libraries (the `.xlam` class) → dashboards/panels → keyboard-driven
  automation → structural macros → custom cell types and file formats.
- **Residual honestly stated:** three things stay genuinely out of reach and should be documented as
  permanent non-goals rather than pretended away: (a) **synchronous** grid hooks that must answer
  inside a paint or a recalc tick — the `cell.onRender` precedent handles this with a render cache
  (`app/src/api/scriptHost/renderCache.ts`), which is a *cache*, not synchrony, and imposes a
  one-frame lag; (b) arbitrary DOM manipulation of *host* chrome; (c) anything requiring a
  same-origin document.

### O4 — Status quo (fork the app)

Third parties who need real add-ins vendor the repo and rebuild. **Verdict:** this is what the
project currently ships, and it is incompatible with the vision statement. It also silently
converts every add-in into a supply-chain fork, which is worse for security than any option above.

### Comparison

| | O1 signed escalation | O2 developer mode | O3 richer worker API | O4 fork |
|---|---|---|---|---|
| Security pillar ("never full machine access") | ✗ violated | ⚠ contained, session-only | ✓ preserved | ✗ (fork = full access, unaudited) |
| Transparency pillar | ✗ audit hole | ✓ badged + logged | ✓ improved | ✗ none |
| Effort | S (deceptively) | S–M | L, incremental | 0 |
| Add-in class unlocked | all, at once | none (authoring only) | formulas → UI → automation, progressively | all, at the cost of a fork |
| Reversible if it goes wrong | ✗ (published bundles depend on it) | ✓ | ✓ | n/a |

---

## 4. First slice — worker-extension formula functions

Chosen because it serves the exact audience the review names ("a VBA convert who shipped `.xlam`
function libraries"), it is the smallest surface, and the end-to-end pattern already exists in
production for a different caller.

**The proof it works:** `app/src/api/customFunctions.ts:157-172` already registers formula UDFs
whose `implementation` is an async call into a sandboxed worker realm:

```ts
const cleanup = registerFunction({
  name: upper, ..., minArgs: arity, maxArgs: arity, volatile: d.volatile === true,
  implementation: (...args: unknown[]) =>
    callExposedMethod(LIB_OBJECT_TYPE, LIB_INSTANCE_ID, upper, ...args),
});
```

The slice below is the same thing with the worker-extension protocol as the transport instead of
the exposed-method registry.

### 4.1 Protocol (`app/src/api/scriptHost/extensionProtocol.ts`)

Add to `ExtRegistration` (currently 38-56):

```ts
| {
    kind: "formula";
    regId: number;
    handlerId: number;
    def: ExtFormulaDef;
  }
```

with a new data-only descriptor:

```ts
export interface ExtFormulaDef {
  name: string;            // uppercased host-side; must match /^[A-Z_][A-Z0-9_.]*$/
  description?: string;
  syntax?: string;
  category?: string;       // forced to the extension's display name host-side
  minArgs: number;
  maxArgs: number;         // -1 for variadic
  volatile?: boolean;
}
```

No function ever crosses; `handlerId` is the existing worker-local handler slot
(`extensionWorkerContext.ts:77-81`).

### 4.2 Worker context (`.../worker/extensionWorkerContext.ts`)

Replace the throwing getter at 376-378 with:

```ts
formulas: {
  registerFunction(def: ExtFormulaDef, impl: Handler): () => void {
    const handlerId = registerHandler(impl);
    const regId = nextRegId++;
    post({ t: "register", reg: { kind: "formula", regId, handlerId, def } });
    return () => { handlers.delete(handlerId); post({ t: "unregister", regId }); };
  },
},
```

### 4.3 Host (`.../extensionWorkerHost.ts`, in `setupRegistration`, 341-398)

```
case "formula":
  1. CEILING CHECK — refuse unless mw.handle.declaredCapabilities.has("formula.udf").
     Enforced HERE, at registration, not at call time: an extension that did not declare
     formula.udf must never have its functions appear in the catalog or IntelliSense.
     Log + toast the refusal; do not silently drop.
  2. VALIDATE the name against the identifier regex; reject dotted/spaced/empty names.
  3. COLLISION — refuse to shadow a built-in or an already-registered function. Resolution
     rule: first registration wins, later ones are refused with a named error. (Excel-compatible
     flat namespace is required — prefixing would break formula portability — so collisions must
     be a loud refusal, never a silent rename.)
  4. REGISTER via @api registerFunction with
       implementation: (...args) => invokeWorkerHandler(mw, reg.handlerId, args)
       category: mw.handle.scriptName   // attribution is host-supplied, never extension-supplied
  5. mw.regCleanups.set(reg.regId, cleanupFromRegisterFunction)
```

`invokeWorkerHandler` (400-410) already exists and already enforces a deadline
(`EXTENSION_HANDLER_TIMEOUT_MS = 5_000`, `extensionProtocol.ts:153`). A UDF that exceeds it rejects,
which the UDF path surfaces as a cell error — acceptable, and it should be documented as the
extension-UDF budget.

### 4.4 Manifest, consent, transparency

- The sidecar manifest must declare `"capabilities": ["formula.udf"]`. The existing trust gate
  applies unchanged: unsigned/invalid/`publisherChanged` ⇒ empty ceiling
  (`ExtensionManager.ts:644-652`) ⇒ step 1 above refuses ⇒ **an unsigned extension cannot register
  worksheet functions.** That is the right default and it costs nothing to implement.
- The existing first-use consent prompt already enumerates capabilities
  (`ExtensionManager.ts:866-873`); `formula.udf` will appear there. The prompt text should gain a
  concrete clause when `formula.udf` is present ("…may add worksheet functions that recalculate
  with your data").
- `app/src/api/scriptSurfaces.ts` and the code inventory must list extension-registered functions.
  The review already flags `scriptSurfaces.ts` as understating real reach (§6.2); this slice must
  not add a second omission. A completeness test asserting "every host-installed proxy registration
  kind appears in the surface taxonomy" belongs in this slice.

### 4.5 Known limitations inherited (not introduced) by this slice

The UDF path already has confirmed defects the review enumerates: paste/fill/multi-cell edits never
resolve UDFs (`#NAME?` until each cell is edited), asymmetric volatility, values-only arguments (no
`Range`), no spilled returns. Extension-registered functions inherit all of them. **Do not ship this
slice as "third-party formulas work" until roadmap item 17 lands** — shipping a headline capability
on top of a known `#NAME?`-on-paste bug is exactly the "answers wrong is worse than absent" failure
mode §3 of the review calls out.

### 4.6 Second slice (sketch only)

**Host-owned panel, extension-owned content.** `ui.panels.register(spec)` in the worker context
posts a `{ kind: "panel", regId, panelId, title, icon, placement }` registration; the host registers
a real panel through `@api/ui` whose body is `ExtensionPanelHost` — a trusted component that renders
either (a) a declarative widget tree the worker pushes (`ScriptDialogFormSpec` generalized to a
non-modal surface), or (b) an `srcdoc` iframe with `sandbox="allow-scripts"` and the
`CustomControlHost` bridge, gated on the `ui.html` capability. Chrome, title bar and the
"from extension *X*" attribution are host-drawn and not overridable — a sandboxed surface must never
be able to impersonate the app, the same rule `scriptDialogs.ts` already enforces for modals.

---

## 5. What I did not verify

- I did not run the app or load an extension. All claims are from source reading at the stated
  file:line positions on `main` @ `a9f9018c`.
- I did not verify that `registerFunction`'s async `implementation` return is handled identically
  when the promise *rejects* versus when it resolves to the `UDF_ERROR_KEY` sentinel
  (`formulaFunctions.ts:30`). The first slice must confirm this before relying on rejection to
  produce a cell error.
- I did not measure whether `EXTENSION_HANDLER_TIMEOUT_MS` (5 s) interacts badly with the UDF
  pre-fetch deadline — they are separate budgets and could produce a confusing double-timeout.
- I did not audit `workerHardening.ts` line by line; I take the extensibility review's 2026-07-01
  finding ("neuters fetch/XHR/WS/timers/DOM") as accurate but current.
- The claim that no third trust class can be constructed rests on reading every `trust:` literal in
  `ExtensionManager.ts`; I did not grep the whole repo for other `ExtensionTrust` producers.

---

## 6. Slice 1 as shipped (2026-08-01)

The decision in §1 held: **`mayActivateOnMainThread` is byte-for-byte unchanged**
(`extensionTrust.ts`) and `ExtensionTrust` is still exactly `"trusted" | "distributed"`. What
changed is that the sandbox became worth staying inside.

### 6.1 What a sandboxed extension can now contribute

All of it is DECLARATIVE — a descriptor crosses the structured-clone boundary and trusted host code
renders or registers it. No component, no markup, no closure, ever.

| Contribution | Worker API | Host installs it as | Notes |
|---|---|---|---|
| **Worksheet functions** | `ctx.formulas.registerFunction(name, {params, description, volatile}, impl)` | a real `registerFunction` UDF whose `implementation` RPCs back into the worker | needs `formula.udf` ⇒ effectively signature-gated |
| Commands | `ctx.commands.register(id, handler)` | `CommandRegistry` under `ext:<extId>:<id>`, never `scriptSafe` | pre-existing; now ceiling-gated |
| Menu items | `ctx.ui.menus.registerMenuItem(menuId, item)` | a real menu item whose action runs the extension's own command | pre-existing; now ceiling-gated |
| **Ribbon buttons** | `ctx.ui.ribbon.registerButton({id,label,group,icon,command,order})` | a host-drawn button in the **Add-ins** ribbon tab | `icon` is a TOKEN from `RibbonIcon`; unknown ⇒ generic glyph |
| **Keyboard shortcuts** | `ctx.keybindings.register({id,combo,command,label})` | a real `KeyBinding` with `category` = the extension's name | host owns the listener; no keystroke reaches the sandbox |
| **Cell styling** | `ctx.grid.cellStyles.register(id, batchHandler)` + `.invalidate()` | a `registerCellRenderCache` SWR cache | one-frame lag by construction; every override sanitized key-by-key |
| **File import** | `ctx.fileFormats.registerImporter(format, importer)` | a `registerFileFormat` with an importer only | host does the I/O; result rebuilt field-by-field |

The **Add-ins** ribbon tab is rendered by the trusted built-in
`app/extensions/ExtensionsManager/AddInsRibbonSection.tsx` — the "host-owned chrome,
extension-owned content" shape of §4.6, delivered a slice early because it costs nothing once the
descriptors exist. It registers itself only when at least one add-in has contributed a button.

### 6.2 What we added that the design did not have: the CONTRIBUTION CEILING

The doc gated formulas on the *capability* ceiling. Writing the code showed that is not enough, and
not the right shape for the other six kinds:

- a capability answers *"what of the world outside this document may it touch?"*. A ribbon button
  touches nothing outside the document, so gating it on a capability would be theatre;
- but the user still needs to know *"what will appear in my app, under what names?"* — and needs to
  know it **before** the code runs.

So the sidecar manifest gained `contributes: { formulas, commands, menuItems, ribbonButtons,
keybindings, cellStyles, fileFormats }`, each an explicit list of ids (no wildcards — a wildcard
makes pre-install disclosure meaningless). A registration outside it is refused. Because the sidecar
is read **without importing the bundle**, the consent prompt can now enumerate every worksheet
function an add-in will install while its code has never run:

```
It will add to Calcula:
  - worksheet functions: VATRATE, VATAMOUNT
  - commands: showRates
  ...
It adds worksheet functions: formulas in your sheets can call them, and its code
runs against your data every time those cells recalculate.
```

The two ceilings are gated differently, deliberately (`extensionTrust.ts`
`computeContributionCeiling`): capabilities are **zeroed** for an unsigned/invalid/publisher-changed
sidecar, contributions are **not**. A contribution declaration grants nothing — it can only narrow
what the code would otherwise register — and for an unsigned bundle the declaration and the code have
the same unverified author. Worksheet functions stay signature-gated anyway, via `formula.udf`.

Refusals are loud by construction: console + toast + a row in the Extensions panel + an audit-ring
entry (`ext.contribute.<kind>`, `ok:false`). "My function is missing" is always answerable.

### 6.3 A latent security defect this slice found and closed

`EXTENSION_BROKER_METHODS` shipped with the comment *"anything not here is rejected by the broker as
UnknownMethod"* — and **nothing read it**. The broker enforces the shared `ALLOWLIST`, which also
carries restricted-tier rows meant for object scripts (`base.log`, `base.expose`,
`sheet.setCellValue`, `events.subscribe`, …). The only thing keeping a sandboxed extension out of
them was `executeExtensionImpl`'s `default:` arm — fail-closed *by accident*, and the accident
evaporates the moment anyone adds a `case`. `handleBrokerCall` now consults the set explicitly,
before capability prompting, and `extensionProtocol.test.ts` asserts both the call and its ordering
from source. This is the third instance of the same bug class in this program (`base.unexpose`,
`cap.cube.*`), which is why the coverage tests derive their layers from the source text rather than
from a hand-maintained list.

### 6.3.1 What the ceiling does NOT bound (integration review, 2026-08-01)

The contribution ceiling pins the *identifier* a registration uses. It does not pin what that
registration renders, which shortcut it claims, or which file extension it answers for — and every
one of the following was reachable by an add-in whose declared ceiling looked entirely benign, with
no capability involved. All five are closed in `extensionWorkerHost.ts`; regression tests live in
`__tests__/extensionContributions.test.ts` under "IMPERSONATION + TAKEOVER".

| Gap | Why it was reachable | Rule now |
|---|---|---|
| Menu item renders as `"Save As…"` in the File menu | the ceiling pins `menuId/itemId`, never the label; every other surface carried host-drawn attribution and this one did not | label is suffixed with the authoritative extension name and stripped of control/bidi characters, so the suffix cannot be rewritten from inside |
| Add-in becomes the CSV importer | `findImporter` takes the highest `priority`, and `priority` came from the sandbox; the manifest declares only the format id, so consent could not warn | an extension already handled by another importer is refused BY NAME; add-in importers register at a fixed negative priority so a later-registering built-in still wins |
| Add-in claims `Ctrl+S` | `findConflicts` only logged; built-ins won by registration order, which is load-order luck, not policy — and consent shows the binding id, never the keys | a combination already bound (built-in, add-in or user) is a loud refusal |
| Refusal toasts as a message channel | refusals were loud by design and unbounded by omission; `register` is a message an add-in can post in a loop, each toast echoing its own string | bounded by `MAX_VISIBLE_REFUSALS`; the audit entry is never rate-limited, only the noise |
| `cellStyle` reads every visible cell | the handler is handed each cell's displayed value (that is the use case), while consent said only "adds cell styling" | disclosed as a reach sentence in consent (`CONTRIBUTION_REACH_NOTE`, so a later kind cannot ship a reach the prompt forgot) and in the transparency label. **Still ungated** — see the note in the review's §8 |

### 6.4 Deferred, with reasons (not "not yet")

- **Exporting a file format.** `ExportContext` carries live `getCell` / `getUsedRange` functions —
  whole-workbook read authority with no capability in the vocabulary to describe it. Importing ships;
  exporting waits for either a capability that names that reach or a data-only export contract.
- **Task panes / panels / custom cell editors.** These need a live React component. The path is
  §4.6's `ExtensionPanelHost` (declarative widget tree, or an opaque-origin `srcdoc` iframe behind
  `ui.html`); the ribbon work above is the same pattern and proves it out.
- **Synchronous grid hooks** (`editGuards`, `rangeGuards`, `cellClicks`, `cellTypes`, custom
  decorations that paint on the shared canvas). Permanent non-goals in this form, exactly as §3 O3
  states: they must answer inside a paint or an edit tick. `cellStyles` is the cached-not-synchronous
  answer for the styling subset.
- **Developer mode (O2).** Not built. Nothing in slice 1 depends on it.

### 6.5 The example

`docs/examples/addin-tax-tools/` is a complete, installable add-in (bundle + sidecar + README) that
registers two worksheet functions, a command, a menu item, a ribbon button, a shortcut and a cell
styler. `app/src/api/scriptHost/__tests__/exampleAddin.test.ts` imports that exact file the way the
sandbox does (inline ES module), activates it against the real worker-side context, and asserts that
everything it registers is declared and everything declared is registered — so the documented path
cannot rot into fiction.

### 6.6 What remained after slice 1

1. ~~**No signing tool.**~~ — **CLOSED (G0, 2026-08-01).** `core/calcula-sign` ships. See §7.
2. ~~**No install command.**~~ — **CLOSED (G0, 2026-08-01).** `install_extension` + the
   **Install add-in…** flow in the Extensions panel. See §7.
3. **`scriptSurfaces.ts` / `codeInventory.ts`** do not yet enumerate extension-registered
   contributions as code units. The data is exported from `extensionWorkerHost` as
   `listExtensionContributions()` and re-exported from the `@api` barrel; the Extensions panel
   renders it, the "Code in This File" inventory does not.
4. **A capability that names "reads the grid".** `cellStyle` is disclosed, not gated (see §6.3.1).
   The vocabulary has no id for document reads, so the honest options were "hand over values and say
   so" or "drop the feature"; the first was chosen because the same contributor still cannot write a
   cell (no `sheet.*` row is in `EXTENSION_BROKER_METHODS`) and cannot exfiltrate anything without a
   separately consented `net.fetch` / `storage` grant. Adding such a capability is a vocabulary
   decision, and this would be its first consumer.
5. **UDF residuals (§4.5) are inherited.** Roadmap item 17 landed, but extension UDFs share whatever
   remains of the paste/fill and values-only-arguments behaviour.

---

## 7. The on-ramp as shipped (G0, 2026-08-01)

Slice 1 made the sandbox capable. It also left the headline capability unreachable: `formula.udf` is
correctly zeroed for an unsigned sidecar, nothing in the repo produced `<base>.manifest.sig`, and
there was no install command. G0 closes both — and closes a third gap nobody had named: **the
signature did not cover the code.**

### 7.1 What signing now covers, exactly

| Artefact | Covered by the signature? |
|---|---|
| `<base>.manifest.json` — id, version, `capabilities`, `contributes`, `workerSupport` | **Yes.** The detached Ed25519 signature is over the raw manifest bytes as written to disk. |
| `<base>.js` (or `index.js`) — the bundle the worker imports | **Yes, transitively.** `calcula-sign` writes the bundle's SHA-256 into the manifest as `codeHash` *before* signing, and the host re-checks it on **every scan**, not only at install. |
| Anything else in the add-in folder (READMEs, assets, extra `.js` files) | **No — and nothing else is installed.** The installer copies exactly three files. The worker imports a single blob ES module and cannot resolve bare imports, so `<base>.js` / `index.js` is the entire executable surface. |

Before G0 the second row read **No**, and that mattered more than it sounds. An attacker with write
access to `%APPDATA%\com.calcula.app\extensions\` could swap the program file of an add-in the user
had already trusted, and the app would still report **Signed**, still honour the declared ceiling,
and still hand the swapped code `formula.udf` — a worksheet function running against the user's data
on every recalculation. The manifest signature authenticated a *description* of the add-in. It now
authenticates the add-in.

Residual risks, stated plainly:

- **A signature is identity, not behaviour.** It proves bytes came from the holder of a key and have
  not changed since. It says nothing about what the code does. That is why a good signature still
  only unlocks the *capability ceiling* — never the execution realm (§1), and never consent. A
  signed add-in is still refused main-thread access, still runs in the hardened worker realm, still
  asks the user before its first run, and still asks again the first time each capability is used.
- **TOFU is first-contact trust.** No CA, no revocation list, no expiry. A key that was malicious on
  first contact is pinned as such. What TOFU buys is *continuity*: after the first install, a
  substitution is loud.
- **An extension pin is MACHINE-GLOBAL, and that is a decision — do not "fix" it.** `.calp` package
  pins are keyed by `(registry, package)`, because keying by name alone let whoever made first
  contact with a name own it for the whole machine. The obvious symmetry — scope an extension pin by
  where it was installed FROM — is refused, for four reasons, and this paragraph exists so it is not
  re-litigated:
  1. **The only candidate scope is the attacker's own choice.** A bundle dropped in
     `%USERPROFILE%\Downloads` would get its own pristine scope and therefore a free `firstUse` on an
     id it does not own. That is precisely the squat Wave H closed by making the launch-time scan
     non-pinning; folder scoping would re-open it through a different door.
  2. **It cannot be recorded honestly.** `install_extension` COPIES the three files into
     `%APPDATA%\com.calcula.app\extensions`. The "scope" evaporates the moment the install
     completes, so the pin would be filed under a location that no longer means anything.
  3. **It breaks legitimate reinstalls.** The same add-in reinstalled from a USB stick, a network
     share or a newer download folder would read as a false first use, teaching users that the
     first-use question is noise.
  4. **There is no naming authority behind an extension id anyway.** A registry is a human trust
     decision with a stable identity; a folder is not. For an id namespace with no authority behind
     it, machine-global first-contact ownership IS the semantics — and the protection is that only a
     human at the installer may claim it.

  The key is built by `calp::signing::PinKey::extension(id)`, which takes no scope, and
  `installTrustChain.test.ts` fails if a scope-derived status ever appears in
  `EXTENSION_TRUST_STATUSES`.
- **A stolen private key is a full compromise of that publisher's identity** until every user
  refuses the publisher change. Rotation and theft are indistinguishable at the protocol level —
  both are "a different key" — which is why the accept-publisher-change step refuses to be a
  one-click affirmation (§7.4).
- **`codeHash` is optional in the format and enforced-when-present at scan.** A manifest signed by
  some other tool without one verifies, loads, and gets its ceiling — with the manifest-only coverage
  that implies. The install path refuses such an add-in outright, so anything installed through the
  supported on-ramp is covered; a hand-copied one may not be. Making the field mandatory at scan is
  a small, deliberate follow-up (§7.7).

### 7.2 The author's tool: `calcula-sign`

A small Rust binary in the workspace at `core/calcula-sign`. It owns **no crypto**: keys, signing and
verification are `calp::signing` — the same code path, the same key file and the same
`trusted-publishers.json` that `.calp` package publishing uses. One publisher identity, one trust
root.

```
cd core
cargo build --release -p calcula-sign
# -> core/target/release/calcula-sign.exe
```

```
calcula-sign key show   [--profile <dir>]
calcula-sign key init   [--profile <dir>]
calcula-sign sign   <target> [--profile <dir>]
calcula-sign verify <target>
```

`<target>` is the add-in **folder**, its `<name>.js`, or its `<name>.manifest.json` — all three
resolve to the same layout. `--profile` defaults to `%LOCALAPPDATA%\Calcula`, which is exactly the
directory the app uses, so the key you publish `.calp` packages with is the key you sign add-ins
with.

Typical first run:

```
$ calcula-sign key init
[OK] Publisher keypair created with the OS CSPRNG.
Profile      : C:\Users\you\AppData\Local\Calcula
Publisher    : you
Public key   : 6ce81e633e914d3534d729c887f0da49b3c7f9ce2f3afabce0869b205f1925c1

BACK UP 'C:\Users\you\AppData\Local\Calcula\publisher-key.json'.
Losing it means your next release signs with a DIFFERENT key, which every
existing user sees as a publisher CHANGE (their add-in's capabilities are
revoked until they explicitly accept the new key).

$ calcula-sign sign ./my-addin
[OK] Signed acme.tax-tools v1.0.0
  manifest : ...\my-addin\tax-tools.manifest.json
  bundle   : ...\my-addin\tax-tools.js
  signature: ...\my-addin\tax-tools.manifest.sig
  publisher: 6ce81e63...
  codeHash : d1f0658b...

$ calcula-sign verify ./my-addin
[OK] acme.tax-tools v1.0.0 verifies
```

What `sign` does, in order — the order is load-bearing:

1. Resolve the layout **by name**, never by probing the folder (`<base>.manifest.json` →
   `<base>.js`; `extension.manifest.json` → `index.js`). Which bytes a signature covers must not
   depend on what else happens to be lying around. `extension.js` is a reserved name and is refused.
2. Refuse a manifest that could never run: missing `id`, an `id` outside `[A-Za-z0-9._-]`, missing
   `version`, or `workerSupport` not `true`. Better a refusal at sign time than a silent no-op in
   the app.
3. Load the **existing** keypair. `sign` never creates one — minting an identity has to be the
   separate, explicit `key init`.
4. Compute the bundle's SHA-256; write `publisherKey` and `codeHash` into the manifest.
5. Rewrite the manifest canonically (pretty-printed, keys sorted, trailing newline), **re-read it
   from disk**, and sign those exact bytes. The signature can never be over anything but what ships.
6. Self-check the signature it just wrote before printing `[OK]`.

The private key is never printed, never accepted as an argument, and never copied into the add-in
folder. `key init` is idempotent and cannot rotate an existing key by accident.

> **Supersedes `docs/examples/sign-extension.mjs`.** That ad-hoc Node script (written for the
> `hello-world-sandboxed` example) produces a valid signature — `calcula-sign verify` accepts the
> one it made — but it does three things `calcula-sign` deliberately does not. It **mints a second
> trust root**: a fresh keypair unrelated to the publisher identity `.calp` uses, so an author ends
> up with two identities and users with two unrelated pins. It **writes the PRIVATE key into the
> add-in folder** as `publisher.key`, protected only by a `.gitignore` line — one `git add -f`, one
> "zip the folder and send it", and the signing key ships to everyone. And it does not write
> `codeHash`, so its signatures cover the manifest only. It should be deleted rather than
> maintained; `calcula-sign` is the supported path.

**Author's checklist.** Re-run `calcula-sign sign` after *any* change to the bundle or the manifest.
An edited bundle no longer matches `codeHash` and Calcula reports the add-in as tampered — which is
the point, and is also the most likely way to confuse yourself during development. `calcula-sign
verify` reproduces the app's check offline.

### 7.3 The manifest, complete

```json
{
  "id": "acme.tax-tools",
  "name": "Tax Tools",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "workerSupport": true,
  "publisherKey": "<64 hex chars - written by calcula-sign>",
  "codeHash": "<64 hex chars - written by calcula-sign>",
  "capabilities": ["formula.udf", "ui.dialog"],
  "contributes": {
    "formulas": ["VATRATE", "VATAMOUNT"],
    "commands": ["showRates"],
    "menuItems": ["formulas/showRates"],
    "ribbonButtons": ["showRates"],
    "keybindings": ["showRates"],
    "cellStyles": ["vat-country"],
    "fileFormats": []
  }
}
```

`publisherKey` and `codeHash` are tool-written; everything else is yours. Both ceilings behave
exactly as §6.2 describes, and the **source can never widen them**: `admitContribution`
(`extensionWorkerHost.ts`) checks every registration against `mw.contributes` and
`mw.handle.declaredCapabilities` — both built host-side from the authoritative manifest at mount —
and refuses anything outside them by name, loudly.

### 7.4 The user's path: Extensions ▸ **Install add-in…**

Backed by one Tauri command, `install_extension` (`app/src-tauri/src/extension_install.rs`), which
serves both the preview and the install; `confirm` is the only difference.

1. **The user picks a folder** in a native dialog. No path string is ever synthesized by extension or
   script code, and the backend only ever *reads* the source. The destination is always
   `app_data/extensions` and is never caller-supplied. The command is main-window-only and routes
   through the capability-gated backend channel, not the raw passthrough.
2. **Preview.** Rust reads the sidecar — *without importing the bundle* — verifies the signature,
   checks `codeHash`, looks up the TOFU pin, and returns: publisher key, trust status, whether the
   signature covers the code, declared capabilities (and whether they will be honoured), every
   declared contribution by name, and the exact files that will be written. **The preview pass copies
   nothing and pins nothing** — asserted by test, because a pin written before the user decided is
   precisely the failure this feature exists to fix.
3. **The dialog shows it**, with the reach spelled out for the two contribution kinds that hand an
   add-in workbook data with no capability behind them (worksheet functions; cell styling).
4. **Install** copies exactly three files and — only now — pins the publisher key.

Refusals, and why each is a refusal rather than a warning:

| Situation | Outcome |
|---|---|
| No sidecar manifest | **Refused.** Calcula will not install code it cannot describe to you before running it. |
| `workerSupport` not `true` | **Refused.** It could never run; installing it would only produce a blocked entry. |
| Signature does not verify | **Refused.** The bytes contradict the claim. There is no honest badge for that. |
| Signed, but `codeHash` missing | **Refused.** "Signed" would mean less than it sounds, and the fix is one `calcula-sign sign` away. |
| Signed, but `codeHash` mismatches | **Refused**, and the status collapses to `invalid`. A broken claim about the code is not a weaker kind of signed. |
| **Unsigned** | **Allowed.** A legitimate state: the capability ceiling is zeroed, so it cannot register worksheet functions or reach anything outside the document. The dialog says exactly that. |
| **Publisher changed** | **Allowed only after a second, differently-worded decision** — its own checkbox naming the old and the new key. Nothing ever re-pins silently. Mirrors the `.calp` rule. |

After install the add-in loads on the next launch, and the existing first-use consent gate still asks
before a single line of its code runs. **Installing is not consenting.**

Replacing a signed install with an unsigned build removes the stale `.sig`, so a signature can never
outlive the manifest it was made for.

**Uninstall** is unchanged (`uninstall_extension`): it deletes the bundle and both sidecars and
deliberately leaves the TOFU pin, so a later re-install from the same key still verifies — from
ANYWHERE, because an extension pin carries no source scope (§7.2).

### 7.5 End-to-end, as actually run

Against the real example in `docs/examples/addin-tax-tools/`:

- `calcula-sign key init` → keypair created with the OS CSPRNG.
- `calcula-sign sign <folder>` → `publisherKey` + `codeHash` stamped, manifest rewritten,
  `tax-tools.manifest.sig` written, self-check passed.
- `calcula-sign verify <folder>` → signature valid over 684 manifest bytes; bundle matches
  `codeHash`.
- Append one line to the signed bundle → `[FAIL] TAMPERED: ... does not match the codeHash inside
  the signed manifest.`
- Restore the bundle, change `"ui.dialog"` to `"net.fetch"` in the manifest → `[FAIL] ... the
  manifest signature for calcula.example.tax-tools@1.0.0 is invalid`.
- `documented_example_addin_signs_installs_and_scans_verified`
  (`app/src-tauri/src/extension_install.rs`) drives the whole chain against those same repo files:
  sign → preview (`firstUse`, code covered, `formula.udf` honoured, `VATRATE`/`VATAMOUNT` disclosed,
  nothing pinned) → install (pinned) → the real `verify_extension_manifest` that the shell's disk
  scan calls returns `verified` with the declared capabilities intact.
- `scan_reports_invalid_when_installed_code_is_swapped_after_trust` swaps the *installed* bundle and
  asserts the next scan returns `invalid`; restoring the signed bytes restores trust.

**Not run:** the last mile inside the live application — launching Calcula, clicking *Install
add-in…*, reloading, allowing the consent prompt, and typing `=VATRATE("SE")` into a cell. The
registration half of that step is covered by Wave F's `extensionContributions.test.ts` ("a sandboxed
extension registers a worksheet function that evaluates through the worker"), which asserts the
function reaches the worksheet-function registry with host-supplied attribution and that its
`implementation` resolves the value a cell would receive. Everything between the signature and that
registration is covered above. The unexecuted step is the UI walk itself.

**The example in the repo is deliberately left unsigned.** Signing it would commit a signature bound
to one machine's key, which nobody else can reproduce and which breaks the moment the example is
edited. Its README points at `calcula-sign` instead.

### 7.6 Where the pieces live

| Piece | Path |
|---|---|
| Keys, sign/verify, TOFU store, add-in layout, `codeHash` helpers | `core/calp/src/signing.rs` |
| Author CLI | `core/calcula-sign/src/main.rs` |
| Preview / install / pin, and the scan-time code-hash check | `app/src-tauri/src/extension_install.rs` |
| Scan-time verification (calls the above) | `app/src-tauri/src/lib.rs` `verify_extension_manifest` |
| Install dialog + capability-gated backend channel | `app/extensions/ExtensionsManager/` |
| Trust-chain regression tests | `app/extensions/ExtensionsManager/__tests__/installTrustChain.test.ts` |

### 7.7 Still open after G0

1. ~~**`codeHash` is not yet mandatory at scan.**~~ — **CLOSED by the Wave G integration pass
   (2026-08-01).** It is mandatory. A signature that verifies but declares no `codeHash` (or whose
   bundle cannot be read) is reported as the new status **`codeUnverified`**, which is outside
   `trust_grants_capabilities` — so capabilities are refused, the install is refused, and the
   publisher key is **not pinned**. The four `ext_manifest_tests` fixtures were given real bundles
   and hashes so they exercise the states they are named for.

   The same pass closed a second, sharper hole that was not on this list: **the trust decision was
   fail-open when the TOFU pin store could not be read.** `verify_extension_manifest` returned
   `"verified"` outright on a parse error, and `inspect` treated it as "no pin" (`firstUse`). An
   attacker who can write the user's profile directory — the same attacker the `codeHash` work
   already assumes can write `%APPDATA%/…/extensions` — could corrupt one JSON file and have a
   publisher-key substitution report as trusted. There is now a single shared
   `decide_extension_trust()` that both the scan and the installer call, and an unreadable store is
   **`trustUnavailable`**: not trusted, not installable, not pinned.
2. **Scan-time TOFU still pins silently** for a bundle that never went through `install_extension`
   (`verify_extension_manifest` pins on first sight). Nothing is *granted* by the pin — consent is
   still asked separately — but a bundle dropped into `%APPDATA%` by hand can squat the pin for an id
   it does not own, so the genuine publisher later reads as `publisherChanged`. Now that a real
   install path exists, the fix is to stop pinning during the scan and treat an unpinned-but-valid
   signature as needing the install decision.
3. **No audit entry for an install.** The workbook audit log is workbook-scoped while an add-in
   install is machine-scoped, so the right home is a new store rather than `calp::audit`. The install
   report and the Extensions panel are the current transparency surfaces.
4. **Archives are not an install source.** Folder or bundle file only. Supporting `.zip` means a new
   dependency in the app crate and a zip-slip surface, for a format an add-in does not need.
5. **No update check.** Re-running the installer over a newer copy is the update path; there is no
   feed and no notification, only a report of what is currently installed.
