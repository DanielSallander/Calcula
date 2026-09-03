# TypeScript Forms — release one (modal forms)

**Status: SHIPPED 2026-09-02** (slices S1–S5 of the approved plan). Verified against the code on
**2026-09-03**; every mechanism below cites the file and line that was opened and read. Where the
code differs from the plan (`~/.claude/plans/it-occured-to-me-wiggly-pixel.md`), the code is what is
documented here and the difference is listed in §13. What was NOT built is in §13 and in
`docs/design/open-items.md` §2.ab.

## 1. Purpose and owner decisions

Calcula had no equivalent of a VBA `UserForm`. A script could ask one question at a time through
`caps.dialog.*` (a flat five-field spec painted by trusted code, `app/src/api/scriptHost/scriptDialogSpec.ts`),
and nothing else. The VBA review named custom UI surfaces as the one unfinished frontier
(`docs/design/scripting-vba-review.md` §9).

Owner decisions taken 2026-09-02, all reflected in the code:

1. **Host-painted widget tree first.** The script supplies DATA — a tree of plain objects — and
   trusted host code paints it in the app skin (`scriptFormSpec.ts:11-21`,
   `ScriptFormDialog.tsx:2-16`). Isolated HTML/CSS "apps" are a later milestone (§14, M6).
2. **Code-first authoring.** The layout is an object literal inside the script, in a
   `#region Form layout (designer-owned …)` block the scaffold emits
   (`app/src/api/scriptableObjectScaffolds.ts:662-679`). A drag-and-drop designer is M5.
3. **Modal only.** One form on screen, sharing the modal slot with `ui.dialog`
   (`scriptDialogs.ts:99-118`). Modeless windows and task panes are M2; on-grid embedding is M3.
4. **Workbook object scripts only.** A form is an ordinary object script (`objectType: "form"`),
   saved in `.cala`, carried by `.calp`, forced restricted and unmounted until consent like every
   distributed script (`core/calp/src/pull.rs:769-784`). A third-party add-in `form` contribution
   kind is M4.

## 2. Architecture

```
worker realm (one hardened Web Worker per script)        trusted host (main window)
------------------------------------------------         --------------------------------------------------------
FormContext shim   contextShims.ts:3527-3624              ALLOWLIST rows        allowlist.ts:1052-1073
                                                          executeImpl cases     host.ts:5271-5334
  define(spec) --callFire "form.define"----------------->  defineScriptForm     scriptForms.ts:170
  show()       --call "form.show"----------------------->  resolveFormBindings  host.ts:12158  (reads = brokerCall)
                                                           showScriptForm       scriptForms.ts:273
                                                             claimModalSlot     scriptDialogs.ts:137
                                                             SCRIPT_FORM_REQUEST_EVENT ---> ScriptableObjects/index.ts:634
                                                                                            ScriptFormDialog.tsx (renderer)
               <-- callResult { showId } -----------------  handleInput "shown" scriptForms.ts:502  <-- INPUT "shown" (:232)
  (awaits __form_closed)                                   ... INPUT change / click / submit / cancel / interaction
  onShow/onChange/onClick/onClose  <--{t:"event"}--------  deps.forward        host.ts:12039
  onSubmit  <--methodCall "__form_onSubmit"--------------  raceFormSubmitVerdict host.ts:12389 (3 s, default accept)
                                                           writeFormBindings   host.ts:12239 (one undo batch)
  rt.exposed "__form_closed"  <--methodCall--------------  relayFormClosed     host.ts:12015
  form.values / form.isOpen   <--{t:"mirror"}------------  deps.mirror         host.ts:12040
```

Three modules own the host half, and the split is deliberate:

- `app/src/api/scriptHost/scriptFormSpec.ts` — the declarative shape, the limits, and the four
  app events. A leaf: it imports only `scriptDialogSpec.ts` (`:1-9`, `:23-32`).
- `app/src/api/scriptHost/scriptForms.ts` — layouts, sessions, deadlines, rate buckets, and the
  renderer exchange. It never imports `host.ts`; host reach arrives as `FormSessionDeps`
  callbacks (`:88-112`).
- `app/src/api/scriptHost/host.ts` — the binding pipeline and the worker relays, because they
  need module-private `executeImpl` (`:3252`), `withScriptUndoBatch` (`:7591`),
  `isOwnScriptWrite` (`:247`) and the mounted-worker table.
- `app/src/api/scriptHost/scriptFormBindings.ts` — the PURE half of binding: parsing `bind`,
  cell → seed, widget → cell write, dirtiness (`:1-15`).

The renderer is `app/extensions/ScriptableObjects/components/scriptForm/` (§10), wired in
`app/extensions/ScriptableObjects/index.ts:603-695`.

## 3. The object type and persistence

`"form"` is a member of `ScriptableObjectType` (`app/src/api/scriptableObjects.ts:59`, listed
in `SCRIPTABLE_OBJECT_TYPES` at `:89`; Rust `core/persistence/src/lib.rs:1661-1665`). It is an
object script with a **minted UUID `instanceId`** and no backing workbook object:
`createFormScript` (`app/extensions/ScriptableObjects/lib/createForm.ts:38-51`) is the one place a
form is minted — `id: crypto.randomUUID()`, `instanceId: crypto.randomUUID()`, `accessLevel:
"restricted"`, source from `getScaffoldTemplate("form", name)` — and both Insert > Form
(`ScriptableObjects/index.ts:876-895`) and the manager pane's "+ Form"
(`ObjectScriptManagerPane.tsx:144-157`, `:300-301`) call it. Names auto-number `Form1`, `Form2`, …
case-insensitively (`createForm.ts:21-28`) because other scripts address a form by NAME (§9).
An AI-drafted form gets its instanceId minted in `draftToScriptDefinition`
(`ScriptableObjects/lib/scriptDrafts.ts:105`).

**No new store, no manifest feature id, no format version.** A form is persisted exactly as every
object script is (the `object_scripts` feature; `CALA_MAX_SUPPORTED_FORMAT_VERSION` is untouched at
`core/calcula-format/src/manifest.rs:57`). An older reader that does not know the variant fails to
deserialize that one script — a visible loss, not a misreading — which is the test the `.cala`
versioning rule sets.

The Rust variant sites, all exhaustive matches that cargo enforces:

