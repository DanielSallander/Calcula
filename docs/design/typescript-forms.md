# TypeScript Forms — release one (modal forms)

**Status: SHIPPED 2026-09-02** (slices S1–S5 of the approved plan). Verified against the code on
**2026-09-03**, and re-verified the same day after all of it had landed: the twenty adversarial
review fixes (§13a), the preview follow-up, and the NINE further findings of the second review
pass (§13b). Every mechanism below cites the FILE and the SYMBOL that was opened and read — a
function, constant, interface, `case` label or test name — never a line number, because those in
the first draft of this document were wrong within a day and sent readers somewhere unrelated.
Where the code differs from the plan (`~/.claude/plans/it-occured-to-me-wiggly-pixel.md`), the code
is what is documented here and the difference is listed in §13. What was NOT built is in §13 and in
`docs/design/open-items.md` §2.ab.

## 1. Purpose and owner decisions

Calcula had no equivalent of a VBA `UserForm`. A script could ask one question at a time through
`caps.dialog.*` (a flat five-field spec painted by trusted code, `app/src/api/scriptHost/scriptDialogSpec.ts`),
and nothing else. The VBA review named custom UI surfaces as the one unfinished frontier
(`docs/design/scripting-vba-review.md` §9).

Owner decisions taken 2026-09-02, all reflected in the code:

