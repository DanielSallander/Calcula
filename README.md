# Calcula

> An open-source spreadsheet engine with a microkernel core. As extensible as VS Code, as fast as Rust can make it.

**Status:** Active development. Core engine and most major features are working. Not yet production-released, but architecturally solid and growing fast.

---

## The Question

Excel may be the most successful "programming language" ever written. Hundreds of millions of people use it daily, and an enormous amount of the world's business logic lives inside `.xlsx` files.

But the spreadsheet itself, the engine, the grid, the formula model, has barely changed in three decades. It is closed and monolithic: you can script on top of it, but you cannot change what the engine itself *is* without a vendor's permission.

**What happens if we build one the other way around?**

Calcula is an attempt to answer that: a spreadsheet engine where the core knows nothing about formatting, pivot tables, or charts, and where every feature is an extension you can replace, rewrite, or rip out.

## Why Calcula Exists

Calcula was born from a specific frustration.

What made Excel beloved was not the grid -- it was the *customizability*. Formulas, VBA, add-ins: if you had a specific problem, you could build a specific solution, yourself, today. That power is what turned the spreadsheet into the most successful end-user programming environment in history.

Then the industry moved on. The center of gravity shifted to Power BI, and VBA became something to apologize for -- old, insecure, quietly deprecated in spirit. Power BI is a genuinely good tool, but it trades that power away: you are locked to the vendor's visuals and the vendor's data model. There is no escape hatch for the problem the vendor didn't anticipate. When you hit the wall, you don't build the feature -- you wait for Microsoft to ship it.

**Calcula exists to bring that customizability back.** A spreadsheet where the user is never stuck waiting on a roadmap, because the platform itself is programmable -- from formula functions to whole extensions to per-object scripts.

But going back to Excel's model wholesale would repeat its mistakes, because the criticisms of VBA are fair:

- **Security.** Macros run with the full power of the machine, which made them one of history's favorite malware vectors.
- **Opacity.** Custom code hides inside the file. Open someone else's workbook and you simply don't know where code lives, what it touches, or when it runs.

Calcula's scripting model is built against both failure modes -- and this is implemented, not aspirational. Scripts are TypeScript instead of VBA and run in hardened sandboxes (per-script Worker realms in the frontend, an isolated Rust interpreter for notebooks and one-off scripts). Anything privileged -- network access, model queries, storage, UI -- goes through a **capability broker** with declared ceilings, explicit user consent, and a per-workbook **audit trail** that records every script surface's activity and survives reload. Code arriving in distributed packages never runs without consent, packages and extensions are **Ed25519-signed**, and a transparency panel shows exactly where code resides and what it can touch. AI agents are governed the same way: the MCP server's workbook tools and the in-app AI chat run behind the same script-security consent gate, under a user-set **access ceiling** (read-only / read-write / scripts), and every AI-driven change -- cell writes, formatting, chart/table/pivot/name creation -- lands in the same audit trail. The same principle extends to the architecture itself: extensions get real power, but only through a narrow, typed, inspectable API.

And there is one more Excel weakness Calcula refuses to inherit: **distribution**. Sharing a workbook has always meant emailing a copy and losing control of it. Calcula's `.calp` package system replaces that with publish/subscribe report distribution -- and turns the channel two-way, so packages can also *collect* data from recipients through writeback. Both are described below.

## The Architecture

Calcula follows a strict microkernel design, heavily inspired by VS Code.

```
   +----------------------------------------------------+
   |                    Extensions                      |
   |   Formatting | Pivots | Charts | Conditional ...   |
   +----------------------------------------------------+
                            |
   +----------------------------------------------------+
   |       Shell (host: layout + extension loader)      |
   +----------------------------------------------------+
                            |
   +----------------------------------------------------+
   |        Extension API (the typed @api facade)       |
   +----------------------------------------------------+
                            |
   +----------------------------------------------------+
   |   Core: TS Face (grid render, selection, undo) +   |
   |   Rust Brain (formulas, dependency graph, recalc)  |
   +----------------------------------------------------+
```