| site | line |
|---|---|
| `ScriptableObjectType::Form` | `core/persistence/src/lib.rs:1661-1665` |
| `ObjectScriptObjectTypeDef::Form` + both `From` arms | `core/calcula-format/src/features/object_scripts.rs:58`, `:112`, `:136` (round-trip test `:224-228`) |
| `object_type_to_string` / `string_to_object_type` | `app/src-tauri/src/scripting/object_script_commands.rs:99`, `:121` |
| `VALID_OBJECT_TYPES` (MCP drafts; order pinned by `chatToolSurface.test.ts:263`) | `app/src-tauri/src/mcp/drafts.rs:110` |

Distribution: publish lifts the ceiling from the `// @capability ui.dialog` pragma like any script;
pull forces `Restricted` + `Distributed` + the manifest ceiling (`core/calp/src/pull.rs:769-784`),
and an unconsented form is not mounted, so it cannot be shown by anyone (§9). The Subscribe dialog
and the package inspector list it as an object script with its raw `objectType` and full emitted
source (`SubscribeDialog.tsx:607`; `inspector/ScriptsSection.tsx:96-107`, `:173`). No rendered
layout view exists in the inspector — open item.

Forms are deliberately **not** enumerable through `api.listObjects`
(`app/src/api/scriptHost/objectInventory.ts` has no `form` kind).

## 4. The script-facing API

The declarations below are quoted from `app/scripts/scriptTypings/objectContexts.template.d.ts`
(the prose source of the generated `objectContexts.d.ts`; lockstep pinned by
`extensions/ScriptableObjects/__tests__/objectContextsTypings.test.ts`).

```ts
// objectContexts.template.d.ts:5389-5415
declare type FormValue = string | number | boolean | null;
declare interface FormOption { value: string; label?: string; }
declare type FormOptions = Array<string | FormOption> | { range: string };
declare type FormBinding =
  | string
  | { cell: string; sheet?: string | number }
  | { name: string }
  | { control: string };

// :5417-5435
declare interface FormWidgetBase {
  name?: string; label?: string; help?: string; hidden?: boolean; disabled?: boolean;
  width?: number | "fill";
}
declare interface FormInputBase extends FormWidgetBase {
  name: string; bind?: FormBinding; required?: boolean; writeOn?: "submit" | "change";
}

// :5445-5464
declare type FormWidget =
  | ({ type: "label"; text: string; style?: "normal" | "heading" | "muted" } & FormWidgetBase)
  | ({ type: "textbox"; default?: string; placeholder?: string; multiline?: boolean; maxLength?: number } & FormInputBase)
  | ({ type: "number"; default?: number; min?: number; max?: number; step?: number } & FormInputBase)
  | ({ type: "date"; default?: string; min?: string; max?: string } & FormInputBase)
  | ({ type: "checkbox"; default?: boolean } & FormInputBase)
  | ({ type: "toggle"; default?: boolean } & FormInputBase)
  | ({ type: "radio"; options: FormOptions; default?: string; layout?: "row" | "column" } & FormInputBase)
  | ({ type: "dropdown"; options: FormOptions; default?: string; allowEmpty?: boolean } & FormInputBase)
  | ({ type: "listbox"; options: FormOptions; multi?: boolean; default?: string | string[]; rows?: number } & FormInputBase)
  | ({ type: "button"; name: string; text: string; role?: "default" | "submit" | "cancel"; danger?: boolean } & FormWidgetBase)
  | ({ type: "group"; title?: string; children: FormWidget[] } & FormWidgetBase)
  | ({ type: "tabs"; pages: Array<{ title: string; children: FormWidget[] }> } & FormWidgetBase)
  | ({ type: "row"; children: FormWidget[]; gap?: number } & FormWidgetBase)
  | ({ type: "column"; children: FormWidget[]; gap?: number } & FormWidgetBase)
  | ({ type: "grid"; columns: number; children: FormWidget[] } & FormWidgetBase)
  | ({ type: "spacer"; size?: number } & FormWidgetBase)
  | ({ type: "image"; src: string; alt?: string; height?: number } & FormWidgetBase)
  | ({ type: "table"; columns: string[]; rows: FormValue[][] | { range: string }; maxRows?: number } & FormWidgetBase)
  | ({ type: "progress"; name: string; value: number; max?: number; text?: string } & FormWidgetBase);

// :5467-5483
declare interface FormSpec {
  title?: string; description?: string; submitLabel?: string; cancelLabel?: string;
  width?: number; writeOn?: "submit" | "change"; submitOnEnter?: boolean; focus?: string;
  children: FormWidget[];
}

// :5486-5507
declare interface FormPatch {
  values?: Record<string, FormValue | string[]>;
  controls?: Record<string, { disabled?: boolean; hidden?: boolean; label?: string; text?: string;
    options?: FormOptions; error?: string | null; value?: number; max?: number }>;
  focus?: string;
  message?: { text: string; kind?: "info" | "warning" | "error" } | null;
}

// :5514-5535
declare type FormSubmitVerdict =
  | void | undefined | false | "cancel"
  | { cancel: true; errors?: Record<string, string>; message?: string };
declare interface FormChangeDetail {
  name: string; value: FormValue | string[]; values: Record<string, FormValue | string[]>;
  source: "user" | "cell";
}
declare interface FormClickDetail { name: string; values: Record<string, FormValue | string[]>; }
declare interface FormCloseDetail {
  reason: "submit" | "cancel" | "script" | "deadline" | "unmount";
  values: Record<string, FormValue | string[]>;
}

// :5540-5549  (context.caps.forms — on EVERY script)
declare interface ScriptFormsApi {
  show(name: string, options?: { initial?: Record<string, FormValue | string[]> }): Promise<Record<string, unknown> | null>;
}

// :5556-5571
declare interface FormControlHandle {
  readonly value: unknown;
  set(value: unknown): void;
  setText(text: string): void;
  enable(enabled: boolean): void;
  show(visible: boolean): void;
  setOptions(options: FormOptions): void;
  setError(message: string | null): void;
  focus(): void;
  onChange(handler: (detail: FormChangeDetail) => void): () => void;
  onClick(handler: (detail: FormClickDetail) => void): () => void;
}

// :5580-5624
declare interface FormContext extends BaseObjectContext {
  readonly instanceId: string;
  define(spec: FormSpec): void;
  show(options?: { initial?: Record<string, FormValue | string[]> }): Promise<Record<string, unknown> | null>;
  close(result?: Record<string, FormValue | string[]> | null): void;
  update(patch: FormPatch): void;
  control(name: string): FormControlHandle;
  readonly values: Record<string, unknown>;
  readonly isOpen: boolean;
  onShow(handler: (detail: { values: Record<string, FormValue | string[]> }) => void): () => void;
  onChange(handler: (detail: FormChangeDetail) => void): () => void;
  onClick(handler: (detail: FormClickDetail) => void): () => void;
  onSubmit(handler: (detail: { values: Record<string, FormValue | string[]> }) => FormSubmitVerdict | Promise<FormSubmitVerdict>): () => void;
  onClose(handler: (detail: FormCloseDetail) => void): () => void;
}
```