1. **Host-painted widget tree first.** The script supplies DATA — a tree of plain objects — and
   trusted host code paints it in the app skin (`scriptFormSpec.ts` header comment "WHY
   DECLARATIVE"; `ScriptFormDialog.tsx` header comment "PURPOSE"/"SECURITY"). Isolated HTML/CSS
   "apps" are a later milestone (§14, M6).
2. **Code-first authoring.** The layout is an object literal inside the script, in a
   `#region Form layout (designer-owned …)` block the scaffold emits
   (`app/src/api/scriptableObjectScaffolds.ts` `getScaffoldTemplate`, `case "form"`). A
   drag-and-drop designer is M5.
3. **Modal only.** One form on screen, sharing the modal slot with `ui.dialog`
   (`scriptDialogs.ts`, the "THE MODAL SLOT — guards 1 and 2, shared with script-defined forms"
   block). Modeless windows and task panes are M2; on-grid embedding is M3.
4. **Workbook object scripts only.** A form is an ordinary object script (`objectType: "form"`),
   saved in `.cala`, carried by `.calp`, forced restricted and unmounted until consent like every
   distributed script (`core/calp/src/pull.rs` `pull_with_options`, the "Read object scripts" loop).
   A third-party add-in `form` contribution kind is M4.

## 2. Architecture

```
worker realm (one hardened Web Worker per script)        trusted host (main window)
------------------------------------------------         --------------------------------------------------------
FormContext shim   contextShims.ts case "form"            ALLOWLIST rows        allowlist.ts "form.*" block
                                                          executeImpl cases     host.ts case "form.define".."cap.formsShow"
  define(spec) --callFire "form.define"----------------->  defineScriptForm     scriptForms.ts
  show()       --call "form.show"----------------------->  showScriptForm       scriptForms.ts
                                                             claimModalSlot     scriptDialogs.ts
                                                             (then, and only then, the resolve THUNK)
                                                             resolveFormBindings host.ts  (reads = brokerCall)
                                                             SCRIPT_FORM_REQUEST_EVENT ---> ScriptableObjects/index.ts
                                                                                            ScriptFormDialog.tsx (renderer)
               <-- callResult { showId } -----------------  handleInput case "shown"  <-- INPUT "shown"
  (awaits __form_closed)                                   ... INPUT change / click / submit / cancel / interaction
  onShow/onChange/onClick/onClose  <--{t:"event"}--------  formSessionDeps.forward   host.ts
  onSubmit  <--methodCall "__form_onSubmit"--------------  raceFormSubmitVerdict     host.ts (3 s, default accept)
                                                           writeFormBindings         host.ts (one undo batch)
  rt.exposed "__form_closed"  <--methodCall--------------  relayFormClosed           host.ts
  form.values / form.isOpen   <--{t:"mirror"}------------  formSessionDeps.mirror    host.ts
```

Four modules own the host half, and the split is deliberate:

- `app/src/api/scriptHost/scriptFormSpec.ts` — the declarative shape, the limits, and the four
  app events (`SCRIPT_FORM_REQUEST_EVENT` / `_PATCH_` / `_CLOSE_` / `_INPUT_EVENT`). A leaf: its
  only import is `./scriptDialogSpec`.
- `app/src/api/scriptHost/scriptForms.ts` — layouts, sessions, deadlines, rate buckets, and the
  renderer exchange. It never imports `host.ts`; host reach arrives as `FormSessionDeps`
  callbacks.
- `app/src/api/scriptHost/host.ts` — the binding pipeline and the worker relays, because they
  need module-private `executeImpl`, `withScriptUndoBatch`, `isOwnScriptWrite` and the
  mounted-worker table (`mounted`).
- `app/src/api/scriptHost/scriptFormBindings.ts` — the PURE half of binding: parsing `bind`,
  cell → seed, widget → cell write, dirtiness, and the sheet-identity refusal (see its header
  comment, "THE ONE RULE EVERY WRITER HERE OBEYS").

The renderer is `app/extensions/ScriptableObjects/components/scriptForm/` (§10), wired in
`app/extensions/ScriptableObjects/index.ts` under the "TypeScript Forms: the script-defined form
modal" comment. A fifth module, `app/src/api/scriptFormPreview.ts`, is the shared preview
entry point added on 2026-09-03 (§11).

## 3. The object type and persistence

`"form"` is a member of `ScriptableObjectType` (`app/src/api/scriptableObjects.ts`, listed
in `SCRIPTABLE_OBJECT_TYPES`; Rust `core/persistence/src/lib.rs` `ScriptableObjectType::Form`). It
is an object script with a **minted UUID `instanceId`** and no backing workbook object:
`createFormScript` (`app/extensions/ScriptableObjects/lib/createForm.ts`) is the one place a
form is minted — `id: crypto.randomUUID()`, `instanceId: crypto.randomUUID()`, `accessLevel:
"restricted"`, source from `getScaffoldTemplate("form", name)` — and both Insert > Form
(`ScriptableObjects/index.ts`, the `insert.form` menu item) and the manager pane's "+ Form"
(`ObjectScriptManagerPane.tsx` `handleAddForm`, and the button that calls it) call it. Names
auto-number `Form1`, `Form2`, … case-insensitively (`createForm.ts` `nextFormName`) because other
scripts address a form by NAME (§9). An AI-drafted form gets its instanceId minted in
`draftToScriptDefinition` (`ScriptableObjects/lib/scriptDrafts.ts`).

**No new store, no manifest feature id, no format version.** A form is persisted exactly as every
object script is (the `object_scripts` feature; `CALA_MAX_SUPPORTED_FORMAT_VERSION`
(`core/calcula-format/src/manifest.rs`) is untouched by the forms work — it has since moved for an
unrelated reason, which `open-items.md` §2.ab tracks as doc drift in `CLAUDE.md`). An older reader
that does not know the variant fails to deserialize that one script — a visible loss, not a
misreading — which is the test the `.cala` versioning rule sets.

The Rust variant sites, all exhaustive matches that cargo enforces:

| site | where |
|---|---|
| `ScriptableObjectType::Form` | `core/persistence/src/lib.rs` |
| `ObjectScriptObjectTypeDef::Form` + both `From` arms | `core/calcula-format/src/features/object_scripts.rs` (round-trip test `form_object_type_round_trips_through_the_cala_def`) |
| `object_type_to_string` / `string_to_object_type` | `app/src-tauri/src/scripting/object_script_commands.rs` |
| `VALID_OBJECT_TYPES` (MCP drafts; order pinned by `chatToolSurface.test.ts` `"matches VALID_OBJECT_TYPES in mcp/drafts.rs exactly, in order"`) | `app/src-tauri/src/mcp/drafts.rs` |

Distribution: publish lifts the ceiling from the `// @capability ui.dialog` pragma like any script;
pull forces `Restricted` + `Distributed` + the manifest ceiling (`core/calp/src/pull.rs`
`pull_with_options`), and an unconsented form is not mounted, so it cannot be shown by anyone (§9).
The Subscribe dialog lists it as an object script with its raw `objectType`
(`SubscribeDialog.tsx` `SubscribeDialog`, the "Scripts (…)" block), and the package inspector shows
its full emitted source (`inspector/ScriptsSection.tsx` `SourceBlock`) — plus, since 2026-09-03, a
**Preview layout** action for form scripts only (`FormPreviewAction`, §11; the dialog it opens is
painted in the MAIN window, over a cross-window wire). The earlier statement here that "no rendered
layout view exists in the inspector" is no longer true.

Forms are deliberately **not** enumerable through `api.listObjects`
(`app/src/api/scriptHost/objectInventory.ts` has no `form` kind).

## 4. The script-facing API

The declarations below are quoted from `app/scripts/scriptTypings/objectContexts.template.d.ts`
(the prose source of the generated `objectContexts.d.ts`; lockstep pinned by
`extensions/ScriptableObjects/__tests__/objectContextsTypings.test.ts`).

```ts
// objectContexts.template.d.ts — FormValue / FormOption / FormOptions / FormBinding
declare type FormValue = string | number | boolean | null;
declare interface FormOption { value: string; label?: string; }
declare type FormOptions = Array<string | FormOption> | { range: string };
declare type FormBinding =
  | string
  | { cell: string; sheet?: string | number }
  | { name: string }
  | { control: string };

// FormWidgetBase / FormInputBase
declare interface FormWidgetBase {
  name?: string; label?: string; help?: string; hidden?: boolean; disabled?: boolean;
  width?: number | "fill";
}
declare interface FormInputBase extends FormWidgetBase {
  name: string; bind?: FormBinding; required?: boolean; writeOn?: "submit" | "change";
}

// FormWidget
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

// FormSpec
declare interface FormSpec {
  title?: string; description?: string; submitLabel?: string; cancelLabel?: string;
  width?: number; writeOn?: "submit" | "change"; submitOnEnter?: boolean; focus?: string;
  children: FormWidget[];
}

// FormPatch
declare interface FormPatch {
  values?: Record<string, FormValue | string[]>;
  controls?: Record<string, { disabled?: boolean; hidden?: boolean; label?: string; text?: string;
    options?: FormOptions; error?: string | null; value?: number; max?: number }>;
  focus?: string;
  message?: { text: string; kind?: "info" | "warning" | "error" } | null;
}

// FormSubmitVerdict / FormChangeDetail / FormClickDetail / FormCloseDetail
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

// ScriptFormsApi  (context.caps.forms — on EVERY script)
declare interface ScriptFormsApi {
  show(name: string, options?: { initial?: Record<string, FormValue | string[]> }): Promise<Record<string, unknown> | null>;
}

// FormControlHandle
declare interface FormControlHandle {
  readonly value: unknown;
  set(value: unknown): void;
  setText(text: string): void;
  enable(enabled: boolean): void;
  show(visible: boolean): void;
  // NOT FormOptions: a `{ range }` list is read once, when the form opens, and a
  // patch cannot change it — the host refuses one by name rather than ignoring it.
  setOptions(options: Array<string | FormOption>): void;
  setError(message: string | null): void;
  focus(): void;
  onChange(handler: (detail: FormChangeDetail) => void): () => void;
  onClick(handler: (detail: FormClickDetail) => void): () => void;
}

// FormContext
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

`{ type: "html" }` is not in the vocabulary (`scriptFormSpec.ts` `FORM_WIDGET_TYPES`) and the
validator refuses it by name (`validators.ts` `checkFormWidget`); it is reserved for M6.

How the shim implements this (`app/src/api/scriptHost/worker/contextShims.ts`, `case "form"`):
`define` / `update` / `close` are fire-and-forget `callFire`s; `show` is
`awaitFormAnswer(rt, await call(rt, "form.show", [options]))`; `values` and `isOpen` read
host-pushed mirrors `form.values` / `form.isOpen` (through the local `formValues` helper and
`mirror`); `control(name)` setters are sugar over the local `update` helper, i.e. `form.update`;
per-widget `onChange` / `onClick` handlers are dispatched from ONE registered hook per kind (the
`widgetHook` helper), so one `hookRegistered` crosses per hook name, never per widget; `onSubmit`
is a REPLYING hook registered under the relay name `__form_onSubmit`
(`registerReplyingHook`). `caps.forms.show(name)` is
`awaitFormAnswer(rt, await call(rt, "cap.formsShow", [name, options]))` (`contextShims.ts`,
the `forms` member of the capabilities object).

The scaffold (`scriptableObjectScaffolds.ts` `getScaffoldTemplate`, `case "form"`) is the worked
example: a bound order-entry form, an `onChange` that recomputes a label through
`form.control("total").setText`, an `onSubmit` that blocks one combination, and a top-level `run()`
that awaits `context.show()`. The AI path prefers `onSubmit` for this type
(`scriptTemplate.ts` `PREFERRED_HOOK_BY_TYPE`) and has one canary task,
`cap-form-customer-quantity` (`tests/eval/tasks.json`).

## 5. Wire rows and consent text

**SIX** ALLOWLIST rows, not the five the plan named (`app/src/api/scriptHost/allowlist.ts`, the
`"form.*"` / `"cap.formsShow"` block). `form.readControl` is the sixth and is host-driven (§13):

| row | tier | capability | class | validator | limits | desc (the consent / transparency sentence) |
|---|---|---|---|---|---|---|
| `form.define` | restricted | — | emit | `vFormDefine` | maxNodes 200, maxDepth 8, maxInputs 64 | "Describe the layout of its own form (labels, inputs, choices, buttons) so Calcula can draw it — nothing is shown until it asks to show it" |
| `form.show` | restricted | `ui.dialog` | ui | `vFormShow` | — | "Open its form as a dialog you must answer or close before continuing, and read what you entered; a field it bound to a cell shows that cell and writes it back when you submit — or as soon as you change it, if the form asked for that, in which case closing the form does not undo it (on the sheet you were looking at when it opened, for a restricted script)" |
| `form.update` | restricted | `ui.dialog` | emit | `vFormUpdate` | perSecond 30 | "Change what its open form shows (values, enabled or hidden fields, choices, a message)" |
| `form.close` | restricted | `ui.dialog` | emit | `vFormClose` | — | "Close its own form from code and decide what answer it reports" |
| `form.readControl` | restricted | — | read | `vFormReadControl` | — | "Read the current value of a control on this workbook's Controls pane, to show it in its form" |
| `cap.formsShow` | restricted | `ui.dialog` | ui | `vFormsShowNamed` | — | "Open another script's form in this workbook as a dialog, on that script's behalf, and read your answer" |

The `form.show` sentence gained its `writeOn: "change"` clause during the adversarial review (§13a):
a sentence promising writeback "when you submit" is false for a form that writes on every change and
does not take those writes back on Cancel. Pinned by `formConsentHonesty.test.ts`
`"form.show also names the OTHER moment a bound field writes"`.

All four capability-bearing rows are classified in `BROKER_AUDITED_CAPABILITY_METHODS`
(`broker.ts`) with the reason "host-window form; no script-driven backend call" — the one
backend call a show can make, the image resolve, is host-driven (§8).

**Why reusing `ui.dialog` is honest for a modal.** The user-facing `ui.dialog` sentences are
unchanged and pinned as source text by `formConsentHonesty.test.ts`
(`describe("the four user-facing ui.dialog sentences still promise a dialog and an answer")`) —
FOUR file locations carrying THREE distinct wordings:
`capabilities.ts` `CAP_DESCRIPTION` "show you a dialog and receive what you enter";
`Distribution/components/SubscribeDialog.tsx` `CAPABILITY_PHRASE` and
`inspector/ScriptsSection.tsx` `CAPABILITY_PHRASE`, which share "interrupt you with a dialog and
read your answer"; and `ScriptableObjects/index.ts` `CAPABILITY_DESCRIPTION` "Interrupt you with a
dialog box and read what you answer". A host-painted modal that collects keystrokes is exactly that
reach. The **cell** reach of a bound widget is NOT carried by `ui.dialog`: bindings are executed as
the script's own `sheet.*` / `api.*` calls (§8), which are tier-governed and capability-free, and
the consent screen for a restricted script already says it reads and writes "the cells of the sheet
currently shown" (`extensions/ScriptableObjects/__tests__/consentTextHonesty.test.ts` `"says
plainly that a restricted script reads and writes the shown sheet"`). The `form.show` desc names
the binding reach anyway (`formConsentHonesty.test.ts` `"form.show names its cell reach: what a
bound field shows, when it writes, which sheet"`). This reasoning is what makes a **modeless**
surface a different capability later (§14, M2): "a dialog you must answer or close before
continuing" would be false for it.

`form.define` carries no capability so that the preview harness — whose handle has an empty
ceiling and empty grants (`broker.ts` `buildPreviewHandle`) — admits it and can capture the layout
(§11).

## 6. The show() resolution model and the two clocks

`form.show` / `cap.formsShow` are `class: "ui"` rows and sit on the person-length deadline
(`protocol.ts` `METHOD_DEADLINES_MS`, `UI_DIALOG_DEADLINE_MS = 300_000`). But they do **not** await
the answer. The broker call resolves `{ showId }` the moment the renderer acknowledges the form is
on screen (`scriptForms.ts` `handleInput`, `case "shown"`); the host itself gives the renderer
`FORM_SHOWN_ACK_TIMEOUT_MS = 10_000` to do so (declared in `scriptForms.ts`, armed as `ackTimer` at
the end of `showScriptForm`), after which the session ends as "cancel" and the awaiting `show()`
rejects with `HostError` "the form did not open (no renderer acknowledged it)" (`endSession`, the
`!s.shown` branch). This keeps `scriptDialogs.test.ts` `"is exactly the ui.dialog family"` additive
and means no worker-side RPC ever stays pending for a data-entry session.

The answer arrives later: `deps.closed(showId, result)` (the last statement of `endSession`) becomes
`relayMethodCall(mw, "__form_closed", [{ showId, result }])` (`host.ts` `relayFormClosed`), and the
worker-local `rt.exposed` entry `__form_closed` — installed on EVERY realm at context build through
`rt.exposed` directly, never through `context.expose`, so it is not script-callable and not a
debugger trigger (`contextShims.ts` `formWaiters`) — resolves the promise the script is awaiting
(`contextShims.ts` `awaitFormAnswer`). A muted script's show answers `{ showId, closed: true }` and
the shim resolves `null` at once (`showScriptForm`'s `isScriptDialogMuted` branch;
`awaitFormAnswer`'s `o.closed` branch).

**Clock 1, worker → host** (`protocol.ts` `callDeadlineMs`): bounds only the show itself.

**Clock 2, host → worker** (`host.ts` `relayMethodCall`, `METHOD_CALL_TIMEOUT_MS = CALL_TIMEOUT_MS
= 30_000` in `protocol.ts`; armed by that call's `entry.arm`): this is the clock that carries a
`run()`, a button handler, a scheduled job or a shortcut that AWAITS the form, because those are
relayed method calls. While a script has a form open the host holds that clock: on "shown"
`deps.suspendDeadlines()` → `holdFormDeadlines(mw)` increments `mw.formHolds` (the field is
declared on `MountedWorker`) and calls `suspendMethodCallDeadlines`; on close `releaseFormDeadlines`
decrements and re-arms only when the count reaches zero and the script is not paused in the
debugger. `resumeMethodCallDeadlines` refuses to re-arm while `formHolds > 0`, so the debugger
resuming cannot restart the clock under an open form — pinned by `formUnmountSweep.test.ts` `"the
debugger's resume cannot restart the relay clock under an open form"`. For a cross-script show both
the owner's and the caller's clocks are held (`formSessionDeps`, `suspendDeadlines` /
`resumeDeadlines`).

## 7. Guards, deadlines and limits

**Modal slot, shared with dialogs** (`scriptDialogs.ts` `claimModalSlot` / `releaseModalSlot` /
`getActiveModal`). `showScriptForm` claims it with `kind: "scriptForm"`; `"form"` was already the
`cap.dialogForm` kind (`ScriptDialogKind`, widened by `ModalKind`). Guard 1: one modal per script —
"this script already has a dialog open" (`claimModalSlot`, the `slotByScript.has` branch). Guard 2:
one app-wide, rejected not queued — "another script (…) is showing a dialog" (`claimModalSlot`, the
`getActiveModal` branch). Guard 3: **only a USER decision moves the dismissal streak** — `submit`
resets it, `cancel` and `deadline` advance it, and `script` / `unmount` leave it alone
(`endSession`, the block commented "ONLY THE USER MOVES THE DISMISSAL STREAK, IN EITHER DIRECTION").
`MAX_CONSECUTIVE_DISMISSALS = 3` mutes the script for dialogs and forms alike
(`scriptDialogs.ts` `recordModalOutcome`). *This is a change from the shipped behaviour: every
non-submit close used to count as a refusal, which muted a wizard that closed and reopened its own
form three times (§13a).*

**Registry-owned bounds** (`scriptForms.ts`):

| constant | value | where |
|---|---|---|
| `FORM_IDLE_DEADLINE_MS` | 30 min, re-armed by any renderer `interaction` / `change` / `click` / `submit` | declared in `scriptForms.ts`; armed by `armIdle`, re-armed in `handleInput` |
| `FORM_MAX_OPEN_MS` | 8 h absolute | declared in `scriptForms.ts`; `maxTimer` set in `handleInput` `case "shown"` |
| `FORM_SHOWN_ACK_TIMEOUT_MS` | 10 s for the renderer to ack | declared in `scriptForms.ts`; `ackTimer` set at the end of `showScriptForm` |
| `FORM_TEXT_CHANGE_DEBOUNCE_MS` | 150 ms host-side debounce for textbox / number / date `onChange` | declared in `scriptForms.ts`; applied in `handleInput` `case "change"` via `isTextLike` |
| `FORM_SHOWS_PER_MINUTE` | 20 show attempts per script per minute, refused with a HostError beyond it | `scriptFormSpec.ts`; enforced by `bucketAllowsShow`, called from `showScriptForm` |
| `FORM_UPDATE_PER_SECOND` | 30 `form.update` per second per open form (token bucket); excess dropped, one console warning per session | `scriptFormSpec.ts`; enforced by `takeUpdateToken`, called from `updateScriptForm` |

Both deadlines close as dismissed (`null`) with `onClose { reason: "deadline" }`, never as an
error (`armIdle`; the `maxTimer` in `handleInput` `case "shown"`). `endSession` is idempotent —
cancel, script close, deadline, unmount and reset all land there and only the first settles
anything. The renderer throttles `interaction` to one per second on its side
(`ScriptFormDialog.tsx` `INTERACTION_THROTTLE_MS`, applied in `onInteraction`).

**Validator limits** (`scriptFormSpec.ts`, the "Limits" block; enforced in `validators.ts`):
`MAX_FORM_NODES` 200 (containers count), `MAX_FORM_DEPTH` 8, `MAX_FORM_INPUTS` 64,
`MAX_FORM_OPTIONS` 500, `MAX_FORM_TABLE_CELLS` 5,000, `MAX_FORM_TABS` 12,
`MAX_FORM_GRID_COLUMNS` 6, width `MIN_FORM_WIDTH`..`MAX_FORM_WIDTH` (320..1200),
`MAX_FORM_BIND_CHARS` 64, `MAX_FORM_INITIAL_KEYS` 64, `MAX_FORM_VALUE_CHARS` 32,767,
`MAX_FORM_PATCH_CONTROLS` 64, `MAX_FORM_ERROR_CHARS` 200. `vFormDefine` (`validators.ts`)
walks the tree with an explicit stack — a children array is counted before it is pushed (its
`pushChildren` helper), so a hostile 10,000-deep chain returns a message rather than overflowing.
Per widget (`checkFormWidget`): `type "html"` refused by name, known keys per type
(`checkKnownKeys` against `FORM_WIDGET_KEYS`), names must be identifiers, not reserved, and unique
across the whole tree (the `seen` set), text bounded by the dialog caps, `bind` shape-checked
(`checkFormBinding`), no regex `pattern` key exists anywhere. `vFormShow` / `vFormsShowNamed` admit
only `{ initial }` with ≤ 64 identifier keys; `vFormUpdate` bounds `controls` to 64 entries with
known keys (`FORM_PATCH_CONTROL_KEYS`) and errors to 200 chars, and refuses a `{ range }` in
`controls.*.options` BY NAME; `vFormClose` takes a name → value map or nothing;
`vFormReadControl` takes one bounded non-empty string.

## 8. The binding pipeline

Everything below runs under the FORM script's own handle: every read and write is
`brokerCall(handle, method, args, () => executeImpl(mw, method, args))` on the very row the script
would call by hand, so the tier clamp, the writeback draft gate and the audit row are structural,
not re-implemented (`host.ts` `readFormCell`, `resolveFormSources`, the `form.readControl` branch
of `resolveFormBindings`, and `writeFormBindings`).

1. **RESOLVE at show** (`resolveFormBindings`, `host.ts`) — after the registry's guards
   have passed, before anything is painted. `form.show` hands `showScriptForm` a `resolve` THUNK
   rather than finished seeds (`host.ts` `case "form.show"`), and the registry awaits it only once
   no-layout, the show bucket, the dismissal mute and the app-wide modal slot have all let the show
   through, and only after the slot is CLAIMED, so nothing can take it while the reads are in
   flight (`scriptForms.ts` `showScriptForm`, the `args.resolve` block). Resolving first — the
   shape this originally shipped with — meant a muted script looping on `show()` still performed
   one audited broker read per bound cell, plus every `{ range }` source and an image resolve, for
   a form that never opened: wasted IPC, and an audit trail saying a form had read the sheet when
   the user saw nothing. A thunk that THROWS gives the slot back, enters no session and emits no
   close event, and the `show()` rejects with that reason; so does an unmount or a workbook reset
   arriving while the reads are still running (`pendingShows` / `dropPendingShow`), after which the
   show refuses rather than painting for a script that is gone — between the claim and the session
   existing there is nothing in `sessions` for `revokeScriptForms` / `resetScriptForms` to close,
   and a slot left held would refuse every later dialog in the session. **The pending claim names
   BOTH scripts, not only the owner** (`PendingShow.callerScriptId`, set in `showScriptForm` from
   `args.callerScriptId`): `dropPendingShow` releases it when the unmounting script matches the
   owner **or** the caller, because in a `caps.forms.show` those are two different scripts and the
   one awaiting the answer is the CALLER. An entry keyed and matched on the owner alone survived
   its caller's unmount, went on to paint a form on behalf of code that no longer existed, and sent
   the answer nowhere — while an open SESSION had always closed on either script's unmount
   (`revokeScriptForms`, its `other.callerScriptId === scriptId` loop), so the two halves of one
   rule disagreed. Because the bindings
   therefore do not exist when the session's callbacks are built, `formSessionDeps` takes a GETTER
   (`() => holder.bound`) and each callback reads it when it fires.
   `collectFormBindings` (`scriptFormBindings.ts`) lists every INPUT widget with a `bind`, in tree
   order, with its effective `writeOn` (widget's, else the form's, else `"submit"`).
   `parseFormBinding` (`scriptFormBindings.ts`) tries a bare string as a single-cell A1 address
   (`B2`, `Sheet1!B2`, `'My sheet'!B2`), else as a defined name; a rectangle is refused because an
   input binds ONE cell. `{ cell, sheet }` resolves the sheet through `resolveSheetRefIn`
   (called from `resolveFormBindings`); `{ name }` goes through `lib.resolveNamedRangeCoords` and
   must name one cell; `{ control }` goes through the `form.readControl` broker row, whose inline
   executor calls `getControlValue`, and is read-only (`seedFromControlValue`;
   `app/src/api/controlValues.ts` exposes getters only). A binding that fails at any step becomes a
   seed `{ readOnly: true, reason }` and the widget renders DISABLED with that reason — the form
   still shows (every `out.seeds[decl.name] = { value: null, readOnly: true, reason }` arm of
   `resolveFormBindings`).
2. **READ.** `readFormCell` (`host.ts`) calls `sheet.getCellData` (restricted) or
   `api.getCellData` (unlocked) with an EXPLICIT sheet index, so a restricted binding naming another
   sheet — or a name resolving to one — is refused by `clampSheetIndex` on that row
   (`host.ts` `case "sheet.getCellData"` → `clampSheetIndex`) and the refusal is both audited and
   shown as the widget's reason. The typed `{ value, display, formula }` becomes the seed through
   `seedFromCell` (`scriptFormBindings.ts`): a number widget gets the NUMBER (never the display
   text), a date widget gets the ISO string from the serial, a formula is kept on the seed so the
   widget is shown but never rewritten unless edited. Sources — `options: { range }`, table
   `rows: { range }` — are read through `sheet.getRangeValues` / `api.getRangeValues` under the same
   handle (`resolveFormSources`); an `image.src` is resolved ONCE per show from its `media:` handle
   through `resolveMediaRef` (an IPC; also in `resolveFormSources`) and never per paint. Range-fed
   content is clamped to the same inline caps by `optionsFromCells` / `rowsFromCells`.
   **A seed is not only a value, and the registry's merge respects that.** `showScriptForm` keeps
   the WHOLE seed for every name that is a widget in this layout and gates only `values[name]` on
   `FORM_INPUT_TYPE_SET` (`scriptForms.ts` `showScriptForm`, the loop over `argSeeds`). Filtering
   the seed ITSELF through that set — which is what shipped — threw away exactly the two fields the
   renderer reads for the widgets that take CONTENT rather than an answer: a `table`'s `rows` and
   an `image`'s `imageUrl`, neither of which is an input type. A form with
   `rows: { range: "D2:E9" }` therefore resolved the range, paid for the read, and painted an EMPTY
   table.
3. **PIN (restricted tier).** If any cell binding survived, `pinnedSheet` is the sheet active at
   show and the band shows its name (the `if (restricted && out.cells.length > 0)` tail of
   `resolveFormBindings`; `ScriptFormDialog.tsx`, the `request.pinnedSheetName` line of the band).
4. **WRITE** (`writeFormBindings`, `host.ts`). On Submit the registry first flushes any
   debounced text change, asks `onSubmit` (§8a), and only on acceptance calls `writeBindings` BEFORE
   closing, so a refused write keeps the user's entries on screen with the reason
   (`scriptForms.ts` `submit`). At restricted tier the active sheet must still equal the pinned one
   or the whole submit is refused with `switch back to "<sheet>" to save this form` and the form stays
   open — because the restricted write row passes NO sheet argument and the executor writes whatever
   sheet is active at call time (`host.ts` `case "sheet.setCellValue"`), a silent wrong-cell write is
   otherwise possible. A SECOND identity check runs next: `sheetIdentityRefusal`
   (`scriptFormBindings.ts`) re-reads the sheet list and refuses the write if the pinned sheet, or
   any bound cell's sheet, no longer carries the NAME it had at show — another script (a scheduled
   job, an MCP tool) can delete or reorder sheets while the modal is up, and every binding holds an
   INDEX. Refused, never re-aimed. Only DIRTY widgets are written on Submit
   (`dirtyNames`, `scriptFormBindings.ts`; `isDirty` treats `""`/`null` as equal and a
   number against its own text as equal, in BOTH directions); dirtiness is judged against what the
   CELL held at show, not against `initial`. Each write is `cellWriteFor`: the typed number or
   boolean (the executor's `scriptCellInput`, `host.ts`, sends them invariant), the user's
   formula text when it starts with `=`, an ISO date string, a listbox joined with `", "`, or `null`
   to clear — **never the display string**, because the entry ladder refuses currency text
   (`core/engine/src/number_text.rs` `ENTRY`) and echoing `£1,234.50` would store TEXT. All cells
   go out per cell inside `withScriptUndoBatch(lib, "Form: <name>", …)`, which JOINS an already-open
   transaction rather than nesting one (`host.ts` `withScriptUndoBatch`, its `alreadyOpen` branch) —
   so "one Ctrl+Z" holds when no transaction is open, and per-cell writes are required because the
   batch command drops writeback cells. A `writeOn: "change"` widget is written right after its
   (debounced) change is delivered, as its own batch, and a refused write shows in the banner
   (`scriptForms.ts` `handleInput`, the `s.writeOnChange.has(name)` branch of `deliver`).
   After a write the cells are re-read and pushed as fresh seeds so an unchanged resubmit is not
   rewritten — through `refreshScriptFormSeeds(showId, fresh, { echo: false })`, because this is the
   form's OWN write coming back and forwarding it as `onChange { source: "cell" }` told a
   `writeOn: "change"` script that an outside edit had landed on the value it had just written.
5. **LIVE** (`installFormLiveWatch`, `host.ts`), installed when the renderer acks
   (`formSessionDeps.opened`). For every `AppEvents.CELL_VALUES_CHANGED` entry: the PINNED-SHEET
   filter runs FIRST at restricted tier — before any tier clamp, so a change on a sheet the user
   switched to never reaches a restricted form even though the clamp would now admit that sheet;
   own writes are dropped via `isOwnScriptWrite` (fed by `recordScriptWrite` in the
   executor's `case "sheet.setCellValue"`, keyed to the FORM script's id because the writes go out
   under its handle); the rest is intersected on `(sheetIndex, row, col)`, coalesced on a 16 ms
   `setTimeout`, re-read through `readFormCell`, and pushed with `refreshScriptFormSeeds`
   (`scriptForms.ts`), which patches the renderer, updates the `form.values` mirror and
   forwards `onChange { source: "cell" }`. `refreshScriptFormSeeds` applies the RENDERER's own
   untouched rule before adopting a value, so `form.values` never reports a number the user cannot
   see. The renderer applies a refreshed seed only to widgets the user has not touched; a touched
   one keeps the user's value and is marked stale (`ScriptFormDialog.tsx`, the `detail.seeds` branch
   of the PATCH effect). Controls-pane bindings refresh on non-transient `onControlValueChange`
   (the tail of `installFormLiveWatch`), each delivery going through the same audited
   `form.readControl` row. That subscription arrives through a DYNAMIC
   `import("../controlValues")`, so it can outrun the form it belongs to: a form the user or a
   deadline closed in the same turn it opened ran the cleanup FIRST, against a still-empty
   `unsubControls`, and the `.then` then installed a live listener with nobody left to remove it —
   one re-seeding a dead session for the rest of the session. The cleanup sets a `disposed` flag
   that the `.then` asks about and tears the listener down itself
   (`installFormLiveWatch`, its `disposed` / `unsubControls` pair), which is also why the function
   is exported: no public entry point can drive that import ordering
   (`formLiveWatchDisposal.test.ts`).
6. **AUDIT.** Every read and write above is a broker call and lands as the form script's own row;
   the show is the `form.show` row; a proxied show adds the caller's `cap.formsShow` row
   (`host.ts` `case "cap.formsShow"`).

### 8a. The onSubmit verdict

`raceFormSubmitVerdict` (`host.ts`): not asked at all when the script declared no
`onSubmit` (`mw.declaredHooks`); skipped with a console warning while the script is paused in the
debugger (`isScriptDebugPaused`); otherwise `relayMethodCall(mw, "__form_onSubmit", [{ values }])`
raced against `BEFORE_LIFECYCLE_DEADLINE_MS` (3 s) — timeout accepts, a thrown handler accepts.
`normalizeFormSubmitVerdict` (`host.ts`) keeps `errors` (name-checked, clamped to 200 chars) and
`message` whole — unlike the workbook lifecycle normalizer (`normalizeLifecycleVerdict`), which
drops them. A refusal is STATED on the wire as `refused: true`
(`ScriptFormPatchPayload.refused`, `scriptFormSpec.ts`), never inferred from the presence of errors
or a message, because a bare `{ cancel: true }` carries neither (§13a). Declarative rules
(`required`, `min`/`max`, `maxLength`, option membership) are enforced in the renderer before the
host is ever asked (`ScriptFormDialog.tsx` `submit` → `lib/scriptFormState.ts` `validateFormValues`
/ `validateInputValue`), and hidden / disabled / read-only widgets are not judged
(`scriptFormState.test.ts` `"does not judge widgets the user cannot act on: hidden, disabled,
read-only"`).

## 9. Cross-script show

`context.caps.forms.show(name)` → `cap.formsShow` (`host.ts` `case "cap.formsShow"`). The caller's
own row is admitted and audited by the broker call that dispatched it. `findMountedFormByName`
(`host.ts`) then resolves the target among MOUNTED workers with `objectType === "form"`, a
case-insensitive trimmed name match, and `sameTrustOrigin(caller.handle, mw.handle)` — the R7
predicate in ONE place, `broker.ts` `sameTrustOrigin`: same TIER and same ORIGIN (`"local"` or the
same package name). Zero matches is `HostError` "no form named … is running (it may not exist, or
its package has not been approved)"; more than one is a loud refusal naming the count. There is no
`public` opt-in in release one.

The target's OWN policy is then re-run: `brokerCall(target.handle, "form.show", [options], …)`,
so a form whose owner never declared `ui.dialog` is refused with the owner's
`CapabilityRequired` / `PermissionDenied`, never opened by proxy. Bindings are resolved under the
TARGET and written under the target (`formSessionDeps(target, () => holder.bound, mw)`) —
and, exactly as for the target's own `form.show`, the resolve is a thunk the registry calls only
after its guards pass, so a target that is muted or already has a form up costs no reads at all.
The session records `callerName` / `callerScriptId` (`showScriptForm`, on the `FormSession` and on
the `ScriptFormRequestPayload`): the band reads "… — opened by <Caller>" (`ScriptFormDialog.tsx`
`provenance`), the answer is relayed to BOTH workers and both clocks are held
(`formSessionDeps` `closed` / `suspendDeadlines`), and the CALLER's unmount closes a
form it opened on another script's behalf (`scriptForms.ts` `revokeScriptForms`, its
`other.callerScriptId === scriptId` loop). An unconsented distributed form is not mounted, so it is
not found — nothing paints before consent.

