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


### 2y. Deleting the ORIGIN of a spilled array leaves the spill map behind — the spilled cells become permanently uneditable AND undeletable for the session, and save as orphan literals (2026-08-10) — **FIXED 2026-08-10; see the closing note at the end of this section, which corrects the filed fix**

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

**Not fixed in that pass, deliberately.** It is a different defect in a different command from the one
that pass was sent to prove, the Delete key is one of the hottest paths in the suite, and half of it —
removing cells without recording them for undo — is precisely the shape this register keeps filing
against. It wanted its own pass with its own teeth.

---

#### The closing pass (2026-08-10). What the filed fix got wrong, and what the defect actually was

**Half (a) as filed was wrong, and building it would have made undo destroy the array.** The filing
said each cleared spill cell should get an `undo_stack.record_cell_change`, "strictly better than
`update_cell`'s branch, which removes them with no undo entry at all". It is strictly worse, and the
reason is `apply_changes`: it restores every recorded cell BEFORE it recalculates. Restore literal
`2 3 4` into A2:A4 alongside the restored `=SEQUENCE(4)` in A1, and when the origin re-evaluates
`reevaluate_formula_cell` finds occupied cells that are not its own spill — the map entry left with the
clear — sets `spill_blocked`, and the undo lands on **`#VALUE!`** instead of the array. A spilled cell
is DERIVED state: it carries no formula, no rich text, style 0. Undo restores the ORIGIN and the
cascade re-spills it, which is exactly how `update_cell(A1, "")` has always undone correctly. Pinned
both ways, in `commands/spill_map_tests.rs`: `a_swallowed_spill_cell_gets_no_undo_entry` asserts the
transaction holds A1 and nothing else, and
`restoring_spilled_literals_beside_a_restored_origin_is_what_blocks_the_respill` demonstrates the
`#VALUE!` the filed version would have produced.

**Half (b) was right but under-specified, and applied blindly it corrupts.** The exemption cannot be
unconditional: `sort_range` also calls the guard, and letting a permutation swallow an origin shuffles
spilled values among rows as if they were data. The guard now takes an explicit **`SpillOriginPolicy`**
— `ReleasedByCaller` (the clears) or `Refuse` (everything else) — and
`every_release_policy_call_site_actually_releases_the_spill` fails if a site takes the exemption
without reaching a tear-down, because taking it without the removal it promises is worse than the
refusal it replaces.

**And the fix does not belong in `clear_range` at all.** The register asked for the sibling commands to
be enumerated, and the enumeration is what changed the shape of the answer: `clear_range` was one of
**eleven** writers that could orphan the map, and a twelfth was `update_cell` itself. So the tear-down
moved to a CHOKE POINT — `recalc_after_active_sheet_bulk_rewrite`, where **a seed that no longer holds
a formula releases whatever spill it owned**. Every bulk rewrite already ends there, so the Delete key,
Clear Contents, a sort that moved an origin, an **undo** that cleared one and the **redo** that cleared
it again are all covered by one rule rather than five remembered call sites. `undo_commands.rs` was not
touched. The other half of the rule was already in place: a seed that DOES hold a formula goes through
`reevaluate_formula_cell`, which tears the old range down and spills the new one. Together they cover
"the origin went away" and "the origin changed", which is the whole of the maintenance problem.

It runs BEFORE the manual-calculation return, deliberately: manual mode means the user accepted stale
VALUES, never a map claiming cells for a formula that is gone — and F9 would not repair it, because
`run_calculation_pass` is not spill-aware either (§2ab). Cost on the Delete key: one `spill_ranges` lock
and one `is_empty()` when the workbook holds no dynamic array. The seed list is projected into a
`CoordSet` only after that check has found something to release, so a 10,000-cell remove-duplicates
seed list is never hashed for nothing.

**Two defects this pass found that §2y had not, both in `update_cell` — the command the filing named as
the map's one correct maintainer.** Its tear-down sat inside
`if let Some(formula) = ... { match parser::parse(&formula) { Ok(parsed) => `, so:

| gesture over a spill origin | before | now |
|---|---|---|
| type a **literal** (`7`) | map kept, A2:A4 uneditable + undeletable — §2y exactly | released |
| type a formula that does not **parse** | same | released |
| type `=A2*10` (a formula reading its own old spill) | stored **20**, read from the array it was destroying; a reload of the same file produces **0** | **0** from the edit path and the load path alike |

The third is the worse one: an ORDER-DEPENDENT stored value, which is the failure this program's
recalculation work exists to eliminate, and it was reachable by one keystroke. The release is now
hoisted above every branch and runs BEFORE the new formula is evaluated — the array ceases to exist the
moment its formula is replaced. `update_cells_batch_core` (the PASTE path) had the identical shape and
got the identical hoist.

**The enumeration, made mechanical rather than a list of names.** `every_cell_writing_function_either_
maintains_the_spill_map_or_is_exempt_with_a_reason` walks the crate — the sibling of the recalculation
census, with the same sabotage tests and the same delegating-helper modelling (which found three more
writers on its own). Every function that writes cells must MAINTAIN, REFUSE, or be EXEMPT with a
written reason:

| command | before | now |
|---|---|---|
| `update_cell` (empty) | maintained | maintained (shared tear-down) |
| `update_cell` (new formula) | maintained | maintained, and hoisted above the branch |
| `update_cell` (literal / unparseable) | **leaked** | maintained |
| `update_cells_batch_core` (paste) | leaked outside the formula branch | maintained |
| `clear_range` (the Delete key) | **leaked** | released via the choke point; guard exempts a swallowed origin |
| `clear_cell` | leaked | released via the choke point |
| `clear_range_with_options` (Clear Contents/All) | leaked | as `clear_range` |
| `clear_range_with_options_off_sheet` | leaked | released in its own critical section |
| `clear_range_on_sheets` (group clear) | leaked, **and had no guard at all** | guarded + released |
| `update_cell_on_sheets` (script off-sheet write) | leaked, **and had no guard at all** | guarded + released |
| `sort_range` / `sort_range_off_sheet` | guarded for CELLS only; could still move an origin | `check_no_array_within` — refuses cells *and* origin |
| `fill_range` (Ctrl+D / Ctrl+R) | **no spill guard whatsoever** | `check_no_array_within` |
| `merge_cells` / `merge_cells_off_sheet` | no spill guard; deletes every non-master cell | `check_no_array_within` |
| `replace_all` / `replace_single` (+ off-sheet) | rewrote spilled VALUES in place | `check_spill_protection_cells` over the match list |
| `apply_script_modified_grids_core` (non-active install) | leaked | `release_spills_orphaned_by_grid` |
| `calp_revert_override` / `calp_accept_upstream` / `calp_refresh_apply` | leaked | same |
| insert/delete rows/columns | already moved both maps in lockstep | unchanged |
| undo / redo (`apply_changes`) | **leaked** | covered by the choke point; the file was not touched |

`check_no_array_within` exists because the spilled-CELL check alone is blind to one arrangement: a
horizontal array in row 1 lies entirely outside any rectangle over column A **except for its origin**,
so sorting column A moved the formula to another row while B1:D1 stayed put. Both questions, one
helper, and `every_command_that_cannot_carry_an_array_refuses_one` pins that the five commands whose
census answer is "it refuses" still refuse.

**Verified.** 30 new tests in `app/src-tauri/src/commands/spill_map_tests.rs`, including the register's
reproduction start to finish, undo restoring the spill AND the map, redo taking it down again, the
exemption on both sides of the guard's adaptive scan, and the tear-down under manual calculation.

| suite | result | vs. baseline |
|---|---|---|
| `npx vitest run` | **746 files / 106,211 passed, 0 failed** | 742 / 106,168 — the delta is other passes'; no TypeScript was touched here |
| `check-types` (tsc) | clean | — |
| `lint:boundaries` | clean | — |
| `check:script-typings` | **39 interfaces / 736 members** | exact — no new command, no new capability id |
| `check:line-endings` | **0 mixed** | exact |
| core `cargo test` | **1,289 passed, 0 failed** | 1,285 (+4, another pass; nothing under `core/` touched here) |
| `cargo test -p script-engine` | **111 passed, 0 failed** | exact |
| app-lib `cargo test --lib` | **1,267 passed, 0 failed** | 1,221 (+30 this pass, +16 other passes) |
| `test_pivot` | **56 passed, 0 failed** | exact |
| `cargo check --lib --tests` (app) | clean, **0 warnings** | exact |

**One flake observed, in another pass's area, recorded so it is not read as a regression.**
`bi::model_editor::tests::an_abandoned_script_batch_is_reclaimed_and_rolled_back` failed on 2 of 7
full-suite runs at `--test-threads=8` and passed 5 of 7, plus 3 of 3 in isolation. It drives a GLOBAL
`script_batch_registry()` and a wall-clock deadline, so it is load-sensitive test isolation, not
product behaviour, and nothing in this pass reaches `bi/`.

**The live E2E projects were NOT re-run, and that is a gap, stated rather than papered over.** The
brief's launch script (`scratchpad/launch-vba-batch.ps1`) does not exist in the tree, and the crate was
being edited by other passes throughout this one — `persistence.rs` and
`script_security_census_tests.rs` were each broken mid-edit long enough to block a build here, which is
exactly the condition §2ab cites for not having run its own reproduction live. What that costs is
smaller than usual: the tests above drive the REAL `update_cell_impl`, `reevaluate_formula_cell`,
`recalc_after_active_sheet_bulk_rewrite` and `apply_changes` in-process, so the only reproduced piece is
`clear_range`'s `#[tauri::command]` wrapper — and `clear_range_still_runs_the_four_phases_this_harness_
reproduces` pins from source that the wrapper still performs the same four steps in the same order,
guard before transaction. The two spill journey specs that DO exist
(`document-store-leak.spec.ts`, `undo-across-open.spec.ts`) exercise §2x's cross-document case, not the
Delete key.

**Residual, and it belongs to §2ab:** off-sheet recalculation and the load path are not spill-aware
(the LOAD half is FIXED — §3be restores the map from the file rather than making the load path
spill-aware; the OFF-SHEET half stands)
(`reevaluate_formula_cell` is the only function in the crate that ever WRITES `spill_ranges`), so a
spill torn down on a background sheet does not come back until that sheet is edited while active. This
pass confirmed §2ab independently and added a running reproduction to it; see the addendum there.


### 2z. A slicer's computed properties come back from a reload RESTORED AND DEAD — the property is there, the formula is there, and the cell it names can never move it again (2026-08-10) — **FIXED**, and the sibling sweep it triggered is below

`restore_slicers` (`persistence.rs`) put `slicer_state.computed_properties` back and never rebuilt
`computed_prop_dependencies` / `computed_prop_dependents`. Re-evaluation
(`slicer::computed::re_evaluate_slicer_computed_properties`) is driven **entirely** by that reverse
index: it looks the changed cells up there and re-evaluates nothing it does not find. So a restored
property was present in the store, listed in the dialog with its formula, and inert.

**Measured**: add a computed property `headerText "=DA1"`; edit DA1 — the header follows. Save,
File ▸ New, reopen — the property is restored intact, and editing DA1 **never updates the header
again**. Nothing errors; nothing is marked stale; the only symptom is a formula that has quietly
stopped being a formula.

**How it was found, and why that matters more than the fix.** The AppState twin,
`computed_properties::restore_computed_properties`, rebuilds *its* index on the same load path, in a
block whose comment says so out loud. Two sibling functions, one file apart, doing the same job for
the same feature — one of them re-indexing and one not. Reading them side by side is the whole
technique; no test and no type could have said it, because both functions individually look correct.

**The fix removes the ability to make the mistake, rather than adding the missing line.** Properties
and their index are now installed by ONE function,
`slicer::computed::install_restored_computed_properties`, which both restore paths call — `.cala`
load (`restore_slicers`) and `.calp` materialization (`calp_commands::materialize_pulled_slicers`).
A future edit cannot restore one half without the other because there is only one half to call.
`restore_slicers` also now CLEARS the index before rebuilding, which it never did: workbook A's
reverse index used to survive into workbook B, so an edit in B could re-evaluate a property belonging
to a document that was closed.

Two smaller things fell out. `restore_slicers` takes plain `&SlicerState` / `&AppState` instead of
`State<T>` — a `tauri::State` cannot be built outside a running app, and a defect provable only by
running the real restore has to be reachable from a unit test. And `materialize_pulled_slicers`
inserted computed properties with no index too; in practice `sanitize_distributed_slicers` strips
them first (publisher-authored formulas never materialize on a subscriber), so it was a dead copy of
the same defect — now routed through the same installer so it cannot wake up.

Four regression tests in `app/src-tauri/src/slicer/tests.rs`, all four verified to FAIL on the
pre-fix behaviour (the index rebuild was disabled and they were re-run):
`a_restored_slicer_computed_property_still_re_evaluates` (behaviour: the header really moves),
`restore_rebuilds_the_reverse_index_under_the_cell_key` (the key shape, so an index built with wrong
keys is distinguishable from no index), `restore_clears_the_previous_documents_index`, and
`slicer_property_and_cell_property_restore_alike` — which asserts the two sibling paths agree, i.e.
pins the comparison that found this so a third property family has a shape to copy.

**THE SIBLING SWEEP — every restore path checked for the same shape** ("a restored collection whose
derived index is not rebuilt"). Walked `fn restore_*` across the app crate plus every non-`Persisted`
`AppState`/`SlicerState`/`PivotState` field that is derived rather than loaded:

| derived state | rebuilt on open? |
|---|---|
| slicer `computed_prop_dependents` / `_dependencies` | **NO — this item** |
| AppState `computed_prop_dependents` / `_dependencies` | yes, `restore_computed_properties` |
| formula `dependents` / `name_dependents` / stripe + cross-sheet maps | yes, `rebuild_all_dependencies` after load |
| `writeback_index` / `writeback_declarations` / `model_writeback_declarations` | yes, `rebuild_writeback_index_deferring_http` |
| `table_names` (name -> table) | yes, `restore_tables` builds both halves |
| `auto_filter_id` on tables | yes, `relink_autofilter_owner`, per §AutoFilter-identity |
| pivot `protected_regions` | yes, `update_pivot_region` in `restore_pivot_definitions` |
| report `protected_regions` | yes, `reregister_report_region` per saved report |
| BI query `protected_regions` | n/a — the owning `active_queries` are session state and go with them |
| `id_registry` | yes, re-seeded from the override layer |
| package BI connections | **NO — §2aa** |
| `spill_ranges` / `spill_hosts` | yes (2026-08-10, §3be) — `restore_spill_map_on_load`, from the extent the file now stores. **Not "rebuilt": RESTORED.** The one entry in this table that was never derivable, which is why it stayed empty for so long |

Two of the twelve were wrong. Both are written up below.

### 2aa. A subscribed `.calp` report cannot resolve its model after save + reopen — there is no path from a reopened subscriber workbook back to a live model at all (2026-08-10) — **FIXED**, design recorded

`capture_local_bi_connections` skips package connections when saving a `.cala`, deliberately and
correctly: a package's model belongs to the publisher and travels in the `.calp`, and embedding a
copy in every subscriber's file would mean a subscriber's workbook could serve a model no publisher
ever signed. What was missing is the other half — nothing ever put them back.

**Measured on a saved subscriber workbook.** Reopen -> `bi_get_connections` = **0** (the subscription
ledger itself restores fine). `calp_refresh_data` -> `{sourcesRefreshed: 0, needsConfiguration: […]}`
and still 0 afterwards, because refresh only ever **updates** a connection that already exists. Only
`calp_pull` and `refresh_embedded_data_sources` (reachable solely when a NEWER version exists) ever
created one. Every BI pivot in the report pointed at `ConnectionId::ZERO`.

There was even a comment in `load_embedded_data_sources` asserting it "runs on the OPEN path
(restoring package connections from the file)". It did not. The comment described an intention with
no implementation behind it — which is exactly how a gap this size stays invisible in review.

**THE DESIGN DECISION.** Re-materialize on open from the **subscription ledger** (which package,
which registry, which resolved version) plus the **local package cache**, through a new
`calp::pull::load_verified_data_sources` that runs the SAME three gates `pull` runs, in the same
order, under `PinPolicy::RequirePinned`:

1. `verify_and_load_manifest_via` / `load_pinned_manifest_via` — Ed25519 signature over the single
   trusted manifest copy, against the publisher key **this machine already pinned**.
2. `check_min_app_version`.
3. `verify_version_artifacts_via` — every artifact, including the `models/{id}/model.json` the
   restore then reads by path, hashes to the digest the signed manifest published, and nothing
   unlisted was dropped into the version directory after publish.

The data-source resolution itself is **extracted out of `pull` and shared**, so restore and pull
cannot resolve a model artifact differently.

**This adds a restore; it does not weaken the rule that only a pull creates a package connection.**
That rule was deliberate and still holds. `RequirePinned` makes first contact a hard error, so this
can never create a connection for a package this machine never subscribed to, can never mint a pin,
and can never advance a version — it re-materializes exactly the version the ledger says the user
already accepted. The threat it must not become is precise and was the reason to think hard here: a
`.cala` arrives **by email**, and it names a package and a registry of its author's choosing. Under
`PinOnFirstUse` this restore would have been a way to make the recipient's machine trust a publisher
it had never heard of, silently, by opening a file. That is the same hole the writeback rebuild was
hardened against, and it is why the restore is not a trust decision.

**The three failure modes, answered rather than assumed:**

* **Package missing / registry gone / version deleted / offline** — the manifest read fails, the
  subscription is skipped, **no connection is made**. The workbook still opens with the last pull's
  cells (they are in the `.cala`) and its pivots report no connection, exactly as before. Nothing
  stale is presented as live.
* **Signature no longer verifies / publisher key changed / an artifact was tampered with** — skipped,
  with **no fallback to the unverified bytes**. A subscriber that cannot prove which model it has
  gets no model. This is the case the `.calp` integrity machinery exists for, so it is honoured, not
  bypassed.
* **HTTP registry** — skipped with **no network I/O at all**. Two independent reasons, and both had
  to hold: `local_artifact_path` returns `None` for a non-local transport, so a package connection
  has never materialized from an HTTP registry even on the pull path (nothing is lost that a pull
  would have given); and verifying artifacts over HTTP means downloading every artifact behind a
  30-second-timeout blocking read, on the open, before a cell is drawn — the precise hang
  `rebuild_writeback_index_deferring_http` exists to avoid.

**And it is not silent.** `state.package_connection_restore_skips` records every non-silent skip and
`calp_get_package_connection_skips` surfaces it, with a per-reason sentence in the Subscriptions
pane — modelled on the writeback-skip disclosure and for the identical reason: without it, "this
package has no data source" and "this package's model could not be verified on this machine" are the
same observable state, a pivot quietly reporting no connection. The reason vocabulary is one shared
classifier (`writeback_skip_reason` renamed to `calp_skip_reason`) so the two on-open registry walks
cannot answer the same question in two dialects.

Placement matters and is pinned by a test: the restore runs AFTER `restore_distribution_user_files`
(it reads the ledger that call restores) and after `load_pending_roles` (so a restored package
connection picks up its saved "view as" RLS role, as the pull path does). BI pivots are re-pointed
through a single `rebind_bi_pivots_to_connections`, called twice from two disjoint id spaces that
share one field — local connections keyed by saved connection uuid, package connections keyed by
package data-source id.

Four tests in `core/calp/tests/lifecycle.rs`: the model resolves after a reopen **and to the same
artifact the pull resolved**; an unpinned package is refused **and the pin store stays empty**; a
tampered model is refused; a missing version fails cleanly rather than being reported as tampering.
Five more in `writebackSkipDisclosure.test.ts` pin the disclosure surface and that the restore is
actually wired into `open_file` in the right order.

**FOUND ALONGSIDE, AND FIXED: three `.calp` commands read the version manifest with no signature
check at all** — `calp_refresh_data`, `calp_save_data_source_config`, `calp_get_data_sources` all
called `registry.get_version_manifest(...)` directly. The worst is `calp_refresh_data`: it takes
`ds.server` / `ds.database` from that unverified manifest and opens a database connection to them,
sending either a saved connection string or the user's Windows identity via SSPI. Anyone able to
write the registry directory — a shared folder, a synced drive — could repoint a subscribed
package's data source at a host they control and harvest credentials on the next Refresh, with no
signature to break and nothing on screen to notice. All three now go through
`load_pinned_manifest_via`, the same gate the writeback rebuild uses.

Four other `get_version_manifest` call sites were reviewed and left: `calp_browse_registry` is
pre-trust discovery, and `require_publisher` / `refresh_rollup_if_publisher` /
`calp_region_response_status` read the manifest's asserted `publisher_key` only to ask whether THIS
machine holds the matching private key — an authorization question about the local profile, not a
trust statement about the package's contents. Worth a second opinion from whoever owns the writeback
authorization model, but not this pass's call.

### 2ab. `spill_ranges` / `spill_hosts` are reset when a document is replaced and never REBUILT — so a reopened workbook's dynamic arrays have no spill protection, and touching the formula turns it into `#VALUE!` (2026-08-10) — **FIXED 2026-08-10 (§3be), and NOT the way this section and §3bb recommended**

> **The recommendation in this section and in §3bb was wrong, and the reason it was wrong is a
> factual claim about Excel that nobody had checked.** Both said: spilled cells are derived state,
> Excel does not persist them, so stop persisting them and let a load-time recalculation re-spill.
> Excel persists them, AND it persists the array's EXTENT alongside them (`ref` on
> `<f t="array">`), and it recomputes neither on open. The fix that shipped therefore adds the
> extent to `.cala` (`format_version` 7) rather than removing the values. Full account and the
> verification in **§3be**; everything below is the finding as it stood, kept because the
> reproduction is still exactly right.
>
> Two names below are stale by design: the characterisation test
> `a_reloaded_workbook_has_no_spill_map_and_the_origin_collapses_2ab` was INVERTED and renamed
> `the_restored_spill_map_is_what_keeps_a_reloaded_origin_alive_2ab` (it still asserts the
> collapse for an UNOWNED array, so the restore stays visibly load-bearing), and the three
> `EXEMPT` reasons quoted below were rewritten to say what is now true.

The second miss from §2z's sweep, and the one that corrects a claim this register already makes.

`reset_document_scoped_stores` clears both spill maps (§2x, correctly — a stale entry from the
previous document destroys cells in the new one). Nothing on the open path fills them back in. A
`.cala` stores the spilled cells as ordinary values with no `ast`, so after a reload the only record
that A2:A4 belong to A1's array — the maps — is empty.

**§2y states the opposite and should be corrected when this is fixed.** It says re-opening "rebuilds
the spill map from the restored formulas, so `spill_ranges` comes back EMPTY and the cells are
editable again". `spill_ranges` does come back empty and the cells are editable again — but because
nothing rebuilt it, not because something did. §2y read the right observation off the wrong cause,
which is why the consequences below were never noticed.

**Reproduction** (code-level; not yet run against the live app because `commands/data.rs` is being
rewritten by the spill-census work in flight — re-verify against that before fixing):

```
1. A1 = "=SEQUENCE(4)"                  A1:A4 -> 1 2 3 4,  spill_ranges [{origin 0,0 -> 3,0}]
2. Save, close, reopen
3. get_spill_ranges                     -> []            <-- no spill border, nothing protected
4. Type into A2                         -> ACCEPTED      <-- Excel refuses this
5. Re-enter the same formula in A1 (or edit any precedent so A1 re-evaluates)
                                        -> A1 becomes #VALUE!
```

Step 5 is the sharp end. The re-evaluation path tears down "the range this cell used to own" from
`spill_ranges` first — which is empty — so the restored literals in A2:A4 are still sitting there
when the occupancy check runs. `is_own_spill` consults `spill_hosts`, also empty, so they read as
foreign data and the spill is blocked. A working array formula becomes an error purely by being
touched after a reload, and step 4 means the user may have already overwritten one of its cells
without being stopped.

**Why it is filed rather than fixed.** Rebuilding the maps means re-evaluating every array formula
on load and writing its spill — that is a recalculation on the open path, which is a product
decision (open cost vs. correctness) and must go through the shared entry points the recalculation
census guards, not a private loop in `open_file`. It also collides directly with the spill-map
census work currently in flight in `commands/data.rs` / `spill_map_tests.rs`, whose `EXEMPT` list
already names `open_file` with the reason *"document replacement: `reset_document_scoped_stores`
clears both spill maps for the outgoing document"* — true, and it covers only the outgoing half. The
INCOMING half is this item, and the exemption's wording should be narrowed when it lands so it stops
reading like full coverage.

---

#### Confirmed independently by the §2y closing pass, with the reproduction now RUNNING (2026-08-10)

The §2y pass reached this from the other end of the same question — §2y is "who tears the map DOWN",
this is "who builds it UP" — and arrived at the same place, so both halves of the sweep now agree.
Four things to add.

**1. The reproduction is no longer code-level.** It runs, in-process, as
`commands/spill_map_tests.rs::a_reloaded_workbook_has_no_spill_map_and_the_origin_collapses_2ab`. It
reproduces the reload STATE rather than doing file I/O — the two things that make it are the maps
being empty and the spilled values being present as plain cells, which is exactly what `open_file`
leaves behind — then drives the real cascade and asserts the `#VALUE!`. It is a CHARACTERISATION
test: it asserts today's broken behaviour so this section cannot drift, and **its failure messages
say so** ("if this now holds an entry, the load path rebuilds the spill map and §2ab is FIXED —
invert this test").

**2. The blocking mechanism is pinned separately, so the two sections cannot rot apart.**
`restoring_spilled_literals_beside_a_restored_origin_is_what_blocks_the_respill` asserts that a
formula spilling onto occupied cells it does not own reports `#VALUE!`. §2y's fix *depends* on that
rule (it is why the swallowed spill cells get no undo entry) and this section's step 5 is the same
rule firing where nobody wants it. If it ever changes, both fail loudly.

**3. It is not only the OPEN path — F9 has it too, and that widens the fix.** `run_calculation_pass`
and `recalculate_sheet_values` have no spill handling whatsoever; `reevaluate_formula_cell` is the
only function in the crate that ever writes `spill_ranges`. So:
* pressing F9 does not repair a reloaded workbook, and cannot;
* the same blindness is why `recalc_after_off_sheet_write` cannot restore a spill on a BACKGROUND
  sheet, which is the residual §2y's fix knowingly leaves behind (a spill torn down off-sheet stays
  down until that sheet is edited while active).
A rebuild that lives in the shared whole-sheet pass therefore fixes three things at once — open, F9,
and off-sheet — which is an argument for putting it there rather than in `open_file`.

**4. The `EXEMPT` wording was narrowed, as this section asked.** `open_file`'s entry in the spill
census now reads: *"document replacement: `reset_document_scoped_stores` clears both spill maps for
the outgoing document. It does not REBUILD them for the incoming one — see §2ab and
`a_reloaded_workbook_has_no_spill_map_and_the_origin_collapses_2ab`."* `run_calculation_pass` and
`recalculate_sheet_values` carry the same pointer.

**One correction to step 4 of the reproduction above, measured on the fixed build.** "Type into A2 ->
ACCEPTED" is right after a reload, and it is right for the reason given (the maps are empty). But it
should not be read as a general statement that a spilled cell can be typed over: inside a live
session it is refused, and §2y's pass extended that refusal to the seven commands that could
previously reach a spilled cell without asking (`fill_range`, `merge_cells` ×2, `replace_all` /
`replace_single` ×2, `clear_range_on_sheets`, `update_cell_on_sheets`). The hole in step 4 is
specifically the reload's empty map, not a missing guard.


#### Re-verified ON THE RUNNING APP (2026-08-10, the §3bd live-proof pass) — still OPEN, and F9 is worse than this section says

Driven through the real backend on a cold build, `.cala` written and reopened for real (not a
reproduced load STATE). `EA5 = 4`, `EB5 = "=SEQUENCE(EA5)"`:

```
1. live                       EB5:EB8 -> 1 2 3 4      spill_ranges [{origin 4,131 -> 7,131}]
2. save, File > New, reopen   EB5:EB8 -> 1 2 3 4      spill_ranges []          <-- looks fine
3. set EA5 = 4  (the SAME value)
                              EB5     -> #VALUE!      spill_ranges []
                              EB6:EB8 -> 2 3 4        (orphan literals from the file)
4. Calculate Now              EB5:EB8 -> 1 2 3 4      spill_ranges []          <-- STILL empty
5. set EA5 = 4 again          EB5     -> #VALUE!      spill_ranges []
```

**Two corrections to the account above.**

**(a) The triggering edit does not have to change anything.** Step 3 writes `4` over a cell that
already holds `4`. Re-evaluation of the origin is enough; the user has not altered a single value in
the workbook and the array dies.

**(b) "Pressing F9 does not repair a reloaded workbook, and cannot" is half right, and the half that
is wrong is the dangerous half.** `Calculate Now` DOES put readable numbers back on the grid — the
origin re-evaluates and the trailing cells still hold the literals the file restored — so the block
*looks* repaired. It is not: `spill_ranges` is still empty, and the next touch of any precedent
collapses it again (step 5). Worse, the block only looks right here because the restored literals
happen to equal what the array would produce. Change `EA5` to a different length and step 4 leaves
STALE LITERALS sitting under a live origin, presented as that origin's array — a wrong answer with
no error on it, which is a worse outcome than the `#VALUE!` it replaces.

So the user-visible cycle on a reopened workbook is: *fine -> touch anything -> `#VALUE!` -> press F9
-> looks fine -> touch anything -> `#VALUE!`*, indefinitely. Nothing in that loop tells them the
array stopped being protected.

The fix and its cost are unchanged (rebuild on load, or stop persisting spilled cells and let the
load recalculation re-spill them — a `format_version` decision, hence an owner call). What changes is
the priority argument: this is not "no spill protection after a reload", it is "a dynamic array that
breaks on the next keystroke and cannot be repaired from the UI".


### 2ac. Undo and Redo were NEVER disabled — anywhere. The app offered an undo it did not have (2026-08-10) — **FIXED**

**The finding is not mine; §3ax(1) made it while writing `undo-across-open.spec.ts`, and filed it as a
"real (small) product gap".** The Home tab rendered `undo`/`redo` as plain `<Button>`s with no binding
to `get_undo_state`; the Edit menu items carried no enablement; and nothing anywhere in `app/src` or
`app/extensions` read `canUndo` for a UI state at all. Re-measured before touching anything:
`rg "canUndo" app/src app/extensions` returned the tauri-api wrapper's type declaration and nothing
else. Excel greys both out on an empty stack, and the owner's standing rule is Excel parity.

**Why this is more than cosmetics.** The press on an empty stack is not merely ignored — until §2x
landed it was the gesture that destroyed a cell of the open workbook with a value from a document the
user had closed. §2x fixed the leak; the affordance still says "there is something here to undo" when
there is not, which is the app asserting something false about its own state.

**THE FIX IS ON THE STORE, NOT AT ~100 CALL SITES, and the argument is `DirtyFlag`'s one store over.**
`AppState::undo_stack` is now `undo_history::UndoHistory` instead of `Mutex<UndoStack>`: `Mutex`-shaped
(`lock()` returning a `Result` whose error is `Debug + Display`), so **all 97 existing `.unwrap()`,
`.map_err(|e| e.to_string())?`, `if let Ok(..)` and `let Ok(..) else` call sites across 30 files are
unchanged**, and the guard compares `(can_undo, can_redo)` at acquisition against the same pair at
release. A transition emits `document:undo-state-changed`. Nothing has to remember anything, and a
future writer cannot bypass it without replacing the field's type.

* **ONLY TRANSITIONS.** A 10 000-cell paste that pushes one transaction onto a non-empty stack emits
  nothing; typing into ten cells in a row emits at most one event, on the first.
* **READS ARE FREE**, and that is load-bearing rather than an optimisation: the frontend calls
  `get_undo_state` from inside the listener this event feeds, and a read that announced would be an
  infinite loop. Same trap `DirtyFlag` documents.
* **The guard releases the mutex BEFORE announcing**, for the same reason `DirtyGuard` does.

**AND `document:dirty-changed` WAS NOT ENOUGH — checked rather than assumed, which is why this is its
own channel and not a second subscriber to that one.** The two states move independently in both
directions: undoing back to depth 0 leaves the document dirty, so the next edit re-arms `canUndo` with
no dirty transition to ride on; and an edit after an undo clears the redo stack (`canRedo` true ->
false) while the document was already dirty and stays dirty. Either one leaves a ribbon button lying
about what pressing it will do.

**The frontend half is one bridge and one store, mirroring `dirtyStateBridge`.**
`shell/undoStateBridge.ts` re-emits onto `AppEvents.UNDO_STATE_CHANGED` (74th event); `@api/undoState`
holds ONE cached answer that both consumers read, so a greyed ribbon button can never sit above an
enabled menu entry for the same command. The Home tab binds `disabled`/`aria-disabled` on exactly the
two ids; `StandardMenus` patches the two Edit items through `updateMenuItem` (in place — re-registering
would rebuild Edit from this extension's own literal and drop anything another extension had
contributed to it) and unsubscribes on deactivate.

**Both fail OPEN, at both hops, and that is a decision.** A malformed payload and a backend that
refuses to answer both yield `{canUndo: true, canRedo: true}`. A wrongly-ENABLED button costs a press
that does nothing — exactly the behaviour that shipped until now. A wrongly-DISABLED one takes away an
undo the user really has and gives them no way to argue with it.

**The seed read is not a poll.** The first subscriber triggers one `getUndoState()`, because a listener
that mounts BETWEEN transitions has no event to learn from; after that the store lives on events, and
the bus subscription is dropped with the last subscriber.

**BLAST RADIUS — what legitimately changed, and what did not.**

* **`undo-across-open.spec.ts` REQUIRED a change, and it is the register's own prose that was wrong.**
  Its `pressRibbon` helper carried a doc comment stating as measured fact that "Calcula's Undo/Redo
  affordances are NEVER disabled", and it called `btn.click()` unconditionally — which now times out on
  a correct build at the two sites where the stack is deliberately empty. The helper returns
  `"pressed" | "refused"` instead, and **the teeth are unchanged**: on a LEAKING build the freshly
  opened document still reports `canUndo`, so the button is enabled, the press happens and the byte
  oracle sees the corruption. On a correct build the refusal is now asserted, which is a second,
  independent statement of the same guarantee. The two sites inside the owning document assert
  `"pressed"` — a fix that bought the spec by greying the button out would otherwise pass by doing
  nothing.
* **`ribbon-tabs.spec.ts` gained a `beforeEach`**, because the ribbon goldens now photograph undo
  availability: a capture after a spec that ran `new_file` shows two greyed buttons and one taken
  mid-suite shows two live ones. One write to a scratch cell the spec already owns (`X10`) pins the
  stack non-empty. Deliberately not undone afterwards — an undo would light Redo up instead, which is
  the same non-determinism from the other side.
* **NOTHING ELSE.** `menu-interactions.spec.ts` only asserts the Edit items are visible (`toBeVisible`
  is true of a disabled button), and no spec anywhere clicks Edit > Undo through the menu
  (`rg "clickMenuItem" | rg -i "undo|redo"` is empty). The `undo-redo.spec.ts` and oracle routes drive
  the Tauri commands, which are untouched.

**Verification.** 6 Rust tests on the store (first edit announces; a second edit announces nothing;
a READ announces nothing; undoing the last entry announces both halves in one event; replacing the
stack wholesale — which is what `reset_document_scoped_stores` does — announces the reset; the payload
serialises `{"canUndo":…,"canRedo":…}`). 27 frontend tests across four new files. The Home-tab file
carries the counterweight that a NEIGHBOURING button is untouched, without which it would pass just as
happily on a component that disabled the whole group, and asserts that a disabled press does not reach
the handler at all. **Demonstrated firing:** removing `disabled={unavailable}` from the real component
fails 5 of its 7 tests.