`{ type: "html" }` is not in the vocabulary (`scriptFormSpec.ts:83-105`) and the validator refuses
it by name (`validators.ts:4202`); it is reserved for M6.

How the shim implements this (`app/src/api/scriptHost/worker/contextShims.ts:3527-3624`):
`define` / `update` / `close` are fire-and-forget `callFire`s (`:3564`, `:3569`, `:3575`);
`show` is `awaitFormAnswer(rt, await call(rt, "form.show", [options]))` (`:3572`); `values` and
`isOpen` read host-pushed mirrors `form.values` / `form.isOpen` (`:3537-3538`, `:3609-3614`);
`control(name)` setters are sugar over `form.update` (`:3578-3608`); per-widget `onChange` /
`onClick` handlers are dispatched from ONE registered hook per kind, so one `hookRegistered`
crosses per hook name, never per widget (`:3539-3563`); `onSubmit` is a REPLYING hook registered
under the relay name `__form_onSubmit` (`:3621-3622`, `registerReplyingHook` at `:636-662`).
`caps.forms.show(name)` is `awaitFormAnswer(rt, await call(rt, "cap.formsShow", [name, options]))`
(`:1430-1432`).

The scaffold (`scriptableObjectScaffolds.ts:647-711`) is the worked example: a bound order-entry
form, an `onChange` that recomputes a label through `form.control("total").setText`, an `onSubmit`
that blocks one combination, and a top-level `run()` that awaits `context.show()`. The AI path
prefers `onSubmit` for this type (`scriptTemplate.ts:49`) and has one canary task,
`cap-form-customer-quantity` (`tests/eval/tasks.json:492-517`).

## 5. Wire rows and consent text

The five ALLOWLIST rows (`app/src/api/scriptHost/allowlist.ts:1052-1073`):

| row | tier | capability | class | validator | limits | desc (the consent / transparency sentence) |
|---|---|---|---|---|---|---|
| `form.define` (`:1052-1055`) | restricted | — | emit | `vFormDefine` | maxNodes 200, maxDepth 8, maxInputs 64 | "Describe the layout of its own form (labels, inputs, choices, buttons) so Calcula can draw it — nothing is shown until it asks to show it" |
| `form.show` (`:1056-1058`) | restricted | `ui.dialog` | ui | `vFormShow` | — | "Open its form as a dialog you must answer or close before continuing, and read what you entered; a field it bound to a cell shows that cell and writes it back when you submit (on the sheet you were looking at when it opened, for a restricted script)" |
| `form.update` (`:1059-1061`) | restricted | `ui.dialog` | emit | `vFormUpdate` | perSecond 30 | "Change what its open form shows (values, enabled or hidden fields, choices, a message)" |
| `form.close` (`:1062-1064`) | restricted | `ui.dialog` | emit | `vFormClose` | — | "Close its own form from code and decide what answer it reports" |
| `cap.formsShow` (`:1071-1073`) | restricted | `ui.dialog` | ui | `vFormsShowNamed` | — | "Open another script's form in this workbook as a dialog, on that script's behalf, and read your answer" |

All four capability-bearing rows are classified in `BROKER_AUDITED_CAPABILITY_METHODS`
(`broker.ts:304-307`) with the reason "host-window form; no script-driven backend call" — the one
backend call a show can make, the image resolve, is host-driven (§8).

**Why reusing `ui.dialog` is honest for a modal.** The four sentences a person actually reads for
`ui.dialog` are unchanged and pinned (`formConsentHonesty.test.ts:91-107`):
`capabilities.ts:433` "show you a dialog and receive what you enter";
`Distribution/components/SubscribeDialog.tsx:63` and `inspector/ScriptsSection.tsx:46` "interrupt you
with a dialog and read your answer"; `ScriptableObjects/index.ts:176` "Interrupt you with a dialog
box and read what you answer". A host-painted modal that collects keystrokes is exactly that reach.
The **cell** reach of a bound widget is NOT carried by `ui.dialog`: bindings are executed as the
script's own `sheet.*` / `api.*` calls (§8), which are tier-governed and capability-free, and the
consent screen for a restricted script already says it reads and writes "the cells of the sheet
currently shown" (`extensions/ScriptableObjects/__tests__/consentTextHonesty.test.ts:79`). The
`form.show` desc names the binding reach anyway (`formConsentHonesty.test.ts:75`). This reasoning is
what makes a **modeless** surface a different capability later (§14, M2): "a dialog you must answer
or close before continuing" would be false for it.

`form.define` carries no capability so that the preview harness — whose handle has an empty
ceiling and empty grants (`broker.ts:189-195`) — admits it and can capture the layout (§11).

## 6. The show() resolution model and the two clocks

`form.show` / `cap.formsShow` are `class: "ui"` rows and sit on the person-length deadline
(`protocol.ts:386`, `:392`, `UI_DIALOG_DEADLINE_MS = 300_000` at `:359`). But they do **not** await
the answer. The broker call resolves `{ showId }` the moment the renderer acknowledges the form is
on screen (`scriptForms.ts:502-517`, "shown"); the host itself gives the renderer
`FORM_SHOWN_ACK_TIMEOUT_MS = 10_000` to do so (`:73`, `:381-383`), after which the session ends as
"cancel" and the awaiting `show()` rejects with `HostError` "the form did not open (no renderer
acknowledged it)" (`:228-234`). This keeps `scriptDialogs.test.ts:270-277` additive and means no
worker-side RPC ever stays pending for a data-entry session.

The answer arrives later: `deps.closed(showId, result)` (`scriptForms.ts:238`) becomes
`relayMethodCall(mw, "__form_closed", [{ showId, result }])` (`host.ts:12015-12024`), and the
worker-local `rt.exposed` entry `__form_closed` — installed on EVERY realm at context build through
`rt.exposed` directly, never through `context.expose`, so it is not script-callable and not a
debugger trigger (`contextShims.ts:773-801`) — resolves the promise the script is awaiting
(`awaitFormAnswer`, `:809-816`). A muted script's show answers `{ showId, closed: true }` and the
shim resolves `null` at once (`scriptForms.ts:304-309`, `contextShims.ts:812`).