## 10. The renderer

`app/extensions/ScriptableObjects/components/scriptForm/` — `ScriptFormDialog.tsx` (`FormSession`:
session, keyboard, submit/cancel, patch/close handling), `FormWidgetTree.tsx` (one switch arm per
widget type, `renderWidget`), `widgets/{RadioGroup,ListBox,TabStrip,Progress}.tsx`, and
`ScriptFormDialog.styles.ts`, which re-exports the chrome from `ScriptDialogPrompt.styles.ts` so the
two modal surfaces cannot drift (its top-level `export { … } from "../ScriptDialogPrompt.styles"`).
Registered as dialog id `"scriptable-objects.scriptForm"` (`ScriptableObjects/index.ts`,
`SCRIPT_FORM_DIALOG_ID`); the three watchers there turn `SCRIPT_FORM_REQUEST_EVENT` into
`context.ui.dialogs.show`, hide the dialog on `SCRIPT_FORM_CLOSE_EVENT`, and emit a `cancel` from a
`DialogExtensions.onChange` watcher if the dialog vanished while the host still had the session
open — so EVERY close reaches the host.

- **Painting.** `@api/layout` primitives under a panel `SurfaceLayoutProvider`; what the kit lacks
  is a small native element styled with theme tokens (`FormWidgetTree.tsx` header CONTEXT note and
  its `@api/layout` import block). No `dangerouslySetInnerHTML`; an image draws only from the
  host-resolved `seed.imageUrl`, never from `src` (header PURPOSE note; `ImageWidget`). The
  read-only table is `_shared/components/ResultTable` (its import; `TableWidget`).