### 2ad. The `.ok()` swallow — a repaired formula that would not re-parse was DELETED, silently (2026-08-10) — **FIXED**, and the operation now refuses the way Excel does

§3bc left this deliberately, with the reason: every *known* producer of unparseable text had been
fixed (the 47 debug-formatted function names, the sheet-name quoting rule, the `""` escape), so the
swallow had nothing left to swallow. That is an argument about today's producers, not about the
mechanism — and the mechanism is **why none of those defects was ever noticed**. Each of them
produced text that would not lex; each was turned into `ast = None`; and `ast = None` on a cell that
still holds its last computed value is *a stale number with an empty formula bar and no error
anywhere*. There is nothing for a user to report.

**Where it was.** `repair_all_formulas` (every sheet rename and every sheet delete, over every
formula on every sheet) and `apply_names_to_formulas` (Excel's Apply Names), both spelling
`parser::parse(&text).ok().map(Box::new)`.

**THE SHAPE, decided by the standing parity rule.** Excel refuses the operation rather than
corrupting the workbook — rename a sheet in a way Excel cannot carry the formulas through and Excel
tells you and does nothing. So:

* `repair_all_formulas` is **plan-then-commit**. Every repaired formula is parsed BEFORE any cell is
  written; one that cannot be read back returns a `FormulaRepairRefusal` and **nothing is written at
  all** — not even the formulas that would have survived, because a half-applied rewrite is the worst
  outcome available and nothing records which half happened.
* The refusal **names the sheet, the cell and the text** (`Cannot rename sheet 'Data' to 'Facts': the
  formula in Data!B4 would be rewritten to '=SUM(', which cannot be read back (…). Nothing was
  changed.`) and reaches the user: `SheetTabs` already surfaces a rejected `renameSheet` /
  `deleteSheet` through `alertAsync`.
* It is **deterministic**. `Grid::cells` is a hash map; the walk is sorted, so two runs of the same
  refused operation name the same cell. A refusal that moves is a bug report nobody can reproduce.

**The hard half was WHERE to refuse.** `delete_sheet` runs the repair *after* it has removed the
sheet from a dozen index-aligned stores; "the repair wrote nothing" would leave a workbook with the
sheet gone and its formulas un-repaired. So both callers **pre-flight** it —
`check_formulas_repairable` asks the question under READ locks, before the first mutation and before
the `DocumentEffect::mutates` token exists, and returns the refusal from there. Two subtleties the
first version got wrong, both now in the helper (`sheets.rs::check_workbook_repairable`):

1. `state.grid` is the AUTHORITATIVE copy of the active sheet and `grids[active]` can lag behind it
   (BUG-0016). Checking `grids` alone misses the formula the user typed since the last sheet switch —
   which is the formula most likely to be unusual.
2. The sheet being DELETED is skipped: its formulas are about to cease to exist, so refusing the
   delete on account of one of them is a refusal the user cannot act on.

**`apply_names_to_formulas` got the same treatment plus a second fix.** It read `formula_string()` —
the DISPLAY form — which collapses a named LAMBDA's `__INVOKE__("MyFn", <lambda>, args)` marker to
`MyFn(args)`; re-parsing that yields `Custom("MYFN")` with no lambda attached. Applying a name to a
range containing such a call destroyed it. It now reads the raw form, parses every replacement before
writing any of them, and refuses the whole command with the offending cell named. Its
`DocumentEffect` token moved behind the last refusal as well (`lock_pending` / `authorize`, the
instrument `rename_sheet` uses): asking Apply Names about a workbook it has nothing to do to no
longer marks the document modified.

**Tests.** 6 unit tests + a census. The census `every_caller_of_the_workbook_formula_repair_pre_flights_it`
fails by name when a third caller appears without a pre-flight, and
`the_pre_flight_census_can_see_a_caller_that_forgets` is its sabotage. The counterweight
`a_reference_to_a_deleted_sheet_still_becomes_a_ref_error` exists because refusing must not have been
bought by making the repair timid.

---

### 2ae. The same two defects on THIRTEEN other call sites — inserting a row destroyed a named-LAMBDA call, renaming a table destroyed it too, and a sort could delete a formula outright (2026-08-10) — **FIXED**, and both halves are now censused

Found by asking §2ad's question about its neighbours rather than about itself. The sheet repair is
not the only place that reads a formula as TEXT, rewrites the references and stores the re-parse.
Eleven others do exactly that and had **neither** fix — and widening the census afterwards found two
more (below):

| where | what it does |
|---|---|
| `insert_rows_impl`, `insert_columns_impl`, `delete_rows_impl`, `delete_columns_impl` | shift every reference on every sheet |
| `off_sheet_structural_edit`, `shift_cross_sheet_formulas`, `shift_cross_sheet_formulas_for_off_sheet_edit` | the same, for formulas on OTHER sheets |
| `sort_range` (four arms: row-sort and column-sort, twice each) | Excel sort semantics — a moved formula keeps referring to its own row |
| `fill_range` | Ctrl+D / Ctrl+R |
| `relocate_cell_references` | cut and paste |

**THE REPRODUCTION** (`a_structural_rewrite_that_reads_the_display_form_destroys_a_named_lambda_call`):
a cell holding `=__INVOKE__("MyFn",LAMBDA(x,x*2),A5)` renders, in the DISPLAY form these sites read,
as `MyFn(A5)`. Insert a row above row 5 and the shifter produces `MyFn(A6)`, which differs from
`MyFn(A5)`, so the cell is rewritten — and `MyFn(A6)` re-parses as `Custom("MYFN")`, an unknown user
function. **The lambda is gone and the cell is `#NAME?`.** This is register §3ba finding 2 (renaming
a sheet destroys every named-LAMBDA call) on a far more common gesture; the §3ba fix was applied at
its own call site only.

**The fix is one pair of helpers in `commands/structure.rs`**, so a twelfth call site cannot get
either half wrong:

* `formula_to_rewrite(cell)` — the RAW form, marker intact.
* `store_rewritten_formula(cell, text, operation, row, col)` — parses, stores on success, and on
  failure **keeps the formula the cell already has** and logs at ERROR. `shift_cross_sheet_formulas`
  had already been written that way ("a formula we cannot re-parse is left exactly as it was rather
  than being silently blanked"); the other eleven had not caught up.

`fill_range` is the one EXEMPTION, with the reason: its `Err` arm writes `#VALUE!` into the target,
so the failure is visible in the grid, and there is nothing to keep — the source cell's own AST would
point at the wrong cells if it were carried into the target. Its log moved from `debug` to `error`.

**Both halves are censuses.** `no_structural_rewrite_swallows_a_parse_failure` (the store half, with
the one exemption named and reasoned) and `every_structural_rewrite_reads_the_raw_formula` (the read
half). The read census does not flag "mentions `formula_string`" — that method has legitimate uses in
the same functions — it reads BACKWARDS from each reference-shifter call to see where its input came
from, and both have sabotage tests.

**Then the census was widened, and it found two more sites with no shifter in them.** The narrow
census's population is "functions that call a reference-shifter", and the defect is not about
shifters — it is about rendering a formula, re-parsing the render, and storing the result. Stated
that way (`no_function_re_parses_the_display_form_and_stores_it_on_a_cell`, over
`commands/structure.rs`, `commands/data.rs`, `tables.rs`, `named_ranges.rs` and `lib.rs`), two more
came out:

* **`tables.rs`** — renaming a TABLE, and rewriting a table's structured references, both read the
  display form and stored what it re-parsed to. So renaming a table destroyed every named-LAMBDA
  call in any formula that mentioned that table. (The same file already handled the *parse-failure*
  half correctly, with the reason written down — "a re-parse failure must NOT be swallowed" — which
  is how a fix reaches one half of a class and not the other.)
* **`update_cell_on_sheets`** (write the same value to several sheets) rendered its freshly parsed
  input template back to text and parsed it *again* to build the engine AST. The template already
  held the tree; the round trip bought nothing and could only lose. It now uses the tree.

**What the widened census does NOT flag, checked deliberately:** the `parser::parse(...).ok()` in
`computed_properties.rs`, `slicer/computed.rs` and `persistence.rs`. Those derive a `cached_ast`
beside a stored formula TEXT that remains the authority — a failure loses a cache, not a formula, and
the text is still there to be re-parsed after a fix. That is why the census is written over "stores
an AST **on a cell**" rather than over "calls `.ok()`".

---

### 2af. The instrument four censuses read through was broken — it could not see `pub(crate) fn`, and one string literal made a 6,500-line function out of thirty (2026-08-10) — **FIXED**

Not a product defect; worse in one specific way. `free_function_bodies` is what the restamp census,
the pre-flight census and both §2ae censuses enumerate the crate with. Writing the new censuses made
it report two impossible numbers — "0 functions rebuild a grid from stored text" in a file with five,
and one offender in `commands/data.rs::update_cell_impl` for code that is not in it — and both were
the walker, not the crate.

1. **The spellings.** It searched `find("\nfn ").or_else(|| find("\npub fn "))`. `or_else` runs only
   when the first search finds nothing **anywhere ahead**, so in any file with a private `fn` after a
   `pub fn`, every `pub fn` before it was skipped — and its body attributed to whichever function the
   walker did find. `pub(crate) fn` and `pub(super) fn` were invisible outright, which is most of
   `commands/structure.rs`.
2. **The braces.** It counted `{` and `}` as raw bytes, including inside strings and comments.
   `commands/data.rs` contains a string with an unbalanced brace, so `update_cell_impl` swallowed the
   next 6,000 lines — thirty other functions — and every census reading it reported THEIR contents
   under ITS name.

**A census that names the wrong function is worse than no census**: the offender it prints does not
contain the offence, so the reader concludes the census is noise. The walker is now
string/comment/char-literal aware and finds the earliest declaration at the left margin whatever its
spelling, with two teeth tests (`the_function_walker_sees_every_spelling_of_a_free_function`,
`the_function_walker_is_not_fooled_by_a_brace_inside_a_string_or_a_comment`).

**Carry this:** the existing restamp census passed for two days while reading through both bugs. It
was not wrong about its two callers, but it could not have seen a third in `pub(crate)` form. When a
census is cheap, sabotage it on a fixture that contains every spelling of the thing it counts — not
just the spelling the crate happens to use today.

---

### 2ag. Sheet names were unvalidated at entry — F6's product half (2026-08-10) — **DECIDED AND FIXED** under the Excel-parity rule

§3bc left this as a product call. It is not one: the standing rule says Excel decides, and Excel's
rule is written down and narrow. **Nothing about the three names the hunt measured changes** —
`John's`, `Q1-2026` and `2026` are LEGAL in Excel, the renderer quotes them correctly since §3ba, and
refusing them would have been this register inventing a restriction Excel does not have. What was
missing is everything else.

**What Calcula accepted before:** anything but an empty name and an exact-case duplicate. `[`, `]`,
`*`, `?`, `/`, `\`, `:`, a leading or trailing apostrophe, 400 characters, `History`, and `sheet1`
beside an existing `Sheet1` — the last of which produced two sheets that every case-insensitive
lookup in the crate (`index_of_sheet`, the cross-sheet dependency keys) believed were one.

**The rule, in `app/src-tauri/src/sheet_names.rs`** — 1–31 characters (CHARACTERS, not bytes), none
of `: \ / ? * [ ]`, no leading or trailing apostrophe, not `History` (Excel reserves it for a shared
workbook's change-history sheet), and not a name another sheet already has **ignoring case**.

**ENTRY REFUSES; LOAD ACCEPTS AND CARRIES.** This is the half that needed deciding rather than
looking up. A workbook already on disk may hold a name the rule rejects — written before the rule, or
produced by an `.xlsx` / `.calp` publisher. Refusing it at load means refusing to open the user's
file, which trades a cosmetic problem for a total one. `open_file` therefore keeps the name exactly
as written and logs one line per workbook naming what it carried (`load_violation`); the rule applies
the next time the user renames that sheet. The corollary is that **addressing** such a sheet must
keep working, so the script host's `checkSheetRef` is deliberately looser than its `checkSheetName` —
a script can reach a sheet it could never create. Three existing frontend tests asserted the opposite
and were updated with the reason.

**GENERATED names never refuse; they COERCE.** `sanitize_sheet_name` is the same rule as a total
function, for names the app builds out of data — the pivot "Show Report Filter Pages" command names a
sheet after a field value, and there is no user to show a message to. `pivot/commands.rs` had its own
copy of Excel's character set and length limit, which had already drifted (it knew nothing about the
apostrophe or `History`); it now delegates. `unique_sheet_name` shortens the stem to make room for a
` (2)` suffix, because `format!("{} (2)", base)` on a 31-character base produces a name the new rule
refuses — "Duplicate Sheet" would have started failing on any sheet with a long name.

**Wired at every entry:** `add_sheet`, `rename_sheet`, `copy_sheet` (Rust, authoritative) and
`vSheetName` / `vSheetRename` (TypeScript, so a script gets a message instead of a raw backend error
string; it was 255 characters there and unlimited in Rust). The Rust gates were also **moved ahead of
`DocumentEffect::mutates`** in `add_sheet` and `copy_sheet`, which minted the dirty token before their
refusals.

**11 tests** in the module, including the pair that keeps the two halves honest:
`the_three_measured_names_are_accepted` (parity, stated as a test so nobody "fixes" it later) and
`a_legal_name_survives_the_quoting_round_trip` (what entry accepts, the serialiser must be able to
write into a formula that lexes again, and rendering that must be STABLE).

---

### 2ah. §2t's residual: the `.calp` overlay rebuilt formula ASTs by its own route and nothing restamped it — a distributed report showed `=BUDGETTOTAL` where the publisher wrote `=BudgetTotal` (2026-08-10) — **FIXED**, and the route is now censused

**Audited because the register said it was unaudited**, and it was broken. `restamp_workbook_name_casing`
had three callers — `open_file`, `rename_sheet`, `delete_sheet` — and the distribution paths are none
of them.

**The route.** A package stores every formula as TEXT. `persistence::Sheet::to_grid()` re-parses that
text, through the same lexer that upper-cases every bare identifier. So a publisher's `=BudgetTotal*2`
lands in the subscriber's workbook as `=BUDGETTOTAL*2` — §2t exactly, on a path §2t's fix never
reached. Five functions do it: `calp_pull`, `calp_refresh_apply`, `calp_reset_subscription`,
`calp_dev_subscribe` and `calp_dev_refresh`. In `calp_pull` the restamp runs after the pulled NAMES
are inserted, since the pulled names and the subscriber's own are both authorities for the spelling of
a formula on a pulled sheet.

**A SIXTH path with no `to_grid()` in it at all:** an override. `write_override_value` re-parses the
override layer's stored formula text, so an overridden cell shouted too. It restamps the one AST it
writes (`restamp_name_casing`) rather than the whole workbook, taking the name table BEFORE the grids
— the lock order `restamp_workbook_name_casing` already established.

**Censused, not listed.** `every_path_that_rebuilds_a_grid_from_stored_text_restamps_the_name_casing`
takes `.to_grid()` as the seam — it is the only way a `persistence::Sheet` becomes a `Grid` — so one
rule covers pull, refresh, reset, both dev paths and `open_file`, and a seventh rebuilder fails by
name. `the_override_write_restamps_the_name_casing_it_re_parses` is the second, narrow census for the
override route. Both have sabotage tests.
`rebuilding_a_grid_from_stored_text_is_what_shouts_a_defined_name` states the MECHANISM as a test, so
if the lexer ever stops upper-casing, the restamps are reported as dead code rather than left to rot.

---

### 2ai. A bare SHEET qualifier is upper-cased by the lexer and nothing restamps it — `=Data!A1` is stored and shown as `=DATA!A1` (2026-08-10) — **FIXED** (2026-08-11), as the third restamp

Found by a test written for §2ag: `a_legal_name_survives_the_quoting_round_trip` asserted an exact
round trip and failed on `Data`, the most ordinary name in the file.

**Reproduction (unit level, no app needed):**
```rust
let parsed = parser::parse("=Data!A1").unwrap();
assert_eq!(format!("={}", engine::ast_render::render_formula_raw(&parsed)), "=DATA!A1");
```
A QUOTED qualifier keeps its case (`='Q1-2026'!A1` round-trips exactly), so the two spellings
disagree with each other as well as with the sheet tab.

**Why it is not §2t.** §2t's restamp re-spells DEFINED NAMES from the Name Manager. The sheet table is
a second authority that nothing consults: `restamp_grid_name_casing` walks `NamedRef` nodes only. The
register already recorded the symptom once, at the end of the "Suggested order" section, as a
cosmetic residual found live ("a sheet name typed as `Sheet1!` is stored and shown as `SHEET1!`") —
this is the same thing, and it is reachable without typing a qualifier at all: any formula that
mentions another sheet shows it shouting.

**THE FIX**, taken with §2aj because they are the same lexer defect with different authorities.
`sheet_names::restamp_sheet_casing` walks `CellRef` / `Range` / `ColumnRef` / `RowRef` `sheet` slots
and both bookends of a `Sheet3DRef`, and re-spells only on an EXACT case-insensitive match against
the live list. `restamp_grid_sheet_casing` is the load half, gated by an allocation-free
`has_sheet_qualifier` walk so a workbook with no cross-sheet formula never reaches the renderer.

**The trap this section named is the one thing the implementation is built around.** A qualifier
naming a sheet that does not exist is left EXACTLY as it is — `official_spelling` returns `None`
unless a sheet by that name is really there — so a dangling reference cannot acquire a
plausible-looking sheet name it never had. `a_qualifier_naming_no_sheet_is_left_exactly_as_it_is`
pins that, and it is the test that would fail first if someone "simplified" the lookup.

**Three restamps, ONE call site each, and the census still guards it.** `restamp_workbook_name_casing`
now runs all three authorities in one pass over each grid (names from the Name Manager, tables from
the table registry, sheets from `state.sheet_names`), so the census that policed its callers polices
all three by construction rather than needing two more of itself. The `.calp` overlay's second route
is `WorkbookSpellings::restamp` — one struct holding all three authorities, so a caller cannot take
two and forget the third — and `the_override_write_restamps_the_name_casing_it_re_parses` now asserts
all three names appear.

**Verified:** `=Data!A1` keeps its casing through entry (`a_sheet_qualifier_is_stored_the_way_the_tab_spells_it`,
which also asserts it still resolves to 7), through a case-only sheet rename, and NOT through a
rename that leaves the qualifier matching nothing.


### 2aj. A structured reference is RESOLVED AT ENTRY and stored as an absolute range — `=SUM(Sales[Amount])` becomes `=SUM($A$2:$A$4)` and stops following its table (2026-08-11) — **FIXED** (2026-08-11), by D2's route, and it found two more defects on the way

Found while proving §3bi/F2 live. The nine `TableSpecifier` variants were going to be exercised by
typing them into cells; they cannot be. `split_entered_formula` calls `resolve_positional_refs`,
which splices every `TableRef` node into a plain `Range` **before the cell stores anything** — the
same shape as §3bf's `A1#`, one document over.

**Reproduction, on the running app (sv-SE, cold `tauri dev`):**

```
A1..A4 = Amount / 10 / 20 / 30 ; create_table "Sales" over A1:A4 with headers
type   C1 = SUM(Sales[Amount])
read   C1 -> display 60, formula "=SUM($A$2:$A$4)"     <-- not what was typed
type   A5 = 40   (a row under the table's data)
read   C1 -> display 60, formula "=SUM($A$2:$A$4)"     <-- Excel: 100, and the
                                                            formula still reads
                                                            =SUM(Sales[Amount])
```

**Two harms, and they are different.** The first is TRANSPARENCY: the formula the user typed is not
the formula the workbook keeps, and the formula bar shows the substitute. The second is
CORRECTNESS-by-parity: the stored form is a fixed rectangle in absolute coordinates, so it cannot
follow a table that grows, shrinks or is resized — the whole point of a structured reference in
Excel. Nothing warns.

**What it means for §3bi/F2.** F2's fix (nested Excel forms + the parser arm for `[[@a]:[@b]]`) is
still load-bearing and is still reachable — a **defined name's `refers_to`** keeps the specifier
verbatim, and `repair_named_ranges` re-renders every one of them on any sheet rename or delete. That
is the route the live proof uses (§3bj), and all nine round-trip. But the register should not go on
implying that a typed cell formula is one of F2's populations: it is not, because the specifier never
survives entry.

**FIXED, following D2 rather than inventing a shape.** The owner had already decided this exact
question for defined names ("do exactly as in Excel"), and Excel keeps a structured reference live in
exactly the same way, so the standing parity rule and the precedent point one way.

`split_entered_formula` no longer flattens the specifier: `stored` keeps `Sales[Amount]` and
`name_resolution::eval_ast` resolves it — against the table's CURRENT extent — on every evaluation.
Nothing rewrites the formula when the table grows; the same tree simply resolves to a different
rectangle. `app/src-tauri/src/table_deps.rs` is the new module and it deliberately MIRRORS
`name_resolution` function for function, so the two indirections cannot drift:

| defined names (D2)         | structured references (§2aj)      |
|----------------------------|-----------------------------------|
| `NameDependentsMap`        | `TableDependentsMap`              |
| `collect_names`            | `collect_table_names`             |
| `cell_reads_any_name`      | `cell_reads_any_table`            |
| `restamp_name_casing`      | `restamp_table_casing`            |
| `recalc_after_name_change` | `tables::recalc_after_table_change` |

**THE DEPENDENCY-EDGE DESIGN**, which is the half a stored reference is worthless without.

* **The table edge.** A table is not a cell, so it is in none of `dependents` / `column_dependents` /
  `row_dependents` / `cross_sheet_dependents`. `AppState::table_dependents` maps an UPPERCASE table
  name to the active sheet's formula cells that read it, maintained at the same four places the name
  edges are (`update_cell`, the batch writer, `fill_range`, `rebuild_all_dependencies_from_grid`) plus
  the two table commands that write formulas themselves. Like `collect_names`, it records an edge for
  a table that does not EXIST yet, so creating `Sales` turns every waiting `#NAME?` into a number.
* **A bare `[@Amount]` names no table**, and which table it means depends on the cell's position,
  which a later row insert can change. Resolving it at edge-registration time would be a second
  authority that can go stale, so it registers under `BARE_TABLE_KEY` and every table change adds
  that bucket to its seeds. It over-recalculates by exactly the cells that contain a bare this-row
  reference — cells inside a table — which is a rounding error against a structural change, and it
  cannot miss.
* **The CELL edges have to be re-derived too, and this is the half the name case does not have.**
  After a resize, `=SUM(Sales[Amount])` reads a row that is in no map; without re-deriving, the total
  would follow the resize ONCE and then never notice an edit to the row it gained —
  silently-right-then-silently-wrong, which is worse than the bug being fixed.
  `table_deps::refresh_reader_edges` re-extracts the readers' references through `eval_ast`. It is
  TARGETED, not `rebuild_all_dependencies`: this runs on `check_table_auto_expand`, i.e. on typing one
  row under a table, and a whole-sheet re-extraction on a per-keystroke gesture is not a trade worth
  making. It also runs in MANUAL calculation mode, because an edge is not a value.
* **A reader can reach a table through a NAME** (`MyRange` = `=Sales[Amount]`, then `=SUM(MyRange)`),
  and that cell's own AST says only `MyRange` — it is in no table bucket and `cell_reads_any_table`
  answers false for it. `recalc_after_table_change` parses each `refers_to` and asks which NAMES read
  a changed table, then seeds their readers as well. Without that step the indirection is a place
  stale values hide.
* **The ORDERING walks were the quiet half.** `build_workbook_plan` (F9), `workbook_circular_cells`,
  `recalculate_sheet_values` and `SheetDependencyIndex::build` all order from
  `extract_all_references`, which can see through neither a `NamedRef` nor a `TableRef` — so a
  structured reader sorted as an INPUT and computed from whatever the table's own formula cells held
  before the pass, an answer that depends on hash-iteration order. All four now go through
  `crate::stored_ast_references`, which expands first. **This was already true for defined names
  (D2's residual) and is fixed for both.**

**WHAT EXCEL DOES, and how it was decided.** Structured references are live and follow the table;
renaming a table rewrites every reference to it; renaming a table COLUMN rewrites every specifier
that names it; Convert to Range replaces each specifier with the equivalent cell reference and the
values do not move; an unresolvable specifier is `#NAME?`; and a table name is workbook-wide, so
`=SUM(Sales[Amount])` is legal from any sheet. Each of those is now a test.

**Delete behaves as Excel's Convert to Range**, verified rather than assumed: Excel has no gesture
that removes a table object and leaves the cells, so `delete_table` shares
`rewrite_table_refs_to_ranges` with `convert_to_range` — every dependent specifier is frozen into the
rectangle it named at that instant, so no value moves. The registry-level fact underneath it (a
specifier naming a table that is gone reports an ERROR, not a stale number) is pinned separately, so
a future caller that forgets the flattening fails loudly.

**THE TWO DEFECTS THIS FOUND**, both of which the entry-time resolution had been hiding:

1. **A column rename destroyed its readers.** While the specifier was flattened at entry, retyping a
   header could not break a formula — the formula held `$A$2:$A$4` and had forgotten the column ever
   had a name. With the specifier stored, `rename_table_column` AND `enforce_table_header` (the grid
   route, which is the one users actually take) had to carry the readers over, and now do, through
   one shared `rename_table_column_in_formulas`. A bare `[@Amount]` is rewritten only when the cell is
   physically inside the table being renamed.
2. **§2al, its own section below: a cross-sheet structured reference read the WRONG SHEET.**

**Two commands stopped freezing their own formulas.** `write_table_formula_cell` stored the RESOLVED
rectangle, so a totals row was pinned to the extent the table had when the function was chosen —
adding a row left `SUBTOTAL(109,$A$2:$A$4)` summing four cells of five. `set_calculated_column` stored
the per-row FLATTENING, so a calculated column stopped following its own table the moment it was
written and the formula bar showed coordinates for a formula the user wrote in column names. Both now
store the structured form.

**Casing came with it (§2t, for tables).** The lexer uppercases the table name and
`parse_bracket_content` builds the column name out of identifier tokens, so `Sales[Amount]` parses as
`SALES[AMOUNT]`. `restamp_table_casing` re-spells both from the table's own registry and columns, at
entry, at load, and on the `.calp` overlay path. A reference to a table that does not exist is left
exactly as typed — there is no authority to re-spell it from.

**The censuses learned one new word, and it is pinned.** `recalc_after_table_change` is not a second
cascade: it seeds `recalc_after_active_sheet_bulk_rewrite` and `recalc_after_off_sheet_write` and
nothing else, the way `recalc_after_name_change` does. Three censuses (recalculation, spill-map, D3
table-seed) now accept a call to it — so
`the_table_recalculation_reaches_the_shared_cascade` asserts from source that it really does seed
them, closing the same hole `DELEGATING_HELPERS` was written to close for `write_table_formula_cell`.

**24 tests** in `app/src-tauri/src/commands/structured_ref_tests.rs` (entry, casing, growth, shrink,
the gained row becoming a precedent, off-sheet readers, rename, delete, create-resolves-the-waiting,
edge add/drop/clear, edge survives a sheet switch, bare refs, render/parse/restamp round-trip over
five specifier forms, F9 ordering, the three §2ai cases, and two source-level wiring censuses) plus 8
in `table_deps.rs`.

**RESIDUALS, stated rather than hidden.**

* ~~`find_table_at_cell` matches a bare `[@Col]` by ROW RANGE ONLY, so a formula in a far column on
  the same rows as a table resolves against that table instead of reporting `#NAME?` as Excel does.
  Pre-existing, and it needs `current_col` on `TableRefContext` — a 20-site change on top of this
  one. Not taken here.~~ **FIXED 2026-08-11 at integration — see §2ar.** The threading was 24 sites,
  not 20, and narrowing the match broke exactly one existing test, for the defect's own reason.
* SPILL references are still resolved at entry (§3bf). That is deliberate and now the only remaining
  member of the class: resolving `A1#` at evaluation needs `state.spill_ranges`, a Mutex the evaluator
  would take once per evaluated dependent.

### 2ak. `=1E3` was not a formula — the lexer had no exponent rule, so a scientific literal was stored as TEXT with no error anywhere (2026-08-11) — **FIXED**

Found by CHECKING the register's own "remaining" list on the running app instead of restating it. The
probe for S6 typed `=1E308*10` to see whether numeric overflow answers `#NUM!`; it answered nothing,
because the cell was not a formula at all.

**The reproduction, on the running app:**

```
type  =1E3        -> the cell displays the string "=1E3", formula bar empty
type  =2.5E2+1    -> displays "=2.5E2+1"        (Excel: 251)
type  =SUM(1E2;2) -> displays "=SUM(1E2,2)"     (Excel: 102) -- and note the
                     separator has been locale-converted, so the text stored is
                     not even the text the user typed
type  1E3         -> 1000                        <-- the NUMBER parser was fine
                                                     all along
```

`lexer.rs::read_number` consumed digits and one dot and stopped. `1E3` therefore lexed as
`Number(1)` followed by `Identifier("E3")` — two tokens with no operator between them — the parse
failed, and `update_cell`'s "not a formula, then it is text" fallback stored the input verbatim. This
is the silent class this register keeps cataloguing, reachable by typing a number the way half of
science writes one, and it had no test anywhere: the parser crate had 100 tests and none of them
contained an `E`.

**The fix, and the one thing that makes it non-trivial.** `E` also begins a column name, so `1E3`
must become `1000` while `E3` must stay a cell reference. `read_number` now peeks an exponent on a
CLONE of the character iterator and advances the real one only when an optional sign is followed by
at least one digit. `=1E`, `=1E+` and `=1EUR` therefore consume nothing and lex exactly as before.
Verified live after a rebuild: `=1E3` -> 1000, `=1e3` -> 1000, `=2.5E2+1` -> 251, `=1E-3` -> 0,001,
`=1E+3` -> 1000, `=SUM(1E2;2)` -> 102, and the counterweights `=E3` -> 7, `=SUM(E3:E4)` -> 10,
`=E3*2` -> 14.

**4 tests** in `core/parser/src/tests.rs`: the six literal forms each lexing as ONE token; the three
`E`-that-is-not-an-exponent refusals; the parse-level check that `2.5E2+1` is `250 + 1` (precedence,
not string concatenation) and that `SUM(1E2,2)` and `1E3` parse at all; and the parser-level
counterweight that `E3` and `SUM(E3:E10)` are still references.

**The residual, stated rather than hidden.** The literal is stored as its VALUE, so the formula bar
shows `=1000` where the user typed `=1E3` (and `=250+1` for `=2.5E2+1`). Excel keeps the `1E3`
spelling. That is the same class as §2t / §2ai — the AST holds an `f64` and the renderer prints it —
and it is strictly better than the previous behaviour, which preserved nothing because the cell was
not a formula. Filed here rather than fixed: preserving it means carrying the literal's source text
on the AST node, which is a change to every producer of `Expression::Literal`.

### 2am. S6 — the whole function set answered `#VALUE!` for a numeric-domain failure; Excel answers `#NUM!` (or `#DIV/0!`) (2026-08-11) — **FIXED**

`=SQRT(-1)` was `#VALUE!`. So was `=LOG(0)`, `=LARGE(A1:A5,0)`, `=DEC2BIN(600)`, `=DATE(-1,1,1)` and
about a hundred more — every function in the product that can reject a number it cannot use.

**Excel's rule, confirmed against Microsoft's own remarks rather than asserted:**

| Excel says | means | example, quoted |
|---|---|---|
| `#VALUE!` | the argument is the wrong KIND of thing | *"If start_num is less than 1, MID returns the #VALUE! error value."* |
| `#NUM!` | a number the function cannot use, or a result too large | *"If number is negative, SQRT returns the #NUM! error value."* |
| `#DIV/0!` | the statistic divides by zero | *"If either array1 or array2 is empty, or if s of their values equals zero, CORREL returns a #DIV/0! error."* |

Pages read for this: SQRT, MID, ROMAN, LARGE, DEC2BIN, BIN2DEC, HEX2DEC, GEOMEAN, TRIMMEAN,
YEARFRAC, CHOOSEROWS, INDEX, CEILING, SKEW, STEYX, CORREL, DATE, TIME, BASE, MUNIT, LOG.

**THE SWEEP WAS MECHANICAL, because a by-name list of two functions is the shape that has failed
twice in this program.** Every `CellError::Value` site in `evaluator.rs` — 1268 of them — was
extracted by script and grouped by enclosing function, then filtered to the ones sitting behind a
NUMERIC guard rather than an arity or type check. That produced ~230 candidate sites across ~110
functions, each of which was then classified by hand against Excel. The classification is the
deliverable, not the diff:

* **`#NUM!` (92 functions, 190 sites, rewritten by script).** The idiom
  `match ….as_number() { Some(n) if COND => …, _ => Error(Value) }` conflates "not a number" with
  "a number outside the domain"; the rewrite splits the catch-all into
  `Some(_) => Num, None => Value`. Families: every distribution and inverse (NORM/LOGNORM/BINOM/
  POISSON/EXPON/CHISQ/T/F/GAMMA/BETA/WEIBULL/HYPGEOM/NEGBINOM/CONFIDENCE), every bond and
  depreciation function (PRICE/YIELD/DISC/INTRATE/RECEIVED/COUP*/TBILL*/DB/DDB/VDB/SLN/SYD/
  CUMIPMT/CUMPRINC/AMOR*/EFFECT/NOMINAL/RRI/PDURATION/DOLLARDE/DOLLARFR/IPMT/PPMT/ISPMT),
  LARGE/SMALL/PERCENTILE/QUARTILE.EXC/PERCENTRANK.EXC/TRIMMEAN/STANDARDIZE/FISHER/GAMMALN,
  BESSEL*, BIT*, and SQRT/SQRTPI.
* **`#NUM!` (hand edits).** SQRT, SQRTPI, LN, LOG, LOG10, ASIN, ACOS, FACT, FACTDOUBLE, COMBIN,
  COMBINA, MULTINOMIAL, GCD, LCM, MROUND, CEILING, FLOOR, EXP, RANDBETWEEN, GEOMEAN, HARMEAN,
  GAMMA, GROWTH, LOGEST, IRR, XIRR, RATE, NPER, PMT, PERMUT, DATE, TIME, YEARFRAC, BASE, DECIMAL,
  IMLN/IMLOG10/IMLOG2, the whole DEC2/BIN2/HEX2/OCT2 family, and the arithmetic operators.
* **`#DIV/0!` (17 guards).** CORREL, COVARIANCE.P/S, SLOPE, INTERCEPT, STEYX, SKEW, SKEW.P, KURT,
  FORECAST.LINEAR, STDEVA, STDEVPA, VARA, VARPA, AVERAGEA — every "too few data points" guard,
  because the statistic really does divide by zero. Plus two Excel behaviours that read as surprises
  until you write the arithmetic down: **`LOG(10,1)` is `#DIV/0!`** (the implementation is
  `ln(n)/ln(base)` and `ln(1)` is zero — Excel surfaces the division, not the domain), and
  **`0^-1` is `#DIV/0!`** (`x^-n` is `1/x^n`).
* **LEFT UNTOUCHED at `#VALUE!`, deliberately.** The text family (MID, LEFT, RIGHT, REPT, FIND,
  SEARCH, REPLACE, SUBSTITUTE), ADDRESS, MUNIT, CHOOSECOLS/CHOOSEROWS, WRAPROWS/WRAPCOLS, EXPAND,
  MDETERM/MINVERSE, AGGREGATE's `function_num`, and **ROMAN** — whose remarks say `#VALUE!` for a
  negative number where every neighbouring function says `#NUM!`. Excel's oddity, kept because
  parity is the tiebreaker.
* **The base-conversion family INVERTS the usual reading of "text argument", and Microsoft states
  it outright.** `DEC2BIN("x")` is `#VALUE!` (nonnumeric), but `BIN2DEC("2")` is `#NUM!` — `"2"` is
  the right kind of thing and not a numeral in base 2. Range violations and an insufficient `places`
  are `#NUM!` throughout.

**Three defects the sweep uncovered that are not error-spelling at all.**

1. **`=1E308*10` displayed `inf`.** No operator checked for overflow, so the IEEE infinity reached
   the grid — a token that is not a number, not an error, and not anything a user can act on. Excel
   answers `#NUM!` past 1.7976931348623158E+308. `finite_or_num` is now the ONE gate every
   arithmetic operator funnels through, so there is one answer to "what happens when a formula
   overflows" instead of one per operator. `EXP(1000)` goes the same way.
2. **`=COMBINA(0,1)` PANICKED.** `nn = n + k - 1` is 0, and the symmetry shortcut's `nn - k`
   underflowed a `u64` — a debug-build panic inside the evaluator, i.e. the whole recalculation
   dies, from typing one formula. Guarded, and the value it now returns (0) is the one the shortcut
   would have produced had it not underflowed.
3. **`places` was unbounded on nine base-conversion functions.** It reaches
   `format!("{:0>width$}")` as a WIDTH, so `=DEC2BIN(5,1000000000)` asked the formatter for a
   one-gigabyte string on a single keystroke. Excel caps `places` at 10 and answers `#NUM!` above
   it; the cap is now both the parity answer and the allocation bound. The same argument retired
   `BASE`'s `MAX_TEXT_LEN` check: Excel's own `min_length` ceiling of 255 fences the O(n²) pad
   before the fuel counter could, so the budget test that used to assert `#LIMIT!` there now asserts
   `#NUM!` and says why. **A cap the argument can never clear is a better guard than a counter that
   has to notice.**

Two smaller parity fixes fell out of the same reading. `DATE(99,1,1)` was the year 99, not 1999 —
Excel adds 1900 to any year in 0..1899, and Calcula took the number literally. And `DATE(1900,-500,1)`
answered the serial for 1900-04-01: month underflow rolls the year, `date_to_serial`'s year loop
simply does not run below 1900, and nothing checked the ROLLED year. Both are `#NUM!` or correct now.

**12 tests** in `evaluator::error_value_parity_tests`, table-driven over ~120 formulas in six tables
(math, statistical, financial, engineering, date, too-few-points) plus a counterweight table of the
functions Excel keeps at `#VALUE!` — because the half that must not move is the half a "change every
guard" sweep would have broken. The tests read from GRID CELLS rather than array literals, and say
why: `{1;2;3}` is Excel's column-array syntax and **this parser does not accept it** (`{…}` here is
a Python-style list literal with a comma separator and no row separator at all). That is its own
parity gap and is filed below rather than papered over.

---

### 2an. §3bg — `#SPILL!` exists now, and adding it exposed that CLEARING A CELL NEVER RECALCULATED ANYTHING (2026-08-11) — **BOTH FIXED**

The filed half took an hour and is exactly what §3bg predicted: `CellError::Spill`, the literal in
`as_literal`/`from_literal`, the two frontend `CELL_ERROR_LITERALS` lists, and the three
spill-decision sites in `commands/data.rs`. §3bi's cost update was right — no exhaustive `match`
broke in either workspace.

**Excel's `#SPILL!` names the obstruction, and naming it is the whole point.** `#VALUE!` means "fix
the argument"; every argument of a blocked array is correct and the remedy is in ANOTHER CELL.
`CellValue::Error` carries no payload, so the address lives in `AppState.spill_blocks`
(origin → first blocking cell), written by the same three sites in the same breath as the error and
read back by the error-checking pane, which now has its own `spillBlocked` category and a message
that says *"…it cannot write them because A3 is not empty. Clear A3…"*. Staleness is unobservable
and the map needs no tear-down of its own: it is only ever READ for a cell whose value is
`#SPILL!`, and a cell can only hold that value from an evaluation that wrote the entry.

#### The defect behind it, which is much larger than the one that found it

The first `#SPILL!` test written was "clear the obstruction and the array comes back". It failed.
Chasing why produced this, on the running engine:

```
A1 = 5
B1 = =A1+1     ->  6
clear A1       ->  A1 is empty,  B1 is STILL 6      (Excel: 1)
```

**`update_cell_impl`'s empty-value branch ended in `return Ok(…)` placed ABOVE the recalculation
block.** Clearing a cell wrote the grid, maintained the dependency maps, recorded the undo entry —
and returned before the cascade. Every dependent of a cleared cell kept the value it had before the
clear, and the stale number is not merely displayed: it is what the next save writes.

Delete and Backspace both commit an empty value through this exact path
(`useSpreadsheetEditing` calls `startEditing("")` then `handleCommitEdit`, which calls
`updateCell(row, col, "")`). This was the most-used editing key in the product leaving the workbook
internally inconsistent.

The fix is structural, not a patch: the early return became an `else`, so **clear and write are
alternatives that both fall through to the one cascade.** Each branch already did its own grid
write, dependency maintenance, `updated_cells` entry, override record and undo entry; nothing else in
the function distinguished them. A second exit from a function that owns the cascade is how the
cascade got skipped, which is the general lesson: *an early `return` inside a function whose tail is
a shared invariant is that invariant's most likely hole.*

That also gave the `#SPILL!` recovery for free — with the clear branch reaching the cascade, the
unblock seeding below actually runs.

#### The unblock seeding, and why `spill_blocks` pays for itself twice

A blocked origin does not DEPEND on the cell in its way, so no dependency edge reaches it and the
cascade walked past even once the clear branch got there. `spill_blocks` already records which cell
blocks which origin, so unblocking is a reverse lookup on a map that is empty in every workbook with
no blocked array. Convergent when several cells block one array: the re-evaluation records the next
blocker and stays `#SPILL!`.

**7 tests.** Four for `#SPILL!` (blocked on entry, blocked by a later edit, cleared-and-re-spilled
with the block record forgotten, and a real `.cala` round trip proving the literal survives); three
for the clear cascade (one hop, a chain plus a non-arithmetic dependent, and "one keystroke, one undo
entry" — the failure mode of turning an early return into an `else` is a double record). Three
pre-existing tests that pinned `#VALUE!` for a blocked spill were inverted.

**The error-spelling census was VACUOUS and is now real.** `error_display_tests::every_variant_is_accounted_for`
claimed "a new `CellError` that nobody adds here is a new spelling nobody checked" — and compared
`SPELLINGS` against a HAND-WRITTEN `all` array in the same file. `CellError::Null` and
`CellError::Num` had been added for the .xlsx reader and appeared in NEITHER list, so both stayed the
same length and the assertion passed while two variants went unchecked. It now reads `cell.rs` at
test time, the way the frontend's `type-guards-exhaustive` drift guard already did. **A census that
enumerates a copy of the thing rather than the thing is not a census.**

---

### 2ao. S10 — the 1904 date system was read off the file and thrown away (2026-08-11) — **IMPORT FIXED; the SETTING is filed as D9**

Excel has shipped two date systems since 1985. The 1904 one (epoch 1904-01-01) is the Macintosh
default and is still written by Excel for Mac and by anything exporting through it. A serial number
means a date **four years and a day** apart depending on which system the workbook declares, and
`xlsx_reader.rs` never read the declaration.

So a Mac workbook imported with every date 1462 days early — **silently**, because 1462 days off is
still a perfectly valid date. Nothing on screen, in the file or in the log said anything.

**The fix, and the part that makes it more than a `+1462`.** `parse_xlsx_styles` now returns
`date1904` from `<workbookPr>`, accepting all four OOXML boolean spellings (`1`/`true`/`0`/`false`
— LibreOffice writes the word, and reading only `"1"` would have taken the 1900 branch on every file
it produces, which is this register's signature failure shape). The shift is then applied
**per cell, driven by the resolved number FORMAT**, because a blanket shift would corrupt every
quantity, price and count in the file:

* `Date` — always.
* `Time` — only when the value carries a date part (`>= 1`). A bare time of day (0.5 = noon) is the
  same number in both systems.
* `Custom` — when the format contains an unquoted `y` or `d` (`m` is ambiguous: month and minute).
* **Never for an ELAPSED format** (`[h]`, `[mm]`, `[ss]`), in either the `Time` or the `Custom` arm.
  Built-in numFmtId 46 (`[h]:mm:ss`) parses to `Time`, so covering only `Custom` would have turned a
  thirty-hour DURATION into an instant in 1904.

Export needs no counterpart: Calcula writes 1900-system serials and omits the attribute, which is
the OOXML default.

**3 tests** in `xlsx_writer::tests`, on real ZIP fixtures with a styles part: the epoch itself, a
real date, a plain number that must NOT move, a bare time, an elapsed duration, the three boolean
spellings, and the absent/false control.

---

### 2ap. §2ak's residual — the renderer expanded `1E300` to 301 digits (2026-08-11) — **THE REAL DEFECT FIXED; the spelling filed with a measured cost**

§2ak fixed the lexer and filed the residual as cosmetic: `=1E3` re-spells as `=1000`. Measuring it
turned up something that is not cosmetic at all.

**Rust's `Display` for `f64` has no exponent form.** `format!("{}", 1e300)` is a 301-character string
of digits; `1e-300` is 302; `f64::MAX` is 309. And this renderer's output is not a debug string —
it is what the formula bar shows AND what `.cala` writes and re-parses. `=1E300*A1` was stored,
displayed and reloaded as a 301-digit literal.

Fixed in the ONE renderer: a plain rendering longer than 20 characters switches to `{:E}`, which the
lexer's new exponent rule reads back (`scientific_rendering_preserves_the_exact_f64` asserts the
round trip on the BIT PATTERN, not the magnitude). 20 is chosen so nothing human-scale moves — the
widest ordinary value stays plain.

**The `=1E3` → `=1000` re-spelling stays, and here is the cost that decides it.** Excel preserves
formula text as typed; Calcula stores an AST and renders it, so preserving the spelling means
carrying the literal's source text on `parser::ast::Value`. Measured: **62 exhaustive matches on
`Value`** across both workspaces and **210 `Expression::Literal(` sites**, on a type that is
`Serialize`/`Deserialize` and rides in the AST-carrying undo snapshots — so the change is a serde
shape change as well as a wide refactor. Against that: the round trip is numerically exact, the file
is unaffected, and the only symptom is that the formula bar shows a canonicalised number.
**Recommendation: do not.**

**RE-EXAMINED 2026-08-11, and the recommendation is unchanged — but its stated mitigation is WRONG and
is struck.** Two things sharpen the filing:

1. **This is not a renderer defect at all, and no rendering rule can fix it.** `1E3` and `1000` lex to
   the SAME `Value::Number(1000.0)`; the spelling is destroyed at lex time, not at render time. The
   renderer is being asked to recover information that is not in its input. That moves the entry from
   "a wide refactor would be needed" to "the wide refactor is the ONLY possible fix" — carrying the
   literal's source text on `parser::ast::Value` (or on `Expression::Literal`, which is no cheaper:
   **212** construction sites across `core/` and `app/src-tauri/`, re-counted this pass, against the
   210 recorded above).
2. **"The cheap 80% is to widen the scientific threshold" does not apply and would be a REGRESSION.**
   `render_value` takes an integer fast path FIRST — `if *n == (*n as i64) as f64 && n.abs() < 1e15 {
   format!("{}", *n as i64) }` — so `1000.0` is rendered by that branch and `MAX_PLAIN_LITERAL_LEN`
   is never consulted for it. Lowering the threshold changes nothing about `=1E3`. Making the
   scientific form reach it at all would mean changing the INTEGER branch, and then `=1000000` typed
   plainly renders as `=1E6`: parity bought on the rare case by breaking it on the common one, which
   Excel never does. There is no cheap 80% here; there is the refactor or nothing.

**A cheaper-looking alternative was considered and rejected on correctness, not cost:** caching the
raw formula string on `Cell` (one struct, one `format_version` bump). It is wrong — a structural edit
rewrites references, so the cached string goes stale the first time a row is inserted. Preserving
spelling has to be per-literal, which is the refactor above.

Recommendation stands: **do not.** If it is ever wanted, it is a one-purpose refactor of
`Value::Number`, and it should be scheduled as one.

---

### 2aq. Filed, not fixed — three parity gaps found while sweeping the error values (2026-08-11)

None of these is an error-value question, and each is a wider change than the sweep that found it.

- **An empty cell reads as the NUMBER zero in every context.** `=A1&"!"` over a blank is `"0!"`
  where Excel gives `"!"`, and `=COUNT(A1:A1)` over a blank is 1 where Excel gives 0. Excel treats a
  blank as 0 in ARITHMETIC only; in concatenation it is the empty string, and the counting functions
  ignore it. **Reproduction:** both are asserted, at today's values, in
  `clearing_a_cell_recalculates_the_whole_chain`, whose message says the assertion is pinning the gap
  rather than endorsing it. This is empty-cell semantics across the whole evaluator — a project, not
  a patch.
- **Excel's array literal `{1;2;3}` does not parse.** `{…}` in this parser is a Python-style LIST
  literal: comma-separated, no row separator, and `;` is `Illegal`. So every Excel formula
  containing an inline array — `=SUM({1;2;3})`, `=MATCH(x,{1,2,3},0)`, the whole documented idiom —
  fails to parse on paste or import. `{1,2,3}` parses but means a list, not a 1×3 array.
- **`#NULL!` is still never produced.** The intersection operator (a space between two ranges) has
  no `#NULL!` path. The variant exists and round-trips; this is the other half of S6 and is
  unchanged by it.

---

### 2al. A structured reference on ANOTHER sheet read the wrong sheet — `=SUM(Sales[Amount])` written on Sheet2 summed **Sheet2's** `A2:A4` (2026-08-11) — **FIXED**

Found by a test written for §2aj, on its own precondition: `a_reader_on_another_sheet_recalculates_too`
could not build its fixture, because the off-sheet reader did not evaluate to 60 in the first place.

**The reproduction, at unit level.** `Sales` covers `Sheet1!A1:A4` (10/20/30 under a header). On
Sheet2, `A2:A4` hold 1/2/3. Type `=SUM(Sales[Amount])` on Sheet2:

```
expected (Excel): 60      -- the table's rows
measured:          6      -- Sheet2's OWN A2:A4
```

Not zero. **A different, entirely plausible number**, which is the property that makes this the
silent class: nothing errors, nothing looks wrong, and the value is only wrong if you know what the
table holds.

**The cause.** A table's NAME is workbook-wide — `find_table_by_name` searches the whole registry —
but every resolution built its range with `sheet: None`, which means "the sheet the formula is on".
`resolve_column_ref`, `resolve_this_row_ref`, `resolve_column_range`, `resolve_this_row_range`,
`resolve_special_column` and the five `make_range` arms of `resolve_single_table_ref` all passed
`None` unconditionally.

**OLDER THAN §2aj, and §2aj did not cause it** — entry-time resolution produced the same wrong
rectangle, it just produced it once instead of on every evaluation. But §2aj makes structured
references worth using, so it makes this reachable by more people.

**The fix.** `TableRefContext` and `NameTables` / `NameEvalCtx` carry the workbook's `sheet_names`;
`find_table_by_name` returns the table WITH the sheet the registry filed it under (rather than
`Table::sheet_index`, so the pair cannot disagree with itself); and `resolve_single_table_ref`
computes one `qualifier` — `None` when the table is on the formula's own sheet, the sheet's official
name otherwise — and passes it to every arm. A BARE `[@Col]` is by definition on the current sheet
and carries no qualifier.

That is a 30-site threading of one field, and it is the reason it had not been fixed: nothing
smaller reaches all five resolution helpers.

**The dependency edges follow for free.** A qualified range is extracted as `cross_sheet_cells` by
`extract_references_recursive`, so an off-sheet structured reader lands in `cross_sheet_dependents`
like any other cross-sheet formula and the ordinary cascade reaches it.

**2 tests**: `a_structured_reference_reads_the_tables_sheet_not_the_formulas` (with DECOY values in
the reader's own sheet, so a locally-resolved formula produces 6 rather than 0 — a test that only
asserted "not zero" would have passed the whole time), and
`a_reader_on_another_sheet_recalculates_too`, which is the growth case across a sheet boundary.

### 2ar. A bare `[@Column]` matched on the ROW RANGE ALONE, so a formula in a far column resolved against a table it is not in (2026-08-11) — **FIXED**

Filed by §2aj's own author as "pre-existing; needs `current_col` on `TableRefContext`, a second
20-site change". It is fixed here, and the change was 24 sites rather than 20.

**What it did.** `find_table_at_cell` — the resolver for the *bare* specifier, the one that means
"the table this cell is in" — tested only `current_row >= table.start_row && current_row <=
table.end_row`. A rectangle entered on one axis is not entered. With `Sales` over `A1:A4`, a formula
`=[@Amount]*2` in **Z2** resolved against `Sales` and answered **20**. Excel answers `#NAME?`: the
unqualified form is legal only inside the table, and from anywhere else the reference has to name its
table (`Sales[@Amount]`).

The failure mode is the one this program keeps meeting — not a crash and not an error, a *plausible
number*. Nothing in the document says the total came from a table the formula has no relationship
with.

**The adjacent column is a different question and must not be confused with it.** `B2` beside a
one-column table ending at `A` is exactly where Excel's table AUTO-EXPANSION absorbs the cell INTO
the table, and Calcula does the same in `check_table_auto_expand` (`col == table.end_col + 1` and the
row within range). So a bare specifier at B2 *is* legal — because by the time it resolves, the table
really does contain it. That is handled by extending the rectangle, never by matching outside it.

This distinction is why the fix broke exactly one existing test.
`a_bare_this_row_reference_is_reached_by_any_table_change` put its reader at B2 against a
**one-column** table, and passed for the defect's reason: the harness writes cells directly and never
runs the auto-expand step, so B2 stayed outside the table and the row-only match let it through. The
test's subject is the `BARE_TABLE_KEY` edge, not the geometry, so the table is now two columns wide —
which is what the cell is sitting in once the real app has run.

**The change.** `TableRefContext` gains `current_col`, `NameEvalCtx` gains `col`, and both are
threaded to every construction site: 16 `TableRefContext` literals, 3 `NameEvalCtx` literals, 7
`NameTables::at()` callers, plus `stored_ast_references`, `split_entered_formula` and
`resolve_table_refs_now`, which each grew a `col` parameter and had their callers updated. Every site
already had the column in scope — it was simply never passed. The compiler enumerated all of them
(`E0063`/`E0061`), so none was found by reading.

**2 tests**, both written before the fix and both observed to fail against it:

- `a_bare_specifier_far_from_the_table_is_not_in_it` — column **Z**, far outside the table on both
  axes, where auto-expansion can never reach and the answer is unambiguous. Failed with
  `left: Number(20.0), right: Error(Name)`.
- `a_bare_specifier_inside_the_table_still_resolves` — the other side of the gate, so that narrowing
  the match cannot silently break the case the specifier exists for (a calculated column).

**Not changed:** the qualified form `Sales[@Amount]` never went through `find_table_at_cell` at all
(it resolves by name), so it was correct before and is untouched.

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

### 3ay. The document-store census now roots at BOTH projection paths — and the claim that it costs nothing was MEASURED, not repeated (2026-08-10)

**The gap.** `every_store_the_save_path_reads_is_reset_when_the_document_is_replaced` rooted at
`assemble_workbook_for_save` alone, because the `.cala` save is the path §2w's leak was measured on.
It is not the only path that projects the live stores into a file somebody else opens. **The `.calp`
publish is the other**, and it is the one carrying the confidentiality edge that made §2w matter: a
`.calp` is by construction sent to other people, so a store the publish path reads and the reset does
not clear would put a closed document's content into a package a subscriber pulls, and nothing would
have failed.

**Rooted at `assemble_publish_workbook` as well. The cost was measured before the claim was made, and
again after:**

| | stores reached |
|---|---|
| `assemble_workbook_for_save` alone | **70** |
| both roots | **71** |
| publish-only | **1** — `AppState.protected_regions` (read to compute the package's excluded regions) |
| publish-only AND unreset | **0** |

So the second root demanded nothing on the day it was added — which is exactly why it had to be added
on a day when it demanded nothing. (The register's earlier figure of "60 stores" is stale by the
`workbook_protection` / `pending_recalc` chain-join fix and by §2x's additions; the two numbers that
matter, 1 publish-only and 0 escaping, both hold.)

**Two new guarantees, not one.** `the_two_projection_roots_are_both_real_and_the_publish_root_adds_no_demands`
asserts (a) each root name resolves to **exactly one free function**, and (b) the publish root's
private contribution is empty. (a) is not bureaucracy: `call_closure` silently yields nothing for a
name it cannot resolve, so a root that is renamed, deleted, or turned into an `impl` method — which
`parse_fn_header` deliberately does not index — would leave the census passing over half the surface
with **no signal at all**. That is the exact failure mode this whole file exists to make impossible.
(b) is what keeps the "costs nothing" claim honest: the day publish starts reading a store the save
path does not, this test names it and the census above demands the decision.

The test also refuses to pass vacuously in the other direction: it asserts the publish root really does
contribute a store of its own, so a root that stopped reaching the carrier could not sit there
contributing nothing while looking like coverage.

**Demonstrated firing, twice, by sabotaging the real tree and restoring it.**

| sabotage | what failed | message |
|---|---|---|
| `state.calculation_mode.read()` added to `assemble_publish_workbook` | **the census AND the new test** | "…projected into every saved workbook or **published package** but are NOT reset: `AppState.calculation_mode`" / "…read ONLY by the `.calp` publish path and are not reset" |
| `SAVE_ROOTS` second entry renamed to a function that does not exist | the new test | "`assemble_publish_workbook_renamed` is a census ROOT and resolves to 0 free functions… a root that has been renamed… does not fail the census — it silently shrinks it" |

The first sabotage is worth noting for what it says about the census's honesty: `calculation_mode` is
`SESSION_SCOPED` in the FIELD census (an application preference the reset must not touch) and is
therefore correctly not reset — so putting it on a projection path is exactly the shape of a real
leak, and both halves of the census said so, by name, in one run.

**Non-vacuity was extended with the publish root's own member.** `AppState.protected_regions` is now in
the list of stores the census must find, alongside the five §2w members — so a walk that stopped
reaching the publish path would fail on the enumeration rather than quietly reporting a clean bill over
half the surface.


### 3az. The four small recorded leftovers — each re-verified, and what each one actually was (2026-08-10)

The instruction was to check whether each is still open and then close it or say why not. Two were
still open and closed; one turned out to be hiding a real behavioural defect; one is still refused,
and the refusal is now backed by a measurement rather than by a recollection.

---

**(1) `persist_security_config` — the trigger has NOT fired, so the recommendation stands. It is now a
CHECK instead of a sentence.**

§3av reported it and deliberately did not fix it: two writers, both correct, "if a third writer is ever
added, fold the write into a `set_security_level(state, level)` helper". Re-counted:
`rg "persist_security_config"` returns **three** hits — `set_script_security_level`,
`set_mcp_access_level` and the definition. The other apparent writers are all inside `#[cfg(test)] mod`
blocks, and `hydrate_security_level` writes both fields and must NOT persist because it is the load
path. **So the code is unchanged, and rightly.**

What changed is that a recommendation living only in a document decays, and this register has recorded
that failure mode more than once. `script_security_census_tests.rs` classifies every PRODUCTION
function that touches `security_level` or `mcp_access_level` as writer-that-persists, load-path or
reader, each with a written reason; a fourth is unclassified until somebody decides, and the failure
message IS the recommendation.

**Writing it found two functions the by-hand list had missed** — `check_script_security` and
`script_execution_status`, both readers — which is the same lesson as everywhere else in this program:
a hand-written list of instances is not a measurement of the class. It also rejected an invented name
(`is_script_execution_allowed`) through its own staleness check, which is the check working in the
direction people forget to test.

Deliberately NOT a call-count assertion. "`persist_security_config` has exactly two call sites" fires
for the writer who REMEMBERS the persist and stays silent for the one who forgets — and forgetting is
the defect. **Demonstrated firing:** deleting the persist from `set_mcp_access_level` fails
`every_writer_of_the_security_levels_persists_the_choice` by name. The failure mode is stated next to
the check so nobody over-reacts to it: this is a REVERT at next launch, not a corruption — but note the
direction it can revert in, from a level the user TIGHTENED back to a looser persisted one, silently.

---

**(2) `ScriptableObjects/lib/debugger.ts` — collapsed, and it was not merely structural: the shape had
already produced a live defect.**

§3aw filed it as "correct today, for the same unpurchased reason the reports were", with the failure
mode recorded as "losing BREAKPOINTS, not user data". Reading it to apply the `animationStore`
treatment found that the third mutator the register was waiting for **was already there**:
`clearAllBreakpoints()` went round `commit()` and did four fifths of its job. It cleared the map,
announced and persisted — and never called `sendBreakpoints`. **So "Clear All Breakpoints" during a
LIVE debug session emptied the gutter and left the runtime stopping at every one of them.**

The map now lives in a `#private` field on a `BreakpointStore` with three doors: `mutate()` (changes,
announces, persists and retargets a live session — all of it or none), `adopt()` (installs a set that
came OUT of the workbook; does not persist, and the name says so) and `forget()` (the document was
replaced; does not persist, because the document being loaded owns the answer). `clearAllBreakpoints`
is now one `mutate` per script, so it cannot forget — forgetting is not one of the things `mutate` can
do — and the persist is debounced, so N calls still make one write. `loadPersistedBreakpoints` also
collects into a local before touching the store, so a backend that throws halfway through no longer
installs half a workbook's breakpoints.

Compile probe, run against the real tree and reverted: `store.#byScript` outside the class body ->
`TS18013: Property '#byScript' is not accessible outside class 'BreakpointStore' because it has a
private identifier`.

**One test in `debugger.test.ts` had to change, and the change is evidence rather than an
accommodation.** Its `beforeEach` called `clearAllBreakpoints()` while the previous test's session was
still installed; the clear now schedules an async `hostSetDebugBreakpoints` that landed after the
`mockClear()` and read as the next test's call. The session is torn down first, and a new test pins the
fixed behaviour directly (`CLEAR ALL reaches a live session, not just the gutter`). 33 passing, was 32.

---

**(3) The `ribbon-tabs` Ctrl+F1 golden — the refusal reason has NOT evaporated. Measured.**

§3ar refused to re-record `ribbon-minimized` because its diff was grid CONTENT left by whichever of the
~450 preceding tests ran last. The question posed for this pass was whether D5's canvas-layer crop had
dissolved that. **It has not, and the measurement is one command:**

```
ribbon-home-tab-default.png        1280 x 136
ribbon-ribbon-before-minimize.png  1280 x 136
ribbon-minimized.png               1280 x 800   <-- the whole window
```

Every other golden in the file is a ribbon-ELEMENT capture. This one alone is
`takeCheckpoint(page, name)` with no target, which photographs the window. D5 cropped
`takeGridScreenshot` to `[data-grid-canvas-layer]`; it does not touch `takeCheckpoint`. So the frame
still contains the entire grid, and re-recording it would still freeze one run's residue.

**What was done instead is to remove the CAUSE, so that recording it becomes legitimate**, which is the
same move D5 made for grid captures:

* the grid area is **masked** out of the frame (`mask: [locator("[data-grid-area]")]`). The mask is a
  solid rectangle, so the grid's GEOMETRY — the thing a window-framed shot is for, since collapsing the
  ribbon moves the grid area up and makes it taller — is still in frame and its contents are not. A
  ribbon-only capture could not show that, which is why the instrument was not simply swapped;
* the SELECTION is pinned with `navigateTo("W1")` before the capture, because the window frame also
  contains the Name Box and the status bar, both of which render the current selection — the documented
  `clickCell` drift, with its documented remedy;
* undo availability is pinned by the same `beforeEach` §2ac added, since the Home tab's Undo/Redo
  buttons are in frame and now follow the stack.

**The baseline was deliberately NOT deleted or re-recorded here.** `softly()` swallows
"snapshot doesn't exist" and writes the actual, so deleting it would have produced a green run and a
baseline recorded by an agent who could not open the app to look at it — which is the failure this
register keeps naming. **It goes to the re-record pass (§3aq's list) with the blocker removed**: after
this change, recording it no longer freezes residue.

---

**(4) `inline-editor-live` test 8 — the upstream spec is STILL not identified, and the honest close is
that the next failure will identify itself.**

§3at recorded this twice and ended both times with "the upstream spec responsible is NOT identified".
Re-reading the evidence narrowed it to two candidate mechanisms and eliminated neither by reasoning —
which, per this register's own standing rule, means neither is a conclusion:

* **a commit-timing race.** The test typed the word and its Enter at full speed, waited a flat 500 ms,
  and then read the cell ONCE. In isolation the commit lands in far less than that; at the end of a
  450-test run in a shared app it need not. This is the one candidate that can be removed by
  construction rather than by investigation, and it has been: the assertion is now `expect.poll`
  (10 s, backing-off intervals). A poll cannot fail for being early, and it keeps every tooth the fixed
  wait had — the pre-fix build committed `"b"`, which no amount of waiting turns into `"tabbed"`.
* **an upstream refusal.** Something makes the BACKEND reject a write to that coordinate. The candidate
  set is real (sheet protection, a stale spill map — §2y — a validation rule, a merge, a hidden row)
  and none of them is on a spec that alphabetically precedes `inline-editor-live` in a way that could
  be confirmed statically. `data-validation.spec.ts` works in column V, not B; the protection and merge
  specs sort AFTER it.

**So the spec was made to diagnose itself.** On failure it now dumps the cell, the active sheet, the
sheet list, the undo state, the validation rule, protection status, the user-hidden rows, whether an
editor is open, what holds focus — and, the discriminator, **the result of a direct `update_cell` on the
same coordinate**. If that write succeeds, the keystrokes never arrived (focus, timing, a sibling's
editor); if it is REFUSED, the backend is rejecting writes to that cell and the error says why. The
only evidence a shared 450-test run has ever left behind is `expected "tabbed", received ""`, which is
compatible with all of the above and points at none of it; bisecting a shared-app suite costs hours,
and this costs one function that runs only on the failure path.

**Stated plainly so it is not read as a fix:** candidate one is eliminated, candidate two is not, and
the next full run is what decides. This entry replaces "never identified" with "identifies itself".


### 3ba. The hunt verification pass — ten findings checked, eight real, one refuted, and the two the hunt never saw (2026-08-10)

A read-only hunt filed ten findings (F1–F10) with the honest caveat that it had run nothing: no build,
no test, no app. This register's own record is why that caveat mattered — six hypotheses previously
recorded here as conclusions were all wrong. So every finding was reproduced before anything was
changed, and the results are given below including the one that evaporated.

**The verification table.** "Evidence" is what was actually executed, not what was read.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| F1 | Parentheses dropped by both renderers; save/reload changes the computed value | **REAL** | Probe: `=(A1+B1)*C1` rendered `A1+B1*C1`; 9 of 10 grouped forms failed to round-trip |
| F2a | An unknown sheet resolves to the formula's OWN sheet, not `#REF!` | **REAL** | Probe: `=NoSuchSheet!A1` returned `100` — Sheet1's own A1 |
| F2b | Deleting a sheet never repairs plain cross-sheet refs | **REAL** | Probe: `repair_3d_refs_on_delete("=Sheet2!A1", "Sheet2", …)` returned `Some("=SHEET2!A1")` |
| F3 | File ▸ Open discards unsaved changes with no prompt | **REAL** | `fileOpen` has no `isModified` guard; `fileNew` and the close handler both do |
| F4 | Renaming a sheet orphans incoming cross-sheet edges | **REAL** | New test fails without the fix: `Sheet2!B1` keeps `10` after `Data!A1 = 999` |
| F5 | Move/delete never remap the sheet INDICES in the dependency maps | **REAL** | Two new tests, one per operation, both fail without the fix |
| F6 | Sheet names unvalidated; the quoting rule is narrower than the lexer's escape | **REAL** | Probe: `John's` → `'John's'!A1`, `Q1-2026` → `Q1-2026!A1`, `2026` → `2026!A1` — none re-parse |
| F7 | Named ranges' `refers_to` never updated on rename or delete | **REAL** | `grep named_ranges sheets.rs` is empty; the name table is untouched by every sheet operation |
| F8 | The recalc census cannot see `repair_all_formulas` | **REAL** | Widening the detector surfaced it, plus `delete_sheet` and `rename_sheet` behind it |
| F9 | `fill_range` has no spill check and misses the §2y choke point | **NOT REAL** | Already fixed. `check_no_array_within` sits at `data.rs:6852`, installed by the §2y pass while the hunt was reading |
| F10 | A text literal cannot contain a double quote | **REAL** | Probe: `="a""b"` is a parse error — `read_string` has no `""` escape though `read_quoted_identifier` has `''` |

**F9 is the useful negative.** The hunt flagged it as medium-high confidence "against a file that changed
under me twice", and it was right to hedge: the §2y pass had already installed exactly the guard it
predicted would be missing. A finding filed against a moving file is a finding about a moment, not
about the tree.

**THE TWO THE HUNT NEVER SAW, both worse than most of what it did file.** Both were found the same way:
not by looking harder at the reported defect, but by asking what else went through the seam the defect
sat in. The hunt correctly identified "there are two AST→text serialisers and no round-trip test" as the
root pattern under F1/F6/F10. It then proposed a proptest. Comparing the two tables instead is what
found these.

1. **47 built-in functions rendered to text that is not their name.** The app crate's
   `expression_to_formula` had 224 explicit arms and then `other => format!("{:?}", other)` — a
   **debug-format catch-all covering 247 more functions**, which prints the Rust *variant identifier*.
   `CELL` was written `CellFn`, `FORECAST` → `ForecastLinear`, `STDEV.S` → `StdevS`,
   `NETWORKDAYS.INTL` → `NETWORKDAYSINTL`, and the whole `GATHER.*` writeback family likewise. For 47 of
   them the produced text is not an accepted spelling. It does not fail loudly: re-parsing yields
   `Custom("CELLFN")` — an *unknown user function* — so the formula becomes `#NAME?` with no error at
   render time and none at parse time. Measured, then reproduced:
   `=CELL("row",A1)` → `=CellFn("row",A1)` → `Custom("CELLFN")`.
   Two further arms had simply drifted (`STDEV.P`/`VAR.P` against the canonical `STDEVP`/`VARP`), which
   made `repair_all_formulas` rewrite untouched cells on every sheet operation because the two
   serialisers disagreed about text they both round-tripped.
   **Reach: renaming or deleting ANY sheet runs every formula on every sheet through this.**

2. **Renaming any sheet destroyed every named-LAMBDA call in the workbook.** `repair_all_formulas`
   read each cell with `formula_string()` — the DISPLAY form, which collapses the internal
   `__INVOKE__("MyFn", <lambda>, args)` marker down to `MyFn(args)`. The repair re-parses that and
   renders it back as `MYFN(A1)`; since the upper-cased result differs from the mixed-case original,
   the cell is REWRITTEN and the resolved lambda is gone. It fires on sheets the rename never
   mentioned. Pinned at the fix site by
   `repair_all_formulas_preserves_a_named_lambda_call_it_does_not_need_to_touch`, which under sabotage
   reports `the resolved lambda was destroyed by a repair that changed nothing: MYFN(A1)`.

**A third, found while fixing F7:** a sheet-scoped defined name carries its scope as an INDEX, and
`remap_sheet_keyed_stores` never remapped it. Moving or deleting a sheet silently re-scoped every
sheet-local name onto whichever sheet inherited the number.

#### What was fixed, and how each was made to fail first

**One renderer, not two (F1 + F6 + F10 + both unseen findings).** `expression_to_formula` and its three
private helpers (`builtin_function_to_name`, `expression_to_formula_no_sheet`,
`table_specifier_to_string`, 386 lines) were **deleted**; the function is now a delegation to
`engine::ast_render::render_formula_raw`. This is §3av's lesson one level down: single-representation
was bought for stores, and the *formula* still had two. The engine renderer then gained:

- **Precedence-aware parenthesisation.** A `binding_power` table mirroring the parser's descent chain,
  with the right-operand-of-a-left-associative-operator case and `^`'s right-associativity handled, plus
  the detail that `parse_power` takes its LEFT operand from `parse_primary` (so `(A1^B1)^C1` must keep
  its parentheses) and that a *negative number literal* renders like a unary minus (so `Power(-5, 2)`
  must render `(-5)^2` or it re-parses as `-(5^2)`: 25 becomes −25).
- **A real sheet-name quoting rule.** Bare only when identifier-shaped; otherwise apostrophe-wrapped
  with embedded apostrophes DOUBLED, the escape `read_quoted_identifier` already understood and the
  serialiser never produced.
- **`"` escaped as `""`** in text literals, and `read_string` taught the matching escape.

**A refinement worth recording because the test caught it, not review:** the first version of the
quoting rule also quoted reference-shaped names (`A1`, `ZZ100`). That is harmless in isolation and
wrong in practice — it also captures `Sheet1`, `Sheet2`, `Q1`, the DEFAULT sheet names — and would have
re-quoted the formula text of essentially every existing workbook. `=A1!B2` was checked and parses with
sheet `A1`; the trailing `!` is what disambiguates. The guard was removed.

**Teeth.** `every_three_leaf_operator_pairing_survives_render_and_re_parse` walks both associativity
shapes for every ordered pair of the 8 binary operators — 128 groupings, asserted exhaustive. With
parenthesisation disabled, **64 of 128 fail**. `every_builtin_function_survives_serialisation_as_itself`
enumerates the function catalogue (520 entries) rather than sampling it; re-introducing the debug
fallback for two functions makes it name them.

**`#REF!` where a sheet is gone (F2a + F2b).** `get_grid_for_sheet`'s `.unwrap_or(self.grid)` is
replaced at all ten sheet-QUALIFIED call sites by `resolve_grid_for_sheet`, which returns `#REF!`.
`(Some(name), None)` — a qualified reference with no multi-sheet context at all — deliberately still
resolves locally: that is single-sheet evaluation, where there is no sheet table to check against and
the qualifier has always been ignored. `visibility_key_for_sheet`, which was written to MIRROR the old
fallback, has its contract comment updated rather than left to rot. Separately,
`repair_3d_delete_recursive` gained the four reference arms its rename twin always had.

**The dependency maps follow their sheets (F4 + F5).** Two helpers, called from the places that already
own the renumbering: `remap_cross_sheet_dependency_indices` from inside `remap_sheet_keyed_stores` (so
`move_sheet` and `delete_sheet` are both covered by one choke point, not two call sites), and
`rename_cross_sheet_dependency_keys` from `rename_sheet`. Both halves of the pair move together —
`cross_sheet_dependents` is keyed by NAME with INDEX values, `cross_sheet_dependencies` the reverse —
because a fix that moved only the forward index would leave the reverse one naming a sheet that no
longer exists. `rename_sheet` also gained the `rebuild_all_dependencies` call every sibling already had.
Four tests, all four fail with the helpers disabled.

**Defined names follow their sheets (F7).** `refers_to` goes through the same repair the grid formulas
do — the name follows a rename and becomes `=#REF!` when its sheet is deleted — and sheet-scoped names
have their index remapped, or are removed with the sheet they were scoped to.

**The census's third blind spot (F8).** `Grid::cells` is public and this crate writes into it directly
in 42 places; the detector only knew `set_cell`/`clear_cell`. Widening it is not the whole story,
because a naive widening reported `extract_references_recursive` — `ExtractedRefs` also has a field
called `cells`, and collecting a reference into it is not writing a cell. A false positive is worse than
a gap here: the only way to make the census green would have been to record a **false exemption**, which
is how a census stops being believed. The detector is therefore receiver-aware, and that precision is
itself guarded by `every_direct_cells_map_receiver_is_a_recognised_spelling`, which enumerates every
receiver reaching `.cells.insert/remove/get_mut` and fails on any spelling it has not been told about.
Renaming one `grid` binding to `target` makes it report `named_ranges.rs:1049 — receiver 'target'`.

**And the census immediately earned it.** With `repair_all_formulas` visible, `delete_sheet` surfaced:
it turns formulas across every sheet into `#REF!` and **recalculated nothing**, so every cell downstream
of a broken reference kept the number it computed while the sheet existed, and that is what a save
wrote. It now recalculates the workbook — whole-workbook rather than seeded, because the repaired cells
are spread across every sheet and this is a rare, already-heavyweight operation. Removing that call
makes the census fail by name. `rename_sheet` is EXEMPT with the reason a rename moves no value.

**File ▸ Open asks (F3).** The six lines from `fileNew`, before the picker rather than after — asking
afterwards makes the user choose a file and only then learn the choice costs them their edits. Five
tests; four fail without the guard, and `the_prompt_precedes_the_picker` is the one a naive fix loses.

#### Contract checks

All five were run. (a) is satisfied by the **corrected** semantics, not the filed ones: the register's
own §2y correction established that spilled cells get NO undo entry and that undo restores the ORIGIN
which then re-spills — `a_swallowed_spill_cell_gets_no_undo_entry` and
`undo_of_the_delete_restores_the_spill_and_the_map_agrees` pin both halves, and
`restoring_spilled_literals_beside_a_restored_origin_is_what_blocks_the_respill` pins why the filed
version would have destroyed the array. (b) `a_restored_slicer_computed_property_still_re_evaluates`.
(c) four lifecycle tests including `reopening_refuses_a_package_this_machine_never_pinned` and
`reopening_refuses_a_package_whose_model_was_tampered_with`. (d) all four censuses green, including
`the_two_projection_roots_are_both_real_and_the_publish_root_adds_no_demands`. (e) six
`undo_history` tests plus the two frontend suites.

---

### 3bb. §2ab sharpened — the collapse is EDIT-triggered, and the machinery to fix it already works

> **CLOSED by §3be (2026-08-10). The last paragraph of this section — "if `.cala` stopped saving
> spilled cells, the origins would re-spill during the load recalculation" — is the recommendation
> §3be reversed.** It is kept verbatim because the two measurements above it are correct and
> load-bearing (the collapse is edit-triggered; the spill machinery itself works in both
> directions). Only the conclusion was wrong.

§2ab (a reloaded workbook has no spill map) remains **OPEN**. It was probed rather than re-asserted, and
two measurements change how it should be scheduled and fixed.

**It is not the reload that breaks the array.** A reloaded workbook looks correct: the spilled literals
came back from the file and the origin holds its value. The collapse happens on the FIRST recalculation
that touches the origin — an edit to any precedent — at which point `spill_blocked` sees cells occupied
by literals no map claims, and the array becomes `#VALUE!`. So the user-visible sequence is *open the
file, everything is fine, change one input, the array dies*. That is worse to diagnose than a visible
failure on open, and it means the reproduction must include an edit.

**The spill machinery itself is not broken — only the load path lacks it.** Probed directly:
`=SEQUENCE(B1)` with `B1 = 4`, then `B1 = 3` shrinks the array to three cells and the map with it, then
`B1 = 5` grows it back to five. Both directions correct, map consistent throughout. The cascade knows
how to write a spill; `recalculate_sheet_values` does not.

**Which points at the cheaper fix.** The obvious repair is "rebuild the map on load", which needs the
spill-writing logic lifted out of `update_cell_impl` (it is entangled with the cube prefetch, the UDF
resolver, the pivot and gather callbacks, styles and locale). But §2y's own finding suggests a smaller
one: **spilled cells are derived state** — that is exactly why they get no undo entry — and derived
state need not be persisted at all. If `.cala` stopped saving spilled cells, the origins would re-spill
during the load recalculation and the map would be rebuilt by the code that already works. That is a
`format_version` decision and therefore an owner call, which is why this stays filed rather than fixed.

---

### 3bc. Two things left deliberately unfixed, with the reason — **BOTH NOW CLOSED: see §2ag (sheet-name validation) and §2ad (the `.ok()` swallow), and §2ae for the eleven neighbours the swallow turned out to have**

**Sheet-name VALIDATION at entry.** F6's product half. The serialiser now round-trips any name, so
nothing is destroyed by one — but `rename_sheet`/`add_sheet` still accept names Excel forbids
(`[ ] * ? / \ :`, leading/trailing apostrophe) and names that collide with a reference. Quoting makes
them safe; whether to allow them is a product call, and one that touches import/export compatibility.

**`.ok()` swallowing a parse failure into a lost formula.** `repair_all_formulas` and
`apply_names_to_formulas` both store `parser::parse(&text).ok().map(Box::new)`, so a formula whose
repaired text does not parse silently becomes `ast = None` — a stale value with an empty formula bar and
no error anywhere. Every *known* producer of unparseable text is now fixed (the 47 functions, the
quoting rule, the apostrophe escape), which is why this is no longer urgent. It is still the mechanism
that turned all of them into silent data loss rather than a visible failure, and it should become a
logged `#REF!` rather than a swallow.

### 3bd. The live-proof pass for §2y / §2z / §2aa / §2ac and the hunt fixes — six new journey specs, two product defects found while writing them, and one spec that had encoded the old behaviour (2026-08-10)

Everything §3ba fixed, plus §2y, §2z, §2aa and §2ac, had been proved by unit and in-process tests and
by nothing else: the §2y closing pass said so in as many words ("the live E2E projects were NOT
re-run, and that is a gap"), and the reason given was that the brief's launch script did not exist in
the tree. **It exists now** — `scratchpad/launch-vba-batch.ps1`, checked in, doing the four things
`global-setup.ts` does that manual mode does not (kill stale instances and Vite squatters, put MSVC's
`link.exe` ahead of Git's, point `CARGO_TARGET_DIR` outside the Dropbox tree, open the CDP port) and
launching with `src-tauri/tauri.e2e.conf.json`, without which `window.__TAURI__` is absent and every
spec that drives the app through it fails.

#### What is now proved through the real UI

| spec | tests | what it drives that no unit test can |
|---|---|---|
| `journeys/spill-delete.spec.ts` | 3 | the REAL Delete key on a spill origin; the painted strings AND the canvas pixels; the whole-block delete; the bytes on disk |
| `journeys/undo-enablement.spec.ts` | 2 | the backend event -> shell bridge -> `@api/undoState` -> Home tab `disabled` -> Edit menu `disabled` wire, five hops |
| `journeys/computed-property-restore.spec.ts` | 1 | a real `.cala` round trip, then a real cell edit reaching the re-evaluation through the commit path and `slicers:refresh` |
| `journeys/subscription-restore.spec.ts` | 4 | publish -> pull -> save -> File > New -> reopen, plus the two unhappy paths performed on the registry's own bytes |
| `journeys/formula-roundtrip.spec.ts` | 4 | a real sheet rename/delete running every formula through the serialiser, and the cross-sheet edge that must survive it |
| `journeys/open-guard.spec.ts` | 3 | File ▸ Open's native prompt, its ORDER relative to the picker, and both answers |

**§2y's exact reproduction, gesture for gesture.** `=SEQUENCE(4;1;424243)` typed into the origin
through the real inline editor, the REAL **Delete** key, then: the spilled cells gone from the
rendered grid (`get_viewport_cells` — the command the canvas paints from — AND a pixel comparison
against the same block captured empty, which also catches the spill border), the map empty, the
neighbour EDITABLE again, undo restoring the formula *and* its spill *and* the map, and redo taking
all three down again. The start value is `424243` so the archive oracle is looking for THIS array and
not for a stray `2`.

**Teeth, measured rather than asserted.** `recalc_after_active_sheet_bulk_rewrite`'s tear-down was
disabled on the running build (`let has_spills = false && …`), `tauri dev` rebuilt, and the spec was
re-run:

```
the Delete key cleared the formula and left its spilled values painted on the grid
  Expected  ["", "", "", ""]
  Received  ["", "424244", "424245", "424246"]
```

and a direct probe on the sabotaged build reproduced the rest of §2y verbatim — `clear_range` returned
OK, `spill_ranges` UNCHANGED, and `update_cell` on the neighbour was refused with *"Cannot edit cell
(6, 132): it contains a spilled array value from cell (5, 132). Edit or delete the formula in the
source cell instead."* against a source cell that is empty. The sabotage was then reverted and
`data.rs` verified **byte-identical by sha256**
(`8011d47389dd87500574beadffc087fd8dc6c5e4502047c6f119a51a89cc88e9` before and after), rebuilt, and
the spec re-run green.

#### TWO PRODUCT DEFECTS FOUND WHILE WRITING `formula-roundtrip.spec.ts` — both fixed

Neither was among the hunt's ten findings, and neither is visible from the fixed code: they were found
by driving `rename_sheet` on the running app and then reading the formula bar and the Name Manager.

**1. Renaming or deleting a sheet RE-SPELLED every defined name in the workbook.** `=Anchor*2` came
back `=ANCHOR*2`, on sheets the operation never mentioned. This is **§2t** (`BudgetTotal` ->
`BUDGETTOTAL`) on a path §2t's fix does not reach — `restamp_workbook_name_casing` is called from
`open_file` and from nowhere else. The mechanism: both repairs re-render the whole formula whether or
not they touched it, the lexer upper-cases every bare identifier, and `repair_all_formulas` rewrites
any cell whose repaired text DIFFERS from what it was given.

**2. The same re-render rewrote a named LAMBDA's own definition** — a `refers_to` authored as
`=LAMBDA(x, x*2)` came back `=LAMBDA(X,X*2)`. That re-spells a **local binding**, which is precisely
what §2t's restamp refuses to do, and for the reason §2t gives: respelling a local after a workbook
name that merely collides with it tells the reader something false. Here it was not even a collision —
just the renderer.

**The fix is two halves, and the first is the important one.** `repair_3d_refs_on_rename` and
`repair_3d_refs_on_delete` now return the CALLER'S ORIGINAL TEXT when the repair produced the same
tree it was given (`unchanged_or`, comparing rendered ASTs — not strings that look similar). A repair
that changed nothing must leave the user's own spelling alone, and that covers the overwhelming
majority of cells, since most formulas never mention the sheet being renamed. For the formulas a
rename really does rewrite, `rename_sheet` and `delete_sheet` now call the SAME
`restamp_workbook_name_casing` the load path calls, so entry, reload and a sheet operation cannot
disagree about what a name is called. Five tests in `formula_serialisation_tests.rs`, including the
two counterweights (a rename that DOES touch the formula still repairs it; a delete that does still
produces `#REF!`) without which the preservation could have been bought by making the repair a no-op.

#### ONE EXISTING SPEC HAD ENCODED THE OLD BEHAVIOUR — the F3 regression, found by running the suite

`undo-across-open.spec.ts` failed 2 of 5 in the first ordered journey run after F3 landed:
`the file dialog has no file-name edit box`. It opens BRAVO while ALPHA holds an unsaved edit, which
is now exactly the gesture that raises the guard's native prompt — and its picker driver, which looks
for a file-name `Edit` child, correctly reported that the visible dialog had none. The product is
right; the spec was out of date.

`openThroughFileMenu` now answers the prompt, and **the expectation is MEASURED, not assumed**: it
reads `is_file_modified` immediately before the click and requires a prompt exactly when the document
is dirty. The first version hard-coded a per-call-site expectation and was wrong about one of them —
a spec asserting its author's model of the app rather than the app. Nothing else in the file changed;
its teeth are unaffected, because the corruption §2x is about happens AFTER the open.

#### A TEST-INFRASTRUCTURE DEFECT WORTH ITS OWN PARAGRAPH: a leaked native dialog poisons everything after it

While `open-guard.spec.ts` was being written, one of its assertions aborted a test between raising the
file picker and dismissing it. A file picker is **owned by the app process and outlives the spec**. The
next run measured the debris rather than the product, and by the time it was diagnosed the app was
holding **twelve stacked "Öppna" dialogs** — enumerated to be sure of it. Every downstream failure in
between, including a chase after a phantom "the dirty flag is set on a freshly saved document", was
that and nothing else.

`open-guard.spec.ts` now dismisses every native window in BOTH `beforeEach` and `afterEach`, and the
`beforeEach` asserts the app has none left before the test begins — so a leak fails the spec that
caused it instead of the one after it. **Any future spec that raises a native dialog should copy that
pair.** The related lesson for the enumeration itself: the unsaved-changes prompt is an rfd TASKDIALOG
whose body is DirectUI, so a Win32 window walk cannot read it (that is why the shared driver uses UI
Automation) — but a FILE dialog is a plain `#32770` with a file-name `Edit` child, and the presence or
absence of that child is a reliable way to tell the two apart from outside the app.

#### ONE GOLDEN RE-RECORDED, and §2ac's blast-radius analysis had missed it

`visual` came back **17 passed / 1 failed**: `core-visual.spec.ts` -> *"edit menu open"*, **243
differing pixels, identical to the pixel on two consecutive re-runs** — deterministic, not a flake.
The diff image contains exactly four things: the Edit menu's **Undo** and **Redo** items, and the
ribbon's **Undo** and **Redo** buttons. Nothing else in the frame moved.

That is §2ac, and it is correct behaviour: the capture is taken immediately after
`resetToNewWorkbook`, so the document has just been replaced and both affordances are properly
greyed. The golden predates the enablement.

**§2ac enumerated its blast radius and got this one wrong by omission.** It named
`undo-across-open.spec.ts` and `ribbon-tabs.spec.ts` (which it fixed with a `beforeEach` that pins
the stack non-empty), checked `menu-interactions.spec.ts` (`toBeVisible` is true of a disabled
button) and concluded "NOTHING ELSE". The visual project's own menu golden photographs the Edit menu
directly and was never considered.

The golden was re-recorded rather than pinned, and the reason is the opposite of `ribbon-tabs`'s: the
ribbon golden is taken mid-suite where the stack's depth is incidental, so it had to be pinned; this
one is taken on a document that has *just been reset*, where "both disabled" is the only correct
picture and is reached deterministically. Re-recorded golden:
`e2e/visual/__screenshots__/core-visual.spec.ts/menu-edit-open.png`,
`e81c8f44…` -> `22bf900b…`. The full project is **18/18** on a cold app afterwards.

#### AND ONE SPEC-AUTHORING TRAP, recorded because the test caught it and review would not have

`computed-property-restore.spec.ts` captures the slicer's header bar as pixels. `slicer.x/y` are SHEET
coordinates, so that clip is only over the slicer while the grid is parked at the origin — and the
spec's own edits go to `DA1`, a hundred columns away. The first version failed BOTH ways in one run:
the pre-reload comparison "passed" because the whole viewport had scrolled between the two captures,
and the post-reload one "failed" because both captures photographed the same empty patch of grid.
**A pixel oracle that moves with the camera measures the camera.** The capture normalises scroll first.

### 3be. §2ab CLOSED — by persisting the array's EXTENT, not by dropping its cells. The register's own recommendation was reversed, because the Excel claim underneath it is false — and checking that claim also found the `.xlsx` export corrupting every dynamic array (2026-08-10)

**The brief asked me to verify the Excel claim myself rather than take it, and verifying it inverted
the fix.** §2ab and §3bb both concluded: spilled cells are derived state, Excel does not store them,
Excel recomputes the array from the origin on load, so `.cala` should stop storing them and let the
load recalculation re-spill. Every clause of that except the first is wrong.

#### What Excel actually does, verified against the format rather than remembered

In `xlsx` a dynamic-array origin is one cell element carrying the formula, the array's RANGE, and its
cached top-left value:

```xml
<c r="A1" cm="1"><f t="array" ref="A1:A4">SEQUENCE(4)</f><v>1</v></c>
<c r="A2"><v>2</v></c>
<c r="A3"><v>3</v></c>
<c r="A4"><v>4</v></c>
```

* `ref` on `<f t="array">` **is the spill extent**, persisted. ECMA-376 Part 1 §18.3.1.40
  (`CT_CellFormula`) defines `ref` as "range of cells which the formula applies to", required for a
  shared formula, an array formula or a data table. Verified in this repo's own dependency tree
  rather than from memory: `rust_xlsxwriter-0.79.4/src/worksheet.rs::write_array_formula_cell` emits
  exactly the element above (and `cm="1"`, the cell-metadata flag that distinguishes a DYNAMIC array
  from a legacy CSE one), and `calamine-0.26.1/src/xlsx/mod.rs` parses `ref` back.
* The cells the array covers are written as ordinary **value-only** `<c>` elements with no `<f>` —
  i.e. Excel *does* persist the spilled cells, as literals, exactly as Calcula already did.
* So Excel recomputes **neither** half on open. It reads the values and it reads the ownership.

**Why that split is the right one, and not merely Excel's.** The spilled VALUES are a cache: derived,
re-derivable, cheap to be wrong about. The OWNERSHIP is not derivable at any price short of
re-evaluating every formula in the workbook — a spilled `2` and a typed `2` are the same bytes.
§2y's observation that spilled cells are derived state (which is why they get no undo entry) is true
and was applied to the wrong noun.

Under the owner's standing rule that Excel parity decides open questions, the fix is therefore:
**persist the extent, keep the values, recompute nothing.**

#### What shipped

**Format.** `SavedCell::spill: Option<(u32, u32)>` — the bottom-right of the rectangle, on the ORIGIN
only. Serialised as `CellEntry::sp`, an A1 range including the origin, so a sheet's `data.json` reads
`"A1": { "v": 1.0, "t": "n", "f": "SEQUENCE(4)", "sp": "A1:A4" }` — Excel's shape, and legible next to
a sheet XML. A rectangle rather than a cell list for the same two reasons `ref` is one: it is two
numbers for an array of any size, and it also records ownership of spilled cells whose value is
EMPTY, which the sparse writer drops from `data.json` entirely and which would otherwise come back
editable in the middle of a protected block.

**`format_version` 7**, `SPILL_EXTENT_MIN_FORMAT_VERSION`, stamped ONLY when some cell carries an
extent — so a workbook with no dynamic array still writes v1–v6 and stays openable by older builds.
It earns a link in the chain by the chain's own test (would an older reader MISHANDLE the document,
or merely lose cosmetic state?) more clearly than any existing link: an older reader drops `sp`, then
re-saves the spilled values as ordinary literals, and the file comes back **looking correct and
being wrong** — the array owned by nothing, its cells individually editable, and the origin
collapsing on the next re-evaluation. `CALA_MAX_SUPPORTED_FORMAT_VERSION` 6 → 7.

**Save.** `apply_spill_extents_to_sheet` joins `AppState.spill_ranges` onto the saved cells inside
`build_workbook_for_save`, one line after `apply_user_hidden_to_sheet` and for the identical reason:
`engine::Cell` has no notion of a spill, so the ownership has to come from the store that holds it.
An origin that is no longer a formula is skipped rather than stamped — a claim with nothing to
re-derive it from can only destroy cells.

**Load.** `app/src-tauri/src/spill_restore.rs`, called from `open_file` after
`rebuild_all_dependencies` and before the `CellData` payload is built. It is the refill half that
`reset_document_scoped_stores`'s comment had always implied existed.

**`.calp`.** The package carries the same field for free — publish and pull both go through
`cells_to_sheet_data` / `sheet_data_to_cells` — so a subscriber's arrays are owned the moment they
land, with no recalculation. All five paths that install a pulled sheet's grid (`calp_pull`,
`calp_refresh_apply`, `calp_dev_subscribe`, `calp_dev_refresh`, `calp_reset_subscription`) now call
`restore_spill_extents_for_sheet`, which SWEEPS the target sheet index before installing. That
sweep is the half a pure append would not have needed: three of the five REPLACE a sheet's whole
grid, and a `spill_hosts` entry surviving that replacement is §2x's class of defect one document
over — an edit refused in the name of a formula that is no longer there. A source census
(`every_calp_sheet_install_restores_the_spill_extents`) keys on `pulled.sheet.to_grid()` so a sixth
path cannot be added without one.

#### The existing corpus — and why the recovery never writes

Workbooks already on disk carry the spilled literals and no extent. They are routed by
`persistence::Workbook::format_version`, a new INBOUND-only field carrying the version the archive
was READ at (`0` for `.xlsx` and for anything built in memory; the writer never reads it and
re-derives its own stamp). Below v7, `recover_spill_map_by_evaluation` runs: one evaluation per
formula cell, per sheet.

**No dependency ordering is required, and that is not luck.** A formula reads its precedents from the
GRID, and the grid already holds every value the file cached. So each origin evaluates against
exactly the values that were on screen when the workbook was saved, in whatever order the pass
visits them. It is the same property that lets Excel open an array-bearing workbook without
recalculating it — and it is the concrete reason the load path did NOT have to become a
recalculation, which was the cost §2ab was worried about.

**It claims a footprint only when the file's own values agree with the fresh array cell for cell,
including the origin — and therefore it never writes anything.** Every cell a successful claim covers
already holds the value the array produces, and a cell the array leaves empty was never persisted.
Where the values DISAGREE (a build with a different function set, a precedent now `#REF!`) it claims
nothing and leaves the grid untouched: that workbook then behaves exactly as it did before this
existed, which is bad but honest, and it self-heals on the first save. The alternative — claiming the
footprint anyway and overwriting whatever is under it — would delete cells on the strength of a guess
about which of them used to belong to an array, and nothing in a pre-v7 file supports that guess.
A user's typed literal sitting where an array would go is pinned by
`the_recovery_leaves_a_genuine_blocker_alone`.

**The legacy cost is self-extinguishing**: open once, pay the pass; save once, the file is stamped v7
and never pays again.

#### The benchmark

`bench_the_load_path_cost_of_spill_ownership` (ignored by default:
`cargo test --lib -- --ignored --nocapture bench_the_load_path_cost`). Dev profile — the app crate at
`opt-level = 0`, `engine`/`parser` at 3, i.e. what `tauri dev` actually runs. Both paths linear.

| workbook | v7 restore | pre-v7 recovery |
|---|---|---|
| 50 000 formulas, **no array** | **1.68 ms** | 99.4 ms (50 000 evaluations) |
| 1 000 formulas + 10 arrays x 100 | 0.77 ms | 3.1 ms (1 010 evaluations) |
| 10 000 formulas + 50 arrays x 200 | 8.2 ms | 32.0 ms (10 050 evaluations) |
| 50 000 formulas + 100 arrays x 500 | 41.4 ms | 180.6 ms (50 100 evaluations) |

**Read the first row, because it is the common case.** A large workbook with no dynamic array pays
1.68 ms on the v7 path — one linear scan of the cells, no allocation, no evaluation — against 99 ms
to prove by evaluation that there was nothing to prove. That gap is the whole argument for persisting
the extent, and it is also what "recompute on load" would have cost EVERY workbook forever rather
than pre-v7 files once. The v7 cost scales with SPILLED CELLS (one map insert each), not with
formulas; the 39.6 ms row is 49 900 `HashMap` inserts that a live session builds anyway.

**Two guards on the restore**, because an extent is unverified input. An extent whose area exceeds
one full column (1 048 576 cells — already the largest map a live session could build for one origin,
so nothing a user can do is refused) is rejected rather than allocated. An extent overlapping a claim
another origin already made is rejected WHOLE rather than trimmed, so one origin's tear-down can
never erase another's output. Both rejections degrade to the pre-v7 behaviour, which is recoverable;
neither can delete a cell. A malformed, reversed or wrong-anchored `sp` is discarded at the format
boundary (`cell_ref::range_from_a1` + an anchor check in `entry_to_saved_cell`), so the host never
sees one.

**And a fuel ceiling on the recovery**, declared rather than inherited
(`eval_budget::inherit_or(EvalSurface::Background)`). It runs on the OPEN path, where nothing else
has installed a governor, and it evaluates arbitrary formulas out of an untrusted file — so a
runaway formula in a pre-v7 workbook costs a bounded amount of work and comes back `#LIMIT!` (which
is simply not an array, so nothing is claimed) instead of hanging the open with no Cancel button
anywhere. `Background` because the user did not personally start this pass, which is what that
surface is for.

#### A THIRD defect, found by reading Excel's format instead of assuming it: the `.xlsx` export was corrupting every dynamic array

Not on anyone's list, and only visible once the extent existed to compare against. `xlsx_writer` had
no notion of a spill: it wrote the origin as an ORDINARY formula and the cells it produced as loose
literals.

```
Calcula:  A1 =SEQUENCE(4)  ->  1 2 3 4
exported: <c r="A1"><f>_xlfn.SEQUENCE(4)</f><v>1</v></c>
          <c r="A2"><v>2</v></c> ... three literals, owned by nothing
opened in Excel:  A1 -> #SPILL!
```

`rust_xlsxwriter` sets `fullCalcOnLoad="1"`, so Excel re-evaluates A1 on open, the array tries to
spill onto the very literals the writer just emitted, and it is **blocked by its own output**. Every
dynamic array in every exported workbook, silently, with the failure only visible in Excel.

The fix is the same fact in the other direction: write the origin with
`write_dynamic_array_formula`, so it carries `ref` and `cm="1"`, BEFORE the cell loop — the library
pads the declared range with `0` placeholders, and the ordinary cell loop then replaces those with
the workbook's real cached values while leaving `ref` intact. The bytes are now exactly Excel's:

```xml
<c r="A1" cm="1"><f t="array" ref="A1:A4">_xlfn.SEQUENCE(4)</f><v>1</v></c>
<c r="A2"><v>2</v></c><c r="A3"><v>3</v></c><c r="A4"><v>4</v></c>
```

The origin's `<v>` is its REAL first value rather than the library's `0` default
(`cached_result_literal`), so a reader that does not recalculate — a preview pane, `openpyxl` with
`data_only=True` — sees the array rather than a zero. A cell inside the footprint that carries its
OWN formula is deliberately left to the cell loop and lands as a formula, so `#SPILL!` stays
available for the case where it is the right answer
(`a_real_blocker_inside_a_footprint_is_still_exported`).

**The import direction is unchanged and does not need to change.** `xlsx_reader` goes through
calamine, which surfaces the formula text but not the `t="array"`/`ref` pair, so an imported array
arrives as an origin plus loose literals — and `format_version: 0` on an imported workbook puts it
below the gate, which is what routes it through the same recovery a pre-v7 `.cala` gets. An imported
Excel dynamic array is therefore re-proved by evaluation and comes out owned.

#### The `.calp` compatibility stamp

The publish path already has the right mechanism and it was not being used for this:
`carries_wave_content` stamps `min_app_version` with the publishing app's own version exactly when a
package carries something an older app would pull "successfully" and then silently drop. A spill
extent on a published sheet is now one of those, and it is the sharpest case in the list — an older
subscriber writes the spilled cells as ordinary literals, drops the ownership, and gets an array that
looks right and collapses on the first re-evaluation of its origin. Cell-only packages with no array
still stamp nothing and stay pullable by older apps, which is the point of that function; pinned by
`pull.rs::a_published_dynamic_array_declares_a_minimum_app_version`, including that an array on a
sheet the package does NOT publish must not stamp.

#### Proved on the RUNNING app, not only in-process

The whole §2ab probe, driven through the real backend over CDP on a cold `tauri dev` build, with a
real `.cala` written to and read from disk:

```
1. live                     EB5:EB8 -> 1 2 3 4     spill_ranges [{4,131 -> 7,131}]
2. save, File > New, reopen EB5:EB8 -> 1 2 3 4     spill_ranges [{4,131 -> 7,131}]   <-- WAS []
3. set EA5 = 4 (SAME value) EB5:EB8 -> 1 2 3 4     spill_ranges [{4,131 -> 7,131}]   <-- WAS #VALUE!
4. set EA5 = 2 (SHRINK)     EB5:EB8 -> 1 2 _ _     spill_ranges [{4,131 -> 5,131}]   <-- WAS 1 2 3 4
5. set EA5 = 6 (GROW)       EB5:EB10-> 1 2 3 4 5 6 spill_ranges [{4,131 -> 9,131}]
6. type into EB6            REFUSED: "Cannot edit cell (6, 132): it contains a spilled array
                            value from cell (5, 132)."                                <-- WAS ACCEPTED
```

Step 4 is the one that matters most and is the hardest to see: before this, shrinking a reopened
array left `3` and `4` sitting under a live origin, presented as its output, with no error anywhere.

The bytes on disk are Excel's shape exactly — `manifest.json` `formatVersion: 7`, features
`["spill_extents", "theme"]`, and in `sheets/0_Sheet1/data.json`:

```json
"EA5": { "v": 4.0, "t": "n" },
"EB5": { "v": 1.0, "t": "n", "f": "SEQUENCE(EA5)", "sp": "EB5:EB8" },
"EB6": { "v": 2.0, "t": "n" },
"EB7": { "v": 3.0, "t": "n" },
"EB8": { "v": 4.0, "t": "n" }
```

— the origin carrying formula + extent, the covered cells value-only, which is `<f t="array"
ref="EB5:EB8">` plus three bare `<v>` elements in any other spelling.

#### Tests

25 new, all green (22 in the app crate, one in `calp`, two in `persistence`). `commands/spill_persistence_tests.rs` (21 + the benchmark) does a REAL `.cala`
round trip — `write_calcula_bytes` → ZIP bytes → `read_calcula_bytes` — rather than reproducing a
load STATE: the §2ab reproduction start to finish including the edit that writes `4` over a cell
already holding `4`; a reopened array refusing an edit to one of its cells and naming the origin; the
array that SHRINKS after a reload (the case where F9 used to leave stale literals under a live origin
presented as its output) and the one that GROWS; an origin whose dependency broke; an origin whose
function this build lacks; the conditional v7 stamp; the pre-v7 corpus recovering by evaluation; the
recovery declining a disagreement and sparing a genuine blocker; malformed and overlapping extents;
and three source censuses pinning that the save still stamps, the open still restores, and every
`.calp` install still sweeps.

`spill_map_tests.rs`'s characterisation test was INVERTED rather than deleted, and renamed to
`the_restored_spill_map_is_what_keeps_a_reloaded_origin_alive_2ab`. It now asserts BOTH halves in one
test: without the map the origin still collapses to `#VALUE!` (so nobody concludes the defect was
imaginary, and so the restore stays visibly load-bearing), with the map restored it survives. The
three `EXEMPT` reasons that pointed at §2ab (`open_file`, `run_calculation_pass`,
`recalculate_sheet_values`) were rewritten to say what is now true.

`bulk_rewrite_recalc_tests::NOT_A_GRID` gained `sheet` with its reason: `apply_spill_extents_to_sheet`
reaches `.cells.get_mut(` on a `persistence::Sheet`, which is the SAVE-side snapshot, not a live
`engine::Grid`.

`persistence/xlsx_writer.rs` gained
`a_dynamic_array_exports_as_one_array_formula_not_as_literals`, which asserts the exported
`sheet1.xml` BYTES rather than a round trip, because the round trip through Calcula's own reader
cannot see the defect — only Excel can — and
`a_real_blocker_inside_a_footprint_is_still_exported`.

#### What this does NOT fix, and one thing it makes fixable

~~**`run_calculation_pass` and `recalculate_sheet_values` are still not spill-aware.**~~
**BOTH ARE, from 2026-08-11 (§3bs)** — and so is the cross-sheet walk. The third residual this
paragraph left open (a spill torn down on a BACKGROUND sheet staying down until that sheet is edited
while active, §2y's known residual) is closed with it: F9 plans the workbook, and every sheet it
plans now goes through the same spill decision an edit makes. The two `EXEMPT` reasons this
paragraph referred to are DELETED, along with four more, because the six functions now maintain the
map instead of arguing that they need not.

**`A1#` is frozen at entry, and persisting the extent removes the stated reason.** Filed as §3bf.

**`#SPILL!` does not exist.** Filed as §3bg.

---

### 3bf. `A1#` is resolved once, at entry, and stored as a fixed range — so a spill reference does not follow its array (2026-08-10) — **FIXED 2026-08-11 (§3bs), together with its neighbour §3bm**

> **FIXED.** The stored formula keeps the `#` and it resolves at EVALUATION, with a dependency
> edge — the D2/§2aj recipe a third time. Landed in the same pass as §3bm because the two really
> did want one answer about where a spill fact lives: §3bm made the recalculation pass the fourth
> place that decided a spill, and §3bf made `eval_ast` the one place that reads one. Full write-up,
> including the two defects the §3bf tests found in code nobody had suspected, in **§3bs**.

`split_entered_formula` calls `resolve_positional_refs`, which turns a typed `A1#` into a plain
`Range` **in the form the cell STORES** (`EnteredFormula::stored`, not merely in the form it
evaluates). The comment on that function states the reason outright: *"Both are resolved at entry in
both forms, because neither can be re-derived later from the cell alone."*

So `=SUM(A1#)` is stored, rendered in the formula bar, and saved as `=SUM(A1:A4)`. If A1's array then
grows to five, the reference still reads four. In Excel `A1#` is a LIVE reference to whatever the
array currently spans — that is its entire purpose — so this is a parity gap, and a silent one: the
formula bar shows the frozen range, so there is nothing on screen saying the `#` was ever there.

**Why it is worth filing now.** The stated blocker was that the spill range could not be re-derived
from the cell later. It can now: the extent is persisted and the map is restored on load, so a stored
`SpillRef` could be resolved at evaluation time the same way a stored `NamedRef` is (D2's shape
exactly — keep the name-bearing tree, expand only for the evaluator). The pieces are
`crate::resolve_spill_refs_in_ast` (already written, already called from two places) and
`name_resolution::eval_ast`, whose own doc records that it deliberately does NOT resolve spill refs
because that would take `state.spill_ranges` once per evaluated dependent — a real cost, and the
thing to measure if this is picked up.

**Reproduction, INVERTED 2026-08-11** — the characterisation test is now
`spill_persistence_tests::a_spill_reference_follows_its_array_3bf` and asserts the parity answer:
`=SEQUENCE(B1)` in A1 with `B1 = 4`; `=SUM(A1#)` in C1 reads 10 and is STORED as `SUM(A1#)`;
`B1 = 5` grows the array to five and C1 reads **15**, as Excel does. A dedicated module,
`commands/spill_ref_tests.rs`, carries the rest (§3bs).

---

### 3bg. There is no `#SPILL!` — a blocked dynamic array reports `#VALUE!` (2026-08-10) — **FIXED 2026-08-11 (§2an), and the fix found a much bigger defect behind it**

> **Cost update (§3bi, 2026-08-10).** Still open, and now cheaper than this section estimated. The
> "small but wide" list below counted the error enum, the literals table, `isErrorValue`, the TS
> mirror, error checking and the audit. Adding `CellError::Null` and `CellError::Num` for the .xlsx
> importer walked exactly that path and found it narrower than feared: **no exhaustive `match` in
> either workspace broke**, `isErrorValue`'s drift guard reads `cell.rs` at test time and picks a new
> variant up for free, and the only hand edit needed was the UDF-wire list in `formulaFunctions.ts`.
> A `Spill` variant is now a four-file change, not a wide one.

`engine::CellError` has `Div0 Ref Name Value NA Circular Conflict Blocked Limit` and no `Spill`.
`reevaluate_formula_cell`'s blocked branch returns `CellValue::Error(CellError::Value)`, so an array
that cannot spill is indistinguishable from a wrong argument type.

Excel has `#SPILL!` as a distinct error precisely because the remedy is different and specific:
"clear the cells the array needs", not "fix the argument". The variant would also make blocked spills
COUNTABLE for error checking and the audit trail, which is the argument `CellError::Limit`'s own doc
makes for existing at all.

Not done here because it is not a spill-persistence change: it touches the error enum, the canonical
literal table, `isErrorValue` and the error-spelling parity work D7 closed, the TS mirror, error
checking and the audit categories. Sized as small but wide.

**Reproduction, RUNNING** inside
`spill_persistence_tests::the_recovery_leaves_a_genuine_blocker_alone`, whose precondition asserts it:
type `x` into A2, then `=SEQUENCE(B1)` into A1. A1 reads `#VALUE!`; Excel reads `#SPILL!`.

---

### 3bh. `dialogGlobalsBan.test.ts` is a 30-second timeout waiting to happen — FIXED, and the number the register quotes was measured against it (2026-08-10)

> **Not fully fixed by this section — see §3bu.** Sharing one `ESLint` instance removed 22 of the
> 23 config loads, but the surviving load is still billed to whichever case runs FIRST, and it blew
> the 30 s timeout again on a later full run. The load is SETUP and is now billed there
> (`beforeAll`, 300 s budget).

Running the FULL vitest suite for §2ad–§2ah produced `746 passed | 1 failed` and the failure was
`the dialog-globals ban > rejects qualified window.confirm in src/`: **`Test timed out in 30000ms`**,
not an assertion. The same file passes 23/23 in 2 seconds on its own.

**Cause.** `lint()` constructed a NEW `ESLint` instance per case — 23 config loads of the real project
config. Under the full suite everything runs in parallel, the first case pays the cold load, and 40s
of it lands on a 30s test timeout. One shared lazily-created instance removes it: `cwd` and the config
are constant and the per-case `filePath` is already an argument to `lintText`.

**Why this is worth an entry rather than a commit.** The failure reads, in the log, exactly like the
dialog-globals lint rule having been deleted — which is the one thing that file exists to detect. A
guard whose failure mode is indistinguishable from the defect it guards is a guard that will be
ignored the third time it cries. Full-suite numbers after the fix are in the pass summary; the
106,216 figure this register quotes was reproduced exactly, so no other count moved.


### 3bi. The second hunt verification pass — thirteen findings checked, ten real, two STALE, one refuted in part; the xlsx formula path was the priority and had three wrong-answer defects of its own (2026-08-10)

A second read-only hunt filed thirteen findings (F1–F13) over four surfaces the program had not
examined: `.xlsx`, the soak/invariant projects, `model-engine-lib`, and performance. Like the first
hunt (§3ba) it had run nothing — no build, no test, no app — and said so. Every finding was
reproduced before anything changed. **Three verdicts came back different from the filing, and the
refutation is the most useful of them**, because it corrects a claim this register itself records.

**The verification table.** "Evidence" is what was executed, not what was read.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| F2 | `render_table_specifier` emits text the parser cannot read back for 3 of 9 variants | **REAL** | Harness over all nine: `ColumnRange` → `T[a]:[b]` **parse error**; `ThisRowRange` → `T[@a]:[@b]` **parse error**; `SpecialColumn` → `SUM(SALES[#Data],REVENUE)` re-parsed with **arg count 1 → 2** |
| F1 | A second AST→text serialiser survives with 248 `{:?}` names and no paren guard | **REAL, and there were TWO** | Mechanical count: **472 variants, 224 handled, 248 fall through**. `formula_eval_plan.rs::build_spans_recursive` is a THIRD copy the hunt did not name |
| F4 | `_xlfn.` never stripped → every post-2007 Excel function imports as `#NAME?` | **REAL** | Hand-built .xlsx through `load_xlsx`: `=_xlfn.STDEV.S(A1:A2)`, `=_xlfn.XLOOKUP(…)`, `=_xlfn._xlws.FILTER(…)`, `=_xlfn.LET(_xlpm.x,…)` all arrive with the prefix intact |
| F3 | Every error cell imported from .xlsx becomes `#VALUE!` | **REAL** | Same harness: `Error("Div0")`, `Error("NA")`, `Error("Ref")`, `Error("Name")`, `Error("Null")`, `Error("Num")` — calamine's **Debug** names, none of which `from_literal` matches |
| F5 | Ctrl+S onto an open .xlsx bypasses the lossy-save consent | **REAL** | `saveFile` reads `currentPath` and calls `save_file` with no extension check; the prompt exists only in `saveFileAs` |
| F6 | The loss report misses images/media/user files/theme/geometry/rich text; no census | **REAL** | Field walk: the writer touches **6** of `Workbook`'s 37 fields; the report covered 24 checks and **8 stores were dropped in silence** |
| F10 | A formula cell with no cached `<v>` is dropped on import | **REAL** | `<c r="B1"><f>A1*2</f></c>` → the cell is **absent** from the loaded sheet |
| F9 | An Excel-illegal sheet name aborts the whole .xlsx save with a raw library message | **REAL** (narrowed) | Entry-time validation (§2ag) now blocks the common source, but LOAD deliberately accepts and carries legacy names, so it is still reachable |
| F13 | The BI expression language cannot express a `"`; the formatter does not escape one | **REAL** | `tokenizer.rs` scans to the first `"`; `format.rs` emits `format!("\"{v}\"")` unescaped |
| F12 | The 1904 date system is ignored | **REAL** | `grep -r 1904` over `core/` and `app/src-tauri/` returns nothing but a crc32 table; `calamine` is declared without the `dates` feature |
| **F7** | **Spill maps are never rebuilt on load, so `A1#` degenerates to `A1`** | **STALE — already fixed** | `spill_restore::restore_spill_map_on_load` is called from `open_file`; the §2ab pass landed it while the hunt was reading. **One sub-claim survived and was real** — see below |
| **F8** | **Spill regions export to .xlsx as `#SPILL!`** | **STALE — already fixed** | `xlsx_writer` calls `write_dynamic_array_formula`; same §2ab pass |
| **F11** | **calamine expands only 1-D shared formulas** | **NOT VERIFIED — left filed** | A dependency limitation needing a crafted 2-D `ref` fixture; not reproduced, not acted on |

**THE REFUTATION, and it corrects this register.** F3 carried a rider: that `cell.rs`'s comment
("#NULL!/#NUM! are deliberately absent … see `CELL_ERROR_LITERALS` in cellFormatting.ts, which still
recognises them because they can arrive by xlsx import") was "wrong on 3 counts", one being that the
list "is in `formulaFunctions.ts` (not cellFormatting.ts), has 9 entries, and contains neither".
**There are TWO such lists.** `app/src/core/lib/gridRenderer/styles/cellFormatting.ts` has 12 entries
and *does* contain `#NULL!` and `#NUM!` — the comment pointed at the right file. The hunt found the
*other* list (`app/src/api/formulaFunctions.ts`, the UDF-wire normaliser) and reported it as the only
one. The substantive half of the rider was true, though, and it is the interesting half: **the claim
"they can arrive by xlsx import" was false, because the importer mangled them first.** The absence
justified itself with a second bug.

**`CellError` gained `Null` and `Num`.** Under the Excel-parity rule this was not close: with the
reader fixed, an imported `#NULL!` had exactly two possible fates — a variant of its own, or silent
rewriting to `#VALUE!` on the way in. Both `as_literal` and `from_literal` now carry them, the UDF
wire list matches (a test that pinned the old absence was inverted, with the reason), and the
`isErrorValue` drift guard picks them up for free because it reads `cell.rs` at test time.
**Not** yet produced by the evaluator's own numeric work — `SQRT(-1)` still answers `#VALUE!`. That is
a separate parity gap and is filed as **S6** below, unfixed.

**F1 was worse than filed, and the guard is the reason.** `the_app_crate_has_no_second_serialiser`
scanned ONE file (`lib.rs`) for THREE function names. So it could not see `evaluate_formula.rs`, which
held a complete renderer under different names — nor `formula_eval_plan.rs`, which held a third. Both
are now **deleted**, not disciplined: `ast_render` grew a span-collecting mode
(`render_with_spans`), and the two app-crate entry points are one-line delegations. The offsets that
drive the Evaluate-Formula underline and the Formula Visualizer's step markers now come from the
renderer that produces the text, so a highlight cannot point at something the text does not say.
The guard was replaced with one that scans **every** `.rs` in the crate for the SHAPE — bulk
`BuiltinFunction::X => "NAME"` arms, and a Debug fallback beside them — after stripping comments,
because the first version of it flagged the two doc comments that *describe* the defect.

**F7's surviving sub-claim was real and is fixed.** `resolve_spill_refs_in_ast` keyed the lookup on
`(current_sheet_index, row, col)` while copying the ref's own `sheet` into the Range it built. So
`=SUM(Sheet2!A1#)` looked the anchor up in the **active** sheet's map, missed, and fell back to the
bare cell: the formula silently became `=SUM(Sheet2!A1)` — one cell instead of the array, no error, a
different number. It now resolves the qualifier to its own sheet index, and a qualifier naming a
sheet that does not exist takes the miss path rather than falling back to the active sheet.

**What the .xlsx work is really about.** This is the format other applications read, so a defect here
is a defect in someone else's spreadsheet. Between them the reader and writer had **exactly one test**
(hidden rows/cols) — no formula round-trip, no error round-trip. That absence is why F3, F4 and F10
survived. There are now five, including the one that ties this section to the renderer work: a grouped
expression (`=(A1+B1)*C1`, which has no parenthesis node in the AST and depends entirely on the
renderer's precedence guard) and a dotted function name (`STDEV.S`, one of the 248) written to a real
`.xlsx` file and read back unchanged.

**F6 got a producer, not just more checks.** Eight missing `check(...)` lines would have drifted again.
`XLSX_LOSS_COVERAGE` now names all 37 `Workbook` fields with a verdict — `WRITTEN`, `REPORTED`, or
`SILENT` **with a written reason** — and the census reads the field list out of
`core/persistence/src/lib.rs` at test time, so a new field cannot be added without deciding whether an
.xlsx save loses it. The worst single omission: the report's "Pane controls" line reads
`PaneControlState.controls`, a different store from `Workbook::controls` — the cell-anchored store
where every embedded **image** lives. A workbook full of pictures reported no loss at all.

**What the hunt was right about that is not a defect.** Its reading of the soak/invariant projects
stands and is worth keeping: the walker's entire formula alphabet is six formulas with no
parentheses, no structured table refs, no dynamic arrays, no `^`, no unary minus and no cross-sheet
refs — so F2, the spill class and the whole renderer round-trip class are **invisible to the soak by
construction**. A green soak run is therefore weak evidence for anything in this section. Widening
`walker/actionCatalog.ts` is filed as **S9**. Its performance reading also stands: the benches cover
`core/engine` and `core/pivot-engine` only, and `app/src-tauri` has none, so "benches unchanged" must
not be read as "no regression" for anything in the app crate.

**`model-engine-lib` was reached** (F13), so its own suite was run and its mandatory
`docs/host-integration-changelog.md` entry was added. `""` doubling is DAX's escape, so Power BI
parity settled the spelling; both halves (tokenizer and formatter) changed together.

#### The regression this pass introduced, and what caught it

The F7 sheet-key fix needed the sheet-name table inside `resolve_spill_refs_in_ast`, and the obvious
way to get it — `state.sheet_names.read()` at the point of use — **deadlocked the app-crate suite**.
All three call sites already sit inside a scope holding that same read guard (`data.rs:1278`,
`data.rs:2837`, `udf.rs:244`), and `std::sync::RwLock` does not promise a recursive read is safe: on
Windows it is an SRWLock, where a second read on the same thread blocks forever as soon as a writer is
queued. `a_spill_reference_is_frozen_at_entry_3bf` hung, and because a hang is not a failure the
suite simply never returned.

Fixed by threading `sheet_names: &[String]` down through `split_entered_formula` and
`resolve_positional_refs` instead of re-acquiring — the names are already in hand at every caller.

**Two things worth keeping from this.** First, `cargo test --lib` for this crate rebuilds the test
binary, which **discards the embedded comctl32 manifest** and makes the run die with `0xc0000139`
before a single test executes; the documented workflow (`--no-run`, then `fix-test-manifest.ps1`, then
run the exe **directly**) is not optional, and the exe must be dead before the next link or the build
fails with `LNK1104`. Second, and more important: a hang reads as "still running", so it is invisible
to any check that only looks at exit status or a failure count. Running the suite to completion — not
compiling it, not running a filtered subset — is what found this.

#### Filed, not fixed

- **S6 — `#NUM!` was representable but never produced. FIXED 2026-08-11 (§2am).** The evaluator
  now raises it: 190 guards rewritten by a mechanical sweep plus 60 hand edits, over ~110 functions.
  `#NULL!` is still never produced — the intersection operator has no `#NULL!` path — and that half
  stays filed here.
- **S7 — F11: calamine expands only 1-D shared formulas.** `cells_reader.rs` builds the offset map
  only for a single-row or single-column `ref`; a 2-D `ref="B2:D10"` yields an empty map and every
  follower gets no formula. **Reproduction needed:** a crafted .xlsx with a rectangular shared-formula
  `ref`. Not reproduced here, and not fixable inside Calcula — it is a dependency limitation.
- **S8 — `WorkbookProperties` are written on .xlsx export and ignored on import.** One-way loss:
  title/author/subject survive a save and vanish on the next open. `xlsx_reader.rs` never populates
  them. Recorded in `XLSX_LOSS_COVERAGE` as part of the `properties` verdict.
- **S9 — the soak walker cannot generate a formula that trips any renderer defect.** Its alphabet is
  `=SUM(A1:A10)`, `=A1&B2`, `=IF(A1>0;1;0)`, `=AVERAGE(B1:B10)`, `=COUNT(A1:A30)`, `=MAX(A1:E5)`.
  Adding ~8 formulas to `walker/actionCatalog.ts:107` is the single highest-leverage change available
  to the soak system.
- **S10 — F12: the 1904 date system was ignored. FIXED 2026-08-11 (§2ao).** The importer reads
  `workbookPr/@date1904` and moves date-formatted serials onto the 1900 epoch. Whether Calcula should
  OFFER the 1904 system as a setting of its own is a product call and is filed as **D9**, with a
  recommendation.
- **Two allocation costs worth measuring rather than guessing** (the hunt's performance section, both
  re-read and both real as described): `calculation.rs` renders every formula on every sheet to a
  `String` and uppercases it on **every** row-visibility change (AutoFilter apply/clear, hide/unhide,
  outline collapse/expand, and every undo of those); and `rebuild_all_dependencies` runs on every
  sheet switch, allocating a fully expanded AST clone per formula cell. Neither is observable today —
  `app/src-tauri` has no benches.

### 3bj. §2ab, §2ag and the §3bi hunt fixes PROVED LIVE — and the first `soak` and `invariant` runs this program has performed, both of which failed (2026-08-11)

Everything below was executed on a COLD `tauri dev` build over CDP 9222, with the app relaunched
from `scratchpad/launch-vba-batch.ps1` before each run that is reported. Nothing here is inferred
from a unit test.

#### The new live proof: `app/e2e/journeys/reload-integrity.spec.ts`, 7 tests, all green

| # | What it proves | Time |
|---|---|---|
| 1 | §2ab: a reopened array is OWNED — the saved bytes carry `"sp": "B1:B4"` and `"formatVersion": 7`; the probe verbatim (same-value edit does not kill it; SHRINK leaves no stale cell; GROW works; a spilled cell refuses an edit and names its origin) | 17.1s |
| 2 | §3be's legacy corpus: a forged pre-v7 archive (`formatVersion` 6, every `sp` deleted, spilled values left as plain literals) opens with its ownership re-proved by evaluation, and shrinks clean | 13.5s |
| 3 | **TEETH** — see below | 13.7s |
| 4 | §3bi/F2: all NINE structured-reference forms survive the repair walker byte-identically | 13.1s |
| 5 | §2ag: five Excel-illegal names refused at entry, each with a message naming the rule, each changing nothing; and a workbook whose manifest carries `Bad/Name` still opens and brings its data | 17.4s |
| 6 | §3bi/F1+F3+F4: `=(A1+B1)*C1` (35, not 23), `STDEV.S`, `#DIV/0!` and `#N/A` through a REAL `.xlsx` (asserted to contain `xl/worksheets/sheet1.xml`, so it is not a `.cala` with the wrong suffix) | 15.4s |
| 7 | §3bi/F5: Ctrl+S onto an open `.xlsx` raises the consent prompt listing what is lost; **Cancel does not write** (mtime unchanged) and **OK does** | 13.2s |

**The teeth, and they are not an assertion — they are a third forged file.** Test 3 builds an archive
that KEEPS the `formatVersion: 7` stamp and deletes every `sp`. That gates the pre-v7 recovery off
and leaves the extent as the only possible source of ownership. It reproduces §2ab exactly on the
running build:

```
open (v7, no sp)   B1..B4 -> 1 2 3 4     spill_ranges []          <-- unowned
set A1 = 2         B1     -> #VALUE!      B2..B4 still 2 3 4      <-- the defect
```

So tests 1 and 2 are not passing because "something always runs": with the extent removed the array
comes back as four loose literals and collapses on the first edit of its input, which is what §2ab
was. Every other assertion in the file is likewise preceded by its own precondition — the File > New
wipe is asserted to have emptied the cell before every reopen; the legacy fixture asserts its own
legacy-ness (`formatVersion 6`, no `"sp"`, the literals still present); the refusal tests are
preceded by a LEGAL rename of the same sheet through the same route; and the consent test asserts
the loss report is EMPTY before it manufactures something to lose.

#### Two things writing it found

**1. A refused sheet rename reaches the user through a NATIVE message box, and a test that does not
drive it stacks them.** `alertAsync` goes to `tauri-plugin-dialog`, so the refusal is a Win32
`#32770` owned by app.exe that Playwright cannot see at all. Dispatching five illegal renames from a
probe left FIVE stacked "Calcula" boxes standing — invisible to every DOM query and inherited by
whatever ran next, the same hazard `open-guard.spec.ts` records for file pickers. The spec drives
them with `e2e/answer-native-dialog.ps1` and sweeps in `beforeEach` AND `afterEach`, over both titles
it can raise. The refusal text is worth recording because it is good: `Failed to rename sheet: Sheet
name cannot contain '[' -- the characters : \ / ? * [ ] are not allowed`.

**2. `render_table_specifier` is not reachable from a typed cell formula at all** — structured
references are resolved to absolute ranges at entry. Filed as **§2aj**, with the reproduction, and
**FIXED 2026-08-11**: a typed cell formula is now one of F2's populations, and the round-trip test
over five specifier forms is what proves it. It
does not weaken F2: the reachable route is a defined name's `refers_to`, which keeps the specifier
verbatim and is re-rendered by `repair_named_ranges` on every sheet rename, and that is what test 4
drives. Test 4 carries its own counterweight (`Follower = Sheet1!$A$1`, asserted to have become
`=Facts!$A$1`), so a repair walker that had simply stopped running could not pass it.

#### The project runs

| project | result | baseline | verdict |
|---|---|---|---|
| functional | **543 passed / 2 failed / 11 skipped** (39.3m) | 542 / 3 / 11 | no new failure; one baseline failure did not recur |
| journey | **117 passed / 1 skipped** (23.9m) | 110 / 1 | +7 = this section's new file, all green |
| scenario | **24 / 24** (1.7m) | 24/24 | unchanged |
| visual | **18 / 18** (2.7m) | 18/18 | unchanged |
| macro | **27 / 27** (5.9m) — invocation: `--project=functional --grep "[Mm]acro"` | 27/27 | unchanged |
| **invariant** | **1 passed / 1 FAILED** (2.4m) | never run | see below |
| **soak** | **1 FAILED** (16.7m, seed 20260810, failed at step 75 of 150) | never run | see below |

The two functional failures are the `ribbon-tabs` Ctrl+F1 golden and ONE `state-consistency` monkey
entry. The baseline's third failure (the second `state-consistency` entry, recorded as a cascade of
the first) did not recur — which is what a monkey test that seeds itself from the clock does. **The
re-run after the lexer change produced 542/3/11, the baseline exactly**, with both monkey entries
failing; and the FIRST of the two failed on a completely different invariant than it had an hour
earlier — `contextual-ribbon-tabs` ("Table Design" visible with zero tables) rather than
`undo-round-trip`, while the second is a bare 120 s timeout downstream of it. So
`state-consistency.spec.ts` is not one bug on HEAD: it is at least three
(`undo-round-trip`/sparklines, `undo-round-trip`/cells+tables, `contextual-ribbon-tabs`), and which
one a run reports is decided by the clock. That is the strongest argument for the `INVARIANT_SEED`
injection below.

#### The `invariant` project — FAILS, and the seed it told you to replay could not be replayed

`--project=invariant` is `state-consistency.spec.ts` with the oracle battery on. It fails
`undo-round-trip`, on `sparklines.*`:

```
Undoing 28 steps did not restore the checkpoint state. 1 differences;
first: sparklines.0[0]: "[{...id 4...}]" -> "[]"
```

**The first fix was to the harness, because the report was lying.** It printed
`Seed: 1786396152029  (use this seed to replay the exact sequence)` while the spec read
`const seed = Date.now()` with no way to inject one — so no invariant failure this system has ever
reported was replayable. It now reads `INVARIANT_SEED`. With
`INVARIANT_SEED=1786396152029 npx playwright test --project=invariant` the violation reproduces (as
`sparklines.0[0]: "[]" -> "[{...id 5...}]"` — the other direction, because the walk's action outcomes
depend on live app state, but always the same store).

**What was narrowed, and what was NOT.** On the running app, backend `obj_sparklines` undo/redo is
SYMMETRIC in isolation: create + delete + create with the walker's own timings, three trials,
`MATCH=true` every time; and again with real Ctrl+Z / Ctrl+Y interleaved. So the asymmetry needs
another action class to participate and is NOT a missing `record_sparklines_undo`. Two candidates,
both stated as hypotheses because neither was proved: the Sparklines extension writes to the backend
on a **300 ms debounce** (`scheduleSave`), so an undo entry can be pushed after a checkpoint has
already read `undoDepth`; and the oracle undoes/redoes through RAW `invoke`, deliberately not
notifying the frontend, on the argument that the round trip is exact — which the three suppressions
in `knownIssues.ts` guarantee it is not.

**Not fixed. Filed as S11** with the reproduction above.

#### The `soak` project — FAILS, with a confirmed, minimized reproduction

`SOAK_SEED=20260810 SOAK_ACTIONS=150 SOAK_ORACLE_EVERY=25 SOAK_BUDGET_MS=900000` — a bounded slice:
ONE walk, 150 actions, 15-minute budget, chosen because a walk costs ~17 minutes of app time and this
pass had five other projects to run. It failed at step 75 with `undo-round-trip` and **8 digest
differences**, and the system did its job: `replayConfirmed: true`, `minimizedActionCount: 55` after
22 shrink replays, bundle at
`app/e2e/results/soak/failures/2026-08-10T21-21-08-352Z-undo-round-trip/`.

Undoing 23 steps left THREE independent things the checkpoint did not have:

* `sheets[0].cells.3:3` — a cell edit (`Test54`) that undo did not remove;
* `tables.<id>` plus the five `autoFilters.0.*` fields that are its filter — a table restored by undo
  that the checkpoint did not have, i.e. a create and a delete that are not paired;
* `conditionalFormats.0` — **BUG-0020**, already ledgered and already suppressed. The violation is
  still reported because `filterKnownIssues` suppresses only when EVERY path is covered, which is the
  right design and is why this one surfaced instead of hiding.

**Not caused by this batch.** Nothing in the spill / renderer / `.xlsx` work touches chart, table or
conditional-format undo registration, and this is the same class the soak system found on its first
day. **Filed as S12** with the bundle path and the seed.

**And the soak's own limitation still stands** (§3bi, S9): the walker's formula alphabet is six
parenthesis-free formulas, so a green soak would have been weak evidence for anything in §3bi. It was
not green — and it still says nothing about the renderer.

#### Filed, not fixed

- **S11 — the `invariant` project fails `undo-round-trip` on `sparklines.*`.** Reproduction:
  `E2E_MANUAL=1 INVARIANT_SEED=1786396152029 npx playwright test --project=invariant`. Backend
  undo/redo of `obj_sparklines` is symmetric in isolation (measured); the divergence needs another
  action class. Suspects: the extension's 300 ms save debounce, and the oracle's raw-invoke round
  trip leaving the frontend store desynchronised. **SUPERSEDED by §3bk** — the third suspect turned
  out to be the oracle's own arithmetic, and "needs another action class" reads as "needs enough
  other actions to overflow the 100-entry undo cap". **CLOSED 2026-08-11 (§3bm): the seed was replayed
  against the id-based oracle on the running app and PASSED, twice, with all five checkpoints DECIDED
  (winding back 58/14/43/50/47 transactions) and none declining. The `state-consistency`
  INTERMITTENCY was a different defect all along — see §3bn.**
- **S12 — the `soak` project fails `undo-round-trip` with three independent undo leaks.**
  Reproduction: `E2E_MANUAL=1 SOAK_SEED=20260810 SOAK_ACTIONS=150 SOAK_ORACLE_EVERY=25
  npx playwright test --project=soak`; confirmed minimized trace in the bundle named above. One of
  the three is BUG-0020; the cell-edit and table halves are not ledgered anywhere. **ANSWERED IN
  §3bk**: it was ONE defect and TWO false reports. BUG-0020 is FIXED (the CF commands recorded no
  undo entry at all); the cell-edit and table halves are the oracle navigating by depth against a
  capped history, and the oracle now navigates by transaction id and declines to decide when the
  checkpoint has fallen off the end. **CLOSED 2026-08-11 (§3bm): the seed was re-run on the app,
  twice, cold — 150 actions, six checkpoints, all DECIDED (41/36/42/33/55/34 transactions), zero
  violations.**
- **§2aj — a structured reference is frozen at entry** (its own section above). **FIXED 2026-08-11**, together with §2ai and the two defects it uncovered (a column rename destroying its readers; §2al, a cross-sheet structured reference reading the wrong sheet).

#### Checking the "remaining" list instead of restating it — and the defect that found

The four items §3bi left filed were re-measured on the running app rather than repeated from the
register. Three are still exactly as recorded — `SQRT(-1)` and `LOG(0)` answer `#VALUE!` where Excel
answers `#NUM!` (S6); a dynamic array blocked by an occupied cell answers `#VALUE!` where Excel
answers `#SPILL!` (§3bg); `=Data!A1` is stored and shown as `=DATA!A1` (§2ai — **since FIXED**, see
that section). There is no date-system command at all (S10).

The fourth probe typed `=1E308*10` to see what numeric overflow answers, and it answered nothing —
the cell was not a formula. **`=1E3` was not a formula either.** Filed and FIXED as **§2ak**: the
lexer had no exponent rule, so a scientific literal lexed as two tokens, the parse failed, and the
app stored the user's text AS TEXT with no error anywhere.

#### Suite state after the Rust change

| suite | result | baseline |
|---|---|---|
| core cargo workspace | **1 313 passed / 0 failed** (2 pre-existing `dead_code` / `unused mut` warnings in test code this pass never touched) | 1 309 (+4 = §2ak's tests) |
| app-lib | **1 356 passed / 0 failed / 4 ignored** | 1 356, unchanged |
| vitest | **747 files / 106 217 passed / 0 failed** | unchanged |
| functional (re-run after the lexer change) | **542 passed / 3 failed / 11 skipped** (40.3m) | the register's baseline exactly |
| journey (re-run after the lexer change) | **117 passed / 1 skipped** (23.4m) | unchanged |
| check-types · lint:boundaries · check:line-endings · e2e `tsc` | clean | clean |

#### What this pass did NOT examine

`model-engine-lib` was neither touched nor run. The soak was ONE walk on ONE seed — the walk space is
sampled, not covered. No `.calp`, BI, pivot or Model Editor surface was exercised beyond whatever the
functional and scenario projects already reach, and no encrypted `.cala`, no AutoRecover cycle and no
multi-window path was driven. The vitest suite was run but nothing in it exercises the Rust lexer, so
it is evidence about the TypeScript side only. `check:script-typings` was not re-run: no script-facing
type changed.

### 3bk. S12 was ONE defect and TWO false reports — the undo-round-trip oracle was navigating by DEPTH, and depth is not a position (2026-08-11)

S12 handed over three "independent undo leaks" from the soak bundle
`app/e2e/results/soak/failures/2026-08-10T21-21-08-352Z-undo-round-trip/` (seed 20260810,
`replayConfirmed: true`, minimized 75 -> 55 actions). Reproducing them as Rust tests, as the brief
asked, is what settled them: **one is a real product defect and is fixed; the other two were the
instrument reporting its own blind spot.** Both halves are pinned by tests, and the second half also
explains S11 and the `state-consistency` intermittency that has been written off as monkey flake all
session.

#### What the bundle actually says

The oracle checkpointed after action 50, ran actions 51..75, undid **23** steps and found three things
the checkpoint had never had:

| leftover | walk action | verdict |
|---|---|---|
| `sheets[0].cells.3:3` — `D4 = "Test54"` | 54 | not a defect |
| `tables.<id>` + the five `autoFilters.0.*` fields | 51 | not a defect |
| `conditionalFormats.0` | 75 | **real — BUG-0020, fixed** |

Read the middle column. Two of the leftovers are the OLDEST mutations of the window and one is the
newest. **That shape is the finding.** A broken inverse leaves a defect-shaped leftover; a contiguous
*oldest-first* prefix is what "the undo stopped short" looks like from outside. And the window did not
push 23 transactions — it pushed roughly 36, because the walker's `table.create` writes nine cells
through `update_cell` before it creates anything, and every one of those is its own transaction.

The count was short because `undo_depth()` had **saturated**. History is capped at 100 entries
(`MAX_HISTORY_SIZE`, and Excel caps at 100 too, so parity keeps it there). Past the cap every push
silently drops the oldest entry and the depth stops growing, so
`undoDepth_now - undoDepth_baseline` under-counts by exactly the number evicted. The oracle undid 23
of ~36 transactions, stopped 13 short, and reported everything the walk had done in the first 13 as
an undo defect.

Nothing else can produce that outcome. Both "leaked" mutations DO record undo entries —
`update_cell` records unconditionally, and `create_table` records the table and the AutoFilter it
displaced in one transaction — so the entries were on the stack the whole time and were simply never
reached. Both are now Rust tests that perform the same operations and assert the state comes back
(`undo_s12_soak_leak_tests::the_walks_cell_edit_is_undone_when_its_entry_is_actually_reached`,
`::the_walks_table_create_undo_removes_the_table_and_restores_the_filter` — the latter reproduces the
one-AutoFilter-slot-per-sheet displacement the digest diff shows, and asserts the sheet's filter comes
back with the checkpoint's geometry).

#### The fix: ask by IDENTITY, not by size

`undo_depth()` answers "how big is the history". The oracle was asking "how far back is the point I
remembered", and no size answers that once the history is allowed to forget. So:

* `core/engine/src/undo.rs` — every `Transaction` carries a monotonic `seq`, stamped on first push.
  `UndoStack` exposes `undo_seqs()` (the ids on the stack, oldest first), `evicted_total()` (what the
  cap has dropped, the only trace an eviction leaves) and `max_size()`. Ids are never reused, **not
  even across `clear()`**, so a stale marker can never be matched by a later transaction that happens
  to land in the same slot.
* The inverse transaction a restore builds **inherits** the popped transaction's `seq`, so an
  undo-then-redo puts the SAME entry back. Without that, any Ctrl+Z inside a window would make every
  later checkpoint look unreachable and the oracle would stop checking exactly when the walk got
  interesting.
* `get_undo_state` reports `undoSeqs` / `evictedTotal` / `historyLimit`.
* `app/e2e/oracles/undoRoundTrip.ts` remembers the id on TOP at the baseline and counts the entries
  above it. The arithmetic is now exact in the two cases the difference got wrong in OPPOSITE
  directions: eviction past the cap, and the walk undoing back past its own checkpoint.
* When the marker is gone the state is unreachable and the oracle **declines to decide** —
  `undo-history-unreachable`, routed into `OracleBattery.undecided` and logged, never into
  `violations`. It is not a defect and it is not a known-issue suppression either: hiding it in the
  ledger would hide the blind spot instead of the bug.

`core/engine/src/undo.rs::history_horizon_tests` (7 tests) pins the mechanism from both sides,
including the case where depth arithmetic happens to be RIGHT — an exact instrument must not be more
conservative than the sloppy one where the sloppy one works.

#### BUG-0020 — the one that was real, and it was the whole store

Conditional formatting was the last persisted store whose own commands recorded nothing.
`add` / `update` / `delete` / `reorder` / `clear_in_range` were all invisible to Ctrl+Z. Excel has
always undone a conditional-formatting rule, so parity settles it. Each now snapshots the sheet's
whole rule list into the `obj_conditional_formats` entry that already existed for structural shifts —
whole-list, because the Vec ORDER is evaluation semantics and `add` recomputes a priority from the
current maximum, so no per-rule inverse exists. A refusal (unknown rule id) and a genuine no-op (a
clear that removes nothing, a reorder that reorders nothing) record **nothing**: an undo entry that
restores an identical list is a Ctrl+Z that visibly does nothing, which is worse than none.

Restoring the rules is only half of it. `MutationDomain::ConditionalFormats` is new, mapped to
`AppEvents.CONDITIONAL_FORMATS_CHANGED`, because the extension caches the rule LIST in
`cfStore.state.rules` and `grid:refresh` only makes it re-EVALUATE that cache — the same staleness
that once made undoing a note or a hyperlink invisible. The BUG-0020 suppression is **deleted** from
`knownIssues.ts`, so the walker's `cf.add-rule` now has to hold up.

#### What this says about S11 and `state-consistency`

Same instrument, same arithmetic, same shape. S11 reported *"Undoing 28 steps did not restore the
checkpoint state; sparklines.0[0]"* on a 75-action walk with checkpoints every 25 — and the narrowing
already recorded there says backend `obj_sparklines` undo/redo is symmetric in isolation and
*"needs another action class to trigger"*. Needing enough OTHER actions to fill a 100-entry history is
exactly that, and the sparkline group is simply what happened to be oldest in that window. **S11 is
most likely the same false report**, and it is now decidable rather than arguable: with the id-based
oracle the same seed either reports a real diff or reports `undo-history-unreachable`. The replay is
`E2E_MANUAL=1 INVARIANT_SEED=1786396152029 npx playwright test --project=invariant`; it has NOT been
re-run here (see the honesty note below), so S11 stays open with its hypothesis upgraded, not closed.

The second `state-consistency` test was ALSO unseeded — `Date.now() + 1`, missed when the first one
was fixed. It is the entry whose failures were repeatedly filed as monkey flake. It now reads
`INVARIANT_SEED` too (`+ 1`, so replaying one test does not replay the other).

#### And one thing the fix found on its own: the reset was reusing ids

`reset_document_scoped_stores` emptied the undo stack by REPLACING it —
`*state.undo_stack.lock()? = UndoStack::new()`. That empties it correctly, and it also restarts the
transaction-id counter at 1. With ids now naming a point in history, restarting them lets a marker
remembered in workbook A be matched by an unrelated transaction in workbook B: the same
"nothing in it names the document it came from" mistake the surrounding block exists to fix, one level
up. It is now `clear()`, which empties undo, redo AND any open transaction while the counter keeps
advancing, and `the_undo_stack_does_not_survive_the_document_it_belongs_to` asserts the ids do not
restart alongside its existing assertions.

#### Suites

| suite | result | baseline |
|---|---|---|
| core cargo workspace | **1 337 passed / 0 failed** (+7 = `history_horizon_tests`; the rest is another agent's concurrent work in the same tree) | 1 313 |
| script-engine | **111 passed / 0 failed** | 111, unchanged |
| app-lib | **1 397 passed / 3 failed / 4 ignored** — all three failures are in another agent's IN-FLIGHT work and none touches undo or conditional formatting: `spill_persistence_tests::clearing_the_obstruction_re_spills_and_forgets_the_block` (the `#SPILL!` change landing mid-flight), `structured_ref_tests::a_specifier_survives_the_render_reparse_round_trip` and `formula_serialisation_tests::the_override_write_restamps_the_name_casing_it_re_parses`. Earlier runs of this pass saw up to 13, all from the same two in-flight areas, decreasing as those agents landed their work. | 1 356 |
| app-lib, this pass's own tests | **9 passed / 0 failed** (`undo_s12_soak_leak_tests`), plus `the_undo_stack_does_not_survive_the_document_it_belongs_to` extended and passing | new |
| `test_pivot` | **56 passed / 0 failed** | 56, unchanged |
| vitest | **747 files / 106 217 passed / 0 failed** | unchanged |
| app crate warnings | **0** | 0 |
| check-types · e2e `tsc` · lint:boundaries · check:line-endings | clean | clean |

The first vitest run of this pass reported ONE failure, `dialogGlobalsBan.test.ts` ("expected at
least one dialog error, got none"). It passes in isolation and the immediate full re-run was
747/106 217 green — the same load-sensitivity §3bh already recorded for that file, which lints a
synthetic source through ESLint inside the assertion. Recorded rather than ignored: it is a flake in a
GUARD, and a guard that intermittently reports NO violations is the failure direction that matters.

#### The tests were sabotaged before they were believed

`adding_a_conditional_format_is_undoable` and `undoing_a_rule_announces_the_conditional_format_domain`
were re-run with the new `record_conditional_formats_undo` call removed from
`add_conditional_format_impl`. Both fail — "adding a rule must leave exactly one entry on the undo
stack: left 0, right 1", and then "nothing on the undo stack". So they test the fix rather than
accompanying it.

#### Honesty about what was NOT run

**No E2E project was run** — not the soak, not `invariant`, not functional. So the claim that the
id-based oracle makes seed 20260810 pass is REASONED from the bundle and the Rust tests, not observed.
Re-running `E2E_MANUAL=1 SOAK_SEED=20260810 SOAK_ACTIONS=150 SOAK_ORACLE_EVERY=25` is the first thing
the next pass should do; a green run there — or an `undo-history-unreachable` note instead of a
violation — is what actually closes S12's first two entries, and the `INVARIANT_SEED` replay is what
closes S11. `model-engine-lib` was neither touched nor run, and `check:script-typings` was not
re-run (no script-facing type changed; `UndoState` is not part of the script surface).

Two things were deliberately NOT touched. `app/src-tauri/src/tables.rs` was being edited by another
agent DURING this pass — its command signatures changed under an edit that had already applied — so
the `create_table_impl` / `delete_table_impl` extraction that would have let the table half of leak 2
be driven through the real command was backed out, and that test drives the two undo entries
`create_table` records instead. And `MAX_HISTORY_SIZE` stays at 100: Excel caps undo at 100 too, so
parity settles it, and raising it would only move the horizon rather than make the oracle honest
about it.

### 3bl. The S12 / structured-refs / Excel-parity integration pass — contract verification, and the two things it found (2026-08-11)

Three batches landed against a repo all three were editing at once (S12+S11 undo, §2ai/§2aj/§2al
structured references, S6/§3bg/S10 Excel parity). This pass integrated them, ran every unit suite to
completion, and checked the five contracts the batches were held to. **No E2E was run** — that was
out of scope for this pass, so every claim below is a unit-level or source-level claim.

**The three app-lib failures the undo batch reported as "another agent's in-flight work" were exactly
that, and all three are green on the merged tree** — `spill_persistence_tests`,
`structured_ref_tests::a_specifier_survives_the_render_reparse_round_trip` and
`formula_serialisation_tests::the_override_write_restamps_the_name_casing_it_re_parses`. Nothing had
to be done to them; they were mid-edit snapshots, not defects.

#### Two things found by integrating

**1. Two core-workspace warnings, against a stated "0 warnings" baseline.** `cargo check --workspace
--all-targets` on core reported an unused `mut` (`pivot-engine/src/engine.rs`) and a dead test helper
`make_id` (`engine/src/identity_graph.rs`). Both were test-module residue from the concurrent work,
and both are removed — core is back to 0 warnings. Worth recording because *both agents reported "0
warnings"*: they had each checked the crate they were editing, and neither ran `--all-targets` across
the whole core workspace, which is where test targets live.

**2. `normalizeCellErrorLiteral`'s list had no drift guard — and it is a SECOND
`CELL_ERROR_LITERALS`.** Contract (c) asked whether the error reclassification collapsed any variant
through `normalizeCellErrorLiteral`. It has not: all **12** `CellError::as_literal` variants are
present in `api/formulaFunctions.ts`, verified against `cell.rs`. But *nothing was checking that*.

The guard that exists — `type-guards-exhaustive.test.ts`, which reads `cell.rs` at test time —
covers `isErrorValue`, whose list is a **different constant of the same name** in
`gridRenderer/styles/cellFormatting.ts`. The two could drift apart silently, and the failure would be
asymmetric and confusing: the grid paints a new variant red while the UDF path collapses that same
variant to `#VALUE!`.

That collapse is lossy and silent, and it has already happened twice — `#NUM!` and `#NULL!` sat
outside the list under a comment asserting they had "no engine variant", and `#LIMIT!`/`#SPILL!` were
each added by hand after the fact. A new test,
`advertises EVERY CellError literal the engine can produce`, now reads the engine's own
`as_literal` table and checks **both directions**: every engine literal is advertised and survives
`normalizeCellErrorLiteral`, and every advertised literal is one the engine can still produce.
**Sabotage-verified** — dropping `#SPILL!` from the list fails it with the missing literal named.

#### Contract verdicts

| # | Contract | Verdict |
|---|---|---|
| (a) | each soak leak has a deterministic regression test, failing with the fix reverted | **HELD.** Leak 3 (BUG-0020, the only real defect) — sabotage-verified here, not just reported: removing the CF snapshot from `record_conditional_formats_undo` fails **5** tests. Leaks 1 and 2 were the instrument, so there is no fix to revert; they are pinned as *positive* assertions that the entries exist (`the_walks_cell_edit_is_undone…`, `the_walks_table_create_undo…`), and the instrument's own root cause has `depth_saturates_at_the_cap_so_the_difference_undercounts` in `undo.rs`. |
| (b) | a stored structured reference has a dependency edge — growing a table recalculates its readers | **HELD, with teeth.** Disabling edge registration in `table_deps::update_table_dependencies` fails **10** tests, including `a_table_that_grows_recalculates_its_readers`, `a_row_the_table_gained_is_a_precedent_from_then_on` and `the_edge_is_recorded_and_dropped_with_the_formula`. |
| (c) | the error reclassification did not collapse any variant through `normalizeCellErrorLiteral` | **HELD** — and the check that proves it did not exist until this pass. See above. |
| (d) | all six censuses still fire, plus formula-repair-restamp now covering sheet-name casing | **HELD.** All six pass, each with its own "detector actually fires" self-test. The restamp census covers all three authorities — `restamp_name_casing` (§2t), `restamp_table_casing` (§2aj), `restamp_sheet_casing` (§2ai) — pinned by `the_override_write_restamps_the_name_casing_it_re_parses`. |
| (e) | nothing added a fourth recalculation walk or a fourth serialiser | **HELD.** `recalc_after_table_change` is not a new walk: `the_table_recalculation_reaches_the_shared_cascade` asserts *from source* that it seeds `recalc_after_active_sheet_bulk_rewrite` + `recalc_after_off_sheet_write` (+ `refresh_reader_edges`), and three censuses accept a call to it as proof only because that test stands behind it. The sole-serialiser guard still holds `expression_to_formula` to a delegation to `engine::ast_render`. |

#### Hangs

Watched for, none seen. Every suite ran to completion; the slowest single suite was vitest at
**165 s** wall clock for 747 files. app-lib runs in **2.1 s**, core in **10 s**. No suite needed a
timeout raise, and no run had to be killed.

#### One defect fixed in this pass

Closing the deferred `find_table_at_cell` item — filed by §2aj's author, not a residue of it. See
**§2ar**.

#### Suites, all green

| suite | result | baseline |
|---|---|---|
| vitest | **747 files / 106,219 / 0 failed** | 747 / 106,217 |
| app-lib | **1,406 / 0 failed** (4 ignored) | 1,356 |
| core cargo workspace | **1,337 / 0 failed** | 1,313 |
| script-engine (within core) | **111** | 111 |
| test_pivot | **56 / 0** | 56 |
| model-engine-lib | **2,192 / 0 failed** | 2,192 |
| `cargo check` app crate | **0 warnings** | 0 |
| `cargo check` core workspace `--all-targets` | **0 warnings** (was 2) | 0 |
| check-types · lint:boundaries · check:line-endings | clean | clean |
| check:script-typings | **39 interfaces / 736 members** | 39 / 736 |

**The vitest delta is +2 and both are accounted for:** +1 from the Excel-parity batch, +1 from the
new `normalizeCellErrorLiteral` drift guard added here. **The app-lib delta is +50:** +24
`structured_ref_tests`, +8 `table_deps`, +9 `undo_s12_soak_leak_tests`, +2 from §2ar, and +7
elsewhere across the three batches.

**`model-engine-lib` WAS reached** and is not skippable on this pass —
`engine-core/src/compute/expression/format.rs` and `.../parser/tokenizer.rs` were both edited. It
runs green at its baseline.

#### Still open, and stated rather than hidden

- ~~**S11 / `state-consistency` remains OPEN.**~~ **The undo half is CLOSED — §3bm ran the replay on
  the app and it passes.** The `state-consistency` intermittency was a separate defect and now has a
  root cause: **§3bn**, a slicer left behind by the deletion of its table.
- ~~**S12's own closure is still reasoned, not observed.**~~ **OBSERVED — §3bm re-ran
  `SOAK_SEED=20260810 SOAK_ACTIONS=150 SOAK_ORACLE_EVERY=25` twice, cold, and it passes.**
- **§3bf** (`A1#` resolved at entry) remains deliberately open.
- The `dialogGlobalsBan.test.ts` ESLint-timeout flake did **not** reproduce in either full vitest run
  here (both 747/747), but it was only ever seen with Rust compiling concurrently.

### 3bm. The live-proof pass — S11 and S12 CLOSED on the app, §2aj/§2ai/#NUM!/#SPILL! proved through the real UI, and three new defects the proofs found (2026-08-11)

Everything §3bk and §3bl left "reasoned, not observed" was run here, cold, on the real app. The two
seeds that had been failing now pass; the register items that had only unit tests behind them were
driven through the WebView; and writing those proofs found **three defects nobody had seen**, one of
which fires on every save.

**Every number below was produced by a run performed in this pass.** Each project was started from a
COLD `scratchpad/launch-vba-batch.ps1` and driven with `E2E_MANUAL=1`.

#### 1. S11 and S12 — CLOSED, on the seeds that filed them

| filed as | reproduction, exactly as the register recorded it | result |
|---|---|---|
| **S12** | `SOAK_SEED=20260810 SOAK_ACTIONS=150 SOAK_ORACLE_EVERY=25 --project=soak` | **PASSED** — 150 actions, 6 oracle checkpoints, 127 s walk / 2.2 m test. Run **twice**, cold both times. Previously failed at step 75 with `undo-round-trip` and 8 digest differences. |
| **S11** | `INVARIANT_SEED=1786396152029 --project=invariant` | **2 passed** (2.2 m, and 2.5 m on the re-run). Previously `undo-round-trip` on `sparklines.*`. |

**And the pass is not vacuous, which is the half that needed proving.** §3bk's fix works by declining
to decide when the checkpoint has fallen off the 100-entry history, so "green" could have meant "the
oracle skipped every window". It did not: **zero** checkpoints in any run reported
`undo-history-unreachable`.

To make that legible instead of inferred, `undoRoundTrip.ts` now PRINTS how far each checkpoint wound
the history back — and prints "nothing undoable in this window" when the distance is zero, because a
trivially-consistent checkpoint and a verified one look identical in a green report and are not the
same evidence. Measured, with that instrument in place:

* soak seed 20260810 — six checkpoints, winding back **41, 36, 42, 33, 55, 34** transactions.
* invariant seed 1786396152029 — five checkpoints, **58, 14, 43, 50, 47**.
* invariant seed 20260811 (fresh) — five checkpoints, **39, 55, 10, 70, 24**.

Every window undid tens of real transactions and every one was decided. S12's "23 steps" under the old
depth arithmetic against 41 under the id-based one is the under-count §3bk predicted, now measured.

#### 2. Fresh seeds — because a fixed seed proves the walk, not the class

* **invariant `INVARIANT_SEED=20260811`: 2 passed** (2.5 m).
* **soak `SOAK_SEED=20260811`: FAILED**, and the failure is reported here rather than smoothed over.
  The violation is `no-console-errors` at step 5:
  `[ObjectScriptManager] Failed to mount script "Soak Shape Renderer": Script mount timed out (10s)`.
  It is a legitimate error — `scriptableObjects.ts` logs, emits `objectscript:error` and rethrows, all
  correct — but **it did not reproduce once in 16 shrink replays** (`replayConfirmed: false`), so it
  is a timing failure of the 10 s mount deadline in a Vite dev build under load, not a decidable
  defect. Filed as **S13**, not fixed, because there is nothing yet to fix.

#### 3. THE INSTRUMENT WAS THROWING AWAY THE ANSWER — the shrinker's blind spot

That soak bundle read `replayConfirmed: false` and nothing else, i.e. "the failure did not
reproduce". The log said otherwise: of the replays the shrinker ran, **twelve out of twelve** of the
14-action subsets failed — every one of them with `no-js-exceptions` — and several 4-action subsets
failed with `save-reload-round-trip` and `undo-depth-mismatch`.

`minimizeTrace`'s `matches()` accepts only the ORIGINAL violation id, so a replay that fails with a
different id is treated exactly like a replay that passed, and the only trace of it was a console
line nothing read. **A deterministic failure was sitting inside a bundle that said the failure did not
reproduce** — which is how the last pass came to file this class as noise.

`ShrinkResult.otherOutcomes` now counts every non-matching outcome, `soak-walk.spec.ts` writes it into
`failure.json` as `shrinkOtherOutcomes`, and the shrinker prints
`"<id>" never reproduced, but replays DID fail: … This is a different reproducible failure, not an
absent one.` The bundle can no longer say "nothing here" when every replay failed.

#### 4. The register items, proved through the real UI

`app/e2e/journeys/live-parity-proofs.spec.ts` — a journey because every test starts from File > New
and three save to disk. Deliberately **not** `.serial`: the first run had `.serial` and the `#SPILL!`
failure took the unrelated BUG-0020 proof down with it.

| claim | how it was driven | result |
|---|---|---|
| **§2aj** — a structured reference is stored as typed and FOLLOWS its table | `=SUM(Sales[Amount])` typed into a real cell through the inline editor; formula bar asserted `=SUM(Sales[Amount])` and explicitly `not.toBe("=SUM($A$2:$A$4)")`; then the table grown by typing `40` under it (real auto-expand), table extent re-read to prove it grew | **PASS** — 60 before, **100** after, formula unchanged. This is the one the register said "stayed 60". |
| **§2ai** — a sheet qualifier keeps its casing | `=Data!A1` typed; asserted through entry, a save + reload from disk, a rename to `Ledger`, and a CASE-ONLY rename to `LEDGER` | **PASS** on all four, value 7 throughout |
| **S6 / #NUM! parity** | `=SQRT(-1)` and `=LOG(0)` typed, with `=SQRT(9)` as counterweight | **PASS** — both `#NUM!`, both survive save/reload, the counterweight stays `3` |
| **§3bg / #SPILL! parity** | `=SEQUENCE(1;2)` blocked by an occupied `D1`; unblocked array as counterweight; `get_error_indicators` for the blocker's address | **PASS live** — `#SPILL!`, the pane names `D1`, the blocker's own text is not overwritten. **The save/reload half FAILED and is §3bm below.** |
| **BUG-0020** — a CF rule is undoable | rule added, then REAL Ctrl+Z and Ctrl+Y on the grid | **PASS** — and **sabotage-verified on a running build**, see §6 |

#### 5. THREE NEW DEFECTS, all found by writing the proofs

**(a) §3bm — THE RECALCULATION PASS DOES NOT IMPLEMENT SPILLING, AND EVERY SAVE RUNS IT.**
This is the serious one.

`app/src-tauri/src/calculation.rs` — `run_calculation_pass` (F9 and Shift+F9) and
`recalculate_sheet_values` — contains **no reference to spilling at all**. It writes the result of
`evaluate_formula_with_pivot`, which ends in `EvalResult::to_cell_value()`, and that collapses an
array to its first element (`core/engine/src/evaluator.rs`: *"Arrays collapse to the first value when
stored in a cell"*). The three places that really decide a spill are all in `commands/data.rs`
(`update_cell_impl`, `reevaluate_formula_cell`, `update_cells_batch_core`) and the pass reaches none
of them. `calculate_before_save` defaults to **true**, so this runs on every save.

Measured on the running app, each half with a control so neither can pass vacuously:

```
1. A BLOCKED array loses its error to a plausible number
   D1 = "block" ; C1 = =SEQUENCE(1;2)
   live         C1 -> #SPILL!   D1 -> "block"     spill_ranges []
   after save   C1 -> 1         D1 -> "block"     spill_ranges []      <-- silent
   after reload C1 -> 1                                                 <-- the file has it wrong
   F9 alone does the same, so it is not save-specific.

2. A SHRUNK array keeps its stale tail
   A1 = 4 ; B1 = =SEQUENCE(A1)  -> B1:B4 = 1 2 3 4 ; F1 = =A1*10 (control)
   manual mode, A1 = 2, then F9:
     F1 -> 20        <-- CONTROL: the recalculation really ran
     B1:B4 -> 1 2 3 4 and spill_ranges STILL claims B1:B4
   Excel: B1:B2 = 1 2 and B3:B4 empty. So =SEQUENCE(2) renders 1 2 3 4.
```

Half 1 is a wrong ANSWER where Excel shows an ERROR; half 2 is §2ab's
"silently-right-then-silently-wrong" shape on a live path the §2ab work never looked at.

**NOT FIXED IN THAT PASS, deliberately — FIXED 2026-08-11 in §3bs.** The fix is a change to the ONE
recalculation cascade — the most guarded path in the app — and the only correct shape is to give the
pass the same spill decision the other three sites use. That is what §3bs does, and it did it by
noticing that the three sites were three hand-written COPIES: they are now one function,
`apply_spill_decision`, parameterised on the sheet, and the recalculation pass is its fifth caller
rather than a fourth copy. Read §3bs for what that consolidation then proved and what it broke.

Pinned instead by a CHARACTERISATION test that asserts today's wrong answer and says in its failure
messages that it must be INVERTED when fixed — the shape §3bf uses:
`§3bm CHARACTERISATION — F9 and save do not spill` in `live-parity-proofs.spec.ts`, with the `F1`
control inside it.

**(b) §3bn — DELETING A TABLE ORPHANS ITS SLICER, and that is what `state-consistency` has been.**

The register has recorded for three passes that `state-consistency` "is not one bug" and its failures
kept being written off as monkey flake. Seed **1786421716252** failed **twice out of two runs**, with
two different symptoms in one region:

* functional run — `no-console-errors`:
  `[Slicer] Failed to get items for slicer <id> Table <id> not found`, at step 56 after
  `slicer.create` (18) and `table.delete` (17, 20);
* invariant replay of the same seed — `page-crashed`: an overlay intercepted pointer events through
  **171** click retries and the test timed out at 120 s. The UI was **wedged**, not merely noisy.

Reduced to two gestures it needs no walk at all: create a table, create a slicer on it, delete the
table — `tables=0, slicers=1`, and the survivor's `cacheSourceId` still names the deleted table. The
error only surfaces when something later asks the orphan to refresh its items, which is why the walks
failed far from the cause and looked random. **Excel does not let a slicer outlive its source**, so
the standing parity rule settles what the fix is.

Pinned by `§3bn CHARACTERISATION — deleting a table leaves its slicer behind` (asserts the orphan
survives, states the inversion, and cleans the orphan up so it cannot wedge the next spec).

**(c) A TEETH TEST HAD GONE STALE, and only a journey could have caught it.**
`reload-integrity.spec.ts`'s `TEETH: an archive stamped v7 with its extent deleted opens UNOWNED and
collapses on the first edit` asserted `#VALUE!`. §3bg/§2an gave the engine a `CellError::Spill`
variant, so the collapse is now spelled `#SPILL!` — which is *better*, and the teeth check still
measures what it was written to measure. The batch that landed `#SPILL!` **ran no E2E**, so nothing
noticed. Updated to `#SPILL!` with the reason recorded at the assertion: a fix silently invalidating a
TEETH test is precisely the failure mode a teeth test exists to prevent in the other direction.

#### 6. TEETH — the BUG-0020 fix, sabotaged on a running build

`record_conditional_formats_undo` was removed from `add_conditional_format_impl`, the app rebuilt and
relaunched cold, and the LIVE Ctrl+Z proof re-run:

```
x 1 [journey] BUG-0020 — Ctrl+Z removes a conditional-format rule, Ctrl+Y puts it back (4.0s)
  Error: Ctrl+Z did not remove the conditional-format rule (BUG-0020)
  Expected: 0   Received: 1
```

The leak returns, through the real keystroke. Restored from a pre-sabotage copy and verified
**byte-identical by checksum** — `sha256 dc37bb01eeb321325517a6633ae58622c3cfb0803bbdf2a71e3ed84a62103178`
before and after — then rebuilt cold and all six live proofs re-run: **6 passed (53.3 s)**.

#### 7. Every project, each from a COLD app

| project | result | baseline | verdict |
|---|---|---|---|
| soak, seed 20260810 | **1 passed** (2.2 m), run twice | was FAILING | **S12 closed** |
| invariant, seed 1786396152029 | **2 passed** (2.2 m / 2.5 m) | was FAILING | **S11 closed** |
| invariant, fresh seed 20260811 | **2 passed** (2.5 m) | new | clean |
| soak, fresh seed 20260811 | **1 failed** | new | **S13**, not reproducible in 16 replays |
| journey | **115 passed / 2 failed / 1 skipped / 5 did not run** (23.3 m) of 123 | 117 + 1 skipped, of 118 | both failures are findings (§3bm, stale teeth), the 5 skips were `.serial` collateral — since removed |
| scenario | **24 passed** (1.6 m) | 24/24 | unchanged |
| visual | **18 passed** (2.6 m) | 18/18 | unchanged |
| macro (`--project=functional --grep "[Mm]acro"`) | **27 passed** (6.1 m) | 27/27 | unchanged |
| functional | **543 passed / 2 failed / 11 skipped** (39.2 m) | 542 / 3 / 11 | **one FEWER failure**, none new |

Functional's two: the stale `ribbon-minimized.png` baseline (804 388 px differ — the ribbon restyle
and SVG icon set, already recorded as "all visual baselines stale"), and `state-consistency`, which is
**§3bn** above and now has a root cause.

| unit suite | result | baseline |
|---|---|---|
| vitest | **747 files / 106 219 passed / 0 failed** (154 s) | 747 / 106 219 |
| core cargo workspace | **1 337 passed / 0 failed** | 1 337 |
| core `cargo check --workspace --all-targets` | **0 warnings** | 0 |
| app crate `cargo check` | **0 warnings** | 0 |
| app-lib | **1 406 passed / 0 failed / 4 ignored** | 1 406 |
| `test_pivot` | **56 passed / 0 failed** | 56 |
| model-engine-lib | **2 192 passed / 0 failed** | 2 192 |
| check-types · lint:boundaries · check:line-endings · e2e `tsc` | clean | clean |
| check:script-typings | **39 interfaces / 736 members / 356 with generated broker policy** | 39 / 736 |

#### 8. Hangs, and TWO RUNS THAT ARE NOT REPORTED AS RESULTS

In the measured batch above nothing hung: every project ran to completion, nothing was killed and no
timeout was raised. The one 120 s timeout was §3bn wedging the UI — a product defect surfacing as a
timeout, not a harness hang.

**Two later journey re-runs are excluded from the table, and why.** After the batch, two
`cold-run.sh` invocations overlapped: the first had appeared to fail at launch, actually survived, and
started its own Playwright when the app finally came up. Two runs then shared one CDP connection and
one workbook. Their numbers (90/10 and a run with 17 failures and several 300 s timeouts) are
artefacts of that collision and are **not** evidence about the product. They are recorded here rather
than dropped because a reader comparing logs would otherwise find two alarming journey runs with no
explanation.

**One real defect came out of the wreckage, and it was in THIS PASS'S OWN TEST.** The §3bm
characterisation switches calculation mode to `manual` to isolate the recalculation pass.
`calculation_mode` is workbook-wide `AppState` that **File > New does not reset**, so a failure
between the switch and the restore leaves every later spec in the run with automatic recalculation
OFF — typed edits stop propagating, unrelated specs fail, and some sit until their timeout. It is now
a `try`/`finally`, and the file has a `beforeEach` that asserts automatic mode so a leak from any
OTHER spec cannot silently invalidate these proofs either. Any future test that flips a global mode
must do the same.

After that fix, on a clean cold app: **all 7 live proofs pass (1.4 m)**, and the repaired stale teeth
test passes too (`reload-integrity` "TEETH: an archive stamped v7 …", observed `ok` after the
`#SPILL!` correction).

#### 9. What this pass did NOT examine, checked rather than asserted

* **Closed from the previous pass's list:** `model-engine-lib` was RUN (2 192, green). Encrypted
  `.cala` was exercised — `encryption.spec.ts`'s six tests are in the functional 543. A REAL
  AutoRecover cycle was exercised — `dirty-flag.spec.ts`'s 1-minute cycle is in the journey run.
  Multi-window was exercised — the Script Editor window specs (`macro-*`, `scriptable-objects`,
  `vba-idioms-*`) are in the functional 543.
* **Still open:** the soak remains SAMPLED, not covered — two seeds, one of which failed
  irreproducibly. `.calp`, BI, pivot and Model Editor surfaces were exercised only as far as the
  functional and scenario projects already reach; nothing new was driven there.
* ~~**§3bf** (`A1#` frozen at entry) remains deliberately open~~ — **CLOSED 2026-08-11 (§3bs)**,
  together with §3bm, because they were the same shape (a spill fact that one path knows and another
  does not) and wanted one answer.
* ~~**§3bm and §3bn are FILED, NOT FIXED.**~~ **§3bm is FIXED 2026-08-11 (§3bs)** and its
  characterisation test in `live-parity-proofs.spec.ts` must now be INVERTED — see §3bs, which could
  not run E2E. ~~**§3bn (the orphaned slicer) is still filed, not fixed**~~ — **CLOSED 2026-08-11 (§3bt)**, and
  it was not one pair but fifteen: the whole "delete an object that other objects point at" class,
  now enumerated as a 50-row matrix and guarded by a seventh census.
* ~~The `invariant` project has **no trace minimiser**~~ — **CLOSED 2026-08-11 by §3bo**, and not
  by giving the invariant runner a shrinker: the invariant runner itself was the duplicate and is
  DELETED. Both walks drive one `WalkRunner` over one catalog and write one failure bundle. Giving
  the minimiser a unit tier in the same change found two defects in it, one of which had been
  writing `replayConfirmed: true` into bundles whose confirmation replay never ran.
* The app is left RUNNING on CDP 9222.

---

### 3bo. The `invariant` walk IS the soak walk now — one runner, one catalog, one minimiser, one failure bundle; and giving the minimiser a unit tier found two defects in the minimiser (2026-08-11)

The brief asked for a trace minimiser on the `invariant` project, "or lift the shared piece so both use
one implementation — a second copy is the shape this program keeps deleting". Enumerating before
porting turned up that the minimiser was not the second copy. **The whole runner was.**

| | `invariants/` (v1) | `walker/` (v2) |
|---|---|---|
| action catalog | 27 actions | **59** — a strict SUPERSET; all 27 ids are in it |
| what a run records | a list of action ID strings | a concrete `ActionTrace` (id + params), flushed to disk after every action |
| minimiser | none | ddmin (`minimizeTrace`) |
| failure bundle | none | trace + minimized trace + failure.json + report.md |
| replay | impossible | `createTraceSource` + `--project=soak --grep "Trace replay"` |

That is why `state-consistency` was classified as monkey flake three times: a report listing action
ids and nothing else cannot be replayed, cannot be reduced, and cannot be distinguished from noise.
§3bn's orphaned slicer had to be reduced BY HAND.

**DELETED, not wrapped:** `invariants/runner.ts`, `invariants/actions.ts`,
`invariants/actionGenerator.ts`, `invariants/reporter.ts`. `invariants/` keeps only the part that was
never duplicated — what a snapshot IS (`stateSnapshot.ts`) and what must be true of one
(`invariants.ts`). `state-consistency.spec.ts` now builds a `WalkRunner` over `ACTION_CATALOG`, so it
gained 32 action types it never had, and on failure it writes the same bundle the soak writes, from
the same `writeFailureBundle`.

**And the bundle writer is now shared too.** The soak spec had its own inline bundle-writing block;
extending that shape to a second harness would have made two copies of the thing whose absence was
the finding. `walker/failureBundle.ts` is the one implementation, and the soak spec is 40 lines
shorter for it.

#### The monkey walk was running inside the functional suite

`state-consistency.spec.ts` lives in `./e2e/tests`, so the `functional` project picked it up as well
as the `invariant` project that exists for it. Everything in `./e2e/tests` shares one app instance and
one ACCUMULATING workbook — that is precisely why `journey` is a separate project — and this spec
resets the document and then applies up to 75 RANDOM mutating actions, with roughly twenty spec files
running after it alphabetically. `functional` now carries `testIgnore: "**/state-consistency.spec.ts"`.
It is also budgeted for an in-spec ddmin shrink on failure, which is minutes, not the 30 s that
project assumes.

#### THE MINIMISER HAD NO UNIT TIER, AND THAT IS WHY ITS TWO DEFECTS SURVIVED

`minimizeTrace` is a pure function of (trace, replay predicate). The only way to exercise it was to
launch the whole app, produce a real failing walk, and read a console line — so it never was.
`vitest.config.ts` now includes `e2e/**/*.test.ts` (Playwright owns `*.spec.ts` / `*.scenario.ts` in
that tree, so a `*.test.ts` there is unambiguously a Node unit test of the harness), and
`walker/__tests__/shrinker.test.ts` is 12 tests. Writing them found two defects, one of them worse
than the one the brief already knew about:

1. **`stillFails` was initialised to `true`** and only ever assigned by the FINAL confirmation replay
   — which is skipped the moment the replay cap or the time budget is exhausted, the ordinary outcome
   on a long trace. A shrink that had reproduced nothing wrote `replayConfirmed: true` into the
   bundle. The boolean has been replaced by a tri-state `ShrinkVerdict`:
   `confirmed` / `not-reproduced` / `unverified`. `unverified` is a real answer and it is not `true`;
   the report says in English that nothing was established and that this is not evidence of absence.
2. **The already-known blind spot is now pinned by a test**, not only by a comment:
   `matches()` accepts only the original violation id, so a replay failing a DIFFERENT way is
   recorded exactly like a replay that passed. `otherOutcomes` counts them, `failure.json` carries
   `shrinkOtherOutcomes`, and `describeShrink` prints "DIFFERENT reproducible failure … triage the
   failure that reproduces, not the one that was reported."

#### PROVED, on the real app: 25 actions -> 1, with a KNOWN minimum

A unit test proves the arithmetic. It cannot prove the thing that has actually failed every time
here: that replay against the live product is faithful enough for reduction to converge.
`soak/shrinker-selftest.spec.ts` plants a failure whose minimum is known in advance — 12 filler
`cell.click`s, one `table.create`, 12 more `cell.click`s, with a canary invariant that fires when a
table exists — and asserts the minimiser reaches exactly `[table.create]`.

```
[shrink] replay 1: 12 actions -> pass
[shrink] replay 2: 13 actions -> FAIL(selftest-canary-table-exists)
[shrink] replay 3:  6 actions -> FAIL(selftest-canary-table-exists)
[shrink] replay 4:  3 actions -> FAIL(selftest-canary-table-exists)
[shrink] replay 5:  1 actions -> FAIL(selftest-canary-table-exists)

[minimiser self-test] 25 -> 1 actions in 6 replays (verdict=confirmed)
minimized: table.create                                   1 passed (54.8 s)
```

A canary rather than a real defect, deliberately: a self-test that depends on a live bug stops
working the day the bug is fixed.

#### The first real bundle it wrote contained two lies, and they were in THIS pass's own code

`INVARIANT_SEED=1786421716252 --project=invariant` was run to reduce §3bn automatically. It did not
get that far: **the app DIED at step 67, during `table.create`** — `page-crashed`. That turned out to
be another agent recompiling the Rust crate underneath the run (§3bq), not a product crash, and the
bundle is the reason that is known rather than guessed. It was diagnostic in exactly the way it was
built to be, and wrong in two places:

* **it called a crash "a harness failure, not a product one — the trace is not what went wrong".**
  The application had died; that is the most serious result this walker can produce. The reason not
  to minimize it in-spec is MECHANICAL — every replay needs a live page and there isn't one — and
  the bundle now says that, plus what to do instead (relaunch, then run the `originalTrace` command).
  The wording was inherited from the soak spec's `crashed` guard, which had it equally wrong for
  three passes and never printed it where anyone would read it.
* **it printed a replay command for `minimized.trace.json` when no minimized trace had been
  written.** The command referenced a file that does not exist. `replay.minimizedTrace` is added only
  once the file it names is on disk.

Both fixed. This is the second time this pass that writing down what a failure MEANS caught an error
the code had been making silently.

#### What the consolidated walk then measured

| run | result |
|---|---|
| `INVARIANT_SEED=20260811 --grep "random action sequence"` (75 actions, full 59-action catalog) | **1 passed** (1.3 m) |
| `INVARIANT_SEED=20260811 --grep "rapid create-delete"` (50 actions, rapidFire 0.5) | **1 passed** (43.8 s) |
| minimiser self-test (planted failure, known minimum) | **1 passed** (54.8 s), 25 -> 1 |

Both walks pass on a catalog **more than twice the size** of the one they used to run, which is the
first time this spec has been exercised over sheets, names, conditional formats, validation, freeze
panes, merge, sort, filter, clipboard, comments, notes, hyperlinks, replace-all or the worker realm.

**Two numbers in the baseline move, both mechanically.** `vitest` is **748 files / 106 231** (was
747 / 106 219) — one new file, the minimiser's twelve unit tests. And `functional` loses
`state-consistency`'s two tests to the `testIgnore` above; they run in `invariant`, which is where
they always belonged. **No functional total is quoted here** — see §3bq for why none could be
measured.

#### Not attempted, deliberately

A real product failure reduced automatically — §3bn's orphaned slicer — is the demonstration this
would most like to show, and it did not appear: five seeds were run and the walks either passed or
lost their app to §3bq. The planted self-test is the substitute, and it is the stronger instrument
test anyway (a known minimum can be ASSERTED; a real defect's cannot). The next pass that sees a
`state-consistency` failure in a quiet tree gets the reduction for free.

---

### 3bp. S13 is not chased — it is made ACTIONABLE. What a walker failure bundle now contains, and the four things it was missing (2026-08-11)

S13 (a `no-console-errors` failure on a fresh soak seed, `[ObjectScriptManager] Failed to mount
script "Soak Shape Renderer": Script mount timed out (10s)`, not reproducible in 16 replays) was
deliberately left unfixed because there was nothing to fix. It was also left UNDIAGNOSABLE, and that
part was fixable. The brief's question — "what would the bundle need to contain for the next
occurrence to be actionable?" — has four answers, and the bundle had none of them.

**1. The console ring: everything the page said, not just the errors.**
`installErrorTracking` captured `console.error` and page errors and dropped the rest on the floor.
The walker's own account of a refused mount is a `console.warn`, so the single line naming the cause
was never recorded. `isKnownNoise()` also dropped its matches with no trace, so a mis-calibrated
filter and a quiet run were indistinguishable. There is now a 2000-entry ring of EVERY console
message — type, text, source location, the walk step it arrived during, milliseconds since tracking
started, and a `filtered` flag rather than a deletion — with `dropped` reported so a truncated ring
says so instead of pretending to be complete. `report.md` leads with **every error and warning of the
whole run**, not a window around the failing step, because the product's `console.error` and the
walker's `console.warn` about the same mount can land on different steps.

**2. Timings, because a deadline is a duration.** Nothing timed anything, so "the mount sat on its
ten-second deadline and then failed" and "something failed instantly" produced identical evidence —
for the one failure mode this walker has that is *defined* in seconds. Every action now records
`startedAtMs` / `durationMs` / whether it threw, every oracle checkpoint records its duration, and
both the console report and `diagnostics.json` list the ten slowest actions. And the walker's own
mount handler now prints the number it measured:
`[walker] script mount "<id>" refused/failed after 10007ms (deadline 10000ms)`.

**3. The script host, at the moment of failure.** A mount-timeout bundle could not say whether ANY
script was mounted, let alone which. `probeScriptHost` records registered ids, mounted ids, instance
ids and tiers. It never throws: a probe that can fail the run it is diagnosing is worse than no probe.

**4. The app's own log, and the two ways of capturing it that DID NOT WORK.** Nothing was recording
`tauri dev`'s output, so every failure bundle this harness has ever written contained the browser
console and nothing else — a failure caused on the Rust side left no trace at all. Both launch paths
now tee to `app/e2e/results/app-dev.log` and the bundle copies its tail. Getting there took three
attempts, and the first two failed SILENTLY, which is the part worth recording:

* `Tee-Object` — Windows PowerShell 5.1's has no `-Encoding` and writes **UTF-16LE**, which any
  UTF-8 reader turns into mojibake. (The bundle's reader now sniffs the encoding regardless, because
  a log is written by whatever the operator happened to run.)
* a PowerShell `ForEach-Object` tee with an explicit BOM-less `StreamWriter` — correct encoding, and
  **still only two lines**: yarn's banner. Nothing `tauri dev` printed ever reached the pipeline.
* `app/e2e/launch-app.mjs` — node's piped `spawn`, the mechanism `global-setup.ts` already used to
  stream its `[tauri] …` lines. This one works, and it was verified by reading the file rather than
  by assuming: the log now carries the Vite banner, the cargo build and the app's own output.

**The first thing it captured was the explanation for something else.** Line one of the first real
capture is `Info Watching C:DropboxProjektCalculaappsrc-tauri for changes...` — the dev
watcher that had been killing this pass's E2E runs (§3bq). The instrument paid for itself on its
first launch.

**What is now known about S13's MECHANISM, which is not the same as its trigger.**
`ObjectScriptManager.mountScript` logs `console.error("[ObjectScriptManager] Failed to mount script
…")` and then rethrows. The walker catches the rethrow on purpose — a fuzzer must not abort on a
Script-Security decision — but the `console.error` has already fired, so **a failed mount fails the
walk's `no-console-errors` invariant no matter what the walker's handler does**. That is not a bug in
either of them; it is the reason S13 presents as a console-error violation rather than as a mount
failure, and the bundle now says so at the point of the warning. What remains unknown is why a
`fillRect` script exceeded a ten-second mount deadline once, and the next occurrence will arrive with
the mount duration, the script id, the whole console transcript and the backend log attached.

**Not suppressed.** Adding `Failed to mount script` to `isKnownNoise` or to the known-issues ledger
would turn a real product error into a silent one. The failure stays a failure; it is now a failure
that explains itself.

---

### 3bq. THE ENVIRONMENT WAS NOT QUIET — another agent was editing and compiling Rust throughout, and that is what "the app crashed" was (2026-08-11)

Read this before comparing any live E2E number in the section above with a previous pass's.

The app died **twice** during this pass's live work: once mid-walk (`page-crashed` at step 67 of the
`invariant` seed-1786421716252 run) and once between two ribbon captures. Neither is a product
crash. The evidence, gathered rather than assumed:

* `app.exe` was gone while the Vite dev server was still serving on 5173 — the FRONTEND was fine and
  the Tauri process had exited;
* the Windows Application event log had no entry for it, so it was not a fault Windows saw;
* `Get-CimInstance Win32_Process` showed **five to eight live `cargo.exe` / `rustc.exe` processes**
  that this pass never started, including `cargo check --lib --tests` and
  `cargo check --manifest-path app/src-tauri/Cargo.toml --all-targets`;
* `app/src-tauri/src/calculation.rs` and `control_values.rs` had mtimes **inside this pass's E2E
  window**.

`tauri dev` watches the Rust crate: a source change tears the running application down, rebuilds and
restarts it. **That is not inferred — the app log this pass added prints it, and printed it on the
very first launch that could capture anything:**

```
     Running DevCommand (`cargo  run --no-default-features --color always --`)
        Info Watching C:DropboxProjektCalculaappsrc-tauri for changes...
```
 Every E2E project in this tree connects to that one app over CDP, so an unrelated Rust
edit kills whatever walk, spec or screenshot run is in flight. The brief's rule — *never edit
`app/src-tauri` during an E2E run* — held from this side; it did not hold from the other.

**Three consequences, all of which affect how the numbers above should be read.**

1. **`page-crashed` in a walker bundle is not, on its own, evidence of a product crash** in a
   concurrently-edited tree. The bundle now carries what is needed to tell the two apart (the
   console ring, the realm-connection table, the app-log tail) but it deliberately does NOT diagnose
   it — see §3bo on the heuristic that was written and then deleted for inventing a reload.
2. **Long runs were not attempted.** A full ordered `--project=functional` pass is ~40 minutes and
   could not have completed uninterrupted; a cold Rust rebuild in this window took over twenty. The
   live results reported are all short runs. **Nothing here reports a functional/journey/visual
   suite total, and no such total should be inferred from this pass.**
3. **The one golden this pass touched was validated as far as that allows and no further** — see the
   ribbon entry. Its final validation is a full ordered functional run, and that is owed by the next
   pass in a quiet tree.

**It reached the unit suite too, and the shape is worth knowing.** A full `vitest` run early in the
pass was **748 files / 106 231 passed, 0 failed**. The same suite re-run at the end, while thirteen
`rustc` processes and an app link were saturating the machine, reported **3 failed** — and all three
are TIMEOUTS, not assertions: `aiChatExtension` (hook, 10 s), `build-verification` (vite build,
300 s) and `dialogGlobalsBan` (a 30 s test that took **212 s**). Each passes alone on a quiet
machine: 23, 7 and 1 tests in 6 s, 11 s and 59 s. The valid number is the first one. Note also that
§3bh called `dialogGlobalsBan` "a 30-second timeout waiting to happen" — under CPU contention it
happens, and a wall-clock budget on a lint-driven test is still the fragile part.

**Not a complaint, an interlock.** Two agents sharing one `tauri dev` is a real configuration and it
will happen again. The cheap mitigation, if this recurs: give the E2E app its own checkout, or agree
that E2E holds a lock the Rust agents check. Filing it rather than fixing it because the fix is a
workflow decision, not a code change.

---

### 3br. `ribbon-minimized` — re-examined on a live app. REFUSED AGAIN, on a new and much smaller reason, half of which is now fixed (2026-08-11)

§3ar refused this golden because its diff was grid CONTENT left by whichever of the ~450 preceding
specs ran last. §3az(3) declared that reason spent — the grid is masked out of the frame now, the
selection is pinned with `navigateTo`, undo availability is pinned by a `beforeEach`, "so recording it
no longer freezes one run's residue" — and put it on the re-record list, "deliberately not recorded by
an agent who could not open the app to look at the result". This pass opened the app and looked.

**The committed baseline is stale beyond argument.** Opened, not inferred: it shows the PRE-RESTYLE
window with a fully rendered grid, the Name Box on **A1** and the formula bar reading **"Before"**.
There is no mask in it and its ribbon is two restyles old. It fails today with 804 388 px differing —
the whole grid area.

#### The first recording attempt froze somebody else's residue, OUTSIDE the mask

```
Name Box:     W1
Formula bar:  Bold        <-- W1's CONTENT
```

`"Bold"` is written to W1 by **the last test in this very file**, `formatting buttons reflect active
cell state`. In one ordered pass of the file that test has not run when the capture is taken, so W1
is empty and the golden looks stable; run the file twice — or run this test alone after a full pass —
and the formula bar reads `Bold`. §3az(3) pinned WHICH CELL is selected. **The window frame also
contains the FORMULA BAR, so it photographs WHAT IS IN that cell**, and nothing pinned that. That is
§3ar's defect one level in, and "the reason has evaporated, record it" would have frozen it.

**Fixed in the spec:**

```ts
await grid.setCellValueDirect("X9", "ribbon-pin");
await grid.navigateTo("X9");
```

X9 is inside this spec's declared W-X / rows 1-10 block, no other test touches it, and it is given a
KNOWN value rather than assumed empty — "nothing ever writes here" is an assumption a future spec can
break silently; "this is what is here" is not.

#### What was then MEASURED, and it is most of the way there

* **Stable across an app restart.** Recorded, then verified on an independent run after `tauri dev`
  had torn the app down and rebuilt it (§3bq): **5 passed**, `ribbon-minimized` among them.
* **Insensitive to the residue that moves its siblings — the decisive experiment.** Running
  `charts.spec.ts` + `pivot.spec.ts` first and then `ribbon-tabs`: **13 passed, 3 failed**, and the
  three failures are `home-tab-default`, `ribbon-tab-insert`/`home-restored` and `format-state` —
  every one a capture of ribbon CONTENT, whose font box and Alignment toggles follow the active
  cell. `ribbon-minimized` PASSED. Contextual ribbon tabs are covered by the same result: charts
  existed and no contextual tab reached the strip.

#### Why it is still refused, and it is a two-line reason

A `ribbon-tabs` golden is a FUNCTIONAL-project golden, and §3ar's rule is that those are recorded in
a cold, full, ordered `--project=functional` run. Two specs that run BEFORE `ribbon-tabs`
alphabetically leave state this frame still photographs, and neither is masked or pinned:

| spec | leaves | in frame as |
|---|---|---|
| `flagged-defects.spec.ts` | `add_sheet` (x2), `setZoom` | the sheet-tab strip; the status bar's zoom readout |
| `hidden-rows-persistence.spec.ts` | `addSheetViaButton` (x2) | the sheet-tab strip |

Neither deletes the sheets it adds. So the number of sheet tabs at `ribbon-tabs` time in a full
ordered run is an OPEN QUESTION, and a golden recorded from a one-sheet app answers it by assumption.
The run that would settle it is ~40 minutes and could not be completed in this window — another agent
was recompiling the Rust crate throughout and the app was killed four times (§3bq).

**Recording it anyway was considered and rejected.** The argument for was strong: the committed
baseline can never pass again, so a wrong new baseline is no worse. The argument against decided it —
this register's record is that goldens recorded on an assumption become the next pass's mystery, and
the assumption here is *nameable and one measurement away*. Refusing costs one known failure that is
already known; recording costs a plausible-looking baseline whose first failure looks like a
regression.

**What the next pass inherits, in order:**

1. the content pin is already in the tree — it is the part that needed a live app to find;
2. **first**, run a cold full ordered `--project=functional` and simply LOOK at the sheet-tab strip
   when `ribbon-tabs` runs. If more than one tab is present, mask the strip (it needs a stable
   selector; `button[data-sheet-tab]` exists but its container has none) or accept it as pinned state
   and say so;
3. then record with `--update-snapshots` in that same cold full run, and verify on an independent one;
4. attribute the diff explicitly. Expected: the mask over `[data-grid-area]`, the Name Box reading
   **X9**, the formula bar reading **ribbon-pin**, and current ribbon styling. Anything else is a
   finding, not a re-record.

**Housekeeping that is itself a finding:** `--update-snapshots` on this file rewrote **all seven**
goldens while recording the one under examination — the same trap §3ar caught. All seven were
restored from a pre-pass copy and **verified by sha256** (`ribbon-minimized`
`3650f6f0…`, the five ribbon-element captures `b5564b0c…`, `ribbon-tab-insert` `6b2f0b94…`).

---

### 3bs. §3bm and §3bf, fixed together — there is ONE spill decision now, and the six functions that used to argue their way out of maintaining the map no longer have to (2026-08-11)

> **§3bu verified this by sabotage and found one hole next door:** the "one spill decision"
> contract holds hard (a one-line bypass in `apply_spill_decision` fails 54 tests, 40 of them in
> modules that predate it), but the RECALCULATION census could not see the end of
> `commands/data.rs` — its `#[cfg(test)]` stripper ran to EOF on a brace-less `mod x;`
> declaration, and that file ends with ten of them. Fixed in §3bu.

§3bm (the recalculation pass does not spill) and §3bf (`A1#` is frozen at entry) were filed as
neighbours "wanting one answer about where a spill fact lives". They got one, and it turned out to be
two halves of the same sentence:

* **`commands::data::apply_spill_decision` is the only function that DECIDES a spill** — the only
  place `spill_ranges.insert(` appears outside the load-time restore. It was three copies.
* **`name_resolution::eval_ast` is the only function that READS one for a formula** — the third
  indirection a stored formula keeps, after D2's defined name and §2aj's structured reference.

#### 1. §3bm — what was actually wrong, and why the fix is a deletion

The register described the pass as having *no* spill decision. That was true and it was the smaller
half. The bigger half is that the other three paths had **three separate hand-written copies** of it —
`update_cell_impl`, `reevaluate_formula_cell`, `update_cells_batch_core` — and they had already
drifted: only one consulted `spill_hosts` to tell "a cell my own array owns" from "somebody else's
cell", and none of the three cleared the recorded `#SPILL!` address when the formula stopped
producing an array. `note_spill_block`'s own doc had to *ask* the three to stay symmetric, which is
the register's standing tell that a thing wants to be one thing.

So the fix is not "add a fourth copy to the pass". It is:

```
apply_spill_decision(state, grid, grids, active_sheet, sheet, row, col, &raw, styles, locale, out)
```

— tear down what this origin owned (through the ONE tear-down, §2y), refuse where blocked with the
blocker's address, otherwise lay the rectangle and claim it — with `sheet` and `active_sheet` as
SEPARATE parameters, which is the whole reason a workbook-scoped pass can use it at all. Five callers
now: the three edit paths, the cross-sheet walk, and both recalculation passes. `evaluate_single_formula`
was changed to return the raw `EvalResult` instead of `to_cell_value()`; that collapse *was* the defect.

**No fourth walk was added, and the census says so rather than the author.** The plan loop is the
same loop; `apply_spill_decision` decides what ONE already-evaluated result does to the grid and
never chooses which cells to evaluate. Both censuses were updated and, notably, **six `EXEMPT`
entries were DELETED** — `update_cell_impl`, `update_cells_batch_core`, `reevaluate_formula_cell`,
`recalc_walked_cell`, `run_calculation_pass` and `recalculate_sheet_values`. Three of them had
carried their own copy; three had said, in prose, that they "removed no origin", which was true and
beside the point, because they REPLACED an array's value without re-laying its rectangle. They are
now classified by the detector instead of by a sentence.

#### 2. Four more defects of the same class, found because the decision became one

* **The cross-sheet edit walk was scalar-only.** `recalc_walked_cell` wrote `to_cell_value()`, so a
  dynamic array on a sheet you were not looking at collapsed the moment an edit on another sheet
  reached it. Left alone it would have made the same workbook hold different values depending on
  whether F9 or a keystroke last ran — the exact path-dependence `EvalSurface`'s doc forbids, and it
  would have been *created* by fixing §3bm. `cascade_cross_sheet_dependents` therefore takes
  `&AppState` now; it still installs no token of its own, so the surface-inheritance argument in its
  doc is untouched.
* **The `#CIRCULAR!` stamps released nothing.** A cell that becomes a cycle member produces no array,
  but neither the pass's own circular branch nor `mark_off_sheet_circular_cells` gave its rectangle
  back. `release_origin_spill` — the tear-down half, split out precisely because these two branches
  write a value they never evaluated — is called from both.
* **A scalar result never cleared `spill_blocks`.** An origin that stopped producing an array kept
  the address it had recorded, so the next time anything asked "what is blocking this cell" it got a
  stale answer. The scalar branch of the one decision clears it.
* **`scripting/udf.rs::collect_udf_calls` held a FOURTH hand-rolled copy of the ENTRY-time
  resolution** (names, then tables, then spill refs) and cached the *resolved* tree into its scratch
  cell. Once §3bf made the real edit path keep the `#`, that scratch cell held a different formula
  from the one the user was typing and UDF discovery scanned the wrong text. It calls
  `split_entered_formula` now, like everything else.

#### 3. §3bf — `A1#` resolves at evaluation, with an edge

`split_entered_formula` no longer resolves spill refs into `stored`; `eval_ast` resolves them, last
(a name's `refers_to` may itself be a `#`). Three consequences, all of them the point:

* the formula bar and the archive both say `SUM(A1#)`, so nothing on screen lies about what was
  typed;
* the dependency edges come **free**, because `stored_ast_references` asks the same `eval_ast` — the
  reader is recalculated by the edit cascade, not by a later F9;
* the reference resolves against the extent the CURRENT pass just laid, which is why this could not
  ride a snapshot. Anything captured at the start of a cascade answers with the extent that cascade
  is in the middle of replacing — §3bf again, narrowed to one pass.

**The cost §3bf asked to be measured.** One `ast_has_spill_refs` walk per evaluated cell — the same
order as the `ast_has_table_refs` walk `eval_ast` already paid — and, only for a formula that really
contains a `#`, one uncontended `spill_ranges` lock around a map read. A workbook with no spill
reference never takes the lock.

**That lock is a new deadlock shape, and it is guarded rather than remembered.** `std::sync::Mutex` is
not reentrant, so a function that holds `spill_ranges` and then evaluates a formula hangs — and a hang
is invisible to an exit-status check, which this register has already lost a run to.
`spill_ref_tests::no_spill_map_holder_also_resolves_a_formula` enumerates the crate for the
combination and **found two on its first run**: the UDF collector above, and
`spill_restore::recover_spill_map_by_evaluation`, whose evaluation half and map-writing half were one
function separated only by a `drop`. The commit half is now `commit_recovered_spills`, so the two
cannot be interleaved by accident because they cannot see each other's locals.

**And the §3bf tests found a §3bm-shaped defect in the recalculation pass, one layer down.**
`evaluate_single_formula` had its OWN private copy of the resolution rule — names and tables, and no
knowledge of spill refs — so `=SUM(A1#)` answered `#NAME?` the first time F9 was pressed. It goes
through `eval_ast` now. That is the third time in this one section that a private copy of a shared
rule was the defect.

#### 4. TEETH

`apply_spill_decision` was given a one-line early return (`return raw_result.to_cell_value()`, the
pre-fix behaviour) behind an env var, the crate rebuilt, and the whole app-lib suite re-run with it
set. **Forty-odd spill tests fail across three modules** — the nine new §3bm tests, and every
pre-existing test in `spill_map_tests` and `spill_persistence_tests`, including `§2ab`, `§2y` and the
`#SPILL!` tests written before this pass. That is the proof the consolidation is real: those older
tests never mentioned the new function, and they cannot pass without it. `commands/data.rs` was
restored from a pre-sabotage copy and verified **byte-identical by checksum** —
`sha256 0aad47d62b75e335e26cd625d434b3493426bb9bd73c074c0cc534484943cc86` before and after — then
rebuilt and re-run green.

Two source-level guards were added with their own non-vacuity tests, in the shape the six censuses
use: `recalc_spill_tests::only_one_function_decides_a_spill` (+
`the_one_decision_detector_finds_what_it_looks_for`) and
`spill_ref_tests::no_spill_map_holder_also_resolves_a_formula` (+
`the_lock_census_detector_finds_the_pattern`).

#### 5. THE SAVE-PATH BENCHMARK, which is what the brief gated this on

`calculate_before_save` defaults to **true**, so the workbook pass runs on every Ctrl+S. Measured with
`bench_the_save_path_cost_of_the_spill_decision` (in `spill_persistence_tests`), **debug profile,
arm64, min of three runs**, against the same binary with the decision bypassed:

| workbook | before | after | delta |
|---|---|---|---|
| 10 000 formulas, no array | 67.9 ms | 73.9 ms | **+6.0 ms (+8.8%), 0.60 us/formula cell** |
| 50 000 formulas, no array | 377.8 ms | 400.3 ms | **+22.5 ms (+6.0%), 0.45 us/formula cell** |
| 50 000 formulas + 100 arrays x 50 | 384.6 ms | 700.7 ms | +316 ms — **not a regression**: the bypassed run writes no spill cells at all, so this column is the cost of producing the right answer for 4 900 of them |

The added work in the common case is one `spill_ranges` lock plus an `is_empty()`
(`take_spills_where` returns before it looks at anything else) and one `spill_blocks` lock, per
formula cell. **A 50 000-formula workbook pays about 20 ms more per save, in a DEBUG build.** The
first two rows are the ones to hold anyone to; the third is not a comparison.

#### 6. What was NOT done, precisely

* **NO E2E WAS RUN.** An `app.exe` belonging to another agent was live on this machine during the
  pass (it had to be killed to free `target/`), and the register's own rule is that two cold-start
  invocations must never overlap — the last collision produced a run that had to be discarded.
  **The §3bm characterisation in `app/e2e/journeys/live-parity-proofs.spec.ts` has been INVERTED
  anyway**, because leaving it asserting the fixed defect guarantees a red: it now asserts that F9
  re-lays a shrunk array (B3/B4 empty AND `get_spill_ranges` claiming only B1:B2), that a blocked
  array keeps its `#SPILL!` through save and reload, and it keeps its `F1` control and its
  `try`/`finally` around manual mode. **That inversion is UNVERIFIED live and is the first thing the
  next pass should run** (`--project=journey --grep "live-parity"`); the same behaviour is proved at
  the Rust level by nine tests plus the sabotage above, so the expectation is green.
* **`A1#` on a cell that is NOT a spilling array reads the cell itself; Excel answers `#REF!`.**
  Pinned as a known deviation by `a_hash_on_a_cell_that_is_not_an_array_reads_the_cell_itself`, with
  the reason at the assertion: `spill_ranges` records an entry only when the result reaches beyond
  its origin, so a ONE-cell dynamic array (`=SEQUENCE(1)`) has no extent, and the single-cell
  fallback is what makes `A1#` on it read 1 — which is what Excel does. Answering `#REF!` needs 1x1
  arrays recorded in the map first, and that is a `.cala` extent change, not a resolution change.
  **Filed, small, and deliberately not bundled.**
* **The workbook plan's ORDER is still built from the extents the pass found on the way in.** A
  reader of an array's ORIGIN is ordered correctly (the origin is a formula cell, so the edge
  exists), and that covers `A1#` and every whole-range reader. A formula that reads ONE spilled cell
  directly (`=B3*2`) has no edge, because `B3` holds no formula — so it can be evaluated before the
  array is re-laid. This is pre-existing, is the same class as `OFFSET`/`INDIRECT`, and is unchanged
  by this pass; recorded because the fix makes it observable where before nothing moved at all.
* **`vitest` had ONE transient failure**, `build-verification.test.ts` ("Vite build failed"), which
  **passes on its own** (163 s). Another agent was editing TypeScript throughout — §3bq's hazard,
  recurring.

#### 7. Numbers

| suite | result | baseline |
|---|---|---|
| app-lib | **1 460 passed / 0 failed / 5 ignored** | 1 406 — this pass added 24 (12 `recalc_spill_tests`, 8 `spill_ref_tests`, 3 save-path, 1 ignored bench); the rest are another agent's |
| core cargo | **1 337**, 0 warnings `--all-targets` | 1 337 |
| script-engine | **111** | 111 |
| test_pivot | **56** | 56 |
| app crate | 0 warnings `--all-targets` | 0 |
| vitest | 747 files passed + 1 transient (748), **106 230 passed / 1 failed** | 747 / 106 219 |
| `tsc --noEmit -p tsconfig.check.json` | clean | clean |
| E2E | **not run** — see section 6 | — |

---

### 3bt. §3bn CLOSED — the orphaned slicer, and the CLASS it turned out to be: 50 (owner, dependent) pairs, 15 of them leaving a dangling or stale reference, and a seventh census so a new object type cannot be added without declaring what happens to its dependents (2026-08-11)

> **The census below did NOT hold as written — see §3bu.** It asked its question per object KIND
> and concatenated the bodies of every delete command for that kind, so `convert_to_range` vouched
> for `delete_table`: deleting the `cascade_deleted_sources` call from `delete_table` left the
> census green. It now asks per COMMAND. Tightening it also found a real hand-inlined second copy
> of `clear_prop_dependencies` in `remove_slicer_computed_property`.

**The named instance first.** Create a table, create a slicer on it, delete the table:
`tables = 0`, `slicers = 1`, and the survivor's `cacheSourceId` still names the deleted table.
`get_slicer_items` answered `"Table {id} not found"` on every item fetch (a console error per
repaint) and the slicer's overlay went on claiming its rectangle, so clicks meant for the grid
underneath hit a control that could never respond — 171 click retries into the 120 s timeout.
Fixed: **deleting a table deletes its slicers**, which is what Excel does.

**The class is the part that matters, and it was much wider than the report.** Enumerating
mechanically rather than by name — everything deletable against everything that holds a reference —
turned up the same shape live in fourteen more places, none of which fixing the table/slicer pair
would have touched:

| deleted | dependent | before | now |
|---|---|---|---|
| table | slicer (`cacheSourceId` / `connectedSources`) | **ORPHAN** | cascade, or repoint if a Report Connection survives |
| table (Convert to Range) | slicer, object script, undo record | **ORPHAN + NO UNDO AT ALL** | same cascade as delete; **and it now records an undo transaction** |
| pivot | slicer | **ORPHAN** | cascade / repoint |
| pivot | timeline slicer (`sourceId`) | **ORPHAN** | cascade / repoint |
| pivot | ribbon filter (`connectedPivots`, `crossFilterTargets`) | **ORPHAN** | prune the dead id; the filter survives |
| slicer | ribbon filter (`crossFilterSlicerTargets`) | **ORPHAN** | prune |
| ribbon filter | sibling filters (`crossFilterTargets`) | **ORPHAN** | prune |
| chart | pane control (`chartParamTarget`) | **ORPHAN** | clear the binding; the control, its name and its VALUE survive |
| sheet | slicer / timeline / chart / sparkline **on** it | **ORPHAN** (survived invisibly, and in the saved file) | deleted with the sheet |
| sheet | the same objects on sheets **above** it | **STALE INDEX** — painted on the wrong sheet | re-anchored |
| sheet (move / copy) | the same objects | **STALE INDEX** | re-anchored |
| sheet | ribbon filter `connectedSheets` (bySheet mode) | **STALE INDEX** — silently retargeted at another sheet's pivots | pruned + re-anchored |
| pane control | its object script (`pane-<id>`) | frontend-only, so **every other route left it** | pruned backend-side |
| script (macro) | scheduled jobs (`scriptId`) | **ORPHAN** — woke on its timer forever and failed to resolve | jobs dropped |
| script (macro) | capability grants | **ORPHAN** — a standing authorisation with no code, inheritable by a new script with the same id | revoked |
| script (macro) | buttons that link it | warn + keep (`list_controls_referencing_macro`) | unchanged — this was already right, and it is the standard the rest now meet |
| named range | formulas | `#NAME?`, not rewritten | unchanged — **Excel's behaviour, deliberately** |
| BI connection | ribbon filters, BI pivots, reports | orphan, silently | **warn and keep** — see below |

The full matrix is **50 rows over 27 object kinds** and lives as DATA in
`app/src-tauri/src/object_deps.rs` (`DEPENDENCY_MATRIX`), one row per (owner, dependent) pair with
its policy, the symbol that executes it, and the reason. `cargo test -- --nocapture
object_dependency_table` prints it.

**Four verbs, and "orphan" is not one of them.** `Cascade` (the dependent cannot exist without the
owner), `CascadeOrRebind` (Excel's Report-Connections rule: dead ids are dropped from the connection
list first, and only a slicer with NOTHING left to filter is deleted — one that loses one of three
pivots keeps filtering the other two and has its `cacheSourceId` repointed at a survivor),
`Prune` (the dependent survives minus the dead reference — deleting a chart must not delete the
slider that drove it), `Repair` (stored text rewritten). Plus three that run no code and must
therefore be ARGUED in the row: `WarnAndKeep`, `Recalculate`, `NoDependents`.

**Undo is part of the cascade, not an afterthought.** A cascade that cannot be undone is a data-loss
bug wearing a fix's clothes. `record_source_cascade_undo` pushes a restore for every object the
cascade touched into the transaction the DELETING command already has open, and the ordering is
load-bearing: undo replays a transaction in REVERSE record order, so the cascade's entries are
recorded BEFORE the owner's and therefore restore AFTER it — the slicers come back onto a table that
exists again. One Ctrl+Z, one restored world. Two deliberate exceptions, both written down:
timeline slicers have no restore arm because `TimelineSlicerState` is not persisted at all
(pre-existing gap), and `delete_sheet` records nothing because Excel does not let a sheet delete be
undone either — a cascade recording restores there would put slicers back onto a sheet that cannot
come back.

**THE SEVENTH CENSUS** — `object_deps_census_tests.rs`. Three parts: every `#[tauri::command]` that
deletes is either mapped to an `ObjectKind` or written down as out-of-scope **with a reason**; every
`ObjectKind` has at least one matrix row (*"nothing points at this"* is a legitimate answer, no
answer is not); and every row whose policy needs code names a symbol the owning delete command
actually calls. 63 delete-shaped commands are enumerated from the tree; 33 are workbook-object
deletes, 14 are excused individually and the 19 `bi_model_delete_*` by one prefix rule (the semantic
model's own object graph, validated inside `bi-engine`).

The detector fires, and is proven to on synthetic sources every build: a commented-out call does not
satisfy it (both sides read comment-stripped source); it follows exactly ONE level of delegation
(`remove_auto_filter` is a two-line wrapper — without the hop it would pass vacuously; with two hops
the closure becomes the whole crate and stops discriminating); an `impl` method is not a free
function (at any indent below 0, a `Drop` impl's `fn drop` resolves as the `drop(guard)` ending
nearly every locking function here); and — the strongest form — the implementation check is driven
against a world where every delete command is EMPTY and must report **every** row that needs code,
`table -> slicer` by name. If that comes back short, deleting a cascade call would not fail the
build.

One parse defect the census found in itself, worth recording because it is the exact failure mode
the previous six were hardened against: `all_bodies` was a first-wins map, and `mcp/objects.rs`
defines its own `delete_table` / `delete_sheet` / `move_sheet` wrappers. `delete_sheet` resolved to
the four-line MCP wrapper and **every cascade the real command runs read as unimplemented**. Bodies
are now kept per name as a `Vec`, which is also the honest answer when there are two delete paths.

**Two pre-existing defects fixed alongside, both found by the enumeration:**

* **`convert_to_range` recorded NO undo whatsoever.** It rewrote every dependent structured
  reference in the workbook, dropped the table's AutoFilter and removed the table, and Ctrl+Z brought
  back none of it. That is the same class of half-finished bookkeeping BUG-0006 was on `delete_table`.
  It now records the identical transaction, in the identical order, and prunes the table's object
  scripts (which it also never did — a script bound to a dead table id is inherited by the next
  object minted at that id, §1a's defect on a second path).
* **Sheet MOVE and COPY never re-anchored the floating object stores either.** They are not keyed by
  sheet, so `remap_sheet_keyed_stores` never reached them; the same walk now runs there, with a total
  remap, so it deletes nothing and only re-anchors.

**One product call, implemented safe and flagged: deleting a BI (model) connection.** Excel keeps a
PivotTable whose connection is gone and lets it fail to refresh. Cascading would delete the user's
laid-out pivots and their formatting because a connection string went stale — unrecoverable, where
leaving them is recoverable by re-creating the connection. So the objects STAY, and the confirm now
NAMES them ("*3 object(s) read this connection (pivot "Sales by Region", ribbonFilter "Region", …).
They are KEPT, but will fail to refresh until a matching connection exists again*"), which is the
`list_controls_referencing_macro` standard applied to a second owner. Backed by one new command,
`list_object_dependents(kind, id)`, which answers from the same rules the cascade applies so the
warning and the behaviour cannot drift.

**One fidelity gap recorded rather than fixed, with the argument.** Excel reverts cells using a
deleted named style to Normal; Calcula leaves their resolved formatting in place. This is NOT a
dangling reference — a cell stores a `style_index` into the style registry, never the style NAME — so
nothing orphans. Leaving it is the safe option (nothing the user can see changes, no formatting is
lost); reverting would silently restyle cells across the workbook. Owner call.

**And one thing the frontend needed, which the backend fix alone would not have cured.** The
extensions cache their own objects and paint their own overlays, so a slicer the backend deleted goes
on rendering — and on swallowing clicks, which is the 120 s timeout — until its cache re-reads. Every
cascading delete now emits `MUTATION_REFRESH` with the DOMAINS it disturbed (`slicer`, `pivot`,
`ribbonFilter`, `paneControl`, `objects`); the Shell translator owns the mapping to per-feature
events, so no extension names another extension's event.

**Tests:** 31 new backend tests — `object_deps_tests.rs` has one per non-trivial pair (including the
two halves of the rebind rule, the two type guards that stop a table delete from touching a pivot
slicer or a model-connection slicer, and both halves of the sheet case), and
`object_deps_census_tests.rs` has the census plus six self-tests. app-lib **1 460** green, core
**1 337** green.

**The characterisation test is INVERTED.** `§3bn CHARACTERISATION — deleting a table leaves its
slicer behind` in `live-parity-proofs.spec.ts` is now `§3bn PROOF — deleting a table deletes the
slicer bound to it` and asserts 0 survivors. **It was NOT run** — another agent held the app and an
E2E session throughout this window, and two cold-start invocations on one CDP connection is the
wreckage this register already recorded once. The inversion is mechanical (1 -> 0, plus a
`not.toContain` on the dead binding) and typechecks; the next pass that runs `--project=journey`
should confirm it, and re-run `state-consistency` seed **1786421716252** to confirm it was the same
defect.

**Residual, named:** `TimelineSlicerState` is still not persisted, so a timeline slicer does not
survive save/reload at all and has no undo arm — the cascade removes it correctly in-session and
records nothing. That is a pre-existing gap, not one this pass introduced, and it is the reason the
timeline rows in the matrix are honest about having no undo.



### 3bu. The integration pass for §3bs / §3bt / §3bq — contract verification by sabotage, and the three defects it found (2026-08-11)

Three passes landed together (the spill consolidation §3bs, the orphan cascade §3bt, the harness
de-duplication §3bq). This pass integrated them, reconciled the shared files, and then tried to
BREAK each contract on purpose. Every suite is green; the interesting part is the three things that
turned out not to be contracts at all until they were attacked.

**All three were found by sabotage, not by reading.** Each of the preceding reports asserted its
guard held. Each assertion was true about the code it described and false about the guard.

#### 1. The seventh census asked its question per KIND, so one delete path vouched for its sibling

The census in §3bt claims: *every row whose policy needs code names a symbol the owning delete
command actually calls*. It was tested by removing the `cascade_deleted_sources` call from
`delete_table` — the exact call §3bn exists to have added — and running the census.

**It stayed green.**

`unimplemented_rules` keyed its map on the owner's `ObjectKind` and CONCATENATED the bodies of every
delete command that removes that kind:

```rust
owner_text.entry(kind.wire_name()).or_default().push_str(&text);
```

`DELETE_COMMANDS` lists both `("delete_table", Table)` and `("convert_to_range", Table)`. Both land
in one bucket, so the row was satisfied as long as EITHER path cascaded. `convert_to_range` still
did, and it vouched for `delete_table`.

This is not a near-miss; it is the section's own defect wearing the census's clothes.
`convert_to_range` was found in §3bt precisely *because* it was a second table-delete path carrying
the identical orphan — and the census written to prevent the next one could not have caught it.
**Six kinds have more than one delete command** (Table, ObjectScript, Sparkline, Comment, Note,
ComputedProperty), so six kinds could hide a missing cascade on one of their paths.

An orphan is created by a COMMAND, so the unit of proof is a command. `unimplemented_rules` now
takes one entry per command and reports per command, naming the path:

> `table -> slicer.cacheSourceId / slicer.connectedSources: declares cascade_deleted_sources, which`
> `appears nowhere in the comment-stripped body of delete_table — every command that destroys a`
> `table must run the cascade, not just one of them`

The detector's own self-test grew the case that would have caught this (`7. A SIBLING DELETE PATH
MUST NOT VOUCH FOR ITS TWIN`): a synthetic world where every command implements except
`delete_table`, asserting the report is non-empty AND names `delete_table` alone. The empty-world
count in case 6 is now a sum over (rule x commands-of-that-kind) rather than a row count — a kind
with two delete paths owes two proofs.

#### 2. ...and tightening it immediately found a real second copy: `remove_slicer_computed_property`

With the census asking per command, it reported a pair nobody had planted:

> `computedProperty -> computed-prop dependency edges: declares clear_prop_dependencies, which`
> `appears nowhere in the comment-stripped body of remove_slicer_computed_property`

Not an orphan — the slicer path DID clean up its dependency maps. It did it with a **hand-inlined
second copy** of the forward/reverse map bookkeeping, which agreed with
`computed_properties::clear_prop_dependencies` only because neither had been touched since. That is
the §3bm shape exactly (three copies of one spill decision, two already drifted), one layer down and
still un-drifted — caught while it was only a hazard.

`clear_prop_dependencies` is now generic over the id type (`u64` for grid properties,
`identity::EntityId` for slicer properties; both are `Copy + Eq + Hash` and the maps are otherwise
identical) and `pub(crate)`. One loop, two callers. The inlined copy is deleted.

#### 3. The recalculation census could not see the end of `commands/data.rs`

Sabotage for §3bs's "no fourth recalculation walk": append a cell writer that recalculates nothing
to `commands/data.rs` and confirm the census names it. The **spill** census named it immediately.
The **recalculation** census stayed green.

`strip_test_modules` blanks `#[cfg(test)]` modules before enumerating. It skipped one by scanning
forward to a `}` at column 0:

```rust
let mut k = j;
while k < lines.len() && lines[k] != "}" { k += 1; }
```

A module **declaration** (`#[cfg(test)] #[path = "..."] mod spill_ref_tests;`) has no body and no
such brace, so the scan ran to EOF and cleared every line from the first declaration onward.
`commands/data.rs` ends with **ten** of those declarations. Everything after them was invisible to
the census — in the crate's largest command file, and in the one whose spill decision §3bs had just
consolidated.

Nothing was actually hiding there (the census passes with the whole file visible), so this cost
nothing yet. It was one appended function away from costing a wrong answer with no signal.
Declarations are now blanked as one line and the walk continues; the self-test gained case `3b`,
which asserts both halves — a writer after a brace-less `mod x;` IS enumerated, and a real
`#[cfg(test)] mod tests { ... }` with a body is STILL stripped, because a census that enumerates
test fixtures as product writes drowns.

#### The contracts, and how each was actually checked

| contract | verdict | how |
|---|---|---|
| §3bm characterisation test inverted | **HOLDS** | `a_spill_reference_follows_its_array_3bf` asserts the stored form keeps `#` and the sum tracks 10 -> 15 -> 3; the E2E §3bm test asserts B3/B4 empty and `get_spill_ranges` = B1:B2. No test anywhere still asserts the collapse. |
| no fourth recalculation walk | **HOLDS** (after fix 3) | Appending a non-recalculating cell writer to `data.rs` now fails BOTH enumerating censuses by name. Before the stripper fix it failed only the spill one. |
| a recalculation that changes an array's LENGTH updates ownership | **HOLDS** | `f9_re_lays_an_array_that_shrank` / `_that_grew`, each with a non-array CONTROL, plus `assert_map_agrees_with_grid` reconciling `spill_hosts` against `spill_ranges` cell for cell. |
| one spill decision | **HOLDS** | A one-line early return in `apply_spill_decision` behind `CALCULA_TEETH` fails **54** tests — **40 of them in `spill_map_tests` and `spill_persistence_tests`, which never name the function** and predate it. |
| no silent orphan | **HOLDS** (after fixes 1-2) | Removing the cascade from `delete_table` now fails the census by command name. |
| all censuses fire, each with a self-test | **HOLDS** | Nine detector self-tests, two of them extended by this pass. |
| no second minimiser | **HOLDS** | One `minimizeTrace` in `walker/shrinker.ts`; `soak-walk` and `state-consistency` both import `WalkRunner` + `writeFailureBundle` + the shrinker from `../walker`. `invariants/{runner,actions,actionGenerator,reporter}.ts` are gone. |

**Restoration discipline:** every sabotage was reverted and verified by `sha256` —
`commands/data.rs` `de5ccc51...`, `tables.rs` `9e555a02...`.

#### `dialogGlobalsBan` — the flake §3bh fixed once, fixed properly

§3bh shared one `ESLint` instance across the file's 23 cases. That removed 22 config loads; the
surviving one is still billed to whichever case runs FIRST, and under a full parallel `vitest run`
it has been measured past the 30 s per-test timeout (212 s in one contended run). The file then
reports a failure that reads exactly like a deleted lint rule, which is the worst possible false
signal for a guard-on-a-guard.

The load is SETUP, so it is now billed to setup: a `beforeAll` warms the instance with a 300 s
budget and every case keeps the ordinary timeout. Nothing the test asserts is softened. The full
suite is **748 files / 106,231 passed / 0 failed**, with this file green in place rather than only
in isolation.

#### Numbers

vitest **748 / 106,231** (baseline 747 / 106,219; the delta is exactly
`e2e/walker/__tests__/shrinker.test.ts`, +1 file / +12 tests, from §3bq) · core **1,337** ·
script-engine **111** · app-lib **1,460 / 0 / 5 ignored** · test_pivot **56** ·
model-engine-lib **2,192 / 0 / 80 ignored** · `cargo check --all-targets` **0 warnings** in both
workspaces · check-types, lint:boundaries, check:line-endings clean · script typings **39 / 736**.

**E2E was not run in this pass, by instruction.** The three inverted E2E characterisation tests
(§3bm, §3bn, and the §3bf live proof in `live-parity-proofs.spec.ts`) typecheck and are still
unexecuted since inversion — that is the one outstanding verification, and it is named in §3bs and
§3bt as well. Run `--project=journey --grep "live-parity"` first.

### 3bv. The live-proof pass for §3bs / §3bt / §3bu — the inverted tests all pass, and the app hung twice while proving it. One deadlock fixed, a crate-wide lock-order split closed, a second deadlock filed with an instrument (2026-08-11)

The brief was to PROVE the previous three passes on a running app: run the inverted §3bm / §3bf /
§3bn characterisation tests, exercise the minimiser on a real failure, and run every project. All of
that was done and is reported below. It is not the interesting part.

**The interesting part is that the app stopped answering, twice, and the guard that exists to prevent
exactly that was RED IN THE TREE the whole time.**

#### 1. `state_digest_lock_order_tests` was failing, and nobody had run it

§3bu reported `app-lib 1,460 / 0 / 5 ignored`. Measured at the start of this pass, on an unmodified
tree, with `cargo test --lib`:

```
test state_digest_lock_order_tests::the_digest_takes_the_two_grid_locks_in_the_passs_order ... FAILED
test state_digest_lock_order_tests::the_digest_does_not_hold_grids_while_it_waits_for_grid ... FAILED
```

Both of them. `build_workbook_state_digest` still took `state.grids` and THEN `state.grid`, exactly
the order its own file's header describes as the thing that "hangs the entire application". The fix
that file documents had landed as PROSE AND TESTS; the two lines it is about were never turned round.

That is not a near miss. **The app hung on it, live, in this pass, before the tests were ever run** —
soak seed 1786446166374, the fresh seed this brief asked for: 19 threads waiting, 0 CPU seconds
consumed over four minutes, `Responding: False`, and the last line in the app log its own
`DIGEST|get_workbook_state_digest` with no completion. The identical signature the file's header
attributes to seed 20260810. It took the whole shrink down with it — the minimiser was on replay 8
of a real defect when the page died.

A hang is invisible to an exit-status check; a red test is invisible to nobody. It was simply never
run.

#### 2. ...and the guard was asking a question two functions wide, in a crate where 32 more were wrong

With the digest turned round, the obvious next question — *is this the only one?* — had never been
asked. Enumerating every function that binds both grid locks and still holds the first when it takes
the second:

| order | functions |
|---|---|
| `grid` then `grids` (the pass's) | **41** |
| `grids` then `grid` (inverted) | **32** |

The crate had NO canonical order. Any of the 32 could deadlock against the background recalculation
pass exactly as the digest did, and one of them is `get_used_range` — which the canvas asks for
constantly. `Persisted<T>` is a **`Mutex`**, not an `RwLock` (`read()` is `lock()`), so two "readers"
exclude each other and every pair is a real pair.

**Why the direction is not a choice.** A deadlock needs one holder on a background thread. This crate
has exactly TWO `#[tauri::command(async)]` commands — `calculate_now` and `calculate_sheet` — and both
are `run_calculation_pass`. Every other command is synchronous and therefore serialised on the
WebView2 main thread, so the 41 and the 32 cannot deadlock each other; they can only deadlock against
the pass. Everything has to agree with the pass, and the pass's order is `grid` then `grids`.

All 32 are now in the pass's order. 21 were a pure statement swap; 9 took the mirror inside a nested
`if dest_sheet_idx == active_sheet` branch and had it hoisted above `grids` (a slightly wider critical
section, which is the price of one order); and `calp_reset_subscription` was restructured to hold
**one lock at a time**, which needs no ordering rule at all and is the better answer wherever the
clone is cheap.

#### 3. The census that replaces it, and the three real inversions IT found after the mechanical pass

`no_function_holds_the_two_grid_locks_in_the_inverted_order` walks every non-test `.rs` in the crate.
It counts an acquisition whether or not it is bound to a name, and stops looking at the first `drop(`
or when the block holding the first guard closes. It over-approximates on purpose: a false positive
costs an argument, a false negative costs an app that stops answering with nothing in the log.

It immediately found three the mechanical pass had missed, and each is a different lesson:

* **`sheets.rs::delete_sheet` takes the two locks TWICE** — a read pair and a write pair — and only
  the first had been corrected. A per-function "first acquisition of each" rule is not enough.
* **`pivot/commands.rs::create_pivot_inner`** — the mirror is taken 34 lines below `grids`, inside two
  nested branches. It had been classified as safe by a `drop()` that belonged to a different guard.
* **`calp_commands.rs::calp_reset_subscription`** — `*state.grid.write(&e)? = grid.clone();`, an
  UNBOUND acquisition inside a block still holding `grids`. Nothing that looks for `let` bindings can
  see it.

**The census has teeth against the real tree, not just planted strings.** Re-introducing the digest's
inversion and running it:

> `these functions take state.grids and then state.grid while the first guard is still alive:`
> `  state_digest.rs::build_workbook_state_digest`

Restored and verified by sha256 (`state_digest.rs` `29aa4a62…`). Four planted bodies pin the detector
itself (adjacent / nested-in-a-branch / unbound temporary must all fire; canonical order, released by
scope, released by drop and a commented-out call must not), and a fifth pins the `#[cfg(test)]`
stripper against §3bu's exact defect — a brace-less `mod x;` must not swallow the rest of the file
and a real test module must still go.

#### 4. A third test was red, and the census's own staleness check named it

`every_cell_writing_function_either_maintains_the_spill_map_or_is_exempt_with_a_reason` was also
failing, on `state_digest.rs::build_workbook_state_digest`. The digest's body had been split out of
the command so the lock-order guards could call it without a Tauri `State` — and its EXEMPT entry did
not move with it, so the census was naming a read-only function. (The `cells.insert(` it matches is
an insert into the digest's own output `BTreeMap`.) Fixing it by adding the new name left the OLD name
stale, and the same census's second half caught that too:

> `EXEMPT names functions that no longer write cells: state_digest.rs::get_workbook_state_digest`

Three of the crate's tests were red on arrival. **`app-lib` is 1,467 / 0 / 5 ignored now** — 1,464
that existed, all green, plus this pass's three new census tests.

#### 5. THE SECOND DEADLOCK IS REAL AND IS NOT FIXED

The lock-order fix is necessary and is not sufficient. On the rerun of the same fresh seed, on the
fixed build, **the app wedged again** with the same signature: last log line
`DIGEST|get_workbook_state_digest cells_only=false`, no completion, all 19 threads in `Wait`, zero CPU
delta over 70 seconds, `Responding: False`.

What is established, by measurement rather than reasoning:

* it is NOT the `grid`/`grids` pair — that order is now uniform and the census proves it;
* it needs the background pass: only `calculate_now` / `calculate_sheet` run off the main thread;
* the shape is identical both times — a pass logged on `ThreadId(1)` (i.e. the main thread, so
  `save_file`'s calculate-before-save), then two file-status commands, then a full digest that never
  returns;
* it appears under the shrink replays, which run the save/reload oracle at EVERY checkpoint, and only
  late in a long walk.

**A hypothesis was formed and then REFUTED rather than assumed.** `ProgressEmitter::tick()` and
`finish()` emit to the WebView from inside the region that holds both grid locks — the pass's own
comment says so ("`pending_recalc` is a LEAF mutex … so taking it here, while the grid locks are still
held, cannot deadlock"). A WebView2 emit is main-thread-affine, so pass-holds-locks-and-waits-for-main
while main-waits-for-locks is a complete cycle, and it would only close once a pass runs longer than
the 100 ms progress interval — which is exactly "late in a long walk". A targeted journey spec was
written to force that interleaving (4 000 formula rows, `calculate_now` fired without awaiting, then a
synchronous digest 120 ms later, raced against a 45 s timer):
`app/e2e/journeys/calc-progress-deadlock.spec.ts`. **It passed.** The hypothesis is not proven and the
spec stays as a regression test for the shape it does cover.

**What was built instead of a guess: an instrument.** The digest now announces the phase it is in
(twelve of them, one per lock group) and a watchdog thread logs the last phase reached if the call has
not returned in 30 s:

> `DIGEST|STUCK: the workbook digest has not returned in 30s. Last phase reached: 5: pivots. …`

It costs one relaxed atomic store per phase and one thread per digest, in a test-only oracle command.
It does not fix anything. It converts "the app is wedged and nobody knows why" — which has now cost
three passes — into a line naming the section, which is the difference between a defect that can be
fixed and one that keeps coming back as flake.

**Next pass: run the fresh seed, wait for the STUCK line, fix the lock it names.**

#### 6. A NEW FINDING from the fresh seed, reproduced twice: undo does not restore a table's AutoFilter link

Soak `SOAK_SEED=1786446166374` (fresh; chosen as `Date.now()` at the start of the pass and recorded)
failed the undo round-trip oracle at step 125, **and failed identically on a second run**:

> `Undoing 22 steps did not restore the checkpoint state. 1 differences; first:`
> `tables.<id>.autoFilterId: "<filter id>" -> "<absent>"`

The cause is in the register already, one section over. `Table.auto_filter_id` is DERIVED state, not
persisted, recomputed by `relink_autofilter_owner` "wherever the sheet's filter is created, replaced
or removed" — and an UNDO does all three. `apply_object_restore`'s `obj_autofilter` arm writes
`state.auto_filters` and its `obj_table` arm writes `state.tables`, and neither re-derives ownership.
So an undo that puts a filter back leaves every table on that sheet claiming nothing, and the table's
own filter button stops being the filter's owner.

This is the §3bt class (a dependent's back-reference that one path maintains and another does not),
on a store that is DERIVED rather than owned. It is filed here rather than fixed because fixing it
before the minimiser had reduced it would have destroyed the only real failure available for
requirement 4 of this brief.

#### 7. The proofs the brief asked for

| proof | result |
|---|---|
| **§3bm live** — `=SEQUENCE(n)`, real F9 keystroke, grow AND shrink, spill map read back | **PASS**. `1,2,3,4` after the grow with the map at B1:B4; `1,2,"",""` after the shrink with the map back at B1:B2. A non-array CONTROL (`=A1*10`) moves either side, and manual mode is asserted to really be manual first |
| **§3bm live** — a blocked array through the calculate-before-save pass | **PASS**. `#SPILL!` survives the save, the blocker's own text survives, and the error pane still names `D1` after a reload |
| **an array saved is an array reopened** | **PASS**, and STRENGTHENED here: after save+reopen the four cells paint `1,2,3,4`, `get_spill_ranges` claims exactly B1:B4, the ORIGIN carries the `SEQUENCE` formula and a spilled cell does NOT — an archive of four independent formulas would paint identically and is now excluded |
| **§3bf live** — `=SUM(B1#)` | **PASS**. Stored form keeps the `#`; the value follows 6 → 15 → 3 through edits, answers 10 through F9, and comes back reading the reopened array |
| **§3bn live** — delete a table with a slicer, through the Table extension's own `deleteTableAsync` | **PASS**. Backend slicers 0, extension cache 0, **floating grid regions 0**, and no `not found` / `Failed to get items` in the console |
| **§3bt second pair** — Convert to Range | **PASS**. Cascades, KEEPS the data (`Apple`/`10` still painted), gives the overlay rectangle back, and ONE Ctrl+Z restores table + slicer together |
| **teeth on the §3bm fix** | **BITES**. With `apply_spill_decision` replaced by `to_cell_value()` in the pass, saving a blocked array writes **`1`** — "the calculate-before-save pass collapsed a blocked array to a plausible number". 4 tests fail. Restored and verified: `calculation.rs` sha256 `f583d002…`, no `CALCULA_TEETH` residue |
| **soak 20260810** (previously closed) | **PASS**, twice — 150 actions, 6 oracle checkpoints, 128 s / 123 s |
| **soak fresh seed 1786446166374** | **FAILED** twice out of two (the autoFilterId finding above), and **passes 150/150** with the fix |
| **invariant 1786396152029** | **2 passed** (1.9 m) |
| **invariant fresh seed 1786456498740** | **2 passed** (1.8 m) |
| **journey** | **121 passed / 2 failed / 1 skipped / 5 did not run** of 129 (23.6 m). BOTH of the baseline's known failures are gone. The two new ones were diagnosed and fixed in this pass — see below — and the file they live in passes 7/7 afterwards |
| **macro** (`--project=functional --grep "[Mm]acro"`) | **26 passed / 1 failed** (6.3 m) |
| **functional** | **509 passed / 34 failed / 11 skipped** (38.2 m) — every failure a screenshot, all one cause, see §7 |
| **visual** | 18/18 against re-recorded goldens; **16/18** on an independent cold re-run |
| **scenario** | wedged (see §5) |

**The two journey failures, both real and both fixed:**

* `reload-integrity` TEETH — a v7 archive with its extent stripped now opens with `#SPILL!` in the
  origin instead of `1`. That is §3bs arriving: the load path's recalculation SPILLS now, so an origin
  that cannot own its footprint says so at LOAD rather than at the first edit. The teeth are sharper,
  not blunter, and the assertion was rewritten with the reasoning rather than quietly relaxed.
* `remaining-correctness` §2l — "the headings must be painted to begin with" measured 0.0031 against a
  `> 0.005` gate. The probe's ink cut-off was 120 and `theme.headerText` is `#666666`; through the
  pinned sRGB capture the anti-aliased glyphs land just above it. Re-tuned to 170 BY MEASUREMENT
  (0.0083 with the headings on, ~0 with them off), not by loosening until green.

#### 8. EVERY SCREENSHOT GOLDEN IN THE TREE WAS CAPTURED THROUGH THE DISPLAY'S COLOUR PROFILE

34 functional + 18 visual + 3 scenario tests failed at once, hours after the same suites had been
green on the same machine, with a uniform per-channel delta. It is not a product change and it is not
this pass's Rust:

```
StatusBar.tsx      backgroundColor: "#217346"   = rgb( 33,115, 70)
capture today                                     rgb( 33,115, 70)   <- the source, exactly
every committed golden                            rgb( 63,112, 75)
```

The goldens encode a transform that belongs to the MONITOR. `--force-color-profile=sRGB` is now set
in both launch paths (`global-setup.ts` and `scratchpad/launch-vba-batch.ps1`) so a capture is a
function of the page and nothing else.

**The visual goldens were re-recorded under the pin and then VERIFIED ON AN INDEPENDENT COLD APP:
16 of 18 hold. The other two do not**, and that is a second finding: `grid with data` and `cell
selection highlight` differ between two runs of the same suite — a formula's repaint races the
capture. They are recorded but unstable; they are not evidence of anything until that race is fixed.

**The functional goldens were NOT re-recorded.** §3ar's rule is that they are recorded in a cold, full,
ordered `--project=functional` run, which is 40 minutes, and verifying it needs a second — more than
this pass had left. Recording without verifying is how a golden becomes the next pass's mystery.

#### 9. What the minimiser did on a REAL failure, and where it stopped

The brief asked for the minimiser to be exercised on a real defect rather than a planted one. It was:
the autoFilterId failure above, 125 actions, in-spec ddmin with the save/reload oracle at every
replay. It got through 8 replays — 125 → a 62-action subset that PASSED, a 63-action subset that
FAILED, then three 93-action and two 109-action probes — before **the app deadlocked underneath it**
and every later replay hit a dead page. The bundle it wrote is complete and replayable
(`app/e2e/results/soak/failures/2026-08-11T11-04-38-483Z-soak-undo-round-trip/`: trace, failure.json
with the exact replay command, diagnostics, the app-log tail).

So: the minimiser reduces a real failure and the bundle is usable, and it cannot finish while §5 is
open. That is the honest state — no reduced repro is quoted here because none was confirmed.

#### 10. One macro test fails and is NOT diagnosed

`macro-link-model` 1 — "a button runs the CURRENT macro after it is edited (link, not copy)".
Deterministic, 2 runs of 2. The button runs the ORIGINAL macro correctly; after the macro is EDITED
IN PLACE and saved, the same button writes nothing at all within 45 s (expected `28282`, got `""`).
The baseline was 27/27. It is not attributed — it was found late and every remaining minute went to
§5. The shape to check first is the editor's Save path against §3bt's
"delete script -> capability grants revoked" cascade: if Save is delete+recreate, a revoked grant
would produce exactly this silence.


#### 11. Numbers, and the state this pass leaves behind

`app-lib` **1,467 / 0 / 5 ignored** (1,464 on arrival with THREE red; +3 new census tests) ·
core workspace **1,337 / 0** (script-engine's 111 included) · `cargo check --all-targets` **0
warnings** · the crate-wide grid-lock scan reports **0** inverted holders.

**Two changes made in this pass were REVERTED after being tested and exonerated**, and the reverts
are the point: when the scenario suite began wedging, the two candidates were this pass's own — the
undo relink and the progress-emitter hand-off. Each was reverted in turn and the wedge SURVIVED both,
so neither is the cause. The relink was then restored, because it is proved (seed 1786446166374 fails
2/2 without it and passes 150/150 with it). **The emitter hand-off is left OUT**: it is a good idea on
its own terms — emitting to a main-thread-affine WebView while holding two global write locks is
wrong regardless — but it is unproven, and an unproven change to a locking path is not what a pass
should leave behind when the app is wedging. The reasoning is written up in §5 so the next pass can
apply it deliberately.

**The app is left running on CDP 9222 and answering.**

---

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


### D9. Should Calcula offer the 1904 date system as a setting of its own? — **OPEN, product call**

S10's import half is fixed (§2ao): a 1904 workbook now imports correctly. What Calcula does NOT have
is a date system of its own — every workbook is 1900, and `File ▸ Options` has no switch.

**Recommendation: do not add one.** The reasons, in the order they matter:

1. **The 1904 system exists to paper over a bug Calcula does not have.** Its whole purpose in 1985
   was to avoid Lotus's fictitious 1900-02-29 on the Mac. Both systems are legacy; Microsoft's own
   guidance is to leave the default alone.
2. **It is the classic silent-corruption switch.** Excel's own documentation warns that copying
   dates between workbooks with different date systems shifts them by four years, and that toggling
   the setting on a workbook full of dates changes what every one of them means. A setting whose
   failure mode is "all your dates are now wrong and nothing said so" is exactly what this register
   spends its time removing.
3. **Round-trip fidelity does not need it.** A 1904 file is read correctly and written back as 1900
   with the attribute omitted. The only thing lost is the FLAG, and the flag carries no user intent
   worth preserving — nobody chooses 1904, they inherit it.

**What would change the answer:** a user who must hand a file back to a Mac-authored process that
asserts on `date1904="1"`. That is a WRITE-side concern (emit the flag and shift on export), not a
setting, and it should be built as an export option if it is ever asked for.


## Suggested order

**Rewritten 2026-08-08 (fourth and final time, at the close of the correctness program).** Restated
from the sections rather than amended, for the reason the first rewrite gave: a to-do list that
outlives its items stops being read.

**The silently-wrong-answer tier is NOT empty. §2x closed on 2026-08-10 and was then proved live —
and proving it live turned up §2y, a defect in one document with no File ▸ Open in it. The way the tier
refilled twice between 2026-08-09 and now is recorded as the SEVENTH and EIGHTH CORRECTIONS below —
read those before trusting any sentence in this section, because every version of the emptiness claim
so far has been falsified within a day.**

**NINTH CORRECTION, later on 2026-08-10.** It refilled again, and this time from a direction the
eight corrections above never looked: not "does a mutation reach the file", but **"does opening the
file put the derived state back"**. §2z (slicer computed properties restored and dead) and §2aa (a
subscribed report with no path back to its model) are both FIXED, and **§2ab is now FIXED too
(§3be)** — but read §3be before this paragraph, because the fix it took is the OPPOSITE of the one
this register recommended twice. What was true here: after any reload a workbook's dynamic arrays
had **no spill protection at all**, a spilled cell could be typed over, and touching the array
formula turned it into `#VALUE!` — and §2y's own text asserted the opposite, having read the right
observation off the wrong cause. What was wrong: the proposed remedy, "stop persisting spilled cells
and recompute on load", rested on an unverified claim about Excel. Excel persists the spilled cells
AND the array's extent, and recomputes neither; `.cala` now does the same. The technique
that found all three is worth more than the three: read a restore function **next to its sibling**.
Both look correct alone; the asymmetry is only visible in the pair. §2z carries the full sweep of
twelve pieces of derived state, ten of which turned out fine.

**TENTH CORRECTION, later still on 2026-08-10.** It refilled a fourth time, and the eleven findings that
did it were filed by a READ-ONLY hunt that had run nothing. Nine of the ten it filed reproduced (F9 had
already been fixed by the §2y pass mid-read). The tier's contents were, in severity order: a renderer
that dropped parentheses so `=(A1+B1)*C1` came back from disk computing 21 instead of 30; an evaluator
that resolved an unknown sheet to the formula's OWN sheet instead of `#REF!`; cross-sheet dependency
maps that nothing re-keyed when a sheet was renamed, moved or deleted; and defined names that no sheet
operation touched at all. All are FIXED, each with a test made to fail first.

**But the two worst were not on the hunt's list, and the way they were found is the transferable part.**
The hunt named the right ROOT — "two AST-to-text serialisers and no round-trip test" — and then proposed
testing the property. Comparing the two implementations against each other instead found that one of
them ended in `other => format!("{:?}", other)`: **47 built-in functions, `CELL` and `FORECAST` and
`STDEV.S` among them, rendered to text that is not their name and re-parsed as unknown user functions.**
Renaming any sheet ran every formula in the workbook through it. The same seam then gave up a second:
the repair read the DISPLAY form of each formula, so **renaming any sheet also destroyed every
named-LAMBDA call**, including on sheets the rename never mentioned. Neither is exotic; both are one
`grep` away from the finding that was filed. The lesson to carry: when a hunt identifies a duplicated
representation, DIFF the duplicates before writing a property test over them — the drift is the defect,
and it is already enumerable.

**The count is not the point, but it is the evidence:** the recalculation census has now been widened
three times (delegating helpers, comments-are-not-code, free-functions-only) and this is the fourth —
direct `grid.cells` writes — and the fourth widening immediately surfaced `delete_sheet`, which turned
formulas into `#REF!` across the workbook and recalculated nothing. A census that has been wrong four
times about its own scope should be assumed to be wrong a fifth.

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

0. ~~**§2y — deleting the ORIGIN of a spilled array leaves the spill map behind.**~~
   **CLOSED 2026-08-10.** And the filed two-part fix was HALF WRONG, which is the entry's own lesson
   recurring: part (a) said to record each cleared spill cell for undo, and doing that would have made
   Ctrl+Z land on `#VALUE!` instead of the array, because `apply_changes` restores every recorded cell
   BEFORE it recalculates and the restored literals then block the re-spill. Spilled cells are DERIVED
   state and get no undo entry; undo restores the ORIGIN and the cascade re-spills it. Part (b) was
   right but had to become an explicit `SpillOriginPolicy` — applied unconditionally it lets a SORT
   swallow an origin and shuffle values no formula owns.
   **And the fix does not live in `clear_range`.** Enumerating the siblings, as the entry asked, found
   `clear_range` was one of ELEVEN writers that could orphan the map — and a twelfth was `update_cell`
   itself, which leaked whenever the replacement was a literal or an unparseable formula, and which
   evaluated a replacement formula against the array it was destroying (`=A2*10` stored 20 where a
   reload produces 0 — an order-dependent value from one keystroke). So the tear-down moved to a CHOKE
   POINT, `recalc_after_active_sheet_bulk_rewrite`, where a seed that no longer holds a formula releases
   whatever it owned; that covers the Delete key, Clear Contents, sort, undo AND redo without touching
   `undo_commands.rs`. Seven commands that could reach a spilled cell with no guard at all now refuse.
   The class is checkable at both ends: a crate-wide spill census (MAINTAIN / REFUSE / EXEMPT-with-a-
   reason, with the recalculation census's sabotage tests and delegating-helper modelling) plus a
   wiring test that a call site taking the origin exemption actually releases. 30 tests in
   `commands/spill_map_tests.rs`. The residual was §2ab, now CLOSED by §3be — the map is restored
   from the file rather than rebuilt, so a reopened array is owned before anything touches it. §2y.

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
   ~~**`ribbon-tabs`' own golden is now RECORDABLE (§3az(3)).**~~ **IT WAS NOT — see §3br**, which
   opened the app and looked. §3az(3)'s hardening (grid masked, selection pinned, undo pinned) is
   real and was MEASURED to work: `ribbon-minimized` survives `charts` + `pivot` residue on which
   three of its own siblings fail. But the window frame also contains the FORMULA BAR, so it
   photographs the CONTENT of the pinned cell — and the first recording attempt froze `W1 = "Bold"`,
   written by the last test in the same file. Content is pinned now (`X9` = `ribbon-pin`).
   **STILL REFUSED**, on one remaining, nameable question: `flagged-defects` and
   `hidden-rows-persistence` both run earlier and both `add_sheet` without deleting, and the
   SHEET-TAB STRIP is in frame. Settle that in a cold full ordered functional run — look at the strip
   first, then record — which §3bq is why this pass could not do.
   Note the new coupling while you are there: every ribbon golden now photographs Undo/Redo
   ENABLEMENT (§2ac), so a capture taken after a spec that ran `new_file` differs from one taken
   mid-suite.

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