**Clock 1, worker → host** (`callDeadlineMs`, `protocol.ts:413-415`): bounds only the show itself.

**Clock 2, host → worker** (`relayMethodCall`, `METHOD_CALL_TIMEOUT_MS = CALL_TIMEOUT_MS = 30_000`,
`protocol.ts:347`, `:424`; armed at `host.ts:12736-12740`): this is the clock that carries a
`run()`, a button handler, a scheduled job or a shortcut that AWAITS the form, because those are
relayed method calls. While a script has a form open the host holds that clock: on "shown"
`deps.suspendDeadlines()` → `holdFormDeadlines(mw)` increments `mw.formHolds` and calls
`suspendMethodCallDeadlines` (`host.ts:12003-12006`, field at `:627-634`); on close
`releaseFormDeadlines` decrements and re-arms only when the count reaches zero and the script is
not paused in the debugger (`:12007-12012`). `resumeMethodCallDeadlines` refuses to re-arm while
`formHolds > 0` (`:12778`), so the debugger resuming cannot restart the clock under an open form —
pinned by `formUnmountSweep.test.ts:67`. For a cross-script show both the owner's and the caller's
clocks are held (`:12057-12064`).

## 7. Guards, deadlines and limits

**Modal slot, shared with dialogs** (`scriptDialogs.ts:99-173`). `showScriptForm` claims it with
`kind: "scriptForm"` (`scriptForms.ts:312-316`; `"form"` was already the `cap.dialogForm` kind,
`scriptDialogs.ts:49`, `ModalKind` at `:111`). Guard 1: one modal per script — "this script already
has a dialog open" (`:144-149`). Guard 2: one app-wide, rejected not queued — "another script (…) is
showing a dialog" (`:150-156`). Guard 3: every non-submit close is a refusal for the dismissal
streak (`scriptForms.ts:224-226`), and `MAX_CONSECUTIVE_DISMISSALS = 3` mutes the script for
dialogs and forms alike (`scriptDialogs.ts:90`, `:198-206`); a submit resets the streak.

**Registry-owned bounds** (`scriptForms.ts`):

| constant | value | where |
|---|---|---|
| `FORM_IDLE_DEADLINE_MS` | 30 min, re-armed by any renderer `interaction` / `change` / `click` / `submit` | `:69`, `:203-206`, `:519-523` |
| `FORM_MAX_OPEN_MS` | 8 h absolute | `:71`, `:510` |
| `FORM_SHOWN_ACK_TIMEOUT_MS` | 10 s for the renderer to ack | `:73`, `:381-383` |
| `FORM_TEXT_CHANGE_DEBOUNCE_MS` | 150 ms host-side debounce for textbox / number / date `onChange` | `:75`, `:496-498`, `:550-553` |
| `FORM_SHOWS_PER_MINUTE` | 20 show attempts per script per minute, refused with a HostError beyond it | `scriptFormSpec.ts:81`, `scriptForms.ts:241-251`, `:295-302` |
| `FORM_UPDATE_PER_SECOND` | 30 `form.update` per second per open form (token bucket); excess dropped, one console warning per session | `scriptFormSpec.ts:79`, `scriptForms.ts:253-263`, `:393-401` |

Both deadlines close as dismissed (`null`) with `onClose { reason: "deadline" }`, never as an
error (`:205`, `:510`). `endSession` is idempotent — cancel, script close, deadline, unmount and
reset all land there and only the first settles anything (`:213-239`). The renderer throttles
`interaction` to one per second on its side (`ScriptFormDialog.tsx:69`, `:262-268`).

**Validator limits** (`scriptFormSpec.ts:52-81`; enforced in `validators.ts`): `MAX_FORM_NODES`
200 (containers count), `MAX_FORM_DEPTH` 8, `MAX_FORM_INPUTS` 64, `MAX_FORM_OPTIONS` 500,
`MAX_FORM_TABLE_CELLS` 5,000, `MAX_FORM_TABS` 12, `MAX_FORM_GRID_COLUMNS` 6, width
320..1200, `MAX_FORM_BIND_CHARS` 64, `MAX_FORM_INITIAL_KEYS` 64, `MAX_FORM_VALUE_CHARS` 32,767,
`MAX_FORM_PATCH_CONTROLS` 64, `MAX_FORM_ERROR_CHARS` 200. `vFormDefine` (`validators.ts:4364-4439`)
walks the tree with an explicit stack — a children array is counted before it is pushed, so a
hostile 10,000-deep chain returns a message rather than overflowing (`:4398-4415`). Per widget
(`checkFormWidget`, `:4198-4245`): `type "html"` refused by name (`:4202`), known keys per type
(`:4207`), names must be identifiers, not reserved, and unique across the whole tree
(`:4210-4217`), text bounded by the dialog caps, `bind` shape-checked, no regex `pattern` key exists
anywhere. `vFormShow` / `vFormsShowNamed` (`:4442-4449`, `:4524-4529`) admit only `{ initial }`
with ≤ 64 identifier keys; `vFormUpdate` (`:4454-4511`) bounds `controls` to 64 entries with known
keys and errors to 200 chars; `vFormClose` (`:4514-4517`) takes a name → value map or nothing.

## 8. The binding pipeline

Everything below runs under the FORM script's own handle: every read and write is
`brokerCall(handle, method, args, () => executeImpl(mw, method, args))` on the very row the script
would call by hand, so the tier clamp, the writeback draft gate and the audit row are structural,
not re-implemented (`host.ts:12136-12139`, `:12123`, `:12145`, `:12270`).

1. **RESOLVE at show** (`resolveFormBindings`, `host.ts:12158-12226`), before anything is painted
   (`:5278-5284`). `collectFormBindings` lists every INPUT widget with a `bind`, in tree order, with
   its effective `writeOn` (widget's, else the form's, else `"submit"`; `scriptFormBindings.ts:43-62`).
   `parseFormBinding` (`:148-178`) tries a bare string as a single-cell A1 address (`B2`,
   `Sheet1!B2`, `'My sheet'!B2`), else as a defined name; a rectangle is refused because an input
   binds ONE cell. `{ cell, sheet }` resolves the sheet through `resolveSheetRefIn`
   (`host.ts:12185-12192`); `{ name }` goes through `lib.resolveNamedRangeCoords` and must name one
   cell (`:12195-12210`); `{ control }` reads `getControlValue` and is read-only
   (`:12176-12181`, `scriptFormBindings.ts:241-249`; `app/src/api/controlValues.ts` exposes getters
   only). A binding that fails at any step becomes a seed `{ readOnly: true, reason }` and the widget
   renders DISABLED with that reason — the form still shows (`:12173`, `:12189`, `:12199`,
   `:12203-12208`).