- **Identity band** — chrome the script cannot address (`ScriptFormDialog.tsx`, the `S.Header`
  block): the script name (`S.AskedBy`); "A form from a script in this workbook" or
  `A form from the package "<name>"`, with " — opened by <caller>" for a proxied show (the
  `provenance` memo); `Sheet: <pinned>` at restricted tier; "Preview — nothing will be written" in
  preview mode (`S.PreviewBanner`). `spec.title` is BODY content below the band (`S.ScriptTitle`).

  **Provenance is STRUCTURAL, not a magic string** (2026-09-03). The payload field is
  `ScriptFormRequestPayload.origin`, a `FormOrigin` = `{ kind: "local" } | { kind: "package"; name }`
  (`scriptFormSpec.ts`), and the `provenance` memo branches on `kind`. It used to be one string,
  `scriptOrigin`, in which the value `"local"` was the sentinel for this workbook and every OTHER
  value was a package name — so an application PUBLISHED UNDER THE NAME `local` was told to the
  user as "A form from a script in this workbook", which is precisely the impersonation the band
  exists to prevent, reached by choosing a name. Every producer is structural now: the two mount
  paths go through `formOriginForMount(definition)` (`scriptFormSpec.ts`), which reads
  `definition.provenance` — not the name, and not `handle.origin`, which collapses the same two
  cases the same way — while `scriptFormPreview.ts` takes the origin from its caller
  (`FormLayoutPreviewRequest.origin`). Pinned by `scriptFormDialog.test.tsx` `"still says PACKAGE
  for an application literally named \"local\""` and `scriptFormSpec.test.ts`
  `describe("formOriginForMount")`.
