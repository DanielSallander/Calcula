# Open decisions — August 2026

Written 2026-08-07 at the close of the VBA-idiom parity program, the hidden-rows fix, the
visual-suite restoration and the dirty-flag census. Everything here is either a **product
decision that needs an owner** or a **scoped proposal awaiting a go/no-go**. Nothing here is
work in progress.

Status of the things that are *done* lives elsewhere: `docs/design/scripting-vba-review.md`
(§7 items 26-29 for the idiom waves).

---

## 1. Shapes and pictures — the deferred Wave-5 item

This was deferred as "VBA parity: `Shapes.AddShape` / `Shapes.AddPicture`". That framing
undersells it. The **report-distribution vision needs it**: a published `.calp` report with no
logo is not a report anyone sends to a customer. Recommend re-scoping it as a distribution
feature, not a scripting one.

The two halves have very different costs and should be decided separately.

### 1a. Shapes — COMPLETE 2026-08-07 (seam, recipe, script rows; frontend only, no new Tauri command)

Manipulating an *existing* shape already worked from scripts (`setProperty`, including `text`).
What was missing was creation and deletion, because `IControlStoreService`
(`app/src/api/componentStoreRegistry.ts:139`) was **list-only**.

**`@api/controlsService` shipped as a SIBLING of `buttonControlService` / `pictureControlService`,
not as a widening of either**, and that was the first real decision. The three control types have
disjoint property sets, and the button options are not merely extra fields — they are *behavioural
contracts*: `onSelect` is inline source the click path feeds to the QuickJS module runtime, and
`macroRef` is a LINK (not a copy) re-resolved on every click. Neither means anything for a
rectangle, and putting them in front of a caller that must never reach them is how a seam becomes a
hazard. Same shape as its siblings: provider interface, `registerControlsProvider` returning an
identity-checked unregister closure, `hasControlsProvider`, and a **throwing**
`requireControlsProvider` — refusing loudly beats reporting a success that draws nothing.

Surface: `listShapeCatalog()`, `createShape(req)`, `deleteControl(instanceId)`, and `listControls`,
which **moved here** from `IControlStoreService` (one consumer, `host.ts`'s
`listWorkbookObjects("shape")`, so widening broke nothing). `IControlStoreService` is deleted; the
registry's doc comment — *"Read-only: creating a control is a canvas-placement gesture, not a data
operation"* — is replaced by the correction, because it was never a principle. It was a description
of a missing feature. Placing a shape from a script writes persisted metadata that travels in the
saved `.cala` and in published `.calp` artifacts; that is a data operation.

One read/write asymmetry is deliberate and pinned: `listWorkbookObjects` takes `getControlsProvider`
(null → empty list, because for a READ "the extension is not loaded" and "there are no controls" are
the same honest answer), while both mutations take the throwing accessor.

**THE RECIPE — the part a naive version gets wrong.** `createShapeControlAt` is extracted out of
`insertShape` so there is **one recipe and two callers**, exactly as `createButtonControlAt` already
was. A correct shape is **17 property keys**, every value a string, and three of them are
load-bearing in ways nobody guesses:

- **`pinToGrid` is written EXPLICITLY as `"false"`.** `moves_with_cells` (`controls.rs:64-69`)
  defaults an ABSENT property to **true** — right for in-cell controls — so omitting it makes the
  backend shift the anchor on the first row insert while the frontend holds its pixels. Divergence
  on the very first structural edit, silently.
- **The caption is `text`, never `label`.** That write SUCCEEDS and draws an empty shape; it is the
  original invisible-control bug.
- **`x`/`y` are a per-column/per-row WALK** (`cellOriginPixels`), never a multiplication — widths and
  heights are irregular the moment a user resizes anything.

`insertShape` **omitted `invalidateShapeCache`**; the shared recipe includes it (the shape renderer
caches its bitmap by control id, so a fresh control at a recycled id repainted the OLD shape). The
handle returned carries `instanceId`, so no caller re-derives `control-{s}-{r}-{c}`; the inverse,
`parseFloatingControlId`, was added **next to** `makeFloatingControlId` so the format keeps one home
per side of the seam (`controlSheetFromInstanceId` is the host's).

**Two refusals replace two silent wrongs.** `getShapeDefinition` missing used to `return` — it now
THROWS with every accepted id, which is also how the catalog is discovered: **123 shapes in 8
categories** stay out of the consent string entirely. And an occupied anchor is REFUSED rather than
overwritten: `set_control_metadata` is a plain map insert, so creating over an existing control
wiped it *and* left its object script bound to the anchor for the newcomer to inherit.

**TWO PRE-EXISTING DEFECTS FIXED ALONGSIDE.**

- **A control's object script was ORPHANED on delete.** `deleteFloatingControl` gated
  `deleteObjectScriptsForInstance` (and the declared properties, custom renderer, HTML overlay and
  has-script mark) on `controlType === "shape"`. Since an instanceId derives from the ANCHOR, a
  button deleted at B3 left `control-0-2-1`'s script behind and the next control created there
  **silently inherited it** — code its author never wrote, running on their click. The cleanup is now
  unconditional; deleting an absent entry is a no-op for every one of those tables, so the honest
  gate is no gate. `deleteControl` routes to `deleteFloatingControl`, **never** to
  `removeButtonControlAt`, which is the button seam's ROLLBACK and deliberately skips script cleanup,
  declared properties, the HTML overlay, the selection and the Properties pane.
- **Controls were loaded ONCE, at activation, for the sheet that happened to be active.** The
  document half (`AFTER_OPEN` / `AFTER_NEW`) had landed with §1b; the **sheet** half had not, and it
  was worse than stale: `syncFloatingControlRegions` is sheet-BLIND (it publishes an overlay region
  for every store entry, with no sheet filter), so sheet 1's controls kept painting over every other
  sheet and a click on one of those phantoms edited a control the user was not looking at, while the
  other sheet's controls never appeared at all. `SHEET_CHANGED` now swaps the store, one sheet at a
  time. The departing sheet is **tracked** (`loadedSheetIndex`), not derived — SHEET_CHANGED reports
  the sheet being switched TO. Both reloaders share ONE promise queue, because
  `announceBackendStateReplaced()` correctly emits SHEET_CHANGED *as well as* AFTER_OPEN and the
  outcome must not depend on which await resolved first. Picture caches are INVALIDATED here, never
  released: blob URLs are keyed by content hash and the controls come straight back, so revoking
  would re-pull every image's bytes on every sheet-tab click. (AFTER_OPEN still releases — a handle
  from the closed document cannot resolve.)

**Two script rows, no new capability id, no new Tauri command.**
`api.createShape(catalogId, anchor, {width?, height?, text?, name?})` and `api.deleteShape(id)`, both
**unlocked / `class: "mutate"` / no capability**, matching `api.createChart` and `api.createTable`.
The reason is the SHAPE of the call: the only thing named is a catalog id, so there is no bytes,
path, URL or source-code parameter to refuse — `onSelect` and `macroRef` are not options and never
will be, since a sandboxed script that could write either would be authoring code that later runs in
a wider trust class than its own. **Active sheet only** (`api.createTable`'s rule for its reason:
geometry comes from the live sheet's dimensions and the overlay regions are sheet-blind);
`deleteShape` enforces it by reading the sheet **out of the id** rather than taking a sheet argument,
and reuses `vObjectId`. `vCreateShape` bounds width/height at **10..20,000 px — the same bound
`checkChartPlacementProps`/`vCreatePicture` use**, one decision across three rows — and bounds `text`
at `MAX_SHAPE_PROPERTY_CHARS`, the same number a later `shape.setProperty` gets.

Both rows say **plainly in their `desc:` that they are NOT undoable**, because they are not: control
create/delete records no undo entry at all (`controls.rs` writes under a `DocumentEffect` and never
calls `record_cell_change`). That is the honest state, not a claim that it is fine.

`name` accepted a value it could never show: it had a READER (`listControls` →
`api.listObjects("shape")`) and **no writer anywhere**, so the object list showed a permanently-empty
name. A `PropertyDefinition` for it is in `SHAPE_PROPERTIES` in the same change.

**Still open, honestly.** Create and delete are not undoable, and closing that means giving control
mutations a real undo transaction in Rust — out of scope for a frontend-only pass, and stated in the
consent text meanwhile. `deleteControl` refuses an IN-CELL (embedded) button rather than removing it:
that one is a cell-FORMATTING operation, and pretending otherwise would delete metadata while leaving
the cell styled as a button. `listControls` is still per sheet, so `api.listObjects("shape")` costs
one round trip per sheet.

**THREE RESIDUES CLOSED AT INTEGRATION (2026-08-07), all in the same file.**

- **The STARTUP load was not on the reload queue.** Activation called `loadFloatingControls()`
  free-floating while the two reloaders shared a promise chain — so the serialisation that makes
  AFTER_OPEN and SHEET_CHANGED deterministic did not cover the one load that races them. A workbook
  restored at startup emits both while that first read is still in flight, and the outcome depended
  on which IPC round trip returned first. The queue is now **seeded with** the startup load, so
  activation is its first link and the last write wins by ORDER rather than by timing. (Duplicate
  entries were never possible — `addFloatingControl` filters its own id first — so the symptom was a
  stale sheet, not a doubled one.)
- **A control on ANOTHER SHEET was reported as an in-cell control.** The floating store holds one
  sheet at a time, so `deleteControlByInstanceId`'s store miss means two different things, and both
  fell through to *"this is an in-cell control — clear the cell to remove one"*. That is a confident
  wrong answer to a question the caller never asked. The script door never reached it
  (`assertActiveSheet` runs first in `host.ts`), but the seam is public and the next caller would
  have. The two cases are now separated, cross-sheet first, naming the sheet and the fix.
- **The embedded predicate had two spellings.** The rule deciding what enters the floating store was
  open-coded in `loadFloatingControls`, and the delete refusal needed the same rule. Two copies that
  disagree would refuse a control with a reason that does not describe it, silently — so it is one
  `isEmbeddedControl(controlType, properties)` with two callers, pinned by a test that counts them.

**Verification.** `check-types`, `lint:boundaries`, `check:script-typings` (39 interfaces / **736**
members, up from 734 — the two new rows) all clean; full vitest green (**729 files / 105,967**, from
723 / 105,870: six new files carrying 96 tests, plus one in `controls-parameterized.test.ts`, whose
`it.each` over `SHAPE_PROPERTIES` gains a case from the new `name` row). Rust is untouched by this
work and every Rust baseline is unmoved: core **1,282**, script-engine **111**, app-lib **1,042**,
test_pivot **56**, both `cargo check`s clean. Tests:
`app/src/api/__tests__/controlsService.test.ts` (seam),
`app/extensions/Controls/__tests__/shapeCreation.test.ts` (catalog, recipe, both defects),
`app/src/api/scriptHost/__tests__/shapeScriptRows.test.ts` (rows + validator). The recipe and defect
assertions were **shown to have teeth by reinstating each defect one at a time** — dropping
`pinToGrid`, renaming `text` to `label`, removing the anchor-collision check, removing
`invalidateShapeCache`, restoring the `controlType === "shape"` script-cleanup gate and removing the
SHEET_CHANGED subscription each turn the suite red, at the assertion that names them. The three
integration fixes were proved the same way: un-seeding the queue fails *"puts the STARTUP load on the
same queue as the two reloaders"*; deleting the cross-sheet branch fails two tests; re-spelling the
embedded predicate inline fails *"is asked by both the loader and the delete path, never re-spelled"*.

**E2E COVERAGE — CLOSED 2026-08-08.** `app/e2e/journeys/shapes-hometab.spec.ts`, 8 tests in the
`journey` project (tests 6 and 8 wipe/reopen the document and reload the frontend, so it cannot live
in `e2e/tests`). It covers both §1a and §2a and it drives the PRODUCT, not the seam: real macros run
from the real Macro Library (Developer ▸ Macros ▸ Run), the real Insert ▸ Shapes gallery, the real
View menu and Customize dialog, the real Insert ▸ Controls ▸ Button, a real Design-Mode click and
Delete, and the app's own `newFile` / `openFileAtPath`.

The decisive oracles are RENDERED ones. A shape's presence is a canvas patch sampled through the
app's live geometry and asserted in BOTH directions (0 before the create, ~1.0 after, 0 after the
delete). A macro's outcome is the library's own `[data-macro-error]` / `[data-macro-output]` panes —
a run that neither errors nor prints `[OK]` is reported as a hang rather than passing. And a Home-tab
row break is measured as the number of distinct `getBoundingClientRect().top` values the group's
buttons occupy, which no stored setting can satisfy.

Covered: (1) `api.createShape` paints, its backend properties carry `pinToGrid: "false"` and `text`
(with no `label` key anywhere), the returned handle names the control that exists, and
`api.deleteShape` removes it from canvas AND backend; (2) a gallery shape and a script shape agree on
all **17** property keys and on every value except `x` (with the `x`-differs / `y`-matches pair
asserted so the exclusion is not vacuous); (3) `createShape("rectangel")` is refused with a message
naming the id and listing accepted ones, and no control is created anywhere on the sheet; (4) an
occupied anchor is refused and the first shape keeps its type and caption; (5) a button with a bound
object script, deleted with a real click + Delete, takes its script with it, and a NEW button at the
same anchor inherits nothing; (6) a shape survives save → `newFile` → reopen, and the other
workbook's control follows neither the canvas nor the inventory; (7) View ▸ "Customize Home Tab..."
opens the dialog and the ribbon still shows the seven default sections in order; (8) "Row Break" is
enabled, placeable, and the ribbon re-lays the Cells group into three rows — and Reset-then-Cancel
leaves the saved layout unchanged across a reload.

**The assertions were shown to have teeth by reinstating each defect one at a time**, running only
the affected test, and confirming it goes red at the assertion that names it: dropping the explicit
`pinToGrid` fails *"pinToGrid is written EXPLICITLY as \"false\""* with `undefined`; renaming `text`
to `label` fails *"the caption lives in `text`"*; deleting the anchor-collision check fails *"the
collision is REFUSED"*; restoring the `controlType === "shape"` gate on the script cleanup fails
*"the object script went WITH it"* and prints the surviving script; making `resetLayout` call
`localStorage.removeItem` again fails *"it is STILL the customised layout after a reload"* with 2
where 3 is required.

**THREE DEFECTS FOUND BY THE LIVE RUN, all fixed.**

- **Saving a Home-tab customisation kicked the user off the Home tab.** The `homeTab:layoutChanged`
  handler called `unregisterPanel(HOME_TAB_ID)` before re-registering, so the tab momentarily did not
  exist — and `RibbonContainer`'s active-tab reconciliation falls back to the first non-contextual tab
  when the current one disappears. The user pressed **Save** and landed on Page Layout with their
  newly customised Home tab off screen. `registerPanel` already upserts by id (the panel registry
  `set`s and `registerRibbonTab` overwrites), so the fix is to re-register IN PLACE and never
  unregister. Pinned by *"Save did not kick the ribbon onto another tab"*, which fails when the
  unregister is put back.
- **Removing control metadata straight from the backend left PHANTOMS on the canvas.** Removing a control's backend
  metadata does not touch the frontend floating store, and the store is only swapped when the sheet
  actually CHANGES (`reloadForSheetChange` short-circuits on `nextSheet === loadedSheetIndex`), so
  re-emitting SHEET_CHANGED for the current sheet is a no-op. A leftover shape kept painting into the
  next test's probe. Test-side fix: deletion goes through the provider's own `deleteControl`.
- **The canvas probe trusted `config.rowHeaderWidth` when the headings were hidden.** The renderer
  substitutes 0/0 for `rowHeaderWidth`/`colHeaderHeight` when `displayHeadings === false`
  (`gridRenderer/core.ts`) while `gs.config` keeps reporting 22/20, so the probe sampled 22px left and
  20px above the truth and scored a perfectly painted shape at 0.80. `anchorOrigin` now applies the
  renderer's own rule. `e2e/helpers/grid.ts`'s shared `readGridGeometry` has the SAME gap and is
  **not** fixed here — every other spec runs with headings on, and changing a shared helper under a
  baseline reproduction was not worth the blast radius. It is a real trap for the next spec.

**TWO PRE-EXISTING DEFECTS OBSERVED, NOT FIXED (out of scope, recorded so they are not re-found).**

- **`set_sheet_display_flags` does not drive the renderer, and `new_file` does not reset it.**
  `dirty-flag.spec.ts` restores the view flags through that command and then calls `new_file`; the
  frontend's Core state is fed by `DISPLAY_*_TOGGLED` events and never hears about either, so the
  whole rest of the journey run renders with the row/column headings switched OFF while the backend
  reports them ON. The new spec repairs the frontend flags itself before it measures anything.
- **On that headings-off canvas, a floating control could not be selected by clicking it** — not at
  its painted position and not at the config-offset position either. Measured, not characterised; it
  belongs to the headings feature rather than to the controls seam, and the design-mode toast is
  throttled, so "no toast" is suggestive rather than conclusive. Worth a look before anyone ships a
  hide-headings workflow.

**Live results (each suite from a COLD app launch, `E2E_MANUAL=1`).** journey **38 passed / 1
skipped** (31 pre-existing = 30 passed / 1 skipped, unchanged, + this file's 8); visual **18/18**;
scenario **24/24**; the 11 macro/VBA specs **55 passed / 1 failed** — `macro-live-edit` test 6, the
known pre-existing HEAD failure, untouched. `scriptable-shapes` (40), `scriptable-objects` (26),
`table-namedrange-script` (2) and `macro-recorder-journey` (1) were run alongside and are all green.

### 1b. Pictures — COMPLETE 2026-08-07 (backend, script host and frontend all shipped)

**The premise this section was written on was wrong, and the correction is the important part.**
It said "today only text crosses the file picker" and treated pictures as a future decision.
**Insert > Image already shipped, with no validation of any kind.** `Controls/index.ts` opened a
hidden `<input type="file">` IN THE WEBVIEW — not the Tauri dialog, not Rust — `FileReader.
readAsDataURL` base64'd the whole file, and the result was stored verbatim as the control property
`src`. Rust never saw a path. No size cap, no format check, no dimension cap anywhere;
`input.accept` is a dialog filter HINT and "All Files" was always offered. `getImageNaturalSize`
fell back to `{200, 150}` on decode error, so picking a NON-IMAGE silently created a placeholder
over a file whose bytes were **already embedded in the document**. That base64 then travelled into
published `.calp`, was SHA-256'd, and was covered by the detached manifest signature. So this was
never a green-field design question; it was an unvalidated ingress in production.

**What shipped 2026-08-07 (all Rust, plus the `@api` wrappers).**

**(i) How bytes enter.** `read_media_file(path) -> MediaRef` — a MAIN-window Tauri command, sibling
of `read_text_file`. The USER picks the file through the native dialog (`importImageViaPicker` in
`api/filesystem.ts`, riding the existing `file.picker` capability — **no new capability id**); the
host reads it, validates it, files it under its SHA-256 and returns
`{ ref: "media:<sha256>", mimeType, width, height, byteLength }`. **The bytes never cross IPC.**
`MediaRef` has no `data` field and a test asserts it never grows one. `read_media_file` and
`resolve_media_ref` are both on the `PRIVILEGED_BACKEND_COMMANDS` denylist.

**(ii) Where the bytes live.** `media/{sha256}` raw ZIP entries in `.cala`, modelled on the existing
`bi_cache/{connId}/{relfile}` section; `Workbook.media: HashMap<String, Vec<u8>>`. Written STORED,
not Deflated (every admitted format is already entropy-coded, and this is the user's Ctrl+S path),
in sorted hash order so identical content produces identical archive bytes.

**The `format_version` bump this section recommended was REJECTED, on the chain's own test.**
`manifest.rs` states it: a feature takes a version link when an older reader would MISHANDLE the
document, not merely lose state. The three sections holding links all make the document *lie* —
`pending_recalc` turns a knowingly-stale workbook into one claiming to be calculated,
`user_hidden` resurrects rows hidden to keep data out of a report, `sheet_display_flags` shows
values where the author left formulas. A dropped picture does none of that: a picture that is
simply not there is the loudest possible signal. So `media` gets a manifest FEATURE ID (so
`read_calcula_manifest` can answer "does this carry embedded binary?" without materializing the
workbook) with an **unconditional read** (the `named_ranges`/`sparklines` precedent), and
`format_version` stays at **6**. Stamping v7 would have made every workbook containing one image
unopenable by an older build for no protective gain.

**Riding `user_files` was rejected** and the reason is recorded in code: `.calp` excludes it
wholesale as subscriber-local, it is the user-visible virtual filesystem (a user could delete their
own logo), and `create_virtual_file` is `Option<String>` / `String::from_utf8` — it cannot carry a
PNG.

**(iii) Decode safety.** `calcula_format::media::inspect_media` — magic bytes, an **8 MiB** byte cap,
header-only dimension parsing per format, and **two** dimension caps. **No image crate is linked**
(the `image` crate remains transitive-only, via `arboard`). The pixel cap is not redundant with the
byte cap and that is the whole reason the header is parsed rather than sniffed: a 30,000 x 30,000
single-colour PNG compresses to a few kilobytes, sails through any byte cap, and asks the WebView
for 3.6 GB of RGBA. Allowlist PNG/JPEG/GIF/WebP. **SVG and BMP are refused** — SVG has no magic
bytes, no header dimensions and is an XML+scripting surface; BMP is uncompressed. Malformed or
truncated headers are refused, never guessed.

**Garbage collection.** Unreferenced media is dropped from the **ARCHIVE** at save, never from the
session store. That split is what keeps undo honest: deleting a picture removes the control that
referenced it, and if the bytes went too, Ctrl+Z would restore a control whose handle resolves to
nothing. The session keeps every byte it admitted; each save writes only what the document points
at; the bytes are finally gone after save-and-reload, at which point the undo stack is gone too.
The reference scan is VALUE-shaped, not property-name-shaped, so a future `backgroundImage` cannot
silently orphan a picture.

**`.calp`.** Media publishes as **its own artifacts** at `media/{sha256}`, not inline in
`controls.json`. That is what makes the content-addressed blob store work:
`commit_artifacts_as_blobs` keys on each ARTIFACT's SHA, and a media artifact's content IS the
image — so its blob key is the media hash and the same logo is one blob across versions. Inline,
the key was the SHA of the whole `controls.json`, so a one-word caption edit minted a fresh
multi-megabyte blob every release. Only media the PUBLISHED sheets reference travels. The
integrity walk recurses into every directory except `submissions/` and `reviews/`, so the new
artifacts are hashed and LISTED automatically — which they must be, since that same walk rejects
unlisted artifacts. Pulled blobs are re-validated host-side and re-keyed from their own bytes: a
signed manifest proves the publisher sent these bytes, not that they are a picture.

**Two collateral defects fixed at the same time.**

- `set_control_property` **overwrote `control_type`** with whatever the caller passed. The shape
  property handler hardcodes `"shape"`, so one script property write against an IMAGE silently
  converted it to a shape and it stopped rendering — with the backend reporting success. The type
  is now immutable after creation, checked under `lock_pending()` so the gate and the write share
  one lock (Tauri dispatches on a thread pool; a `read()`-drop-`write()` pair is a TOCTOU window).
- **`object.setState` is `restricted` with no capability, and `vSetState` accepts
  `shape.setProperty` with no key allowlist and no length bound** — so a distributed script could
  write an arbitrary multi-megabyte string into persisted control properties. Now bounded
  MECHANICALLY at the backend door (`MAX_CONTROL_PROPERTY_CHARS` = 64 KiB, on both
  `set_control_property` and `set_control_metadata`), because that is where every route — UI,
  script broker, MCP, `.calp` materialization — converges. A refusal is loud, not a truncation.

**Migration.** Documents already carrying inline base64 are migrated on `.cala` load: decoded,
re-validated, filed under their content hash, and the property rewritten to a `media:` handle. It
does not dirty the document (`CleanReason::LoadingFromDisk`) and is idempotent. A payload this
build refuses — an SVG logo the old picker accepted — is **left untouched rather than deleted**: it
keeps rendering from its data URL under the existing CSP `data:` allowance while the write door
stays shut. Read tolerance and write strictness are different questions.

**THE EXISTING CORPUS — the sub-decision the original proposal missed, settled 2026-08-07.**

"Migrate the saved documents" turned out to be two questions with two different answers, because
there are two corpora and only one of them is the user's own.

**(a) Already-saved `.cala` files — migrate on load, verified end to end.** Covered by
`migrate_legacy_data_urls` (above). It is now proved through an actual FILE rather than an in-memory
store (`media.rs::a_legacy_cala_file_on_disk_still_opens_and_its_picture_survives`): write a fixture
the shipped Insert > Image would have produced — inline data URL, no `media/` section — open it,
migrate, save, and re-open. The picture survives byte for byte, the second load migrates to nothing
(idempotent ACROSS A SAVE, not merely in memory), the archive gains the `media` feature id, and
**`format_version` does not move**, which is the version-chain claim above stated as an assertion
instead of a paragraph.

**(b) Already-published, already-SIGNED `.calp` packages — accept the old shape, migrate at the
boundary.** This is the half that was missing, and it was not merely undecided: it was a live hole.
Packages published before media artifacts existed carry whole images base64'd inside
`controls.json`, and that artifact is covered by the detached manifest signature. A subscriber
cannot re-sign someone else's package. Two things followed that nobody had joined up:

- Refusing the legacy shape would break every existing subscription to fix nothing, so the pull
  path must READ it. Non-negotiable.
- But pulled controls are materialized by `materialize_saved_controls`, which writes STRAIGHT into
  `ControlStorage`. It is not a `set_control_metadata` call, so the 64 KiB property bound never saw
  it — and whatever lands there is saved verbatim into the SUBSCRIBER's own `controls.json`. A
  legacy pull was therefore the one surviving route by which unvalidated binary entered a document,
  and the claim that "every route converges on those two commands" was wrong about this one.

**The answer is the same one the `.cala` corpus gets, applied at the package boundary:**
`media::admit_distributed_controls` now sanitizes AND migrates — decode, re-validate through
`inspect_media` (magic bytes, byte cap, both pixel caps), file under the content hash, rewrite the
property to a handle — and all three distributed materialization sites (first pull, refresh, dev
pull) call it instead of `sanitize_distributed_controls`. The signature is untouched and unaffected:
verification runs against the package as published, and this runs after it, on the way into the
subscriber's own document. It takes the media lock and no other, and is called BEFORE the controls
lock, matching the media-then-controls order both pull paths already used.

**What a subscriber sees: the picture, exactly as before.** Same pixels, no consent prompt, no
re-pull, no "package invalid". What changed is invisible to them and entirely in their favour — the
image is now content-addressed, so the same logo across five packages is one blob, and their own
saved workbook holds a 70-character handle where it used to hold a multi-megabyte string. A payload
this build refuses (an SVG, or one over a cap) is left inline and keeps rendering under the CSP
`data:` allowance, never dropped: the same read-tolerance / write-strictness split as the `.cala`
corpus, for the same reason — deleting it would silently destroy a picture the subscriber can see.

A correctly-signed decompression bomb inline is refused by the same gate as one shipped as an
artifact; a signature proves the publisher sent these bytes, not that they are a picture.

**Dev-mode pulls now carry media too** (`DevPullResult.media`), closing a residual the backend pass
recorded: a dev pull exists to show an author what a subscriber will get, and without the bytes
every picture in the preview painted "Image Unavailable".

**`tauri.conf.json:26-27` `img-src 'self' data: blob:` is load-bearing and was undocumented.**
`parse_media_ref` requires exactly 64 lowercase hex characters, so a handle can never become a URL
or a path component — but the CSP line must not be relaxed. It now says so in the one place that
cannot rot: **JSON cannot carry a comment and Tauri's config denies unknown fields** (every config
struct in `tauri-utils` carries `deny_unknown_fields`, so a `_comment` key is a startup parse
error), so the note is a TEST — `extensions/Controls/__tests__/imageIngress.test.ts` reads
`tauri.conf.json` and asserts both `csp` and `devCsp` still contain exactly
`img-src 'self' data: blob:`, with the reason for each token in the test body. Delete the directive
and the suite goes red. `blob:` is what the renderer paints resolved media from; `data:` is what
keeps the un-migratable legacy corpus visible.

**THE FRONTEND REWIRE SHIPPED 2026-08-07 (same day). Insert > Image works again, through the
validated door.**

- **`insertImage`** now calls `importImageViaPicker` (native dialog -> host reads, validates, files
  the bytes) and stores the returned `media:` handle as `src`. `pickImageFile` and
  `getImageNaturalSize` are **deleted**, not adapted, and a test greps the extension to keep them
  deleted: no `FileReader`, no `readAsDataURL`, no `<input type="file">` anywhere in Controls. The
  initial layout size comes from the header the host already parsed. A refusal shows the host's own
  message — which names the rule and the number — and **creates no control at all**.
- **The renderer** resolves a handle once per CONTENT HASH into one Blob and one object URL, so N
  controls sharing a logo cost one IPC call, one blob and one decode. `invalidateAllImageCaches`
  (theme change, structural edit, `CELLS_UPDATED`) deliberately does NOT revoke those URLs: bytes
  are immutable under their hash, so the old behaviour — one theme change re-pulling every image's
  entire base64 across IPC — is gone rather than reproduced. URLs are revoked when the last control
  referencing them goes (`forgetImageControl`, on the delete path) and on extension teardown.
- **`src` is no longer a free-text box.** `PropertyDefinition` gained `readOnly` / `readOnlyHint`
  and `IMAGE_PROPERTIES.src` uses them, so the Properties pane displays the handle (selectable, so
  it can be copied) and refuses to edit it. That closes the hole the CSP was silently covering for.
- **A workbook OPENED mid-session now reloads its controls.** Controls read them exactly once, at
  activation — CellTypes and CellBehaviors already reloaded on `AFTER_OPEN`, this one did not — so a
  second workbook showed the first one's controls. Media made that worse than stale geometry: a
  handle from the closed document resolves against the new document's store and correctly fails. The
  whole picture cache is now RELEASED (not merely invalidated) on `AFTER_OPEN`.
- **The load-side report.** The host's migration runs during the load and is silent by design; what
  the frontend adds is telling the user about the pictures it could NOT convert — once per control
  per session, worded so the first thing they read is that nothing was removed and they still
  display (`Image/legacyInlineImages.ts`).

**The policy question is CLOSED, and it is closed in code (2026-08-07).** "A restricted script may
REFERENCE existing media, never INTRODUCE bytes" is now a property of the validator rather than a
sentence in this document. `vSetState` gained a gate for the `shape.setProperty` aspect
(`validators.ts` `checkShapeSetProperty`), and `vObjectAspect` already delegates to it, so the
own-object door (`object.setState`, restricted, instance-pinned) and the cross-instance door
(`api.objectSetState`, unlocked) land on the same check:

- **`src` accepts `media:` + 64 lowercase hex, or `""` to clear it, and nothing else.** A data: URI,
  a `blob:`/`https:` URL and a file path are all refused by shape, with the fix named in the error.
  This is the line that makes the tier rule mechanical: bytes can only enter through
  `read_media_file`, which is MAIN-window gated and denylisted for scripts.
- **Every other property write is key-checked and length-bounded.** Keys are the union of the real
  `SHAPE_PROPERTIES` / `IMAGE_PROPERTIES` / `BUTTON_PROPERTIES` sets, with a drift test that reads
  the extension source (policy must not import a feature, so the list is a literal and the test is
  what keeps it honest). Values are capped at **8,192 characters** — deliberately TIGHTER than the
  backend's 64 KiB `MAX_CONTROL_PROPERTY_CHARS`, which has to stay looser because it also admits
  inline `onSelect` source written by trusted UI.
- **`onSelect` and `macroRef` are refused outright from the script door.** Both hold an ACTION, not
  an appearance: `onSelect` is inline source the click path feeds to `runWorkbookScript` (the
  QuickJS module runtime — a wider trust class than the worker the caller runs in), and `macroRef`
  re-points a control at any recorded macro. A sandboxed script that could write either would be
  authoring code that later runs with more reach than it has. Nothing legitimate is lost: neither
  key is in the shape or image property sets, and the aspect's handler hardcodes the type `"shape"`.
- The unknown-key tail is **open by spelling, closed by everything else**, and that is forced rather
  than chosen: `declareProperties` is a shipped feature that mints author-named keys, and a
  validator is stateless by contract, so it cannot know which keys an instance declared. A custom
  key must be identifier-shaped and bounded, and it can never collide with `src` or a refused key
  because those rules run first.

**Two new script rows, no new capability id.**

- **`cap.fileImportMedia`** — a FOURTH ARM on the existing `file.picker` capability, restricted
  tier, `class: "file"`. `file.picker` already means "the user picks one file and the host does the
  I/O", which is exactly this, so it needs no id and no second consent decision. It is the
  NARROWEST of the four: `cap.fileImportText` hands the script the file's CONTENTS — through
  `read_text_file`, whose Windows-1252 lossy fallback returns mojibake for a binary file rather than
  an error — while this arm returns an inert handle and four integers. The host executor
  re-projects the response field by field, so a `data` member could not travel even if one appeared
  upstream. No options object: which formats may be embedded is the host's decision, and letting a
  script widen the picker to "All Files" would restore the old ingress under a nicer name.
- **`api.createPicture(dataRef, anchor, options?)`** — unlocked tier, `class: "mutate"`, no
  capability, matching `api.createChart` / `api.createTable` (a picture the workbook already holds
  is document content; nothing leaves the file). ACTIVE SHEET only, for `api.createTable`'s reason:
  control geometry comes from the active sheet's dimensions and the overlay regions are sheet-blind.
  The only image argument is a handle — there is no bytes, data-URI or path parameter to refuse — so
  the row cannot become an ingress however it is called.

**That dependency is now SATISFIED (2026-08-07).** Placement goes through a feature-neutral seam,
`@api/pictureControlService`, modelled exactly on `@api/buttonControlService` and for its hard-won
reason: the Macro Recorder once hand-rolled a control and produced an invisible one while the
backend reported success. **The Controls extension registers a provider at activation**
(`createPictureControlAt` / `removePictureControlAt`), so `api.createPicture` places a real, visible
picture. Two refusals are deliberate and belong to the provider, not to the seam:

- a `src` that is not a well-formed handle is a programming error, refused rather than stored — the
  extension must not be the place where the CSP goes back to being the only defence;
- a handle THIS DOCUMENT CANNOT RESOLVE creates nothing. A picture that can never paint is worse
  than an error: it is a permanent broken-image box the user has to hunt down, produced by an
  operation that reported success. Resolution goes through the renderer's single-flight cache
  (`getMediaNaturalSize`), so asking costs the pull that was about to happen anyway, and the
  decoded natural size gives a caller that named one dimension the other one at the true aspect
  ratio.

**EVERY WAY A CONTROL PROPERTY CAN BE WRITTEN, AND WHAT BOUNDS IT.** The point of the change is a
closed list, so here is the list, verified by reading the code rather than by assertion:

| Route | Gate |
|---|---|
| Insert > Image (fresh ingress) | Native dialog -> `read_media_file` (MAIN-window gated) -> `inspect_media`. Stores a handle. The old `<input type="file">` / `FileReader` path exists only in comments, and a test greps for it. |
| Script `object.setState` / `api.objectSetState` -> `shape.setProperty` | `checkShapeSetProperty`: `src` must be a handle or `""`; other keys allowlisted and bounded at 8,192 chars; `onSelect` / `macroRef` refused outright. Then the backend's 64 KiB bound behind it. |
| Properties pane | `src` is `readOnly` (a display of the handle, selectable so it can be copied). Other properties -> `set_control_property` -> 64 KiB. |
| Copy / paste / duplicate a control | `set_control_metadata` -> 64 KiB. Copies metadata that was already admitted; introduces nothing. |
| `.calp` first pull, refresh, dev pull | `admit_distributed_controls` — sanitize + migrate legacy inline through `inspect_media`. Package-carried media goes through `admit_foreign_media`, re-keyed from its own bytes. |
| `.cala` load | `migrate_legacy_data_urls`. |
| Undo/redo, row/column insert/delete, sheet remap | Move already-admitted metadata between keys. No new values. |
| `api.createPicture` | Handle only — there is no bytes, path or data-URI parameter to refuse. Placement via `@api/pictureControlService`. |

Three properties hold across all of it: **the cap and the format allowlist are enforced in RUST**, in
one function (`calcula_format::media::inspect_media`) that every door calls — not in the frontend,
which is where the `MAX_FILE_TEXT_CHARS` precedent went wrong; **no image decoder is linked into the
privileged process** (`cargo tree -i image` shows `image v0.25.10` reachable only as
`arboard` -> `tauri-plugin-clipboard-manager`, and no `use image::` exists in any first-party crate —
the headers are parsed by byte offset); and **the migration cannot lose a picture**, because the
only two outcomes are "became a handle" and "left exactly as it was, still painted by the renderer's
non-handle branch".

**E2E COVERAGE — CLOSED (2026-08-07).** `app/e2e/journeys/image-ingress.spec.ts`, 7 tests in the
`journey` project (it saves, wipes with `new_file` and reopens, so it cannot live in `e2e/tests`).
It is the FIRST E2E the feature has ever had, and it drives the product rather than the seam:

- **The real menu item and the real NATIVE dialog.** Tauri's IPC surface is non-writable, so the
  picker cannot be stubbed from the page (the same wall `dirty-flag-close.spec.ts` hit). The dialog
  is therefore answered from OUTSIDE — the spec writes its own PowerShell helper, finds the `#32770`
  window owned by `app.exe`, `WM_SETTEXT`s the path into its file-name `Edit` and posts `IDOK`. A
  CANCEL case runs first, so every later outcome is attributable to the file CHOSEN rather than to
  the menu click.
- **The picture is asserted to RENDER**, by sampling the grid canvas through the same live geometry
  (`readGridGeometry`) the click helpers use — asserted present after insert, ABSENT after the wipe,
  present again after reopen. Both directions, one probe.
- **The persisted `src` is read out of the saved `.cala` ARCHIVE**, by a dependency-free ZIP reader
  written inside the spec (`media/` entries are STORED, `controls.json` is Deflated). It asserts the
  `media:{sha}` handle is present, that `data:image`/`base64`/the file's own base64 prefix are NOT,
  and that three controls' worth of `controls.json` is under 4 KB.
- **"Did the document gain the bytes?"** is `resolve_media_ref("media:" + sha256(fixture))` — content
  addressed, so it asks about THAT file. False at baseline, true after insert, false after wipe,
  false for every refused file.

Covered: a normal PNG renders + handle + header-derived size; save/wipe/reopen; dedup (same file
twice = 1 blob / 2 controls, plus a second picture to prove dedup counts CONTENT); the three
refusals (byte cap with the limit named, a ZIP renamed `.png` caught on magic bytes, SVG) each
asserting no control AND no bytes AND nothing in the archive; a script's `shape.setProperty` refusing
a `data:` URL while accepting a real handle; and the legacy corpus — a `.cala` written with an inline
`data:` image, opened, migrated, rendered, saved and reopened.

**The refusal assertions were shown to have teeth by reinstating the defects**, one at a time, and
confirming the spec goes red:

- `checkShapeSetProperty`'s `src` rule disabled -> test 6 fails with `ACCEPTED`.
- `pickValidatedImage` returning a placeholder instead of `null` on refusal -> the magic-bytes test
  fails, and the diff it prints is the shipped defect's exact signature: a control at the anchor with
  `width: 200, height: 150`.

Two attributability guards are built in so a refusal cannot pass for the wrong reason: the byte-cap
case first inserts a twin PNG built identically (noise pixels, deflate level 0) but under the cap and
requires it to be ACCEPTED; and the script test's `data:` payload is a picture the document has never
held, so "did the store gain it?" has a real answer.

*Gotcha for whoever edits this next:* a Vite **HMR update** to an extension file does NOT re-run
extension activation, so an already-registered menu action keeps the old closure and a mutation test
will silently pass. Force a full page reload after touching `app/extensions/**` before trusting a
live run.

**STILL OPEN, honestly.**

- **A refused legacy inline payload is still unbounded**, in both corpora. It is left inline
  deliberately, and nothing caps how big that string may be; for a package this is bounded only by
  the fact that no artifact size cap exists at all, which is a separate, pre-existing question.
- **`resolve_control_properties` still returns `src`** and is script-reachable. For a handle that is
  70 bytes; for an un-migratable legacy inline image it is still the whole data URL, so a restricted
  script can READ those bytes (it can neither write them back nor create new ones).
- **Cross-DOCUMENT paste of a picture fails visibly** ("Image Unavailable"): the in-session clipboard
  holds a handle and the media store is per-document. Fixing it needs a byte re-admission route,
  which is the thing this design refuses; left alone deliberately.
- **`vSetState`'s unknown-key tail is open by spelling**, because `declareProperties` mints
  author-named keys and a validator is stateless by contract. Custom keys are identifier-shaped and
  bounded, and cannot collide with `src` or a refused key.

### 1c. The rest of Wave 5 — recommend demand-driven, not scheduled

`CenterAcrossSelection` (engine + renderer neighbour-paint pass) is the strongest of the
remainder — it is what the "never merge cells" school reaches for, and report titles want it.
Insert/delete *cells* with shift, extended border line styles, superscript/subscript and
sparklines are genuinely long-tail: each is an engine project whose script API is the last 5%.
Let real user demand pull these rather than pushing them.

---

## 2. Defects found and deliberately not fixed

Each was found during the work above, verified, and left alone because it needed an owner
decision or exceeded the scope of the pass that found it.

### 2a. Home-tab "Customize" entry point — RESTORED 2026-08-07

The affordance was dropped during the sections/panel migration.
`HomeTabCustomizeDialog.tsx` was **still registered and still listening** for its save event, and
`loadLayout` still ran at startup — so a previously saved layout still applied, but a user could
never change it again. Live, maintained, unreachable code, with zero callers.

**The owner decided the entry point is crucial, under one constraint: the Home tab's CURRENT
appearance must remain the DEFAULT.** That constraint turned out to hold *by construction* rather
than needing anything captured: `DEFAULT_LAYOUT` already IS today's look and is simultaneously what
`loadLayout()` returns on a cache miss and what `resetLayout()` returns. The work was to keep it
that way — which is now a test, not a note (`__tests__/homeTabSections.test.tsx`).

**It is a View-menu item, not a ribbon gear.** `registerMenuItem` is a first-class extension API
that 30+ extensions already use, so the restore needed **no shell change, no API change, and turns
ZERO goldens red**. The earlier "8 visual goldens encode its absence" note applied to a *ribbon
gear*, which would have needed a new right-aligned tab-strip surface plus a sidebar-projection
equivalent. Checked rather than assumed: the visual suite has open-menu goldens for **File, Edit and
Data only** — there is no View-menu golden anywhere in `e2e/`, and `buildSections(DEFAULT_LAYOUT)`
emits section descriptors identical to the previous code's (same ids, labels, icons, sizes,
`ribbonPresentation`, `collapsePriority`), so `ribbon-core-default-ribbon.png` is untouched too.

**Two bugs that would have been visible within 30 seconds of the button shipping, both fixed.**

- **"Row Break" could never be added.** `usedItemIds` was a GLOBAL set and `isUsed` disabled anything
  already placed anywhere — but `rowBreak` is a **multi-instance separator** that `DEFAULT_LAYOUT`
  already uses five times, so it was greyed out on first open. Layout control was advertised and
  unreachable. Separators are now exempt from the used-set (`isMultiInstanceItem`).
- **Reset-then-Cancel silently reset.** `resetLayout()` called `localStorage.removeItem`
  IMMEDIATELY while `handleReset` only set local state and emitted no `homeTab:layoutChanged`. So
  Reset then Cancel wiped storage, left the ribbon unchanged, and the reset appeared at the *next
  launch*. `resetLayout` is now **pure** — it returns the default and writes nothing; the write
  belongs in `handleSave` like every other field.

**The separator tail, fixed in the same diff because the used-set fix is what makes it reachable.**
`removeItem` filtered by EQUALITY (removing one `rowBreak` removed every one in that group),
`moveItem` used `indexOf` (the arrows on the second row break moved the first), and React
`key={itemId}` collided. All three are index-keyed now.

**No merge on load — fixed.** `loadLayout` only ever SUBTRACTED unknown ids, so a new entry in
`ALL_ITEMS` never reached an existing saved layout: **anyone who customised once was frozen out of
every command shipped afterwards.** There is now a `version` on the layout, an `addedIn` on each
catalog item, and a pure `migrateLayout(saved, catalog)` that adds everything introduced *after* the
saved version. The version is stamped back on load, and that stamp is the point: without it the
additive step would re-add, on every load, a command the user deliberately removed. Separators are
never auto-added — where the row breaks go is the user's business. `migrateLayout` takes its catalog
as a parameter so the test can drive a synthetic "next release" instead of waiting for one.

**Empty sections — decided and handled.** A group left with no *renderable* item is dropped, on both
the load path and at save. "Renderable" excludes a group holding only row breaks: a separator paints
no button, so such a group rendered as a labelled, empty section.

**`GROUP_ICONS` and `GROUP_ORDER` are folded into `DEFAULT_LAYOUT`** as per-group `iconId` /
`collapsePriority`, so there is ONE default object instead of a constant plus two id-keyed lookup
tables that can drift — this drift had already happened once (`GROUP_ORDER` omitted `"cells"`).
Icons stay an id -> ReactNode map in `components/homeTabIcons.tsx`, because a persisted layout must
never contain React elements; the dialog now offers that map as a per-group icon picker, so a
user-created group gets a real choice instead of the fallback glyph.

**`cells` keeps `collapsePriority: 99` deliberately.** That is not a considered value — it is the
fallback the missing `GROUP_ORDER` row produced, and it makes Cells demote LAST on a narrow band,
which is almost certainly unintended. It is now written out explicitly so it cannot drift silently,
but it is **not changed**: changing it changes narrow-window behaviour, which is the owner's call
under the "current appearance is the default" constraint, not a cleanup. **Open: pick the real
number** (55, between Styles and Editing, is the obvious candidate).

**Reported, not built: an in-place affordance on the Home tab header.** A right-click item via a
generic `PanelDefinition.contextMenuItems` field is the sanctioned follow-on and would give the
feature discoverability the View menu does not — but it touches the shell, so it is out of scope
here.

**Verification (confirmed at integration, 2026-08-07).** `check-types` and `lint:boundaries` clean;
the whole repo suite green at **729 files / 105,967 tests, 0 failed**, of which 41 are this item's
three new files (`homeTabLayout` 21, `homeTabSections` 10, `homeTabCustomizeDialog` 10). `"view"` is
a real menu id with five other extensions already contributing to it (Animation, CollectionPreview,
JsonView, Print x2), so the entry point needed no shell change and no `@api` change; `registerMenuItem`
at activation is matched by `unregisterMenuItem` in `deactivate`. Re-verified by reading the code
rather than the report: `DEFAULT_LAYOUT` is simultaneously what `loadLayout()` returns on a cache
miss, what `migrateLayout` falls back to when a saved layout has nothing renderable left, what
`resetLayout()` clones, and — through `buildSections(loadLayout())` — what the ribbon renders;
`resetLayout` touches no storage at all, and the only write in the dialog is `handleSave`'s.

**LIVE E2E — CLOSED 2026-08-08, and it found a fourth bug.** Tests 7 and 8 of
`app/e2e/journeys/shapes-hometab.spec.ts` (see §1a for the whole file) drive the real View menu, the
real dialog and the real ribbon. Test 7 asserts the entry point is present, that clicking it OPENS
the dialog, that the dialog holds one card per ribbon group, and that the seven default sections are
still in their default order — the owner's constraint, measured rather than reasoned. Test 8 adds a
Row Break to Cells, moves it one place left with the chip's own arrow, saves, and asserts the RIBBON
re-lays that group from two rendered rows into three; then Reset-then-Cancel, then a reload, and the
layout is still the customised one. The dialog gained `data-hometab-*` hooks for this (dialog root,
group card, item chip + move-left, add-to select, available-command buttons, the three footer
buttons) — it had no test hooks at all, and `[class*=…]` selectors do not work against
styled-components hashes.

Two assertions are pinned against vacuity from inside: "Row Break is enabled" is paired with "an
already-placed single-instance command (`bold`) IS disabled", and the reset/cancel claim is checked
after a real frontend reload rather than against in-memory state. Both were confirmed to fail when
their defect is reinstated.

**The fourth bug, found on the running app: pressing Save threw the user off the Home tab.**
`layoutChangedHandler` unregistered the panel before re-registering it, so the tab momentarily did
not exist and `RibbonContainer` fell back to the first non-contextual tab — Page Layout. The
customised Home tab was off screen, and the re-register that followed could not take the selection
back because "pageLayout" was by then a perfectly valid current tab. Fixed by re-registering IN PLACE
(`registerPanel` upserts by id); pinned by *"Save did not kick the ribbon onto another tab"*.

**STILL OPEN.** Two, both stated above and neither closed here: `cells: collapsePriority` is still
the accidental **99** awaiting a product call (55 is the candidate), and the Home-tab-header
right-click affordance is still shell work. One smaller residue, pre-existing and deliberately left:
`saveLayout` swallows a `localStorage` failure into a `console.warn`, so a quota-exceeded save closes
the dialog looking successful. Fixing it means giving a pure config module a way to talk to the user.

### 2b. Pivot progress overlay never clears — FIXED 2026-08-07

The backend emits its final `pivot:progress` immediately before returning
(`src-tauri/src/pivot/commands.rs:884`). Tauri events and command responses travel separate
channels, so that last event landed *after* pivot-api's `finally { clearLoading }` had run,
re-arming an indicator nothing would ever clear. Reproduced deterministically (byte-identical
across two cold runs, unchanged by a 6 s wait), not a race.

**Fix.** `applyBackendProgress()` in `Pivot/lib/pivotViewStore.ts`, called from
`Pivot/index.ts`: a backend event may UPDATE a running operation, never START one.

The proposed one-liner was right but **incomplete**, and the second half is the interesting
one. The guard is only safe while every progress-emitting command clears its indicator under
a sequence check, because `loadingPivots` is keyed by pivot id alone and `clearLoading`
deletes unconditionally. Two of the three (`updatePivotFields`, `refreshPivotCache`) already
took a `startOperation` sequence and cleared under `isCurrentOperation`; **`changePivotDataSource`
did not**. A superseded `changePivotDataSource` therefore wiped a newer operation's entry, and
from that moment the guard dropped every one of the newer operation's real progress events —
leaving a genuinely-running refresh with no indicator at all. Before the guard existed an
unconditional `setLoading` re-created the entry, so the leak healed itself; the guard removed
that accidental safety net, which is why the sequencing had to become real.
`changePivotDataSource` is now sequenced like its siblings, and
`Every progress-emitting command is sequenced` fails if a fourth emitter appears unsequenced.

### 2c. Cross-sheet recalculation does not propagate (BUG-0019) — FIXED 2026-08-07

Editing `Sheet1!C5` propagated to `C9`, but the chain `C9 -> Sheet2!B3 -> B4` never recalculated
in memory. The scenario spec's assertions are restored (and corrected — see §2h) and the ledger
entry is closed. **Four causes, not two**: the fourth was found on the running app after the
first three were "done", and it is the one an ordinary user would have met first.

The asymmetry with save-and-reload was the whole clue, and it pointed at two *different* causes,
one per hop, both in `cascade_cross_sheet_dependents` (`commands/data.rs`):

1. **The walk was rooted only on the cells the caller EDITED.** Cells the caller *recalculated*
   were marked processed but never queued, so `C9` — which changed as a dependent — never had its
   own cross-sheet dependents looked up. First-order propagation therefore worked perfectly, which
   is exactly why this survived: every obvious cross-sheet test passes against the broken code.
2. **The walk expanded a non-active sheet's same-sheet dependents through the ACTIVE sheet's
   dependency map.** Those maps are keyed `(row, col)` with no sheet dimension and are rebuilt on
   every sheet switch, so reaching `Sheet2!B3` asked *Sheet1* what depends on `(2,1)`. Nothing did,
   and `Sheet2!B4 = B2-B3` stayed stale forever. A `SheetDependencyIndex` is now derived on demand
   from the reached sheet's own formula ASTs and expanded in topological order.

Two hand-copied duplicates of the walk (`update_cells_batch_core` for paste, `fill_range`) were
carrying cause 1 independently and lacked the same-sheet expansion entirely; both now call the
shared function, and a wiring test fails if a third copy appears.

**A third entry point, found while auditing the fix (FIXED 2026-08-07): `sort_range`
recalculated NOTHING.** Not cross-sheet, not same-sheet, nothing. It permuted its range, rebuilt
the dependency maps and returned, so a `=A1` beside the range or any off-sheet reader kept its
pre-sort value until an unrelated later edit swept it up. The asymmetry that gives it away is
that the **off-sheet** sibling `sort_range_off_sheet` has always recalculated (through
`recalc_after_off_sheet_write`) — so sorting a sheet you were NOT looking at produced the right
answer while sorting the one in front of you did not. Fixed with
`recalc_after_active_sheet_bulk_rewrite`, which reuses `recalc_order_from_seeds` +
`reevaluate_formula_cell` + the one shared `cascade_cross_sheet_dependents` rather than copying
them, and runs as a second lock phase (the dependency maps it needs are the ones
`rebuild_all_dependencies_from_grid` just held, and std mutexes are not reentrant).

**A FOURTH cause, found on the RUNNING app 2026-08-07 while proving the above — FIXED.**
Every cross-sheet test, unit and E2E alike, visited the referencing sheet exactly once: go
there, type the formula, come back. A real user opens the summary sheet again to look at it.
That **second visit silently disabled cross-sheet recalculation for the rest of the session**
— `Sheet2!A1` and `Sheet2!A2` froze at their old values while Sheet1 recalculated perfectly.
Reproduced live: `Sheet1!A1=100`, `A2==A1*2`, `Sheet2!A1==Sheet1!A2`, `A2==A1+1`; with no extra
sheet visit the edit gives 250/500/500/501, with one Sheet1→Sheet2→Sheet1 round trip it gives
250/500/**200**/**201**.

Cause: `CrossSheetDependentsMap` is keyed by sheet NAME, and `cascade_cross_sheet_dependents`
looks a cell up under the workbook's OFFICIAL name (`sheet_names[idx]`). Every registration site
normalised the parsed name to that spelling — four hand-copied inline copies of the same
`eq_ignore_ascii_case` loop — but `rebuild_all_dependencies_from_grid`, which runs on EVERY
sheet switch, registered straight from the AST's spelling.

And the AST's spelling is **never** the workbook's: the lexer normalises every bare identifier
to UPPERCASE (`parser/src/lexer.rs:196`), so `=Sheet1!A2` is stored as `SHEET1!A2` and re-keys
as `("SHEET1", 0, 1)` while the cascade asks for `("Sheet1", 0, 1)`. That is why this was not a
narrow bad-casing bug but a total loss: **every** cross-sheet edge owned by a revisited sheet
died. (A quoted reference, `='Sheet1'!A2`, lexes as `QuotedIdentifier` and keeps its case, so it
would have survived — a difference no user could have explained.)

The four copies are now one `normalize_cross_sheet_refs` in `lib.rs` that the rebuild also
calls, and `rebuild_all_dependencies_from_grid` takes `sheet_names` explicitly rather than
locking for it (some callers already hold the grid). Pinned by
`revisiting_a_sheet_does_not_lose_its_cross_sheet_dependents` and
`a_cross_sheet_reference_registers_under_the_official_sheet_name`; both fail against the old
code with exactly the live symptom (200 where 500 is required).

**Not fixed here (one has since been closed):**

- **Undo does not recalculate dependents at all** — verified rather than inferred, and pinned by
  `undo_does_not_recalculate_dependents_pinning_a_known_gap` instead of being asserted away,
  because the trade-off belonged to undo's owner. **FIXED 2026-08-07 — see §2i**, which replaces
  the pin with the real assertions and records the transaction-kind analysis that decided it.
- A dependency cycle that crosses a sheet boundary is not detected anywhere —
  `partition_formula_cells` runs Kahn's algorithm over one sheet's local map, and the edit path
  has no cross-sheet cycle check. It terminates and produces an order-dependent number instead of
  `#CIRCULAR!`. Detecting it needs a genuinely sheet-dimensioned dependency graph, which is the
  same underlying gap as cause 2 above and is the real follow-on here.
  **FIXED 2026-08-08 — see §2m.**
- `clear_range` performs no dependent recalculation at all — not even same-sheet. Same class as
  the sort defect above; not fixed because it was outside this pass.
  **FIXED 2026-08-08 — see §2m**, which also records the nine siblings the sweep found.

### 2i. Undo/redo did not recalculate dependents — FIXED 2026-08-07

The largest remaining wrong-answer bug, pinned by §2c rather than fixed because the trade-off
belonged to undo's owner. Undo was a value RESTORE and nothing else: only the cells a caller
passed to `record_cell_change` are in a transaction, the dependents its forward cascade
re-evaluated never were, and `apply_changes` re-evaluated nothing for a plain cell restore. So
undoing `Sheet1!C5` left `C9 = SUM(C4:C8)` and `Sheet2!B3 = Sheet1!C9` at their post-edit values
while loading the same document gave the pre-edit ones. Same-sheet first, so genuinely its own
defect. Redo shared it exactly, through the same function with the inverse transaction.

**The transaction-kind analysis, which is what decided the design.** `CellChange` has six
variants and one of them (`CustomRestore`) fans out to ~40 registered kinds:

| kind | carries dependent values? | needed |
|---|---|---|
| `SetCell` (34 record sites: edit, paste, fill, sort, clear, find/replace, styles, merge, protection, MCP) | **No** — only what the caller wrote | the cascade; this was the bug |
| `SetColumnWidth` / `SetRowHeight` | n/a, geometry | nothing |
| `AddMergeRegion` / `RemoveMergeRegion` | n/a — cells a merge clears are separately `SetCell` | nothing of its own |
| `RestoreSnapshot` (row/col insert+delete) | **Yes, for the whole ACTIVE sheet**, cached values and all — but nothing off it | cross-sheet only |
| `CustomRestore` `script_grid_cells` / `sheet_merge_regions` / `sheet_structural_snapshot` | **Yes** (each restored `Cell` carries its cached value) | already had a full active-sheet recalc; unchanged |
| `CustomRestore` pivot/slicer/ribbon-filter/pane-control/`obj_*`/comment/note/hyperlink/default-dim/user-hidden | no cell values | nothing |

So yes — some transactions carry dependent values and some do not, and the naive blanket recalc
really can fight a restore. But the interesting finding is that **the opposite rule, "restored
cells are authoritative, recompute only their dependents", is the one that produces a wrong
answer**, and it does so on an ordinary input.

**A transaction is not required to capture its `previous` cells before it starts writing.** Any
grouped run that writes cell by cell — `begin_undo_transaction` + N `update_cell` (the scripting
host and the Model Editor CLI batch), find-and-replace, fill — cascades after EACH write. Undo
`[C5 = 6950, C9 = 99999]` and `C9`'s recorded `previous` is `=SUM(C4:C8)` cached at **27800**:
the total after the C5 write, a value that never existed before the operation. Believing it
restores a state the document never had, and drags `Sheet2!B3` along with it.

**The design: re-derive, don't believe.** Restored cells are seeded into the one shared cascade
(`recalc_after_active_sheet_bulk_rewrite` → `recalc_order_from_seeds` + `reevaluate_formula_cell`
+ `cascade_cross_sheet_dependents`) with `include_seeds: true`. That loop skips any seed with no
formula, so restored **literals** keep exactly the recorded value — that is the state undo owns —
while restored **formulas** are re-evaluated in topological order from precedents the restore has
already finished putting back. The two transaction classes then converge instead of competing: one
carrying no dependents gets them computed, and `RestoreSnapshot` recomputes to the same numbers it
carried while also fixing what no active-sheet snapshot can carry — the other sheets' formulas
reading into it. Cost: a restored volatile (`=RAND()`, `=NOW()`) lands on a fresh value, as it does
under any other recalculation.

Seeds are filtered to cells whose value or formula actually MOVED (`cell_value_differs`, now the
single predicate the subscriber-override diff uses too). Style edits record `SetCell` as well —
styles.rs, named_styles_cmd.rs and protection.rs all do — and a bold-10,000-cells undo must not
walk the dependency graph to re-derive the numbers it started with. It runs as a SECOND lock phase
after every grid/style guard is dropped, the `sort_range` shape, because std mutexes are not
reentrant. Redo is the same function, so both directions cascade or neither does.

**Found and fixed on the way: undo restored formulas without restoring their dependency EDGES.**
The maps are derived state, and `apply_changes` rebuilt them only after a *structural* restore.
Overwrite `A2 = A1*2` with a literal and the edge `A1 -> A2` is dropped (`update_dependencies`
with no refs); undo put the formula back and left the edge dropped, so the restored formula was
**inert for the rest of the session** and the next edit to `A1` silently failed to reach it. Same
shape as BUG-0019's fourth cause — a map that describes the grid quietly stops describing it, and
every symptom is a stale number rather than an error. `rebuild_all_dependencies` now runs whenever
a restore changed *which formula* sits in a cell, and (either way) BEFORE the cascade, which looks
its seeds up in exactly those maps. Incremental edge maintenance was rejected: hand-maintained
edges are what BUG-0019 was, and undo is a human-scale action running the same rescan a sheet
switch already does.

Pinned by `undo_recalculates_its_same_sheet_and_cross_sheet_dependents`,
`redo_recalculates_dependents_too`, `undo_redo_undo_round_trips_every_dependent`,
`undo_reports_the_recalculated_dependents_to_the_frontend` (values in `grids` are not enough — the
frontend repaints only what the command returns), `undo_of_a_grouped_bulk_write_restores_the_total_once`,
`a_transaction_carrying_its_own_dependent_still_ends_consistent` (the 27800 case above),
`undoing_a_formula_edit_restores_its_dependency_edges`,
`undo_of_a_style_only_change_leaves_values_untouched` and
`undo_cascades_through_the_one_shared_walk`. Every value assertion is re-checked against
`recalculate_every_sheet()` — agreement with the load path is the oracle, exactly as for BUG-0019.

**The three residuals recorded here — ALL CLOSED 2026-08-08.**

**Root cause first, because two of the three were one defect.** Undo's restore -> recalculate
channel had NO sheet dimension anywhere along it: `CellChange::SetCell` carried `(row, col)`, the
restore reported `(row, col)` through `override_edits`, and the cascade consumed `&[(u32, u32)]`
resolved against the ACTIVE sheet's dependency maps. So "undo restored the wrong sheet" and "a
whole-sheet restore can seed nothing" were not two bugs but two faces of one — an off-sheet fact
could not be EXPRESSED at any point along that path. The named-range gap is genuinely separate and
no sheet dimension helps it: a name is resolved while a formula is evaluated and is an edge in no
dependency map, so no coordinate on any sheet describes the formulas it feeds.

- **`SetCell` now carries its sheet.** `CellChange::SetCell { sheet, row, col, previous }`, recorded
  by `UndoStack::record_cell_change(sheet, ...)` at all 33 app call sites — three of which, in
  `update_cell_on_sheets`, were already recording OFF-sheet writes as if they were active-sheet
  ones, which is the defect in the wild rather than in theory. `apply_changes` restores into
  `grids[sheet]` and touches the active mirror only when `sheet` IS active; an off-sheet restored
  cell is reported with `sheetIndex: Some(n)` so the frontend cannot apply it to the sheet on
  screen, and the formula-bar event skips those (it has no sheet dimension of its own).
- **Restores report the sheets they wrote.** A `RestoreReport` is threaded through the restore
  registry: `report_restore`, `calp_reset`, `script_grid_cells`, `sheet_structural_snapshot`,
  `sheet_merge_regions`, `obj_cross_sheet_formulas` and off-sheet `SetCell` all call
  `report.wrote_sheet(idx)`. `apply_changes` then runs `recalc_after_off_sheet_write` over them —
  the SAME entry point a forward off-sheet write uses, so an undo and the write it reverses converge
  through identical code instead of a fourth copy of the walk. Reporting SHEETS, not cells, is the
  right granularity for these: each is a whole-region or whole-sheet swap carrying cached values, so
  what stays stale is never its own cells but the other sheets' formulas reading into them.
- **A named-range restore sets `report.workbook_recalc`**, and `apply_changes` runs that same shared
  cascade over EVERY sheet. It is the only honest trigger — the alternative, seeding from the cells
  that mention the name, needs a name-to-formula edge that does not exist, and hand-maintained edges
  are exactly what BUG-0019 was.

Pinned by `set_cell_restores_to_the_sheet_it_was_recorded_on`,
`an_off_sheet_set_cell_restore_recalculates_the_sheets_reading_into_it`,
`an_off_sheet_set_cell_restore_reports_its_sheet_to_the_frontend`,
`undoing_a_named_range_definition_recalculates_the_formulas_that_use_it`,
`redoing_a_named_range_definition_recalculates_too`,
`a_named_range_undo_agrees_with_a_whole_workbook_recalculation` (the load-path oracle again),
`a_report_restore_recalculates_the_other_sheets_reading_into_it`,
`every_cell_writing_restore_kind_reports_the_sheet_it_wrote` and
`the_off_sheet_cascade_is_the_shared_one`, all in
`app/src-tauri/src/undo_sheet_domain_tests.rs`.

**REDO SYMMETRY, checked at integration (2026-08-08) and one twin added.** Undo and redo differ in
exactly two places: which stack they pop, and the `is_undo` flag they hand `apply_changes`. Reading
that flag's uses: it decides the merge-region direction and which stack the inverse transaction goes
on, and nothing else — the sheet dimension on `SetCell`, the `RestoreReport`, `refresh_domains` and
the cascade are all direction-independent, and Core's `handleUndo` / `handleRedo` build the same
domain list from the same field. So the symmetry holds. But "redo is the same function" is a
property of today's code rather than a guarantee, and `is_undo` ALREADY branches inside that
function, so the sheet-dimension gap — the one defect of the three with no redo assertion — now has
one: `redoing_an_off_sheet_set_cell_restores_the_sheet_and_recalculates_too` drives undo then redo
and requires the edit back on Sheet1, Sheet2's dependent recalculated, the active mirror untouched,
and the reported cell carrying `sheetIndex: Some(0)`.

**One silent-failure channel found and closed in the same pass.** The announcement became DATA on
both sides, but the two sides are still hand-synchronised and the TS side fails SILENTLY: Core casts
the backend's `refreshDomains: string[]` straight to `MutationDomain[]`, and the Shell translator
looks each one up with `?? []`. A Rust wire name TypeScript has never heard of is therefore dropped
without a word — the original defect wearing the new design's clothes, and nothing could see it.
Three guards in `crossLayerConstantDrift.test.ts` now read `MutationDomain::wire_name` out of
`undo_commands.rs` and compare it against the `MutationDomain` union and `MUTATION_DOMAIN_EVENTS`,
in both directions (a domain the backend never emits is a refresh that looks wired and never fires),
each failure naming the two files to edit. `styles` is the one deliberate asymmetry: Core prepends it
because undo can re-apply formatting and no restore kind reports it.

**Cost, disclosed.** An undo touching one of those kinds now re-evaluates the written sheets and the
active one, twice (that is what `recalc_after_off_sheet_write` does), and a named-range undo
re-evaluates the whole workbook. Undo is a human-scale action and this fires only for restores that
actually reported a sheet; an ordinary same-sheet cell undo still runs the seeded cascade alone.

### 2d. Selection chrome hides cell decorations — FIXED 2026-08-07

The active-cell highlight painted over the cell's top-right corner — exactly where the note/comment
indicator lives. Selecting a commented cell therefore hid its own indicator from the user.
Measured: 15 indicator pixels with the selection parked elsewhere, **0** with the cell selected.

**Fix.** `registerCellDecoration` grew a z-anchor. `"under-selection"` (the default) is cell
CONTENT — data bars, sparklines, checkboxes — where the selection tint reading over it is correct,
exactly as it reads over the text. `"over-selection"` is INDICATOR chrome that must survive the
highlight. The cell pass paints over-selection decorations in place for cells no chrome covers and
defers the covered ones, which the renderer replays after `drawSelection` /
`drawClipboardSelection` and before the above-selection overlays — a chart floating over the cell
should still cover it. Deferring the already-computed context rather than running a second loop
keeps the geometry (merge masters, insertion-animation offsets, header clipping) owned by the one
pass that computes it, and costs one object per chrome-covered cell — one, for the usual
single-cell selection. Review's annotation triangles, ErrorChecking's error triangles and
CellBookmarks' dot declare the new anchor; the selection painter learned nothing about notes.

Verified by a deterministic pixel probe (`gridRenderer/cellDecorationZOrder.test.ts`): frames go
through the real `renderGrid` into a small alpha-compositing rasteriser, and "indicator pixels" is
the count of pixels that differ between the frame with the decoration registered and the identical
frame without it — the defect report's own measurement. The count on a selected cell is now
**equal** to the count on an unselected one, for a single-cell selection, a containing range and a
clipboard range; an `"under-selection"` decoration still measures strictly lower when selected,
which is what keeps the two anchors demonstrably different.

**Golden impact, triaged rather than assumed (2026-08-07).** Exactly three committed goldens are
affected, all in the FUNCTIONAL suite (`e2e/tests/__screenshots__/comments-notes.spec.ts/`):
`comments-cell-with-indicator`, `notes-cell-with-indicator` and `comments-indicators-visible`.
Each of those tests annotates a cell, then calls `navigateTo` on **that same cell** and clips the
screenshot to it (W1, X1, W6 respectively) — so every one of them captures an annotated cell while
it is the active cell, which is precisely the frame this change alters.

**RESOLVED 2026-08-07: they did NOT need re-recording, and were not re-recorded.** The prediction
above ("they currently encode the defect, they will go red") was written at triage time and has
since been overtaken: the goldens were already re-recorded in the same change that added
`announceAnnotationsChanged` to the spec. Verified empirically rather than assumed — a cold
`--project=functional e2e/tests/comments-notes.spec.ts` run passes **7/7** against the committed
goldens on HEAD.

Two things are worth keeping, because both were misleading:

- **The committed goldens DO contain their indicators.** Decoded: the notes golden holds 10 px of
  `226,57,34` (the note triangle) and 15 px of `124,111,229` (a neighbouring comment triangle), on
  a cell whose column header is painted with the selected-column tint — i.e. an indicator that
  survives selection, which is the post-fix behaviour.
- **The spec header's "VERIFIED: the previously committed goldens hold zero #FF0000 and zero
  #7B68EE pixels" is not a safe test for "no indicator".** Those are the source constants in
  `Review/rendering/triangleRenderer.ts`; the renderer paints through the skin/theme, so the
  literal constant never appears in a frame. Counting exact constants will report "no indicator"
  on a frame that plainly has one. Count near-matches, or diff against the same frame with the
  decoration unregistered (which is what `cellDecorationZOrder.test.ts` and the live journey
  assertion already do).

The live oracle is unaffected and still holds: `correctness-cluster.spec.ts` test 10 ("a note
indicator survives being selected") passes on the running app.

The **visual suite (18/18) is not affected**: neither `core-visual.spec.ts` nor
`workflow-visual.spec.ts` creates a note, comment, bookmark or formula error, so no frame in it
contains an over-selection decoration to reorder.

### 2e. Backend mutations never reach the frontend for grouping, hyperlinks and tracing — FIXED 2026-08-07

Measured on the live app: `group_rows`, `add_hyperlink` and `trace_precedents` changed **0 pixels**
until something else forced a refresh. Tables and annotations had refresh events; these three did
not. Same class: **backend-created validations and notes stayed invisible to their extension's
frontend cache**.

**Fix.** Three new feature-neutral events (`OUTLINE_CHANGED`, `HYPERLINKS_CHANGED`,
`VALIDATIONS_CHANGED`; `ANNOTATIONS_CHANGED` reused), emitted **from the IPC wrapper, never a
call site** — the `ROWS_INSERTED` / `SHEET_ADDED` precedent — so "every route announces" is a
property of the code rather than a checklist. Verified against all three route classes: UI,
script broker (which drives the same wrappers through the `@api` services), and MCP, which has
**no** tools for any of the four and no reach to them from the Rust QuickJS surface either. The
only bypasses left are raw `invoke(...)` calls, which exist solely in E2E specs.
`coalescedRefresh.ts` keeps a mutating caller and its own listener from paying two round-trips.

**Tracing deliberately got no event** — `trace_precedents` is a pure query that mutates nothing,
so "0 pixels" is correct by construction. What was missing is a *door*: `@api/tracingService`
(the `groupingService` shape), registered by the Tracing extension. (The "no in-repo consumer"
caveat recorded here is now **stale**: it is registered by `Tracing/index.ts` and consumed by
`journeys/correctness-cluster.spec.ts` 3d and `tests/formula-tracing.spec.ts`, so the seam is
exercised rather than merely present.)

**Found and fixed on the way:** `resetGroupingState()` zeroed the outline bar on SHEET_CHANGED,
and `renderOutlineBar` returns early while the bar is zero-sized — so the only code that would
re-fetch stopped running. Switching to a sheet that already had groups showed **no outline for
the rest of the session**.

**The document-REPLACING routes were still missing — FIXED 2026-08-07.** Announcing from the
mutation wrappers covers every per-mutation route, but `new_file` and `open_file` replace all
four states at once and go through none of them. Measured live: after grouping rows and then
File > New, the grid still reserved a **36 px outline gutter** for a workbook whose backend
reported `maxRowLevel: 0`, and the sheet-tab bar still showed a clickable phantom **"Sheet2"**
whose backend index no longer existed (activating it errors with "Sheet index 1 out of range").
`AFTER_NEW`/`AFTER_OPEN` do not cover it — those are workbook-lifecycle events with their own
subscribers, and the four caches deliberately listen for the state they own. `newFile()` and
`openFileAtPath()` in `core/lib/file-api.ts` now call one `announceBackendStateReplaced()`
after the backend has committed (order asserted, not assumed: announcing early would have every
listener re-read and re-cache the OLD state, which is indistinguishable from not announcing).
`SHEET_CHANGED` rides along because it is literally true and because SheetTabs re-reads on it.

**The undo direction — CLOSED 2026-08-08, together with control create/delete (§1a).**

The blocker recorded here was real, but the diagnosis was one level too shallow: the problem was not
that four flags were missing, it was that the announcement WAS a flag ladder. Adding a domain meant
editing a Rust struct, a TS interface and an `if (result.xChanged) domains.push("x")` list in Core in
step, and the non-cell domains are precisely the ones nobody ever did that for.

**The announcement is now DATA.** `RestoreSpec.change_class: CustomRestoreKind` (one class per kind)
became `RestoreSpec.domains: MutationDomains` (a SET), because a restore is routinely more than one
thing at once — `obj_validation` is an object-store swap AND a validation change, and the old field
could only name one of them. `UndoResult` gained `refresh_domains: Vec<String>`; the five legacy
booleans are DERIVED from that same set, so a kind cannot be classified twice and disagree with
itself. Core stopped re-deriving domains and forwards what the backend reported. Five new domains:
`outline`, `hyperlinks`, `validations`, `annotations` — translated by the Shell to the very same
four `*_CHANGED` events the forward IPC wrappers emit, so the extension subscribers are unchanged —
and `controls`.

**Grouping had to become undoable first, because there was nothing to announce.** Every command in
`grouping.rs` wrote `state.outlines` and returned; the outline was restorable only as a passenger of
a structural edit (`obj_coord_stores`). So Ctrl+Z after grouping a block undid the user's PREVIOUS
action while the grouping stayed. A new `"outline"` CustomRestore kind plus `with_outline_undo`
wraps all eleven mutating commands: snapshot under a READ guard before `DocumentEffect::mutates`
constructs, record only when the command reported success (these refuse in several places, and a
refusal that pushed an entry would make Ctrl+Z a no-op the user has to press twice), and take the
undo-stack lock only after the outline guard is dropped — `apply_changes` holds the stack and then
reaches the outline store through a deferred restore, so the opposite order would invert it.

**Control create/delete are undoable through the existing `obj_controls` kind.**
`set_control_metadata` and `remove_control_metadata` snapshot the pre-mutation store;
`remove_control_metadata` refuses first, so removing nothing neither dirties nor pushes an entry.
The snapshot's `script_instance_ids` list is deliberately EMPTY for create/delete, and that is the
load-bearing half: a control's instance id derives from its ANCHOR, and the delete path DELETES its
object scripts rather than re-keying them, precisely so the next control created at that cell cannot
inherit code its author never wrote. Restoring a binding here would reopen that orphan-inheritance
bug, pointing at a script row that no longer exists — so undo brings back the CONTROL and nothing
else. Re-keying, where the same control MOVES and its binding must follow, remains the
structural-shift case, and that one does populate the list (`shift_controls`).

Both recorders honour the in-open-transaction contract, so a macro that creates ten shapes inside one
`begin_undo_transaction` stays ONE undo step. Redo runs through the same `apply_changes` with the
inverse transaction, so every assertion here has a redo twin.

The Controls extension needed a door of its own: it holds ONE sheet's controls in a frontend store,
swapped only on a sheet change, so a backend-only change to that store is invisible to it and a
repaint re-renders the same stale list. `AppEvents.CONTROLS_CHANGED` plus a fourth reloader on the
existing serialised reload queue.

Pinned by `undoing_a_grouping_restores_the_outline_and_announces_it`,
`redoing_a_grouping_puts_it_back_and_announces_it`,
`undoing_a_hyperlink_a_note_a_comment_or_a_validation_announces_its_domain`,
`the_legacy_flags_agree_with_the_domain_list`, `a_control_creation_undoes_and_redoes`,
`a_control_deletion_undoes_and_redoes`,
`undoing_a_control_deletion_does_not_resurrect_a_dead_script_binding`,
`a_scripted_batch_of_non_cell_mutations_is_one_undo_step` and
`every_outline_command_records_an_undo_entry`, plus the registry table itself
(`registry_matches_expected_domains`, `every_domain_but_hidden_has_a_wire_name`).

**Still open, deliberately:** `default_row_height` / `default_column_width` announce no domain. They
are geometry, and the frontend's dimension re-read covers the cases that already reach it, but an
undo of a default-dimension change ON ITS OWN does not force that re-read. Same class, much smaller,
and it belongs with the dimension owner rather than here.

**A hyperlink paints NOTHING, by construction — measured, and not a defect.** `add_hyperlink`
changes zero pixels of its cell and always did: the blue-and-underlined look is cell FORMATTING
that `InsertHyperlinkDialog` applies separately, and the Hyperlinks extension paints nothing at
all. What it owns is an `indicatorSet` feeding a cell CURSOR interceptor and the
Open/Edit/Remove context-menu items — and THAT is what went stale. The live oracle is therefore
the rendered cursor: `pointer` over the linked cell, `cell` over its neighbour, with nothing
refreshed by hand (`correctness-cluster.spec.ts` 3c). A pixel-diff assertion on the cell would
fail forever against correct code.

### 2f. The dirty *indicator* lags the dirty *flag* — FIXED 2026-08-07

After a backend-only mutation the title bar showed no asterisk even though `is_file_modified` was
true. The safety net worked; the ambient signal did not.

**Fix.** The announcement sits on the FLAG, not at the call sites. `FileState::is_modified` is a
`document_effect::DirtyFlag` rather than a bare `Mutex<bool>`, and its guard compares the value it
was locked at against the value at release, emitting `document:dirty-changed` on a real transition.
That covers `DocumentEffect::mutates`, the legacy `mark_workbook_modified` and the ~60 remaining
direct `*is_modified.lock() = true` sites in one move, with none of them having to remember — which
is the point, since asking 355 commands to emit an event is the same failure mode the dirty-flag
census existed to end. The API is `Mutex`-shaped (`.lock()`, `.unwrap()`, `.map_err(..)?`), so no
call site changed.

Only TRANSITIONS are announced, in both directions: a bulk operation over an already-dirty document
emits one event rather than one per write, a read emits none — including the `is_file_modified` the
frontend calls from inside the listener, which would otherwise loop — and the save/open/new
`= false` sites clear the asterisk. `shell/dirtyStateBridge.ts` re-emits onto
`AppEvents.DIRTY_STATE_CHANGED`, which `Layout.tsx` already re-titles on; that last hop is asserted
from source in `shell/__tests__/dirtyStateBridge.test.ts`, because a bridge nobody subscribes to is
a silent no-op of exactly the kind this program keeps finding.

### 2g. Smaller, verified, unowned — FOUR OF FIVE FIXED 2026-08-07

Each of the four was reproduced in a unit test that fails against the old code with the reported
symptom before it was fixed. Frontend only; no Rust was touched.

**`Ctrl+Home` is intermittently swallowed — FIXED, and it was NOT being swallowed.**
The diagnosis in the original report ("WebView2 level") was wrong, and the evidence was already in
the report: the *following* `ArrowRight` landed, so the container had focus and the handler was live.
Every keyboard navigation awaits `getMergeInfo` — an IPC round trip — *before* it dispatches, and each
keydown computed its target from the `selection` captured in the React render current when the key
arrived. Two keys inside one round trip therefore both started from A5, and the ArrowRight dispatch,
issued second, won. Ctrl+Home ran and was then overwritten. The intermittency is just IPC latency
against typing speed, which is also why a retry loop "fixed" it in tests.

Fixed in `core/hooks/useGridKeyboard.ts` with two refs and no timing assumptions: `liveSelectionRef`
is the selection navigation reasons from (updated the moment a navigation resolves, so the next one
chains off the real result), and `navChainRef` serialises the navigations so a slow one cannot be
overtaken by a later, faster one. While the chain is busy the ref is authoritative; when it drains,
React state takes over again so a mouse click or a Name Box jump is still picked up. Ctrl+A,
Ctrl+Shift+Space and Ctrl+Shift+End go through the same `commitSelection` for the same reason.
Pinned by `core/hooks/__tests__/gridKeyboardNavigationOrder.test.tsx`, which holds the round trip
open deliberately; against the un-queued code it reads `r4c1` — B5, the exact symptom reported.

**The Script Editor's macro `<select>` picks the wrong macro — FIXED.**
Three independent asynchronous things decided the initial selection: the editor registering its
cross-window listeners, the main window's 4-second fallback delivery timer, and the editor's own
"nothing selected yet, take the first one" fallback. Under load a slow-booting editor let the timer
deliver into a void — `deliverOnce` then closed the channel, so the payload was **lost outright** —
and the alphabetical fallback chose the first macro. `sbfault` sorts before `statusbar`, which is
precisely what was observed.

The requested document identity now travels **with the window**, in its URL fragment
(`ScriptableObjects/lib/editorTarget.ts`; a fragment, not a query string, so neither the dev server
nor Tauri's asset protocol sees it and the page is served identically). The editor reads it on its
very first render — before any listener, timer or listing — so the initial selection is decided by
identity rather than arrival order. Three supporting changes: READY is now definitive while the timer
is not, so a timer delivery no longer closes the channel and a late READY re-delivers (safe by the
editor's own "opening is selecting, and keeps unsaved edits" contract); the open-with-macro handler
selects **synchronously** on payload arrival instead of after its `getWorkbookScript` await; and the
"take the first one" fallback cannot run while a requested id is outstanding, releasing it only once
both listings have answered and the id is in neither.
Pinned by `objectScriptEditorSelectionIdentity.test.tsx` — including a test asserting that *without*
a requested id the alphabetical fallback really does pick the decoy, so the fix is what changes the
outcome. Against the pre-fix code three of its tests fail with
`expected 'macro-e2evba4-sbfault-…' to be 'macro-e2evba4-sb-…'`.

**The inline editor never expands over neighbouring cells — FIXED (horizontal case).**
`core/components/InlineEditor/expansion.ts` is the pure geometry; `InlineEditor.tsx` measures the
entry (widest line, so Alt+Enter multi-line is handled) and grows the box rightward. Two rules are
what the tests hold: it never covers a cell that holds data, and it never crosses the viewport edge.
A neighbour whose contents are **not yet known** counts as occupied, so the in-flight lookup can
never paint over a value. The neighbour lookup is one `get_viewport_cells` per edited cell — not per
keystroke — because an entry can only grow while the user types. Merged cells are excluded (a merge
already spans its columns). The box hugs the text rather than snapping to whole columns, which is
also what collapses it again when the user deletes.
**Vertical growth for multi-line entries is NOT implemented** — the editor is still an `<input>`, so
Alt+Enter content is measured but shown on one line. That needs a `<textarea>` swap and is a
separate change.

**A truncated cell's underline is drawn wider than the ellipsised text — FIXED.**
`drawTextWithTruncationMetrics` now reports what was actually painted (`renderedWidth`,
`renderedX`, `truncated`) alongside the full-string width that callers use as the overflow signal;
`drawTextWithTruncation` is a thin wrapper over it, so no existing caller changed. The underline and
the strikethrough both measure the rendered glyphs. That also fixed a second case nobody had noticed:
a truncated string is drawn from the left edge regardless of alignment, so a right-aligned truncated
cell had its rule offset away from its own text. Accounting underlines are still cell-wide by design.
Pinned by `rendering/truncatedTextDecoration.test.ts`, which goes through the real `renderGrid` and
compares the rule against the string `fillText` received — it restates none of the renderer's
arithmetic. (Note for anyone writing similar fixtures: a long value with an EMPTY neighbour is not
truncated at all, it spills; the fixture blocks the neighbour on purpose.)

**BOTH REMAINING ITEMS CLOSED 2026-08-08 — and the first was not a crash at all.**

- **The two "hard crashes" are `dirty-flag-close.spec.ts` killing the app on purpose.** Named cause,
  measured rather than reasoned; see §3af below.
- **Vertical expansion of the inline editor — FIXED, and it was NOT cosmetic.** See §3ag below. The
  editor being an `<input>` was destroying Alt+Enter newlines, not merely showing them on one line.

---

### 2h. Proved live — what `correctness-cluster.spec.ts` now holds

`app/e2e/journeys/correctness-cluster.spec.ts` (10 tests, `journey` project) asserts §2b-§2f on
the RUNNING app, through the real UI, with no test double in the path. It is a JOURNEY because
it calls `new_file`, saves to disk and adds a sheet — the functional specs share one
accumulating workbook whose goldens encode prior residue.

Three techniques in it are worth reusing rather than re-deriving:

- **Reading another sheet without activating it.** `get_cell` only answers for the ACTIVE sheet,
  and switching to read would run `set_active_sheet`, which rebuilds the very dependency state
  under test. `get_workbook_state_digest` (cellsOnly) is a pure read of the stored per-sheet
  grids — no mirror, no recalculation, no rebuild. Every cross-sheet assertion uses it. The same
  correction was needed in `budget-model.scenario.ts`: its restored BUG-0019 assertions read
  `B3`/`B4` through `getCellDisplayValue` while **Sheet1** was active, so they read Sheet1!B3 =
  "Budget" and could never have passed. The expected VALUES (27800, -500) are unchanged and
  arithmetically forced; only the read mechanism moved.
- **"No overlay" as "these pixels do not move".** The pivot progress overlay is canvas-drawn and
  its bar re-renders every animation frame while it lives, so a stuck overlay cannot hold still.
  Two captures ~1 s apart that are byte-identical prove it is gone — no golden, nothing to go
  stale. Paired with a PRECONDITION capture before the refresh, so a failure cannot be blamed on
  something else that animates.
- **Indicator pixels as a difference, live.** §2d's own measurement, reproduced in the app: count
  the pixels that differ between the frame with the note and the frame without it, once with the
  selection parked and once with the cell selected. 65 px vs 65 px now; flipping Review's anchor
  back to `"under-selection"` gives 65 vs 10 and the test goes red.

Three traps cost real time and are worth knowing before touching this file:

- A **clipboard marquee** left by a copy animates forever and `new_file` does not dismiss it
  (Escape does), so it silently breaks any "these pixels did not move" assertion downstream.
- A **menu button's textContent concatenates its label with its chevron or shortcut** — the rows
  read "Outline▸" and "GroupAlt+Shift+Right" — so anchored `^Label$` patterns match nothing and,
  because Playwright has no default action timeout, the test HANGS until the 3-minute test
  timeout rather than failing in seconds. Every menu step here carries an explicit timeout.
- **Never edit anything under `app/src-tauri` while an E2E run is in flight.** The `tauri dev`
  watcher rebuilds and RESTARTS the app — even for a `#[cfg(test)]`-only file — and the suite
  then fails for reasons that look exactly like real defects. One macro run was lost to this.

---

### 2j. Switching sheets dirtied the document and ate the user's next Ctrl+Z — FIXED 2026-08-07

**Found by writing §2k's undo test, not by reading.** The headline assertion — edit, Ctrl+Z, the
dependents come back — failed on the running app with the source cell still holding its edited
value. The undo had fired; it had simply undone something else.

**What was actually happening.** The Sparklines extension saves unconditionally on every
`SHEET_CHANGED` (`saveNow()` in `extensions/Sparklines/index.ts:210`), and
`save_sparklines_impl` treated "write back the empty list you just read" as a change: it
constructed `DocumentEffect::mutates` up front and recorded an undo entry unconditionally. So on
a workbook with **no sparklines at all**, a plain sheet switch both dirtied the document and
pushed an undo entry named "Edit sparklines" that restored nothing.

Measured on the running app, on a workbook whose only content was `A1 = 100`, immediately after
a successful `save_file`:

| step | `is_file_modified` | title asterisk | `undoDepth` |
|---|---|---|---|
| after save | false | no | 4 |
| switch to Sheet2 | **true** | **yes** | **5** |
| switch back to Sheet1 | **true** | **yes** | **6** |

Two user-visible consequences, both of which a user would report as something else:

- **The close prompt lied.** `set_active_sheet` goes out of its way to declare itself
  `deliberately_clean(CleanReason::Navigation)`, with a comment saying that merely LOOKING at a
  workbook must never dirty it "or the close prompt stops meaning anything". An extension writing
  back what it had just read overruled that decision from outside.
- **Undo silently lost a step per sheet switch.** Look at another sheet and come back, and the
  next Ctrl+Z pops a no-op. Two switches, two dead Ctrl+Z presses, and the user's actual edit
  still on screen. This is exactly how it presented in the test.

**Fix** (`src-tauri/src/sparkline_commands.rs`): resolve the stored blob under a READ guard and
return early when the upsert would change nothing — absent, `""`, `"[]"` and `"null"` all mean
"no sparklines", so an absent entry and an empty list are the same document. This is the ordering
the file's own header already prescribes and which `delete_sparklines_impl` and
`clear_all_sparklines` already followed; `save_sparklines_impl` was the one that did not.
`DocumentEffect::mutates` dirties in its constructor, so the "is there anything to change?"
question has to be answered before it exists.

Same numbers after the fix: **1 / 1 / 1**, clean throughout.

Pinned by `an_upsert_that_changes_nothing_neither_dirties_nor_records_undo`
(`document_effect_objects_tests.rs`), which covers the sheet-switch shape, an identical re-save
of a real group, and — the teeth — a genuinely different payload that must still dirty and still
be undoable, so a guard that over-reached would fail too. The pre-existing
`saving_sparklines_dirties_and_deleting_nothing_stays_clean` asserted its dirty case by saving
`"[]"`; it now saves a real group, because `"[]"` no longer is a change.

**The generalisable lesson.** Every "save on X" wired to a lifecycle event is a candidate for this
bug, and the cost is paid by two features that have nothing to do with the extension — the dirty
flag and the undo stack. The mechanism cannot catch it: the extension was calling a legitimate
mutator, and the mutator honestly declared a mutation. Only the mutator can know that the write is
a no-op, so **the no-change check belongs in the command, not in the caller.**

---

### 2k. Proved live — what `census-followon.spec.ts` holds

`app/e2e/journeys/census-followon.spec.ts` (7 tests, `journey` project) is the live half of the
dirty-flag/recalc census's four contract verdicts, in the same spirit as §2h: real UI, real
WebView, no test double anywhere in the path. A JOURNEY for the usual reason — it calls
`new_file`, saves to disk, and adds a sheet.

What it pins, and the shape of each:

1. **Undo restores dependent values** — the headline, three tests. A typed edit to `Sheet1!A1`
   with `A2 = A1*2` and `Sheet2!A1 = Sheet1!A2`, then Ctrl+Z and Ctrl+Y, asserted first through
   the non-masking digest read (§2h's technique) and only then on the rendered Sheet2. Test 1b
   adds the pixel form: Sheet2 must repaint on the edit, repaint again on the undo, and land
   **byte-identical to the frame it had before the edit** — a repaint to some third state is not
   a restore. Test 1c drives §3b's verdict directly: a bulk paste that replaces a literal AND a
   formula in one transaction, undone, must give back the FORMULA (checked in the formula bar,
   not just its value) — and then a fresh edit to its input proves the restored formula is live
   in the dependency graph rather than a cached number.
2. **The dirty flag after the per-keystroke `mutates()` removal** — a typed edit dirties, reads
   do not, saving clears, and the whole cycle repeats. This is the test that found §2j.
3. **Inline-editor expansion** — measured off the live DOM node. Three points, not one: a short
   entry stays at the cell width, empty neighbours let the box grow to the text, and an occupied
   neighbour stops it dead at that column's left edge.
4. **Ctrl+Home** — 10 plain iterations plus 10 of the reported chained shape (Ctrl+Home
   immediately followed by ArrowRight, which must land on B1). The defect was intermittent, so a
   single pass proves nothing.
5. **Truncated-cell underline** — a pixel probe, no golden.

Four things in it are worth reusing:

- **`[data-inline-editor]`** is now on the editor input (`InlineEditor.tsx`). styled-components
  hashes the class name, so there was no way to select the live editor at all; it is otherwise an
  anonymous `<input>` among the formula bar and the Name Box.
- **`page.keyboard.press("Control+Home")` WORKS over CDP.** `fixtures.ts` and the three
  `test.fixme`d undo tests in `editing.spec.ts` both say WebView2 swallows Control combos before
  they reach the app. That is **stale for Ctrl+Home and for Ctrl+Z**: the real key press drove all
  20 iterations here, and `GridHelper.undo()`'s dispatched event drives the undo tests. The spec
  probes the real route once and falls back only if it fails, and it reports which route it used.
  Someone should re-check whether `editing.spec.ts`'s three `test.fixme`s can simply be un-fixmed.
- **A viewport clamp will silently weaken a width test.** The editor's expansion has three limits —
  the text, the first occupied neighbour, and the WINDOW — and the third outranks the other two.
  The first cold run measured 129.3 px unobstructed and 128.6 px obstructed and PASSED: both were
  clamped by the window, and the 0.7 px "difference" was coincidence. `navigateTo` scrolls
  MINIMALLY, so it does not move a cell that is already visible; the fixture now jumps far right
  first so the target comes back as the leftmost column, and a precondition assertion refuses to
  measure unless there is room. Correct numbers: cell 64.3, short entry 64.3, empty neighbours
  **248.7**, occupied neighbour **128.6** (exactly two columns, stopping at the wall).
- **A pixel probe needs its own teeth clause.** The underline test measures where the glyphs end
  and where the rule ends, both from pixels, and then asserts that the answer the PRE-FIX code
  would have produced (the cell clamp) is rejected by the very tolerance that just passed.
  Measured: cell 64.3 CSS px, glyphs end 49.7, underline ends 50.7, old-code clamp 61.3. Without
  that clause a fixture whose truncation happens to land near the cell edge passes for the buggy
  renderer too — and with narrow glyphs it very nearly does, which is why the fixture uses
  uniformly wide ones.

### 2l. The headings-off pair — FIXED 2026-08-08 (and the control click, characterised)

Two defects in one symptom, plus the shared-helper trap next to them. All three are closed; a
fourth, deeper one is now measured and named instead of suspected.

**(i) `set_sheet_display_flags` did not drive the renderer.** The four flags (`displayZeros`,
`showFormulas`, `viewMode`, `displayHeadings`) became per-sheet BACKEND state that round-trips the
`.cala` (v6) — but what DRAWS them is frontend Core state, fed by the `DISPLAY_*_TOGGLED` app
events the View menu emits. So the two halves agreed only when the change came from that menu.
Every other route — a script, an MCP tool, a `.calp` materialisation, an E2E spec restoring state —
moved the authority and left the renderer painting the previous document.

The fix is the `document:dirty-changed` shape, for the same reason: the setter is the single write
door for all four flags, so it is the single emitter. `sheets.rs` gained
`SHEET_DISPLAY_FLAGS_EVENT = "sheet:display-flags-changed"`, emitted **after the write guard is
dropped** (a subscriber that answers by calling `get_sheet_display_flags` would otherwise deadlock
against a still-held lock — pinned by an ordering assertion, not by a comment).
`shell/sheetDisplayFlagsBridge.ts` re-emits it as `AppEvents.SHEET_DISPLAY_FLAGS_CHANGED`, and Core
answers by re-reading the authority. **The app event carries no payload on purpose**: one hydration
path (`loadSheetDisplayFlags`) reads the backend, so no subscriber can act on a copy that has since
gone stale. It is deliberately NOT one of the `*_TOGGLED` events — those are frontend INTENTS that
`Layout.tsx` answers by writing BACK to the backend, so re-using one here would bounce the value
the backend just reported straight at it.

**(ii) `new_file` did not reset it.** Rust always reset the flags (`persistence.rs`, under
`CleanReason::LoadingFromDisk`); the frontend never heard. `announceBackendStateReplaced()` in
`core/lib/file-api.ts` — which exists for exactly this class, and already speaks for outline,
hyperlinks, validations, annotations and the sheet list — now announces the display flags too, so
`new_file` AND `open_file` are covered by one line. `SHEET_CHANGED` was not enough: Core hydrates
the flags on the `sheet:normalSwitch` window event `SheetTabs` emits, which is a different event
with a different meaning.

Hydration on **mount and on sheet switch** was already correct and is now pinned by a test that
counts the call sites, so a future edit cannot quietly reduce it to startup-only — the bug that
made a freeze on sheet 2 show sheet 1's panes.

**(iii) `readGridGeometry` trusted the config.** `e2e/helpers/grid.ts` translates a cell reference
into canvas pixels for every click and every screenshot probe in the suite, and it read
`config.rowHeaderWidth` — which keeps reporting 22/20 while the renderer paints 0/0. Every
coordinate it produced on a headings-off canvas was 22px left and 20px above the truth. The rule now
lives in ONE module, `core/lib/gridRenderer/layout/headerVisibility.ts` (`resolveHeaderSizes` /
`effectiveGridConfig`); `renderGrid` calls it instead of substituting the gutters privately, and the
helper **imports that same function** through `__calcImport` rather than re-spelling it. If the
import is unavailable the helper THROWS naming the reason — guessing is the bug it exists to fix.
`shapes-hometab.spec.ts`'s local copy of the rule is deleted; `image-ingress.spec.ts` and
`helpers/screenshots.ts` go through `readGridGeometry` and were fixed by the same change. No other
helper reads the gutters directly.

**THE FLOATING-CONTROL CLICK: characterised, and it is purely the geometry offset.**

The earlier note ("could not be selected at its painted position or at the config-offset one;
measured, not characterised") is now settled by a deterministic measurement against the shipped
hit-testers, with the shipped numbers — a real Insert > Controls > Button box of **80 x 28**
(`max(cellWidth, 80) x max(cellHeight, 28)`) and the spec's own click at painted top-left **+ (30,
10)**. `gridRenderer/layout/__tests__/headerVisibility.test.ts`:

- `renderGrid` paints floating overlays through `effectiveConfig` (gutters 0), while
  `getFloatingCanvasBounds` adds the RAW `config` gutters (22/20). The hit rectangle therefore sits
  **exactly `rowHeaderWidth` right and `colHeaderHeight` down** of the painted one — asserted by
  sweeping both axes for the first hit, not by reasoning.
- The click that failed is 30px right and **10px below** the painted top edge. 30 > 22, so it is
  inside in x; **10 < 20, so it is above the hit rectangle in y**. That is the whole miss, and it is
  why the failure looked capricious rather than uniform.
- **The hit-tester is not independently wrong.** The same unchanged config, region registry and
  `findFloatingRegionAt` DO find the control when the click is placed where that config says the
  control is. Nothing about control hit-testing is broken.
- **And it falls out of the headings fix**, verified rather than assumed: with `displayHeadings`
  restored, painted origin and hit origin are the same point and the identical click selects the
  control.

**THE RESIDUE, NAMED: 0 is not yet a legal gutter width.** The obvious closure — put 0 in the config
so painter and hit-tester agree — was tried and **rejected on measurement**. The gutters are read as
`config.rowHeaderWidth || 50` in roughly **60 places across Core and the extensions**
(`hitTesting.ts` alone has nine), so a legitimate 0 becomes **50** — a bigger offset than the 22/20
it was meant to remove. Two assertions in the test file pin that, so the next person does not spend
the same hour. Closing it means converting that `||` idiom to `??` first, across Core *and* the
extensions, which also fixes a pre-existing sibling: `drawGridLines` already receives the collapsed
config and recovers 50 from it, so gridlines and cells do not start at the same x on a headings-off
canvas today. That is a headings-feature project, not a display-flags one, and it is the honest
remaining state of "hide headings".

**Verification.** `check-types`, `lint:boundaries`, `check:line-endings` and the e2e `tsc` project
all clean; `cargo check --lib` clean. Three new test files, 33 tests:
`gridRenderer/layout/__tests__/headerVisibility.test.ts` (16 — the rule, the measurement, the
diagnosis, the `|| 50` blocker, and one-home source reads),
`gridRenderer/layout/__tests__/e2eGridGeometry.test.ts` (5 — drives the REAL
`e2e/helpers/grid.ts` with a fake Playwright `Page`, since vitest does not collect `app/e2e`), and
`shell/__tests__/sheetDisplayFlagsBridge.test.ts` (12 — the bridge, the Rust event-name and
emit-ordering contract, the Core subscription, and the `new_file` reset on both sides). The
surrounding suites are unmoved: `src/core/lib/gridRenderer`, `src/core/state`, `src/shell` and
`sheetViewState` run **55 files / 4,748 tests, 0 failed**.

**Not run here, and why:** the app-crate test binary did not build during this pass —
`undo_commands.rs` was mid-edit by concurrent work and failed with two `E0061` arity errors in test
code, in a file this change does not touch. `cargo check --lib` passes, and the only Rust change is
`set_sheet_display_flags` gaining an `AppHandle` and an emit.

### 2m. Bulk rewrites recalculated nothing, and cross-sheet cycles were undetected — FIXED 2026-08-08

The two §2c residuals, closed together because the first turned out not to be one command.

#### `clear_range` — and nine siblings

Recorded as "`clear_range` performs no dependent recalculation at all". Verified before fixing, and
true: the Delete key erased its cells, dropped their outgoing dependency edges and returned a
count. `=SUM(A1:A3)` kept its pre-delete total until an unrelated later edit swept it up.
`clear_cell`, the single-cell twin behind Ctrl+X and the clipboard paths, was the same and returns
no cells at all.

**The sweep is the finding, not the fix.** This class had already recurred twice — the two
hand-copied walks in BUG-0019, then `sort_range` — so every command that rewrites cell content was
enumerated and classified rather than just the one named. Ten were broken. The signature that
identifies them is worth recording: **five had an off-sheet twin that recalculated correctly while
the active-sheet path did not**, so the bug only appeared when you operated on the sheet you were
looking at.

| command | rewrites | before | now |
|---|---|---|---|
| `clear_cell` | one cell (Delete, clipboard cut) | **nothing** | seeded cascade |
| `clear_range` | a range (Delete key) | **nothing** | seeded cascade |
| `clear_range_with_options` (active) | a range (Clear All/Contents) | **nothing** — off-sheet twin was correct | seeded cascade, content branches only |
| `clear_range_on_sheets` | a range on grouped sheets | **nothing** | `recalc_after_off_sheet_write` |
| `remove_duplicates` | compacts + clears the tail | **nothing**, and never rebuilt the dependency maps either | rebuild, then seeded cascade |
| `replace_all` (active) | every matched cell | **nothing** — off-sheet twin was correct | seeded cascade |
| `replace_single` (active) | one cell | **nothing** — off-sheet twin was correct | seeded cascade |
| `merge_cells` | erases every slave cell | **nothing** | seeded cascade |
| `consolidate_data` | an aggregated block | **nothing** | branches on destination sheet |
| `bi_insert_result` | a query-result block | **nothing** | branches on destination sheet |
| `sort_range` | permutes a range | fixed in §2c | unchanged |
| `update_cells_batch_core`, `fill_range` | paste / fill | fixed in §2c | unchanged |

Every fix routes through the ONE shared cascade — `recalc_after_active_sheet_bulk_rewrite` for the
active sheet, `recalc_after_off_sheet_write` for others — and runs as a **second lock phase** after
the command's own guards are dropped, the `sort_range` shape, because those helpers take the same
grid and dependency mutexes and std mutexes are not reentrant. No fourth copy of the walk was
added.

Three details worth keeping:

- **Seeds are the cells whose VALUE moved, not the cells touched.** `clear_range_with_options`
  seeds only its All/ResetContents/Contents branches; Formats, Hyperlinks and RemoveHyperlinks
  change `style_index` and nothing a formula can read. That is deliberately tighter than the
  off-sheet twin, which excludes only Formats.
- **`remove_duplicates` needed a dependency rebuild before it could be seeded at all.** It compacts
  rows upward, so formula cells land at new positions while the maps still describe the old ones —
  the BUG-0010 hazard `sort_range` rebuilds for. Seeding a cascade over stale edges would have
  walked the wrong graph, so the rebuild is part of the fix rather than a separate nicety.
- **`consolidate_data` is driven from a thin command wrapper**, seeding from the result's
  `updated_cells`. Its two write branches (label mode, position mode) each end in their own
  `ConsolidateResult` inside their own lock scope; seeding from the returned positions needs no
  lock and cannot drift from the write if a third branch appears.

Still not seeding, and deliberately: the style-only commands (`apply_formatting`, `set_cell_style`,
`apply_border_preset`, `set_cell_protection`, `set_cell_rich_text`) change no value a formula can
read; `calculate_now` and `open_file` ARE recalculation; the solver, goal-seek, data-table and
scenario commands run their own evaluation loops over the cells they write. `drill_through_to_sheet`
writes a freshly created sheet nothing can yet reference. `undo_pivot_overwrite` and the table
totals-row/calculated-column commands (`toggle_totals_row`, `set_totals_row_function`,
`set_calculated_column`, `check_table_auto_expand`) write cells and do NOT seed — they are in class
but were left alone, because they belong to the pivot/table owners and each writes into a region
whose own refresh path is the thing that ought to trigger. They are named here so the next sweep
starts from a list rather than a grep.

#### TWO MORE SIBLINGS, and the reason a list of names could never have been enough (2026-08-08)

The sweep above enumerated ten commands and fixed them. Integration enumerated the CRATE, and found
**two more that the ten-command sweep had not named at all** — which is the finding, because it is
the third time this class has been "swept" and the second time the sweep missed a member.

- **`bi_refresh_connection` recalculated nothing**, in the same file as `bi_insert_result`, which
  the sweep HAD fixed. A refresh replaces the whole query-result block exactly as an insert writes
  it, so every formula reading a refreshed region kept the PREVIOUS refresh's numbers. Fixed the
  same way and with the same seeds — the UNION of the old block and the new one, because a refresh
  returning fewer rows blanks cells a formula was reading, and a `=SUM()` over the shrunken tail is
  exactly as stale as one over the rewritten head. The recalculation runs ONCE after the query loop
  (two active queries can share a sheet), when every grid guard has been dropped.
- **`merge_cells_off_sheet` recalculated nothing** — the mirror of the asymmetry the sweep itself
  identified as the diagnostic signature. `merge_cells` was fixed; the off-sheet twin it returns to
  early was not, so merging on the sheet you were NOT looking at left a formula reading a destroyed
  slave cell showing the destroyed value. Gated on "something a formula can read was actually
  erased", so a merge over empty cells still pays nothing.

**The sweep is now MECHANICAL, and that is the durable half.**
`every_cell_writing_function_either_recalculates_or_is_exempt_with_a_reason` does not take a list of
command names — a list cannot fail for the command nobody thought of, which is precisely how both of
the above survived. It WALKS `app/src-tauri/src/`, strips `#[cfg(test)]` modules, finds every
function containing a `set_cell` / `clear_cell` call, and requires each one to either reach a shared
recalculation entry point or appear in an `EXEMPT` table **with a written reason**. Seventy-six
functions are classified today. A new cell-writing command fails the suite until somebody makes that
decision explicitly, and a stale `EXEMPT` entry fails it too — a considered decision about code that
no longer exists is its own kind of lie.

Classifying all seventy-six also forced three entries the prose above had not covered:
`create_pivot_inner` and `delete_pivot_table` are IN CLASS and left to the pivot owner alongside
`undo_pivot_overwrite` (a formula over a freshly written or freshly cleared pivot block does stay
stale); and `relocate_cell_references` is recorded as a **named residual** — it re-evaluates the
formulas it rewrites but does not cascade to THEIR dependents, and the cut/paste flow's paste half
seeds only from the pasted block. `rename_table_refs_in_formulas` and `rewrite_table_refs_to_ranges`
are exempt on a different ground: they re-point references at the same cells, so no value moves.

**Proved non-vacuous** by reinstating the defect: with `merge_cells_off_sheet`'s recalculation
disabled, the census fails naming exactly `merge_commands.rs::merge_cells_off_sheet`, and the
behavioural test `off_sheet_merge_recalculates_the_formulas_that_read_its_slaves` fails with the
live symptom (`Some(Number(9.0))` where `Some(Number(0.0))` is required — the value of a cell the
merge had already destroyed).

#### Cross-sheet cycles

`partition_formula_cells` runs Kahn's algorithm over one sheet's local map, and that map is built
from `ExtractedRefs::cells` — **unprefixed references only**. So `Sheet1!A1 = Sheet2!A1` with
`Sheet2!A1 = Sheet1!A1` was detected nowhere and terminated with whichever number the evaluation
order left behind. An order-dependent number is the worst failure available here: the soak and
regression oracles compare recalc results across runs.

**Where the check went, and where it did NOT.** The obvious move — extend
`cascade_cross_sheet_dependents` — is wrong, and finding out why is the useful part.
**The edit path has no cycle detection at all, not even for same-sheet cycles.** Typing `A1 = B1`
then `B1 = A1` produces numbers on the edit path today; `#CIRCULAR!` appears only from the two
FULL-recalculation passes (`recalculate_sheet_values`, `calculate_now`), which is where
`partition_formula_cells` lives. Adding a cross-sheet check to the cascade would therefore have made
cross-sheet cycles *stricter* than same-sheet ones — the opposite of "exactly as a same-sheet one
does". The check went where the existing one already is: one workbook-level graph
(`workbook_circular_cells`), merged into each sheet's partition, so a cross-sheet cycle lands in the
same `circular_groups` bucket a same-sheet cycle lands in.

**Iterative calculation falls out of that choice rather than needing a special case.** Iterative
calc is a supported feature and a deliberate circular reference under it must keep converging.
Because cross-sheet members join the same bucket, they inherit the existing `iteration_enabled`
branch untouched: iterate when on, `#CIRCULAR!` when off. Verified both ways
(`iterative_calculation_still_converges_across_sheets` converges `x = 0.5x + 10` to 20;
`iterative_mode_never_writes_circular_across_sheets` is the negative half stated separately so a
regression fails loudly). One honest limitation: a per-sheet pass iterates only the members living
on the sheet it is evaluating and reads the other sheet's cached value, so a cross-sheet iterative
cycle advances **one hop per whole-workbook round** rather than converging inside a single pass. It
converges geometrically across rounds; it is not instantaneous.

**Cost — two structural gates and a memo. Reasoned, not measured.** This runs on the hot path, and
the perf audit is a standing constraint.

1. **No cross-sheet reference anywhere → return immediately.** The scan that discovers this is the
   same single AST walk that would have built the graph, so a single-sheet workbook pays one pass
   over its own ASTs and nothing more.
2. **The SHEET-LEVEL projection must itself contain a cycle.** Project every cross-sheet edge to
   (precedent sheet → dependent sheet) and run Kahn over that S-node graph. A cell cycle crossing a
   boundary implies a cycle in the projection, so an acyclic projection is a *sound proof* that no
   cross-sheet cell cycle exists — and real workbooks are overwhelmingly layered (data sheets
   feeding a summary), i.e. acyclic. Only a workbook whose sheets genuinely reference each other in
   a loop pays for the cell-level Kahn.
3. **Memoised per recalculation pass** (`begin_circular_pass`), because
   `recalc_after_off_sheet_write` calls `recalculate_sheet_values` 2*(S+1) times in a row. The
   answer cannot change between those calls: recalculation rewrites cell VALUES, never formulas or
   ASTs, and the graph is a function of the ASTs alone. Without this the workbook graph would be
   rebuilt on every one of those calls — the O(S²) that made a naive fix unacceptable.

The projection in step 2 is an over-approximation, so the cell-level Kahn is what keeps it honest.
`mutual_sheet_references_without_a_cell_cycle_stay_numeric` is the guard: Sheet1 reads Sheet2 and
Sheet2 reads Sheet1 through *different* cells, the projection is cyclic, and the answer must still
be two numbers. Reporting `#CIRCULAR!` for an ordinary layered workbook would be far worse than the
bug being fixed.

**A bonus catch.** `=Sheet1!A1` written *on* Sheet1 is a same-sheet cycle the local detector cannot
see, because prefixed references land in `cross_sheet_cells` and never in `ExtractedRefs::cells`.
The projection records it as a sheet self-loop, so it is now reported. (Quoted `='Sheet1'!A1`
behaves the same — the lexer keeps its case, and the walk matches sheet names
case-insensitively, the same normalisation `normalize_cross_sheet_refs` performs.)

#### F9 reported the cycle on ONE sheet — found LIVE, fixed 2026-08-08

Everything above is true of every path that recalculates EVERY sheet, and that is what
`recalc_after_off_sheet_write` does: `recalculate_sheet_values` once per sheet, so each sheet's own
pass reports its own members. **`calculate_now` is not that path.** It is F9, Formulas > Calculate >
Calculate Workbook, and the calculate-before-save step, and it evaluates the ACTIVE SHEET ALONE.

`merge_cross_sheet_circular` therefore moved the active sheet's members into a circular group and left
the members on the other sheets holding whatever number the previous evaluation order produced.
Measured on the running app while writing `remaining-correctness.spec.ts`, not reasoned: with
`Sheet1!A1 = Sheet2!A1` and `Sheet2!A1 = Sheet1!A1`, F9 on Sheet1 gave `#CIRCULAR` on Sheet1!A1 and
**`0`** on Sheet2!A1, and only a SECOND F9 after switching tabs made the two agree.

That surviving number is exactly the order-dependent answer this detector exists to remove. It is also
worse than the original bug in one respect: half the cycle now says "error" while the other half says
"zero", one tab apart, so a user reading the summary sheet gets a plausible number with a
contradiction next door.

**The fix — `mark_off_sheet_circular_cells`.** A cycle is a WORKBOOK-level fact, so every sheet owning
a member reports it. It is not a second detector and not a second traversal: it consumes the set
`calculate_now` has already computed, which is EMPTY for any workbook with no cross-sheet reference at
all (gate 1 of `workbook_circular_cells`), and it walks only its own members. Cells whose value did not
move are not re-announced, so a repeated F9 does not look like a change to a workbook nobody touched;
and the off-sheet cells are reported with `sheetIndex: Some(n)`, so Core — which applies only cells
carrying no sheet index — cannot paint an off-sheet value onto the sheet on screen. **Gated on
iteration being OFF**, for the same reason the active-sheet branch is.

Five tests in `bulk_rewrite_recalc_tests.rs`:
`an_f9_pass_reports_the_cycle_members_it_did_not_evaluate` (with a teeth assertion that the
single-sheet pass had NOT already reported the other member, so the mark is a change and not the state
the fixture arrived in), `a_repeated_f9_does_not_re_announce_an_already_circular_cell`,
`the_off_sheet_mark_leaves_a_layered_workbook_alone` (the false-positive guard restated for the new
writer), `the_off_sheet_mark_is_skipped_under_iterative_calculation`, and the source pin
`calculate_now_marks_the_cycle_members_on_the_sheets_it_does_not_evaluate`. The writer joins the
crate-wide census as an inner step of the pass, with its reason.

**Proved non-vacuous** by making the writer return early: exactly the two behavioural tests fail
(1,081 passed / 3 failed, the third being an unrelated flake that passes on a clean run) and both
guards keep passing — the correct signature for tests that guard against over-reporting.

**The lesson is the section's own lesson, twice.** Every test above recalculates every sheet, because
the harness's `recalculate_every_sheet` was the natural way to write them, and that is precisely why
none of them caught this. A unit test that models the wrong ENTRY POINT is as blind as a sweep that
takes a list of names.

#### Verification

`app/src-tauri/src/commands/bulk_rewrite_recalc_tests.rs`, 15 tests, reusing the `Workbook` harness
from `cross_sheet_recalc_tests.rs` rather than copying one (the harness gained `pub(super)`; a
copied harness drifts, and a drifted harness is how these defects hid). Behaviour is tested against
the real cascade; the command wiring is pinned from source the way
`sort_range_recalculates_the_range_it_rewrote` pins its own, because these commands take `State` and
cannot run in-process and the failure mode is silent.

`every_bulk_cell_rewrite_seeds_the_shared_cascade` is the sweep as an assertion: twelve commands
across four files, split into active-sheet, off-sheet and destination-chosen-at-runtime lists. A
command that rewrites cell content and appears in none of them is the next instance of this bug.

**Proved non-vacuous.** With the merge call and one `recalc_bulk` disabled, exactly four tests fail
(`clearing_a_range_recalculates_its_same_sheet_dependents`, `a_two_sheet_cycle_reports_circular`,
`a_three_sheet_cycle_reports_circular`, `a_prefixed_self_reference_is_a_cycle_too`) and the rest
pass — including the false-positive and iterative guards, which is the correct signature for tests
that guard against over-reporting.

Counts: core `cargo test` **1,282 passed / 0 failed** (baseline), app-lib **1,076 passed / 0
failed** (baseline 1,042; +15 here, the rest from concurrent undo work), `test_pivot` **56**,
`cargo check` clean on both workspaces, `check-types` clean, `check:line-endings` 0 mixed.
(Superseded at integration by §3ad — the two extra siblings above add 2 more app-lib tests.)

### 2n. The grid paints `#CIRCULAR`, not `#CIRCULAR!` — RECORDED 2026-08-08, deliberately not fixed

Found by an assertion written from these notes rather than from the app. Every section of this
register, every Rust test and `CellError::as_literal` all say `#CIRCULAR!`. The running app renders
**`#CIRCULAR`**.

`crate::cell_error_display` (`app/src-tauri/src/lib.rs`) is the one app-side authority on that
spelling, and it special-cases only `NA`, `Conflict`, `Blocked` and `Limit`, letting everything else
fall through to `format!("#{:?}", other).to_uppercase()`. Measured live across the family:

| variant | `CellError::as_literal` (the engine's canonical form) | what the grid paints |
|---|---|---|
| `Circular` | `#CIRCULAR!` | **`#CIRCULAR`** |
| `Div0` | `#DIV/0!` | **`#DIV0`** |
| `Name` | `#NAME?` | **`#NAME`** |
| `Value` | `#VALUE!` | **`#VALUE`** |
| `NA` / `Conflict` / `Blocked` / `Limit` | as listed | agree |

**Its doc comment claims it "mirrors `Cell::display_value` in core/engine/src/cell.rs exactly". It no
longer does** — `display_value` was moved onto `as_literal`, and nothing re-checked this copy. The
stale claim is worth more than the divergence, because it is the thing that would stop the next reader
from looking.

**Not a round-trip hazard — checked, not assumed.** `CellError::from_literal("#CIRCULAR")` falls back
to `Value`, so the obvious worry is that saving and reopening turns a circular cell into `#VALUE!`. It
does not: persistence stores the `CellValue` enum, not the display string. Verified live — save,
`new_file`, reopen, and the cell is still `{"Error":"Circular"}` rendering `#CIRCULAR`.

**Left alone deliberately.** No answer is wrong; only the spelling differs from the canonical literal,
and `#DIV0` has read that way for as long as the product has existed. Changing it moves every visual
golden containing an error cell and belongs with that re-record, not inside a verification pass.
`remaining-correctness.spec.ts` therefore asserts what the product PAINTS, with the divergence named at
the assertion — not a loose regex, which would also accept a future spelling nobody chose.

### 2o. "Calculate Workbook" calculates one sheet — FIXED 2026-08-09 (D1 decided: F9 = workbook, Shift+F9 = sheet)

The same root as §2m's F9 defect, stated as the general fact rather than as one of its symptoms:
`calculate_now` collects its formula cells from the ACTIVE-sheet mirror and evaluates only those. The
Formulas menu calls the item **"Calculate Workbook"**.

Where it shows, measured on the running app with iterative calculation ON,
`Sheet1!B1 = Sheet2!B1*0.5+10` and `Sheet2!B1 = Sheet1!B1`:

- **Six presses of F9 on Sheet1 moved nothing.** 15 / 10, unchanged, every time.
- Switching tabs and pressing F9 on each sheet IS a round, and the cycle then converges geometrically:
  15, 17.5, 18.75, 19.375, ..., **19.999999702 after 25 rounds**.

So §2m's disclosed "one hop per whole-workbook round" is exactly right, and a whole-workbook round is
not something F9 performs. A partial iterate is a legitimate value under iterative calculation, so this
is a LIMIT to decide about rather than a wrong answer to fix — but it is the honest state of "Calculate
Workbook", and §2m's defect was one consequence of it reaching a wrong answer.

Making the command genuinely workbook-wide is the obvious closure and is emphatically NOT a slip-in: it
is the hottest command in the product, `save_file` calls it when calculate-before-save is on, and its
cost would change for every workbook with more than one sheet. `remaining-correctness.spec.ts` test 3
drives whole-workbook rounds through the real tabs, which is the gesture the documented behaviour
actually describes.

**RESOLVED 2026-08-09. Excel's model, implemented exactly** — see D1 for the decision and the
benchmark. `calculate_now` (F9, `Formulas > Calculate > Calculate Now`, calculate-before-save) plans
and evaluates the **whole workbook**; the new `calculate_sheet` (Shift+F9, `Calculate Sheet`) is the
active sheet alone. The menu entries carry Excel's own names, not "Calculate Workbook" / "Calculate
Worksheet". The six-presses-move-nothing measurement is now a **single** press.


### 2p. A typed formula does not keep its NAME — FIXED 2026-08-09 (decided as D2; see §4 D2)

§2i's named-range work is about formulas that resolve THROUGH a name at evaluation time. Writing the
live proof for it found that no formula a user types is one.

`update_cell` resolves named references at ENTRY and stores the RESOLVED reference. Measured: with
`RATE` pointing at `$D$5`, typing `=RATE` into G1 leaves the cell holding the formula **`$D$5`** — the
name is not in the document at all, the formula bar shows `=$D$5`, and repointing `RATE` moves nothing,
F9 or no F9. The unit tests pass because their fixture writes `Cell::new_formula("=RATE*2")` straight
into the grid, a shape `update_cell` never produces. A test that models the wrong entry point again.

**The §2i fix is real and reachable, just not by typing.** Formulas > **"Apply Names..."**
(`apply_names_to_formulas`, Excel's own feature) rewrites the reference back into the NAME — confirmed
live, `f: "$D$5"` becomes `f: "E2E_REMAINING_RATE"` — and from then on the formula resolves through the
name, a repoint moves it, and the undo restores it. That is the route `remaining-correctness.spec.ts`
test 5 drives, and the whole chain (111 -> Apply Names -> repoint -> F9 -> 222 -> Ctrl+Z -> 111) is
asserted on the stored value AND on canvas pixels.

Whether entry SHOULD pre-resolve is a product call nobody has made. Excel keeps the name; keeping it
would make names live indirections and demote `apply_names_to_formulas` from "the only way in" to a
repair tool. Pre-resolving is cheaper to evaluate and is what the code has always done. Recorded with
the measurement so the decision starts from facts rather than from this register's own prose.

**DECIDED AND BUILT 2026-08-09 — Excel parity.** A typed formula now keeps its name and resolves it at
evaluation, with a real name -> dependents edge. The design, the cost decision and every test that had
to change are written up in **§4 D2**. The paragraph above stands as the measurement that produced the
decision; the fixture it describes (`remaining-correctness.spec.ts` test 5 needing Apply Names to have
anything to be about) no longer applies — that test now asserts the stored NAME directly and keeps
Apply Names as an IDEMPOTENCE check.

### 2q. The Animation play pill covers A1:C2 and swallows clicks — FIXED 2026-08-09 (D4 decided: viewport-pinned, with a close control)

**Resolution.** The pill is no longer a grid object. It is viewport-pinned DOM chrome registered
through `@api/ui`'s overlay registry and positioned over the grid canvas's bottom-left corner, with
a visible close control that **unloads the driver**. It claims no cell, is not in the grid's
hit-test path at all, and can be dismissed. The `clearDriver` half — the more important one — landed
with it: three product routes now exist where there were none. Full write-up in §4 D4.

The record of the defect is kept below because the class is the lesson: *a control that lives in
cell coordinates competes with the data for the one resource the grid cannot spare.*

---


Found as the root of the functional-suite cascade (§3a), but it is not a test artifact.
`extensions/Animation/overlay/playOverlay.ts` anchors the play pill at a FIXED SHEET POSITION near
the origin — its own comment calls viewport-pinning "a future enhancement" — so a loaded animation
puts a 172x26 hit-testable control on top of **A1:C2**, the three cells most likely to be clicked
in any workbook. A click there toggles playback instead of selecting the cell, and there is no
affordance saying so. Closing the Animation panel does not remove it; only unloading the driver
does, and the panel's button is labelled "Stop", which restores the model and leaves the driver
loaded.

The E2E suite hit this as a click thief for eighty-nine spec files and nobody could see it for
months. A user with an animation loaded hits it every time they click A1.

**And there is no way to get rid of it.** Every lifecycle event Animation subscribes to
(BEFORE_SAVE / BEFORE_OPEN / BEFORE_NEW / BEFORE_CLOSE / SHEET_CHANGED) calls `stopAndRestore`,
which restores the model and leaves the DRIVER LOADED — so the pill stays. `clearDriver` is the
only call that unloads it and **nothing in the product calls it**: not the panel's "Stop" button,
not closing the panel, not `new_file`. Once a driver is loaded, the pill is on A1:C2 until the
page reloads. That is why the E2E cleanup needs a `window` handle on the engine
(`__CALCULA_ANIMATION__`); the handle exists because the product has no route, and it should be
removed when the product grows one. *(It has one now, and the handle is deleted — see D4.)*

Recorded, not fixed: where the pill should live — viewport-pinned to a corner, given a close
affordance, or made click-through with a drag handle — is an owner decision about a visible piece
of UI, not a slip-in. What is NOT in question is that "a floating control sits on A1, eats the
click, and cannot be dismissed" is wrong in all three designs.

### 2r. Typing into a closed cell committed ONE character — FIXED 2026-08-09

**Measured, not inferred.** `type("hello")` into a closed cell committed **`"o"`**. `type("tabbed")`
committed **`"b"`**. Typing after F2 — editor already open — was always fine. So the loss was
specific to the open-then-receive-keystrokes path, and it predates the `<input>`→`<textarea>` swap.

**Root cause: opening the editor is asynchronous, and every keystroke that lands during the open
arrives at the grid CONTAINER, not at the editor.** `handleContainerKeyDown` answers a printable key
with `await startEditing(key)`, and `startEditing` awaits TWO IPC round trips — `checkEditGuards`
then `getMergeInfo` — before it dispatches the editing state. React then has to render the editor,
and the editor takes focus from a `setTimeout(0)`. The window is wide, and the container lost keys on
BOTH sides of it, by two different mechanisms:

* **Before the editing state existed.** The container had no way to know an open was already in
  flight. `globalIsEditing` is raised *after* the first await, so the second keystroke either found
  it still false (and called `startEditing` again outright) or found it true with `editing === null`
  and hit the "self-healing for stuck editing state" branch, which cleared the flag and then fell
  through to — `startEditing` again. Each call dispatched a fresh REPLACE-mode entry holding only its
  own single character, and the last dispatch won. Five keystrokes, five overlapping opens, one
  surviving character. That is the `"o"` and the `"b"` exactly.
* **After the state existed but before the editor had focus.** The container's "editing is in
  progress, let the editor handle it" early-return dropped the key on the floor — while the editor
  that was supposed to handle it did not yet have focus.

**The fix: an open window, latched synchronously, released when the editor is ready.**
`core/lib/editOpenBuffer.ts` holds a latch engaged by the keystroke that starts the open, BEFORE
`startEditing` awaits anything — which is what makes the next keystroke see an open in flight instead
of starting a second one. While it is engaged the container owns the keyboard: text keys extend the
pending entry (in order), `startEditing` seeds the editing state from that entry instead of from its
own argument, and once the state exists each further key is pushed straight into it. Enter / Tab /
Escape cannot be applied to a string, so they are latched and REPLAYED by the editor through its own
handlers the moment it is ready — which keeps "type a value and hit Enter immediately" working at
speed without a second implementation of what those keys mean.

Three details worth keeping:

* **No timing hack.** Nothing waits for a duration to decide what to do. The single timer in
  `editOpenBuffer` is a failsafe that only fires if the editor never becomes ready AT ALL; remove it
  and correct behaviour is unchanged. It is re-armed by every buffered key, so it can never fire
  while someone is typing. The deterministic release is the editor's own focus effect, which now
  calls `endEditorOpen()` whether or not it actually takes focus — a latch that outlived its editor
  would swallow the keyboard, and that is a worse failure than the bug being fixed.
* **The replay runs from a later render, deliberately.** `commitEdit` closes over `editing.value`
  from the render that created it. Replaying Enter inline from the focus effect would commit the
  value as it was one render ago, so the latched key is put into component state and executed from an
  effect that already sees the final entry and the matching `onCommit`.
* **IME is untouched, on purpose.** A composing keydown (`isComposing`, or `keyCode === 229` as
  WebView2 reports it) is never buffered and never opens the editor: the composed text arrives later
  as an input event on whatever holds focus, and taking the keydown would leave it nowhere to land.

Enter/Alt+Enter/Escape/Tab semantics are unchanged — the three edit-ending keys were refactored into
one `runTerminalKey` shared by the live handler and the replay, and the 47 existing editor tests are
green against it.

**Residual, documented.** Characters typed AFTER an Enter but still inside the open window belong to
the next cell, and the buffer refuses them rather than folding them into the value on its way to the
backend (three keystrokes inside one animation frame, including a commit). Alt+Enter inside the
window is handled as text — the caret is always at the end there — and Ctrl+Enter is passed through
to the container's existing fill-range branch.

**Tests.** `core/lib/__tests__/editOpenBuffer.test.ts` pins the key classification (15).
`core/components/Spreadsheet/__tests__/editorTypingRace.test.tsx` (13) is the oracle: it assembles
the REAL container-keydown → `useEditing` → `InlineEditor` wiring and holds the IPC round trip open
so the race is forced rather than hoped for. **11 of its 13 fail against the pre-fix code**; the two
that pass are the two that must not change (IME, F2). It covers the whole word committing in order,
the word AND its Enter arriving inside the window, Shift+Enter / Tab / Escape at that speed,
Backspace correcting rather than clearing the cell, the phase-2 window (editor mounted, not yet
focused — forced with a faked `setTimeout` while React's MessageChannel scheduler keeps running), and
`getMergeInfo` being called exactly ONCE no matter how fast the word is typed, which is the direct
sentinel for the overlapping-opens regression.

**Live proof — written, NOT yet run.** `e2e/tests/inline-editor-live.spec.ts` gains tests 7 and 8:
type `"hello"` into a closed cell at full speed and assert the editor holds all of it and commits it,
and type `"tabbed"` + Enter with no pause at all and assert the cell reads `tabbed` and the cursor
moved to B31. Those two are the bug report verbatim. They deliberately do NOT use the file's
`typeIntoCell` helper — that helper exists only because of this bug, and its header now says so and
points at these two. **The functional E2E suite was not run for this change** (an overnight run with
other agents working in the same tree; launching the app would have collided), so these two are
written against the fix but unverified live; the six pre-existing tests in that file are unchanged
and still pass through the helper. The same open-window workaround still sits in
`formula-autocomplete.spec.ts` (`=SU`) and `journeys/census-followon.spec.ts` — both now redundant,
both left alone as they belong to other suites.

Also unchanged and still stale: the `editing mode - inline editor visible` visual golden, which the
`<input>`→`<textarea>` swap moved and which was never re-recorded. Nothing here changes the editor's
appearance, and captures were out of scope for this batch.

### 2s. Structural edits re-point references and never re-evaluate — FOUND 2026-08-09 by hardening the census, **FIXED 2026-08-09** (D8, decided by measurement)

`insert_rows`, `insert_columns`, `delete_rows` and `delete_columns` shift every cell, every
dependency map and every formula reference, then stop. No shared recalculation entry point is
reached — the only `recalculate_*` call in them is `grid.recalculate_bounds()`, which is geometry,
not evaluation.

That LOOKS value-preserving, and it is why nothing has caught it: each cell's cached value moves
along with the cell, and each formula is re-pointed so it still means the same cells. It is not
quite true. A range endpoint **shifts** — `shift_formula_row_references` turns `A1:A5` into `A1:A6`
when a row is inserted inside it — so a formula whose result depends on the SHAPE or POSITION of its
own reference keeps a number its own rewritten AST no longer produces:

- `=ROWS(A1:A5)` = 5, insert a row inside the range, the stored formula is now `=ROWS(A1:A6)` and the
  displayed value is still 5;
- likewise `COLUMNS`, `ROW()`/`COLUMN()` in a cell that moved, `COUNTBLANK` over a range that grew,
  `OFFSET` with relative anchors, `CELL("row")`.

Excel recalculates after a structural edit, and the owner's standing rule is that Excel parity
decides what this register does not. So parity says these four should seed the cascade.

**Deliberately NOT done in the integration pass.** The seed set for a row insert is every cell below
the insertion point, so this is a performance decision of exactly the kind D1 and D3 were made to
settle with a measurement, and a row insert is one of the most frequent gestures in the product. It
was raised as **D8** rather than guessed at.

**FIXED, and the measurement changed the answer.** The staleness surface above was written from
reading; the surface that was actually MEASURED is bigger, and it breaks the fix this section
assumed. `=ROW()` takes no arguments, so no structural edit ever rewrites it, and it still has to
change when its cell slides down a row — which means "seed the cells whose AST was rewritten" is not
a complete fix. Nor is `COUNTBLANK`/`OFFSET`/`CELL("row")` the right list: this engine's
`CELL("row")` with no reference is not position-sensitive at all, and `=OFFSET(A5;0;0)` follows its
rewritten base perfectly well. The three that were missing from the list are `=ROW()`/`=COLUMN()`
(position-only), `=SUM(A:A)` (a whole-column reference has no endpoint to shift, so a DELETE moves
its answer with nothing moved and nothing rewritten) and `=ROWS(DATA)` / `Sheet2!B1 =
ROWS(Sheet1!A1:A5)` (a defined name and a cross-sheet reference the edit itself re-pointed, neither
of which is an edge any active-sheet coordinate map holds). Full table and cost in **D8**.

**How it was found, which is the part worth keeping.** Not by reading the four functions — by
sabotage. The census enumerates functions whose body textually contains `.set_cell(` / `.clear_cell(`,
and these four write through `shift_per_sheet_cell_stores`, so the census had never enumerated them
at all. See §3ap.

**PROVED LIVE, 2026-08-09 (§3au).** `app/e2e/journeys/structural-recalc.spec.ts`, 10 tests, drives
the REAL row/column-header context menu ("Insert Row", "Delete Row", "Insert Column", "Delete
Column") and reads the value `get_viewport_cells` hands the canvas. The headline reproduces exactly:
`=ROWS(E1:E5)` renders 5, a menu insert inside the range rewrites it to `=ROWS(E1:E6)` and the
rendered cell says **6** — and the painted pixels change, so it is the canvas and not only the model.
Teeth were shown by deleting the seeding from a running build: **8 of the 10 fail**, each with the
stale value this section predicts (5 for 6, 10 for 11, 8 for 9, 4 for 3, 5 for 4). The two that
survive the sabotage are the two that should — test 6 is the no-regression control, and test 7 is
§2v, which is only reachable BECAUSE D8 recalculates.

**VERIFIED AND CLOSED AT INTEGRATION, 2026-08-09 (§3at).** The measurement reproduced; the census
names each of the four when its seeding is deleted, and the behavioural tests fail independently of
the census; undo and redo both carry settled values. **The fix was not complete as delivered**: the
shared cascade it seeds computed SUBTOTAL/AGGREGATE as if nothing were hidden, so a row insert
overwrote a correct `=SUBTOTAL(109;…)` with a wrong one — a defect this fix made reachable rather than
created. Found by asking what ELSE moves a formula or changes its inputs without writing a cell, and
fixed here: **§2v**. Cut/paste, drag-move, sort, hide-rows and AutoFilter were checked in the same
sweep and are all safe, each for a reason worth knowing (§3at).

### 2t. A stored name SHOUTS after save/reload — `BudgetTotal` -> `BUDGETTOTAL`. FOUND LIVE 2026-08-09 by the scenario oracle, a REGRESSION FROM D2 — **FIXED 2026-08-09** (the D1–D7 live-proof phase)

**The scenario suite was 24/24 at the D1–D7 baseline. It is now 18 passed / 1 failed / 5 did not
run**, and the failure is not a golden — it is the `save-reload-round-trip` oracle:

```
[save-reload-round-trip] Workbook state changed across save/reload. 1 differences;
  first: sheets[0].cells.2:5.f: "BudgetTotal" -> "BUDGETTOTAL"
```

**Root cause, and it is two lines.** `core/parser/src/lexer.rs:196` normalises every bare identifier
to upper case (`Token::Identifier(ident.to_uppercase())`), and `core/engine/src/ast_render.rs:98`
renders `Expression::NamedRef { name, .. }` as whatever the AST happens to hold. At ENTRY the cell
keeps the text the user typed, so the formula reads `BudgetTotal`; on RELOAD the formula is re-parsed
and the name comes back out of the lexer in capitals.

**This is D2's regression, and it could not have existed before D2.** `update_cell` used to resolve
names at entry, so a `NamedRef` never reached storage and there was no bare identifier to round-trip.
D2 deliberately made the name survive into the document — which is right, and is what Excel does —
and in doing so it exposed the lexer's uppercasing on a path that had never been exercised.

**Severity: display and round-trip stability, NOT evaluation.** Every lookup in
`name_resolution.rs` keys on `name.to_uppercase()`, so `BUDGETTOTAL` still resolves to the same
range and the values are unaffected. What breaks is (a) the user's formula is rewritten in capitals
by the act of saving and reopening, and (b) the save/reload oracle fires, which aborted the
`budget-model` scenario and left its remaining 5 phases unrun.

**Excel parity decides the fix, and it is not "stop uppercasing".** Excel canonicalises a typed name
to the spelling of the DEFINED name — type `=budgettotal` against a name defined as `BudgetTotal`
and Excel rewrites your formula to `BudgetTotal`. It never shouts it. So the fix is to render a
`NamedRef` through the workbook's name table (which already holds the authored spelling) rather than
to preserve whatever case the lexer saw; that also makes entry and reload agree by construction,
which preserving raw case would not.

**NOT FIXED HERE, deliberately.** The candidate change is in the lexer's identifier path, which
every function name, `TRUE`/`FALSE` and every structured reference also travels, behind 1,282 core
tests — and the reason this was found at all is that the last person to touch this area shipped a
defect the unit suites could not see. That is an argument for a measured fix in daylight, not a
4 a.m. guess at the end of a re-record pass. This entry is the measurement.

#### THE FIX — 2026-08-09, and it is the one this entry predicted

**Excel canonicalises a typed name to the DEFINED name's spelling; so does Calcula now, on the way
back IN as well as on the way in.** `restamp_name_casing` already existed and already ran at entry
(`split_entered_formula`); what was missing was a caller on the LOAD path. `open_file` now calls
`restamp_workbook_name_casing` (`persistence.rs`) immediately before
`rebuild_all_dependencies`, which walks the active-sheet mirror **and every sheet in
`state.grids`** and hands each grid to `name_resolution::restamp_grid_name_casing`.

**It is the SAME function doing the work at both ends**, which is the whole reason this is a fix
rather than a second recipe: entry and reload cannot disagree about what a name is called, because
they call the same restamp against the same table.

- **Not "stop uppercasing".** The entry deliberately warned against touching the lexer's identifier
  path — every function name, `TRUE`/`FALSE` and every structured reference travels it, behind 1,282
  core tests. Nothing in the lexer or the parser was touched.
- **Cosmetic by construction.** It rewrites the `name` field of `NamedRef` nodes and nothing else.
  Every lookup on this path uppercases (`named_ranges` is UPPERCASE-keyed, `resolve_names_in_ast`
  uppercases, the evaluator's LET/LAMBDA scope uppercases), so no value, edge or resolution can move.
  LET/LAMBDA **binding positions are skipped** — they are locals, and respelling one after a workbook
  name that merely collides with it would tell the reader the wrong thing.
- **Cost.** Gated by `ast_has_named_refs`, so a formula that names nothing is skipped without a
  render, and a workbook with no defined names at all returns on the first `is_empty()`.
- **Not a cell write.** It mutates an AST a cell already holds, in place; it calls neither `set_cell`
  nor `clear_cell`, so it is not a member of the recalculation census's population and needs no
  exemption.

**Tests — written to FAIL first.** `app/src-tauri/src/name_casing_reload_tests.rs`, four tests. The
first asserts the SHOUTED spelling as a **precondition** (`Cell::new_formula("=BudgetTotal*2")`
renders `BUDGETTOTAL*2`) before restamping, so it cannot pass against a parser that never
upper-cased anything. The others pin that the DEFINED spelling wins over whatever was typed
(`=budgettotal` → `BudgetTotal`, which is Excel's rule and the reason this is a restamp and not a
"preserve what the user wrote"), that nothing but a defined name moves — including a `LET` local
called `rate` in a workbook that defines `Rate` — and that an empty name table is left exactly
alone. They live in their own `_tests.rs` file **because the census enumerates any function body
containing a `set_cell` call and skips `*_tests.rs`**; four grid-building fixtures would otherwise
have shown up as unclassified cell writers.

**Proved LIVE**, which is how the defect was found in the first place: `owner-decisions.spec.ts` D2
defines a MIXED-CASE name (`OwnerDecisionRate`), types `=OwnerDecisionRate`, saves, opens a fresh
document, reopens the file and requires the formula back **exactly**. An all-caps name would have
satisfied that assertion whether or not the restamp existed. Measured before the fix on the same
running app: `=OwnerRate*2` saved, reopened as `=OWNERRATE*2`.

**Reach, checked rather than assumed.** The restamp is on `open_file`, and `open_file` is also the
route an AutoRecover snapshot takes — `format_extension` maps `.cala.recovery` to the Calcula reader
precisely so that it does, and the AutoRecover extension only ever *writes*. So recovery is covered
too. The `.calp` overlay load (`calp_commands.rs`) rebuilds ASTs by its own route and was **not**
audited for this; a name authored in mixed case and arriving through a distributed overlay may still
come back shouting. That is the same one-line call in a different function, and it is left for
whoever next has that path under test rather than asserted on a path nobody ran.

### 2u. `vba-idioms-wave4` tests 7 and 8 "hang" — the BACKEND was wedged, not the tests. **ROOT-CAUSED AND FIXED 2026-08-09**

Not in the stated baseline (526 / 13 / 11 named no `vba-*` failure), and seen on every run of this
pass:

| test | result |
|---|---|
| `vba-idioms-wave4.spec.ts:1226` — `removeDuplicates on AA80:AA86` | 10.0m timeout, 3 runs of 3 |
| `vba-idioms-wave4.spec.ts:1303` — `onBeforeDoubleClick veto` | 10.0m timeout, 2 runs of 2 that reached it |

**It is a test hang, not a crash — measured, not inferred.** In the third run the app was still
serving CDP *after* both timeouts, which rules out the reading the first run invited. The 10.0m is
the spec's own `test.setTimeout(600_000)` (line 506) being spent, not a slow test.

**What the first run's "app died" actually was.** The app went down in two of the three runs, always
~46 minutes after launch and always with the launcher's own background task reported as `killed` —
i.e. the harness reaping the long-lived `yarn tauri dev` job, which takes `app.exe` with it. The
signature matches §3af's method: no panic in the tauri log, no Windows Application event, and the
one exit code that was observable was **1**, which §3af measured as `taskkill /F /T /PID` — the
idiom the teardown uses — and NOT the `0xffffffff` of `Stop-Process` nor the `0xc0000409` of a Rust
abort. **The product did not crash.** Everything after the hang in those runs is cascade.


#### THE ROOT CAUSE — a leaked read guard in `remove_duplicates`, and it wedged the whole backend

The entry above was right that this is not a crash and right that the app kept serving CDP. It was
wrong about the shape: **the tests were not slow and were not hanging on the UI.** The backend
command they drive never returned, and while it was stuck **every other Tauri command timed out** —
measured, not inferred: with `remove_duplicates` outstanding, `get_viewport_cells`, `get_sheets`,
`get_style`, `get_all_tables`, `get_undo_redo_state`, `is_file_modified` and even
`get_calculation_mode` all blocked for 5 s and were abandoned. That is one wedged command taking the
dispatcher with it, which is why test 8 — which shares the file and runs after 7 — died too, and
why it looked like two independent hangs.

**Reproduced with no macro, no editor and no Playwright**: a direct `remove_duplicates` invoke over
CDP against a freshly launched app, on the same seven cells, never came back.

**The defect.** `commands/data.rs::remove_duplicates` acquires the three name tables for the
dependency rebuild — `named_ranges`, `tables`, `table_names`, all `read()` — at **function-body
scope**. They therefore live past the explicit `drop()` list and straight through PHASE B, which
calls `recalc_after_active_sheet_bulk_rewrite`, which takes **the same three locks for read again**.
A recursive read on a writer-preferring `RwLock` is a deadlock the moment any writer queues in
between, and nothing recovers it. `sort_range` — which owns the identical
rebuild-then-seed shape and the identical comment about acquiring the tables at the call site —
already scopes its guards inside the match arm and is unaffected. This one did not.

**The fix is the braces**: the rebuild is now enclosed in its own block, so the guards end where the
rebuild ends. One-line change in effect, with the reason written at the site (including "do not
un-nest them") because the next person to tidy that function is the risk.

| | before | after |
|---|---|---|
| direct `remove_duplicates` invoke | never returned (60 s abandoned; every other command blocked) | **7 ms**, `duplicatesRemoved: 3` |
| `vba-idioms-wave4` test 7 | 10.0 m timeout, 3 runs of 3 | **14.6 s, passes** |
| `vba-idioms-wave4` test 8 | 10.0 m timeout | **9.5 s, passes** |

**Why no unit test caught it.** All eight of the D3 seeding changes are `State`-taking commands that
cannot run in-process, so their coverage is split into a behavioural half and a source-wiring half
(§4 D3). A source-wiring test can assert that the entry point is *called*; it cannot assert which
guards are still alive when it is. The thing that found this was running the product.

### 2v. The shared cascade re-evaluated SUBTOTAL/AGGREGATE as if nothing were hidden — FOUND 2026-08-09 by probing D8's NEIGHBOURS, **FIXED 2026-08-09**

**This is a wrong answer written over a right one, not a stale value**, and D8 is what made it
reachable. It was found by the D8 integration pass asking the question D8 itself did not: a
structural edit is not the only thing that moves a formula, so what ELSE changes a formula's inputs
without writing a cell?

`recalc_after_active_sheet_bulk_rewrite` — the ONE shared active-sheet cascade that D3's eight and
D8's four both seed — installed **no row-visibility pass**. `row_visibility.rs` is explicit about
what that means: "No guard => `active()` is None => the aggregates behave as if nothing is hidden."
SUBTOTAL 101–111 and AGGREGATE options 5–7 are the only functions in the set whose answer depends on
something that is not a cell value, so they are the only way to observe it — and every cell this
cascade re-evaluated was computed against a workbook with nothing hidden.

**Measured, not read** (the probe is now `the_cascade_re_evaluates_a_hidden_row_aggregate_with_the_rows_still_hidden`):

```
hide the row holding 20, settle it:      =SUBTOTAL(109;A1:A5)  ->  130   correct
insert a row well below the hidden one:  =SUBTOTAL(109;A1:A6)  ->  150   WRONG, and stored
                                         =SUBTOTAL(9;A1:A6)    ->  150   correct (the control)
```

130 to 150. The cascade did not leave a stale number, it re-derived a wrong one and overwrote a right
one — and the workbook would be SAVED that way.

**D8 made it common; D8 did not create it.** Every caller of that entry point was affected —
`sort_range`, `relocate_cell_references`, D3's eight — but before D8 the structural edit recalculated
nothing at all, so this particular cell kept its correct 130. The fix that made insert/delete
recalculate is what walked the gesture into the bug. That is the argument for probing a fix's
neighbours instead of declaring it complete: D8's own 17 tests all passed, and so did the census.

**THE FIX is the guard the two siblings already install** — one line plus its reason, in
`recalc_after_active_sheet_bulk_rewrite`, before any grid lock, exactly where `update_cell_impl` puts
it. `build_row_visibility` fast-bails when nothing is hidden anywhere, which is the overwhelming
majority of workbooks, and the D8 benchmark is unchanged within noise (302.74 ms worst against
302.55 ms for the same seed set immediately before the fix).

`recalc_after_off_sheet_write` never had the bug: it delegates to `recalculate_sheet_values`, which
installs the guard itself. That asymmetry is exactly the active/off-sheet shape that hid `sort_range`
and `merge_cells_off_sheet` before it.

**PROVED LIVE, 2026-08-09 (§3au) — and this is the first time it was reproduced anywhere but a unit
test.** Test 7 of `structural-recalc.spec.ts` hides a row through the real header menu, checks that
`SUBTOTAL(109)` and `SUBTOTAL(9)` really disagree (120 against 150 — the fixture hides 30, not the 20
of the probe above), then inserts a row through the real menu and requires 120 to survive. Teeth:
with the one-line guard commented out of a running build, the rendered cell reads **150** — the exact
symptom, on the painted grid, through a gesture a user makes. Restored and re-run green.

**Residual, named:** the same entry point also installs no `begin_lookup_pass()`, where
`update_cell_impl` does. That one is a per-pass CACHE, so its absence costs speed and not
correctness, and no caller holds an outer lookup pass that could go stale across the edit (checked).
Left alone: adding a cache is a performance change and this register does not make those without a
measurement.

### 2w. File ▸ New does not reset three stores the save path writes — so a NEW document silently saves the PREVIOUS one's pivots, ribbon filters and model connections (2026-08-09) — **FIXED, and the invariant is now a census; see 2w-FIXED at the end of this item**

**Found by probing §3av's neighbours, and CONFIRMED on the bytes.** Not by reasoning: by opening the
saved `.cala`.

`persistence::new_file` takes `AppState`, `FileState`, `UserFilesState`, `SlicerState`,
`PaneControlState` and `ScriptState`, and resets each of them (slicers, pane controls, workbook
scripts and notebooks, object scripts, extension data, pivot layouts, protected regions, user files).
It does **not** take `PivotState`, `RibbonFilterState` or `BiState`, and nothing else clears them.
`assemble_workbook_for_save` nevertheless projects all three into the workbook:
`collect_pivot_definitions(pivot_state, …)`, `collect_ribbon_filters_for_save(ribbon_filter_state)`
and `capture_local_bi_connections(bi_state)` — each of which serializes its whole live store with no
document scoping.

**The reproduction, on a cold app.** Workbook A gets one model connection ("LEAK PROBE MODEL", a
CSV-backed model), one grid pivot ("LEAK PROBE PIVOT") and one ribbon filter ("LEAK PROBE FILTER").
Then File ▸ New, one cell typed, Save as B. All three are still live after File ▸ New (1 / 1 / 1),
and B — a document into which the user typed a single cell — physically contains them:

```
ENTRIES: manifest.json, theme.json, styles/registry.json, sheets/0_Sheet1/…,
         pivot_definitions/def_019fe72a-….json      <- LEAK PROBE PIVOT
         ribbon_filters/filter_019fe72a-….json      <- LEAK PROBE FILTER
         bi_connections/conn_0.json                 <- LEAK PROBE MODEL
```

`bi_connections/conn_0.json` carries the **whole embedded model** (tables, bindings, measures,
source catalog), so this is not only content the user never authored — it is another project's
semantic model travelling inside their file.

**The three differ in blast radius, and the difference is which restore path clears.**

| store | leaks across File ▸ New | leaks across Open | why |
|---|---|---|---|
| `PivotState` | YES | no | `restore_pivot_definitions` clears before restoring |
| `RibbonFilterState` | YES | no | `restore_ribbon_filters` clears before restoring |
| `BiState.connections` (+ caches, roles) | YES | **YES** | `restore_local_bi_connections` only ADDS; nothing anywhere clears the map |

So BI connections accumulate for the lifetime of the process, across every document the user opens,
and every save embeds all of them.

**This is data INJECTION, not data loss** — the mirror image of §3av, which is presumably why a sweep
looking for lost writes went straight past it. Nothing is corrupted and nothing is lost; the file
simply contains objects its author never put there, silently and permanently.

**The fix is not "clear three more stores in `new_file`", and that is the point.** Each of these is a
`State<_>` a command mutates without a `DocumentEffect`, which is precisely the successor project
already on the list ("`BiState` / `PivotState` / `ScriptState` / `PaneControlState`", 47 sites across
13 files). What §2w adds is the reason that project is not merely structural debt: an ungated store
is also an UNSCOPED store, and the save path cannot tell the difference. Whatever shape that project
takes, the invariant it must buy is **"a store that `assemble_workbook_for_save` reads is reset by
`new_file`"** — which is a check that can be written, and should be, because three of the current
answers are wrong and no test noticed.

**Not fixed here, deliberately.** It is a cross-cutting change to three states owned by other
subsystems, arriving at the end of a pass whose job was reports; landing it unproved would be exactly
the mistake this register keeps recording. It is filed with a reproduction, the byte-level evidence,
and the invariant its fix must establish.

---

### 2w-FIXED (2026-08-09, later the same day). The invariant is bought, and it is CHECKED.

**The enumeration came first, and it found more than the three.** Before anything was changed, the
sources of `assemble_workbook_for_save` were enumerated from the source tree rather than by reading:
follow every call out of the save path, and collect every `<store>.<field>.read()/.lock()` in the
closure. **66 stores.** Then the same question of `new_file` and of `open_file`. Three of §2w's own
answers were confirmed; **three more stores nobody had named** came out of the same walk.

| store | leaked on File ▸ New | leaked on Open | what it costs |
|---|---|---|---|
| `PivotState.pivot_tables` / `.bi_metadata` | YES | no | §2w's pivot |
| `RibbonFilterState.filters` | YES | no | §2w's ribbon filter |
| `BiState.connections` (+ `pending_roles`) | YES | **YES** | §2w's whole embedded model, accumulating for the process lifetime |
| **`AppState.sheet_ids`** | **YES** | no | **worse than a leak: a COLLISION.** `build_workbook_for_save` reads `sheet_ids[i]`, so File ▸ New handed the blank document the PREVIOUS document's `SheetId` — the key every `.calp` override, subscription ledger entry and writeback region is filed under. Two unrelated workbooks then claimed the same sheet, and no later save can detect it |
| **`AppState.model_writeback`** | **YES** | no | the writeback COLUMN history (`model_writeback_values.json`): a blank document saved another workbook's submitted values |
| **`AppState.advanced_filter_hidden_rows`** | no | **YES** | folded into every sheet's persisted `hidden_rows`, so rows an advanced filter hid in the PREVIOUS document were written out as hidden in the one just opened |

Two further stores are outside the invariant (not save sources) and leaked anyway, so they were reset
with the rest: **`AppState.protected_regions`** (`open_file` never cleared it, so the previous
workbook's pivot/report/BI regions went on refusing edits to cells in the new one) and the
**`PivotState` session caches** (`views`, `cancellation_tokens`, `previous_states`,
`active_pivot_id`), each keyed by pivot ids the new document has never heard of.

**THE FIX IS A COLLAPSE, not six more `clear()` calls** — the shape that closed the report store
(§3av). There is now ONE `persistence::reset_document_scoped_stores`, taking all eight States, and
`new_file`'s ~150 lines of inline resets are gone into it. **`open_file` calls it too**, immediately
after the file is read and validated and before a single byte is restored — position deliberate: a
wrong password or a corrupt archive must leave the document on screen untouched, so a reset at the
top of the command would make a typo destroy the user's workbook. Most of `open_file`'s restores
already cleared before refilling; "most" was the defect, and a reset that runs for every store
whether or not the restore below is careful is what makes the class impossible rather than unlikely.

**`BiState` is TORN DOWN, not cleared, and that distinction is load-bearing.** A `Connection` holds
an `Arc<TokioMutex<Engine>>` reference-counted by the shared `EngineRegistry`, and the engine owns the
open database connectors. Dropping the map alone leaves every engine in the registry with a count that
can never reach zero — model, cached Arrow batches and connectors resident for the life of the
process, disk cache never flushed. `reset_bi_connections` therefore drains the map, RELEASES each
registry reference (which flushes that engine's cache and drops it on the last reference), and only
then drops the `Connection`. It never blocks on the engine lock: `release` uses `try_lock`, exactly as
`bi_delete_connection` does, so a query in flight — which holds its own `Arc` clone under the
established take-the-Arc-out-then-`await` pattern — finishes against the document that started it and
the engine drops after. Pinned by `the_teardown_does_not_block_on_an_engine_that_is_busy`, which
asserts the in-flight caller holds the LAST reference once the reset has run.

**The on-disk cache is deliberately NOT deleted**, which is where this differs from
`bi_delete_connection`. Deleting a connection is the user saying that data should be gone; closing a
document is not. The cache is keyed by model path, or by the connection's stable `local:{id}` identity
which `restore_local_bi_connections` reuses verbatim, so reopening the workbook finds its offline data
where it left it.

**`.calp` subscriptions: decided, and nothing changed for them.** A subscribed report needs its model,
and `load_embedded_data_sources` — reached only from `calp_pull` and `calp_refresh_data` — is the only
thing that ever creates a connection for a package data source. Those flows materialize package
content INTO the open document; they are not document-replacing, and running the reset there would
delete the connection the pull had just created. So they do not call it. The connection now lives
exactly as long as the document that pulled it, which is the correct lifetime and the one the census
enforces at both ends. Note what this does NOT change: opening a subscribed `.cala` in a cold process
never reconstructed its package connections in the first place (nothing re-materializes them on open),
so the cold behaviour is untouched — all that is gone is the in-session accident where a package
connection from an earlier document survived into an unrelated one.

**THE CHECK — a census over the save path's sources, in `document_store_census_tests.rs`.** It reads
the crate, follows every call out of `assemble_workbook_for_save`, collects the stores, and requires
each to be reset in `reset_document_scoped_stores` or to sit in `EXEMPT` with a written reason.
`EXEMPT` is **empty** and should stay so. Four companion tests hold the rest of it: every path in
`DOCUMENT_REPLACING_PATHS` must actually CALL the reset (half a census is worthless — the reset could
be perfect and never run); `RESET_FUNCTIONS` may only name helpers the reset really delegates to (that
list is what lets the census see through a helper, so it is also the one place a store could be
quietly excused); every exemption must carry a non-empty reason; and — the one that guards the census
against its own hand-written half — **every `#[tauri::command]` holding both `PivotState` and
`BiState` must be classified**, as document-replacing or, with a written reason, not. That signal is
chosen because a command cannot replace the document without putting those two stores back to blank
and cannot do that without being handed them, and because the frontend reaches the backend only
through a command, so the candidate set is closed. It is deliberately wide: 23 commands are in it
today, 2 replacing and 21 not, and each cost one sentence to decide. Without it,
`DOCUMENT_REPLACING_PATHS` would be exactly the by-name list this register keeps recording the
failure of.

**Both of the recalculation census's hardening lessons were needed here, and both are asserted on
synthetic sources.** (i) *It must see through a delegating helper* — and here BOTH sides delegate:
`assemble_workbook_for_save` contains not one `bi_state.` of its own (the read is inside
`capture_local_bi_connections`), and the reset reaches it only inside `reset_bi_connections`. A census
reading the two top-level bodies would have credited the save path with reading nothing and passed
forever. (ii) *A commented-out call must not satisfy it* — every call site is wrapped in a comment
naming it, so both sides read comment-stripped code. A third trap was found while building it: the
recalculation census's `indent <= 4` rule for `fn` headers resolves an `impl`'s `fn drop` as the
`drop(guard)` every lock release calls, which walked the graph out of the save path and into the
script executor, inventing four "save sources" that are application preferences. This census takes
free functions only, and says so in a test.

**Demonstrated firing, four ways, by sabotaging the real tree and restoring it.**

| sabotage | what failed | message |
|---|---|---|
| the ribbon-filter reset COMMENTED OUT | the census | `RibbonFilterState.filters` |
| a new `state.spill_hosts.lock()` read added to `assemble_workbook_for_save` | the census | `AppState.spill_hosts` |
| `open_file`'s call to the reset commented out | `every_document_replacing_path_runs_the_reset` | "`open_file` replaces the open document but does not call `reset_document_scoped_stores`" |
| the delegation `reset_bi_connections(bi_state)` removed, its name left in `RESET_FUNCTIONS` | `the_reset_delegates_to_every_helper_the_census_credits` + two behaviour tests | "…credits `reset_bi_connections` …but `reset_document_scoped_stores` does not call it" |
| `calp_pull`'s classification entry deleted | `no_command_with_document_wide_reach_is_unclassified` | "these commands hold both `PivotState` and `BiState` … and nobody has said whether they do: `calp_commands.rs::calp_pull`" |

The second sabotage also caught the census being honest in the other direction: placed first in
`build_workbook_for_save_with_slicers` (which `assemble` does not call) it correctly did NOT fire.

**And the LIVE spec was given teeth the same way, on a running build.** With the three resets removed
from `reset_document_scoped_stores` and the app rebuilt, `document-store-leak.spec.ts` failed exactly
where it should: test 1 with *"a document the user typed ONE CELL into carries the previous
workbook's pivot"*, and test 2 on its own CONTROL precondition — a workbook that never had a model
was already carrying one, which is the accumulation half of the defect showing up before the test
even reached its assertion. Test 3, the counterweight (*reopening A still finds everything A owns*),
passed throughout, so the two failures are the leak and not a broken fixture. Restored, all three
pass.

**The census is source-level, so behaviour is pinned separately** in
`document_store_reset_tests.rs` — 18 tests that populate the real stores, run the real reset and
assert emptiness, each with its populated-first precondition so none can pass on an empty store. Two
of them are counterweights rather than leak checks: the reset must NOT touch application state (script
security level, locale, reference style, iterative calculation, and the built-in Cell Styles gallery,
which is re-seeded), and it must not mark the document modified. The byte-level half — that the saved
`.cala` physically contains none of the previous document's entries, read out of the ZIP central
directory — is `app/e2e/journeys/document-store-leak.spec.ts`, including the counterweight that
reopening the original still finds everything it owns.

**One unrelated item cleaned up in the same pass.** `macro-link-model.spec.ts` and
`consent-refusal.spec.ts` both hard-coded `answer-native-dialog.ps1` as an absolute path into one agent
session's scratchpad — the defect already vendored out of `dirty-flag-close.spec.ts`, still sitting in
two specs. The script is now in the repo at `app/e2e/answer-native-dialog.ps1`, resolved from
`import.meta.url` (`__dirname` does not exist in this ESM suite and throws at module load, which
Playwright reports as a collection error for the whole project), and a missing driver now THROWS
instead of yielding an empty answer that reads exactly like "no dialog appeared".

---

### 2x. The UNDO STACK outlived its document — one Ctrl+Z after File ▸ Open destroyed a cell of the workbook on screen and wrote another document's value into it (2026-08-10) — **FIXED, and the class is now a census of its own**

**§2w's neighbour, and the mirror image of §2w's own lesson.** §2w-FIXED collapsed the reset into one
`persistence::reset_document_scoped_stores` and bought the invariant *"a store
`assemble_workbook_for_save` reads is reset when the document is replaced"*, checked by a census with
an empty `EXEMPT`. It was right about what it claimed. What it could not claim — **by construction** —
is anything about a store nothing serialises. `new_file` kept its own inline block, honestly labelled
*"Session state that is NOT a save source"*, and `open_file` had no equivalent. Everything in that
block therefore survived a File ▸ Open into a document that had never seen it.

**Measured on the bytes, cold.**

```
A.cala -> ["A-ORIGINAL"]      B.cala -> ["B-ORIGINAL"]
open A, edit DB1 -> undo state {canUndo:true, "Edit cell (0, 105)", depth 2}
open B          -> undo state UNCHANGED
undo()          -> updatedCells: [{row:0,col:105,display:"A-ORIGINAL"}]
save B as C     -> C.cala contains ["A-ORIGINAL"]   (B-ORIGINAL is GONE)
```

An `UndoTransaction` records `(sheet, row, col)` and the BEFORE value and names no document at all.
So the first Ctrl+Z in the freshly-opened workbook applies the closed workbook's before-image at the
open workbook's coordinates. The user spends an undo they never earned, loses a cell they never
edited, and the next save makes it permanent. **This is not injection like §2w and not a lost write
like §3av — it is a value from one document written over a value in another, and it looks exactly
like an ordinary edit afterwards.**

#### THE CLASSIFICATION, item by item — because half of that block is NOT the document's

The block was moved, not copied, and every line was classified first. The instruction to classify was
the right one: `new_file`'s block was a mix, and `FileState` in particular must NOT move.

| item | scope | why |
|---|---|---|
| `AppState.undo_stack` | **DOCUMENT** | the defect. Coordinates + before-image, no document identity |
| `dependents` / `dependencies` / `column_*` / `row_*` / `cross_sheet_*` / `name_*` (10 maps) | **DOCUMENT** | the dependency graph over THIS document's cells; rebuilt by `rebuild_all_dependencies`. The name edges matter separately (D2: a formula stores the NAME) |
| `AppState.table_names` | **DOCUMENT** | reverse index of `tables`; a stale entry resolves `Table1` to a table this document does not have |
| `AppState.workbook_protection` | **DOCUMENT** (and a save source) | carries the structure-protection PASSWORD HASH. Save-source status was hidden from the census — see the blind spot below |
| `AppState.spill_ranges` / `spill_hosts` | **DOCUMENT** | §2's finding; it deletes cells. Detail below |
| `AppState.next_cf_rule_id` | **DOCUMENT** | per-document id counter |
| `writeback_index` / `writeback_declarations` / `model_writeback_declarations` | **DOCUMENT** | this document's subscription regions; a stale set makes the next refresh diff report another workbook's columns as removed |
| `FileState.current_path` / `session_password` / `is_encrypted` / `mark_saved` | **CALLER'S, stays put** | not stores. They are the answer to "WHICH document is open", and the two paths must legitimately disagree: `open_file` sets the path it read and the passphrase that decrypted it, `new_file` sets neither. This is the one asymmetry the delegation check deliberately permits |

**And the ones the enumeration turned up that were in NEITHER path's reset** — the point of
enumerating rather than moving:

| item | scope | what it costs |
|---|---|---|
| `ScriptState.notebook_runtime` | **DOCUMENT** | **worse than the undo stack.** `checkpoints[i].grids` and `baseline` are whole `Vec<Grid>` snapshots, and `notebook_rewind` assigns one straight over `AppState.grids`. A checkpoint that outlives its document is a one-click replacement of the open workbook with a closed one |
| `ScriptState.notebook_executor` | **DOCUMENT** (session inside it) | the persistent QuickJS session holds the globals the PREVIOUS document's notebook cells defined. Dropped via a new sync `reset_detached()` — the mpsc channel preserves order, so the session is gone before the next cell runs, and it does not spawn the thread if none exists |
| `AppState.animation_snapshots` | **DOCUMENT** | the prior `Cell` values a running playback restores on stop. Stopping after the swap writes the old document's cells into the new one — with NO undo entry, because transient writes never make one |
| `AppState.id_registry` | **DOCUMENT** | `(sheet_id, position) -> CellId`. `open_file` re-seeds it from the restored override layer but nothing ever emptied it; it grew for the life of the process |
| `AppState.gather_cache` | **DOCUMENT** | `build_gather_data` serves this on every recalculation even past its TTL (deliberately — no registry I/O on the edit path), so a stale map feeds another document's collected submissions into this one's GATHER formulas |
| `AppState.pending_recalc` | **DOCUMENT** (and a save source) | `attach_pending_recalc_for_save` writes it into the workbook. `open_file` restored it; `new_file` never cleared it, so a blank document inherited — and saved — the previous workbook's "these cells were never calculated" claim |
| `AppState.writeback_rebuild_skips` | **DOCUMENT** | shown to the user verbatim by `calp_get_writeback_rebuild_skips`; a leftover blames the open workbook for another one's unreachable registry |

**The SESSION/MACHINE-scoped list, each with a written reason, is now `SESSION_SCOPED` in the census.**
`ScriptState.permission_grants` is the one §2w already named and the one that matters most: it holds
the session-scoped execute approval, and clearing it would silently re-arm scripts the user turned
off — a security decision reversed in the unsafe direction with no prompt. The rest: `security_level`
and `mcp_access_level` (machine settings), `notebook_exec_lock` (a `Mutex<()>`, a concurrency
primitive with nothing in it), `BiState.engine_registry` (not cleared but RELEASED, per
`reset_bi_connections`), `locale`, `reference_style`, `iteration_enabled` + `max_iterations` +
`max_change`, `calculation_mode`, `precision_as_displayed`, `calculate_before_save`,
`auto_recover_enabled` + `auto_recover_interval_ms` (application preferences — **none of them
serialised**, which is the same fact from the other side: if one ever becomes a save source the
save-path census will demand a reset and the exemption has to go), `subscriber_identity` (the person
at the machine, from the profile directory) and `calc_cancel` (the Ctrl+Break flag; it cannot carry a
stale cancel because `eval_budget::PassToken::claim` resets it at the start of every owning pass).

#### `clear_undo_history` — DELETED, not wired up

A `#[tauri::command]` with no product caller: no menu item, no command, nothing in `app/src` or
`app/extensions`. Its own doc comment named the route it was missing — *"e.g., when opening a new
file"* — and that route is real, but it is now `reset_document_scoped_stores`, which both
document-replacing paths run. **Re-exposing the same clear as a command would put the undo stack's
lifetime back into somebody's hands to remember, which is the shape that caused this defect.** There
is no user-facing reason either: Excel exposes no such action, and the stack's lifetime IS the
document's — the user asks for it by closing the document. Its one caller was E2E walker setup, where
it was already redundant (`resetToNewWorkbook` invokes `new_file` immediately before, and nothing
between that and the call pushes a transaction). Command, registration and call site are gone.

#### THE SPILL NEIGHBOUR — reproduced, and it is WORSE than the undo stack

§2w's list named `spill_ranges` / `spill_hosts` without a reproduction. Built one. Both maps are keyed
by bare `(sheet_index, row, col)`, and there are two distinct live consequences:

1. **A REFUSAL that never ends.** `check_spill_protection` probes `spill_hosts` and rejects the edit
   with *"The value contained in this cell is spilled from the formula in A1. To delete this value,
   you will need to modify that formula."* — naming a formula in a workbook that is no longer open.
   Those cells of the newly-opened document stay uneditable for the rest of the session, and the
   remedy the message gives is impossible to follow.
2. **A DELETION.** Clearing (or recalculating a dependent of) the stale ORIGIN takes the
   `spill_ranges.remove(...)` branch in `commands/data.rs`, which runs `grid.cells.remove(&(sr, sc))`
   over every coordinate the PREVIOUS document's spill covered. That deletes cells of the open
   document, and the undo transaction records only the cell the user actually touched — **so the
   deleted cells cannot be undone.**

So the neighbour is not a lesser instance: the undo stack overwrites one cell with a recoverable
value, the spill map silently deletes a block with no undo entry at all. Both are pinned live
(`document-store-leak.spec.ts`) and at the store level.

#### THE CENSUS — non-save-source state now has one, and the save-source census had a blind spot

**(a) The FIELD census.** `every_state_field_is_reset_or_exempt` enumerates every `pub` field of every
State the reset is handed — **123 fields across 8 States, parsed from the source tree** — and requires
each to be reset by the shared function or to sit in `SESSION_SCOPED` with a written reason. There is
no third answer. This is the check that would have failed for the undo stack on the day it was
written, and the save-path census could not have, however well written.

Guarded the same way `DOCUMENT_REPLACING_PATHS` is: `the_field_census_covers_every_state_the_reset_is_given`
compares `STATE_FIELD_SOURCES` against the reset's own signature in both directions, so a ninth State
cannot be added to the reset without a ninth family of fields being enumerated.

**(b) The DELEGATION invariant** — the cheapest one, and the one this fix buys outright. Both paths
run the same function, so anything either resets outside it is a bug.
`new_file_delegates_every_store_reset` requires `new_file` to touch **no store at all**;
`open_file_touches_no_store_the_reset_does_not_cover` allows `open_file` its fifty restores but
requires every store it reaches to be one the reset already blanked (one exemption, written:
`AppState.locale`, READ to format the returned cells).

**(c) A REAL BLIND SPOT in §2w's census, found while building (a) and fixed.** `scan_store_accesses`
read one line at a time, and rustfmt wraps a method chain the moment it does not fit — so
`state\n.workbook_protection\n.read()` and `state\n.pending_recalc\n...` were **invisible**. Both are
save sources. The census had reported an empty `EXEMPT` and a clean bill the whole time, and behind
the blind spot sat one live leak (`pending_recalc`, saved into blank documents) and one latent
(`workbook_protection`, reset only by `new_file`'s inline block). `join_method_chains` now folds
whitespace on both sides of every `.` before scanning; the save-path census's source count went 66 →
70. **This is the fourth hardening lesson, alongside the three §2w recorded** (see through a
delegating helper; a commented-out call is not a call; free functions only, or `fn drop` resolves as
`drop(guard)`).

#### DEMONSTRATED FIRING — four sabotages of the real tree, plus two on a running build

| sabotage | what failed | message |
|---|---|---|
| the `undo_stack` reset commented out | `every_state_field_is_reset_or_exempt` **and** `the_undo_stack_does_not_survive_the_document_it_belongs_to` | `AppState.undo_stack` |
| a new unclassified `pub sabotage_probe_store` field added to `AppState` | `every_state_field_is_reset_or_exempt` | `AppState.sabotage_probe_store` |
| a private `state.spill_hosts...clear()` put back into `new_file` | `new_file_delegates_every_store_reset` | "`new_file` reaches these stores itself: `AppState.spill_hosts`" |
| a WRAPPED `state\n.locale\n.lock()` read added to `assemble_workbook_for_save` | the save-path census | `AppState.locale` — i.e. the blind spot is really closed |
| **on a running build:** undo + spill resets removed, backend rebuilt | `document-store-leak.spec.ts` tests 6 and 7 | *"the freshly-opened workbook offers an undo it has not earned (depth 3, ...)"* — the freshly-opened workbook reporting a stack it never built; and the spill test failed at its FIRST edit, *"Cannot edit cell (2, 90): it contains a spilled array value from cell (1, 90)"*, which is the refusal half firing before the deletion half was even reached |
| **on the same build, store-level guard relaxed** to reach the byte oracle | the byte assertion | *"the saved workbook does not contain its own cell value at all"* — `B-ORIGINAL` is not in `C.cala` at all, because the Ctrl+Z put `A-ORIGINAL` there |

**The last row corrected the test, and that is worth recording.** The first version of the acceptance
test edited a DIFFERENT cell in workbook A than the one the two workbooks disagree about — and it
**passed on the demonstrably broken build**, because the leaked undo entry pointed at a cell B left
empty. The leak was real, the corruption was real, and the oracle could not see it. The probe now
edits the same cell the register's original reproduction did — which is, on inspection, exactly what
that reproduction was careful about and the test was not. **An acceptance test that has not been made
to fail is a hypothesis, and this register's record on hypotheses is unchanged.**

#### Where the behaviour is pinned

`document_store_reset_tests.rs` went from 12 `#[test]` items to 22: one per store above, each with
its populated-first precondition, so none can pass on an empty store. The counterweight
(`the_reset_leaves_application_state_alone`) gained ten assertions and now includes
`permission_grants`, `mcp_access_level`, `calculation_mode`, `precision_as_displayed`,
`calculate_before_save`, both AutoRecover settings, both iteration limits and `subscriber_identity` —
so a reset that got enthusiastic and cleared the user's security decisions fails here rather than
shipping.


### 2y. Deleting the ORIGIN of a spilled array leaves the spill map behind — the spilled cells become permanently uneditable AND undeletable for the session, and save as orphan literals (2026-08-10) — **OPEN, with a live reproduction**

Found while giving §2x's spill half a real-UI gesture, by asking a question §2x did not: the store-level
spec cleared the stale origin with `update_cell(row, col, "")`, so the register's whole account of the
spill map's *removal* rests on that one command. **The Delete key is not that command.** It runs
`clear_range`, which CHECKS `check_spill_protection` and never touches `spill_ranges` at all. So the
first real-UI version of the deletion probe pressed Delete, saw the neighbours survive, and would have
reported a clean run on a build that leaks. Following that thread found a defect that has nothing to do
with File ▸ Open — it happens inside one document, on the first press.

**Measured live, on the fixed build, cold** (`get_spill_ranges` and `get_cells_in_rows` verbatim):

```
A1 = "=SEQUENCE(4)"        A1..A4 -> 1 2 3 4     spill_ranges [{origin 0,0 -> 3,0}]
clear_range A1:A1  (the Delete key)              -> ok, 1 cell cleared
A1..A4 -> (empty) 2 3 4                          spill_ranges [{origin 0,0 -> 3,0}]   <-- UNCHANGED
update_cell A2 "typed"  -> REFUSED: "Cannot edit cell (2, 1): it contains a spilled array
                            value from cell (1, 1). Edit or delete the formula in the source
                            cell instead."
clear_range A1:A4       -> REFUSED: "We can't delete this value ... spilled from the formula
                            in A1. To delete this value, you will need to modify that formula."
```

**Both remedies the product offers are impossible to follow.** The source cell it names is EMPTY —
there is no formula left to edit or delete — and selecting the whole block and pressing Delete, which
is what a user tries next, is refused by the same guard. A2:A4 keep showing `2 3 4`, values that no
formula in the document produces, and they cannot be changed or removed for the rest of the session.

**It reaches the bytes, and it half-heals on reload.** Saving writes A2:A4 as ordinary literals
(measured: the archive holds them). Re-opening rebuilds the spill map from the restored formulas, so
`spill_ranges` comes back EMPTY and the cells are editable again — the dead-end is session-scoped, but
the orphan values are permanent in the file and the user has no way to know they became literals.

**Why it is not §2x.** Nothing here crosses a document boundary; the reset is irrelevant. It is
`clear_range` being a second writer to a store whose only maintainer is `update_cell`:

| command | clears the cell | removes the origin's `spill_ranges` entry | drops the `spill_hosts` claims |
|---|---|---|---|
| `update_cell` with `""` (data.rs ~1011) | yes | yes | yes |
| `update_cell` with a new formula (data.rs ~1212) | n/a | yes | yes |
| `clear_range` / `clear_range_with_options` / `clear_range_on_sheets` | yes | **no** | **no** |

**The fix is not one line, which is why it is filed rather than bolted onto §2x.** Two halves:
(a) `clear_range` must remove the spill range owned by any ORIGIN inside the cleared rectangle and
clear that range's cells — through its own `cells_to_clear` loop, so each removed cell gets an
`undo_stack.record_cell_change` (strictly better than `update_cell`'s branch, which removes them with
no undo entry at all — the deletion half of §2x); and (b) `check_spill_protection` must stop refusing a
host whose ORIGIN is inside the same rectangle, or "select the spill and press Delete" stays refused
after (a) fixes everything else. (b) changes a guard with three call sites and needs its own tests.

**Not fixed in this pass, deliberately.** It is a different defect in a different command from the one
this pass was sent to prove, the Delete key is one of the hottest paths in the suite, and half of it —
removing cells without recording them for undo — is precisely the shape this register keeps filing
against. It wants its own pass with its own teeth.


## 3. Test-infrastructure decisions

### 3ae. Proved LIVE — what `remaining-correctness.spec.ts` holds (2026-08-08)

The half no unit test can supply for §2i, §2l and §2m: that the user-visible consequence really
follows, in the real WebView, with no test double anywhere in the path. Eleven tests in
`app/e2e/journeys/remaining-correctness.spec.ts` — a JOURNEY because it calls `new_file`, saves to
disk, reopens, and adds sheets.

**It found three things reading could not.** A defect (§2m's F9 half, fixed here), and two facts this
register's own prose had wrong about the product (§2o, §2p). Two of the three surfaced as a test
failing on its own PRECONDITION, which is the shape to watch for: the fixture could not be built the
way the notes described, because the notes described the wrong entry point.

| # | claim, as the user meets it | how it is proved | teeth |
|---|---|---|---|
| 1a | the Delete key over `A1:A3` recalculates `=SUM(A1:A3)` AND a cross-sheet dependent, on the rendered grid | real `selectRange` + `Delete`; `get_viewport_cells` (what the canvas paints) + `get_workbook_state_digest` (no sheet switch, no mirror) + a pixel diff | 60 -> 0 and 40 -> 0, both pre-values asserted first |
| 1b | Replace All recalculates the formulas reading the replaced cells | real Ctrl+H, the real Find and Replace dialog, the real "Replace all matches" button | 21 -> 6 |
| 2 | a two-sheet cycle renders a circular error on BOTH sheets, not a number | built through the real grid in BOTH entry orders, real F9, read on both sheets | a same-sheet control must report it too (else nothing is detecting cycles), the value must not parse as a number, and a LAYERED cross-sheet reference on the same two sheets must stay `14` |
| 3 | iterative calculation still converges | real Formulas > Calculation Options > Enable Iterative Calculation; same-sheet in one pass, cross-sheet over whole-workbook rounds through the real tabs | never reports circular at ANY round; converges to 20 on both sides |
| 4a | undoing a row group removes the outline GUTTER from the canvas | Ctrl+Z; `outlineBarWidth` 0 again AND the left strip byte-identical to the frame before the group existed | the grouped frame must differ first |
| 4b | undoing a hyperlink takes the pointer CURSOR with it | real mouse hover, `getComputedStyle(...).cursor` | the neighbour was never linked |
| 4c | shape create -> undo -> redo on the canvas; deleting takes its object script; undoing the delete brings back the control without the dead binding | real Insert > Shapes gallery, the registered controls provider's own `deleteControl`, real Ctrl+Z / Ctrl+Y, canvas fill fraction in both directions | a real script binding is asserted present before the delete |
| 5 | undoing a named-range change restores the value the formula had | the typed formula's STORED form is read back and must be the NAME (D2); Formulas > "Apply Names..." then stays as an idempotence check; repoint + F9 + Ctrl+Z | 111 -> 222 -> 111 on the STORED value and on G1's pixels; the pixel probe is shown wired by requiring the 222 frame to differ |
| 6 | display flags drive the renderer, a backend-only write drives it too, `new_file` resets it, and it survives save/reload | real View > Headings; dark-ink fraction in the canvas's top-left corner on an empty sheet | the ink must be there first; selection parked outside the probe so its accent chrome cannot contribute |
| 7 | a floating control is clickable with the headings OFF | real Insert > Shapes, real mouse clicks at the painted centre in both heading states | a click well outside the painted box must select NOTHING, in both states |

**The pixel probes are DIFFERENCES, never goldens.** A committed golden is valid only for the exact
ordered cold pass that recorded it; "these pixels changed when they had to" and "these pixels came back
when undo ran" need no baseline and cannot go stale.

**Two spec-side bugs of my own, recorded because they will recur.** (i) sv-SE renders the decimal
separator as a COMMA, so `Number("19,9993896484")` is `NaN` and a convergence assertion fails as
"expected NaN" while the product is perfectly correct — there is now a `numeric()` helper with the
measurement in its doc comment. (ii) The first version of 4c asserted that a script must NOT survive
create -> undo -> redo. It survived, and that is right: nobody deleted it. The guarantee is about the
DELETE path, and running the two halves in the wrong order asserts the wrong thing.

**Verified state at the close of this pass**, every E2E project from a COLD app launch:

| suite | result | vs. §3ad |
|---|---|---|
| `check-types` | clean | — |
| `lint:boundaries` | clean | — |
| `check:script-typings` | **39 interfaces / 736 members** | exact — no new command, no new capability id |
| `check:line-endings` | **0 mixed** | exact |
| `npx vitest run` | **736 files / 106,067 passed, 0 failed** | exact (nothing under `src/` or `extensions/` changed) |
| core `cargo test` | **1,282 passed, 0 failed** | exact (nothing under `core/` touched) |
| `cargo test -p script-engine` | **111 passed, 0 failed** | exact |
| app-lib `cargo test --lib` | **1,084 passed, 0 failed** | 1,079 (+5, all in `bulk_rewrite_recalc_tests.rs`) |
| `test_pivot` | **56 passed, 0 failed** | exact |
| `cargo check --lib --tests` (app) | clean, **0 warnings** | exact |
| e2e `tsc` | clean | — |
| **`--project=visual`** | **18 passed** | 18/18 — exact |
| **`--project=journey`** | **54 passed, 1 skipped** | 43 + 1 skipped, +11 = this spec exactly |
| **`--project=scenario`** | **24 passed** | 24/24 — exact |
| **macro/VBA, the 12 specs** | **56 passed, 1 failed** | exact; the failure is `macro-live-edit` test 6, the proven pre-existing HEAD failure (trailing-whitespace/EOL normalisation between the Monaco buffer and `save_script` — the diff in the failure output is trailing spaces and nothing else). Untouched and unclaimed. |

### 3ad. Verified state at the close of the recalc / undo / display-flags integration (2026-08-08)

One pass over HEAD after §2l, §2m and §2i's residuals were integrated, plus the two extra recalc
siblings and the orphan cleanup this pass found. It supersedes the per-change numbers quoted inside
those sections.

| suite | result | vs. the baseline this pass started from |
|---|---|---|
| `check-types` | clean | — |
| `lint:boundaries` | clean | — |
| `check:script-typings` | 39 interfaces / **736** members | unchanged — no new capability id, no new script row |
| `check:line-endings` | **0 mixed** | unchanged |
| `npx vitest run` | **736 files / 106,067 passed, 0 failed** | 733 / 106,014 (+3 files, +53) |
| core `cargo test` | **1,282 passed, 0 failed** | 1,282 — exact |
| `cargo test -p script-engine` | **111 passed, 0 failed** | 111 — exact |
| app-lib `cargo test --lib` | **1,079 passed, 0 failed** | 1,042 (+37) |
| `test_pivot` | **56 passed, 0 failed** | 56 — exact |
| `cargo check --lib --tests` (app) | clean, **zero warnings** | was 1 warning |
| `cargo check --lib --tests` (core) | clean, 2 warnings | unchanged, both pre-existing in TEST code (`engine::identity_graph::make_id` unused, one `unused_mut` in `pivot-engine`); nothing under `core/` was touched |

**The vitest delta is fully attributed, to the test.** +33 are §2l's three new files
(`headerVisibility` 16, `e2eGridGeometry` 5, `sheetDisplayFlagsBridge` 12). **+16 are not new files
at all and are worth knowing about before anyone calls them drift**: `events-massive.test.ts` is
data-driven over `Object.entries(AppEvents)` at **8 tests per event** (emit/receive, three
multi-subscriber cases, three payload-variant cases, unsubscribe isolation), and `AppEvents` went
71 -> 73 (`SHEET_DISPLAY_FLAGS_CHANGED` from §2l, `CONTROLS_CHANGED` from §2e). Its sibling
`events-parameterized.test.ts` contributes **nothing**, because it slices the first 30 events and
new ones are appended. The remaining +4 are this pass's mutation-domain drift guards in
`crossLayerConstantDrift.test.ts`.

**The app-lib +37 likewise:** §2m's `bulk_rewrite_recalc_tests` 15, §2i's `undo_sheet_domain_tests`
18, the restore registry's `every_domain_but_hidden_has_a_wire_name` 1, and 3 from this pass (the
crate-wide cell-write census, the off-sheet merge recalculation, and the redo twin).

**Not re-run here:** the live E2E projects. Nothing in this pass touches rendering or the frontend
event surface beyond the drift test; the Rust changes are two recalculation phases and two deletions.
The standing live figures are §3aa's (journey 30 + 1 skipped, visual 18/18, scenario 24/24, macro/VBA
55 passed / 1 failed) plus the 8 tests `shapes-hometab.spec.ts` adds to journey, and `macro-live-edit`
test 6 remains the proven pre-existing HEAD failure.

### 3z. Verified state at the close of the integration pass (2026-08-07)

Every number below is from one pass over HEAD after §2d, §2g, §2i and §3c were integrated, so it
supersedes the per-change numbers quoted inside those sections.

| suite | result | vs. the baseline this program quoted |
|---|---|---|
| `check-types` | clean | — |
| `lint:boundaries` | clean | — |
| `check:script-typings` | 39 interfaces / 732 members | unchanged |
| `npx vitest run` | **718 files / 105,789 passed, 0 failed** | 713 / 105,745 (+5 files, +44) |
| core `cargo test` | **1,256 passed, 0 failed** | 1,256 — exact |
| `cargo test -p script-engine` | **111 passed, 0 failed** | 111 — exact |
| app-lib | **1,015 passed, 0 failed** | 1,003 (+12) |
| `test_pivot` | **56 passed, 0 failed** | 56 — exact |
| `cargo check --lib --tests` | clean (1 warning, below) | — |
| E2E `--project=visual` | **18 / 18** | exact |
| E2E `--project=journey` | **16 passed, 1 skipped** | exact |
| E2E `--project=scenario` | **24 / 24** | was 22 passed / 1 failed / 1 not run |
| E2E `--project=functional` (full) | **495 passed / 34 failed / 11 skipped** | ~490 / 33 — see §3a |

**The vitest delta is fully attributed** and is not drift: 42 of the 44 new tests are the five new
files from §2g (`expansion.test.ts`, `InlineEditor.expansion.test.tsx`,
`gridKeyboardNavigationOrder.test.tsx`, `truncatedTextDecoration.test.ts`,
`objectScriptEditorSelectionIdentity.test.tsx`); the other 2 are the
`newFile announces the backend state it replaced` block added to
`core/lib/__tests__/lifecycleEmitters.test.ts` by §2e's document-replacing-routes fix, which landed
after the 713 baseline was taken. The app-lib +12 is §3c's 4 `document_effect` tests plus §2i's net
+8. Two concurrent agents each reported the 718/105,789 figure as unexplained drift; it is neither
unexplained nor drift.

### 3aa. Re-verified live for the Insert > Image E2E (2026-08-07, evening)

Every row is a COLD app (`app.exe`/`cargo.exe` killed, 9222 and 5173 confirmed clear, relaunched via
`tauri dev` on the out-of-Dropbox `CARGO_TARGET_DIR`, CDP waited for), then `E2E_MANUAL=1`. The
`named_ranges` fix in §3ab landed mid-session, so `visual` and the macro suite were re-run
afterwards; every number below is on the SAME post-fix build.

| suite | result | vs. baseline |
|---|---|---|
| `check-types` | clean | — |
| `lint:boundaries` | clean | — |
| app-lib `cargo test --lib` | **1042 passed / 0 failed** | 1040 (+2 — §3ab's regression tests) |
| E2E `--project=journey` | **30 passed / 1 skipped, 0 failed** | 23 + 1 (+7 — `image-ingress`) |
| E2E `--project=visual` | **18 / 18** | exact |
| E2E `--project=scenario` | **24 / 24** | exact |
| E2E macro/VBA, 11 specs | **55 passed / 1 failed** | matches §3y exactly |

**The one macro failure is the SAME pre-existing HEAD failure §3y proved**: `macro-live-edit` test 6,
the whitespace/EOL normalisation between the Monaco buffer and `save_script`. It reproduced in both
of this session's macro runs (pre- and post-fix). The "56/56" figure some briefs still carry is
stale for that test.

Two flakes were seen ONCE each and did not reproduce on a clean re-run — both are the documented
cold-first-test pattern, and both were the first test of the first spec after a cold launch:
`macro-debug-autoend` test 1, and `census-followon` 1a (a dropped keystroke — "250" arrived as "20",
which the spec's own guard catches and names).

### 3ab. A crash found by running the journey suite: `named_ranges.rs` overflowed and ABORTED the app

Found live on 2026-08-07 while running `--project=journey` for the Insert > Image spec. The app died
mid-run — `dirty-flag.spec.ts` BREADTH, then 15 tests "did not run" because CDP was gone:

```
thread 'main' panicked at src\named_ranges.rs:129:23: attempt to multiply with overflow
thread 'main' panicked at library\core\src\panicking.rs:225:5: panic in a function that cannot unwind
error: process didn't exit successfully: app.exe (exit code: 0xc0000409, STATUS_STACK_BUFFER_OVERRUN)
```

`NamedRange::looks_like_cell_reference` accumulated `col_num = col_num * 26 + …` over the WHOLE
letter run and only then compared against Excel's 16384 ceiling. Seven letters already exceeds
`u32::MAX` (26^7 = 8.03e9), so a name like `ABCDEFGHIJKLMNOP1` overflowed first. In a debug build
that is a panic, and it is reached from a `#[tauri::command]` on a thread that cannot unwind — so it
did not reject the name, it **aborted the whole application**, taking the open workbook with it.

Fixed by enforcing the ceiling INSIDE the loop, which also makes overflow unreachable by
construction (`col_num` is at most 16384 entering each multiply, so the largest product is
16384 * 26 + 26 = 426,010). Two regression tests: a long-letter-run case that asserts the name is
REFUSED as a reference and ACCEPTED as a name, and an exactness test pinning `XFD` valid / `XFE`
invalid so the ceiling is a boundary rather than a blanket refusal of long names.

Unrelated to pictures; it is recorded here because it is what the first full journey run actually
found, and because a validator that aborts the process on a long input is worth looking for
elsewhere. app-lib is **1042 passed / 0 failed** (1040 + these 2).

**One outstanding compiler warning, and it is a real orphan:**
`protection.rs:487 sheet_is_protected` — `pub(crate)`, dead, no callers anywhere in the crate
(`#[warn(dead_code)]`). Documented as "the `AppState` form of `formula_is_hidden` for callers
holding no locks", i.e. a lock-amortising helper that was written and never wired. Not a
correctness gap; it should be deleted or wired by whoever owns the protection gates.

**BOTH ORPHANS CLOSED 2026-08-08.** `sheet_is_protected` is gone — no such symbol survives anywhere
in the crate, and `formula_is_hidden`, the function it was a lock-amortising form of, keeps its real
callers. The last remaining warning was its twin one directory over: `TestHarness::get_cell_value`
in `app/src-tauri/tests/common/mod.rs`, `pub`, zero callers, the same `#[warn(dead_code)]`, and the
same story — a harness affordance written and never used, next to a `set_cell` that is used. Deleted.
`cargo check --lib --tests` on the app crate is now warning-FREE, which it has not been for the
duration of this program.

### 3y. Re-verified live after §2j and §2k (2026-08-07, later the same day)

`census-followon.spec.ts` was written and run against the app, which surfaced §2j. Everything
below is a COLD app per run (`app.exe` and `cargo.exe` killed, ports 9222/5173 clear, relaunched
via `tauri dev` on the out-of-Dropbox `CARGO_TARGET_DIR`, CDP waited for), then `E2E_MANUAL=1`.

| suite | result | vs. §3z |
|---|---|---|
| `check-types` | clean | — |
| `lint:boundaries` | clean | — |
| `check:script-typings` | 39 interfaces / 732 members | unchanged |
| `npx vitest run` | **718 files / 105,789 passed, 0 failed** | exact |
| app-lib `cargo test --lib` | **1,016 passed, 0 failed** | 1,015 (+1 — §2j's new test) |
| `cargo check --lib --tests` | clean (same single `test_pivot` warning) | — |
| E2E `--project=visual` | **18 / 18** | exact |
| E2E `--project=journey` | **23 passed, 1 skipped** | 16 + 1 (+7 — `census-followon`) |
| E2E `--project=scenario` | **24 / 24** | exact |
| E2E macro/VBA, 11 specs | **55 passed / 1 failed** | was 56 / 0 — see below |

Core `cargo test` and `script-engine` were not re-run: nothing under `core/` or
`model-engine-lib/` was touched, and `cargo check` over the workspace is clean.

**The one macro failure is PRE-EXISTING on HEAD, proved rather than assumed.**
`macro-live-edit.spec.ts` test 6 ("taking an edit back returns the chip to Live — no phantom
unsaved work") fails at its last assertion, `storedSource === source`. It reproduced three times:
in the ordered 12-spec run, in the ordered 11-spec run, and **cold in isolation** (4 passed /
1 failed, ~9 s). It was then re-run with **both** of this pass's app-affecting changes reverted —
the `sparkline_commands.rs` guard and the `data-inline-editor` attribute — rebuilt, cold: **it
still fails, identically.** So the "56/56" baseline is stale for this one test, and it is not a
regression from §2j.

What the failure says, for whoever picks it up: the stored macro source comes back differing from
the seeded source on **every line by an invisible trailing run**, and the one blank line comes
back non-empty. The visible characters are identical throughout — `expect` reports 17 changed
lines out of a 17-line file while the plain-text rendering of both sides looks the same. That is
a whitespace/line-terminator normalisation happening somewhere between the Monaco buffer and
`save_script`, not a content change. It matters because the persister's "is there unsaved work?"
question is a string comparison against `savedSource`
(`ObjectScriptEditorApp.tsx` `handleChange` -> `persister.note`/`hasUnsavedEdits`), so a buffer
that normalises differently from the store makes an untouched macro look edited — which is
exactly the phantom work the test is named after. Nothing in the editor sets or normalises the
model's EOL. Deliberately NOT fixed here: it is outside this pass, and a guess pushed into the
macro persister would be worse than an accurate record.

#### FIXED 2026-08-08 — the invisible run was a `\r`, and Monaco owns it

The trailing run on every line and the blank line that came back non-empty were the same byte.
The stored copy was a CRLF copy of an LF document, which is why `expect` reported 17 changed
lines out of a 17-line file while both renderings looked identical.

**Monaco does not have a line ending; it has one PER MODEL, and the default is the operating
system's.** `ModelService` computes a new model's `defaultEOL` from the `files.eol` configuration
and falls back to `(isLinux || isMacintosh) ? LF : CRLF`. That default applies only when the text
the model is built from contains no line break at all — which sounds like it could never matter,
and is precisely what matters, because `@monaco-editor/react` creates the model for a `path` the
first time it renders, with whatever `value` the component holds at that moment. For an editor
that loads its document asynchronously that value is the EMPTY STRING. The model is born CRLF;
the real document then arrives through `executeEdits`, which normalises inserted text TO the
model's ending and never changes it. From then on `model.getValue()` — the string every editor
persists and every dirty check compares — is CRLF.

Test 6 is the minimal reproduction: seed an LF macro, type one character, take it back. The
buffer is now textually identical to the store and differs from it in 17 invisible bytes, so the
persister's `buffer !== stored` fires, the CRLF copy goes through `save_script`, and an untouched
macro reports phantom unsaved work. Note which assertion failed and which did not — the chip DID
return to Live, because after the write the buffer and the store agree again. Only the store's
bytes were wrong.

**Where the fix belongs, and why not the other two candidates.**

- NOT `save_script`. The storage contract (`app/src/api/scriptTranspile.ts`) is that EXACTLY ONE
  ARTIFACT exists and the stored text IS the text the author is looking at: it is what the worker
  imports, what `scriptSecurity` hashes for the capability-grant binding, and what a reviewer
  reads in the transparency panel. A store that silently rewrote bytes would make "the code you
  were shown" and "the code that ran" two different strings — the exact divergence that contract
  exists to make impossible by construction.
- NOT the persister. Comparing EOL-insensitively would remove the phantom-dirty symptom and still
  STORE CRLF the first time anybody made a real edit: a platform-dependent artifact inside a
  `.calp`, and a source hash that differs between a Windows-authored and a Linux-authored
  identical script.
- THE EDITOR. Monaco is where the platform dependency ENTERS. Fixing it there leaves exactly one
  normal form for stored text and no second normaliser to keep in step with the first.

`app/extensions/_shared/lib/monacoLineEndings.ts` installs
`monaco.editor.onDidCreateModel(m => m.setEOL(LF))` once per realm — keyed by a WeakSet on the
namespace object, because the stand-alone editor windows are separate JavaScript realms with
their own `monaco` — and brings any already-created model into line. It is called at module scope
next to `loader.config({ monaco })` in all ten surfaces that mount Monaco, so the guarantee is in
place before any editor can mount. Unit tests in
`_shared/lib/__tests__/monacoLineEndings.test.ts`.

**Verified live, in the ordered functional run (2026-08-08):** test 6 passes in 7.8 s, where it
had failed four times running — in the ordered 12-spec run, the ordered 11-spec run, cold in
isolation, and cold with the two app-affecting changes of that pass reverted. All six
`macro-live-edit` tests pass. The stale "56 passed / 1 failed" baseline no longer needs
explaining.

**A note on how the fix itself nearly no-opped.** Three of those ten files are CRLF and seven are
LF. The first patch pass anchored on an LF import line, silently skipped exactly the three CRLF
files and reported success for the other seven. `npm run check:line-endings` does NOT catch that:
skipping an edit leaves the file perfectly consistent. The mixed-endings hazard has a second
face — not "the edit corrupts the file" but "the edit does nothing and says it worked."

### 3a. The full functional E2E suite is not green on HEAD

**490 passed / 33 failed.** Basic editing and scrolling specs are among the failures. Every
"64/64"-style number quoted during this program is a **subset** — the specs relevant to the change
under test — not whole-suite health. Someone should decide whether to drive that to green or
formally designate the maintained subset, because right now the number invites misreading.

**Re-measured 2026-08-07 at the close of the integration pass: 495 passed / 34 failed / 11
skipped**, i.e. materially unchanged. The failures cluster in `worker-extension*` (5),
`scrolling` (4), `dimensions` (4), `editing` (3), `status-bar` (3), `state-consistency` (2),
`paste-special` (2), `protection` (2), `evaluate-formula` (2) and nine singletons.

**Most of that count is CASCADE, and the distinction matters for anyone trying to reduce it.**
Two things were proved rather than assumed during the pass:

- `editing.spec.ts` fails 3/3 in the full ordered run and **passes 12/12 (5 skipped) cold in
  isolation**. Its three failures read `"This column should be wider"` — a `dimensions.spec.ts`
  fixture string — where they expect `"Hello"` / `"123"` / `"EditMe"`. They are not editing
  defects; they are the preceding spec's residue, which is §3b in its purest form.
- The `dimensions` goldens fail on **a chart painting an error** into the shared workbook:
  `Chart data error — Cannot read properties of undefined (reading 'title')`, ~11.5k differing
  pixels. That error frame is itself left by an earlier spec. Worth an owner in its own right,
  because a chart that renders its own exception is a real symptom independent of the golden.

So the headline number overstates the number of distinct defects. Fixing the few genuine roots
(the chart title error, and whatever leaves `dimensions` residue) should collapse a large part of
the tail — which is a better first move than re-recording 34 goldens.

#### ROOT FOUND 2026-08-08 — ONE FLOATING OBJECT WAS EATING THE CLICKS

The two named symptoms are one cause, and it is not a feature defect in any of the nine files.

`animation.spec.ts` is the FOURTH spec file in the ordered run. It creates a chart-param
animation and never unloads the driver. Animation's play pill is a floating grid region shown
whenever `frameCount > 0`, anchored at a fixed sheet position near the origin — it covers
**A1:C2** — and it is HIT-TESTABLE: a click on it toggles playback. So from the fourth spec
onwards `grid.clickCell("A1")` did not select A1. It pressed play. Every later write to A1/B1/C1
landed wherever the selection happened to be, and every later read came back as some earlier
spec's text.

That is what `editing.spec.ts` was reading when it saw `"This column should be wider"`. Not a
fixture leaking through a shared workbook in the abstract — a click that never arrived. It is
also exactly why the file passes 12/12 cold: cold, there is no pill. The proof is a failure
screenshot, `test-results/editing-*/test-failed-1.png`: the pill sits over A1:C2, the Name Box
reads `A2`, and the formula bar holds `dimensions`' string.

The same file leaks two more things: a chart at (320, 40) 400x300 on sheet 0 — present in every
grid golden from that point on — and cell data in column AA, which is outside the box `resetGrid`
clears.

**THE PRODUCT DEFECT UNDERNEATH IT — FIXED.** The chart `animation.spec.ts` persists has no
`xAxis`, no `yAxis`, no `legend` and no `palette`. That is not a badly written fixture; it is the
shape a caller of `save_chart` actually sends, because the command takes an opaque JSON blob and
scripts, the MCP tools, XLSX import and the E2E harness all send exactly it. `ChartSpec` declares
those fields REQUIRED and about forty painter call sites believe it, so `computeLayout` threw
`Cannot read properties of undefined (reading 'title')`, the renderer caught it, and the chart
painted an ERROR CARD into the workbook — "Chart data error" plus the exception text, ~11.5k
differing pixels.

The type was a lie at exactly one place: `chartStore.fromEntry` did
`JSON.parse(entry.specJson) as ChartDefinition`, which is the only place a foreign blob becomes a
typed chart and therefore the only place the type's promises could be made true.
`extensions/Charts/lib/chartSpecNormalize.ts` now completes a persisted record there, and on the
two write paths that can DELETE a required field (`createChart`, `replaceChartSpec` — hand-editing
the Spec tab and removing `yAxis` is a two-keystroke way to break a chart). It fills absent
structure only and never rewrites a value the spec carries, so a complete chart round-trips
unchanged. The load-time `validateChartSpec` warning stays: WRONG structure is still reported,
MISSING structure is now repaired, and the two are announced separately so a repair never hides
inside a schema warning. Unit tests in `chartSpecNormalize.test.ts`, including the exact bare spec
the harness writes and a probe of every unguarded painter read.

Proved live: the error card is gone and a real chart paints in its place.

**AND WHAT THAT SAYS ABOUT `new_file`.** `dimensions.spec.ts` calls `resetToNewWorkbook`, and
BOTH the chart and the pill survived it. The frontend's floating-object layer is not cleared by
the `new_file` command — the product is unaffected only because File > New does a full
`window.location.reload()`. So "move more specs to `journey`" would not have prevented this, and
neither would any amount of cell clearing. See §3b.

#### THREE LEAKS, NOT ONE — the full census (ordered run, 2026-08-08: 492 / 37 / 11)

The pill is the loudest, not the only one. A second spec turned out to be leaking the same
driver, plus a third kind of residue nobody had named:

- **R1 — a LOADED PLAYBACK DRIVER.** Left by `animation.spec.ts` AND by
  `panel-placement.spec.ts` (which configures a clock-cell driver on A1 sweeping 0..4, then
  presses "Stop (reset)" — which restores the model and leaves the driver loaded). Costs:
  the play pill over A1:C2 eating cell clicks, AND a frame indicator in the STATUS BAR
  ("▶ 6 · 7/11"), which is the 54 differing pixels in the `status-bar` goldens, AND — the
  sharpest evidence in the whole census — `state-consistency`'s undo oracle reporting
  `cells 0:0 "<absent>" -> {"v":"4"}`. A1 = 4 is the end of `panel-placement`'s 0..4 sweep. The
  leaked driver was writing into the monkey runner's workbook.
- **R2 — A PERSISTED CHART.** `animation.spec.ts`, `charts.spec.ts` and
  `workflow-dashboard.spec.ts` all call `save_chart` and never delete. One of them is rendered
  (animation dispatches `charts:refresh`), so it is in every grid golden from spec four onward.
- **R3 — AN OPEN SIDE PANEL.** `panel-placement.spec.ts` opens the Animation panel via
  View ▸ Animation Timeline and restores only the PLACEMENT. The panel takes ~320px off
  `[data-grid-area]`, so every later grid golden fails on SIZE before a single pixel is
  compared: *"Expected an image 1232px by 556px, received 912px by 556px."* That is
  `paste-special` and `protection`, four results, none of them about pasting or protection.

The census, with each file's verdict. "Cascade" means the failure is caused by residue from an
earlier spec and the file has no defect of its own.

| file | n | verdict | cause |
|---|---|---|---|
| `dimensions` | 4 | cascade | R1 (clicks land on the pill, so its own fixtures go to the wrong cells) + R2 in the goldens |
| `editing` | 3 | cascade | R1 — passes 12/12 cold |
| `evaluate-formula` | 2 | cascade | R2 — 14 800 differing pixels, the chart |
| `paste-special` | 2 | cascade | R3 — grid area 912px vs 1232px |
| `protection` | 2 | cascade | R3 |
| `scrolling` | 4 | cascade | R3 (all four are grid goldens) |
| `status-bar` | 3 | cascade | R1 — the frame indicator in the status bar |
| `state-consistency` | 2 | cascade | R1 — the driver writes A1 = 4 behind the undo oracle |
| `sheets`, `go-to-special`, `ribbon-tabs`, `zoom-view`, `flagged-defects` | 1 each | to be decided by the post-fix run | — |
| `formula-autocomplete` | 4 | NOT MINE, and not new | the spec's own header documents the race: the inline editor mounts async and the prefix is dropped when the WebView is a background OS window. Its diagnostic prints `{"editing":"=","inputValue":"="}` — the `AV` after the `=` never reached the textarea. The inline editor is another agent's active work area (`Spreadsheet.tsx` was written minutes before this run). |
| `worker-extension`, `-followups`, `-biquery` | 6 | ROOT, own investigation | no screenshots, no A1:C2 clicks, nothing residue-shaped |

**A measurement caveat that has to be stated.** This run was taken against a working tree two
other agents were editing live. The app is served by `vite dev`, so a frontend save by anyone
lands in the running app. Nothing under `app/src` changed during the run itself, so the numbers
are an honest measurement of the tree AS IT STOOD — but they are not a measurement of this
track's changes in isolation, and `formula-autocomplete` is the visible edge of that.

#### AFTER THE FIXES — 510 passed / 23 failed / 11 skipped (cold, ordered, same day)

Fourteen results recovered, and every one of them by removing residue rather than by touching a
golden. **No golden was re-recorded.** What went green, and what each proves:

| file | was | now | what the pass proves |
|---|---|---|---|
| `dimensions` | 4 fail | **4 pass** | R1+R2+R3 gone: the goldens were always right |
| `editing` | 3 fail | **12 pass** | the click theft is over — it now passes IN THE ORDERED RUN, not only cold |
| `status-bar` | 3 fail | **4 pass** | no animation frame indicator in the status bar |
| `state-consistency` | 2 fail | 1 pass, 1 **timeout** | the undo-oracle violation (`A1 -> "4"`) is gone; a timeout with a script dialog on screen remains, a different cause |
| `sheets`, `flagged-defects`, `zoom-view`, `go-to-special`(1 of 1 → still fails) | 1 fail each | **pass** (except go-to-special) | pure cascade |

**What is left, honestly classified.**

- **`worker-extension` / `-followups` / `-biquery` — 6, A GENUINE ROOT, unowned.** Plain
  assertion failures (`expect(received).toBe(true)`), no screenshots, no residue shape. They
  survived every fix in this pass because they have nothing to do with it. **This is the one item
  in §3a that still needs an owner.**
- **`formula-autocomplete` — 4, NOT THIS TRACK.** The spec's own header documents the race: the
  inline editor mounts asynchronously and drops the prefix when the WebView is a background OS
  window. Its diagnostic prints `{"editing":"=","inputValue":"="}` — the `AV` after the `=` never
  reached the textarea. The inline editor is another agent's active work area.
- **`evaluate-formula` (2), `paste-special` (2), `protection` (2), `scrolling` (3),
  `go-to-special` (1), `ribbon-tabs` (1) — 11, A FOURTH RESIDUE CLASS, NOT CLOSED.** These are all
  grid goldens and they now differ by small amounts (1 500 - 7 000 px, down from 14 800 and from
  outright size mismatches). The cause is the suite's own **column-parking convention**: specs put
  their fixtures in far columns to avoid colliding (`status-bar` in R:S, `edge-cases` in AE:AH,
  `evaluate-formula` in AI, `scrolling` out at row 5000). The data is off-screen — but the USED
  RANGE sets the scrollbar thumbs, and the thumbs are *in* every `[data-grid-area]` capture. So
  every spec's parked fixtures shift every later spec's picture.

  **This one is deliberately NOT papered over.** The two honest fixes are (a) those specs reset
  and capture from a known state, which legitimately changes their goldens and needs them
  re-recorded WITH that reason recorded, or (b) grid captures exclude the scrollbars. Both are
  decisions about the baselines, and this pass's rule was that a golden only changes when someone
  can say why. `zz-workbook-residue.spec.ts` REPORTS the accumulated used range at the end of the
  run so whoever takes it has the measurement; it deliberately does not assert on it, because a
  guard that fires on a convention the suite is not going to abandon is noise.

### 3ac. The `window.confirm` defect class — CLOSED 2026-08-08, and proved live

**The defect.** `tauri-plugin-dialog` replaces `window.confirm` with an ASYNC shim, so it returns a
Promise. `if (!window.confirm(msg)) return;` therefore tests `!Promise` — an object, always truthy —
so the negation is always FALSE and the guard NEVER fires. Every such site ran as though the user had
pressed OK. On a CONSENT gate that means **Cancel granted consent**. It shipped six times and was
patched per-site each time.

**Scope was ~17x the reported one.** The brief listed ~10 sites; a lint rule written to enumerate
them found **171 across 63 files**. Two thirds were the BARE form (`confirm(...)`, no `window.`), which
every prior `window.confirm` search missed. One file — `ModelEditor/.../MeasuresSection.tsx` — greps as
BINARY because it embedded a literal NUL byte, so ripgrep skipped it entirely; it is now `\0`
and searchable. That single file is the empirical argument against ever policing this class with a
grep-based drift test.

**And it happened again, to THIS FILE — found and fixed 2026-08-08.** The paragraph above shipped
with a literal NUL byte in it, quoted as the illustration. The consequence is the same one it
describes: `grep`/`rg` reported *"Binary file docs/design/open-decisions-2026-08.md matches"* and
searched no further, so the live decision register — the document every agent is told to read and
update — was invisible to every content search in the repo. Replaced with the two-character escape
`\0`. The lesson generalises past the original: a byte that makes a file unsearchable does not stop
being a hazard because the file is prose rather than code.

**Six gates failed OPEN**, i.e. Cancel authorised the thing being refused:
`scriptSecurity.ts` (running any script; and the persistent per-workbook trust record),
`scriptHost/capabilities.ts` (lapsed-grant re-consent — the documented "re-consent after an edit is
never blind" became exactly blind, with the diff consumed so it never showed again),
`shell/registries/ExtensionManager.ts` (third-party extension TOFU — every unsigned extension on disk
was consented and activated at startup while its dialog was still on screen), and two in
`ScriptNotebook`.

**Enforcement, not discipline.** `confirmAsync` / `alertAsync` / `promptAsync` in
`src/core/lib/dialogs.ts` (re-exported by `@api/dialogs`) all fail CLOSED; the raw globals are banned by
`dialogGuardConfigs` in `app/eslint.boundaries.js` under `npm run lint:boundaries`, using TWO rules
because the hazard has two syntactic shapes (`no-restricted-globals` for the scope-aware bare form,
`no-restricted-properties` for qualified and non-call references such as
`typeof window.confirm === "function"`).

**Verified by probe, not by assertion (2026-08-08).** A throwaway file containing all nine shapes was
added to `src/` and `extensions/`; `lint:boundaries` failed with **exit 1 and 11 errors**, and the
scope-aware negative control (a *parameter* named `alert`) was correctly NOT flagged. Probe deleted;
gate clean again.

**Proved live in `e2e/journeys/consent-refusal.spec.ts` (5 tests, all passing).** Both a refusal AND a
positive control for each gate — without the positive case a refusal test passes just as happily
against a feature that is broken outright.

- Capability consent (in-app React dialog): Deny -> capability absent from the live grant set, deny
  remembered, and the script's own storage write fails; Allow once -> granted and the write succeeds.
- Native `confirmAsync`: Cancel resolves **false**, OK resolves **true**, asserted against the REAL
  Win32 dialog.
- Lapsed-grant re-consent: Cancel -> `"deny"` recorded and the permission dialog never reached;
  OK -> proceeds to the permission dialog and grants.

**Mutation-tested.** Reverting `capabilities.ts` to the pre-fix `window.confirm` shape makes the spec
FAIL, and a direct probe showed the permission dialog being reached with the notice never answered —
the blind re-approval, reproduced. Both mutations were reverted and `lint:boundaries` re-run clean.

**A REGRESSION the class fix left behind, found and fixed 2026-08-08.**
`MacroLibraryDialog` was converted to `confirmAsync`, but `e2e/tests/macro-link-model.spec.ts`
still stubbed `window.confirm` in-page to answer the delete warning. `confirmAsync` calls the dialog
PLUGIN, not the global, so the stub intercepted nothing: the spec's `__confirmMessages` stayed empty
and test 4 hung on its own poll. It fails in ISOLATION, so it was not cascade — meaning the
"macro/VBA 55 passed / 1 failed" baseline quoted with the class fix cannot have been re-measured
after it. The spec now drives the real native dialog over Win32 and asserts the message via UI
Automation, so it still proves what it was written to prove (the warning NAMES the linking button,
and Cancel really cancels) against the real dialog rather than a stub. Its unattended failure also
left an app-modal dialog on screen, which then knocked out `vba-idioms-wave3` — that spec passes
9/9 in isolation. Both specs now DRAIN stale native dialogs before they start.

**Three traps worth keeping, each hit for real while building that spec:**

1. **Vite HMR splits module identity.** After any source edit the app loads
   `capabilities.ts?t=<ts>`, while a test importing the unversioned path gets a **different module
   instance** with its own `deniedThisSession` map and grant sets. Every "not granted" assertion then
   passes vacuously against a phantom. The spec now resolves the URL the app actually loaded (from
   resource timing) and additionally asserts a mounted script has a NON-EMPTY grant set, so a split
   instance fails loudly instead of passing green.
2. **Native dialogs are locale-rendered.** Tauri's IPC surface is non-writable/non-configurable, so
   these dialogs can only be driven from OUTSIDE over Win32 (`scratchpad/answer-native-dialog.ps1`).
   On this sv-SE machine the Cancel button reads **"Avbryt"**, and `rfd` raises a TaskDialog whose
   buttons return control id 0 — so neither a literal "Cancel" match nor the IDOK/IDCANCEL trick
   works. The driver matches an OK-like label and treats the other button as Cancel, and **echoes
   which button it pressed** so the test can assert a button was pressed at all.
3. **The global script-security session approval is app-lifetime state with no revoke.** A gate built
   on it can only be tested once per launch, so the live proof deliberately targets the per-script
   lapse notice instead, which re-arms with a fresh script id.

### 3b. Shared-workbook contamination between specs

The functional specs share one accumulating workbook, and `resetGrid` clears only `A1:Z1000`, so
screenshot goldens encode prior specs' residue and are only valid for the exact ordered cold pass
that recorded them. Specs that wipe and reopen the document now live in a separate `journey`
project for this reason. **The macro debugger specs are additionally not robust to a long-lived
app instance** — 10 failures contaminated versus 60/60 cold.

Deciding to make specs self-contained would cost a pass but would end a recurring class of
false signal.

#### THE HONEST FIX, 2026-08-08 — it is object ownership, not a bigger eraser

§3b was written as a screenshot-golden problem: one accumulating workbook, a `resetGrid` that
clears only `A1:Z1000`, goldens valid only for the exact ordered cold pass that recorded them.
That is true, and it is the smaller half. **The half that cost thirty test results is that a
leaked OBJECT is interactive, and no reset in the suite touches the object layer at all** —
neither `resetGrid`, which clears cells, nor `resetToNewWorkbook`, which calls `new_file` and
leaves the frontend's floating regions exactly where they were (§3a).

Three changes, in descending order of what they bought.

1. **Specs own the objects they create.** `animation.spec.ts` and `panel-placement.spec.ts` unload
   the playback driver; `panel-placement` also closes the panel it opened. Note WHICH call:
   `stop()` restores the model and leaves the driver loaded, so the pill stays on the grid;
   `clearDriver()` is the one that unloads it. That distinction is the whole fix and it is not
   guessable from the panel's UI, where the button is labelled "Stop". `charts.spec.ts`,
   `animation.spec.ts` and `workflow-dashboard.spec.ts` delete the charts they persist through
   `save_chart`. `dimensions.spec.ts` clears its text at the END of the file rather than per test
   — its own goldens legitimately read the grid the previous test left, so an `afterEach` would
   have rewritten baselines that were not the problem.

   **A sub-trap worth its own sentence, because the first attempt at this cleanup fell into it.**
   `delete_chart` removes the chart from the BACKEND. The frontend store keeps its own copy and
   re-reads it only on `charts:refresh`; dispatching `grid:refresh` alone repaints a chart the
   backend has already forgotten. A cleanup that deletes and then repaints the wrong way looks
   exactly like a cleanup that works.

   **AND THE BIGGER TRAP, which cost a whole run and is a rule now.**
   **`window.__calcImport` DOES NOT GIVE YOU THE APP'S MODULE. It gives you a second copy.**
   It is a dev-only `(u) => import(u)`, so for a STATEFUL module the caller gets a fresh instance
   with its own state. The first version of this cleanup imported
   `/extensions/Animation/lib/animationEngine.ts`, called `clearDriver()` on it, reported success
   and changed nothing — the pill was still on screen in the next spec's failure screenshot. A
   probe made it unambiguous: through the bridge the engine reported `frameCount: 0` while the
   pill visibly read "11/11", and `getGridRegions()` returned `[]` while the grid plainly had
   regions on it. **The same trap had already been built into the residue guard**, whose first
   version read the overlay registry through the bridge and would therefore have passed forever,
   no matter what was leaked — a guard that cannot fail.

   The existing precedent is why `readGridGeometry` is fine: it imports
   `headerVisibility.ts` to call `resolveHeaderSizes`, a PURE function, where instance identity
   does not exist. The rule that follows: **the bridge is for pure functions; live state must be
   reached through a handle the owning module published on `window`.** Two now exist alongside
   `__CALCULA_GRID_STATE__` / `__CALCULA_PANEL_REGISTRY__`: `__CALCULA_GRID_OVERLAYS__`
   (shell/bootstrap.ts) and `__CALCULA_ANIMATION__` (the Animation extension's `activate`).

   **`__CALCULA_ANIMATION__` was DELETED 2026-08-09 (D4), and the reason is the better half of the
   rule above.** The rule says live state must be reached through a published handle — true, and it
   stays true. But that handle existed only because the PRODUCT had no way to unload a driver, so
   the test surface was compensating for a missing feature. Once `clearDriver` got real routes
   (a close control on the pill, an Unload button in the panel, the document-boundary events), the
   specs drive those instead and the handle has no remaining caller. **The rule to add: before
   publishing a handle so a test can reach live state, ask whether the test is reaching for
   something a USER cannot reach. If so, the missing route is the bug.**

   **A fourth residue class, found while fixing the third: THE OPEN PANEL SURVIVES.**
   `animation.spec.ts` opens View ▸ Animation Timeline and never closes it, so the panel is open
   for the rest of the run — and its width is persisted, so it is still open after the app is
   killed and relaunched. A cold restart does not clear it. Both specs now call
   `__CALCULA_PANEL_REGISTRY__.closePanel("animation.timeline")`, which is deterministic where a
   toggle click is not: measured, `[data-grid-area]` goes from 912px straight back to 1232px.
2. **`resetGrid` clears the USED RANGE, not a fixed box** — unioned with the old `A1:Z1000` so it
   can only ever clear more than it used to, never less. Golden-neutral (the visible viewport is
   well inside `A1:Z1000`) and it closes the column-AA class: `charts.spec.ts` seeded four values
   in column 26, one past the edge of the box, and they survived every reset in the suite for the
   rest of the run.
3. **A guard that makes a leak visible.** `e2e/tests/zz-workbook-residue.spec.ts` runs last by
   name and asserts that the run left no floating grid region, no persisted chart, and no open
   side panel. It asserts nothing about any feature. A failure names the KIND of object left
   behind and says to fix it where it was created. Before this, a leaked object was invisible to
   every mechanism the suite had and was only ever found by reading a failure screenshot.

   It also PRINTS the accumulated used range without asserting on it. The first version did
   assert ("nothing outside A1:Z1000") and was wrong: it fired on the suite's deliberate
   column-parking convention. A guard that fires on a convention nobody intends to abandon is
   noise, exactly as a guard that cannot fail is theatre — the same test managed to be both
   within an hour, and the difference was measuring it instead of assuming.

**Per-spec isolation was considered and rejected — and the reason is item 1, not cost.**
`new_file` does not clear the floating-object layer, so the expensive option would not have
prevented the failure it would have been adopted to prevent.

### 3c. `AppState.grids` is a bare `Mutex` — FIXED 2026-08-07

`FileState::is_modified` is now **private**, and `document_effect` is its only writing module.
The convention is a compiler guarantee.

**What made it possible.** `AppState.grids` (`Persisted<Vec<Grid>>`) and `AppState.grid`
(`Persisted<Grid>`) — both halves, because `grid` is a MIRROR of `grids[active_sheet]` and gating
one would have produced a half-guarantee that reads like a whole one. The `Store` option won on
consistency: `Persisted<T>` already carries the 46 stores the census onboarded, it is a newtype over
the same `std::sync::Mutex`, and a bespoke grid guard would have been the same abstraction under a
second name — the "two notions of the grid" the brief warns about. `read()` is free; `write(&effect)`
is the only route to `&mut`.

**Scale.** Converting the 351 `.lock()` sites to `read()` produced **391 compile errors across 29
files** — that is the honest count of grid-mutating paths that had no type-level dirty decision.

**One new primitive, and it is the interesting part.** Every gated command has the shape
`lock -> gates (may refuse) -> decide -> mutate`, because the gates READ the grid (sheet protection
resolves lock state through the grid and the style tiers) while `mutates` dirties EAGERLY and must
not run before a refusal. `write(&effect)` cannot express step one. The obvious workaround —
`read()` for the gate, drop, `write(&effect)` — is wrong: Tauri dispatches on a thread pool, so
releasing the lock between gate and mutation opens a TOCTOU window in every gated command. So
`Persisted::lock_pending()` returns a `PendingGuard` (Deref, no DerefMut) that `authorize(&effect)`
converts into a `WriteGuard` without ever releasing the mutex. Nothing is weakened — holding one
without deciding still only lets you read — and the gate-then-decide ORDER, until now a comment
asking authors to remember, is the only order the types accept.

**The flag itself.** `is_modified` is private; `FileState::is_dirty()` reads it, and
`FileState::set_dirty()` demands a `document_effect::DirtyWrite` whose constructor is
module-private (Rust has no `friend`; this is the standard stand-in, and the same move
`TransientScope` makes one level up). It is minted in exactly two places, both in
`document_effect`: `DocumentEffect::mutates` (set) and `mark_saved` (clear — save/open/new).
`persistence::mark_workbook_modified` is deleted and its 8 call sites converted; the ~41 direct
`*is_modified.lock() = true` sites are gone.

**Five `#[tauri::command]`s that mutated the grid and took no `FileState` at all** — found by the
compiler, not by reading: `rename_sheet` (rewrites every cross-sheet formula in the workbook),
`solver_solve`, `solver_revert`, `relocate_cell_references` (cut/paste reference rewriting) and
`update_cell_on_sheets` (group edit across sheets). None of them dirtied the document, and no
frontend path made up for it — so the work was silently discardable at close. Each now takes
`file_state: State<FileState>`; Tauri injects `State<T>` by type, so no `invoke` call changed.

**Performance.** No regression, by construction rather than by measurement: `Persisted<T>` is a
newtype over the same `std::sync::Mutex` (not an `RwLock`, so reader behaviour is unchanged), the
guards are newtypes over `MutexGuard` with trivial `Deref` — no clone, no allocation, no extra
lock — and `write()` ignores the effect entirely. `authorize()` moves a `MutexGuard`. The only added
cost is one `Mutex<bool>` acquisition per `DocumentEffect::mutates`, and effects are constructed
ONE PER COMMAND, never per cell: `update_cells_batch_core` (bulk paste) has exactly one for the whole
batch. The per-keystroke path went the other way — `update_cell_impl` built four and now builds one.

**Pinned by** `is_modified_has_no_writer_outside_document_effect`,
`the_dirty_flag_field_is_private`, `the_capability_token_is_minted_exactly_twice` and
`the_grid_stores_are_persisted_not_bare_mutexes`. Those pin the SHAPE of the remedy — the compiler
is the real enforcement — because a hurried `pub is_modified` would re-open every direct write in
the crate in silence, which is the state the census started from.

**Audited independently 2026-08-07 (integration pass).** The compile guarantee was re-proved from
scratch rather than taken on report: a throwaway `dirty_probe.rs` with five bypass attempts
produced five errors and no successes — `E0596` on `ReadGuard<Vec<Grid>>`, `ReadGuard<Grid>` and
`PendingGuard<Vec<Grid>>` ("`DerefMut` is required to modify through a dereference, but it is not
implemented"), `E0616` on the private `is_modified` field, and `E0603` on the private `DirtyWrite`
constructor. Every one of the 28 surviving `is_modified` mentions outside `document_effect` is a
comment or the field's own two accessors. The probe was deleted.

**Two corrections to the report, found in that audit.**

1. **`update_cell_impl` built FOUR `DocumentEffect::mutates`, not one** — the per-KEYSTROKE path.
   One is the real gate (unconditional, after every refusal, and the token that authorises both
   grid writes); two more are conditional and legitimate (`cp_effect` for computed properties,
   `slicer_cp_effect` for slicer caches, both re-using the same decision inside branches that
   write persisted state). The fourth was a trailing `let _ = ...mutates(&file_state);` under a
   `// Mark workbook as dirty` comment — pre-`DocumentEffect` residue from `mark_workbook_modified`
   that the migration converted mechanically instead of deleting. Redundant the moment the grid
   became `Persisted<T>`. **Removed.** Cost was small (one uncontended `Mutex<bool>` acquisition,
   and the second..fourth never announce because the flag is already set), but this is the typing
   path and the comment actively misled.
2. **The same `let _ = ...mutates(...)` shape appears at 61 sites across 15 files** and most of
   them are NOT residue — they are the honest marker of a command that dirties while the store it
   mutates is still a bare `Mutex`, i.e. `DocumentEffect` used purely for its side effect because
   there is no `write(&effect)` to hand it to. That list is therefore a fairly precise **map of the
   remaining store work**, and it should shrink as those stores are onboarded rather than being
   swept as a cleanup of its own. **It did: 61/15 → 47/13 after §3ai**, and the remainder is not
   `AppState` at all — it is commands that dirty state living in `BiState` / `PivotState` /
   `ScriptState` / `PaneControlState`, which is the next state to give the same treatment.

**Performance, verified by reading rather than asserted.** `Persisted<T>` is `{ inner: Mutex<T> }`.
`read()`, `write(&effect)` and `lock_pending()` are each one `Mutex::lock` plus a newtype wrap;
`write` binds its effect as `_effect` and ignores it; `authorize()` moves the `MutexGuard` and
never releases it. All three guards are newtypes over `MutexGuard` whose `Deref`/`DerefMut` return
a borrow. **There is no clone, no allocation and no second lock anywhere on the write path** — the
per-keystroke regression the typing change could plausibly have introduced does not exist.

**Residual — CLOSED 2026-08-08 by §3ai.** This section's residual read: "the FLAG's sole-writer
guarantee is complete; the STORE coverage is not", and listed thirteen persisted `AppState` fields
still behind bare `Mutex`es. All of them are `Persisted<T>` now, along with five the list did not
name and one (`model_writeback`) nobody had noticed. **Every store the save path serialises is
gated.** Note also that the "46 onboarded stores" figure above could not be reproduced — a field
count on HEAD before §3ai gave **36**, and it is **58** after. See §3ai for the classification
table, the four gate-ordering defects the conversion surfaced, and what remains ungated (nothing
that reaches disk).

---

### 3af. The two "unexplained hard crashes" — NAMED, and the app never crashed

Recorded twice as `app.exe` exit `0xffffffff` with no panic in the tauri log, during visual/journey
specs, most recently at `shapes-hometab` test 6 (save -> new document -> reopen); "passes 8/8 cold in
isolation, so it is load- or sequence-dependent". It is sequence-dependent, and the sequence is a
test killing the application on purpose.

**`app/e2e/journeys/dirty-flag-close.spec.ts:215`** ends its `dirty` case with:

```
Get-Process -Name app -ErrorAction SilentlyContinue | Stop-Process -Force
```

That is documented, intentional cleanup ("the prompt owns the UI thread, so end this app lifetime
here. The runner relaunches for the next case"). Two things make it read as a crash everywhere else:

1. **`Stop-Process -Force` exits the target with exactly `0xffffffff`.** PowerShell's `Stop-Process`
   calls .NET `Process.Kill()`, which is `TerminateProcess(handle, -1)`, and `-1` is `0xFFFFFFFF`.
   MEASURED, not asserted: killing a dedicated dummy process with `Stop-Process -Force` yields
   `-1 / 0xFFFFFFFF`, while `taskkill /F /T /PID` — the idiom `global-setup.ts` and
   `global-teardown.ts` use — yields **`1`**. So the observed code positively identifies
   `Stop-Process` and positively EXCLUDES the setup/teardown kills. It is the only `Stop-Process` in
   the repository.
2. **There was no panic to log, because nothing panicked.** This is the diagnostic value of the
   contrast with §3ab, the one abort that WAS real: that one printed
   `thread 'main' panicked ... attempt to multiply with overflow`, then `panic in a function that
   cannot unwind`, and exited **`0xc0000409`** (STATUS_STACK_BUFFER_OVERRUN, which is what Rust's
   abort looks like on Windows). `0xffffffff` with a silent log is a different signature entirely —
   external termination, not an abort. **The exit code was the evidence the whole time.**

**Why it lands on `shapes-hometab`, and why isolation hides it.** The suite runs `workers: 1` and
`fullyParallel: false` — ONE shared app instance for the entire run. Playwright orders spec files
alphabetically, and `dirty-flag-close.spec.ts` sorts before `shapes-hometab.spec.ts`. So the kill
happens first and `shapes-hometab` is simply the next spec to lean on the app hard. Run
`shapes-hometab` alone and `dirty-flag-close` never runs — hence 8/8 cold.

**The actual defect, for whoever owns suite health.** The cleanup's own comment says "the runner
relaunches for the next case", and in `E2E_MANUAL=1` — which is how §3y and §3z ran every one of
these suites — **nothing relaunches it**. `global-setup.ts` skips launching entirely in manual mode
(it only waits for CDP) and is a GLOBAL setup that runs once, so there is no per-spec relaunch hook
to fire. The kill is also by NAME rather than by the PID this spec is attached to. Three candidate
fixes, none of them mine to make here: relaunch explicitly in that branch, scope the kill to the
instance's own PID, or order the spec last.

**NOT FIXED HERE ON PURPOSE.** `app/e2e/**` belongs to the suite-health owner, and this is a
one-line scoping change in someone else's file. What is closed is the question: the crash is named,
reproduced in mechanism, and it is not a defect in the product.

**What this rules out**, so nobody re-walks it: it is not an abort from a panic in a non-unwinding
context (that is `0xc0000409` and prints two panic lines — §3ab is the worked example); not a
`panic = "abort"` profile (there is none, and both `Cargo.toml`s carry a comment forbidding it
because `catch_unwind` is load-bearing); not an explicit `process::exit`/`abort` in the app (the only
one in the tree is `core/calp/examples/publish_report.rs`, an example binary); and not the
`generate_handler!` stack frame (that overflows deterministically at first invoke, not on the sixth
test of a spec that passes cold). Worth noting for later regardless: the dispatch list is now **753**
commands against the 32MB `/STACK` reserve sized when it was ~660.

### 3ag. Vertical inline-editor expansion — FIXED, and it was destroying data, not just displaying it

The register had this last, as "the only item that changes no answer". That was wrong, and the
element was the reason.

**`<input type="text">` strips CR/LF.** It is the HTML value-sanitization algorithm, not a quirk —
confirmed directly (`"a\nb"` in, `"ab"` out; a `<textarea>` keeps it). So the shipped editor did not
merely render an Alt+Enter entry on one line:

1. Alt+Enter called `onValueChange("a\n")`. React state kept the newline; the DOM input dropped it.
2. The next keystroke went through `handleChange`, which reads `event.target.value` — the SANITIZED
   string — and wrote it back to state.

**The newline was destroyed by the next character typed after it.** Reproduced as
`alt-enter-eats-the-newline`, which fails against the old code with `expected 'ab' to be 'a\nb'`.

**Fixed by swapping to a `<textarea>`**, with the caret/commit semantics treated as the risky half —
in a textarea an Enter that is not `preventDefault`-ed inserts a newline instead of committing, so
getting this wrong breaks every single edit in the product. Pinned individually: Enter commits;
Shift+Enter commits moving up; Alt+Enter inserts at the CARET and does not commit; Escape cancels;
Tab commits and moves with no tab character; and the early-return guard now `preventDefault`s Enter
and Tab, because an Enter arriving while a commit is in flight used to be harmless only thanks to the
sanitization that was the bug.

**Vertical growth** is `computeExpandedEditorHeight`: one line height per hard break, clamped to the
viewport, never smaller than the cell. Line height is derived from the row (`baseHeight - 4`, the
2px borders) rather than a constant, so a 40px row grows by 36 and not by 16 — the same
second-literal trap as the gutters below. Line-height is passed separately from the box height, or
three lines would each try to fill the whole box.

**Why vertical does NOT check what is underneath, while horizontal refuses to cover data.** The
asymmetry is deliberate and documented at the function. Horizontal expansion mirrors how a long value
DISPLAYS when it is not being edited — it spills right only into empty cells. A multi-line value has
no such behaviour: it never spills downward, it is clipped inside its own row. There is nothing for a
vertical rule to mirror, Excel's in-cell editor simply overlays the rows beneath, and the viewport
stays the only bound — which also keeps a second IPC lookup out of the typing path.

`data-inline-editor` is why the element swap moved no selectors: the hook is an attribute, not a tag.
The neighbouring expansion test's `querySelector("input")` was the one thing that had to change.

**Verification.** 59 tests across the three editor files (23 pure geometry + 36 through the real
component), `check-types`, `lint:boundaries` and `check:line-endings` clean.

### 3ah. `0` is a legal gutter width — the `|| 50` project, CLOSED

Item 4 of the previous list, and the blocker under §2l's residue. **90 sites converted across 17
files**, not the ~60 estimated — and only ONE of them was in an extension
(`Print/lib/pageBreakOverlay.ts`), which is why this was smaller than it looked.

**The second literal was also wrong, which is the part worth keeping.** Those fallbacks said
`|| 50` and `|| 24`. The configured defaults are **22 and 20**, and have been since the Excel-tight
header change. So on any config where the field was missing, ninety sites silently agreed on a
geometry the product does not have — the same shape as the `64.29` column-width drift, and exactly
the lesson that a second literal is how it happens. `FALLBACK_ROW_HEADER_WIDTH` /
`FALLBACK_COL_HEADER_HEIGHT` are now READ FROM `DEFAULT_GRID_CONFIG` rather than typed, and a test
asserts they equal it.

**The mechanism.** `||` cannot tell "collapsed" from "missing", so writing a legitimate 0 into the
config produced 50 — a bigger offset than the 22/20 it was meant to remove. Every site now reads
through `rowHeaderGutter()` / `colHeaderGutter()` in `layout/headerVisibility.ts`, which use `??`.
A source-read test asserts the `|| <literal>` idiom is gone from all 17 files (stripping comments
first, since several of them describe the old idiom in prose).

**And that unblocked the real closure, which is one line.** `Spreadsheet.tsx` now applies the header
rule ONCE — `const config = useMemo(() => effectiveGridConfig(rawConfig, displayHeadings), ...)` —
and hands the result to every consumer. Hit-testing, the fill handle, floating controls and the
inline editor all take their config from that line, so the painter and everything answering "what is
at this pixel" agree on the origin. The §2l measurement is flipped in place: the same
`findFloatingRegionAt` call that returned `null` at the control's painted position now returns the
control, painted origin minus hit origin is **0 on both axes** (was 22/20), and the CORNER of a small
control is clickable, not just the middle that used to overlap by luck.

**One caller deliberately keeps the raw config**, and it is pinned by a test with its reason:
the row-header auto-widen effect compares its computed width against the STORED one and dispatches on
a difference. Handed the effective config it would compare 22 against a collapsed 0 on every render
with the headings hidden, dispatch, read 0 again, and never settle — an infinite dispatch loop. What
it writes is the width to use when headings are shown, so the stored value is both what it should
read and what it should update.

`drawGridLines` — the pre-existing sibling named in §2l, which recovered 50 from the collapsed config
it was already handed — falls out fixed with no separate change, since `RenderState.config` is the
effective config and it now reads through the accessor.

The gutter rule is exported through `@api` (`rowHeaderGutter`, `colHeaderGutter`,
`resolveHeaderSizes`, `effectiveGridConfig`) so an extension painting an overlay in grid coordinates
has a sanctioned way to ask, instead of re-deriving the idiom.

**Verification.** `src/core` runs **102 files / 42,084 tests, 0 failed**; `extensions/Print` 894;
30 in `headerVisibility.test.ts` / `e2eGridGeometry.test.ts`. `check-types`, `lint:boundaries`,
`check:line-endings` clean.

---

### 3ai. The persisted `AppState` stores §3c did not reach — CLOSED 2026-08-08

§3c made the FLAG's sole-writer guarantee complete and left the STORE coverage incomplete: 36
fields were `Persisted<T>` and thirteen persisted ones were still bare `Mutex`es. This pass
converted every one of them, plus five the register's list did not name, plus one nobody had noticed.

**The list was wrong in both directions, which is why the brief said to verify it against the
code.** The register named thirteen fields. A field-by-field walk of `assemble_workbook_for_save`
and `build_workbook_for_save` found:

- `all_merged_regions`, `all_user_hidden_rows`, `all_user_hidden_cols`, `default_row_height`,
  `default_column_width` — the register named only their active-sheet halves, but the background
  sheets' storage is exactly as persisted and exactly as ungated.
- `workbook_protection` — persisted as `workbook.workbook_protection`, adjacent to
  `sheet_protection`, and absent from the list.
- `model_writeback` — persisted as `user_files/model_writeback_values.json`. Not in the list, not
  in the "13 stores" framing at all, and the LAST store the save path serialises that was still a
  bare `Mutex`. It is included because the residual sentence worth writing is "every store the save
  path serialises is gated", and one known exception turns that back into a convention.

**The classification, and it is not uniform.** Onboarding a field decides about dirtiness; it does
not mean the field dirties.

| store | classification | why |
|---|---|---|
| `sheet_names` | `mutates` on rename/add/delete/move/copy; `LoadingFromDisk` on load | `Sheet::name` |
| `sheet_ids` | same | `Sheet::id` — the identity every SheetId-keyed section resolves through |
| `active_sheet` | **`Navigation`** for the pure switch; rides the structural `mutates` in add/delete/move/copy/drill-through; `LoadingFromDisk` on load | see below |
| `style_registry` | `mutates` | every cell's style resolves through it at save |
| `column_widths` / `row_heights` | `mutates` | `DimensionData`, active sheet |
| `all_column_widths` / `all_row_heights` | `mutates`; **`Navigation`** for the sheet-switch stash/load | background sheets |
| `default_row_height` / `default_column_width` | `mutates` | `workbook.default_*` |
| `merged_regions` / `all_merged_regions` | `mutates`; `Navigation` for the switch swap | `Sheet::merged_regions` |
| `user_hidden_*` / `all_user_hidden_*` | `mutates`; **`Navigation`** for stash/load | a third hidden-ness AUTHORITY with nowhere else to live |
| `sheet_zooms` | `mutates`, and only when the value actually CHANGES | `Sheet::zoom` |
| `split_configs` | `mutates` | `Sheet::split_row` / `split_col` |
| `auto_filters` | `mutates`, inside the mutating branch only | `user_files/autofilters.json` |
| `sheet_protection` / `workbook_protection` | `mutates`, after every refusal | `workbook.sheet_protections` |
| `model_writeback` | `mutates` on the local-append branch | `user_files/model_writeback_values.json` |
| `scroll_areas` | **NOT onboarded** | see the negative test below |

**`active_sheet` was onboarded in order to say no, and the numbers are the argument.** 358 reads,
**seven** writers. Six of the seven are not navigation at all: add / delete / move / copy sheet and
pivot drill-through all change WHICH SHEETS EXIST, so the index landing somewhere new is a
consequence of a real document change and rides that command's existing `mutates`. Exactly one —
`set_active_sheet` — is the pure switch, and it writes under `CleanReason::Navigation`. Excel
dirties on a sheet switch; Calcula deliberately does not, because merely LOOKING at a workbook must
never raise the close prompt. That divergence used to be a comment on one function. It is now a
decision the type demands at each of the seven, and `rg deliberately_clean` lists them.

**The sheet-switch stash/load is Navigation, and that is a claim about bytes, not a preference.**
`stash_active_user_hidden` / `load_active_user_hidden` move a value between the active mirror and
its per-sheet slot; `build_workbook_for_save` reads whichever of the two is authoritative for the
sheet it is writing. The saved bytes are identical before and after, so these two mint their own
`deliberately_clean(Navigation)` rather than demanding one from the caller. The four STRUCTURAL
helpers next to them (`push` / `remove` / `duplicate` / `rotate_user_hidden_sheet`) take the
caller's effect instead, because which of `mutates` / `LoadingFromDisk` applies is the calling
command's decision — a load rebuilds the whole vector and must stay clean.

**Four defects the conversion surfaced, all of the same shape: a write that happened before the
gate that could still refuse it.**

1. **`bi_insert_query_results` minted a style before the sheet-index check.** The bold header style
   was added to the persisted style registry, then `if request.sheet_index >= grids.len() { return
   Err }` refused the whole insert. A rejected command left an entry in the workbook's style table.
2. **`set_object_json("sheet_layout")`** wrote the per-sheet dimension vectors and then bounds-
   checked them. Now `lock_pending` holds the guard across the check.
3. **`remove_allow_edit_range`** ran `retain` and returned "Range not found" afterwards. The
   removal was a no-op in that case, so nothing was corrupted — but it was correct by accident, and
   the effect could not be minted before a `return`. The decision now precedes the write.
4. **`set_sheet_zoom`'s no-op rule lived in the wrong place.** The command called
   `set_sheet_zoom_inner`, got back a `bool`, and decided whether to call `mutates` from it — two
   statements apart from the write, in a different function. `set_sheet_zoom_inner` now takes the
   `FileState`, returns EARLY when nothing changes, and mints the effect in the same critical
   section as the write it authorises. Behaviour is identical; the rule and the write can no longer
   drift.

**One API split that is worth keeping on its own merits.** `report::with_sheet_merges` handed every
one of its 17 call sites a `&mut HashSet<MergedRegion>` whether it wanted one or not, so "which of
these change the document?" could only be answered by reading all 17. It is now
`with_sheet_merges` (`&HashSet`, free) and `with_sheet_merges_mut(state, effect, ..)`. The read half
also stopped growing the per-sheet vector on a miss — a READ must not perform a write.

**Two recorders stopped minting the flag.** `record_protection_undo` and
`record_workbook_protection_undo` took a `FileState` purely to call `mutates` AFTER the mutation.
Every protection command now mints the effect before its store write, so the recorders take the
effect instead. One user action, one owner of the flag.

**Scale.** ~1,100 `.lock()` sites converted across 21 fields (`active_sheet` 358, `sheet_names`
130, `style_registry` 118, `merged_regions` 69, `sheet_protection` 47, `sheet_ids` 43, the rest
smaller), producing a little over 300 compile errors in five batches. `Persisted<T>` count in
`AppState`: **36 → 58**. The `let _ = ...mutates(...)` map §3c pointed at shrank from **61 sites in
15 files to 47 in 13** — the remainder is genuine: commands that dirty state living somewhere other
than an `AppState` store (BI model, pane controls, scripts).

**The hot path is unchanged, and this was checked rather than assumed.** `sheet_names` and the
width/height stores are read per painted row. `Persisted<T>` is `{ inner: Mutex<T> }`; `read()` is
`inner.lock()` plus a newtype wrap, and `ReadGuard` derefs to `&T`. No clone, no allocation, no
serialised reader, no second lock. The one shape that WOULD have cost something — handing callers
an owned copy to dodge the guard — was not used anywhere. The only structural change on a read path
is `with_sheet_merges` returning `&HashSet` instead of `&mut`, which is strictly less work.

**The bypass probe.** 21 functions, one per newly onboarded store, each trying to reach `&mut T`
without an effect. All 21 failed to compile (`E0596` / `E0594` / `E0599`). Probe deleted; two
permanent tests replace it:

- `every_persisted_appstate_store_is_gated_not_a_bare_mutex` — asserts the declaration of each of
  the 22 stores contains `Persisted<`, and carries the one-line reason each reaches disk, so a
  future demotion has to be argued against rather than merely made to compile.
- `scroll_areas_stays_ungated_until_it_is_actually_persisted` — the negative half. `scroll_areas`
  is the one store that LOOKS like it belongs in the list and does not: nothing in the save path
  reads it, so a dirty flag on it would promise the user that saving keeps something that is gone
  either way. The test fails in BOTH directions — if it becomes `Persisted<T>` while still unsaved,
  and if the save path starts writing it while it is still ungated.

**What is still reachable without a `DocumentEffect`, stated precisely.** 39 `AppState` fields
remain bare `Mutex`es (plus `calc_cancel`, which is an `Arc<AtomicBool>` on purpose — see its own
comment), and **none of them is serialised by the save path**. They fall into four groups: derived
caches rebuilt at load or save (`dependents` / `dependencies` and the four stripe maps,
`spill_ranges` / `spill_hosts`, `id_registry`, `protected_regions`,
`advanced_filter_hidden_rows`, `writeback_index`, `writeback_declarations`,
`model_writeback_declarations`, `gather_cache`); session state that never reaches disk
(`undo_stack`, `animation_snapshots`, `scroll_areas`, `writeback_rebuild_skips`, `pending_recalc`,
`model_writeback_floor`); application preferences rather than document content
(`calculation_mode`, `iteration_enabled`, `max_iterations`, `max_change`, `precision_as_displayed`,
`calculate_before_save`, `auto_recover_*`, `reference_style`, `locale`, `subscriber_identity`); and
one honest mirror — `report_definitions`, whose persisted form is `extension_data["calcula.reports"]`,
already a `Persisted<T>`, written through `sync_reports_to_extension_data`.

**Can the type be closed further? Yes, and here is the one place it should be.**
`report_definitions` is the last store whose contents reach the .cala while the store itself is
ungated. The write that matters IS gated (the `extension_data` write), so nothing can be lost by
forgetting the flag — but nothing forces `sync_reports_to_extension_data` to be called either, and a
report mutation that skips it is silently dropped at save. That is a different defect from the one
`DocumentEffect` exists to prevent, and it wants a different fix (make the mirror unreachable except
through the sync), so it is recorded here rather than folded in.

Beyond that, the remaining tightening is not about `AppState` at all. `DocumentEffect` gates
*stores*; a Tauri command is a free function and Rust cannot force it to accept a parameter, which
is the argument §3c already made for putting the gate on the state. The stores are now covered. What
is left ungated is a command that mutates state living somewhere else — `BiState`, `PivotState`,
`ScriptState`, `PaneControlState` — and closing THAT means giving those states the same treatment,
not tightening this one further. The 47 remaining `let _ = ...mutates(...)` sites are a precise map
of it, exactly as the 61 were a map of this item.

**Verification.** core `cargo test` **1,282** (baseline 1,282) · app-lib **1,086** (baseline 1,084;
+2 = the two new guard tests) · `test_pivot` **56** (baseline 56) · `cargo check --lib --tests`
**0 warnings** · `check:line-endings` clean. No frontend file was touched.

### 3aj. The orphan / silent-failure sweep — CLOSED 2026-08-08

The register's last unowned leftover (`saveLayout`) plus everything the same-shaped sweep turned up.
The shape being hunted: **a failure that a layer decides not to mention**, where the layer above then
reports success. Three found, all fixed; one of them was found by a test that first passed for the
wrong reason, which is recorded here because the trap generalises.

**1. `saveLayout` swallowed a `localStorage` failure — and the dialog then discarded the user's
work.** §2a filed this as the cosmetic half ("closes the dialog looking successful"). It is worse
than that in one specific way: `handleSave` closed the dialog AND dispatched `homeTab:layoutChanged`
regardless, so the ribbon repainted from the in-memory layout and the customization *looked* applied,
survived until the next reload, and was gone at the following launch with nothing said at any point.

Fixed on both sides of the boundary, and deliberately NOT by giving the config module a voice — §2a
guessed the fix would mean "giving a pure config module a way to talk to the user", and that guess
was the reason it stayed open. It does not: `saveLayout` returns `boolean` and stays pure, and the
DIALOG — which already owns a user-facing surface — is what speaks, via `alertAsync` from
`@api/dialogs`. **The dialog now stays OPEN on failure**, which is the part that matters: closing it
destroys the only copy of the arrangement.

`loadLayout`'s version re-stamp is the one caller that ignores the return value, and it says why in
place: that write is not user-initiated, and losing it costs only a repeat of an idempotent
migration.

**2. A trap that cost a test run, and that `check:line-endings` has no equivalent for.** The first
version of the regression test stubbed the failure with `localStorage.setItem = () => { throw }`.
jsdom serves `localStorage` through a proxy that drops own-property assignment, so the real
implementation kept running, the write landed, and the test reported the pre-fix behaviour as a
pass — a green test proving nothing. The stub must go on **`Storage.prototype`**
(`vi.spyOn(Storage.prototype, "setItem")`). This is the same family as §3b's `__calcImport` finding:
**a test double that silently fails to attach passes forever**, and the only defence is a test that
would fail without the double.

**3. `Distribution`'s `deactivate` swallowed every cleanup throw** (`try { fn(); } catch {}`). The
loop must continue — one bad teardown must not strand the rest — but it now reports. Those cleanups
unmount advisory validator workers and drop listeners; a swallowed throw there is a leak that
survives `deactivate` with nothing to show for it.

**Swept and deliberately left, with the reason.** `installQueue = next.catch(() => undefined)`
(6 sites) is queue-chaining, not error-swallowing: the failure is delivered to the awaited `next`
and this only keeps the chain alive. `cancelUndoTransaction().catch(() => {})` (4 sites) is cleanup
ON an error path, where a second failure has nowhere useful to go. Neither is the shape being hunted.

### 3ak. `dirty-flag-close.spec.ts` — the scoping fix §3af left to the suite owner, and a vacuous pass found while making it

§3af named the `0xffffffff` "crash" and left the one-line fix to whoever owns the suite. Done here,
and reading the file for it turned up a second, quieter problem in the same spec.

**The kill is now scoped to the prompting PID.** It was
`Get-Process -Name app | Stop-Process -Force` — every `app.exe` on the machine: the shared E2E
instance, a second instance, a developer's own Calcula with unsaved work. It is now
`Stop-Process -Id <promptSeen.pid>`, which cannot reach a bystander. The stale comment claiming "the
runner relaunches for the next case" is replaced with what is actually true — nothing relaunches
under `E2E_MANUAL=1`, which is how these suites have actually been run.

**The quieter problem: half this spec could pass vacuously.** `WINDOW_LISTER` pointed at an absolute
path inside one agent session's scratchpad
(`.../Temp/claude/<session-uuid>/scratchpad/list-app-windows.ps1`). That directory is session-scoped
and machine-local, so on any other checkout the enumerator is simply absent — and `listAppWindows`
caught the failure and returned `[]`. An empty window list is **exactly what the CLEAN case
asserts** (`expect(promptSeen).toBeNull()`), so that half would have reported "no prompt appeared"
when in truth nothing had looked.

Fixed by vendoring the script to `app/e2e/list-app-windows.ps1` (beside `launch-with-cdp.ps1`, its
only sibling of the same kind) and by making `listAppWindows` **throw** rather than return `[]`:
"no windows" and "could not look" must not share a return value in a spec that passes on the former.

### 3al. Contract verification at the close of the correctness program (2026-08-08)

Five load-bearing guarantees, each checked by making it FAIL first where that was possible, because
a gate is only worth what its last failing run proves.

**(a) The recalculation census still has teeth.** `sort_range`'s
`recalc_after_active_sheet_bulk_rewrite` call was disabled; the census failed naming
`commands/data.rs::sort_range` and nothing else, and passed again on restore. It enumerates the crate
rather than a list, so it fails for the command nobody thought of — that is the property being
protected, and it is intact.

**(b) The newly onboarded `AppState` stores cannot be written without a `DocumentEffect`.** A probe
module attempted nine bypasses — `sheet_names`, `sheet_ids`, `active_sheet`, `column_widths`,
`merged_regions`, `sheet_zooms`, `workbook_protection`, `model_writeback`, and `replace` on
`default_row_height`. All nine failed to compile with `argument #1 of type &DocumentEffect is
missing`; the probe was deleted. `replace` is gated on the same terms as `write`, which is the one
that could plausibly have been left open.

**(c) The inline editor still commits.** This was the highest-blast-radius change in the batch — it
touches every cell edit in the product. `<textarea>` shipped, and the semantics are pinned
individually rather than as a bundle: Enter commits without inserting a newline, Shift+Enter commits
moving up, Alt+Enter inserts at the caret without committing, Escape cancels without touching the
entry, Tab commits with no tab character, and a disabled editor swallows Enter. 47 tests across the
three `InlineEditor` files pass. `data-inline-editor` is an attribute, not a tag, so no E2E selector
moved.

**(d) No golden was re-recorded.** All 72 files under `app/e2e/**/__screenshots__/` predate the
batch (newest 2026-08-07 16:49; the batch ran 2026-08-08). The eleven scrollbar-thumb diffs were
left failing rather than papered over — they are an owner decision, written up below. Nothing under
`app/e2e/results/` is a golden; it is run output.

**(e) `window.confirm` / `alert` / `prompt` are still banned and the gate still fires.** A probe
exercising both syntactic shapes drew **8 errors**: three `no-restricted-globals` (bare
`confirm`/`alert`/`prompt`) and five `no-restricted-properties` (`window.`/`globalThis.`/`self.`
qualified, **including the non-call `typeof window.prompt === "function"` reference** that once
smuggled the global past review as a feature probe). Probe deleted.

---

### 3am. Running the functional suite found the one thing contract (c) asserted instead of checking

**CLOSED 2026-08-08, from a cold app.** §3al(c) closed the inline-editor swap with: "`data-inline-editor`
is an attribute, not a tag, so no E2E selector moved." The first half is true and the conclusion is
false, and the functional suite says so in four tests.

**`formula-autocomplete` was never an app race.** Its four failures were read for weeks as the inline
editor dropping keystrokes during the mount hand-off — the spec's own header says so, and the
register's suggested-order entry repeated it while correctly warning that the editor had become a
`<textarea>` *after* that measurement. It is simpler than that. `typeFormula` sent the opening
character and then waited for

    document.activeElement?.tagName === "INPUT"

before sending the rest. A `<textarea>` never satisfies that condition, so the wait burned its full
5s timeout, threw, and **the remaining characters were never sent**. Every failure printed the proof
in its own diagnostic — `{"editing":"=","active":"TEXTAREA","inputValue":"="}` — where
`active: TEXTAREA` is not evidence of a race but of the wait being unsatisfiable. Fixed by waiting on
the attribute (`data-inline-editor`) rather than the tag; it was the ONLY tag-based assumption left
in `app/e2e/**`, and every product-side `tagName === "INPUT"` guard already had a `TEXTAREA` arm
beside it, which is why nothing in the app misbehaved.

**Why this is worth a section.** The claim "no E2E selector moved" was reached by reasoning about the
selector strategy, not by grepping for the tag — one `rg '"INPUT"' e2e/` would have found it. That
is the register's own recorded pattern, and this is its **fifth** instance: *a verdict reached by
reasoning about a symptom is a hypothesis.* It also lands on the two items the previous pass listed
as open, and settles both: the `formula-autocomplete` four had a root, and it was not the app.

**The other eleven failures are one class, and it is already D5.** (D5 is now CLOSED — see §4. The
scrollbars are out of frame and the marching ants are parked; the re-record it triggers is 40
goldens, not eleven, because cropping changes the image size.) Every remaining failure in the run
is a `toHaveScreenshot` comparison (each has a `-diff.png`; the four autocomplete failures have
none). They are residue plus chrome: leftovers from sibling specs sitting in the captured viewport
(the `grid` fixture does NO per-test cleanup — `resetGrid` is opt-in, and `edge-cases` parks at
AE:AH exactly where `evaluate-formula` shoots), the scrollbar thumbs D5 is about, and in
`paste-special` the marching-ants copy border that `screenshotGates.ts` already names as the only
non-deterministic thing in either suite. The gates are deliberately tight (200 px on a 685k-px
capture), so any of these fails honestly. **Eleven is also exactly D5's count.** Nothing here is a
product defect and nothing was re-recorded; D5 remains the decision that closes them.

---

### 3an. `worker-extension*` — DIAGNOSED AND CLOSED, and the lead in the register was wrong

Six failures across three specs, carried as "a genuine root, still unowned and NOT diagnosed". Run
against a live app, they are **one root, in the test fixtures, and it is not the `__calcImport`
second-copy theory** the previous entry proposed.

**What the app actually said.** Reproducing the spec's own evaluate block and dumping the WHOLE audit
ring — rather than the single filtered entry the spec looks up — gave:

    sameModuleAcrossTwoImports: true      <- no duplicate module; the lead's premise is absent
    mountOk: true,  mountError: ""
    commandRegistered: false
    auditEntries: [ { method: "ext.contribute.command", ok: false, error: "PermissionDenied" } ]

The proxy command was never created, so `CommandRegistry.execute` did nothing, so the handler never
ran, so `net.fetch` was never attempted, so there was no `cap.fetch` entry — which is the assertion
that failed (`fetchAudited`). Every downstream symptom follows from the first line.

**The cause is the CONTRIBUTION CEILING** (`admitContribution` in `extensionWorkerHost.ts`): an
extension may only register a command whose id is listed under `contributes.commands` in its
AUTHORITATIVE manifest, fail-closed, so the pre-install disclosure cannot be widened by the code
afterwards. The three fixtures predate that ceiling and declare commands only in code. The product
is behaving exactly as the transparency model requires; the fixtures were never updated. Fixed by
declaring `contributes` in all six fixtures — including the SIDECAR manifest for the signed-manifest
test, since that is the manifest the ceiling is read from, which is the point of signing it.

Confirmed by rebuilding the spec's exact fixture with `contributes` added and nothing else changed:
all six assertions pass, and the ring reads `ext.contribute.command` (ok) then `cap.fetch`
(PermissionDenied) — the sequence the spec was written to observe.

**Why the old lead was wrong, and it is the same lesson again.** `__calcImport` was blamed because
§3b had blamed it before for something else. Two imports of the same URL return the SAME module here;
the theory was never checked against the running app. **This is the sixth verdict in this register
reached by reasoning about a symptom, and the sixth to be wrong.** The diagnostic that settled it in
one run was: stop filtering, print everything the ring holds.

### 3ao. What the live re-run found that no static check could — three regressions in this batch's own work

The functional suite was run in full from a cold app (**512 passed / 21 failed / 11 skipped**, from
495/34/11), every remaining failure was classified root-vs-cascade by re-running it cold, the roots
were fixed, and the whole suite was then re-run cold to confirm:

> **526 passed / 13 failed / 11 skipped (41.4 min)** — from the 495 / 34 / 11 baseline.
> **+31 passed, -21 failed.** (The pass count includes 6 new tests: `inline-editor-live.spec.ts`.)

That exercise found three defects in work this program had already reported as done.

**1. `formula-autocomplete` was never an app race — and contract (c) asserted the thing that was
false.** §3al(c) closed the `<textarea>` swap with "`data-inline-editor` is an attribute, not a tag,
so no E2E selector moved." True of selectors, false of the suite: `typeFormula` waited for
`document.activeElement?.tagName === "INPUT"`, which a `<textarea>` can never satisfy, so the wait
burned its 5s timeout, threw, and **the rest of the text was never sent**. The spec printed
`{"editing":"=","active":"TEXTAREA","inputValue":"="}` on every failure — `active: TEXTAREA` is the
answer, not a symptom of a race. One `rg '"INPUT"' e2e/` would have found it; it was the only
tag-based assumption left, and every product-side `tagName === "INPUT"` guard already had a
`TEXTAREA` arm beside it. Fixed by waiting on the attribute. Four failures, gone.

**2. The `dirty-flag-close` vendoring fix broke the ENTIRE journey project, and it was never
re-run.** §3ak's fix wrote `path.join(__dirname, "..", "list-app-windows.ps1")`. This suite is ESM,
so `__dirname` throws at MODULE LOAD, which Playwright reports as a collection error for the whole
PROJECT: **`--project=journey` ran ZERO tests.** `global-setup.ts` and `global-teardown.ts` in the
same folder already use `path.dirname(fileURLToPath(import.meta.url))`, so the convention existed and
was diverged from. The irony is exact: §3ak was written about a spec that could pass without looking
at anything, and shipped a change that made an entire project look at nothing. **A suite that
collects nothing does not resemble a suite that fails** — the run ends in seconds with no failure
list. Fixed; journey is back to **54 passed / 1 skipped**.

**3. A visual golden IS stale from the `<textarea>` swap, so `visual` is 17/1, not 18/18.**
`core-visual.spec.ts` "editing mode - inline editor visible" **fails cold in isolation** (so: root,
not cascade). Two differences from the golden: the capture carries an ambient `A1:H5` range selection
(the documented `clickCell` drift — the test clicks, then screenshots), and the editor's text is no
longer clipped the way an `<input>` scrolled it. Contract (d) reported "no golden was re-recorded" as
a virtue, and it was — but nobody re-ran `visual` after the swap, so the one golden the swap actually
moved was recorded as a clean baseline. **Not re-recorded here either**: it needs a stated reason and
the `clickCell` drift should be fixed first (use `navigateTo` before the capture), or the re-record
just freezes the drift into the baseline.

**Classification of the 21, since a raw count invites the same misreading the register warned about:**

| failures | verdict | evidence |
|---|---|---|
| 4 `formula-autocomplete` | ROOT — **fixed** | tag-based wait, above; 4/4 green cold after |
| 6 `worker-extension*` | ROOT — **fixed** | contribution ceiling, §3an; 6/6 green cold after |
| 2 `evaluate-formula`, 1 `go-to-special` | **CASCADE** | pass cold in isolation; their diffs carry sibling residue (`edge-cases` parks at AE:AH, exactly where `evaluate-formula` shoots) |
| 2 `paste-special` | **CLOSED 2026-08-09 by D5** | was: fails cold ALONE, the diff being the marching-ants copy border (named by `screenshotGates.ts` as the only non-deterministic thing in either suite) plus the scrollbar thumb. Both are gone — the border is parked by reduced motion, the scrollbars are out of frame. Two cold runs now produce a byte-identical capture. It still fails until the golden is re-recorded, which is now a mechanical crop, not a chase |
| 2 `state-consistency` | **FLAKY, not a regression** | passed in run 1 (1.1 min), failed in run 2 on the SAME build. The invariant is named `page-crashed`, but the app did **not** crash: it was still running, still on CDP and still serving commands after the run, with **zero panics** in the whole log. It is Playwright's "Target page, context or browser has been closed" against a random 64-step monkey sequence (seed 1786220272147) |
| 2 `protection`, 1 `ribbon-tabs`, 3 `scrolling` | **NOT individually isolated** | the per-spec cold loop hung on `protection` and was stopped to protect the remaining required runs. `scrolling`'s diff shows a whole selection block differing — the `clickCell` drift signature — but that is an inference, not a measurement, and is recorded as such |

The last row is deliberate. Everything else here was measured; that one was not, and the register has
now been wrong six times by reasoning where it could have run something.

---

### 3ap. The D1–D7 integration pass — contract verification, and the two things it found (2026-08-09)

Seven decisions landed from separate sessions. This pass integrated them, re-ran every unit suite,
and made each contract FAIL before trusting it. Both findings came from sabotage, not from reading.

**Contract (a) — ONE cascade, and the census's teeth.** Verified by deleting a real recalc call, not
a synthetic one:

- deleting the `recalc_after_active_sheet_bulk_rewrite` call from
  `commands/structure.rs::relocate_cell_references` made the census fail naming exactly
  `commands/structure.rs::relocate_cell_references`. Restored; green.
- **deleting the same call from `tables.rs::set_totals_row_function` changed NOTHING — the census
  passed.** That is the finding. The census enumerates functions whose body textually contains
  `.set_cell(` / `.clear_cell(`, and `set_totals_row_function` contains neither: it writes through
  `write_table_formula_cell`, which is EXEMPT *precisely because* "`set_totals_row_function` and
  `toggle_totals_row` seed the cascade over every cell they hand it". The exemption's reason was a
  claim about another function that nothing verified, so the two halves could be removed one at a
  time and no test would ever fail. An exemption whose reason names a caller must check that caller.

  **Closed.** `DELEGATING_HELPERS` in `bulk_rewrite_recalc_tests.rs` lists the nine helpers whose
  recorded reason is "my CALLER recalculates"; calling one now counts as writing a cell, so the
  caller must itself recalculate or earn its own exemption. Re-running the sabotage now fails naming
  `tables.rs::set_totals_row_function`. Three new assertions in
  `the_census_detector_actually_fires_on_a_cell_writer_that_does_not_recalculate` pin the helper
  path, including that a helper's own definition is still judged by its body.

  The hardening exposed six previously-unenumerated functions. Two were second-level helpers with
  clean stories (`apply_override_value_to_grid` — all three override commands run
  `recalculate_sheet_values`; `shift_per_sheet_cell_stores`). **Four were the structural edits, and
  they were a real residual: §2s / D8.** That residual is now CLOSED — the four recalculate, the four
  entries are gone, and `EXEMPT` is **50 entries**, every one with a written reason.

**Contract (b) — F9 vs Shift+F9, and the save path.** `calculate_now` → `CalcScope::Workbook`,
`calculate_sheet` → `CalcScope::ActiveSheet`, both through the one `run_calculation_pass`.
`persistence::save_file` calls `calculate_now` — workbook-wide, chosen deliberately (Excel
recalculates the workbook before saving) and pinned by
`calculate_before_save_recalculates_the_workbook`, with D1's measurement behind it: fixture A shows
workbook scope is ~30% FASTER than the pass it replaced on identical work, because the old F9 ran two
walks and the new one runs one.

**Contract (c) — a stored name has an edge.** Verified with teeth: stubbing the body of
`recalc_after_name_change` fails **five** behavioural tests, including
`repointing_a_name_recalculates_every_formula_that_reads_it` and
`a_repoint_cascades_into_the_readers_dependents`. Restored; all 21 D2 tests green.

**Contract (d) — error literals round-trip, `as_literal`/`from_literal` the single authority.**
D7 reported "no `#{Debug}` arm remains anywhere". **Three remained**, and pointing the grid at
`as_literal` had turned two of them from harmless into user-visible, because they had been agreeing
with the *wrong* spelling. Each was made to fail first, then fixed:

| site | was | consequence |
|---|---|---|
| `Grid::get_cell_display_value` (core/engine) — **Find/Replace** | `#DIV0` | searching for the `#DIV/0!` the grid paints returned NOTHING; the only string that matched was one no surface displays |
| `format_value_for_ai` (calcula-format) — **AI context serializer** | `#DIV0` | a model was told a fact about the workbook that is not true, and could not correlate it with the literal the user quotes |
| `saved_value_display` (calp) — **published HTML report** | `##DIV/0!` | `SavedCellValue::Error` already holds the canonical literal *including* the `#`; the export prefixed another. Every error cell in every published report had a doubled hash — pre-existing, on the one surface a subscriber sees and cannot correct |

Three new tests, one per site, each covering all nine variants; `Limit`/`Blocked`/`Conflict`/`NA`
keep their explicit arms and the round-trip test still asserts
`from_literal(as_literal(v)) == v` for all nine. The `as_literal` doc comment claimed the last
fallback was gone; it now names all three and what each broke.

**Contracts (e), (f), (g).** Inline editor: 75 tests green across 5 files (the 47 pre-existing plus
`editOpenBuffer` 15 and `editorTypingRace` 13) — Enter commits, Escape cancels, no keystroke dropped
while the editor opens. Animation: 12 files / 58 tests; frames still go through
`DocumentEffect::transient` under a filed `anim_snapshot` token, and the pill's unload asserts its
own `anim_restore` does not dirty the document. `DocumentEffect`: `cargo check --lib --tests` is 0
warnings and `is_modified_has_no_writer_outside_document_effect` still holds. Capability vocabulary
unchanged at **16** ids, pinned by `capabilityIds.test.ts`.

**Orphan / silent-failure sweep.** Every export added by the batch has a real non-test consumer
(`editOpenBuffer` ×6, `pillGeometry` ×4, `name_resolution` ×7 — `needs_name_resolution` is consumed
by `eval_ast` inside its own module, which is its documented role as the allocation-free gate). No
empty catch blocks, no `any`, no TODO/FIXME in the new files.

**One flake, characterised not waived.** `bi::model_editor::tests::an_abandoned_script_batch_is_reclaimed_and_rolled_back`
failed once in a parallel app-lib run while three other builds were running, and passed 3/3 in
isolation and in both subsequent full parallel runs. It is a wall-clock reclaim test, untouched by
this batch. Recorded so a recurrence is recognised rather than re-diagnosed.


### 3aq. The golden re-record list handed to the next phase (2026-08-09)

**No golden was re-recorded in the integration pass.** This is the expected-diff list; the next phase
triages against it, and **a golden diff that is NOT on this list is a possible regression, not a
re-record.**

**A. The 40 `takeGridScreenshot` goldens — D5, framing.** `takeGridScreenshot` now frames
`[data-grid-canvas-layer]` instead of `[data-grid-area]`, which excludes the two scrollbars and the
corner box. The image SIZE changes (1232x556 → 1218x542, measured live), so **every** capture through
that helper moves — not only the eleven that were failing on scrollbar-thumb position. Counts
re-derived independently in this pass from the specs themselves and they agree with D5:

| spec | n | goldens |
|---|---|---|
| `tests/scrolling.spec.ts` | 4 | `scroll-before`, `scroll-after-wheel-down`, `scroll-distant-cell-z100`, `scroll-row-5000` |
| `tests/dimensions.spec.ts` | 6 | `dimensions-before-width`, `dimensions-after-set-col-width`, `dimensions-before-row-height`, `dimensions-after-row-height`, `dimensions-after-col-width`, `dimensions-mixed-widths` |
| `tests/grid-rendering.spec.ts` | 5 | `empty-grid-default`, `cells-with-text`, `formatted-cells-bold-italic`, `before-clear`, `after-clear-b1` |
| `tests/paste-special.spec.ts` | 2 | `paste-special-values-result`, `paste-special-formatting-result` |
| `tests/protection.spec.ts` | 2 | `protection-sheet-protected`, `protection-allow-edit-cleared` |
| `tests/go-to-special.spec.ts` | 1 | `go-to-special-blanks` |
| `tests/evaluate-formula.spec.ts` | 2 | `evaluate-formula-init`, `evaluate-formula-constant` |
| `visual/core-visual.spec.ts` | 8 | `core-empty-canvas`, `core-data-entry`, `core-selection-single`, `core-selection-range`, `core-editing-mode`, `fmt-bold-italic-underline`, `fmt-number-formats`, `fmt-alignment` |
| `visual/workflow-visual.spec.ts` | 10 | `workflow-table-headers-bold`, `workflow-table-complete`, `workflow-formula-chain-initial`, `workflow-formula-chain-updated`, `workflow-undo-step1`, `workflow-undo-step2`, `workflow-undo-step3-restored`, `workflow-undo-step4-redone`, `workflow-copy-paste-result`, `workflow-keyboard-entry` |

**Unaffected, and worth stating so an unexpected diff there is read correctly:** every
`takeGridRegionScreenshot` golden (`tables-*`, `notes-*`, `comments-*`, `go-to-special-formulas-sheet`
— that helper already anchored on the canvas) and every whole-window checkpoint (`core-empty-grid`,
`empty-grid-full-window`, the menu / ribbon / status-bar / scenario captures).

**B. Marching ants — same 40, second cause, and it is now FIXED not masked.** The marquee's dash
phase advances on wall-clock, so a re-record would only have picked a different phase. `GridCanvas`
now honours `document.documentElement.dataset.reducedMotion` (the app's own accessibility switch,
which `skinLoader` had always stamped and *nothing had ever read*), and `waitForGridStable` turns it
on. Two independent cold runs produced a byte-identical `grid-paste-special-values-result`.

**C. `__screenshots__/tables.spec.ts/grid-tables-totals-row-sum.png` — D3, already re-recorded, with
cause.** The old baseline was recorded while the totals row rendered BLANK; it encoded the defect that
the totals cell held an uncomputable AST. Keeping it would have made the suite assert that the totals
row shows nothing.

**D. `editing mode - inline editor visible` — stale from BEFORE this batch.** The `<input>`→`<textarea>`
swap moved it and it was never re-recorded. D6 changed no appearance; this is the one known-stale
baseline the batch inherited rather than caused.

**E. Residue only, no direct mover: D7.** No spec that calls `takeGridScreenshot` writes an
error-producing formula, so the literal respelling moves no golden on its own. The one exposure is
residue — `edge-cases` leaves two circular cells at AH1:AH2 inside the viewport `evaluate-formula`
captures, which now read `#CIRCULAR!` — and those two goldens are already in list A.

**Expected to move NOTHING: the integration pass's own changes.** Find/Replace matching, the AI
context serializer, the `.calp` HTML export and the census hardening are all non-rendering. If any
golden outside A–D moves, that is a finding.

### 3ar. The re-record pass — 40 goldens recorded, 3 refused, and what the refusals were (2026-08-09)

**§3aq's prediction held exactly: 40 `takeGridScreenshot` goldens moved, and nothing else did.**
Recorded in two cold runs, each reproducing the conditions its own baselines were recorded under —
visual is a cold app with `--project=visual` first; functional is a cold app with the FULL ordered
`--project=functional`, because those goldens encode the residue of the specs that precede them and a
partial run would have baked in different content.

| set | n | recorded in | verified by |
|---|---|---|---|
| `core-visual` grid captures | 8 | cold visual record run | independent cold run, **18/18** |
| `workflow-visual` grid captures | 10 | same | same |
| `dimensions` 6, `grid-rendering` 5, `scrolling` 4, `evaluate-formula` 2, `paste-special` 2, `protection` 2, `go-to-special` 1 | 22 | cold full functional record run | independent cold full run, all green |

**The audit was mechanical, not narrative.** Every golden was sha256'd before the pass; the record
runs used `--update-snapshots`; the hashes were diffed afterwards. That answers "what actually
changed" with a list instead of a claim. **18 files changed in the visual run and 25 in the
functional run — 40 expected, 3 not.**

**Attribution, per §3aq's list.** All 40 are the D5 crop: every one changed SIZE, 1232x556 ->
1218x542, which is the arithmetic-free consequence of framing `[data-grid-canvas-layer]`. Two
goldens carry a second, visible cause on top of the crop, and both were confirmed by opening the
images rather than by assuming:

- **`grid-core-editing-mode` — three causes in one picture, all on the list.** The crop; **D7**, where
  A2 moved from a black left-aligned `#VALUE` to a **red, centred `#VALUE!`** (the second defect D7
  describes — `isErrorValue` only matches the canonical literals, so the old spelling was not painted
  as an error at all); and the `<input>` -> `<textarea>` swap, which is why §3aq listed this one as
  inherited-stale rather than caused by the batch.
- **`grid-evaluate-formula-*`** — the predicted `#CIRCULAR!` residue from `edge-cases` at AH1:AH2.

**The `clickCell` drift was fixed BEFORE recording, as instructed.** `core-visual.spec.ts`'s editing
test now reaches A1 through `navigateTo` (the Name Box, a real DOM input) instead of `clickCell`
(uniform column-width pixel maths that drifts run to run and can leave an ambient RANGE selection —
measured elsewhere as M3:T19 one run, N3:T20 the next). Recording after a `clickCell` would have
frozen one side of that coin flip into the baseline. The recorded golden shows the selection on A1
exactly, and it reproduced byte-stably on the independent verify run.

**The eleven scrollbar goldens are fixed by construction, confirmed rather than assumed.** All four
`scrolling` goldens plus the other seven ex-thumb failures pass on an independent cold full run, and
the new captures are 1218x542 with no scrollbar in frame — the cause is gone, not the pixels moved.

#### THREE GOLDENS REFUSED — and refusing them is the finding

`--update-snapshots` rewrote three `ribbon-tabs` goldens that are on no expected list. All three were
**restored from the pre-pass backup**, because in each case the diff was ambient state the capture
never chose:

- **`ribbon-home-tab-buttons` and `ribbon-ribbon-tab-home-restored` — the MOUSE POINTER.** Both diffs
  were the identical 57x26 box at the top left, 1465 px, max channel delta 13. Cropped and magnified,
  it is a rounded grey **hover background behind the "Home" tab**: the pointer was left wherever the
  previous action put it. Re-recording cannot fix that — the next spec to leave the pointer elsewhere
  fails the new baseline exactly as the old one failed.
  **Fixed at the cause instead**, in the same spirit as `settleCanvasMotion` and
  `parkSelectionAwayFrom`: `takeRibbonScreenshot` now parks the pointer on the inert bottom-left of
  the status bar first (not (0,0) — that is the File menu). **The fix costs zero baselines**: with the
  pointer parked the app renders what the ORIGINAL goldens already held, and both tests pass against
  the restored files on the verify run.
- **`ribbon-minimized` — grid content residue, pre-existing, still failing.** A whole-window
  checkpoint whose frame includes the grid; expected holds a clean A1 = `Before`, actual holds A1 =
  `3` plus `first second` / `original` / `hello` / `tabbed` left by sibling specs, and different
  scrollbar thumbs. This is §3ao's fourth residue class, it is one of the baseline's own 13 failures,
  and **recording it would freeze one run's accumulated residue into a golden that any change of run
  order breaks.** The honest fix is the one §3ao names — capture from a known state — which is a
  decision about the spec, not a re-record.

#### Two diffs investigated and dismissed WITHOUT touching a golden

- **`core-empty-grid`** failed on a warm app with the ribbon's font box reading `Calibri` instead of
  `system-ui` and a vertical-align button lit. Mechanism found in the source:
  `HomeTabGroupComponent.tsx:182` renders `state.currentStyle?.fontFamily ?? "system-ui"`, and
  `resetToNewWorkbook` dispatches `dimensions:refresh` / `app:sheet-changed` / `grid:refresh` — none
  of which re-reads the active cell's style into the ribbon — so `new_file` clears the document while
  the ribbon keeps the style the previous run left. **Proof it is residue and not a product change:
  on a cold app the golden was not rewritten at all**, i.e. it matched the existing baseline
  byte-for-byte. Left alone. It is order-dependent and will fail whenever `visual` is not the first
  thing after a launch; that fragility is recorded here, not papered over.
- **`core-formula-bar-display`** failed only in the run whose first two tests died in the fixture on
  the documented cold-start timeout. Passed on every warm run; no golden touched.

#### The suite still has teeth — proved by breaking it

The established probe, run against the RECORDED baselines: `DEFAULT_THEME.gridLine`
(`gridRenderer/types.ts`, the value the default light skin actually uses via
`GRID_BASELINES.light`) changed `#e2e2e2` -> `#c8c8c8` — one shade, the smallest honest defect.

| step | result |
|---|---|
| before | probe test **passes** |
| gridline changed, full page reload | **FAILS** — `core-empty-grid` 39,980 px over the grid region; `grid-core-data-entry` and `grid-fmt-alignment` also fail |
| reverted | all **18** grid goldens pass again |

A **full page reload** was used, not an HMR patch: `skinLoader`'s `cachedGridTheme` is computed at
init and survives HMR, so an HMR-only check would have proved nothing.

The single failure remaining after the revert was `core-empty-grid`, and it was attributed rather
than waved through: its diff bbox is `[128,69]-[441,108]` — entirely inside the RIBBON — with zero
differing pixels over the grid, i.e. the residue above and not the gridline. Cold, the same suite is
18/18.

#### Numbers

| suite | baseline | after |
|---|---|---|
| visual | 17 passed / 1 failed | **18 passed / 0 failed** (cold) |
| functional | 526 passed / 13 failed / 11 skipped | 495 passed / **4** failed / 8 skipped at test 507 of ~550, where the run was stopped by hand (§2u) |
| scenario | 24 / 24 | 18 passed / **1 failed** / 5 did not run — **§2t, a real D2 regression** |

The four functional failures: `ribbon-minimized` (refused above, pre-existing), `state-consistency`
(the monkey-sequence flake §3ao already classified), and `vba-idioms-wave4` tests 7 and 8 (§2u).
**Every one of the 13 baseline failures that was a grid golden is now green.**


### 3as. Proved LIVE — what `owner-decisions.spec.ts` holds, and the two defects that writing it found (2026-08-09)

D1–D7 were decided, built in separate sessions, integrated in one pass (§3ap) and had their goldens
re-recorded (§3ar). Through all of it, **no test had ever driven the seven decisions through the
product on a running app.** Unit tests prove a Rust function seeds a cascade; a React test proves a
DOM node exists. Neither proves the user sees the new number. This phase supplied that, and found two
defects every static check had passed.

`app/e2e/journeys/owner-decisions.spec.ts` — **10 tests, 10 passing, 1.6 min.** It lives in the
JOURNEY project because it changes the workbook's calculation mode and iteration settings, defines
and deletes names, and saves and reopens the document; the functional specs share one accumulating
workbook whose goldens encode the residue of everything before them (§3b). Fresh grid real estate
(CE–CN); the columns other specs park fixtures in are untouched.

| # | test | what it proves that no unit test could | time |
|---|---|---|---|
| D1a | a dependent on a NON-ACTIVE sheet updates after F9 and NOT after Shift+F9 | scope, on the rendered grid, under MANUAL calculation — the only mode in which the two commands are distinguishable at all | 13.8s |
| D1b | a cross-sheet iterative cycle converges under repeated F9 **with no sheet switching** | the measurement that settled D1: six presses used to move it nowhere. **It converged in ONE press** (logged by the test) | 13.8s |
| D2 | a typed formula keeps its NAME — bar, repoint, delete, save/reload | all four halves, including §2t | 14.7s |
| D3a | a formula over a pivot's output follows creation AND refresh | the seeding, rendered | 9.2s |
| D3b | a table operation moves a formula reading the totals row | including the totals row COMPUTING at all — D3's third defect | 7.0s |
| D4 | the pill claims no grid region, A1 reaches the grid, close unloads | the region claim is read off the REAL `getGridRegions()`; the click assertion also requires playback NOT to start | 8.6s |
| D5 | the grid capture rectangle excludes the scrollbars, structurally | geometry, not a golden — the thing goldens were unreliable about | 5.6s |
| D6 | Cells demotes between Styles and Editing, not last | the LIVE registered priorities and the LIVE measured widths, through the product's own `computeWidthDemotions` | 1.0s |
| D7 | `#DIV/0!` / `#NAME?` render, no `#PARSE`, literals survive save/reload | the painted string and the round trip | 13.2s |
| — | the TYPING RACE: a multi-character value typed into a CLOSED cell commits whole and in order | §2r, at full speed, four ways (word, word+Enter with no pause, ten characters, a number) | 8.9s |

**Every fixture asserts the WRONG value first.** D1a asserts the cross-sheet dependent is stale at
`20` before either press; D1b asserts the cycle starts more than 1.0 from its fixed point; D3a and
D3b assert their readers are `0` before the pivot and the totals row exist; D4 parks the selection at
CE50 so "A1" cannot be residue; D5 asserts the scrollbars EXIST and are non-degenerate before
requiring them to be outside the frame; D7 asserts the intermediate document is empty before each
reload. A stale value that happens to equal the fresh one proves nothing.

#### Three teeth checks, run rather than argued

| what was broken | result |
|---|---|
| `cells: collapsePriority` **55 → 99** in `homeTabConfig.ts`, full page reload (HMR does not re-run activation) | D6 FAILS on the live priorities; driving the product's own fit function with 99 produces the demotion order `[… styles, **editing, cells**]` — Cells last, which is the defect verbatim. Restored |
| `data-grid-canvas-layer` removed from `S.CanvasLayer` | D5 FAILS naming the DO-NOT-BREAK contract (`Expected 1, Received 0`). Restored |
| the `restamp_workbook_name_casing` call deleted from `open_file`, rebuilt, cold | D2 FAILS on exactly the §2t line: `Expected "=OwnerDecisionRate"`, `Received "=OWNERDECISIONRATE"`. Restored, rebuilt, green |

D1 and D3's teeth are the preconditions inside them (a Rust rebuild per probe is not free, and the
stale-value assertion fails against the pre-decision behaviour by construction).

#### Where D6 is modelled rather than resized, and why that is the right call

D6 reads the LIVE section list from `panelRegistry` and the LIVE rendered widths of the ribbon
strip's own children, then narrows the band step by step through `computeWidthDemotions` — the
product's real decision function. It does **not** shrink the actual ribbon, because `useSectionFit`'s
own contract is that a demoted section STAYS demoted for the app session (its inline content is
unmounted, so it cannot be re-measured). Narrowing the real band would leave demoted sections behind
for every spec after it. Flagged as a deliberate modelling choice, not hidden.

#### Suite numbers — every project from a COLD app

| project | baseline | this run |
|---|---|---|
| **functional** | 526 passed / 13 failed / 11 skipped | **542 passed / 3 failed / 11 skipped** (40.2 min) |
| **macro/VBA**, the 12 specs | 57 / 57 (and 2 hanging 10 min each, §2u) | **57 / 57** (12.8 min) |
| **journey** | 54 passed / 1 skipped | **64 passed / 1 skipped** (12.2 min) — +10, this file |
| **scenario** | 24 / 24, but **18 / 1 / 5** after §2t | **24 / 24** (1.8 min) |
| **visual** | 18 / 18 | **18 / 18** (2.7 min) |
| vitest | 742 files / 106,165 | **742 / 106,165** |
| core `cargo test` | 1,285 | **1,285** |
| `-p script-engine` | 111 | **111** |
| app-lib | 1,148 | **1,152** (+4, §2t) |
| `test_pivot` | 56 | **56** |

**The three functional failures, classified — a number without this is not a result.**

| failure | verdict | evidence |
|---|---|---|
| `inline-editor-live` 8 — "the word AND its Enter typed at full speed still commit the word" | **CASCADE** | the file is **8/8 green cold in isolation**. B30 came back EMPTY (not the pre-fix `"b"`), and the obvious residue was ruled out by measurement, not by reasoning: `formatting.spec.ts` leaves `"UnboldTest"` in B30, so the same word was typed at full speed into an OCCUPIED B30 twelve times over three trials — **12/12 committed `tabbed`**, empty and occupied alike, `type`+`press` and combined `"word\n"` alike. The upstream spec responsible is NOT identified; an attempt to reproduce it with an alphabetical prefix run was abandoned because a stray Playwright client from a killed earlier attempt contaminated the CDP session, and a contaminated run is not evidence |
| `ribbon-tabs` — `ribbon-minimized` golden | **PRE-EXISTING, already refused** | §3ar refused to re-record this one: its diff is grid-content residue from whichever specs ran before it, and recording it would freeze one run's residue into the baseline. One of the baseline's own 13 |
| `state-consistency` — random action sequence | **FLAKE, characterised** | seed 1786259782413, step 6 of 6, invariant `page-crashed` on `ribbon.switch-tab`. The call log shows `<div class="css-1fr3uyz"> intercepts pointer events` — a monkey sequence that opened an overlay and then clicked through it. §3ao classified this same invariant as a flake after it passed one run and failed the next on the SAME build |

**Everything else in the baseline's 13 is now green**, including the two `paste-special` goldens D5
predicted, `evaluate-formula`, `go-to-special`, `protection` and `scrolling`.


### 3at. The D8 integration pass — contract verification, the reproduction, and the defect that probing the neighbours found (2026-08-09)

D8 landed from a separate session. This pass integrated it, re-ran every unit suite, made each
contract FAIL before trusting it, and reproduced the measurement rather than believing it.

**Contract (a) — the four EXEMPT entries are gone, and the census still has teeth.** The list is
**50** entries; `insert_rows`, `insert_columns`, `delete_rows` and `delete_columns` appear nowhere in
it. Sabotage on two of the four, as asked — and the first attempt exposed a second hole:

- **The first sabotage PASSED, and it was the sabotage that was wrong.** The recalc call was
  "removed" from `insert_rows_impl` by commenting it out. The census passed. The RECALC half of the
  detector read the function's RAW body, so the commented-out line still satisfied it. Deleting the
  lines instead failed the census naming exactly `commands/structure.rs::insert_rows_impl`.
- Deleting the call from `delete_columns_impl` failed the census naming exactly
  `commands/structure.rs::delete_columns_impl` — reproducing the implementation's own report.
- While sabotaged, the BEHAVIOURAL tests were run too, because the census only checks that a function
  recalculates and not that it recalculates correctly: **5 of the 19 D8 tests failed**, all of them
  the column cases. Both halves have teeth, independently.
- Restored; app-lib green.

**The comment hole is now closed**, the same way `DELEGATING_HELPERS` closed the delegation hole. The
detector strips comment lines before looking for a shared entry point, and two cases pin it (a
commented-out call and a prose mention). A sweep first confirmed that **no function in the crate was
relying on a comment** — 90 cell-writing functions enumerated, 0 classified as recalculating on
comment text alone — so this hardening changed no classification, it only removes a way to break one
silently. Both real call sites of this class are wrapped in a comment that names the entry point,
which is precisely why a careless deletion leaves the name behind.

**Contract (b) — still ONE cascade, and no fourth walk.** Verified by reading all four commands. The
seeds are accumulated in loops that already existed: the rewrite loop (`seeds.rewritten`), the
move loop (`seeds.moved`), and for the deletes the removal loop. No loop was added. The two
off-coordinate triggers go through `recalc_after_off_sheet_write` and `recalc_after_name_change` —
both pre-existing entry points, neither a new cascade concept. The second-lock-phase pattern is
preserved in all four: every guard is explicitly dropped before the recalc, and the result rows are
read back afterwards, which is what makes the reply carry the new values.

**Contract (c) — undo AND redo, not just the forward path.** Four tests drive the real
`undo_commands::apply_changes` (the shared body `undo` and `redo` both run) and assert through the
same `assert_settled` oracle, including a cross-sheet case. The implementation's reasoning holds up:
both restore whole-grid snapshots, so undo was always safe and **redo was not** — it replays a
snapshot captured at undo time from a workbook the forward path had left stale, which means fixing
forward is what makes redo right.

**Contract (d) — the measurement REPRODUCED.** Run twice on this machine, debug profile, same
fixture. The load-bearing conclusion held both times.

| case | rows | opt 1 | +moved | CHOSEN | opt 2 | whole-sheet | seeds |
|---|---|---|---|---|---|---|---|
| worst 10 000, as reported | 10 000 | 220.08 | 291.06 | **303.29** | 628.08 | 392.76 | 30 009 |
| worst 10 000, run 1 here | 10 000 | 258.26 | 302.41 | **289.40** | 625.15 | 394.26 | 30 009 |
| worst 10 000, run 2 here | 10 000 | 222.28 | 308.02 | **310.06** | 636.60 | 392.31 | 30 009 |
| typical 10 000, run 2 here | 10 000 | 1.88 | 1.83 | **1.84** | 3.22 | 362.71 | 159 |

**What reproduces:** option 2 is worse than the whole-sheet pass it would replace (625–637 ms against
392–394 ms), the chosen set beats the whole-sheet pass at every size, and in the typical case
recalculation is under 1% of the command. Seed counts are identical to the digit. **What does not
survive the second run** is the claim that the chosen set costs "~25–55% more than option 1": against
option 1 PLUS moved formulas it is inside the noise (289 vs 302 one run, 310 vs 308 the next), and
only the bare option-1 comparison is real. That is a correction to the write-up, not to the decision
— option 1 is incomplete at any price.

**Contract (e) — every touched command still picks a `DocumentEffect` arm.** All four `*_impl` bodies
construct `DocumentEffect::mutates(&file_state)` after their gates and before their mutation, as does
`off_sheet_structural_edit`. The `#[tauri::command]` wrappers introduced by the `*_impl` split
construct none and need none: they write nothing, and every `Persisted<T>` write in the body is
type-gated on the token the body holds.

**THE NEIGHBOURS — the question D8 did not ask.** A structural edit is not the only thing that moves
a formula without rewriting it, nor the only thing that changes a formula's inputs without writing a
cell. Each was checked by reading the path to the write, not by assuming:

| neighbour | verdict |
|---|---|
| **cut/paste move, drag-move** (`useClipboard` + `relocate_cell_references`) | **SAFE, by a different mechanism.** The destination is not moved, it is REWRITTEN: the frontend calls `updateCell` per destination cell, which evaluates the formula at its new address. `=ROW()` cut from A5 to A20 is evaluated at A20. `relocate_cell_references` then repoints the OTHER formulas and seeds them. It skips the destination range deliberately, and that skip is correct only because of the `updateCell` above it |
| **`sort_range`** | **SAFE.** It seeds every cell of the sorted range, so a moved `=ROW()` inside it is a seed. Nothing outside the range moves |
| **insert/delete CELLS (shift right/down)** | **does not exist** — no such command in the crate. The four row/column edits are the whole class |
| **hide/unhide rows** (`set_rows_hidden`) | **SAFE and already reasoned about**: it documents that row visibility is a formula input for SUBTOTAL/AGGREGATE, that hiding writes no cell, and that nothing in the dependency graph would dirty them — and cascades explicitly |
| **AutoFilter** | **SAFE**: 12 call sites of `recalc_visibility_after_row_change_from_handle` in `autofilter.rs` |
| **the shared cascade's own view of what is hidden** | **BROKEN — see §2v.** Found here, fixed here |

**Suites at hand-off.** vitest **742 files / 106,165** (baseline, unchanged — no TypeScript was
touched). core **1,285** (1,174 + script-engine 111). script-engine **111**. app-lib **1,171**
(1,152 baseline + 17 D8 + 2 for §2v; ignored 2 -> 3, the third being the D8 benchmark). `test_pivot`
**56**. `cargo check` clean on both workspaces, app crate **0 warnings**; the two core warnings are
pre-existing, in `engine` and `pivot-engine` TEST code, untouched by this pass.
`check-types`, `lint:boundaries`, `check:script-typings` (**39/736**) and `check:line-endings`
(**0 mixed**) all clean. No E2E was run and no golden was re-recorded, as instructed.


### 3au. Proved LIVE — `structural-recalc.spec.ts`, the sabotage that gave it teeth, and the two things writing it corrected (2026-08-09)

§3at handed over one thing owed: neither **D8** nor **§2v** had been proved on a running app. This
pass discharges it. `app/e2e/journeys/structural-recalc.spec.ts` — 10 tests, journey project — drives
the REAL gesture end to end and reads the string `get_viewport_cells` hands the canvas.

**THE GESTURE IS REAL, and that is the whole point of the spec.** `headerMenu` left-clicks the row or
column header and ASSERTS the selection really became `rows`/`columns`, right-clicks the same pixel,
waits for `[role="menu"][aria-label="Context menu"]`, and clicks the item whose text is exactly
"Insert Row" / "Delete Row" / "Insert Column" / "Delete Column". The header pixel is found by asking
the app's own `hitTesting` which pixel belongs to the line and skipping the resize handles — the
pattern `flagged-defects.spec.ts` established. `invoke` appears only in fixtures and oracles, never
in the thing under test.

| # | claim | live result |
|---|---|---|
| 1 | `=ROWS(E1:E5)` renders 5; a menu insert inside the range makes it `=ROWS(E1:E6)` **and renders 6** | pass, 8.2 s — plus the painted G1 pixels change, so the canvas repainted |
| 2 | `=ROW()`, `=ADDRESS(ROW();COLUMN())` follow a row insert with NO reference rewritten | pass, 6.6 s |
| 2b | `=COLUMN()` follows a column insert the same way | pass, 6.7 s |
| 3a | row DELETE: `ROWS` 5→4, `SUM` 150→120, `=ROW()` moves up | pass, 6.6 s |
| 3b | column DELETE: `COLUMNS` 4→3, `SUM` 10→8, `=COLUMN()` moves left | pass, 6.7 s |
| 3c | column INSERT: `COLUMNS` 4→5 | pass, 6.7 s |
| 4 | Sheet2 reader into Sheet1's edited range follows — STORED first, then RENDERED | pass, 11.2 s |
| 5 | Ctrl+Z restores rendered values and Ctrl+Y follows forward — for the insert AND the delete | pass, 19.2 s |
| 6 | 44 ordinary formulas + a plain `=E2+E3` still correct after insert and delete | pass, 9.5 s |
| 7 | §2v: a HIDDEN row stays ignored by `SUBTOTAL(109)` when the edit re-evaluates it | pass, 6.6 s |

**TEETH, BY SABOTAGING A RUNNING BUILD — twice, because the two fixes need different sabotage.**

- **D8 off** (`StructuralSeeds::finish` returns empty; `recalc_structural_side_effects` returns
  early): **8 of the 10 tests fail**, each with exactly the stale value this register predicts —
  ROWS 5 for 6, `=ROW()` 10 for 11, `=COLUMN()` 8 for 9, ROWS 5 for 4 on the delete, COLUMNS 4 for 3,
  4 for 5, and the cross-sheet STORED read 5 for 6. **The two survivors are the two that should
  survive**: test 6 is the no-regression control (those values were right before D8 — that is its
  job), and test 7 is §2v, which with no seeds is never re-evaluated and therefore keeps its correct
  answer. That is §2v's own thesis reproduced from the other side.
- **§2v off** (the `begin_pass` guard commented out, D8 live): test 7 renders **150** where 120 is
  correct. This is the first reproduction of §2v anywhere but a unit test, and it is a wrong answer
  written over a right one on the painted grid.
- Both files restored and verified **byte-identical by checksum** (`structure.rs`
  `3da57f3a…`, `data.rs` `6664448f…`), zero sabotage markers left in the tree.

**TWO THINGS THE SPEC GOT WRONG FIRST, and neither was the app.** Worth recording because both are
the failure mode this register keeps warning about — writing the expectation from reading:

1. The cross-sheet test asserted the re-pointed formula reads `=ROWS(Sheet1!E1:E6)`. It reads
   `SHEET1!`. Probed on the running app before touching anything: the sheet name is stored uppercased
   **at cell entry**, before any structural edit exists, on both sheets — entry-time normalisation,
   orthogonal to D8. The assertion now pins the part under test (which ROW the range ends at) and is
   deliberately case-insensitive about the name, with the probe recorded at the assertion so nobody
   re-derives it. **A cosmetic residual, newly named: a user who types `Sheet1!` gets `SHEET1!` back
   in the formula bar.** Not investigated further; it is not this program's.
2. Two arithmetic errors of mine — a row inserted at 6 does not move row 2, and hiding a row holding
   30 gives 120, not the 130 of §2v's differently-valued fixture. Both fixed in the spec.

**MEASURED IN THE APP: does a row insert feel slow?** A/B on the same running build, frontend-timed,
median of 5 — full table in **D8**. Empty sheet **9.2 → 11.0 ms**; 2 000 rows x 9 columns with 8 000
formulas, worst-case insert at the top **219.4 → 319.4 ms**, typical insert near the bottom
**181.7 → 189.9 ms**. Debug build. It does not read as a stall, and the common gesture is unchanged.

**EVERY PROJECT RUN, each from a COLD app** (kill, relaunch, wait for CDP, `E2E_MANUAL=1`):

| project | result | baseline | verdict |
|---|---|---|---|
| journey | **74 passed / 1 skipped** (13.0m) | 64 + 1 skipped | +10 = the new spec, nothing else moved |
| functional | **543 passed / 2 failed / 11 skipped** (40.6m) | 542 / 3 / 11 | **one BETTER** |
| macro (12 macro-/vba- specs) | **57 / 57** (12.8m) | 57 / 57 | unchanged |
| scenario | **24 / 24** (1.7m) | 24 / 24 | unchanged |
| visual | **18 / 18** (2.7m) | 18 / 18 | unchanged, no golden re-recorded |

The functional run's two failures are the known baseline pair — `ribbon-tabs` Ctrl+F1 and
`state-consistency` monkey. The third baseline failure, `inline-editor-live` "the word AND its Enter
typed at full speed", **passed this time**; it is the documented full-speed typing race, so this is
the flake resolving, not a fix. No new failure in any project, so nothing needed root-or-cascade
classification.

`check-types`, `lint:boundaries`, `check:script-typings` (**39/736**) and `check:line-endings`
(**0 mixed**) all clean at hand-off.


### 3av. `report_definitions` — the mirror is gone, not disciplined (2026-08-09)

The last correctness item on the list, and the one §3ai deliberately left: reports were a store
(`AppState.report_definitions`, a bare `Mutex<Vec<SavedReport>>`) plus a MIRROR
(`extension_data["calcula.reports"]`), and the mirror was what reached the `.cala`. Nothing forced
`sync_reports_to_extension_data` to be called, so a report mutation that skipped it was dropped at
save with no error and no prompt.

**THE ROUTE ENUMERATION, WHICH IS THE EVIDENCE THE FIX IS COMPLETE.** This program has twice been
burned by a by-name list that missed a caller, so every route was found from the code — `rg
report_definitions`, then every writer walked — not from the section that filed the item.

| # | route | mutating site | synced before? |
|---|---|---|---|
| 1 | `create_report` | `report.rs` push | yes |
| 2 | `refresh_report` (incl. Edit Design Query rename + DSL swap) | `report.rs` `iter_mut` | yes |
| 3 | `delete_report` | `report.rs` retain | yes |
| 4 | `restore_report` (`.calp` pull, via the distributable-object channel) | `report.rs` retain+push | yes |
| 5 | delete sheet | `sheets.rs` retain + shift | yes |
| 6 | move sheet | `sheets.rs` remap | yes |
| 7 | copy sheet | `sheets.rs` shift | yes |
| 8 | row/column insert + delete | `commands/structure.rs` `sync_report_definitions_to_regions` | yes |
| 9 | undo/redo of any of the above | `undo_commands.rs` `apply_report_restore` | yes |
| 10 | open workbook | `persistence.rs` whole-vector assign | n/a (load) |
| 11 | File > New | `persistence.rs` clear | n/a (reset) |

**All eleven were correct. That is the finding, not an acquittal** — the defect was never an
instance, it was that correctness at the twelfth site was unpurchased. Scripting/broker and MCP have
no report surface at all (checked: no `report` verb in the script validators or the 21 MCP tools;
scripts reach reports only by invoking the same commands), so the list above is the whole surface.

**Two REVERSE-direction routes nobody had enumerated, because the item was framed as store->mirror.**
The mirror could also be written without the store, and both of these were reachable on HEAD:

1. **`set_extension_data("calcula.reports", …)`.** The reports slot key is spelled EXACTLY like the
   Reports extension's manifest id (`extensions/Reports/index.ts`), and `setExtensionData(EXTENSION_ID,
   …)` is the idiom every other extension uses to persist (Animation does it). One such call would have
   replaced every report in the workbook with whatever the caller was persisting.
2. **The `.calp` extension-data merge.** `merge_pulled_extension_data` inserts any key the subscriber
   lacks, so a published workbook's raw reports slot rode into the subscriber — with the PUBLISHER's
   connection ids and sheet indices and no protected regions — alongside the properly rebound copies
   that `restore_report` installs.

**THE DESIGN, AND THE ONE THAT WAS REJECTED.** The obvious fix was the `DocumentEffect` shape: a
guard type over `report_definitions` whose `Drop` performs the sync, making the mutation and the
persist inseparable. It was rejected, and the reason generalises: **a guard disciplines two
representations; it does not remove the second one.** It leaves the reverse direction wide open
(both routes above stay legal), it leaves a cache that can be stale between the mutation and the
drop, and it leaves a future author free to add a reader that reads the wrong one.

What shipped is the collapse. `AppState.report_definitions` is DELETED. `extension_data[REPORTS_EXT_KEY]`
is the one representation — the thing that is saved is the thing that is mutated — reached through
exactly two doors in `report.rs`:

* `read_reports(state) -> Reports` — free, no effect. Returns a `Reports` newtype that derefs to
  `[SavedReport]`: everything a reader wants, nothing a writer wants. (A plain `Vec` would have made
  `read_reports(&state).push(r)` compile and do nothing — the same "my change did not survive"
  failure one scope smaller.)
* `with_reports_mut(state, effect, f)` — takes a `DocumentEffect`, hands the closure a `&mut Vec`,
  and writes the result back before it returns. There is no sync to forget because there is nothing
  to sync. It writes nothing when the closure changes nothing, so the callers that run on every row
  insert and every sheet reorder do not stamp an empty `"calcula.reports": []` into every workbook.

The two reverse routes are closed at the only place a string key arriving over IPC can be:
`reject_reserved_extension_key` refuses the slot in both `set_extension_data` variants with a message
naming the report commands, and the `.calp` merge skips it (reports arrive through `restore_report`,
which rebinds the connection and registers the region).

Three sheet-index loops in `sheets.rs` — delete, move, copy — collapsed into one
`report::remap_report_sheets(state, effect, |i| -> Option<usize>)`, which is the exact shape of the
`remap_sheet_keyed_stores` call sitting next to each of them.

**THE COMPILE-TIME HALF, DEMONSTRATED.** A four-arm probe, each arm a way to change reports without
persisting them. All four failed; probe deleted.

```
error[E0609]: no field `report_definitions` on type `&AppState`
error[E0061]: this method takes 1 argument but 0 arguments were supplied   (extension_data.write())
error[E0061]: this function takes 3 arguments but 2 arguments were supplied (with_reports_mut, no effect)
error[E0599]: no method named `push` found for struct `Reports` in the current scope
```

Two permanent tests replace it: `appstate_holds_no_second_copy_of_the_report_store` (source-level —
a re-added cache compiles, so there is nothing else to check) and `only_report_rs_reaches_the_reports_slot`,
which allows exactly three files to NAME the key and carries each one's reason, so a fourth has to be
argued for rather than merely made to compile.

**THE ACCEPTANCE TESTS ARE `mutate -> save -> reload -> still there`, not "the sync was called."**
That distinction is the whole item: "the sync was called" is precisely the assertion that PASSES on
the broken design, because all eleven sites called it. Ten tests, one per route, each ending in a
real `.cala` written to a temp dir with `save_calcula` and reopened with `load_calcula`. Two of them
are negative (a deleted report stays deleted; an undone one does not come back), because a deletion
that fails to reach the file is the same bug wearing the other hat.

**THE CLASS SWEEP.** The shape hunted: state SAVED from one representation and MUTATED through
another, joined only by a call someone has to remember.

* **Every source in `assemble_workbook_for_save` was walked.** All 25 of them read the canonical
  store directly — §3ai's conversion is why. `report_definitions` was the last mirror on the Rust
  save path and there is no second one.
* **`animationStore.ts` — the same disease, in TypeScript. FIXED.** A module-level `let animations`
  plus a `persist()` that each mutator had to remember; the extension-data blob is what the `.cala`
  keeps. Both existing mutators were correct — again, the point is the third. The list now lives in a
  `#private` field with three doors: `mutate()` (changes AND writes through, indivisibly), `adopt()`
  (installs a list that CAME FROM the workbook — load and File > New — and says so in its name), and
  a `readonly` `current`. Probe: `store.#animations = …` → `TS18013 not accessible outside class`;
  `store.current.push(…)` → `TS2339 Property 'push' does not exist on type 'readonly AnimationSpec[]'`.
  Three tests added, including the same acceptance shape (mutate → persist → reload → still there).
* **`CellBookmarks` — the same shape done RIGHT, and worth naming.** Its write-through is driven by a
  SUBSCRIPTION to the store's change notification, not by a remembered call at each mutator; its own
  header records that it used to be a `BEFORE_SAVE` listener racing the serializer. Alongside
  `relink_autofilter_owner` (recompute, don't maintain) and `persist_scheduled_jobs` (project at save
  time from the one live registry), that is three worked examples of the right answer in this tree.
* **Checked and CLEAN, single-representation:** `persist_saved_registries` (the file IS the store —
  every command re-reads it), `persist_scheduled_jobs` (save-time projection of the scheduler
  singleton, which unconditionally owns its `user_files` key), `rebuild_writeback_index` /
  `rebuild_gather_cache` / `rebuild_all_dependencies` / `id_registry` / the spill maps (derived caches
  rebuilt from truth, never saved), `monteCarloStore.ts` (transient playback state, never persisted).
* **REPORTED, not fixed — `persist_security_config`.** The Script Security level and the AI access
  ceiling live in `ScriptState` and are mirrored to `script-security.json` by a remembered call. Both
  writers call it today, and the whole surface is two commands in one file, so the ratio of a type
  change to the risk is wrong. **Recommendation:** if a third writer is ever added, fold the write
  into a `set_security_level(state, level)` helper that does both, rather than adding a third
  remembered call. Worth noting the failure mode is a REVERT to the persisted value on relaunch, not
  a corruption — and the load path already refuses malformed or unrecognised levels.

**Verification.** app-lib **1,186 passed / 3 ignored** (baseline 1,169). **This pass added 15**
— 14 `report::tests` and 1 `document_effect_objects_tests` — so 2 of the +17 predate it and the
stated baseline is stale by that much; every test in the suite passes either way, and with `git`
unavailable in this session the pristine count could not be re-measured rather than inferred, which
is why the discrepancy is written down instead of rounded off. core `cargo test` **1,285**
(baseline 1,285) · script-engine
**111** (baseline 111) · `test_pivot` **56** (baseline 56) · `cargo check --lib --tests` **0 warnings** ·
vitest **742 files / 106,168** (baseline 742 / 106,165; +3 = the animation store tests) ·
`check-types`, `lint:boundaries`, `check:line-endings` (0 mixed), `check:script-typings` (**39/736**)
all clean. **No `.cala` `format_version` bump**: the reports slot's JSON is byte-identical to what the
mirror wrote; the only shape change is that a workbook with no reports no longer carries an empty
`"calcula.reports": []` key, which is an extension-data key like any other.


### 3aw. §3av proved LIVE — the sabotage that gave it teeth, and the correctness item that checking the claim found (2026-08-09)

§3av verified the collapse with Rust tests, a source-level test that no second copy is declared, and
a four-arm compile probe. All three are blind to the same thing: none of them opens the product.
They cannot show that the gesture a USER makes — Model ▸ Report from Design Query…, type a design
query, press Create; then Edit Query, rename, Save & refresh — reaches that code, nor that what the
user sees after Save and reopen is what they left.

**`app/e2e/journeys/report-store.spec.ts` — 7 tests, 7 passing, from a cold app.** One test per
mutation route, because the defect was that SOME route might forget the persist, so proving one route
proves nothing about the others. Every test ends in a real `.cala` written with `save_file`, wiped
through the app's own File ▸ New, and reopened with `openFileAtPath`. The assertion shape is
`mutate -> save -> WIPE -> reopen -> still there`, never "the sync was called" — the latter is
exactly the assertion that PASSED on the broken design.

| # | route | the gesture, as a user makes it | time (s) |
|---|---|---|---|
| 1 | create + refresh (**THE HEADLINE**) | Model ▸ Report from Design Query…, then the contextual **Report** ribbon tab ▸ Edit Query: rename AND a new design query | 21.4 |
| 2 | delete (the negative half) | Model ▸ Manage Reports… ▸ Delete — it must STAY deleted, and its cells stay cleared | 17.7 |
| 3 | row insert — **no UI anywhere in the chain** | a sandboxed BUTTON object script in its worker realm calling `api.insertRows`, worker → broker → `insert_rows` → `sync_report_definitions_to_regions` | 16.9 |
| 4 | sheet delete | the sheet-tab context menu ▸ Delete and its confirmation; the report's sheet index re-points 1 → 0 | 18.5 |
| 5 | undo | a real Ctrl+Z on the grid undoing a RENAME — a positive value restored, not an emptiness | 23.9 |
| 6 | the REVERSE route the fix closed | `set_extension_data("calcula.reports", …)` over IPC is REFUSED, and the reports survive the attempt | 13.4 |
| 7 | the class sweep's other instance | View ▸ Animation Timeline ▸ + New — a saved animation survives the same cycle | 10.7 |

Every "still there after reopen" is preceded by the PRE-SAVE assertion of the same value AND by an
assertion that File ▸ New really emptied the store, so no test can pass on a report that was never
modified or on a wipe that never happened.

The BI fixture (a CSV-backed model built with the Model Editor's own commands) is `invoke`d on
purpose: it is setup. Everything from "open the Model menu" onwards is the real UI. Two surfaces were
deliberately not used and the spec says why: the Report tab's own Delete confirms through a NATIVE
Windows message box (outside the WebView, so outside Playwright), and the Monaco content is replaced
with `insertText` rather than typed newlines because the field names in `ROWS:` reliably open the
autocomplete popup, which swallows Enter.

**THE TEETH — both halves, because they answer different questions.**

*Does the CODE refuse a forgetful mutation?* The "twelfth site forgot" defect was written into
`structure::sync_report_definitions_to_regions` the obvious way — take the reports, edit them, never
write back:

```
error[E0599]: no method named `retain` found for struct `Reports` in the current scope
   --> src\commands\structure.rs:91:10
```

*Does the SPEC catch it?* Forced past the type with `read_reports(state).into_vec()` — which
compiles — and run on a real rebuilt app: **exactly one test failed, and it was the sabotaged
route.**

```
x 3. a NON-UI route - a sandboxed button script calling api.insertRows ...
    Error: PRE-SAVE: two inserted rows moved the anchor 2 -> 4
    Received: 2
```

Note WHERE it failed: at the PRE-SAVE assertion, not after the reload. That is the collapse's
dividend stated as a measurement. In the old store/mirror design a forgetful route stayed correct
until the user closed the file; with one representation it is wrong immediately, in the same gesture,
where a test — or the user — can see it. The sabotage was reverted and the tree re-checked
(`cargo check --lib --tests`, 0 warnings) before any reported run.

**CHECKING "no correctness work remains" RATHER THAN ASSERTING IT — AND IT DOES NOT HOLD.**

This section's predecessor rewrote that claim into its honest form: *"the tier is empty as far as
every check in the tree can tell — and the last two things in it were each found by ADDING a check."*
Probing this fix's neighbours added one more, and it found a live defect. **§2w below.** The report
store's neighbour is the rest of the save path: §3av walked every source in
`assemble_workbook_for_save` and asked "does this read the canonical store?". The question it did not
ask is the other half — **"is that store scoped to the DOCUMENT?"** — and for three of them it is
not.

**WHY THE SWEEP MISSED IT — worth stating as its own lesson.** §3av's sweep hunted one shape
("state SAVED from one representation and MUTATED through another") and cleared everything else. That
shape was the right hunt for reports, and it missed §2w entirely, because §2w's stores have exactly
ONE representation — a single live registry projected at save time, which the sweep explicitly
praised as the RIGHT answer (`persist_scheduled_jobs`). Single-representation is necessary and not
sufficient: a save-time projection is only correct if the thing it projects has the same lifetime as
the thing being saved. Two of these three do not, and nothing checked.

**One more thing the sweep did not name, reported and not fixed:
`extensions/ScriptableObjects/lib/debugger.ts`.** It is the same module-level-mirror-plus-remembered-
persist shape as `animationStore.ts` was: a module-level `Map` and a `persistBreakpoints()`. Every
mutating path today funnels through one `commit()` that does both, and `reloadPersistedBreakpoints`
is a correctly-named adopt door — so it is correct, and it is correct for the same unpurchased reason
the reports were. The failure mode is losing BREAKPOINTS, not user data, which is why this is a
recommendation and not a fix: if a fourth mutator is added, give the map the `#private`-field
treatment `animationStore` got rather than adding a fourth remembered call.

**Verification, every project from a COLD app.** journey **81 passed / 1 skipped** (baseline 74 + 1;
the 7 new tests are the difference, and nothing else moved) · functional **542 passed / 3 failed / 11
skipped** · macro **57 / 57** · scenario **24 / 24** · visual **18 / 18** ·
`check:line-endings` 0 mixed · `cargo check --lib --tests` 0 warnings.

**The third functional failure is a CASCADE, and the evidence is stated with its own limits.**
`state-consistency.spec.ts:84` ("rapid create-delete cycles") tripped the `contextual-ribbon-tabs`
invariant at step 32 of 32: *"Table Design" is visible but at least one table must exist (tables=0,
charts=3)*, after a `table.create / table.delete / undo / sparkline.create / sparkline.delete`
sequence. Run cold and alone, that test PASSES (and `:46`, the known flake, fails as it does at
baseline). The usual criterion is met — but both tests in that file seed from `Date.now()`, so the
isolated run walked a DIFFERENT sequence, which makes "passes in isolation" weaker evidence here than
for a deterministic spec. The stronger evidence is that the invariant is about a contextual ribbon
tab after a table delete, nothing in this pass touches ribbon or table code, and the failing walk ran
in the shared accumulating workbook after ~450 prior tests. **The observation itself is worth
keeping**: a contextual "Table Design" tab surviving the deletion of the last table is a real (if
cosmetic) stale-tab bug the monkey did its job by finding, and the monkeys' `Date.now()` seeding is
the reason it cannot simply be replayed — a seed env var would make findings like this actionable
instead of anecdotal.

**A macro run was thrown away rather than reported.** The first macro pass reported 9 failed / 13
passed / 35 did not run. The root was `macro-link-model.spec.ts:489`, whose native-dialog driver
(`answer-native-dialog.ps1`) returned non-zero; every failure after it was
`worker process exited unexpectedly (code=3221225794 = STATUS_DLL_INIT_FAILED)` — the Playwright
worker failing to start, not a test failing. Re-run cold and alone: **57 / 57**. Worth naming
separately: that spec still hard-codes an ABSOLUTE path into one agent session's scratchpad
(`.../claude/c--Dropbox-Projekt-Calcula/<session-uuid>/scratchpad/answer-native-dialog.ps1`) — the
identical defect §3ak found and vendored in `dirty-flag-close.spec.ts`, in a second spec that the
vendoring pass did not look at. It cannot run on another machine, or after this session's scratchpad
is cleaned.


### 3ax. §2x proved LIVE through the REAL UI — `undo-across-open.spec.ts`, the bytes under sabotage, and the three things writing it corrected (2026-08-10)

`document-store-leak.spec.ts` pins §2x at the STORE level: it drives `open_file`, `update_cell` and
`undo` as commands. That is the right test for the store, and it cannot see the thing the user meets.
The real File ▸ Open runs `fileOpen()`, which calls **`window.location.reload()`** after a successful
open — the frontend is rebuilt from scratch between the edit and the undo, and the whole question of
§2x is what the BACKEND still holds across that boundary. Five tests in
`app/e2e/journeys/undo-across-open.spec.ts` drive it end to end: the File menu, the **native file
picker** (driven from outside the WebView, the `image-ingress` technique — Tauri's IPC surface is
non-writable, so it cannot be stubbed), typing into the grid through the real inline editor, Ctrl+Z /
Ctrl+Y on the grid container, the **ribbon's own Undo and Redo buttons**, and File ▸ Save. The oracle
is the `.cala` on disk, parsed in the spec, THROWING on any parse failure.

| # | claim, as the user meets it | how it is proved | teeth |
|---|---|---|---|
| 1 | File ▸ Open, one Ctrl+Z, File ▸ Save — the archive holds the OPEN workbook's value | real menu + picker + typed edit + Ctrl+Z + Save; `calaText` on the saved bytes | the two fixtures are proved to DISAGREE in their bytes first, and the edit is proved to have made an undo entry; the ribbon button is then pressed as a second route and the archive re-read |
| 2 | undo still works INSIDE one document | typed edit, then the ribbon's Undo button; the restored value is read back out of the saved archive | the edit must be present and `undoDepth == 1` before the undo |
| 3 | the same question for REDO across File ▸ Open | a redo entry is built in ALPHA (edit + undo), then Open, then Ctrl+Y and the ribbon Redo | ALPHA's `canRedo` asserted true first, or the absence is vacuous |
| 4 | redo still works INSIDE one document | typed edit, undo, then the ribbon's Redo button; the redone value read from the archive | the undo must have taken first |
| 5 | the previous workbook's spill neither blocks nor deletes here | Open ALPHA (spilling `=SEQUENCE(4)`), Open BRAVO, type over a covered cell, then Delete AND overwrite the stale origin; surviving cells read from the archive | ALPHA's spill must really have spilled (`DB3` non-empty) before anything is asserted |

**THE SABOTAGE, on a running build.** `undo_stack` and the two spill `clear()`s commented out of
`reset_document_scoped_stores`, backend rebuilt, app relaunched cold. Tests 1, 2, 3 and 5 failed;
test 4 (redo inside one document) passed, which is the control. The messages, verbatim:

* *"the freshly-opened workbook offers an undo it has not earned (depth 3, "Edit cell (0, 105)")"*
* *"one Ctrl+Z after File > Open replaced the open workbook's cell with the PREVIOUS workbook's value.
  Expected "BRAVO-ORIGINAL" / Received "ALPHA-ORIGINAL""*
* *"the freshly-opened workbook offers a REDO it has not earned (depth 1)"* and Ctrl+Y produced
  `ZULU-EDITED-IN-ALPHA` — the other document's EDIT, in this document's cell
* *"Cannot edit cell (2, 106): it contains a spilled array value from cell (1, 106)"* — the refusal
  half, naming a formula in a workbook that is no longer open

**And the bytes, which is the part worth keeping.** With the sabotage in place, one Ctrl+Z after
File ▸ Open followed by File ▸ Save left `bravo.cala` on disk in this state, read with an independent
parser afterwards:

```
entries=6 bytes=3475
ALPHA-ORIGINAL:       PRESENT
BRAVO-ORIGINAL:       ABSENT
ZULU-EDITED-IN-ALPHA: ABSENT
```

The workbook the user had open no longer contains its own cell value **at all**; what is there instead
is a value from a document they closed. Source restored afterwards and verified **byte-identical by
SHA-256** (`10007ab1e9c05854392de879ac53c2dbabd3a38e37fffd5a232eeefd39ae1364`), then rebuilt cold: 5/5.

**THREE THINGS WRITING IT CORRECTED, all of them the register's own prose being wrong about the product.**

1. **The Undo affordance is never disabled — anywhere.** The first version asserted that the ribbon's
   Undo button is disabled on a freshly-opened document. It is not, and it never has been: the Home
   tab renders `undo`/`redo` as plain `<Button>`s with no binding to `get_undo_state`, and the Edit
   menu item has no enablement either. Nothing in `app/src` or `app/extensions` reads `canUndo` for a
   UI state at all. The assertion was caught because its counterpart ("enabled after a real edit")
   passed trivially — which is what a test asserting a property nothing implements looks like. The
   spec now presses the button and asserts what the press DOES, and the fact is written down where it
   was measured. **This is a real (small) product gap, not a defect of this fix: Excel greys Undo out
   with an empty stack, and here the user is invited to press it.**
2. **The Delete key does not reach the spill-removal branch.** `clear_range`, not `update_cell`. That
   correction is what turned up §2y, which is a live defect in one document with no File ▸ Open in it.
   Test 5 now performs both gestures.
3. **Fixture ORDER decides whether the spill test can run at all.** Building BRAVO *after* ALPHA fails
   during setup on a leaking build — the scaffolding's own `update_cell` is refused by the stale
   `spill_hosts` — which kills the test before the assertions and hides the deletion half. Fixtures
   are built before the leak is created, so the refusal fires where it is being asserted.

**One deliberate structural choice: the intermediate assertions are `expect.soft`, the archive ones are
hard.** A hard store-level assertion aborts a leaking build before the gesture runs, and the byte
oracle — the only place the damage is permanent — is never reached. The register records that this had
to be relaxed by hand last time to see the corruption; now it does not. Soft still fails the test.

**The spec is self-contained.** It writes its own dialog helper into `os.tmpdir()` at setup rather than
reaching into a session scratchpad — the defect §3ak found in `dirty-flag-close.spec.ts` and §3aw found
still living in `macro-link-model.spec.ts`.

## 4. OWNER DECISIONS — not work, product calls

**These are for the owner. Nothing in this section is a defect awaiting a fix; each is a choice
between defensible options, and each was deliberately NOT decided by the agents who found it.** They
are grouped because five of the seven are one family: they all ask "what should the product mean?",
not "is the product doing what it says?".

Each entry states the choice, what each option costs, and a recommendation. The recommendation is
advice, not a decision taken.

**DECIDED 2026-08-09:** the owner ruled on this section, under one standing rule — **"parity with
Excel should take priority always when there are such questions."**

**ALL SEVEN ARE IMPLEMENTED AND INTEGRATED — 2026-08-09.** D1–D7 landed from separate sessions and
were integrated in one pass: every unit suite re-run, every contract made to FAIL before being
trusted (§3ap). A decided entry keeps its heading and its options — the alternatives are what make the
decision legible — and gains a "what shipped" write-up.

| | decision | measurement that settled it |
|---|---|---|
| **D1** | F9 = workbook, Shift+F9 = active sheet; save recalculates the workbook | 40k chained formulas: workbook **365 ms** vs the old single-sheet F9's **523 ms** on identical work — one walk replacing two. 8×5 000 cross-sheet: sheet 92 ms / workbook 348 ms |
| **D2** | a typed formula keeps its NAME; repointing follows it | no cache, deliberately: a name-free workbook pays one `HashMap::is_empty()` per evaluated dependent |
| **D3** | pivot/table/relocation writes seed the ONE shared cascade | seeding beat the whole-sheet pass it replaced only after a no-formula/no-dependents gate: 12 500 cells **9.27 ms** gated vs 54.19 ms naive vs 15.98 ms whole-sheet |
| **D4** | play pill is viewport-pinned DOM chrome with a close control; Stop ≠ Unload | claims **no** grid region — read off the real `getGridRegions()` |
| **D5** | grid captures frame the canvas layer, not `[data-grid-area]` | crop is CSS that already existed: 1232x556 → **1218x542**, measured live; **40** goldens move, not the 11 estimated |
| **D6** | `cells: collapsePriority` 99 → 55 | demotion order `[10,20,30,40,50,55,60]` |
| **D7** | Excel's exact literals; `CellError::Parse` deleted | 9 variants round-trip `from_literal(as_literal(v)) == v`; **3 more `#{Debug}` sites found at integration** — §3ap contract (d) |

| **D8** | a structural edit recalculates: rewritten ASTs + moved FORMULA cells + one seed per affected column/row when a stripe reference exists, plus the cross-sheet and defined-name triggers | the register's own option 2 measured **628.08 ms** against **392.76 ms** for the whole-sheet pass (10 000-row insert) — D3's finding recurring; the chosen set is **303.29 ms** worst and **1.83 ms** typical. Option 1 was incomplete: `=ROW()` has no argument to rewrite |

**D8 was raised by the integration pass and is now CLOSED** (should a structural edit recalculate? —
§2s), found by sabotaging the census rather than by reading it, and settled by measuring rather than
by taking its own recommendation.

**D8's own integration pass (§3at) reproduced the measurement and then found the fix incomplete.**
The shared cascade it seeds knew nothing about hidden rows, so an insert re-derived
`=SUBTOTAL(109;A1:A5)` from 130 to **150 and stored it** — a wrong answer written over a right one,
in a gesture D8 itself had just made recalculate. Fixed as **§2v**. Every unit suite is green;
neither D8 nor §2v has been proved on a running app, and no E2E was run in that pass.

**ALL SEVEN ARE NOW PROVED ON A RUNNING APP — 2026-08-09.** Integration re-ran every unit suite; it
did not launch the product. `app/e2e/journeys/owner-decisions.spec.ts` drives each decision through
the real UI and reads the result off the rendered grid — **10 tests, 10 passing** — and doing so
found two defects nothing static had caught: **§2t** (a mixed-case name shouting after save/reload,
D2's own regression) and **§2u** (`remove_duplicates` deadlocking the whole backend on a leaked read
guard, which is what the "`vba-idioms-wave4` hangs" actually were). Both are fixed. See **§3as**.


### D1. Should "Calculate Workbook" calculate the workbook? (§2o) — **DECIDED AND SHIPPED 2026-08-09**

**THE OWNER'S DECISION, in the owner's words:** *"In Excel there is 'Calculate Now' that calculates
the workbook and 'Calculate Sheet' that calculates the sheet. We should do the same."* Parity with
Excel, which is the rule every open question here is now settled by.

**The choice, as it stood.** `calculate_now` collected formula cells from the ACTIVE-sheet mirror and
evaluated only those, while the Formulas menu called the item "Calculate Workbook". Measured with
iterative calculation on: six presses of F9 on Sheet1 moved a cross-sheet cycle **not at all**;
switching tabs and pressing F9 on each sheet was a real round, and the cycle then converged
15 → 17.5 → 18.75 → … → 19.999999702 after 25 rounds. The register recommended renaming first and
making it workbook-wide later, behind a benchmark. The owner chose Excel parity instead, and the
benchmark says the caution was misplaced — see the table.

#### What shipped

| | Excel | Calcula now |
|---|---|---|
| Workbook | Calculate Now — **F9** | `calculate_now` — **F9**, `Formulas > Calculate > Calculate Now` |
| Sheet | Calculate Sheet — **Shift+F9** | `calculate_sheet` — **Shift+F9**, `Formulas > Calculate > Calculate Sheet` |

`calculate_sheet` existed but delegated straight to `calculate_now`, on a comment reading *"for now,
calculate_sheet does the same as calculate_now since we have a single sheet"* — a comment older than
multi-sheet workbooks. The two commands are now genuinely different passes: one plain function,
`run_calculation_pass(CalcScope)`, with two arms.

**Shift+F9 is free.** The keybinding registry contains no `F9` binding of any kind (F9 is grid-owned,
in `useGridKeyboard.ts`, alongside F5/F11), and a sandboxed contribution may only claim
`Ctrl+Shift+<letter>` — so nothing could collide with it now or later.

#### ONE cascade, not a fourth walk

The workbook plan is **`workbook_circular_cells`' existing walk, made to return the topological order
it was already computing and throwing away.** The old F9 ran that walk (to find cross-sheet cycles)
*and* `partition_formula_cells` over the active sheet (to find an order). The workbook pass runs one
walk and gets both, over flat `Vec` adjacency instead of `HashMap`s, with formula strings **moved**
into the plan rather than cloned. Its Kahn residue *is* the cross-sheet cycle set, so the workbook
pass does not call the detector at all.

#### The benchmark — measured, not asserted

`bench_calculate_scopes` in `app/src-tauri/src/commands/calculate_scope_tests.rs`
(`cargo test --lib -- --ignored --nocapture bench_calculate_scopes`). **Debug build**, so the absolute
numbers are pessimistic and the ratios are the point. Median of three runs.

| Fixture | Shift+F9 (sheet) | F9 (workbook) | |
|---|---|---|---|
| **A. 1 sheet × 40,000 chained formulas** — both scopes evaluate the *same cells*, so the difference is the PLANNER alone | 40,000 cells — **523 ms** | 40,000 cells — **365 ms** | **F9 is ~30% FASTER than the old F9 on the same work** |
| **B. 8 sheets × 5,000 chained formulas**, chained end to end — the scope difference itself | 5,000 cells — **92 ms** | 40,000 cells — **348 ms** | 8× the cells for 3.8× the time |

Read fixture A carefully, because it is the answer to the question the register was worried about:
**making F9 workbook-wide did not make the ordinary single-sheet F9 slower — it made it faster**, by
removing the second traversal. The first cut of the planner (hash maps, cloned formulas) *was* 10%
slower than the old path; the flat-vector rewrite is what turned −10% into +30%, and both numbers are
in the run log rather than in an opinion. Fixture B is the honest cost: F9 on an 8-sheet workbook now
does eight sheets' work, which is what the command means.

#### Calculate-before-save: decided, not inherited

`save_file` calls `calculate_now`, so it inherited workbook scope automatically — that is exactly the
sort of consequential change that should not arrive by inheritance, so it was checked and **kept
deliberately**. Excel recalculates the workbook before saving; a saved file whose non-active sheets
are stale is the silent-staleness hazard `PendingRecalc` exists to make visible, and `.calp` publish
— which hard-refuses on a pending set — is downstream of this very file. Fixture B is the cost, and
paying it once per Ctrl+S is the right trade against shipping a report with a stale number in it.
Pinned by `calculate_before_save_recalculates_the_workbook`.

#### Was `mark_off_sheet_circular_cells` made redundant? — NO, and here is which half

The brief asked. The answer is **half**: F9 no longer needs it and no longer calls it (every member of
a cross-sheet cycle is in the workbook plan, so each is stamped on its own sheet by the ordinary
circular-group branch), but **Shift+F9 still needs it and still calls it**, because a sheet-scoped
pass genuinely does leave the other sheets unevaluated — which is precisely the `#CIRCULAR!`-here /
plausible-`0`-one-tab-away defect it was written for. It stays, moved into the `ActiveSheet` arm, with
both halves pinned (`f9_reports_a_cross_sheet_cycle_on_every_sheet_that_owns_a_member`,
`shift_f9_still_needs_the_off_sheet_mark`). Deleting it would restore the defect on one command.

#### Tests — run, not read

The pass body was extracted out of the `#[tauri::command]` into `run_calculation_pass`, **so that F9's
cross-sheet behaviour could stop being pinned by asserting on its source text.** Twelve tests in
`commands/calculate_scope_tests.rs`, each with teeth (the pre-state is asserted to be wrong before the
pass runs): a dependent on a non-active sheet, a THREE-sheet chain (a "neighbours of the active sheet"
fix would fail it), Shift+F9's non-reach, the cross-sheet iterative cycle converging in ONE press with
six sheet passes proved *not* to converge it first, no `#CIRCULAR!` under iteration, a cycle reported
on both sheets, the layered false-positive guard under both scopes, plan determinism across runs, and
the two wiring assertions.

#### Two judgement calls, flagged rather than buried

1. **The command returns the ACTIVE sheet's cells only.** Core applies only cells with no sheet index
   (an off-sheet value must never be painted onto the sheet on screen) and the frontend re-fetches the
   viewport on every sheet switch, so serialising every formula cell in the workbook on every F9 would
   be a cost with no reader. The off-sheet WRITES all happen. This also removes a latent bug: the F9
   handler emits a `cellEvent` for `updatedCells[0]`, which could previously be an off-sheet cell.
2. **`PendingRecalc` stays single-sheet.** A cancelled workbook pass spans sheets and the marker
   carries one `sheet_index`; it now records the sheet the pass stopped ON plus the **whole**
   remainder, so the status-bar count and the `.calp` publish refusal are both honest and the tail's
   per-cell sheet attribution is approximate. That is the right way round — over-reporting staleness
   is safe, under-reporting is the hazard — and no reader locates a pending cell by coordinate. Resume
   walks the PLAN (a workbook order is total, so the remainder is a suffix) rather than the marker.
   Widening the persisted marker to carry a sheet per cell is a `.cala` format change and was
   deliberately **not** bundled into this.

### D2. Should a typed formula keep its NAME? (§2p) — **DECIDED AND SHIPPED 2026-08-09**

**The choice.** `update_cell` resolves named references at ENTRY and stores the resolved reference.
Measured: with `RATE` pointing at `$D$5`, typing `=RATE` leaves the cell holding `$D$5`. The name is
not in the document, the formula bar shows `=$D$5`, and repointing `RATE` moves nothing. Excel keeps
the name. Formulas ▸ "Apply Names…" puts it back, after which everything §2i fixed works.

- **Keep the name at entry (Excel parity).** Names become live indirections, repointing a name moves
  every formula that uses it, and `apply_names_to_formulas` demotes from "the only way in" to the
  repair tool it is in Excel. Cost: every evaluation resolves through the name table; the whole
  named-range surface (rename, delete, scope) gains a dependency edge it does not have today.
- **Keep pre-resolving.** Cheaper to evaluate and is what the code has always done. Cost: names are
  a one-shot entry convenience, not a modelling tool — which is not what "named range" means to a
  spreadsheet user, and not what this register's own §2i prose assumed.

**Recommendation: Excel parity, but scoped and scheduled.** This is the one entry here whose current
behaviour will keep generating false conclusions, because every other layer's tests model the shape
`update_cell` never produces. If it is not going to change, the pre-resolution should be documented
at `update_cell` so the next author does not rediscover it from a failing live test.

---

**DECIDED 2026-08-09: Excel parity. BUILT.** The owner's words were "we should do exactly as in
Excel", and the standing rule is that Excel decides anything this brief does not.

#### What it does now

A typed formula stores the NAME. `RATE` = `$D$5`, typing `=RATE*100` leaves the cell holding
`RATE*100`; the formula bar shows it, the `.cala` saves it, and the expansion happens on the way into
the evaluator. Repointing `RATE` moves every formula that reads it, defining a name turns the
`#NAME?` cells that were waiting for it into numbers, and deleting one leaves `#NAME?` **with the
formula text intact** — Excel does not substitute the old definition back in and does not blank the
formula, and that behaviour now falls out of the storage rather than being coded for.

#### The design, in the order the decisions were forced

1. **The two ASTs are the same type.** `engine::Expression` is a re-export of `parser::ast::Expression`
   (`core/engine/src/dependency_extractor.rs:17`), and `convert_expr` is a clone plus wildcard-sheet
   expansion. Expanding a name at evaluation is therefore an AST **splice over an already-parsed
   tree**, not a re-parse — which is what made "resolve per evaluation" affordable and removed the
   need for a second, engine-level copy of `resolve_names_in_ast`. There is still exactly ONE name
   resolver.
2. **One recipe for entry, three callers.** `split_entered_formula` (`lib.rs`) returns
   `EnteredFormula { stored, expanded }`: `stored` is what the cell keeps, `expanded` is what this
   edit evaluates and what `extract_all_references` reads. `update_cell_impl`,
   `update_cells_batch_core` and `fill_range` all go through it, so the three cannot drift about what
   a name means. **Structured-table and spill references are still resolved at entry in both forms**,
   deliberately: `[@Price]` means a different cell on every row and `A1#` means whatever that spill
   covers right now, so neither can survive as text. Only names are deferred. The expansion re-runs
   the table pass, because a name's `refers_to` may itself be `=Table1[Amount]`.
3. **The dependency edge is the core of the work.** `AppState.name_dependents` /
   `name_dependencies` (`name_resolution.rs`), maintained beside the cell/column/row edges in all
   three entry paths and rebuilt by `rebuild_all_dependencies_from_grid`. Two subtleties:
   - edges are recorded for names that **do not exist yet**, because `=RATE` before `RATE` exists is
     a `#NAME?` cell and Excel turns it into a number the moment the name is defined;
   - LET/LAMBDA parameter names earn **no** edge — they are local bindings that shadow defined names,
     and registering `=LET(rate; 2; rate*10)` as a dependent of a workbook name called `rate` would
     recalculate a formula the name cannot reach.
4. **THE TRAP, and it is the one that would have shipped a stale-value bug.**
   `extract_references_recursive` cannot see through a `NamedRef` — a name has no coordinates to
   give. `rebuild_all_dependencies_from_grid` re-derives every cell edge from the STORED ASTs and
   runs on **every sheet switch and every structural undo**, so without expanding first it would have
   silently dropped `=RATE*B2`'s dependency on `$D$5`: the formula would have been right when typed
   and stopped following its precedent at the first tab click. It now expands before extracting.
   `name_tables` is passed IN at each call site (like `sheet_names` already was) rather than locked
   inside, so a caller holding one of those read guards cannot deadlock.
5. **A name change recalculates through the ONE cascade.** `recalc_after_name_change`
   (`named_ranges.rs`) is called by all four CRUD commands. Active-sheet readers seed
   `recalc_after_active_sheet_bulk_rewrite`; sheets that mention a changed name go through
   `recalc_after_off_sheet_write`. No new walk — the census's five entry points are untouched. It
   honours manual calculation mode explicitly, because only ONE of the two helpers does and half a
   recalculation is worse than none.
6. **`open_file` now rebuilds the dependency maps.** It cleared `dependents` with a comment saying
   they would be "rebuilt on recalculation" and nothing did until the first sheet switch. Harmless
   before; not harmless now, since `name_dependents` is the only thing that can answer "which cells
   read `RATE`" and a freshly opened workbook would have answered "none".

#### The cost decision, and why there is no cache

The gate is `needs_name_resolution`, which is allocation-free, short-circuiting, and **returns
immediately when the workbook has no defined names at all** — the dominant case pays one
`HashMap::is_empty()` per evaluated dependent. It asks the workbook's own name table rather than
answering "any `NamedRef` or any `Custom` call" the way `ast_has_named_refs` does, which is what keeps
`=LET(x;1;x+1)` and every JS-UDF formula on the borrowed path. A formula that actually names something
pays one tree clone per evaluation — the same order as the evaluation walk it feeds, and no parse.

A resolved-AST cache keyed by `(sheet_index, formula)` with a name-table generation counter was
designed and **deliberately not built**: an invalidation channel that can go stale is precisely the
defect class this change exists to close, and the measured shape does not need one. If a profile ever
says otherwise, that is the shape to add.

#### Tests changed, and the judgement on each

- `remaining-correctness.spec.ts` test 5 — its doc comment *asserted the defect* ("typing
  `=E2E_REMAINING_RATE` into G1 leaves the cell holding `$D$5`") and used Formulas ▸ "Apply Names…"
  as scaffolding to get a name into a formula at all. Rewritten: it now reads the stored formula
  **straight after typing** and requires it to be the name, and Apply Names stays as an
  **idempotence** check — a formula that already reads the name has no `$D$5` text left to match, so
  the command must leave it alone. Same teeth (111 → 222 → 111 on the stored value and on G1's
  pixels).
- No other test asserted the pre-resolved shape. The unit fixtures §2p complained about
  (`Cell::new_formula("=RATE*2")` written straight into the grid) model the shape `update_cell` now
  actually produces, so they became correct rather than broken.
- Added: `commands/d2_named_range_tests.rs` (19 tests) and `named_resolution`'s own module tests.
  Added `app/e2e/tests/named-ranges.spec.ts` "repointing a name moves the formulas that read it".

#### What was deliberately NOT done

- **Old workbooks are not migrated.** A `.cala` saved before this holds the pre-resolved reference.
  That file is *correct as stored* — it just is not live — and rewriting a user's formulas on load to
  guess which references "meant" a name is exactly the kind of silent edit this program exists to
  remove. "Apply Names…" is the migration, and it is the same one Excel offers.
- **Spill references reached through a name's definition** are not expanded at evaluation: that needs
  `state.spill_ranges`, a Mutex this would take once per evaluated dependent. Entry still resolves
  the spill refs a user typed directly, which is the only shape that has ever worked.
**CORRECTION, 2026-08-09 (the re-record pass).** Storing the name exposed a defect that pre-resolution
had made unreachable: a stored `NamedRef` does not survive save/reload unchanged, because the lexer
upper-cases bare identifiers and the AST renderer prints whatever the AST holds. `BudgetTotal`
reloads as `BUDGETTOTAL`. Evaluation is unaffected (every name lookup keys on `to_uppercase`), but
the user's formula is rewritten in capitals by saving and reopening, and the scenario suite's
save/reload oracle fires. Excel canonicalises a typed name to the DEFINED name's spelling rather than
preserving what was typed, so that is the shape of the fix. Full write-up and why it was not fixed at
4 a.m.: **§2t**.

- **The named-range UNDO arms keep `workbook_recalc`** rather than seeding from the new edge. The
  store-wide arm restores a whole map (the changed set is a symmetric difference, not one name), and
  the single-name arm runs while `apply_changes` holds the grid guards, where reporting a flag is how
  every restore hands work to the second lock phase. Whole-workbook is a superset of the right
  answer, so this is a cost decision and is now written as one — the two doc comments that claimed a
  name "is in no dependency map" were corrected, because that sentence is no longer true.

### D3. Who owns pivot and table recalculation? (§2m's census, `EXEMPT`) — **CLOSED 2026-08-09** (and HARDENED at integration — §3ap)

**Decided: all eight seed the ONE shared cascade.** The owner's standing rule is that Excel parity
decides any question this register does not, and Excel updates every one of these formulas. The
earlier recommendation ("close `relocate_cell_references` now, decide pivot/tables later") is
superseded. `EXEMPT` no longer contains an "IN CLASS" block.

The eight, and what each was leaving stale:

- **Pivot** — `create_pivot_inner`, `delete_pivot_table`, `undo_pivot_overwrite`. A formula over a
  freshly written pivot block kept the value of whatever the pivot overwrote; clearing a block left
  its readers showing the deleted pivot's totals.
- **Tables** — `toggle_totals_row`, `set_totals_row_function`, `set_calculated_column`,
  `check_table_auto_expand`.
- **`relocate_cell_references`** — re-evaluated the formulas it rewrote and cascaded to nothing.
  Done FIRST as the proving case: narrowest, and no refresh path of its own to defer to.

**The seam.** Each reaches the shared entry points by name — `recalc_after_active_sheet_bulk_rewrite`
for the active sheet, `recalc_after_off_sheet_write` for a destination sheet chosen at runtime — as a
SECOND lock phase after the command's own guards drop. No per-region refresh contract was created; a
second cascade concept is exactly what the census exists to prevent. The three pivot commands take
both branches, like `bi_insert_result` and `consolidate_data`, which write result blocks of the same
shape.

Two things deliberately were **not** wrapped in a local helper: the phase-B call is written out at
each of the four table call sites, because the census reads SOURCE and matches the entry point BY
NAME — a forwarding wrapper would silently blind it.

**A second defect found on the way.** The table commands wrote SUBTOTAL and calculated-column
formulas into the grid and registered **no dependency edges at all**. Two consequences: editing the
data underneath a totals row left the total frozen, and seeding could not reach a dependent along an
edge nobody had recorded. `register_table_formula_dependencies` now does what `update_cell_impl`
does — resolve structured refs, then record every edge kind. Seeding alone would not have delivered
parity here.

**A third defect, and the one worth reading — the totals row never worked at all.** Found live in
`tables.spec.ts`, not by reading. `set_totals_row_function` and `toggle_totals_row` wrote the cell
with `engine::Cell::new_formula`, which stores the RAW parse. But `reevaluate_formula_cell` evaluates
a cached AST directly and resolves only NAMES — the crate's standing contract is that a stored AST
already carries its structured-reference resolution, which is exactly what `update_cell_impl` and
`set_calculated_column` store. So the totals cell held an unresolved
`SUBTOTAL(109,Table1[Amount])` that the engine could never compute.

This was invisible for as long as the totals row was never asked for a value: it rendered blank, and
a blank totals row reads as "not configured yet". D3's cascade asked, and the answer came back **0**.
The fix is `write_table_formula_cell`, which stores the resolved form; the totals row now shows a
total, which is the entire point of the feature.

Note the shape of this: the seeding change did not *cause* a regression, it **exposed** a feature that
had never functioned. That is the argument for closing exemptions rather than parking them — an
exemption from recalculation also exempts a formula from ever being checked.

**Verified live in the running app**, not only in unit tests (probe against the real commands over
CDP, since all eight are `State`-taking commands):

| step | before | after |
|---|---|---|
| totals cell after `set_totals_row_function` | blank (uncomputable formula) | `300`, `=SUBTOTAL(109;$AG$22:$AG$23)` |
| formula outside the table reading the total | `0` | `600` |
| after editing the data underneath (200 → 1000) | total frozen | total `1100`, reader `2200` |

**One visual baseline was re-recorded**, with the reason stated as D5 requires:
`e2e/tests/__screenshots__/tables.spec.ts/grid-tables-totals-row-sum.png`. The old baseline was
recorded when the totals row rendered blank — it encoded the defect above, so leaving it would have
made the suite assert that the totals row shows nothing. `tables.spec.ts` is 4/4 after the
re-record.

**Cost — the measurement the hedge was about.** `cost_of_seeding_a_pivot_block_versus_a_whole_sheet_pass`
(`commands/d3_cascade_seed_tests.rs`, `#[ignore]`d; run with `--ignored --nocapture`). Debug profile,
so read the RATIOS, not the absolute milliseconds. "whole sheet" is
`finalize_pivot_update` → `recalculate_sheet_formulas`, which every *other* pivot mutation already
runs — that is the honest comparison, not "free".

| block | cells | readers | seed, naive | seed, gated | whole sheet |
|---|---|---|---|---|---|
| 20×5 | 100 | 50 | 0.76 ms | **0.75 ms** | 1.69 ms |
| 100×10 | 1 000 | 100 | 5.32 ms | **1.88 ms** | 3.61 ms |
| 200×25 | 5 000 | 200 | 22.59 ms | **4.39 ms** | 7.42 ms |
| 500×25 | 12 500 | 400 | 54.19 ms | **9.84 ms** | 15.57 ms |

The "seed, naive" and "seed, gated" columns come from separate runs, so the whole-sheet column moves
with ordinary run-to-run variance (15–23 ms at the largest size); compare within a run, not across.

The naive column is the real finding, and it contradicted the assumption this entry was written on:
seeding a large block was **worse** than the whole-sheet pass it was meant to improve on — 54.19 ms
against 22.75 ms for the whole sheet in that same run, at 12 500 cells. A pivot block is 12 500
*literals*; `recalc_order_from_seeds` admitted every one as a graph member, the evaluation loop
cloned each only to find it had no formula, and the cross-sheet walk allocated a sheet-name String
per root.

The gate that fixes it is in `recalc_after_active_sheet_bulk_rewrite`, not in pivot code: **a seed
that holds no formula and has no dependents provably contributes nothing** — it would be admitted as
a member, skipped for having no formula, and expanded from to nothing. Dropping those makes the cost
proportional to the number of READERS instead of the size of the block, and it benefits every caller
of the shared entry point, not just pivots. Seeding is now cheaper than the whole-sheet pass at every
size measured, so no exemption is justified on cost.

**Tests.** `commands/d3_cascade_seed_tests.rs` — 14 tests. Each removal is matched by a behavioural
test (the dependent MOVES, with the stale value asserted as a precondition so the test cannot pass
against the broken code) plus a source-wiring test (the command still calls the entry point). All
eight are `State`-taking commands and cannot run in-process, so this is the same two-part split the
`sort_range` and `clear_range` tests use.

**The census kept its teeth.** Verified by hand as asked — the recalc call was removed from
`relocate_cell_references`, and the census failed naming exactly
`commands/structure.rs::relocate_cell_references`; then restored. That check is now permanent rather
than folkloric: `the_census_detector_actually_fires_on_a_cell_writer_that_does_not_recalculate` runs
the detector over synthetic source and asserts it fires with the recalc call absent and stays quiet
with it present, and `every_exemption_carries_a_written_reason` fails any entry parked with an empty
reason.

**Residual, worth its own entry.** `recalculate_sheet_formulas` — the recalculation the pivot module
runs on every mutation that is *not* one of these eight — evaluates the **active sheet only**. A
pivot written to a non-active sheet, and any cross-sheet reader of a refreshed pivot, is still stale
on those paths. The eight fixed here take the off-sheet branch correctly; the pivot refresh path does
not, and it is the larger surface.

### D4. Where should the Animation play pill live? (§2q) — **DECIDED AND SHIPPED 2026-08-09**

**The owner's call: viewport-pin it with a close affordance, and add the `clearDriver` product route
regardless of the layout question.** Both halves shipped. The register's own summary of what was
never in doubt turned out to be the right ordering of the work: the layout was the visible problem,
the missing route was the real one.

#### What shipped

The pill is no longer a grid object at all. It was a `GridRegion` with `floating: {x: 8, y: 8}` —
sheet coordinates — registered through `registerGridOverlay` with a `hitTest`, which is exactly what
made it a click thief: it was *in the list the grid hit-tests*. It is now a DOM overlay registered
through `@api/ui`'s overlay registry (the same route AutoFilter's dropdown and CellBookmarks'
editors use), rendered by `OverlayContainer` at the Layout root, `position: fixed`, and it registers
no grid region whatsoever.

- **`overlay/PlayPill.tsx`** — the control: play/pause, progress, frame counter, **close**.
- **`overlay/pillGeometry.ts`** — where it sits, as a pure function, so the placement is testable
  without a layout engine.
- **`overlay/playOverlay.ts`** — install/remove; shows and hides the overlay from the engine's own
  `frameCount > 0`, exactly as before.

**Bottom-left of the GRID CANVAS, not of the window** — and the distinction is the part that matters.
Measuring from the live canvas rect (`getGridCanvas()` off the feature-neutral `@api/rendering`
facade, plus a `ResizeObserver` on it) is what keeps it from fighting the panel/layout system:
opening the sidebar, the task pane or collapsing the ribbon resizes the canvas, and the pill follows
it instead of sitting on top of whatever the layout put there. A window-relative `position: fixed`
would have traded a collision with the cells for a collision with the chrome.

**Why bottom-left, given the owner's Excel-parity rule.** Excel does not settle this: it has no
playback transport, so there is no Excel behaviour to copy. The next authority is the house/Office
convention for transient document chrome — bottom-left, where Word's focus-mode and PowerPoint's
slideshow transports live — and the negative constraint, which is stronger than the positive one:
the top-left corner is the *worst* available position in a spreadsheet, because A1 is where every
workbook starts and where every user clicks first. z-index 90: above the canvas, below the
scrollbars, the task pane, menus and dialogs. Chrome the user did not ask for must never cover
chrome they did.

#### The half that mattered more: three routes to unload a driver, where there were none

`clearDriver` existed and had no caller. A user who loaded a driver could not give it back without
reloading the app — the pill stayed, the status-bar transport stayed, and the engine kept a driver
bound to cells the user might since have repurposed. Now:

1. **The pill's close control.** The natural one, and the one the E2E cleanup drives.
2. **An "Unload" button in the panel transport**, next to Stop — *where drivers are managed*.
3. **Document boundaries.** `BEFORE_OPEN` / `BEFORE_NEW` / `BEFORE_CLOSE` now call `clearDriver`
   instead of `stopAndRestore`.

**`clearDriver` is a strict superset of `stopAndRestore`** — `setDriver(null)` calls `stop()` first,
which restores the model — so the transient guarantee is unchanged by all three. Nothing about the
transient-write pattern was touched: frames still go through `anim_apply_frame` under a filed
`anim_snapshot` token, which is what makes the no-dirty exemption checkable rather than remembered.

**Judgement call, flagged: (3) is a behaviour change the brief did not ask for, and it is the right
one.** A driver is bound to the cells, charts or scenarios of the workbook it was configured
against; carrying it into a *different document* leaves a transport pointing at coordinates that now
mean something else. Excel parity decides it in the direction I took: File ▸ New gives a clean
workbook with nothing carried over. `BEFORE_SAVE` and `SHEET_CHANGED` deliberately still only
**stop** — same workbook, same intent, and a user who saves mid-iteration wants to press Play again.

**And the genuinely debatable part, decided: "Stop" does NOT unload.** The register named this as the
open question, and the answer is the one it guessed — a user mid-iteration wants the driver kept.
Stop and Unload are therefore two buttons, not one, and an E2E test pins the difference in both
directions rather than just asserting the new one works.

#### The E2E surface: what was removed, and why that is the finding

**`__CALCULA_ANIMATION__` is deleted.** Two spec files reached `clearDriver` through it; both now
click the pill's close control. The handle's own comment said it should go when the product grew a
route, and it has.

The general lesson is worth more than the deletion, and it is recorded at §3b as well: **that handle
was the test surface compensating for a missing feature.** The cleanup needed to reach something *no
user could reach*, and rather than reading that as a defect, the suite published a back door and
carried on. Before publishing a handle so a test can reach live state, ask whether a user can reach
the same thing. If not, the missing route is the bug — and here it was the bug that cost eighty-nine
spec files.

#### Tests — made to fail before being trusted

Vitest, `extensions/Animation/overlay/__tests__/`:

- **`claims no grid region — a loaded driver adds nothing the grid hit-tests`**, read off the REAL
  `getGridRegions()` registry, not a mock. A mock could only prove that a function nobody calls was
  not called. Verified with teeth: re-adding an `addGridRegions` call fails it (`expected 2, got 3`).
- **`the close affordance unloads the driver and the pill disappears`** — click only; nothing else in
  the test touches the engine, because calling `clearDriver` "to settle it" is exactly the vacuous
  pass §3ak caught. Verified with teeth: stubbing the handler out fails it (`expected 11 to be 0`).
- The pill is `position: fixed`; it renders nothing with no driver; the toggle plays/pauses and does
  NOT unload; `pillPosition` pins to the canvas corner, falls back to the window when no grid is
  mounted, and never goes negative.

Playwright, `e2e/tests/animation.spec.ts` — three new tests, replacing a window handle with product
paths:

- **`the play pill claims no cell — with a driver loaded, a click at A1 still selects A1`.** Asserted
  the way the defect actually presented: the selection moves to A1 **and** playback does not start.
  Checking only the selection would pass on a pill that stopped stealing the click while still
  starting an animation underneath it. The selection is parked at D5 first so "A1" cannot be residue.
- **`the pill's close control stops playback, restores the model, and unloads the driver`**, clicked
  **mid-playback** — the hardest case for the restore guarantee.
- **`panel: Stop keeps the driver, Unload gives it back`** — the distinction above, both directions.

#### Verification

`npx vitest run extensions/Animation` — **12 files / 58 passed**. `check-types` clean for these files
(the two `InlineEditor.tsx` `releaseOpenWindow` errors on HEAD are another agent's in-flight work).
`lint:boundaries` clean. `eslint extensions/Animation/overlay` clean. `check:line-endings` 0 mixed.

**E2E was NOT run** — the three new specs are written but unrun, for the same reason D1 gave: other
agents were editing `app/src-tauri` through this window and a run would have been both disrupted by
and disruptive to them. Nothing in this change touches Rust. The browser-only visual smoke (vite +
Playwright + the `__TAURI_INTERNALS__` stub) was attempted as a substitute and **could not run on
this machine**: Playwright's bundled Chromium gets `net::ERR_ABORTED` on every loopback navigation to
the dev server, on `localhost`, `[::1]` and `127.0.0.1` alike, with and without `--no-proxy-server`,
while `curl` against the same URL returns 200. That is an environment block, not a finding about the
pill — but it is recorded so the next person does not spend the same thirty minutes. **So the pill's
rendered appearance is the one thing here that is asserted rather than seen**; its behaviour is
covered by a real React render (`position: fixed`, close → no driver) and its placement by the pure
geometry tests.

### D5. The eleven scrollbar-thumb goldens (§3a) — **CLOSED 2026-08-09, verified on a live app**

**Decided: exclude the scrollbars from grid captures, structurally, in the helper.** Eleven grid
goldens differed from their baseline by nothing but a scrollbar thumb. The thumb is a function of the
USED RANGE, and the used range is shared state the suite leaks between specs on purpose — fixtures
are parked in far columns to avoid colliding (`status-bar` at R:S, `edge-cases` at AE:AH, `scrolling`
at row 5000), the data is off-screen and irrelevant to the shot, and the thumb it sets is not. Both
candidate fixes re-recorded baselines, so the real choice was **"once, structurally" versus "once,
per spec, forever"**.

**The change, in one place.** `takeGridScreenshot` framed `[data-grid-area]`, which contains the
canvas layer PLUS the two scrollbars and the corner box. It now frames `[data-grid-canvas-layer]` —
a new DO-NOT-BREAK attribute on `S.CanvasLayer` (Spreadsheet.tsx), the element that is inset by
`SCROLLBAR_SIZE` right and bottom **by definition** in `Spreadsheet.styles.ts`. No arithmetic in the
helper, no measurement: the exclusion is the CSS that already existed. If the attribute ever
disappears the helper falls back to the old framing and says so on stderr, because a silent fallback
here is how eleven goldens would quietly need re-recording again.

**Nothing else was in that strip.** `GridArea`'s only children are the canvas layer, the scrollbars
and the corner box; headers, frozen panes, the grouping outline bar and the inline editor are all
inside the canvas layer, which is `overflow: hidden`. `takeGridRegionScreenshot` already anchored on
the canvas and did not move.

**No capture legitimately needed the scrollbars — checked, not assumed.** `scrolling.spec.ts` is the
only plausible claimant; its four goldens assert that the VISIBLE ROWS changed, and each already
carries that proof in the row headers and cell contents. Nothing in either suite asserts scrollbar
geometry, and a thumb photographed as a side effect is coverage nobody chose and nobody can
interpret when it fails. If it deserves coverage it deserves a test that names the used range it
expects, rather than inheriting one.

**THE RE-RECORD IS 40 GOLDENS, NOT ELEVEN — the earlier cost estimate above was wrong.** Cropping
changes the IMAGE SIZE (1232x556 → 1218x542, measured on the live app), so every golden produced by
`takeGridScreenshot` must be re-recorded, not only the eleven that were failing. The estimate said
"both fixing options re-record the same eleven"; that is true of reset-before-capture and false of
this one. Masking instead of cropping would not have helped — it repaints the same 40. The list, by
spec: `scrolling` 4, `dimensions` 6, `grid-rendering` 5, `paste-special` 2, `protection` 2,
`go-to-special` 1, `evaluate-formula` 2, `core-visual` 8, `workflow-visual` 10. Region captures
(`tables-*`, `notes-*`, `comments-*`, `go-to-special-formulas-sheet`) and window checkpoints are
unaffected. It is one mechanical pass and then the class is gone; the decision stands, but whoever
runs the re-record should expect 40.

**The marching ants were settled too, and this is the part that a re-record could NOT have fixed.**
`screenshotGates.ts` named the marching-ants copy border as the only non-deterministic element in
either suite (77 px of noise over two cold runs of all 76 captures). Its dash phase is advanced by
wall-clock delta in a `requestAnimationFrame` loop, so re-recording just picks a different phase —
which is why `paste-special` was the one spec whose failures survived a re-record.

The fix is not a test hook. `document.documentElement.dataset.reducedMotion` is the app's OWN
accessibility switch: `skinLoader.apply()` stamps it from the OS `prefers-reduced-motion` query or
the Settings > Appearance toggle. **Nothing read it** — the toggle was inert, and the marching ants
are the one piece of motion in the product that never stops on its own, i.e. exactly what a user
asking for reduced motion is asking to be rid of. `GridCanvas` is now its first consumer: the dashed
border is still drawn (reduced motion removes the MOTION, not the information) with the dash phase
parked at 0, and no frame is scheduled for it. The flag is re-read PER FRAME so that switching it on
stops a marquee that is already marching, instead of at the next copy. `waitForGridStable` — the one
function every capture path already awaits — turns it on, which is the same declaration
`animations: "disabled"` makes for CSS and cannot make for a canvas.

**Verified live, twice, cold.** Two independent runs of `paste-special.spec.ts` against a freshly
launched app produced a `grid-paste-special-values-result` capture that was **byte-identical**
(sha256 `93589669ad446e1c…`, second run confirmed by mtime), at 1218x542 with no scrollbars in frame.
That capture is the one the register had recorded as unphotographable.

**The gate numbers deliberately did NOT move.** The 77 px in `screenshotGates.ts` is a measured noise
CEILING across 76 captures. Tightening `maxDiffPixels` to suit the new situation would be re-deriving
a measured constant from an argument; the note now says so, and says what to re-measure.

### D6. `cells: collapsePriority` is an accidental 99 (§2a) — **DECIDED AND SHIPPED 2026-08-09**

**THE OWNER'S DECISION: 55.** Excel's Home tab sheds groups in a fixed order as the window narrows,
and Cells is not the last thing standing; 55 puts it where Excel puts it, between Styles (50) and
Editing (60). Parity with Excel, the standing rule for this section.

**The choice, as it stood.** The value was not considered — it was the fallback a missing
`GROUP_ORDER` row produced, and it made the Cells group demote LAST on a narrow ribbon. The earlier
work had already folded the two ex-lookup-tables into `DEFAULT_LAYOUT`, so this was one number in one
default object, exactly as the brief required: no second lookup table was reintroduced.

**What shipped.** `app/extensions/BuiltIn/HomeTab/homeTabConfig.ts`, `DEFAULT_LAYOUT.groups`, the
`cells` group: `collapsePriority: 99` → `55`, and the comment rewritten from "left as-is, it is a
product call" to the decision and its reason. Three assertions moved with it — the priority table in
`homeTabLayout.test.ts`, the demotion order in `homeTabSections.test.tsx`
(`[10, 20, 30, 40, 50, 55, 60]`, which is literally the order groups become launchers), and the
pre-version migration fill, which takes the number from the shipped default.

`DEFAULT_COLLAPSE_PRIORITY` (99) is unchanged and still applies to groups the USER creates in the
Customize dialog: a group someone added by hand should survive the squeeze longest, because the app
cannot know how important it is. That was never the accident; the accident was `cells` silently
inheriting it.

### D7. The app/engine error-spelling divergence (§2n, extended) — **CLOSED 2026-08-09**

**Decided: adopt the canonical literals everywhere, with Excel as the reference — and delete
`Parse`.** The app-side `cell_error_display` listed four variants explicitly and sent the other six
to `format!("#{:?}", e).to_uppercase()`, i.e. the Rust variant NAME. It is now a one-line forwarder
to `CellError::as_literal`. There is no `#{Debug}` arm left anywhere in the product.

| variant | grid painted | now | why |
|---|---|---|---|
| `Div0` | `#DIV0` | `#DIV/0!` | Excel |
| `Ref` | `#REF` | `#REF!` | Excel |
| `Name` | `#NAME` | `#NAME?` | Excel |
| `Value` | `#VALUE` | `#VALUE!` | Excel |
| `NA` | `#N/A` | `#N/A` | Excel — no trailing punctuation, checked rather than "corrected" |
| `Circular` | `#CIRCULAR` | `#CIRCULAR!` | no Excel counterpart; Excel's punctuation |
| `Conflict` | `#CONFLICT` | `#CONFLICT!` | as above — it was the one literal with no terminal mark |
| `Blocked` | `#BLOCKED!` | `#BLOCKED!` | unchanged |
| `Limit` | `#LIMIT!` | `#LIMIT!` | unchanged |
| `Parse` | `#PARSE` | — | **variant deleted** |

`#NULL!` and `#NUM!` are Excel errors with **no engine variant**; they were left absent rather than
aliased onto a variant that exists, and `cellFormatting.ts` still recognises them because they arrive
by xlsx import.

**`Parse` was deleted, not respelled.** Excel has no unparseable-formula STATE — an invalid formula
is refused at entry or lands as `#NAME?` — and neither does Calcula: `CellError::Parse` is
constructed **nowhere in the product**. `Cell::new_formula` stores an unparseable formula as TEXT,
and the evaluate-formula and script surfaces answer with the string `#SYNTAX!`. The variant existed
only to be rendered as an internal enum name that no other layer could parse back, and to be the one
error that changed meaning on reload (it shared `#VALUE!` outbound and read back as `Value`). Giving
a spelling to a state that cannot occur would have preserved the dead branch; deleting it removes the
class. If the engine ever needs the state, `#SYNTAX!` is already the product's word for it.

**A SECOND DEFECT, and it is the one that mattered.** The divergence was not cosmetic: it stopped the
grid from rendering those cells as errors at all. `isErrorValue`
(`gridRenderer/styles/cellFormatting.ts`) matches against the CANONICAL literals, and `#DIV0` does
not start with `#DIV/0!` — so a division-by-zero cell was painted as ORDINARY LEFT-ALIGNED BLACK
TEXT, indistinguishable from a string the user typed, while a `#DIV/0!` cell imported from xlsx a row
above was painted red and centred. Only `#NAME` matched, by accident (`#NAME?` minus its `?`). That
is precisely the failure `CELL_ERROR_LITERALS`' own doc comment warns about, arriving from the other
side of the boundary.

**Round-trip verified, not assumed.** `as_literal`/`from_literal` remain the single authority; a new
test (`every_error_literal_survives_a_save_and_reload`) asserts `from_literal(as_literal(v)) == v`
for every variant, which `#CONFLICT!` — the one literal that moved — is exactly the shape of change
to break. Persistence writes `as_literal` (`persistence/src/lib.rs`, `calp_commands.rs`), so `.cala`
and `.calp` follow for free; `calcula-format`'s round-trip test now covers all nine variants with no
exception, because there is no longer one. Pre-change workbooks holding the string `#CONFLICT` reload
as `#VALUE!`; under the project's no-backward-compatibility rule that is accepted, and `Conflict` is
an in-session UI-effect collision that is recomputed rather than authored.

**The pinned constraint held.** `Limit`, `Blocked`, `Conflict` and `NA` had to keep exact literals or
the frontend's `normalizeCellErrorLiteral` collapses them to `#VALUE!`. With no Debug arm there is
nothing to fall through to, but the requirement outlives the implementation, so the test still pins
all four by name. A further test asserts no literal equals its own `#{Debug}` spelling — the reusable
mistake, stated directly.

**Goldens this moves: none directly; the residue case is real.** No golden in either suite
deliberately paints an error cell (checked: none of the nine specs that call `takeGridScreenshot`
writes an error-producing formula). The exposure is residue — `edge-cases` leaves two circular cells
at AH1:AH2 in the viewport `evaluate-formula` shoots, which now paint `#CIRCULAR!` in red and centred
instead of `#CIRCULAR` in black. D5 re-records all 40 grid goldens anyway, so this is folded in.

**Also updated:** `remaining-correctness.spec.ts` test 2 asserted the exact string `#CIRCULAR`, with a
doc comment recording the divergence as measured product behaviour; it now asserts `#CIRCULAR!` and
the comment records the closure. **Both cycle tests were run live against the app and pass.**
`udf-evaluation`'s `toContain("#NAME")` is satisfied by `#NAME?` either way. Three stale comments
that claimed a divergence which no longer exists (`formula.rs` ×2, `scripting/udf.rs`) were
corrected rather than left to invite someone to "restore" a symmetry.

**CORRECTION, 2026-08-09 (integration).** This entry claimed "no `#{Debug}` arm remains anywhere".
**Three remained** — `Grid::get_cell_display_value` (Find/Replace), `format_value_for_ai` (the AI
context serializer) and `saved_value_display` (the published `.calp` HTML report, which was emitting
`##DIV/0!` with a doubled hash). Two of the three were made WORSE by this decision, not by accident
but by construction: they had been quietly agreeing with the *wrong* spelling, so pointing the grid at
`as_literal` turned a consistent error into a visible divergence — Find stopped matching the text the
grid paints. All three are fixed, each with a test written to fail first; see §3ap contract (d). The
lesson is the one `as_literal`'s own doc comment now carries: "the last one" is a claim that has to be
grepped for, not remembered.


### D8. Should a structural edit recalculate? (§2s) — **CLOSED 2026-08-09.** Yes, through the shared entry points, on a seed set neither of the register's own options got right

**THE ANSWER: yes, and the register's recommended seed set was wrong.** Option 1 (seed only the
formula cells whose AST was rewritten) is INCOMPLETE, and option 2 (seed every moved cell) is SLOWER
than the whole-sheet pass it would replace. What shipped is neither: rewritten ASTs, plus every moved
FORMULA cell, plus — only when the sheet actually holds a whole-column or whole-row reference — one
seed per affected column and row. Plus two off-coordinate triggers the cascade cannot express.

**THE STALENESS SURFACE, MEASURED.** `probe`s over one of every position- and shape-sensitive formula
in the function set, with the oracle being "whatever LOADING this document would produce"
(`assert_settled` re-evaluates every sheet and reports every cell whose value moves). Not a list of
expected numbers: the question was precisely *which* formulas go stale, and a hand-written
expectation can only confirm the ones somebody already thought of.

| formula | row insert | row delete | col insert | col delete | reached by |
|---|---|---|---|---|---|
| `=ROWS(A1:A5)` | **stale** 5→6 | **stale** 5→4 | — | — | rewritten AST |
| `=COLUMNS(A1:C1)` | — | — | **stale** 3→4 | **stale** 3→2 | rewritten AST |
| `=COUNTA(A1:A5)` | **stale** 5→6 | (deleted) | — | — | rewritten AST |
| `=SUM(A1:A5)` / `SUBTOTAL` / `AGGREGATE` | — (blank row adds 0) | **stale** 150→120 | — | — | rewritten AST |
| `=ROW(A5)` / `=CELL("address";A5)` | **stale** | **stale** | — | — | rewritten AST |
| **`=ROW()` / `=COLUMN()`** | **stale** 8→9 | **stale** 8→7 | **stale** 3→4 | **stale** 3→2 | **MOVED cell — option 1 misses it** |
| **`=ADDRESS(ROW();COLUMN())`** | **stale** `$C$11`→`$C$12` | **stale** | **stale** | **stale** | **MOVED cell** |
| **`=SUM(A:A)` / `=COUNTA(A:A)`** | — | **stale** 150→120 | — | — | **column dependents of a moved/deleted cell** |
| **`=SUM(1:1)`** | **stale** | **stale** | — | **stale** 16→15 | **row dependents of a moved/deleted cell** |
| **`=ROWS(DATA)`** (defined name) | **stale** 5→6 | not measured | not measured | not measured | **`name_dependents` — no coordinate seed reaches it** |
| **`Sheet2!B1 = ROWS(Sheet1!A1:A5)`** | **stale** 5→6 | **stale** 5→4 | — | — | **another sheet — no active-sheet seed reaches it** |
| `=CELL("row")` (no ref) | — | — | — | — | not position-sensitive in this engine |
| `=OFFSET(A5;0;0)` | — | — | — | — | follows its rewritten base |
| `=COUNTBLANK(A1:A5)` | — | — | — | — | §2s guessed this one; it does not move |

Totals over the shape-sensitive fixture, before the fix: **7 stale on a row insert, 11 on a row
delete, 4 on a column insert, 5 on a column delete**. After: **0** in every case.

**§2s's own list was wrong in both directions.** It named `COUNTBLANK`, `OFFSET` and `CELL("row")`,
none of which goes stale here, and it did not name `=ROW()`, `=SUM(A:A)`, a defined name or a
cross-sheet reader — the four that break its recommended fix. That is the whole argument for
measuring: the list you write from reading is not the list.

**THE COST.** `d8_cost_of_recalculating_a_structural_edit` (`commands/d8_structural_recalc_tests.rs`,
`#[ignore]`d; run with `--ignored --nocapture`). Debug profile, so read the RATIOS. Fixture: a tall
sheet at realistic density — 5 literal columns, 3 formula columns with own-row references and a
second hop, one `=ROW()` column, and three whole-range aggregates at the top. Every candidate is
timed against the SAME settled post-edit state, so the columns differ only by their seed set.
"worst" inserts at the top of the data (everything moves; also the COMMON gesture); "typical" inserts
50 rows from the bottom.

| case | rows | command total | of which NOT recalc | opt 1 (rewritten) | +moved formulas | **CHOSEN** | opt 2 (every moved cell) | whole-sheet pass | seeds |
|---|---|---|---|---|---|---|---|---|---|
| worst | 2 000 | 180.29 ms | 119.27 ms | 38.92 ms | 48.87 ms | **61.02 ms** | 115.58 ms | 69.10 ms | 6 009 |
| typical | 2 000 | 75.51 ms | 73.92 ms | 1.49 ms | 1.59 ms | **1.59 ms** | 3.12 ms | 68.54 ms | 159 |
| worst | 10 000 | 935.83 ms | 632.54 ms | 220.08 ms | 291.06 ms | **303.29 ms** | 628.08 ms | 392.76 ms | 30 009 |
| typical | 10 000 | 358.80 ms | 356.97 ms | 2.11 ms | 1.84 ms | **1.83 ms** | 3.25 ms | 367.40 ms | 159 |

**D3'S FINDING RECURRED, EXACTLY.** The register's option 2 — seed every moved cell — measured
**628.08 ms against 392.76 ms for the whole-sheet pass** at 10 000 rows. Worse than the thing it
replaces, which is what D3 measured for a naive pivot seeding. And D3's no-formula/no-dependents gate
does NOT save it this time, which is the part worth keeping: that gate drops a seed that holds no
formula AND has no dependents, and a moved literal in a real workbook usually IS read by something.
It passes the gate, is admitted as a graph member, and is then skipped by the evaluation loop for
having no formula — 12 500 pivot literals were unread, 90 000 moved spreadsheet cells are not.

**The chosen set beats the whole-sheet pass at every size** (61 vs 69, 303 vs 393 worst; 1.6 vs 69,
1.8 vs 367 typical) and beats option 2 by 2x. In the TYPICAL case recalculation is **0.5% of the
command** — the command's own whole-grid result payload dominates by two orders of magnitude — so the
frequent gesture pays essentially nothing.

**MEASURED IN THE LIVE APP TOO, A/B, 2026-08-09 (§3au).** The table above is a Rust micro-benchmark;
the question a user asks is what the GESTURE costs. Same running debug build, timed from the
frontend around `tauri-api.insertRows` (so the number includes IPC and the command's whole-grid reply),
median of 5, once with D8's seeding live and once with `StructuralSeeds::finish` returning empty:

| sheet | gesture | no seeding | **with D8** | delta |
|---|---|---|---|---|
| empty | insert at top | 9.2 ms | **11.0 ms** | +1.8 ms |
| 2 000 x 9, 8 000 formulas | insert at TOP (worst) | 219.4 ms | **319.4 ms** | +100 ms |
| 2 000 x 9, 8 000 formulas | insert near BOTTOM (typical) | 181.7 ms | **189.9 ms** | +8 ms |
| 2 000 x 9, 8 000 formulas | delete at TOP | 223.4 ms | **325.0 ms** | +102 ms |

So on an ordinary sheet the gesture is unchanged, and on a formula-dense 2 000-row sheet the
full-height insert pays ~100 ms — in a DEBUG build, where the un-seeded baseline is already ~220 ms
for reasons that have nothing to do with recalculation. It does not read as a stall in the app. The
honest summary is that D8 is free where the gesture is common and visible only at the worst case on a
large sheet, which is the trade the measurement was run to price.

> **CORRECTED AT INTEGRATION (§3at).** This paragraph originally ended "it costs ~25–55% more than
> the incomplete option 1, which is the price of `=ROW()` being right". Two independent re-runs say
> that is only true against BARE option 1. Against option 1 PLUS moved formulas — the honest
> comparison, since that is the smallest COMPLETE seed set — the chosen set is inside the noise
> (289.40 vs 302.41 ms one run, 310.06 vs 308.02 ms the next). Everything else in this table
> reproduced, including the load-bearing 625–637 vs 392–394 for option 2, and the seed counts to the
> digit. A debug-profile timing carries about ±20% here; single-run differences smaller than that are
> not results.

**WHAT SHIPPED.**

1. `StructuralSeeds` (`commands/structure.rs`) accumulates seeds in the loops each command ALREADY
   runs — no fourth walk. Three kinds, all in POST-edit coordinates: rewritten ASTs; every moved
   FORMULA cell; and one seed per affected COLUMN and ROW, emitted only when `column_dependents` /
   `row_dependents` are non-empty. That last gate is what keeps a whole-column reference from costing
   the blast radius: the stripe maps are already locked by the command, so asking is free, and in a
   workbook with no stripe reference kind 3 emits nothing at all.
2. `recalc_structural_side_effects` runs the two triggers a `(row, col)` seed cannot express, through
   entry points that already exist: `recalc_after_off_sheet_write` for the sheets
   `shift_cross_sheet_formulas` actually re-pointed, and `recalc_after_name_change` for the names
   `shift_named_ranges` actually re-pointed. Both helpers now RETURN what they changed instead of
   dropping it. Manual calculation mode is gated here, for the reason `recalc_after_name_change`
   already records: only one of the two honours the mode, and half a recalculation is worse than
   none.
3. The OFF-SHEET structural edit had the same two holes and now closes them the same way: its sheet
   list is the edited sheet PLUS every cross-sheet-rewritten sheet (a rewritten THIRD sheet was
   previously never re-evaluated), and it calls `recalc_after_name_change` too.
4. **The four commands were split into `*_impl` twins.** `tauri::State` has no public constructor, so
   a `#[tauri::command]` cannot be called from a unit test at all — which is why "the structural edit
   recalculates" could only ever have been asserted about source text. The `_impl` bodies take plain
   references and the 17 behavioural tests drive them. Same shape as `update_cell`/`update_cell_impl`.

**UNDO AND REDO.** Both restore a whole-grid snapshot, so both carry cached values and are exactly as
correct as the grid was when their snapshot was taken. Undo was always safe (its snapshot predates
the edit); **redo was not** — it replays a snapshot captured at undo time, from a workbook the
forward path had left stale. Fixing the forward path is therefore what makes redo right. Pinned by
four tests, including a cross-sheet one, all asserting through the same `assert_settled` oracle.

**THE CENSUS.** The four `EXEMPT` entries are GONE; the list is **50 entries**, down from 54. Teeth
re-verified by sabotage as asked: the seeding call was deleted from `delete_columns_impl` and the
census failed naming exactly `commands/structure.rs::delete_columns_impl`; then restored.

**VERIFIED AT INTEGRATION, 2026-08-09 — and two things changed (§3at).**

1. **The measurement REPRODUCED**, twice, on a second machine-run. Option 2 measured 625–637 ms
   against 392–394 ms for the whole-sheet pass; the chosen set beat the whole-sheet pass at every
   size; seed counts matched to the digit. **One claim above does not survive**: "it costs ~25–55%
   more than the incomplete option 1" is true only against BARE option 1. Against option 1 plus moved
   formulas the chosen set is inside the run-to-run noise (289 vs 302 one run, 310 vs 308 the next).
   The decision is unaffected — option 1 is incomplete at any price — but the number was too
   confident for a debug-profile timing.
2. **The census sabotage found a second hole in the census**, not in D8: the first attempt "removed"
   the call from `insert_rows_impl` by COMMENTING IT OUT and the census PASSED, because its RECALC
   half read the raw function body. Comments are now stripped before that check. No function in the
   crate had been relying on one (90 enumerated, 0 affected), so nothing was reclassified.

**AND THE FIX ITSELF WAS INCOMPLETE, in a way only its NEIGHBOURS revealed — §2v.** The shared
cascade D8 seeds installed no row-visibility pass, so every cell it re-evaluated was computed as if
nothing were hidden. `=SUBTOTAL(109;A1:A5)` sitting correctly at 130 with a row hidden was re-derived
as **150 and stored** by a row insert. Every caller of that entry point was affected, but before D8
the structural edit recalculated nothing, so this cell had kept its correct value — **the D8 fix is
what walked the gesture into the bug.** D8's own 17 tests passed, and so did the census. Fixed, with
two tests; the benchmark is unchanged within noise.

**Residual, named rather than hidden.** The dependency maps are SHIFTED by these commands rather than
rebuilt, so a range that GREW keeps a hole (`=SUM(A1:A5)` → `=SUM(A1:A6)` leaves the map without an
A3 edge after an insert at row 3). That is pre-existing and orthogonal to D8 — it costs a later edit
to A3, not this one — and rebuilding here would add an O(formulas) walk to the most frequent gesture
in the product. Left as a separate question.

<!-- superseded framing kept below for the reasoning it records -->

#### The question as it was raised, 2026-08-09

**The question.** `insert_rows` / `insert_columns` / `delete_rows` / `delete_columns` re-point every
reference and move every cached value with its cell, and never re-evaluate anything. For almost every
formula that is correct and free. For formulas whose result depends on the SHAPE or POSITION of their
own reference it is a stale value: `=ROWS(A1:A5)` becomes `=ROWS(A1:A6)` when you insert a row inside
the range, and keeps displaying 5.

**Excel recalculates after a structural edit**, so the owner's standing rule points one way. What the
rule does not settle is the COST, and that is the whole of this decision.

**Why it was not just done.** The seed set for a row insert is every cell at or below the insertion
point — potentially the sheet. A row insert is among the most frequent gestures in the product, so
this is exactly the shape of question D1 and D3 were made to answer with a measurement rather than an
argument, and D3's own experience is the warning: naive seeding there measured **worse than the
whole-sheet pass it replaced** (54.19 ms vs 22.75 ms) until the no-formula/no-dependents gate was
added, and that gate is already in `recalc_after_active_sheet_bulk_rewrite`, so the honest cost is not
knowable without running it.

**The three options, in the order I would try them.**

1. **Seed only the formula cells whose AST was actually rewritten**, plus their dependents. The
   structural edit already visits and rewrites each one, so the seed set is free to collect — no extra
   walk, which is the constraint that matters most here. This is my recommendation: it is proportional
   to formulas touched rather than to cells moved, and it catches every case in §2s, because a
   shape-sensitive formula only goes stale if its own reference was rewritten.
2. Seed every moved cell. Simple, obviously correct, and proportional to the edit's blast radius
   rather than to the workbook — but on a tall sheet that is the sheet.
3. Do nothing and document it. Defensible only if measurement shows (1) is expensive, which would be
   surprising.

**Do not add a fourth walk** — whichever option wins must seed
`recalc_after_active_sheet_bulk_rewrite` (and `recalc_after_off_sheet_write` for the off-sheet
structural edit), like D3's eight.

**Until it is decided**, the four functions sit in the census's `EXEMPT` with reasons that say exactly
this rather than claiming they need no recalculation — the census's job is to make an omission into a
written decision, and this is one.


## Suggested order

**Rewritten 2026-08-08 (fourth and final time, at the close of the correctness program).** Restated
from the sections rather than amended, for the reason the first rewrite gave: a to-do list that
outlives its items stops being read.

**The silently-wrong-answer tier is NOT empty. §2x closed on 2026-08-10 and was then proved live —
and proving it live turned up §2y, a defect in one document with no File ▸ Open in it. The way the tier
refilled twice between 2026-08-09 and now is recorded as the SEVENTH and EIGHTH CORRECTIONS below —
read those before trusting any sentence in this section, because every version of the emptiness claim
so far has been falsified within a day.**

**The silently-wrong-answer tier is empty, and this time the claim is checked rather than asserted.**
The last rewrite made that claim and was wrong within a day (§2m's F9 half). What is different now is
that the five guarantees the claim rests on were each made to FAIL before being trusted — the recalc
census names a function when you break it, the `DocumentEffect` gate rejects nine bypasses at compile
time, the inline editor's commit path is pinned key by key, no golden was re-recorded, and the
dialog-globals lint fires on all eight shapes. That is §3al.

**Closed since the list was first written:** `1a`, `1b`, `2a` (**including the `saveLayout` residue**,
§3aj), `2b`, `2c`, `2d`, `2e`, `2f`, `2g`, `2i`, `2j`, `2l`, `2m`, `3ab`, `3c`, `3af` (**including the
scoping fix it left to the suite owner**, §3ak), the whole `AppState` store conversion (`3ai`), and
**`3av` — `report_definitions`**, which was the last correctness item on this list *as it then read*;
proving it live added a new one (`2w`, item 0 below).

**CLOSED 2026-08-09 — the last correctness item, and the class under it (§3av).** Item 1 was
`report_definitions`: a store plus a hand-synced mirror, where the mirror was what got saved. It was
not fixed by disciplining the sync. The store was **deleted** — `extension_data["calcula.reports"]`
is now the one representation, reached through two doors, and a report mutation that skips the
persist does not exist because there is nothing left to skip. Four bypass arms were made to fail to
compile, then removed. The sweep for the same shape elsewhere found one more real instance
(`animationStore.ts`, fixed the same way with a `#private` field), three worked examples of the
right answer already in the tree, and one small remembered call reported with a recommendation
rather than converted.

**CLOSED 2026-08-08, this pass — the last three work items on the list:**

- **The unowned leftover (`saveLayout`) was worse than filed, and its filed fix was wrong.** §2a
  guessed that closing it meant "giving a pure config module a way to talk to the user", which is why
  it sat open. It did not: the module returns a `boolean` and stays pure, and the DIALOG — which
  already owns a user-facing surface — speaks. The part that mattered was not the message at all but
  that the dialog **stopped closing on failure**, because closing it destroyed the only copy of the
  user's arrangement. §3aj.
- **The `app/e2e/**` scoping fix, plus a vacuous pass found while making it.** The kill is now scoped
  to the prompting PID instead of every `app.exe` on the machine. Reading the file for that turned up
  a spec pointing at an absolute path inside one agent session's scratchpad, with the failure
  swallowed into `[]` — which is exactly what the CLEAN case asserts, so half the spec would have
  passed **without looking at anything**. Vendored and made to throw. §3ak.
- **The stale doc comment, which was hiding a sixth divergence.** `cell_error_display` claimed to
  mirror `Cell::display_value` "exactly"; the engine had since moved to an explicit `as_literal`
  table with no `#{Debug}` fallback at all. Correcting it required measuring the real divergence,
  and the measurement found **`Parse` → `#PARSE`** — an internal enum name leaking into the grid,
  which the register's four-variant list had never included. Pinned by a test; the spelling itself is
  D7 below.

**A THIRD CORRECTION, and it is the same one twice more.** Both remaining work items had a written
verdict that was wrong in a way that ten minutes of running or reading exposed: "fixing it means
giving a pure config module a way to talk to the user" (it does not), and a four-variant divergence
list (it is six, and the sixth is the only one that is a leak rather than a preference). Added to the
previous two corrections — "changes no answer" for something that corrupted entries, and "not
reproduced deliberately" for something a test kills in a line that says so — the pattern is now
unambiguous and worth more than any single fix in this program:

> **A verdict reached by reasoning about a symptom is a hypothesis. This register has recorded four
> of them as conclusions, and all four were wrong. Spend the number: open the file, run the command,
> check the element, read the exit code.**

**A FOURTH CORRECTION, 2026-08-09 — and it is this section's own claim.** The sentence that used to
follow this paragraph read: *"Note the shape of what is left: there is no correctness work on this
list."* **It was falsified twice inside twenty-four hours**, and neither falsification came from
running the list:

- **§2s / D8.** The four structural edits re-pointed every reference and re-evaluated nothing, so
  `=ROWS(A1:A5)` went on displaying 5 as `=ROWS(A1:A6)`. Found by HARDENING the census
  (`DELEGATING_HELPERS`) — the four wrote through a helper, so the census had never enumerated them
  and could not have failed for them.
- **§2v.** The shared cascade re-evaluated SUBTOTAL/AGGREGATE as if nothing were hidden, overwriting
  a correct 130 with 150. Found by PROBING D8's neighbours after D8's own 17 tests and the census had
  both passed.

So the honest form of the claim is narrower, and it is the form worth keeping:

> **The tier is empty as far as every check in the tree can tell — and the last two things in it were
> each found by ADDING a check, not by running one.** "No known correctness work" is a statement
> about the checks, not about the product. The way to empty it again is to keep making guarantees
> fail, and to probe the neighbours of every fix.

**A FIFTH CORRECTION, 2026-08-09 (later the same day) — the tier is NOT empty, and the way it was
refilled is now a pattern with five instances.** The paragraph that stood here said the tier was
"again empty". It was falsified within hours, by the pass that PROVED §3av on the running app
(§3aw) — and, like the two before it, not by running anything on the list. §3av's own sweep asked of
every source in `assemble_workbook_for_save` "does this read the canonical store?" and cleared them
all. The question it did not ask is the other half — **"is that store scoped to the DOCUMENT?"** —
and for three of them it is not. **§2w**: `new_file` never resets `PivotState`, `RibbonFilterState`
or `BiState`, so a document created by File ▸ New and given a single typed cell is saved carrying the
PREVIOUS document's pivot definitions, ribbon filters and BI model connections — the last of these
including the whole embedded semantic model, and accumulating across every workbook opened in the
session. Confirmed on the bytes of the saved `.cala`, not inferred.

Note what makes §2w the mirror image of everything before it: it is data INJECTION, not data loss.
Every hunt in this program has been for a write that goes missing. This is a write that appears. A
sweep tuned to the first shape walked straight past it, and single-representation — the property
§3av bought — is necessary and not sufficient: a save-time projection is only correct if the store
it projects has the same LIFETIME as the document being saved.

So the honest statement, as of the close of this pass: **the silently-wrong-answer tier holds one
item, §2w, filed with a reproduction and with the invariant its fix must establish** ("a store that
`assemble_workbook_for_save` reads is reset by `new_file`"). Every unit suite is green, every E2E
project is at or better than baseline, and what remains below is otherwise unchanged in shape — two
test-signal items with owners to find, two pieces of structural debt, and the decisions in section 4.

**A SIXTH CORRECTION, later on 2026-08-09.** §2w is fixed (§2w-FIXED), and the fix ENUMERATED before it
changed anything — which is the only reason the entry above can now be read as an undercount. §2w
named three stores; walking the save path's sources out of the source tree found **six**, and two more
that leak without being save sources at all. The three nobody had named are not lesser: `sheet_ids` is
a sheet-IDENTITY collision between unrelated workbooks, which is strictly worse than the injection
§2w describes, because the injected object is at least visible in the archive and a duplicated
`SheetId` is not. **The lesson is the same one this register keeps writing down and this is the
seventh instance: a by-name list of instances is not a measurement of the class.** §2w said so about
its own fix, and it was right about its own fix while being wrong about its own count. The invariant
it demanded is now a check with an empty exemption list, so the count is no longer anybody's to get
wrong.

**A SEVENTH CORRECTION, 2026-08-10 — and it falsifies the SIXTH's closing sentence.** The paragraph
above ends *"the count is no longer anybody's to get wrong"*. It was wrong within a day, and in the
one way this register has never recorded before: **not by miscounting the class, but by measuring the
wrong class.** §2w's census asks whether every store the SAVE PATH READS is reset. The undo stack is
not a save source. It is nevertheless the document's, `new_file` cleared it in a block labelled
*"session state that is NOT a save source"*, `open_file` did not, and **one Ctrl+Z after File ▸ Open
overwrote a cell of the workbook on screen with a value from a workbook that was no longer open** —
then saved it there. §2x, measured on the bytes.

Read against the six before it, the shape is finally explicit. Every correction so far has been about
COMPLETENESS: the list was three and the class was six, the sweep found lost writes and missed
injected ones. This one is about SCOPE — a guarantee that is completely enforced over the wrong set.
**A census cannot fail for what it does not enumerate, and "every save source" is not "every thing
that belongs to the document".** The fix is not a bigger list: `every_state_field_is_reset_or_exempt`
now enumerates every field of every State (123 across 8), so the set being measured is the set that
exists rather than the set that is serialised.

Two side-findings are worth more than their size. **§2w's own census had a live blind spot**: it read
one line at a time, and a rustfmt-wrapped method chain is invisible to that — so `workbook_protection`
and `pending_recalc`, both save sources, were never enumerated, and the empty `EXEMPT` was an empty
`EXEMPT` over 66 of 70 sources. And the acceptance test for §2x **passed on a demonstrably broken
build** on its first attempt, because its probe edited a cell the leaked undo entry did not name. Both
were found by insisting on the demonstration rather than the assertion, which is the only method this
program has that keeps working.

**AN EIGHTH CORRECTION, later on 2026-08-10 — the tier is NOT empty, and §2x itself held up.** Two
separable results, and they point opposite ways.

**§2x was proved LIVE and the static work was confirmed, not contradicted** (§3ax). Five tests drive
the real File menu, the real native picker, real typing, Ctrl+Z / Ctrl+Y and the ribbon's own Undo and
Redo buttons, across the `window.location.reload()` that File ▸ Open performs — the boundary no
command-level test can see — and read the answer out of the `.cala` on disk. Given teeth by sabotaging
a running build: with the resets removed, one Ctrl+Z after File ▸ Open followed by File ▸ Save left the
saved workbook holding `ALPHA-ORIGINAL` and **not holding `BRAVO-ORIGINAL` at all**. Restored and
verified byte-identical by SHA-256, rebuilt cold, 5/5.

**And writing it found a live defect, §2y, which has nothing to do with File ▸ Open.** The store-level
spec cleared the stale spill origin with `update_cell(.., "")`. The Delete key is a different command
— `clear_range` — and it never removes a spill range at all. Following that: delete the origin of a
`=SEQUENCE(4)` inside ONE document and its three spilled cells become uneditable AND undeletable for
the rest of the session, showing values no formula produces, with both remedies the error messages
offer impossible to follow (the source cell they name is empty; deleting the whole block is refused by
the same guard). They save as orphan literals. Reproduction and the two-part fix are in §2y.

**So the claim to carry forward is the method, not the count.** Each of the last four passes has been
told to check emptiness by asking a question the previous pass did not, and each has found something
real — §2w by asking what `new_file` does not reset, §2x by asking what the census cannot enumerate,
§2y by asking which COMMAND the gesture under test actually runs. The tier is empty exactly as often
as somebody stops asking. This time the question that paid was: *the store-level test drove one
command — is that the command the user's gesture calls?* It was not.

**The one thing that WAS owed is now paid (§3au).** Both **D8** and **§2v** have been proved on a
running app — `structural-recalc.spec.ts`, 10 tests through the real row/column-header context menu,
green, and given teeth by sabotaging a running build twice (D8 off: 8 of 10 fail with the exact stale
values; §2v off: the hidden-row aggregate renders 150 for 120). Every project was re-run from a cold
app and every number is at or better than baseline. **What that pass found was not a defect in either
fix** — for the first time in this program the live proof confirmed the static work rather than
contradicting it. It did find one cosmetic residual worth naming: a sheet name typed as `Sheet1!`
is stored and shown as `SHEET1!`, normalised at cell entry and nothing to do with structural edits.

What remains, in order.

0. **§2y — deleting the ORIGIN of a spilled array leaves the spill map behind.** OPEN, with a live
   reproduction. `clear_range` (what the Delete key runs) checks `check_spill_protection` and never
   removes a spill range; only `update_cell` does. Delete the origin of a `=SEQUENCE(4)` and its three
   spilled cells are uneditable AND undeletable for the session, showing values no formula produces,
   with both offered remedies impossible to follow; they save as orphan literals. The fix is two parts
   (remove the owned range through `clear_range`'s own undo-recording loop; stop refusing a host whose
   ORIGIN is inside the same rectangle) and it wants its own pass. Found by asking which COMMAND the
   user's gesture actually runs — §3ax.

0. ~~**§2x — the undo stack (and eighteen other stores) outlived its document across File ▸ Open.**~~
   **CLOSED 2026-08-10.** `new_file`'s inline "session state that is NOT a save source" block is gone
   into `reset_document_scoped_stores`, classified item by item first — `FileState` deliberately did
   NOT move, because "which document is open" is the one thing the two paths must disagree about.
   Enumerating turned up **seven more stores neither path reset**, including `ScriptState.notebook_runtime`
   (whole `Vec<Grid>` snapshots that `notebook_rewind` writes straight over the open workbook) and two
   save sources the old census was blind to. The class is now checkable at both ends: a FIELD census
   over every field of every State, plus the delegation invariant that `new_file` resets nothing of
   its own. `clear_undo_history` was DELETED, not wired up. §2x.

0b. ~~**§2w — `new_file` does not reset three stores that `assemble_workbook_for_save` writes.**~~
   **CLOSED 2026-08-09 (§2w-FIXED).** It was not fixed by clearing three more stores, as the entry
   insisted: the reset is COLLAPSED into one `reset_document_scoped_stores` that both `new_file` and
   `open_file` run, and the invariant is now a census over the save path's sources with an empty
   `EXEMPT` list. Enumerating first turned up **three more leaking stores** the entry had not named —
   `sheet_ids` (a sheet-identity COLLISION, not merely a leak), `model_writeback`,
   `advanced_filter_hidden_rows` — plus `protected_regions` and the `PivotState` session caches, which
   are not save sources and leaked anyway. **The successor project below is unchanged**: the census
   buys the LIFETIME half of the property; it says nothing about whether a mutation dirties the
   document, which is what `DocumentEffect` on those States is for. §2w is still the reason that
   project is not merely structural debt — it is just no longer the reason a user's file is wrong.

1. **The `visual` golden the `<textarea>` swap moved, and the `clickCell` drift under it.** §3ao(3).
   `visual` is **17/1**, not the 18/18 this register has been quoting: "editing mode - inline editor
   visible" fails COLD IN ISOLATION. Fix the drift first (`navigateTo` before the capture, the
   documented remedy) and only then re-record, with the reason written down — re-recording first
   just freezes an ambient selection into the baseline.

2. **The three screenshot specs that were never isolated: `protection` (2), `ribbon-tabs` (1),
   `scrolling` (3).** Everything else in the 21 was classified by running it; these were not, because
   the per-spec cold loop hung on `protection`. `scrolling`'s diff looks like the `clickCell`
   selection drift, which would make it the same item as (1) — but that is a hypothesis, and this
   register's record on hypotheses is now 0 for 6. Run them cold, one spec per app. **Do this AFTER
   the D5 re-record, not before:** `protection` and `scrolling` are `takeGridScreenshot` specs, so
   until their goldens are re-recorded at the new frame size every diff is a crop and tells you
   nothing about the drift. `ribbon-tabs` is unaffected and can be isolated now.

3. **The successor to the `AppState` conversion: `BiState` / `PivotState` / `ScriptState` /
   `PaneControlState`.** `DocumentEffect` gates *stores*, and the app's stores are now covered; what
   is left ungated is a command mutating state that lives elsewhere. The **47** remaining
   `let _ = ...mutates(...)` sites across **13** files are a precise map of it, exactly as the 61
   were a map of §3c. Recounted this pass: still 47 / 13.

4. **The seven decisions in section 4.** They are product calls, not work, and they are written up
   for the owner rather than listed here. **D1 was decided and shipped 2026-08-09** — F9 = Calculate
   Now = the workbook, Shift+F9 = Calculate Sheet = the active sheet, under the owner's standing rule
   that Excel parity wins. The benchmark it was gated on came back the opposite way round from the
   fear: the workbook pass is ~30% FASTER than the old F9 on identical single-sheet work.
   **D4 was decided and shipped 2026-08-09** — the play pill is viewport-pinned DOM chrome with a
   close control, and `clearDriver` has three product routes where it had none. `__CALCULA_ANIMATION__`
   is deleted: the specs drive the product paths now. The finding underneath it is bigger than the
   pill — that handle was the test surface compensating for a feature the product did not have.
   **D5 was decided and shipped 2026-08-09** — grid captures frame the canvas layer, so the
   scrollbars are out of frame, and the marching-ants border is parked by the app's own reduced-motion
   switch (which nothing had ever read). Two cold runs of the capture the register called
   unphotographable are now byte-identical. **Read the cost correction before scheduling the
   re-record: it is 40 goldens, not eleven**, because cropping changes the image size — every
   `takeGridScreenshot` golden moves, region captures and window checkpoints do not.
   **D7 was decided and shipped 2026-08-09** — the grid spells errors the way Excel does and the way
   the rest of the product already did, the last `#{Debug}` arm is gone, and `CellError::Parse` was
   deleted rather than respelled because nothing in the product ever constructed it. The divergence
   was hiding a real defect: `isErrorValue` matches the canonical literals, so every `#DIV0` /
   `#VALUE` / `#REF` / `#CIRCULAR` cell was painted as ordinary black left-aligned text.

**Deliberately not on this list: the rest of Wave 5 (§1c).** `CenterAcrossSelection`, insert/delete
cells with shift, extended border styles, superscript/subscript and sparklines are each an engine
project whose script API is the last 5%. The recommendation stands that real user demand should pull
them rather than a schedule pushing them.

**Also not on this list, and deliberately: the Home-tab-header right-click affordance.** It is shell
work (a generic `PanelDefinition.contextMenuItems` field), it is the discoverability half of a
feature that already works through the View menu, and nothing depends on it.
