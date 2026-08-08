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

### 2o. "Calculate Workbook" calculates one sheet — RECORDED 2026-08-08, an owner decision

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

### 2p. A typed formula does not keep its NAME — RECORDED 2026-08-08

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

### 2q. The Animation play pill covers A1:C2 and swallows clicks — RECORDED 2026-08-08

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
removed when the product grows one.

Recorded, not fixed: where the pill should live — viewport-pinned to a corner, given a close
affordance, or made click-through with a drag handle — is an owner decision about a visible piece
of UI, not a slip-in. What is NOT in question is that "a floating control sits on A1, eats the
click, and cannot be dismissed" is wrong in all three designs.

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
| 5 | undoing a named-range change restores the value the formula had | real Formulas > "Apply Names...", then repoint + F9 + Ctrl+Z | 111 -> 222 -> 111 on the STORED value and on G1's pixels; the pixel probe is shown wired by requiring the 222 frame to differ |
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

**The other eleven failures are one class, and it is already D5.** Every remaining failure in the run
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
| 2 `paste-special` | ROOT, but **no product defect** | still fails cold ALONE; on a clean workbook the entire diff is the marching-ants copy border (which `screenshotGates.ts` already names as the only non-deterministic thing in either suite) plus the scrollbar thumb — D5's class |
| 2 `state-consistency` | **FLAKY, not a regression** | passed in run 1 (1.1 min), failed in run 2 on the SAME build. The invariant is named `page-crashed`, but the app did **not** crash: it was still running, still on CDP and still serving commands after the run, with **zero panics** in the whole log. It is Playwright's "Target page, context or browser has been closed" against a random 64-step monkey sequence (seed 1786220272147) |
| 2 `protection`, 1 `ribbon-tabs`, 3 `scrolling` | **NOT individually isolated** | the per-spec cold loop hung on `protection` and was stopped to protect the remaining required runs. `scrolling`'s diff shows a whole selection block differing — the `clickCell` drift signature — but that is an inference, not a measurement, and is recorded as such |

The last row is deliberate. Everything else here was measured; that one was not, and the register has
now been wrong six times by reasoning where it could have run something.

---

## 4. OWNER DECISIONS — not work, product calls

**These are for the owner. Nothing in this section is a defect awaiting a fix; each is a choice
between defensible options, and each was deliberately NOT decided by the agents who found it.** They
are grouped because five of the seven are one family: they all ask "what should the product mean?",
not "is the product doing what it says?".

Each entry states the choice, what each option costs, and a recommendation. The recommendation is
advice, not a decision taken.

### D1. Should "Calculate Workbook" calculate the workbook? (§2o)

**The choice.** `calculate_now` collects formula cells from the ACTIVE-sheet mirror and evaluates
only those, while the Formulas menu calls the item "Calculate Workbook". Measured with iterative
calculation on: six presses of F9 on Sheet1 moved a cross-sheet cycle **not at all**; switching tabs
and pressing F9 on each sheet is a real round, and the cycle then converges 15 → 17.5 → 18.75 → …
→ 19.999999702 after 25 rounds.

- **Make it workbook-wide.** The name becomes true and a cross-sheet cycle advances per press. Cost:
  this is the hottest command in the product and `save_file` calls it when calculate-before-save is
  on, so the cost of every save and every F9 changes for every workbook with more than one sheet.
  Not a slip-in; wants a benchmark on a large multi-sheet workbook before it lands.
- **Rename the command to "Calculate Sheet"** and add a separate workbook-wide item. Cheap, honest,
  and leaves the fast path fast. Cost: Excel users expect F9 to mean the workbook, so this trades a
  wrong name for a surprising key binding.
- **Leave it.** Cost: the name stays wrong, and the next person to reason from it reaches a wrong
  conclusion — which is exactly how §2m's silently-wrong answer happened.

**Recommendation: rename now, make it workbook-wide behind a benchmark.** The rename removes the
trap immediately at near-zero risk; the performance work can then be scheduled on its merits rather
than being forced by a misleading label. A partial iterate is a legitimate value under iterative
calculation, so this is a limit to name, not a wrong answer to rush.

### D2. Should a typed formula keep its NAME? (§2p)

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

### D3. Who owns pivot and table recalculation? (§2m's census, `EXEMPT`)

**The choice.** Eight functions write cells and deliberately do not recalculate. Each sits in the
census `EXEMPT` table with a written reason, so none is an accident — but "in class, left to their
owner" is a holding position, not an answer:

- **Pivot:** `create_pivot_inner`, `delete_pivot_table`, `undo_pivot_overwrite`. A formula over a
  freshly written pivot block stays stale; clearing a block leaves its readers stale.
- **Tables:** `toggle_totals_row`, `set_totals_row_function`, `set_calculated_column`,
  `check_table_auto_expand`.
- **`relocate_cell_references`:** re-evaluates the formulas it rewrites but does not cascade to
  THEIR dependents.