- **Geometry.** `useDialogWindow({ minWidth: 360, minHeight: 200 })` for drag and resize;
  width `clamp(spec.width ?? DEFAULT_FORM_WIDTH, MIN_FORM_WIDTH, min(MAX_FORM_WIDTH, viewport − 64))`
  (the `width` memo); the body scrolls at `80vh` (`S.Body`).
- **Keyboard** (`onKeyDown`). Escape cancels. Enter submits unless `submitOnEnter: false`, or the
  target is a textarea, a button, a link, a multi-select, a listbox or a tab strip. Focus starts at
  `spec.focus` if that widget is usable, else the first enabled, non-read-only, non-formula input
  (the `autoFocusName` memo). Initial focus is issued as a focus REQUEST once on mount (the
  `initialFocusIssued` effect), not only as React's `autoFocus`, so a `spec.focus` on an inactive
  tab page brings that page forward; the attribute is disarmed afterwards so returning to a tab does
  not steal focus back. Cancel / Escape / the X / the backdrop / a `role: "cancel"` button all take
  the one `cancel` callback.
- **One terminal event.** Exactly one of submit / cancel leaves per session (`answered`); the only
  thing that re-arms it is the host REFUSING a submit — read from `detail.refused`, or inferred from
  `errors`/`message` (the PATCH effect's `refused` const). A bare refusal is given the host's own
  words, "The script did not accept these values." Bound widgets show the seed's `display` while
  untouched and the typed value once edited (`scriptFormDialog.test.tsx` `"shows the seed's display
  text while untouched, never as the value"`).

Pure state lives in `app/extensions/ScriptableObjects/lib/scriptFormState.ts`: `collectWidgets` /
`collectInputs`, `initialFormValues`, `coerceValue`, `validateFormValues`, `buildFormResult`,
`applyFormPatch`, `dirtySet`, `sameFormValue`, `containerSuppressed`.

## 11. Preview and the editor flow

The preview harness serves `form.define` by RECORDING the spec on its backend state
(`scriptPreview/backend.ts` `case "form.define"`, storing into `PreviewBackendState.formLayout`); without
that case every preview of a form script would be `declined`. `form.show` is the one capability
refusal a form preview EXPECTS: it neither declines the run nor reads as a finding
(`scriptPreview/index.ts` `isExpectedFormRefusal`), and the report carries a note — "the form's
layout was captured from form.define; show() is not exercised in a preview" or "no layout was
captured: the script never called form.define during setup". The captured layout leaves as
`WorkerPreviewReport.formLayout` (`scriptPreview/report.ts`), deliberately NOT on the Rust-pinned
`DryRunReport` (see that interface's own doc comment). Preview hook payloads are keyed
`objectType.hook` so a form's `onClick` is a widget click and never a button's `{ x, y }`
(`scriptPreview/runShape.ts` `SYNTHESIZABLE_HOOK_PAYLOADS_BY_TYPE`; the host's
`SIMULATED_HOOK_PAYLOADS` mirror in `host.ts`).

**Range-fed content is resolved by the RUNG, not by the caller** (added 2026-09-03):
`resolveFormSourcesFromPreviewGrid` (`scriptPreview/formSources.ts`) reads `options: { range }` and
a table's `rows: { range }` against the same grid copy the run used, and the answer leaves as
`WorkerPreviewReport.formSources` (`PreviewFormSourceSeed[]`). It cannot be done outside the rung:
the copy never leaves it, so a caller re-reading those ranges would be reading the LIVE workbook and
seeding a dropdown with data the script never saw. Images are declined with a reason
(`PREVIEW_IMAGE_REASON`), as are off-sheet ranges (`offSheetSourceReason`).

**The rung reports three more facts as FIELDS, because only it holds them** (added 2026-09-03,
`scriptPreview/report.ts` `WorkerPreviewReport`, all set in `scriptPreview/index.ts` beside
`formLayout` / `formSources`, and all deliberately off the Rust-pinned `DryRunReport`):

- `activeSheetName` — the name of the ONE sheet the copy is of. `planFormPreviewSeeds` compares a
  cell `bind`'s sheet reference against it with `formSources.ts`' own `namesTheActiveSheet`, so
  `bind: "Sheet1!B2"` while Sheet1 is active now resolves exactly as
  `options: { range: "Sheet1!A1:A3" }` already did. Two rules for one question was one rule and one
  bug: the qualified bind previewed DISABLED as off-sheet while the identically-qualified range
  resolved. It fails CLOSED — with no name reported, every qualified reference stays unresolved,
  because assuming otherwise seeds a widget from a different sheet's cell at the same coordinates.
  Never a second live read: the active sheet can change between the run and the seeding.
- `readBackDisplays` (`PreviewCellDisplay[]`) — what each read-back cell EVALUATED to in the copy,
  beside `readBack`'s input string. The rung recalculates its copy at every settle point, so it
  usually knows; without this the value was thrown away between rung and seed and EVERY
  formula-bound widget previewed read-only saying "a preview does not compute its value", which is
  false. `buildFormPreviewSeeds` now passes it as `shapeOf`'s cached argument, so such a widget
  seeds exactly as a real `form.show` paints it — value, display and formula text. A cell with no
  computed value (one the script overwrote, or any cell of a truncated copy, where formulas are
  deliberately not re-evaluated) contributes no entry and keeps the refusal, whose wording now says
  what is actually true: "this run computed no value for".
- `formLayoutVerdict` (`"captured" | "missing"`) — what `formLayoutNote` reads. It used to SCAN
  `output` for the first `[preview]` line mentioning a layout, and `output` BEGINS with the script's
  own console lines, so a draft that logged `[preview] the layout is fine, click Run` chose the
  sentence the editor and the package inspector then displayed about it. The wording of both the
  verdict and the transcript line comes from `PREVIEW_FORM_LAYOUT_NOTES` (`report.ts`), one table.

`FormPreviewSeedPlan.resolved` also carries each binding's `multi`, and `buildFormPreviewSeeds`
passes it at the `seedFromCell` call the way production's `readFormCell` does. Without it a
multi-select listbox was seeded with one joined string while the renderer holds a list — the shape
mismatch that makes an untouched listbox read as DIRTY and truncate its cell on submit.

The renderer has a preview MODE: with `request.preview`, Submit paints a "what would be written"
list instead of emitting `submit`, and Close cancels (`ScriptFormDialog.tsx`: the `preview` const,
the `preview` branch of `submit`, and the `previewRows` render). **The two are now connected.** The
earlier statement here that "nothing connects the two yet" is no longer true:

- `app/src/api/scriptFormPreview.ts` `previewFormLayout` is the one procedure. It runs the draft
  through `previewObjectScript` (setup only), and runs it TWICE when the layout binds cells — the
  bindings are unknown until the layout exists, so the second run asks the rung to read exactly
  those cells back out of its own copy. It then merges four seed sources in one order
  (`buildFormPreviewSeeds`: range-fed content, then read-back cell values, then live control values,
  then everything a preview cannot reach) and calls `showScriptForm({ …, preview: true })` under a
  `preview:` identity, with deps that reach no worker. `planFormPreviewSeeds` decides what is
  reachable; `PREVIEW_UNRESOLVED_REASON` is the reason every unbound widget carries.
- The Object Script Editor's **Preview form** action goes through
  `extensions/ScriptableObjects/lib/formPreviewBridge.ts`, which is only the Tauri wire between the
  editor window and the main one plus the per-script status the editor renders
  (`installFormPreviewBridge` in the main window, `installFormPreviewClient` /
  `requestFormPreview` / `formPreviewStateFor` in the editor). Both `ObjectScriptEditorApp.tsx` and
  the in-window `CodeEditorDialog.tsx` carry the button.
- The **package inspector** uses the same `previewFormLayout` for a form inside an unconsented
  `.calp` — but **not from its own window**, and that was rebuilt on 2026-09-03 because the first
  version could never paint at all. The Application Inspector is a standalone Tauri window
  (`app/src/packageInspectorMain.tsx`, label `"package-inspector"`) that mounts
  `ApplicationInspectorApp` and deliberately loads no Shell, so no extension is activated in it and
  nothing there listens for `SCRIPT_FORM_REQUEST_EVENT`; a `previewFormLayout` called inside it
  emitted a request no renderer heard, and the show died ten seconds later on
  `FORM_SHOWN_ACK_TIMEOUT_MS`. The **wire** now crosses the windows instead of the call:
  `InspectorFormPreviewEvents.REQUEST` / `.RESULT` on the existing inspector seam
  (`Distribution/lib/inspectorWindowEvents.ts`, beside `package-inspector:open-package`), with
  `Distribution/lib/inspectorFormPreview.ts` holding both halves —
  `installInspectorFormPreviewBridge` (registered in the Distribution extension's `activate`, torn
  down in `deactivate`) runs `previewFormLayout` and paints in the MAIN window;
  `installInspectorFormPreviewClient` (`ApplicationInspectorApp`) hears the outcome and
  `requestInspectorFormPreview` / `inspectorPreviewStateFor` render it inline beside the action.
  The arguments that matter are `readControls: false` and
  `origin: { kind: "package", name }` — so a `{ control }` binding is never answered out of the
  inspecting workbook's live Controls pane, and no application name can make the band claim the
  form is local. No replay store, unlike the editor's bridge: a reopened inspector starts at the
  workspace picker with no script rows on screen, so there is nowhere for a replayed note to land;
  what IS wired is the close, so the note clears rather than claiming an open form.
  What the reviewer is told, before the click, is now what happens: the dialog opens **in the main
  window, behind this one**, and the application's `setup` **is run** — sandboxed (empty ceiling,
  nothing mounted, a throwaway copy of the active sheet), which is the actual guarantee. The
  earlier hint said "Nothing is run", which was false.
- **The "forms only" gate is a relevance filter, not a boundary.** `s.objectType === "form"`
  (`inspector/ScriptsSection.tsx`) reads a field the PUBLISHER wrote into their own manifest, so
  nothing downstream may rely on it having been true; the object-scripts card says so to the
  reviewer, and the gate's own comment says so to the next reader. What bounds the run for ANY
  source is the rung: `buildPreviewHandle` (`broker.ts`) with an empty declared-capability ceiling
  and empty grants, no mount, a copy of the sheet as the whole backend, no audit rows.

Run (F5) opens a debug session, which REMOUNTS the script; the unmount sweep closes any open form
first (`host.ts` `hostUnmountScript` calls `revokeScriptForms`), and `setup` re-running
`form.define` is legal because a define while a session is open replaces the layout for the NEXT
show only (`scriptForms.ts` `defineScriptForm`, and the copy of the spec the session holds).

Typings: the prose lives in `objectContexts.template.d.ts`; `probeShim.ts` maps
`["form", "FormContext"]` (`OBJECT_TYPE_INTERFACES`) and `["control()", "FormControlHandle"]` /
`["caps.forms", "ScriptFormsApi"]` (`NAMED_SUBTREES`); `npm run gen:script-typings` regenerates
`objectContexts.d.ts`, `generated/scriptSurfacePolicy.ts` and `generated/scriptSurfaceSlices.ts`,
and `npm run gen:canary-tasks` regenerates `generated/canaryTasks.ts` from `tests/eval/tasks.json`.

## 12. The tests that pin each rule

| rule | test |
|---|---|
| Vocabulary has no `html`; limits 200 / 8 / 64 / 500 are the boundary cases; hostile depth and width do not recurse; duplicate, reserved and non-identifier names; unknown keys and types by name; regex `pattern` refused; `image.src` is a media handle or `""`; binding shapes; per-widget bounds | `app/src/api/scriptHost/__tests__/scriptFormSpec.test.ts` |
| Data-only request with HOST identity; resolves on "shown"; every no-answer path is `null` and closes once; a BARE refusal still says "refused"; script close; CONTENT seeds survive for `table`/`image`; debounced text vs discrete changes; update bucket; seeds vs `initial`; write BEFORE close and refused write keeps the form open; `opened` fires on ack; `writeOn: "change"`; cell-underneath refresh with `source: "cell"`; the form's own write-back does NOT echo back; a user-edited widget keeps its value | `scriptForms.test.ts`, `describe("scriptForms — sessions")` and `describe("scriptForms — bindings (the host's write-back callbacks)")` |
| One per script / one app-wide / refused while a DIALOG holds the slot; three cancels mute, a submit resets; a close NOBODY chose leaves the streak alone; 20-per-minute bucket | `scriptForms.test.ts`, `describe("scriptForms — guards shared with dialogs")` |
| A refused show performs NO reads at all: no layout, exhausted bucket, muted script, held slot; the thunk runs after the claim and before painting; a throwing thunk gives the slot back; an unmount during the reads refuses the show — of the OWNER, and, for a cross-script show, of the CALLER awaiting the answer | `scriptForms.test.ts`, `describe("scriptForms — a refused show reads nothing")` |
| Ack timeout; idle and absolute deadlines; owner and CALLER unmount sweeps; reset | `scriptForms.test.ts`, `describe("scriptForms — deadlines and sweeps")` |
| `parseFormBinding` forms; sources only when named; seeds from the TYPED value (currency cell → number); formula kept; ISO dates; boolean coercion; listbox split; control seeds read-only; `cellWriteFor` never the display string; untouched currency cell not dirty; `""`/`null` agree; `sheetIdentityRefusal` | `scriptFormBindings.test.ts` |
| `normalizeFormSubmitVerdict` accept/cancel/errors-kept; form preview payloads are widget-shaped | `formSubmitVerdict.test.ts` |
| `hostUnmountScript` and `hostResetAll` call the sweeps; every form row has its `executeImpl` case; debugger resume cannot restart the clock under an open form; the answer relay asks the REALM, not the `mounted` map (all source-reading, with a non-vacuity case) | `formUnmountSweep.test.ts` |
| The live watch's Controls-pane subscription dies with the form: a form closed BEFORE the dynamic import settles leaves no listener behind, one that stays open keeps its subscription until IT closes, and a form with no `{ control }` binding never subscribes at all | `formLiveWatchDisposal.test.ts` |
| Every show/update/close row needs `ui.dialog`, define needs none, the control read is a broker row, the two ui-class rows are exactly the person-answered ones, descs promise "dialog"/"answer", `form.show` names its cell reach AND its `writeOn: "change"` reach, the user-facing `ui.dialog` sentences are unchanged (reads the real files) | `formConsentHonesty.test.ts` |
| ui-family list gains `cap.formsShow` and `form.show`; the deadline table follows | `scriptDialogs.test.ts`, `describe("ui method class")` → `it("is exactly the ui.dialog family")` |
| All capability-bearing rows classified for audit | `capabilityAuditClassification.test.ts` |
| Every row has validator + host case + shim caller (`form.readControl` is listed in `ROWS_WITH_NO_SHIM_CALLER`) | `allowlistCoverage.test.ts` |
| Tree walking, initial values (seed wins, coerced per type), options, declarative validation (no script pattern), typed result, patches, the currency-trap dirty set, containers suppress their children | `extensions/ScriptableObjects/__tests__/scriptFormState.test.ts` |
| Every widget renders and emits; "shown" once; display shown while untouched; `spec.focus`; band = script name + host provenance and the title NEVER enters it; package and proxied bands; typed change payloads; required blocks; Enter/Escape semantics; the X / footer / backdrop cancel; patch with errors re-arms; foreign showId ignored; refreshed seeds skip touched widgets; preview mode never emits submit; images only from `imageUrl` | `scriptFormDialog.test.tsx` |
| The shared preview procedure: seed planning, the two-pass read-back, the four-source merge, control seeds; the listbox `multi` seed SHAPE; an active-sheet-qualified bind (and failing closed with no name); a formula seeded from the run's computed value; the layout note taken from the field and never from a line the script printed | `app/src/api/scriptHost/scriptPreview/__tests__/scriptFormPreview.test.ts` |
| The rung's own three fields — `activeSheetName`, `readBackDisplays` (omitted for a cell it computed nothing for), `formLayoutVerdict` — driven through the real snapshot, preview grid, substituted backend and report builder with only the Worker realm doubled | `app/src/api/scriptHost/scriptPreview/__tests__/previewFormReport.test.ts` |
| The editor's Preview form bridge (request/result/dismiss, replay on EDITOR_READY, the English of each status) | `extensions/ScriptableObjects/__tests__/formPreviewBridge.test.ts`, `objectScriptEditorFormPreview.test.tsx` |
| The inspector's Preview layout action: forms only, the declared type named as a CLAIM, the hint that admits setup is run and says which window, the request going over the wire instead of the core being called in a window that cannot paint, each answer rendered inline, the note cleared on close | `extensions/Distribution/__tests__/inspectorFormPreview.test.tsx` |
| Its MAIN-window half: `readControls: false`, a package origin an application NAMED "local" cannot collapse, every outcome answered (shown/closed/each failure/a thrown core), the wire, the teardown, and the status store (application-scoped key, superseded results ignored, a bounded wait when the main window never answers) | `extensions/Distribution/__tests__/inspectorFormPreviewBridge.test.ts` |
| `formOriginForMount` reads `provenance`, never the package name; the nameless-package placeholder matches the trust handle's | `src/api/scriptHost/__tests__/scriptFormSpec.test.ts`, `describe("formOriginForMount")` |
| The band says PACKAGE for an application literally named "local" | `scriptFormDialog.test.tsx`, `it("still says PACKAGE for an application literally named \"local\"")` |
| Generated typings lockstep (686 chains / 743 entries with the form type) | `objectContextsTypings.test.ts`, `it("keeps one slice entry per DISTINCT DECLARATION, covering every declaration site")` |
| `DRAFT_OBJECT_TYPES` matches `mcp/drafts.rs` exactly, in order | `extensions/AIChat/__tests__/chatToolSurface.test.ts`, `it("matches VALID_OBJECT_TYPES in mcp/drafts.rs exactly, in order")` |
| `PREFERRED_HOOK_BY_TYPE.form` honest about the live surface | `scriptTemplate.test.ts`, `describe("PREFERRED_HOOK_BY_TYPE is honest about the live surface")` |
| Rust `Form` round-trips through the `.cala` def | `core/calcula-format/src/features/object_scripts.rs`, `fn form_object_type_round_trips_through_the_cala_def` |

