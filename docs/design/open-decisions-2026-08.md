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

**One thing to watch that was NOT run here:** the E2E projects (journey / visual / scenario / macro)
were out of scope for a frontend-only pass. The `name` row is now first in the shape Properties
pane's "Shape" group; no committed golden creates a shape, so no visual impact is expected, but that
is reasoned rather than measured.

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
- `clear_range` performs no dependent recalculation at all — not even same-sheet. Same class as
  the sort defect above; not fixed because it was outside this pass.

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

**Still open, same area, deliberately not taken here:**

- `CustomRestore` kinds that write ACTIVE-sheet cells but report no coordinates — `report_restore`
  and `calp_reset` — get no cascade. Both are whole-region/whole-sheet swaps carrying cached
  values, so their own sheet is right; what stays stale is another sheet's formula reading into
  them. Closing it means each restore fn reporting the cells it touched, which is a signature
  change across the registry.
- Undoing a NAMED-RANGE definition (`obj_named_ranges`) does not recalculate the formulas that
  resolve through it. Not a cell-dependent problem — it needs a whole-workbook recalc trigger.
- `SetCell` carries no sheet dimension, so undo always applies to whatever sheet is active. Undo
  after a sheet switch was already wrong and still is; the cascade follows the restore rather than
  papering over it.

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

**Still open (needs Rust):** undo/redo does not refresh these four. `MUTATION_REFRESH` domains
come from Rust undo-result flags, so this needs new flags plus the `MutationDomain` union and the
shell translator. Pre-existing — `DATA_CHANGED` was never emitted on undo either.

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

**Still open:**

- **The app hard-crashed twice** during visual workflow specs (`app.exe` exit `0xffffffff`, no
  panic in the tauri log). Not reproduced deliberately; worth knowing it happens.
- **Vertical expansion of the inline editor** (above) — needs the input-to-textarea change.

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

## 3. Test-infrastructure decisions

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

### 3b. Shared-workbook contamination between specs

The functional specs share one accumulating workbook, and `resetGrid` clears only `A1:Z1000`, so
screenshot goldens encode prior specs' residue and are only valid for the exact ordered cold pass
that recorded them. Specs that wipe and reopen the document now live in a separate `journey`
project for this reason. **The macro debugger specs are additionally not robust to a long-lived
app instance** — 10 failures contaminated versus 60/60 cold.

Deciding to make specs self-contained would cost a pass but would end a recurring class of
false signal.

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
   work item 6 below describes**, and it should shrink as those stores are onboarded rather than
   being swept as a cleanup of its own.

**Performance, verified by reading rather than asserted.** `Persisted<T>` is `{ inner: Mutex<T> }`.
`read()`, `write(&effect)` and `lock_pending()` are each one `Mutex::lock` plus a newtype wrap;
`write` binds its effect as `_effect` and ignores it; `authorize()` moves the `MutexGuard` and
never releases it. All three guards are newtypes over `MutexGuard` whose `Deref`/`DerefMut` return
a borrow. **There is no clone, no allocation and no second lock anywhere on the write path** — the
per-keystroke regression the typing change could plausibly have introduced does not exist.

**Residual, stated plainly.** The guarantee now covers the grid and the 46 onboarded stores. Other
persisted `AppState` fields are still bare `Mutex`es (`sheet_names`, `active_sheet`,
`style_registry`, `column_widths` / `row_heights` and their `all_*` companions,
`merged_regions` / `all_merged_regions`, `user_hidden_rows` / `user_hidden_cols`, `sheet_zooms`,
`split_configs`, `auto_filters`, `sheet_protection`, `sheet_ids`). A command touching only those can
still mutate without deciding. The FLAG's sole-writer guarantee is complete; the STORE coverage is
not, and the same mechanical recipe applies to each.

---

## Suggested order

2b, 2c, 2d, 2e, 2f, 2g (four of five), 2i and 3c are all done (2026-08-07). **The golden item that
stood at the head of this list is closed** — see immediately below. What remains, in order:

0. ~~**Re-record the four known-stale goldens**~~ — **DONE / N-A 2026-08-07, and the triage
   changed the answer.** Each was checked before being touched, per the rule that an unattributable
   diff is a possible regression:
   - The **three `comments-notes` goldens were already current** and were NOT re-recorded. They
     pass 7/7 on a cold functional run against HEAD; they had been re-recorded together with the
     `announceAnnotationsChanged` addition to the spec, which §2d's prediction predates. Detail and
     the decoding trap that made them look empty are in §2d.
   - **`scenario-budget-model-title.png` was stale and IS re-recorded**, from the actual frame of an
     ordered `--project=scenario` pass (not `--update-snapshots`, so no sibling golden was touched).
     The diff is entirely chrome and geometry from dated changes: the 2026-07-30 ribbon SVG icon set,
     the 2026-07-20 point-size/row-height geometry — and two the earlier triage had not named, the
     top-level **Model** menu (order 44) and the **Filters -> Controls** ribbon-tab rename, both of
     which also postdate the 2026-06-11 recording. **Every cell value is identical across the two
     frames, including the BUG-0019 numbers** (27300 / 27800 / -500, F3 = 27300), which is what makes
     it a chrome diff rather than a regression. `--project=scenario` went 22 passed / 1 failed /
     1 did not run -> **24 passed**.
1. **1a** shapes — cheap, unblocks report annotation.
2. **2a** — decide it either way; leaving 839 lines of unreachable code is the worst option.
3. `clear_range` recalculates nothing (§2c), cross-sheet cycles are undetected (§2c), and the
   three residual undo gaps listed at the end of §2i (`report_restore` / `calp_reset` report no
   coordinates, named-range undo triggers no recalc, `SetCell` has no sheet dimension).
4. **Vertical inline-editor expansion** (§2g) — the horizontal case shipped; multi-line entries
   still render on one line because the editor is an `<input>`. Needs an `<input>`-to-`<textarea>`
   swap plus caret/commit handling.
5. **`macro-live-edit` test 6** (§3y) — a pre-existing whitespace/EOL normalisation between the
   Monaco buffer and `save_script` that makes an untouched macro report phantom unsaved work.
   Small, self-contained, and it un-stales a baseline everything else is measured against.
6. ~~**1b pictures**~~ — **DONE 2026-08-07, all four halves.** Backend (ingress, storage, GC,
   `.calp`, migration), script host (`vSetState` key allowlist, `cap.fileImportMedia`,
   `api.createPicture`) and frontend (`insertImage` on `importImageViaPicker`, handle-resolving
   renderer, read-only `src`, `PictureControlProvider` registered, `AFTER_OPEN` reload) all shipped
   — plus **the existing corpus**, which the original proposal had not separated into its two
   halves: saved `.cala` files (migrate on load, now verified through a real file) and
   already-published SIGNED `.calp` packages (accept the legacy inline shape, migrate it at the
   package boundary, so no subscription breaks and no unvalidated binary reaches the subscriber's
   own `controls.json`).
   **E2E coverage is now closed too** (2026-08-07, a fifth half): `app/e2e/journeys/image-ingress.spec.ts`,
   7 tests, driving the real menu item and the real native picker. It was worth saying plainly that
   Insert > Image had never had an E2E test, which is part of why an ingress with no validation of
   any kind shipped and stayed — and the spec was verified to catch the original defect by
   reinstating it (the placeholder fallback reproduces as a `200x150` control at the anchor). See
   §1b for what it asserts and how attributability is guarded.
7. **The persisted `AppState` fields 3c did not reach** — `sheet_names`, `active_sheet`,
   `style_registry`, the width/height stores, `merged_regions`, `user_hidden_*`, `sheet_zooms`,
   `split_configs`, `auto_filters`, `sheet_protection`, `sheet_ids`. Same mechanical recipe as
   3c (`.lock()` -> `.read()`, then let the compiler list the mutating sites); each is smaller
   than the grid was.