- **Seed the shared cascade from each.** Correct by construction and uses machinery that already
  exists. Cost: pivot/table writes become as expensive as bulk rewrites, and these run on every
  refresh.
- **Give each region its own refresh contract** — the pivot's own refresh path triggers dependents.
  Cheaper and arguably more correct in design. Cost: a second cascade concept, which is precisely
  what the ONE-cascade census was built to prevent.
- **Leave exempt.** Cost: a stale formula over a pivot is a silently wrong answer, the tier this
  program was built to empty.

**Recommendation: close `relocate_cell_references` now, decide pivot/tables as one.** It is the
narrowest of the eight, has no refresh path of its own to defer to, and is the only one where the
"owner" is the structural-edit code that already recalculates. The other seven are one decision, not
seven, and should be taken with the pivot refresh design in view.

### D4. Where should the Animation play pill live? (§2q)

**The choice.** The pill is anchored at a fixed SHEET position, so it puts a 172×26 hit-testable
control on top of **A1:C2** — and it ate cell clicks across eighty-nine E2E spec files for months
before anyone saw it. Options: viewport-pin it to a corner, give it a close affordance, or make it
click-through with a drag handle.

**What is NOT in question, and should not wait for the design:** there is currently **no route in
the product to unload a driver**. Every lifecycle event Animation subscribes to calls
`stopAndRestore`, which leaves the driver loaded; `clearDriver` unloads it and **nothing calls it** —
not the panel's "Stop" button, not closing the panel, not `new_file`. Once a driver is loaded the
pill owns A1:C2 until the page reloads.

**Recommendation: viewport-pin with a close affordance, and give the product a `clearDriver`
route regardless of which layout wins.** The E2E cleanup currently reaches `clearDriver` through a
`window` handle (`__CALCULA_ANIMATION__`) that exists ONLY because the product has no route; that
handle should be deleted the moment one exists. Whether "Stop" should also unload is the genuinely
debatable part — a user mid-iteration probably wants the driver kept.

### D5. The eleven scrollbar-thumb goldens (§3a)

**The choice.** Eleven grid goldens differ only by a scrollbar thumb. Specs park fixtures in far
columns to avoid colliding (`status-bar` at R:S, `edge-cases` at AE:AH, `scrolling` at row 5000); the
data is off-screen, but it sets the used range, and the thumbs ARE in every capture.

- **Reset before capture.** Honest and removes the coupling. Cost: re-records eleven baselines, and
  every future spec must remember to reset.
- **Exclude scrollbars from grid captures.** One change to the capture helper, fixes the class
  permanently. Cost: re-records eleven baselines, and the suite stops watching scrollbars at all.
- **Stop parking fixtures in far columns.** Cost: fights a convention the suite is not going to
  abandon, and reintroduces the collisions the parking was there to avoid.

**Recommendation: exclude scrollbars from grid captures.** It fixes the class rather than eleven
instances, and a scrollbar thumb is chrome that no grid-rendering assertion is actually about — if
scrollbar geometry deserves coverage it deserves its own test. Both fixing options re-record the same
eleven baselines, so the choice is really "once, structurally" versus "once, per spec, forever".

**Whichever is chosen, the re-record needs a stated per-golden reason.** This batch deliberately
re-recorded nothing (contract (d) above), so the eleven are still failing honestly rather than
hidden.

### D6. `cells: collapsePriority` is an accidental 99 (§2a)

**The choice.** The value is not considered — it is the fallback a missing `GROUP_ORDER` row
produced, and it makes the Cells group demote LAST on a narrow ribbon, which is almost certainly
unintended. It is now written out explicitly so it cannot drift silently, but it was not changed:
changing it changes narrow-window behaviour, which is the owner's call under the "current appearance
is the default" constraint.

**Recommendation: 55**, between Styles (50) and Editing (60). It is the obvious candidate and the
one the folded-in table would have produced had the row not been missing. This is the cheapest entry
in this section — a one-line change plus a narrow-window check.

### D7. The app/engine error-spelling divergence (§2n, extended)

**The choice.** Six of the ten `CellError` variants are spelled differently by the app-side
`cell_error_display` than by the engine's `CellError::as_literal`. The doc comment claiming the two
were mirrors was **false and has been corrected**, and the divergence is now pinned by a test
(`error_display_tests.rs`) so it cannot widen unnoticed — but the spellings themselves were not
changed, because changing them moves grid goldens.

| variant | grid shows | engine canonical |
|---|---|---|
| `Div0` | `#DIV0` | `#DIV/0!` |
| `Ref` | `#REF` | `#REF!` |
| `Name` | `#NAME` | `#NAME?` |
| `Value` | `#VALUE` | `#VALUE!` |
| `Circular` | `#CIRCULAR` | `#CIRCULAR!` |
| `Parse` | `#PARSE` | `#VALUE!` |