### The journeys, RUN (2026-09-03)

Mount-level behaviour is not left to unit tests. Twenty-six journey tests pass against the running
app — a real Worker realm, the real consent gate, a real undo transaction:

| journey | what it proves |
|---|---|
| `app/e2e/journeys/script-form.spec.ts` (9) | Insert > Form mints a UUID `instanceId`; the band names the script and the pinned sheet; a required field blocks Submit and writes nothing; Enter writes the TYPED values of the dirty widgets and ONE undo reverts them all (with a second-edit positive control, so "one undo" is not vacuous); Escape resolves `null` and writes nothing; an `onSubmit` verdict keeps the form open; a cell changed by another script updates the widget while it is open; a second script's `caps.dialog.alert` is refused while the form holds the slot; and a button script's `caps.forms.show` is held open 33 s — past the 30 s relay deadline — and still receives the answers |
| `script-form-distributed.spec.ts` (2) | a `.calp` carrying a form and a button: DECLINED, nothing is painted, neither script mounts and `ui.dialog` is not in the grant set; then APPROVED, the band names the package and a `Sheet2` binding renders disabled with its reason. The first journey in the tree that publishes a `.calp` containing object scripts |
| `script-preview.spec.ts` (15, one new) | the editor's Preview form paints the captured layout, Submit lists what WOULD be written, and nothing is mounted, written, dirtied or audited |

