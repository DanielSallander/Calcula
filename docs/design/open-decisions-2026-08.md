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

### 1a. Shapes — create and delete (SMALL, recommend doing)

Manipulating an *existing* shape already works from scripts (`setProperty`, including `text`).
What is missing is creation and deletion, because `IControlStoreService`
(`app/src/api/componentStoreRegistry.ts:139`) is **list-only** — `listControls` returns identity
and anchor, nothing else.

**Proposal.** Widen it to a feature-neutral `@api/controlsService` seam with create/delete,
following the `buttonControlService` precedent established by the macro recorder. That precedent
exists for a hard-won reason: the recorder originally hand-rolled a button by writing control
properties directly, and it produced an *invisible* button — wrong property name, no geometry, no
floating-store registration — while the backend reported success. **One recipe must live in the
Controls extension**; a second copy drifts on the first default change.

Script surface: `api.createShape(catalogId, anchor, {width?, height?, text?, name?, sheet?})`
and `api.deleteShape(id)`.

**Risk: low.** No new file format, no new ingress, an established seam pattern.

### 1b. Pictures — needs a binary-ingress decision first (MEDIUM-LARGE)

Today **only text crosses the file picker** (`cap.fileImportText`). Pictures are the first binary
to enter the document, which touches the file format, the distribution package and the sandbox
boundary at once. Four sub-decisions, with recommendations:

**(i) How do bytes enter?** Recommend an **opaque, size-capped `dataRef` handle**: the picker
returns a reference, the image bytes never enter the script realm, and the script calls
`api.createPicture(dataRef, anchor)`. Reject base64-into-the-realm — a 5 MB logo becomes a 6.7 MB
string crossing IPC, and worse, it lets a script *synthesize* arbitrary binary content rather than
merely place a file the user chose.

**(ii) Where do the bytes live?** `.cala` is already a ZIP of structured JSON, so store images as
separate artifacts under `media/`, content-addressed by SHA-256 and referenced by id. That dedupes
a logo repeated on twenty sheets for free. Requires an explicit `format_version` bump (currently
**6**).

**(iii) What may a distributed package and a sandboxed script do?** These differ.
A published report must carry its logo — that is the point. But a *distributed script* introducing
new bytes is a different risk from one referencing bytes already in the document. Recommend:
**restricted-tier scripts may reference existing media, never introduce new bytes.** Introducing
requires the file picker plus user consent, i.e. the unlocked tier.

**(iv) Decode safety.** Image decoding is a classic attack surface. Recommend validating **magic
bytes, a hard size cap and a dimension cap in Rust**, then letting the **WebView do the actual
decode** — do *not* add an image-parsing crate to the privileged Rust process purely to validate.
Allowlist PNG/JPEG/GIF/WebP.

**Recommendation: ship 1a now; treat 1b as its own scoped change** with the above as its design
premise. It is the one remaining item whose value is driven by the product vision rather than by
VBA parity.

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

### 2a. Home-tab "Customize" entry point was deleted — DECISION NEEDED

The gear icon that opened Home-tab customisation was dropped during the sections/panel migration.
`HomeTabCustomizeDialog.tsx` (~839 lines) is **still registered and still listening** for its save
event, and `loadLayout` still runs at startup — so a previously saved layout still applies, but a
user can never change it again. Live, maintained, unreachable code.

