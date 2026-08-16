# Open items — the live list

**This is the authoritative list of what is currently open.** Verified against the code on
**2026-08-16**; every row cites the file and line that was actually opened and read. If a claim
here disagrees with a design document, this file wins — and if it disagrees with the code, the
code wins and this file is the defect.

**Where the history is.** `docs/design/open-decisions-2026-08.md` (1.33 MB, 39 sections) is the
narrative record of the correctness programme: what was decided, why, what was tried and rejected.
Its reasoning is its value and none of it has been moved or deleted. But it is a sequence of
**point-in-time observations**, and its own §35a measured the consequence: greping it for
"still open" returns a list roughly **one third stale in the already-fixed direction**, because a
pass that fixes a defect writes its own section and does not go back and strike the three earlier
paragraphs that called it open. Read it for the WHY. Read this file for the WHAT.

**Scope of this list.** Product and test-infrastructure items only. Individual defects with a
reproduction live in `tests/regression/bug-ledger.json` (**97 entries, 94 fixed, 3 open** as of
2026-08-16: BUG-0095, BUG-0096, BUG-0097 — all filed 2026-08-16 by the documentation audit, all
severity low). Nothing in this file duplicates a ledger entry.

---

## 1. Owner calls — decisions, not work

These need a product judgement before anyone writes code. Each is small to implement and
consequential to get wrong, which is why none of them has been decided under cover of another fix.

### 1.1 Currency negatives: parentheses or a leading minus

`format_currency` wraps every negative in parentheses unconditionally —
`core/engine/src/number_format.rs:137` is `format!("({})", with_symbol)` with no format-section
test. Excel's single-section `$#,##0.00` renders a negative with a **leading minus**; parentheses
are what Excel's *fourth* preset means.

Why it is an owner call and not a patch: the function is shared with the **Format Cells currency
presets**, so changing it changes the dialog's presets too, and it moves visual goldens. Recorded
in §25g and confirmed still open by §35c.

### 1.2 The 1904 date system as a user setting (D9)

**Standing recommendation: add none.** Import already handles it — `xlsx_reader.rs:147`
(`converts_from_1904`) moves a 1904-epoch serial onto Calcula's 1900 epoch at read, per
`<workbookPr date1904="1">` (`xlsx_reader.rs:192-194`). There is no `date1904` symbol anywhere in
`app/src-tauri/src`, so the app has no setting and stores no such flag. The question is whether to
offer one as a document setting for parity with Excel's Mac lineage. Full argument in §4 D9.

### 1.3 OS regional settings on the `"system"` locale path

Excel reads Windows' actual regional settings (`GetLocaleInfoEx`: `LOCALE_SSHORTDATE`,
`SLONGDATE`, `STIMEFORMAT`, `SCURRENCY`), so a user who customises their short date to
`dd-MMM-yy` sees that in Excel. Calcula uses a **fixed per-locale-id table**. "As similar to Excel
as possible" argues for reading the OS on the `"system"` path with the table as the fallback for
explicit overrides. Not prejudged: the field names already added (`longDateFormat`, `timeFormat`)
are the same either way. §25g.

### 1.4 Same-sheet undo does not move the selection

A cross-sheet undo switches sheets and selects the restored range; a **same-sheet** undo leaves
the cursor where it was. Excel selects the restored range in both cases. The change is a one-line
widening of the `switched &&` guard — but it moves the cursor on **every Ctrl+Z**, and several E2E
journeys assert cursor position. Owner call precisely because the implementation is trivial and
the blast radius is not. §13f.

### 1.5 An empty cell reads as the number zero in every context

`core/engine/src/evaluator.rs:1117` is literally `CellValue::Empty => EvalResult::Number(0.0)`,
and `EvalResult` (`evaluator.rs:209-223`) has **no `Empty` variant** to route to —
`Number`/`Text`/`Boolean`/`Error`/`Array`/`List`/`Dict`/`Lambda`. Excel's rule is three-way: blank
is `0` in arithmetic, `""` in concatenation, and **ignored** by the counting functions.

This is engineering rather than a product judgement — the target behaviour is not in doubt — but
it needs a **go-ahead on scope**, because expressing it means a new variant threaded through every
arm of the evaluator. Filed as a project, correctly. §2aq, re-confirmed §35c.

### 1.6 Policy-refused inline payloads still reach the decoder on the `.calp` pull path