2. **READ.** `readFormCell` (`:12141-12150`) calls `sheet.getCellData` (restricted) or
   `api.getCellData` (unlocked) with an EXPLICIT sheet index, so a restricted binding naming another
   sheet — or a name resolving to one — is refused by `clampSheetIndex` on that row
   (`:5015-5021`) and the refusal is both audited and shown as the widget's reason. The typed
   `{ value, display, formula }` becomes the seed through `seedFromCell`
   (`scriptFormBindings.ts:211-238`): a number widget gets the NUMBER (never the display text), a
   date widget gets the ISO string from the serial, a formula is kept on the seed so the widget is
   shown but never rewritten unless edited. Sources — `options: { range }`, table `rows: { range }` —
   are read through `sheet.getRangeValues` / `api.getRangeValues` under the same handle
   (`:12117-12125`); an `image.src` is resolved ONCE per show from its `media:` handle through
   `resolveMediaRef` (an IPC; `:12107-12115`) and never per paint.
3. **PIN (restricted tier).** If any cell binding survived, `pinnedSheet` is the sheet active at
   show and the band shows its name (`:12221-12224`, `ScriptFormDialog.tsx:529`).
4. **WRITE** (`writeFormBindings`, `host.ts:12239-12284`). On Submit the registry first flushes any
   debounced text change, asks `onSubmit` (§8a), and only on acceptance calls `writeBindings` BEFORE
   closing, so a refused write keeps the user's entries on screen with the reason
   (`scriptForms.ts:588-632`). At restricted tier the active sheet must still equal the pinned one
   or the whole submit is refused with `switch back to "<sheet>" to save this form` and the form stays
   open (`host.ts:12249-12257`) — because the restricted write row passes NO sheet argument
   (`:12269`) and the executor writes whatever sheet is active at call time (`:5130-5132`), a
   silent wrong-cell write is otherwise possible. Only DIRTY widgets are written on Submit
   (`dirtyNames`, `scriptFormBindings.ts:297-303`; `isDirty` treats `""`/`null` as equal and a
   number against its own text as equal, `:278-294`); dirtiness is judged against what the CELL held
   at show, not against `initial`. Each write is `cellWriteFor` (`:262-275`): the typed number or
   boolean (the executor's `scriptCellInput`, `host.ts:7653`, sends them invariant), the user's
   formula text when it starts with `=`, an ISO date string, a listbox joined with `", "`, or `null`
   to clear — **never the display string**, because the entry ladder refuses currency text
   (`core/engine/src/number_text.rs` `ENTRY`) and echoing `£1,234.50` would store TEXT. All cells
   go out per cell inside `withScriptUndoBatch(lib, "Form: <name>", …)` (`host.ts:12265-12272`),
   which JOINS an already-open transaction rather than nesting one (`:7596-7600`) — so "one Ctrl+Z"
   holds when no transaction is open, and per-cell writes are required because the batch command
   drops writeback cells. A `writeOn: "change"` widget is written right after its (debounced) change
   is delivered, as its own batch, and a refused write shows in the banner (`scriptForms.ts:536-548`).
   After a write the cells are re-read and pushed as fresh seeds so an unchanged resubmit is not
   rewritten (`host.ts:12273-12283`).
5. **LIVE** (`installFormLiveWatch`, `host.ts:12292-12346`), installed when the renderer acks
   (`:12042-12046`). For every `AppEvents.CELL_VALUES_CHANGED` entry: the PINNED-SHEET filter runs
   FIRST at restricted tier (`:12301`) — before any tier clamp, so a change on a sheet the user
   switched to never reaches a restricted form even though the clamp would now admit that sheet;
   own writes are dropped via `isOwnScriptWrite` (`:12302`; fed by `recordScriptWrite` in the
   executor, `:5133`, keyed to the FORM script's id because the writes go out under its handle);
   the rest is intersected on `(sheetIndex, row, col)` (`:12303-12305`), coalesced on a 16 ms timer
   (`:12309-12323`), re-read through `readFormCell`, and pushed with `refreshScriptFormSeeds`
   (`scriptForms.ts:430-444`), which patches the renderer, updates the `form.values` mirror and
   forwards `onChange { source: "cell" }`. The renderer applies a refreshed seed only to widgets the
   user has not touched; a touched one keeps the user's value and is marked stale
   (`ScriptFormDialog.tsx:343-371`). Controls-pane bindings refresh on non-transient
   `onControlValueChange` (`host.ts:12326-12341`).
6. **AUDIT.** Every read and write above is a broker call and lands as the form script's own row;
   the show is the `form.show` row; a proxied show adds the caller's `cap.formsShow` row
   (`host.ts:5307-5315`).

### 8a. The onSubmit verdict

`raceFormSubmitVerdict` (`host.ts:12389-12420`): not asked at all when the script declared no
`onSubmit` (`:12393`); skipped with a console warning while the script is paused in the debugger
(`:12394-12399`); otherwise `relayMethodCall(mw, "__form_onSubmit", [{ values }])` raced against
`BEFORE_LIFECYCLE_DEADLINE_MS` (3 s) — timeout accepts (`:12408-12413`), a thrown handler accepts
(`:12415-12416`). `normalizeFormSubmitVerdict` (`:12360-12378`) keeps `errors` (name-checked,
clamped to 200 chars) and `message` whole — unlike the workbook lifecycle normalizer, which drops
them. Declarative rules (`required`, `min`/`max`, `maxLength`, option membership) are enforced in the
renderer before the host is ever asked (`ScriptFormDialog.tsx:281-290`,
`lib/scriptFormState.ts:397`), and hidden / disabled / read-only widgets are not judged
(`scriptFormState.test.ts:192`).

## 9. Cross-script show

`context.caps.forms.show(name)` → `cap.formsShow` (`host.ts:5306-5334`). The caller's own row is
admitted and audited by the broker call that dispatched it. `findMountedFormByName`
(`:11980-12000`) then resolves the target among MOUNTED workers with `objectType === "form"`, a
case-insensitive trimmed name match, and `sameTrustOrigin(caller.handle, mw.handle)` — the R7
predicate in ONE place, `broker.ts:530-535`: same TIER and same ORIGIN (`"local"` or the same
package name). Zero matches is `HostError` "no form named … is running (it may not exist, or its
package has not been approved)"; more than one is a loud refusal naming the count. There is no
`public` opt-in in release one.

The target's OWN policy is then re-run: `brokerCall(target.handle, "form.show", [options], …)`
(`:5320-5333`), so a form whose owner never declared `ui.dialog` is refused with the owner's
`CapabilityRequired` / `PermissionDenied`, never opened by proxy. Bindings are resolved under the
TARGET (`:5319`) and written under the target (`formSessionDeps(target, bound, mw)`, `:5331`).
The session records `callerName` / `callerScriptId` (`scriptForms.ts:343`, `:371`): the band reads
"… — opened by <Caller>" (`ScriptFormDialog.tsx:481`), the answer is relayed to BOTH workers
(`host.ts:12051-12056`), both clocks are held (`:12057-12064`), and the CALLER's unmount closes a
form it opened on another script's behalf (`scriptForms.ts:462-467`). An unconsented distributed
form is not mounted, so it is not found — nothing paints before consent.

## 10. The renderer

`app/extensions/ScriptableObjects/components/scriptForm/` — `ScriptFormDialog.tsx` (session,
keyboard, submit/cancel, patch/close handling), `FormWidgetTree.tsx` (one switch arm per widget
type, `:710-734`), `widgets/{RadioGroup,ListBox,TabStrip,Progress}.tsx`, and
`ScriptFormDialog.styles.ts`, which re-exports the chrome from `ScriptDialogPrompt.styles.ts` so the
two modal surfaces cannot drift (`:13-33`). Registered as dialog id
`"scriptable-objects.scriptForm"` (`ScriptableObjects/index.ts:617-624`); the three watchers there
turn `SCRIPT_FORM_REQUEST_EVENT` into `context.ui.dialogs.show`, track whether a terminal event left
the renderer, and emit a `cancel` if the dialog vanished unanswered, so EVERY close reaches the host
(`:634-695`).

- **Painting.** `@api/layout` primitives under a panel `SurfaceLayoutProvider`; what the kit lacks
  is a small native element styled with theme tokens (`FormWidgetTree.tsx:8-13`, `:18-29`). No
  `dangerouslySetInnerHTML`; an image draws only from the host-resolved `seed.imageUrl`, never from
  `src` (`:6-7`, `:547`). The read-only table is `_shared/components/ResultTable` (`:30`, `:575`).
- **Identity band** — chrome the script cannot address (`ScriptFormDialog.tsx:522-535`): the
  script name (`:527`); "A form from a script in this workbook" or `A form from the package "<name>"`,
  with " — opened by <caller>" for a proxied show (`:476-482`); `Sheet: <pinned>` at restricted tier
  (`:529`); "Preview — nothing will be written" in preview mode (`:530`). `spec.title` is BODY content
  below the band (`:538`).
- **Geometry.** `useDialogWindow({ minWidth: 360, minHeight: 200 })` for drag and resize (`:154`);
  width `clamp(spec.width ?? 460, 320, min(1200, viewport − 64))` (`:67`, `:454-458`); the body
  scrolls at `80vh` (`:537`).
- **Keyboard** (`:430-451`). Escape cancels. Enter submits unless `submitOnEnter: false`, or the
  target is a textarea, a button, a link, a multi-select, a listbox or a tab strip. Focus starts at
  `spec.focus` if that widget is usable, else the first enabled, non-read-only, non-formula input
  (`:460-474`). Cancel / Escape / the X / the backdrop / a `role: "cancel"` button all take the one
  cancel path (`:270-277`, `:511`, `:532`).
- **One terminal event.** Exactly one of submit / cancel leaves per session (`answered`); the only
  thing that re-arms it is the host REFUSING a submit with a patch carrying `errors` or a `message`
  (`:18-23`, `:384-389`). Bound widgets show the seed's `display` while untouched and the typed value
  once edited (`scriptFormDialog.test.tsx:248`).

Pure state lives in `app/extensions/ScriptableObjects/lib/scriptFormState.ts`: `collectWidgets` /
`collectInputs`, `initialFormValues`, `coerceValue`, `validateFormValues`, `buildFormResult`,
`applyFormPatch`, `dirtySet`, `sameFormValue`.

## 11. Preview and the editor flow

The preview harness serves `form.define` by RECORDING the spec on its backend state
(`scriptPreview/backend.ts:188-194`, `:766-772`); without that case every preview of a form script
would be `declined`. `form.show` is the one capability refusal a form preview EXPECTS: it neither
declines the run nor reads as a finding (`scriptPreview/index.ts:241-257`), and the report carries a
note — "the form's layout was captured from form.define; show() is not exercised in a preview" or
"no layout was captured: the script never called form.define during setup" (`:266-272`). The
captured layout leaves as `WorkerPreviewReport.formLayout` (`report.ts:34-41`), deliberately NOT on
the Rust-pinned `DryRunReport` (`:28-32`). Preview hook payloads are keyed `objectType.hook` so a
form's `onClick` is a widget click and never a button's `{ x, y }`
(`scriptPreview/runShape.ts:66-72`; the host's `SIMULATED_HOOK_PAYLOADS` mirror at
`host.ts:1936-1942`).

The renderer has a preview MODE: with `request.preview`, Submit paints a "what would be written"
list instead of emitting `submit`, and Close cancels (`ScriptFormDialog.tsx:148`, `:291-295`,
`:549-566`). **Nothing connects the two yet**: `showScriptForm` forwards `args.preview`
(`scriptForms.ts:375`) but no caller passes it (`host.ts:5285-5294`, `:5321-5332`), and no editor
action reads `formLayout` to open the dialog. The "Preview form" toolbar action and
`lib/formPreviewBridge.ts` from the plan were not built — see `open-items.md` §2.ab.

Run (F5) opens a debug session, which REMOUNTS the script; the unmount sweep closes any open form
first (`host.ts:934`), and `setup` re-running `form.define` is legal because a define while a
session is open replaces the layout for the NEXT show only (`scriptForms.ts:165-172`).

Typings: the prose lives in `objectContexts.template.d.ts`; `probeShim.ts` maps
`["form", "FormContext"]`, `["control()", "FormControlHandle"]`, `["caps.forms", "ScriptFormsApi"]`
(`:47`, `:65`, `:74`); `npm run gen:script-typings` regenerates `objectContexts.d.ts`,
`generated/scriptSurfacePolicy.ts` and `generated/scriptSurfaceSlices.ts`, and
`npm run gen:canary-tasks` regenerates `generated/canaryTasks.ts` from `tests/eval/tasks.json`.

## 12. The tests that pin each rule

| rule | test |
|---|---|
| Vocabulary has no `html`; limits 200 / 8 / 64 / 500 are the boundary cases; hostile depth and width do not recurse; duplicate, reserved and non-identifier names; unknown keys and types by name; regex `pattern` refused; `image.src` is a media handle or `""`; binding shapes; per-widget bounds | `app/src/api/scriptHost/__tests__/scriptFormSpec.test.ts` |
| Data-only request with HOST identity; resolves on "shown"; every no-answer path is `null` and closes once; verdict keeps the form open; script close; debounced text vs discrete changes; update bucket; seeds vs `initial`; write BEFORE close and refused write keeps the form open; `opened` fires on ack; `writeOn: "change"`; cell-underneath refresh with `source: "cell"`; one per script / one app-wide / refused while a DIALOG holds the slot; three cancels mute, a submit resets; 20-per-minute bucket; ack timeout; idle and absolute deadlines; owner and CALLER unmount sweeps; reset | `scriptForms.test.ts` (`:145-590`) |
| `parseFormBinding` forms; sources only when named; seeds from the TYPED value (currency cell → number); formula kept; ISO dates; boolean coercion; listbox split; control seeds read-only; `cellWriteFor` never the display string; untouched currency cell not dirty; `""`/`null` agree | `scriptFormBindings.test.ts` |
| `normalizeFormSubmitVerdict` accept/cancel/errors-kept; form preview payloads are widget-shaped | `formSubmitVerdict.test.ts` |
| `hostUnmountScript` and `hostResetAll` call the sweeps; every form row has its `executeImpl` case; debugger resume cannot restart the clock under an open form (source-reading, non-vacuous) | `formUnmountSweep.test.ts` |
| Every show/update/close row needs `ui.dialog`, define needs none, the two ui-class rows are exactly the person-answered ones, descs promise "dialog"/"answer", `form.show` names its cell reach, the four user-facing `ui.dialog` sentences are unchanged (reads the real files) | `formConsentHonesty.test.ts` |
| ui-family list gains `cap.formsShow` and `form.show`; the deadline table follows | `scriptDialogs.test.ts:270-277` |
| All capability-bearing rows classified for audit | `capabilityAuditClassification.test.ts` |
| Every row has validator + host case + shim caller | `allowlistCoverage.test.ts` |
| Tree walking, initial values (seed wins, coerced per type), options, declarative validation (no script pattern), typed result, patches, the currency-trap dirty set | `extensions/ScriptableObjects/__tests__/scriptFormState.test.ts` |
| Every widget renders and emits; "shown" once; display shown while untouched; `spec.focus`; band = script name + host provenance and the title NEVER enters it; package and proxied bands; typed change payloads; required blocks; Enter/Escape semantics; the X / footer / backdrop cancel; patch with errors re-arms; foreign showId ignored; refreshed seeds skip touched widgets; preview mode never emits submit; images only from `imageUrl` | `scriptFormDialog.test.tsx` |
| Generated typings lockstep (686 chains / 743 entries with the form type) | `objectContextsTypings.test.ts:151-168` |
| `DRAFT_OBJECT_TYPES` matches `mcp/drafts.rs` exactly, in order | `extensions/AIChat/__tests__/chatToolSurface.test.ts:263` |
| `PREFERRED_HOOK_BY_TYPE.form` honest about the live surface | `scriptTemplate.test.ts:55` |
| Rust `Form` round-trips through the `.cala` def | `core/calcula-format/src/features/object_scripts.rs:224-228` |

**No end-to-end journey exists for forms.** `app/e2e/journeys/script-form.spec.ts` and
`script-form-distributed.spec.ts` from the plan's S6 were not written, and `script-preview.spec.ts`
has no form case. Mount-level behaviour (a real worker, the real consent gate, one Ctrl+Z over a
real transaction) is therefore pinned only by the unit tests above — see `open-items.md` §2.ab.

## 13. Where the code differs from the plan

- Restricted-tier **reads** pass an EXPLICIT sheet index to `sheet.getCellData` so the clamp refuses
  a foreign sheet by name; the plan said reads pass none. Writes pass none, as planned, which is why
  the pinned-sheet check exists.
- The live watch coalesces on a **16 ms `setTimeout`**, not a `requestAnimationFrame`.
- `DryRunReport` did not gain `formLayout`; it lives on `WorkerPreviewReport` only (`report.ts`),
  because that interface is pinned field-for-field to the Rust struct and the interpreter realm has
  no `form.define` to capture.
- No friendly "Form" label was added where object types are displayed; the Subscribe dialog prints
  the raw `objectType`.
- The submit-verdict racer is pinned by `formSubmitVerdict.test.ts`, not by an addition to
  `hookEventDelivery.test.ts`; the race's timeout path itself has no timer-driven unit test.
- One extra ALLOWLIST row exists that the plan did not name: **`form.readControl`**, capability-free
  and class `read`, the audited door for a `{ control }` binding (§8). It is host-driven, so it is
  listed in `ROWS_WITH_NO_SHIM_CALLER` beside `formula.udf.invoke`.

## 13a. The adversarial review, and the twenty defects it found

Four read-only reviewers (sandbox, bindings, lifecycle, renderer) attacked the built feature against
the code, and every finding was then given to two skeptics told to REFUTE it. Twenty survived and
were fixed; each fix carries a test that was proved to go red when the fix is reverted.

**The pattern is worth more than the list: nineteen of the twenty were two components each being
locally reasonable while disagreeing about a shared rule.** The renderer and the host both decide
what is dirty, what is focused, and what a refusal looks like — and every place they decided it
separately produced a defect.

| What broke | Why it was invisible |
|---|---|
| `onSubmit` returning `false` froze the form on "Working…" forever | the host said "refused" by OMITTING errors and a message; the renderer read refusal off those same two fields, so a bare refusal read as "not refused". Refusal is now STATED (`refused: true`) |
| Escape during a pending submit orphaned the session for 30 minutes, holding the app-wide modal slot | the extension skipped its cancel whenever a terminal event had left the renderer — exactly the case where the host was still waiting. It now tells the host whenever the dialog is gone and the session is open |
| a textbox bound to a currency cell wrote `£1,234.50` as TEXT on the first keystroke | the seed carried the DISPLAY as the editable value; the display now rides along in `seed.display` and the value is typed |
| an untouched single-select listbox truncated a multi-value cell | the host seeded a LIST, the renderer held a string, so `isDirty` said "edited" |
| `{ cell: "B2", sheet: 1 }` never resolved | the index was stringified and looked up as a sheet NAMED "1" — and a test PINNED that |
| a sheet deleted while a form was open re-aimed its writes | bindings held an index; the name each index carried at show is now re-checked before the write (`sheetIdentityRefusal`) |
| a script could hold the modal slot for 8 h with nobody present | `form.update({ focus })` moved focus, the DOM focus event was reported as user interaction, and that re-armed the 30-minute idle deadline |
| a wizard closing its own form three times muted itself | every non-submit close counted as a USER dismissal. Only user decisions move the streak now — and a script-driven close does not RESET it either, or a script could launder the user's refusals |
| a `writeOn: "change"` write came back to its own script as an outside edit | the post-write refresh reused the live-watch path; it now passes `{ echo: false }` |
| `form.values` reported a cell value the user could not see | the refresh overwrote values the renderer deliberately keeps; it now applies the renderer's untouched rule |
| `show({ initial: { qty: "10" } })` wrote an untouched widget | `isDirty` compared number-vs-string in one direction only |
| a required field inside a HIDDEN container blocked Submit with an error nothing painted | validation judged the widget's own flags, never its container's |
| `disabled` on a container left every control in it live | the renderer never propagated it |
| `setOptions({ range })` was accepted and did nothing | a patch performs no range read; it is refused by name now, with what to do instead |
| a `{ range }` list could paint 100,000 entries | the inline caps (500 / 5,000) were not applied to range-fed content |
| the consent sentence promised writeback "when you submit" | `writeOn: "change"` writes on every change and Cancel does not undo it; the sentence now says so |
| a `{ control }` binding read the Controls store directly | no policy, no audit row. It goes through `form.readControl` now |
| a dropdown bound to an EMPTY cell displayed its first option | the `<select>` had no empty row to land on, so the screen disagreed with what would be submitted |
| the answer relay's "worker already gone" guard could not fire | it asked the `mounted` map, which the unmount clears LAST, long after the sweep that closes forms |
| `spec.focus` on a non-active tab page left the form with no focus at all | `autoFocus` is an attribute on a RENDERED element; initial focus is a request now, which brings the page forward |

One confirmed finding was deliberately NOT fixed and is recorded in `open-items.md` §2.ab: the
bound-cell reads happen before the show guards, so a refused show still reads. Nothing unauthorised
happens — every read is the same audited broker call it would be anyway — and the fix is an ordering
change with more risk than the waste it removes.

**A note on reading the verdicts.** Several findings were marked "refuted" by their skeptics because
they were fixed WHILE the skeptics were reading, and the refutation cites the fix. A verdict is
about the code at the moment it was read, not about whether the defect was ever real.

## 14. Later milestones and their prerequisites

Each is additive on the release-one seam; each has defects to close FIRST. The rows below are also
in `docs/design/open-items.md` §2.ab.

- **M2 — modeless floating window and task pane.** Needs a NEW capability id (`ui.pane`), because
  "a dialog you must answer or close before continuing" would be false: `ALL_CAPABILITY_IDS`
  (`capabilityIds.ts:216`), `CAP_DESCRIPTION` (`capabilities.ts:411`), the two phrase tables
  (`SubscribeDialog.tsx:63`, `inspector/ScriptsSection.tsx:46`), `BROKER_AUDITED_CAPABILITY_METHODS`
  (`broker.ts:295`), the `scriptSurfaces.ts` rows, and Rust `KNOWN_CAPABILITY_IDS`
  (`core/persistence/src/lib.rs:1705`). Sessions become script-visible instances (the shim already
  keys waiters by `showId`, `contextShims.ts:782-816`). Real event backpressure:
  `EVENT_QUEUE_HIGH_WATER` is declared and read nowhere (`protocol.ts:426`). A panel host:
  `ExtensionPanelHost` in `docs/design/third-party-addin-authoring.md:361` was never built.
- **M3 — on-grid embedding.** The `ui.html` frame is permanently `pointer-events: none`
  (`extensions/Controls/Shape/shapeRenderer.ts:228`); on-grid controls have no reachable right-click
  menu (`open-items.md` §2.x); anchor-derived control ids lose their script on copy
  (`createForm.ts:8-10`), so the form's minted-UUID identity must carry over.
- **M4 — third-party `form` contribution kind.** `EXTENSION_CONTRIBUTION_KINDS`
  (`extensionProtocol.ts:50`) plus a required capability and a `CONTRIBUTION_REACH_NOTE`; the
  extension realm has no cell API — its `grid` namespace offers only `cellStyles` and refuses the
  rest (`worker/extensionWorkerContext.ts:609-660`) — so bound reads need `grid.read` and bound
  writes need a new gated door or forms stay read-only there; `EXTENSION_BROKER_METHODS` and
  `extensionReachableCapabilities` (`shell/registries/extensionTrust.ts:58`, `:81`) updated honestly.
- **M5 — drag-and-drop designer.** A TypeScript-AST reader/writer for the `#region` block
  (`scriptableObjectScaffolds.ts:662-679`; the transpiler already loads `typescript` on demand,
  `scriptTranspile.ts:121-126`, and ONE ARTIFACT is its rule, `:15-25`), round-trip tests that only
  that block changes and `// @capability`
  pragmas stay byte-identical, `LiveModulePersister` integration
  (`ScriptableObjects/lib/liveModuleBuffer.ts:152`), `_shared/components/useDragDrop.ts`.
- **M6 — isolated HTML/CSS apps.** Prove the srcdoc bridge executes under the Tauri CSP, or serve
  app documents from a Rust custom URI scheme with their own origin; extract the duplicated bridge
  (`shapeRenderer.ts:165-230` vs `ControlsPane/components/CustomControlHost.tsx:17-24`, `:413-417`);
  e2e coverage of a user gesture reaching the bridge; theme-token injection and size negotiation; a
  distinct consent id; a memory watchdog and an iframe cap; asset residence under "reference media,
  never introduce bytes"; only then does `{ type: "html" }` (`scriptFormSpec.ts:83-84`,
  `validators.ts:4202`) become legal.

## 15. Related documents

- `docs/design/scriptable-objects.md` — the object model this type joins (its "UserForms" row now
  points here).
- `docs/design/scripting-vba-review.md` §9 — what is closed and what still trails.
- `docs/design/script-sandbox-architecture.md` — tiers, capabilities, the broker.
- `docs/design/open-items.md` §2.ab — the follow-ups.