- **Rust core.** Formula parsing, AST evaluation, dependency tracking, and recalc all live in a memory-safe Rust kernel. No JavaScript reaching into the calculation hot path.
- **Canvas frontend.** A TypeScript/React shell that renders the grid on HTML5 Canvas, so millions of rows scroll without choking the DOM.
- **Tauri bridge.** The two halves talk over Tauri IPC, keeping the install footprint small and the runtime fast.
- **Everything is an extension.** Bold text? Extension. Number formatting? Extension. Pivot tables? Extension. The core has zero opinions about presentation.
- **Layering is enforced.** `Core --> API --> Shell --> Extensions`. No shortcuts, no upward dependencies. The boundaries are real, not aspirational -- and lint-enforced in CI.

## Why Bother?

A few things become possible when the engine is open and modular:

- **New formula languages.** Want LAMBDA-style functional formulas, or something closer to DAX? Drop in a new evaluator extension.
- **Custom storage backends.** Stream cells from a database, a parquet file, or a remote API instead of loading a workbook into memory.
- **Domain-specific spreadsheets.** Financial modelers, scientists, and BI builders all want different things from a grid. A microkernel lets each community ship its own variant without forking the project.
- **Auditability.** Open code, open formula semantics, open dependency model. No more black-box recalc.

## Beyond the Spreadsheet

Calcula is not just an Excel clone. Several features have no equivalent in traditional spreadsheet software:

### Semantic Models and BI (the Model Editor)

Calcula ships its own in-process BI engine and a full in-app model designer -- the **Model Editor** -- so the Power BI workflow lives *inside* the spreadsheet instead of replacing it:

- **Model authoring**: tables, relationships, measures, calculated columns, calculated tables, perspectives -- edited visually or through a built-in **command-line panel** with a scriptable verb-object grammar and one-undo-step batch runs
- A **DAX-class expression language** for measures and queries, including calculation groups (modeled Power BI-style, as dimensions) and row-level **security contexts written as plain expressions** (with `USERNAME()` / `CUSTOMDATA()`)
- **BI pivot tables** driven by the model, with engine-evaluated subtotals and grand totals for non-additive measures, plus PowerBI-style **visual calculations** (running sums, previous-period, and friends)
- **CUBE formulas** (all 7, `CUBEVALUE`, `CUBEMEMBER`, ...) pull model data into ordinary grid cells, with async prefetch and a builder UI
- **Model extensibility**: script-based data connectors, model events, and model overlays that travel inside distributed packages
- A dedicated **Model menu** consolidates every model surface: editor, connections, model pivots, paginated reports, calculated measures, publish

The model is embedded in the workbook and distributed with it -- no external server, no separate designer application.

### Report Distribution (`.calp` Packages)

Spreadsheets are terrible at distribution. You email a copy, someone edits it, and now there are twelve versions of the truth. Calcula replaces the copy-of-a-workbook paradigm with a **publish/subscribe model**:

- **Publish** a workbook as a `.calp` package with versioning and distribution channels
- **Subscribe** from other workbooks to receive upstream updates
- **Override layers** track local edits separately from the upstream source
- **Refresh** rebases your overrides onto the latest published version
- Packages are **signed** (Ed25519), and any scripts they carry require explicit consent before running

Think of it as Git for spreadsheets, but designed for business users who will never touch a command line.

### Writeback

In traditional spreadsheets, data flows one way: someone builds a model, distributes it, and recipients can only read. Calcula's writeback system reverses this:

- Package authors **designate writeback cells** that recipients are allowed to edit
- Recipients fill in their data and **submit changes** back to the source
- **Draft auto-save** ensures nothing is lost mid-entry
- A full **audit trail** tracks every submission: who changed what, and when
- **Commit guards** validate entries against the region's declared schema; submissions land in an append-only event log and per-subscriber slots, making them conflict-free by construction
- Collected submissions surface as **tables in the BI model**, so returned data feeds straight into pivots, measures, and reports

This turns a spreadsheet from a read-only report into a two-way data collection tool, without giving up control of the model.

### Controls Pane

Excel scatters interactivity across individual objects, each with its own disconnected state. Calcula has a dedicated **Controls pane** where dashboard interactivity lives as first-class objects:

- **Model filters** that drive every BI pivot on the same connection at once -- one filter, many targets, managed from one place
- **Pane controls** -- sliders, dropdowns, checkboxes, buttons, and custom scripted controls -- whose values are readable from any formula via `GET.CONTROLVALUE`, so a slider can drive a calculation, a chart, or a whole scenario
- Combined with slicers and timeline slicers, this creates a dashboard-style experience without leaving the spreadsheet