BUG-0086 split media refusals into two outcomes (`MediaError::is_decode_hazard`, exhaustive match
so a new variant is a compile error): **hazards** (`TooLarge`, `DimensionOutOfRange`,
`TooManyPixels`) are cleared to `""`, **policy refusals** (`SvgRefused`, `BmpRefused`,
`UnknownFormat`, `MalformedHeader`, `Empty`) are left inline and still render. That split is
deliberate and right — destroying a picture because a later build narrowed the allowlist is the
worse failure.

The residual is that on the **pull** path the policy payload has no size bound at all.
`materialize_saved_controls` (`app/src-tauri/src/controls.rs:175-202`) is a plain
`controls.insert` loop: no length check, no media judgement, no `MAX_CONTROL_PROPERTY_CHARS`. The
64 KiB property bound applies to the two property commands, not to a pull. An `<img>` will not run
an SVG's script, which is why this was judged tolerable rather than closed — but it is a judgement,
so it is flagged rather than silently accepted. §36d.

---

## 2. Engineering residuals — no owner input needed

Each is scoped, understood, and deliberately not done. They need a slot, not a decision.

### 2.1 Product / engine

| item | verified at |
|---|---|
| **Excel's array literal `{1;2;3}` does not parse.** The lexer has no `;` arm at all — `;` falls through to `Token::Illegal(ch)` (`core/parser/src/lexer.rs:76`), and `parser.rs:526/566` treats `{…}` as a Python-style `ListLiteral`. `{1,2,3}` parses, but as a list, not a 1x3 array. | `lexer.rs:76`, `parser.rs:526,566` |
| **`#NULL!` is never produced.** `rg CellError::Null core` returns exactly three hits, all in `cell.rs`: the variant (`:78`), `as_literal` (`:164`), `from_literal` (`:189`). It round-trips an imported `#NULL!` faithfully and the evaluator never raises one. Its sibling `Num` carries a doc comment saying "the evaluator PRODUCES this now" (`cell.rs:82`) — `Null` has no such line, which is the difference. | `core/engine/src/cell.rs:78,164,189` |
| **`set_active_sheet` accepts a hidden sheet index.** Worth stating carefully, because it now *looks* guarded: `activate_sheet` does call `ensure_user_sheet` (`sheets.rs:917`), but that guard tests `is_user_sheet` (`sheets.rs:144-149`), which refuses **only** `OBJECT_SHEET_VISIBILITY` — floating-range backing sheets. A user-hidden sheet (`"hidden"`) passes straight through. Excel's `Activate` errors on a hidden sheet. Not tightened because scripts and E2E specs use it to reach hidden sheets. | `sheets.rs:144-168,917` |
| **`default_row_height` / `default_column_width` announce no undo domain.** Both registered with `domains: NONE` (`undo_commands.rs:1579-1580`) and the registry test pins it (`:4530-4531`), so undoing either notifies nothing that needs to repaint. | `app/src-tauri/src/undo_commands.rs:1579,1580,4530` |

### 2.2 The `Persisted<T>` migration is not finished

`AppState` has **104 fields**: **59** are `Persisted<T>`, **43** are still a bare
`Mutex`/`RwLock`, and 2 are unlocked (`undo_stack`, `calc_cancel`). Only the `Persisted<T>` ones
force a command to name a `DocumentEffect`, so a command touching only the remaining 43 can still
mutate without deciding — which is the exact hole `DocumentEffect` was built to close.

The 43 are **overwhelmingly derived caches** (the dependency maps, the spill maps, `id_registry`,
`gather_cache`), which is why this is a work item rather than a data-loss risk. But "overwhelmingly"
is not "entirely", so **check the field before assuming it**, and declare any NEW persisted store
`Persisted<T>` from the start.

**Count the fields, not one grep spelling.** This number has been published three times as three
different values (36, 51, 59), because `rg 'document_effect::Persisted<'` returns 51 and misses the
8 fields spelled `crate::document_effect::Persisted<`. 59 + 43 + 2 = 104 reconciles; nothing else
does.

### 2.3 Import fidelity

**S7 — calamine expands only 1-D shared formulas.** An upstream limitation of the
`calamine = "0.26"` dependency (`core/persistence/Cargo.toml:11`); `core/persistence/src/xlsx_reader.rs`
carries no shared-formula expansion of its own to work around it. Still open, still without a
reproduction fixture — which is the first thing anyone picking it up should build. §7142, §35c.