Running them found one defect — in the SPEC, not the product: the consent prompt was asserted with
`capabilities.ts`'s sentence while that surface renders the ScriptableObjects one. Three distinct
`ui.dialog` wordings exist across four files, and `formConsentHonesty.test.ts` pins all four
locations verbatim.

## 13. Where the code differs from the plan

- Restricted-tier **reads** pass an EXPLICIT sheet index to `sheet.getCellData` so the clamp refuses
  a foreign sheet by name; the plan said reads pass none. Writes pass none, as planned, which is why
  the pinned-sheet check exists.
- The live watch coalesces on a **16 ms `setTimeout`**, not a `requestAnimationFrame`.
- `DryRunReport` did not gain `formLayout`; it lives on `WorkerPreviewReport` only
  (`scriptPreview/report.ts`), because that interface is pinned field-for-field to the Rust struct
  and the interpreter realm has no `form.define` to capture. `formSources` was added to the same
  interface, for the same reason.
- No friendly "Form" label was added where object types are displayed; the Subscribe dialog prints
  the raw `objectType`.
- The submit-verdict racer is pinned by `formSubmitVerdict.test.ts`, not by an addition to
  `hookEventDelivery.test.ts`; the race's timeout path itself has no timer-driven unit test.
- One extra ALLOWLIST row exists that the plan did not name: **`form.readControl`**, capability-free
  and class `read`, the audited door for a `{ control }` binding (§8). It is host-driven, so it is
  listed in `ROWS_WITH_NO_SHIM_CALLER` beside `formula.udf.invoke`.