Repair needs a new `PanelDefinition` field plus shell rendering (the shell cannot know about one
extension's dialog), and *where* the affordance belongs — ribbon gear, Home-tab context menu, View
menu — is a product call.

**Decide: restore an entry point, or delete the dialog deliberately.** Note that **8 visual
goldens currently encode its absence as correct**; restoring the gear will correctly turn them red.

### 2b. Pivot progress overlay never clears — ONE-LINE FIX, needs a yes

The backend emits its final `pivot:progress` immediately before returning
(`src-tauri/src/pivot/commands.rs:786`). Tauri events and command responses travel separate
channels, so that last event lands *after* pivot-api's `finally { clearLoading }` has run,
re-arming an indicator nothing will ever clear. The listener
(`app/extensions/Pivot/index.ts:1976`) calls `setLoading()` unconditionally.

Fix: guard it — `if (!isLoading(payload.pivotId)) return;`. Reproduced deterministically
(byte-identical across two cold runs, unchanged by a 6 s wait), not a race.

### 2c. Cross-sheet recalculation does not propagate (BUG-0019) — REAL, needs scheduling

Editing `Sheet1!C5` propagates to `C9`, but the chain `C9 -> Sheet2!B3 -> B4` never recalculates
in memory. Save-and-reload shows the *reloaded* values are the correct ones, which means the
persisted state is right and the in-memory dependency graph is wrong. Already documented in the
scenario spec with its assertions commented out. **This is a wrong-answer bug in a spreadsheet
and should probably outrank everything else on this page.**

### 2d. Selection chrome hides cell decorations

The active-cell highlight paints over the cell's top-right corner — exactly where the note/comment
indicator lives. Selecting a commented cell therefore hides its own indicator from the user.
Measured: 15 indicator pixels with the selection parked elsewhere, **0** with the cell selected.

### 2e. Backend mutations never reach the frontend for grouping, hyperlinks and tracing

Measured on the live app: `group_rows`, `add_hyperlink` and `trace_precedents` change **0 pixels**
until something else forces a refresh. Tables and annotations have refresh events; these three do
not. Same class: **backend-created validations and notes stay invisible to their extension's
frontend cache** — for validation that also means no painted chevron *and* an unsuppressed fill
handle overlapping it.

Consequence for testing: three visual assertions were deleted because no event exists to make
them meaningful.

### 2f. The dirty *indicator* lags the dirty *flag*

After a backend-only mutation the title bar shows no asterisk even though `is_file_modified` is
true. The safety net works; the ambient signal does not. Correct fix: **announce the clean->dirty
transition once from `DocumentEffect::mutates`**, never ask 355 commands to remember to emit an
event — that is precisely the failure mode the census existed to end.

### 2g. Smaller, verified, unowned

- **`Ctrl+Home` is intermittently swallowed** before reaching the grid (WebView2 level).
- **The Script Editor's macro `<select>` picks the wrong macro under load** — a `-sbfault-` id
  selected instead of `-sb-` during a 12-minute run.
- **The inline editor never expands over neighbouring cells**, so at the (now correct) 64.29 px
  default column width longer entries scroll instead of being visible. An Excel-parity gap that
  the geometry fix exposed rather than caused.
- **A truncated cell's underline is drawn wider than the ellipsised text.** Cosmetic.
- **The app hard-crashed twice** during visual workflow specs (`app.exe` exit `0xffffffff`, no
  panic in the tauri log). Not reproduced deliberately; worth knowing it happens.

---

## 3. Test-infrastructure decisions

### 3a. The full functional E2E suite is not green on HEAD

**490 passed / 33 failed.** Basic editing and scrolling specs are among the failures. Every
"64/64"-style number quoted during this program is a **subset** — the specs relevant to the change
under test — not whole-suite health. Someone should decide whether to drive that to green or
formally designate the maintained subset, because right now the number invites misreading.

### 3b. Shared-workbook contamination between specs

The functional specs share one accumulating workbook, and `resetGrid` clears only `A1:Z1000`, so
screenshot goldens encode prior specs' residue and are only valid for the exact ordered cold pass
that recorded them. Specs that wipe and reopen the document now live in a separate `journey`
project for this reason. **The macro debugger specs are additionally not robust to a long-lived
app instance** — 10 failures contaminated versus 60/60 cold.

Deciding to make specs self-contained would cost a pass but would end a recurring class of
false signal.

### 3c. `AppState.grids` is still a bare `Mutex`

Which is why `FileState::is_modified` cannot yet be made private with `DocumentEffect` as its sole
writer. Grid writes are gated at their commit helpers rather than by the type. **This is the
highest-value follow-on to the dirty-flag census** — it converts the remaining convention into a
compiler guarantee.

---

## Suggested order

1. **2c** (cross-sheet recalc) — a wrong-answer bug beats everything else here.
2. **2b** and **2f** — one-line and small, both user-visible.
3. **3c** — finishes the dirty-flag census properly.
4. **1a** shapes — cheap, unblocks report annotation.
5. **2a** — decide it either way; leaving 839 lines of unreachable code is the worst option.
6. **1b** pictures — as its own scoped change, on the ingress design above.