**`Parse` is not cosmetic and is new information** — the register previously listed four variants,
all missing punctuation. `#PARSE` is an internal enum name leaking into the grid through the
`#{Debug}` arm. The engine gives `Parse` no distinct literal on purpose (it shares `#VALUE!`, so
`from_literal` reloads it as `Value`), which makes `#PARSE` a spelling **no other layer in the
product can parse back**.

- **Adopt the canonical literals.** The grid agrees with the engine, with Excel, and with the
  frontend's `CELL_ERROR_LITERALS`. Cost: re-records every golden painting an error cell.
- **Fix `Parse` only.** Removes the leak at almost no cost — `#PARSE` is unlikely to appear in a
  golden. Cost: leaves five inconsistencies.
- **Leave it.** No answer is wrong and persistence is unaffected (checked). Cost: the grid disagrees
  with every other surface about what an error is called.

**Recommendation: fix `Parse` now, adopt the rest with the D5 golden re-record.** `#PARSE` is the
only one of the six that is a leak rather than a spelling preference, and it is separable. Folding
the other five into whatever re-record D5 triggers means paying the baseline cost once.

**Note for whoever takes this:** `Limit`, `Blocked`, `Conflict` and `NA` must keep their explicit
arms. The `#{Debug}` fallback would drop the trailing punctuation, and the frontend's
`normalizeCellErrorLiteral` collapses anything it does not recognise to `#VALUE!` — erasing exactly
the distinction those variants exist to draw. A test pins this.

---

## Suggested order

**Rewritten 2026-08-08 (fourth and final time, at the close of the correctness program).** Restated
from the sections rather than amended, for the reason the first rewrite gave: a to-do list that
outlives its items stops being read.

**The silently-wrong-answer tier is empty, and this time the claim is checked rather than asserted.**
The last rewrite made that claim and was wrong within a day (§2m's F9 half). What is different now is
that the five guarantees the claim rests on were each made to FAIL before being trusted — the recalc
census names a function when you break it, the `DocumentEffect` gate rejects nine bypasses at compile
time, the inline editor's commit path is pinned key by key, no golden was re-recorded, and the
dialog-globals lint fires on all eight shapes. That is §3al.

**Closed since the list was first written:** `1a`, `1b`, `2a` (**including the `saveLayout` residue**,
§3aj), `2b`, `2c`, `2d`, `2e`, `2f`, `2g`, `2i`, `2j`, `2l`, `2m`, `3ab`, `3c`, `3af` (**including the
scoping fix it left to the suite owner**, §3ak), and the whole `AppState` store conversion (`3ai`).

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

What remains, in order. **Note the shape of what is left: there is no correctness work on this list.**
Two test-signal items with owners to find, two pieces of structural debt, and the decisions in
section 4.

1. **`report_definitions`, the one store §3ai deliberately did not fold in.** Its persisted form
   (`extension_data`) IS gated, so nothing is lost by forgetting the dirty flag — but nothing forces
   `sync_reports_to_extension_data` to be called either, and a report mutation that skips it is
   silently dropped at save. Different defect, different fix: make the mirror unreachable except
   through the sync.

2. **The `visual` golden the `<textarea>` swap moved, and the `clickCell` drift under it.** §3ao(3).
   `visual` is **17/1**, not the 18/18 this register has been quoting: "editing mode - inline editor
   visible" fails COLD IN ISOLATION. Fix the drift first (`navigateTo` before the capture, the
   documented remedy) and only then re-record, with the reason written down — re-recording first
   just freezes an ambient selection into the baseline.

3. **The three screenshot specs that were never isolated: `protection` (2), `ribbon-tabs` (1),
   `scrolling` (3).** Everything else in the 21 was classified by running it; these were not, because
   the per-spec cold loop hung on `protection`. `scrolling`'s diff looks like the `clickCell`
   selection drift, which would make it the same item as (2) — but that is a hypothesis, and this
   register's record on hypotheses is now 0 for 6. Run them cold, one spec per app.

4. **The successor to the `AppState` conversion: `BiState` / `PivotState` / `ScriptState` /
   `PaneControlState`.** `DocumentEffect` gates *stores*, and the app's stores are now covered; what
   is left ungated is a command mutating state that lives elsewhere. The **47** remaining
   `let _ = ...mutates(...)` sites across **13** files are a precise map of it, exactly as the 61
   were a map of §3c. Recounted this pass: still 47 / 13.

5. **The seven decisions in section 4.** They are product calls, not work, and they are written up
   for the owner rather than listed here.

**Deliberately not on this list: the rest of Wave 5 (§1c).** `CenterAcrossSelection`, insert/delete
cells with shift, extended border styles, superscript/subscript and sparklines are each an engine
project whose script API is the last 5%. The recommendation stands that real user demand should pull
them rather than a schedule pushing them.

**Also not on this list, and deliberately: the Home-tab-header right-click affordance.** It is shell
work (a generic `PanelDefinition.contextMenuItems` field), it is the discoverability half of a
feature that already works through the View menu, and nothing depends on it.