### Scriptable Objects and Custom Functions

Scriptable Objects are Calcula's answer to VBA, built on the security model described above. Every object in Calcula (charts, slicers, pivot tables) can carry its own TypeScript code:

- **Per-object lifecycle hooks** let a chart react to its own data changes, a slicer run logic on selection, or a pivot table transform its output
- **Script notebooks** provide a Jupyter-style environment inside the spreadsheet for exploration and prototyping
- A **template library** lets you save and reuse scripted objects across workbooks
- **Custom formula functions** written in sandboxed JavaScript register as real grid functions -- and can query the BI model through the `cube.*` API
- Every script runs sandboxed under the capability broker: **tiered access levels**, consent prompts, and an always-on audit trail; scripts arriving in distributed packages are restricted and never run without explicit consent

### Granular Bricks

Customization should come in every size -- not just "write an extension." **Bricks** are small units of per-cell behavior (custom cell types, renderers, commit hooks) that attach to individual cells or ranges. Trusted registries provide full-power bricks; a declarative, sandboxed tier travels safely inside distributed packages, so a shared report can bring its own cell behaviors along.

### Pivot DSL

Pivot tables can be configured through a text-based **domain-specific language**, not just the visual drag-and-drop editor. This means pivot layouts can be version-controlled, diffed, generated programmatically, or shared as plain text. The same query language doubles as the **design query** behind charts, and supports post-aggregation `CALC:` columns for computed results.

### Animation and Simulation

A transient playback system turns any workbook into a live model: drivers (a clock cell, a chart parameter sweep, scenario tweening, Monte Carlo sampling) advance frame by frame, the engine recalculates dependents, and the grid repaints -- **without ever touching the undo stack or dirtying the document**. Stop, and the original state is restored exactly. Playback can be exported to GIF or WebM.

### Microkernel Extension Model

Where Excel offers COM add-ins bolted onto a monolithic core, Calcula's extension system is the architecture:

- **76 built-in extensions** (plus a dev-only Test Runner), each running through the same public API that third-party extensions use
- No backdoor access: the formatting extension has the same privileges as a plugin you write yourself
- Extensions can register commands, inject UI, add formula functions, subscribe to events, and intercept rendering
- Third-party extensions are scanned at runtime, verified against **signed manifests**, and can opt into the same sandbox as distributed scripts
- Swap out the charting engine, replace the formula evaluator, or add an entirely new data type, all without forking

## Project Status

Calcula is under active development. Here is an honest summary of where things stand:

### Core Engine

| Area | Status |
| --- | --- |
| Canvas grid with virtual scrolling (1M+ rows) | Working |
| Formula parser and evaluator (470+ functions) | Working |
| Dependency graph and recalculation engine | Working |
| Cross-sheet and cross-workbook references | Working |
| Undo/redo stack | Working |
| File format: `.cala` (ZIP archive of structured JSON) | Working |
| Optional whole-file encryption (XChaCha20-Poly1305 + Argon2id) | Working |
| File format: `.calp` (distributable packages, Ed25519-signed) | Working |

### Spreadsheet Features

| Area | Status |
| --- | --- |
| Cell formatting (fonts, colors, borders, number formats) | Working |
| Conditional formatting (data bars, icon sets, color scales) | Working |
| Data validation (dropdowns, type checks, error alerts) | Working |
| AutoFilter and sorting (multi-level, custom filters) | Working |
| Tables (auto-expand, calculated columns, structured refs) | Working |
| Freeze panes, split view, zoom | Working |
| Find/replace, go-to special | Working |
| Fill handle, flash fill, custom fill lists | Working |
| Merge cells, cell comments, hyperlinks | Working |
| Row/column grouping and outlining | Working |
| Sheet and workbook protection | Working |
| Print, page setup, page breaks, PDF export | Working |
| CSV import/export | Working |
| Excel `.xlsx` open/save (values, formulas, styles, merges, freeze panes, hidden rows/cols, charts) | Working |
| Movable/resizable dialogs, app skins, free panel layout | Working |

### Analytics and Visualization