- The plan's "Preview form" toolbar action and `lib/formPreviewBridge.ts` were NOT built for
  release one; they landed on 2026-09-03 together with the shared `app/src/api/scriptFormPreview.ts`
  and an inspector surface the plan never asked for (§11).

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

One confirmed finding was left unfixed at the time and recorded in `open-items.md` §2.ab: the
bound-cell reads happened before the show guards, so a refused show still read the sheet. **That has
since been fixed** — `form.show` and `cap.formsShow` now hand `showScriptForm` a `resolve` thunk it
awaits only after every guard has passed and the modal slot is claimed (§8, step 1), pinned by
`describe("scriptForms — a refused show reads nothing")` in `scriptForms.test.ts`. Its row in
`open-items.md` §2.ab now reads **CLOSED 2026-09-03**, as does the inspector-preview row beside it;
neither is stale any longer.

**A note on reading the verdicts.** Several findings were marked "refuted" by their skeptics because
they were fixed WHILE the skeptics were reading, and the refutation cites the fix. A verdict is
about the code at the moment it was read, not about whether the defect was ever real.

## 13b. The second review pass — nine more findings, all fixed 2026-09-03

A second read of the built feature — provenance, the inspector surface, the preview rung, the
host's session bookkeeping — found nine defects after §13a's twenty. All nine are fixed, each with
a test (§12), and each is described in the section that owns it. Most repeat §13a's pattern exactly:
two components, each locally reasonable, disagreeing about a shared rule — which FIELD carries a
verdict, which SET a filter belongs to, which SCRIPT a claim answers to.

| What broke | Why it was invisible |
|---|---|
| an application published under the name `local` made the identity band say "A form from a script in this workbook" | provenance was a magic string, `scriptOrigin`, whose sentinel for "this workbook" was also a legal package name — the impersonation the band exists to prevent, reached by choosing a name. It is a discriminated `FormOrigin` now and nothing a publisher can type ever lands in `kind` (§10) |
| the package inspector's **Preview layout** painted nothing, then failed ten seconds later | the Application Inspector is a Tauri window that mounts no Shell, so no extension is activated in it and `SCRIPT_FORM_REQUEST_EVENT` reached no renderer; the show died on `FORM_SHOWN_ACK_TIMEOUT_MS`. The WIRE crosses the windows now, not the call (§11) |
| a multi-select listbox previewed as one joined string | `FormPreviewSeedPlan.resolved` dropped the binding's `multi`, so the preview seeded a SHAPE the renderer does not hold — the same mismatch that makes an untouched listbox read as DIRTY and truncate its cell on submit (§11) |
| `bind: "Sheet1!B2"` previewed DISABLED as off-sheet while `options: { range: "Sheet1!A1:A3" }` resolved | two rules for one question. Both ask `namesTheActiveSheet` against the rung's own `activeSheetName` now, and fail CLOSED when the run named no sheet (§11) |
| every formula-bound widget previewed read-only saying "a preview does not compute its value" | the rung HAD computed it and the value was thrown away between report and seed. It rides on `readBackDisplays`, and the refusal that remains says what is true: "this run computed no value for" (§11) |
| a draft that logged `[preview] the layout is fine, click Run` chose the sentence the editor and the inspector then displayed about it | the note was recovered by SCANNING the run's `output`, which begins with the script's own console lines — an untrusted script authoring host chrome. It is a report FIELD now, `formLayoutVerdict`, worded from `PREVIEW_FORM_LAYOUT_NOTES` (§11) |
| a cross-script show outlived the caller awaiting it: a form painted for code that no longer existed, its answer sent nowhere | `pendingShows` was keyed and matched on the OWNER only, while an open session had always closed on either script's unmount. The claim records `callerScriptId` and `dropPendingShow` matches both (§8, step 1) |
| a form closed in the same turn it opened left a Controls-pane listener firing for the rest of the session | the subscription arrives through a dynamic import, so the cleanup ran BEFORE the `.then` that created it, against a still-empty `unsubControls`. `disposed` is the fact the `.then` has to ask about (§8, step 5) |
| `rows: { range: "D2:E9" }` resolved the range and then painted an EMPTY table | the seed merge filtered the whole seed through `FORM_INPUT_TYPE_SET`, and `table` / `image` are not input types — so the host discarded exactly the content it had just gone and read. Only the VALUE half is input-only (§8, step 2) |

## 14. Later milestones and their prerequisites

Each is additive on the release-one seam; each has defects to close FIRST. The rows below are also
in `docs/design/open-items.md` §2.ab.

- **M2 — modeless floating window and task pane.** Needs a NEW capability id (`ui.pane`), because
  "a dialog you must answer or close before continuing" would be false: `ALL_CAPABILITY_IDS`
  (`capabilityIds.ts`), `CAP_DESCRIPTION` (`capabilities.ts`), the three phrase tables
  (`SubscribeDialog.tsx` `CAPABILITY_PHRASE`, `inspector/ScriptsSection.tsx` `CAPABILITY_PHRASE`,
  `ScriptableObjects/index.ts` `CAPABILITY_DESCRIPTION`), `BROKER_AUDITED_CAPABILITY_METHODS`
  (`broker.ts`), the `scriptSurfaces.ts` rows, and Rust `KNOWN_CAPABILITY_IDS`
  (`core/persistence/src/lib.rs`). Sessions become script-visible instances (the shim already
  keys waiters by `showId` — `contextShims.ts` `formWaiters` / `awaitFormAnswer`). Real event
  backpressure: `EVENT_QUEUE_HIGH_WATER` is declared in `protocol.ts` and read nowhere. A panel
  host: `ExtensionPanelHost` in `docs/design/third-party-addin-authoring.md` §4.6 was never built.
- **M3 — on-grid embedding.** The `ui.html` frame is permanently `pointer-events: none`
  (`extensions/Controls/Shape/shapeRenderer.ts`, in `updateHtmlOverlay`); on-grid controls have no
  reachable right-click menu (`open-items.md` §2.x); anchor-derived control ids lose their script on
  copy (`createForm.ts` header CONTEXT note), so the form's minted-UUID identity must carry over.
- **M4 — third-party `form` contribution kind.** `EXTENSION_CONTRIBUTION_KINDS`
  (`app/src/api/scriptHost/extensionProtocol.ts`) plus a required capability and a
  `CONTRIBUTION_REACH_NOTE` entry; the extension realm has no cell API — its `grid` namespace offers
  only `cellStyles` and refuses the rest (`worker/extensionWorkerContext.ts`, the `grid` member) —
  so bound reads need `grid.read` and bound writes need a new gated door or forms stay read-only
  there; `EXTENSION_BROKER_METHODS` and `extensionReachableCapabilities`
  (`shell/registries/extensionTrust.ts`) updated honestly.
- **M5 — drag-and-drop designer.** A TypeScript-AST reader/writer for the `#region` block
  (`scriptableObjectScaffolds.ts` `getScaffoldTemplate` `case "form"`; the transpiler already loads
  `typescript` on demand — `app/src/api/scriptTranspile.ts`, its lazy `import("typescript")` — and
  ONE ARTIFACT is its rule, stated in that file's header), round-trip tests that only that block
  changes and `// @capability` pragmas stay byte-identical, `LiveModulePersister` integration
  (`ScriptableObjects/lib/liveModuleBuffer.ts`), `_shared/components/useDragDrop.ts`.
- **M6 — isolated HTML/CSS apps.** Prove the srcdoc bridge executes under the Tauri CSP, or serve
  app documents from a Rust custom URI scheme with their own origin; extract the duplicated bridge
  (`shapeRenderer.ts` `buildIframeSrcDoc` vs `ControlsPane/components/CustomControlHost.tsx`
  `buildIframeSrcDoc` — the duplication is declared in that file's header CONTEXT note); e2e
  coverage of a user gesture reaching the bridge; theme-token injection and size negotiation; a
  distinct consent id; a memory watchdog and an iframe cap; asset residence under "reference media,
  never introduce bytes"; only then does `{ type: "html" }` (`scriptFormSpec.ts`
  `FORM_WIDGET_TYPES` and its doc comment; `validators.ts` `checkFormWidget`) become legal.

## 15. Related documents

- `docs/design/scriptable-objects.md` — the object model this type joins (its "UserForms" row now
  points here).
- `docs/design/scripting-vba-review.md` §9 — what is closed and what still trails.
- `docs/design/script-sandbox-architecture.md` — tiers, capabilities, the broker.
- `docs/design/open-items.md` §2.ab — the follow-ups. The two rows that WERE stale in the
  already-fixed direction (the inspector layout view, and the read-before-guards ordering) now read
  CLOSED, as do the range-fed preview seeding and the `writeOn: "change"` echo. What is still open
  there is M2–M6 (§14) plus one doc-drift row about `CLAUDE.md`'s `.cala` format version, which the
  forms work did not touch (§3).