### 2.4 Test infrastructure

| item | verified at |
|---|---|
| **The soak walker's formula alphabet is six formulas.** `FORMULAS` is exactly `SUM`, `&`, `IF`, `AVERAGE`, `COUNT`, `MAX` (`e2e/walker/actionCatalog.ts:129-136`). Widening it changes what the committed seeds mean, so it belongs to a pass that can re-baseline them. | `actionCatalog.ts:129-136` |
| **Only charts are re-synced after the walker's `new_file`.** `deepResetForWalk` calls `resyncChartStoreToBackend` and nothing equivalent for sparklines, slicers or pane controls, which sit on the same fan-out (`e2e/walker/reset.ts:242,281`). The chart case is the one BUG-0075 photographed; the others are the same shape, unphotographed. | `e2e/walker/reset.ts:242,281` |
| **The two `evaluate-formula` goldens assert residue, not their feature.** `grid-evaluate-formula-init` and `-constant` are whole-grid captures of a spec whose subject is off-screen until its own `navigateTo`, so they photograph whatever the preceding specs left on rows 1-26. Stable now, but they are layout assertions wearing a feature's name. Turning them into region captures of the AI column is a golden change owned by that spec. | `e2e/tests/__screenshots__/evaluate-formula.spec.ts/`, §30f |
| **The journey project has no side-panel residue guard.** `zz-workbook-residue.spec.ts` exists under `e2e/tests` (functional) and has **no counterpart** under `e2e/journeys` — confirmed by listing both directories. An open side panel left by a journey spec is invisible to that project, which is how a run once lost 10 tests behind a 1218 -> 898 px canvas. | `e2e/tests/zz-workbook-residue.spec.ts` exists; `e2e/journeys/` has none |
| **Completed Playwright runs leave orphaned process trees.** After every project reported exit 0, five node processes plus an `app.exe` were still driving the application minutes later, and the next launch failed on port 5173. Recorded rather than filed because the zero-gap invocation pattern was introduced by the pass that saw it — but the regression runner also drives projects back to back. Cheapest mitigations, in order: a settle gap plus a "no `app.exe`, nothing on 9222 or 5173" precondition between projects, and a teardown that verifies the tree it killed is gone rather than trusting `taskkill /T`. | §39g |

### 2.5 The startup gap that no gate covers

**Nothing in the tree proves the app can be linked at all.** Verified against CI, not inferred:
`.github/workflows/ci.yml` runs `npm run check-types`, `npm test`, and — in a job whose
`working-directory` is `core` — `cargo test --workspace` and `cargo check --workspace --benches`
(`ci.yml:50-72`). `cargo check` does not link; `cargo test --lib` links a **test executable**, not
the `app_lib.dll` the app loads; and no workflow builds the app crate at all (`npm run tauri build`
appears only in `release.yml:79`, which runs on a release tag). Four tracks changed Rust in the week
before this was noticed and the first thing to exercise the link was the E2E launcher, which failed
with ~40 `LNK2001` errors. §39d.

**Related and still true: a pre-React failure shows a blank window with no message.** `app/index.html`
is an empty `<div id="root"></div>` and a module script — no fallback markup, no `window.onerror`.
`RootErrorBoundary` (BUG-0083) catches throws *after* React mounts; a module-resolution failure, a
syntax error, or the Vite dep-optimizer 504 of §37c happens before there is a boundary to catch it.
The E2E startup guard can now *detect* that state and fail the run; the **product** still shows the
user nothing.

---

## 3. How to keep this file honest

1. **Close items here, in place**, when they are fixed — do not rely on a later section of the
   archive to imply it. The archive's failure mode was never false reports; it was stale anchors.
2. **Every row carries a `file:line`.** A row that cannot cite one is a rumour and belongs in the
   ledger with a reproduction, or nowhere.
3. **Both staleness directions are defects.** A row claiming something is broken that now works
   sends the next reader to re-fix working code; that is the direction that cost this project the
   most, not the other one.
4. **Re-verify before restating.** Of the items handed to the 2026-08-16 audit as open, one —
   `set_active_sheet` accepting a hidden index — very nearly read as fixed because a guard with the
   right shape had been added for a different reason. Open the file.