| Area | Status |
| --- | --- |
| Pivot tables (visual editor, DSL, calculated fields) | Working |
| BI semantic models (Model Editor, measures, relationships) | Working |
| Calculated tables, calculation groups, security contexts | Working |
| BI pivots (engine-evaluated totals, visual calculations) | Working |
| CUBE formulas (all 7, over embedded BI models) | Working |
| Charts (free-floating, data point overrides, filters) | Working |
| Sparklines (line, column, win/loss) | Working |
| Slicers, timeline slicers, controls pane | Working |
| Subtotals and consolidation | Working |
| Scenario manager and solver/goal seek | Working |
| Animation / simulation playback (GIF/WebM export) | Working |

### Formula Functions (470+)

| Category | Examples |
| --- | --- |
| Math and trigonometry | ABS, CEILING, FLOOR, ROUND, SQRT, LOG, SIN, COS, ... |
| Statistical | AVERAGE, STDEV, MEDIAN, QUARTILE, RANK, PERCENTILE, ... |
| Financial | PMT, NPV, IRR, FV, RATE, ACCRINT, DB, DDB, ... |
| Lookup and reference | XLOOKUP, VLOOKUP, INDEX, MATCH, INDIRECT, CHOOSE, ... |
| Text | CONCATENATE, LEFT, MID, RIGHT, FIND, TRIM, SUBSTITUTE, ... |
| Date and time | DATE, DATEDIF, NETWORKDAYS, WORKDAY, EDATE, EOMONTH, ... |
| Logical | IF, IFS, AND, OR, XOR, SWITCH, ... |
| Dynamic arrays | FILTER, SORT, UNIQUE, SEQUENCE, BYCOL, BYROW, ... |
| Functional | LET, LAMBDA, MAP, REDUCE, SCAN, ... |
| Cube | CUBEVALUE, CUBEMEMBER, CUBESET, CUBERANKEDMEMBER, ... |
| Database | DSUM, DCOUNT, DAVERAGE, DMAX, DMIN, DSTDEV, DVAR, ... |
| Engineering | BESSELI, ERF, HEX2BIN, HEX2DEC, COMPLEX, CONVERT, ... |

Plus sandboxed **custom functions**: user-defined JavaScript functions that register into the same formula namespace.

### Beyond Spreadsheet

| Area | Status |
| --- | --- |
| Report distribution (`.calp` publish/subscribe) | Working |
| Writeback (submit, drafts, audit trail, event-log fold) | Working |
| Writeback-to-BI (submissions as model tables) | Working |
| Scripting (object scripts, notebooks, templates) | Working |
| Script security (sandbox, capability broker, consent, audit) | Working |
| Custom functions (sandboxed JS UDFs) | Working |
| BI engine integration (connections, models, Model Editor) | Working |
| Granular bricks (per-cell customization, distributable) | Working |
| Formula tracing and dependency visualization | Working |
| Watch window and formula evaluation stepper | Working |
| AI integration (MCP server exposing workbook tools) | Working |

### Extension System

| Area | Status |
| --- | --- |
| Extension host and lifecycle management | Working |
| 76 built-in extensions loaded through public API | Working |
| Command registry, UI injection, event subscriptions | Working |
| Style interceptors and rendering pipeline hooks | Working |
| Edit guards and commit guards | Working |
| Signed third-party extensions (runtime scan, sandbox opt-in) | Working |

The public API is still evolving. If you are looking for something you can ship a workbook in tomorrow, this is not it yet. If you want to explore what a modern spreadsheet engine can look like, pull up a chair.

## Tech Stack

- **Backend:** Rust (workspace with multiple crates)
- **Bridge:** Tauri
- **Frontend:** TypeScript, React, HTML5 Canvas
- **Testing:** Snapshot/golden-file suites, Playwright E2E against the real WebView, a nightly regression runner with visual baselines, and an oracle-driven soak-testing system (undo, save/reload, and recalc round-trips)
- **Target platform:** Windows 11 first, cross-platform as a follow-up

## Getting Started

(Currently for developers only)

1. Clone the repo.
2. Ensure you have Rust and Node.js installed.
3. Run `npm install` in the `/app` directory.
4. Run `npm run tauri dev`.

## Contributing


## License

