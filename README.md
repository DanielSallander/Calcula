# Calcula

> An open-source spreadsheet engine with a microkernel core. As extensible as VS Code, as fast as Rust can make it.

**Status:** Active development. Core engine and most major features are working. Not yet production-released, but architecturally solid and growing fast.

---

## The Question

Excel may be the most successful "programming language" ever written. Hundreds of millions of people use it daily, and an enormous amount of the world's business logic lives inside `.xlsx` files.

But the spreadsheet itself, the engine, the grid, the formula model, has barely changed in three decades. It is closed, monolithic, and impossible to extend without a vendor's permission.

**What happens if we build one the other way around?**

Calcula is an attempt to answer that: a spreadsheet engine where the core knows nothing about formatting, pivot tables, or charts, and where every feature is an extension you can replace, rewrite, or rip out.

## The Architecture

Calcula follows a strict microkernel design, heavily inspired by VS Code.

```
   +----------------------------------------------------+
   |                    Extensions                      |
   |   Formatting | Pivots | Charts | Conditional ...   |
   +----------------------------------------------------+
                            |
   +----------------------------------------------------+
   |               Extension API (Shell)                |
   +----------------------------------------------------+
                            |
   +----------------------------------------------------+
   |           Core (Rust): cells, formulas,            |
   |           dependency graph, recalc engine          |
   +----------------------------------------------------+
```

- **Rust core.** Formula parsing, AST evaluation, dependency tracking, and recalc all live in a memory-safe Rust kernel. No JavaScript reaching into the calculation hot path.
- **Canvas frontend.** A TypeScript/React shell that renders the grid on HTML5 Canvas, so millions of rows scroll without choking the DOM.
- **Tauri bridge.** The two halves talk over Tauri IPC, keeping the install footprint small and the runtime fast.
- **Everything is an extension.** Bold text? Extension. Number formatting? Extension. Pivot tables? Extension. The core has zero opinions about presentation.
- **Layering is enforced.** `Core --> API --> Shell --> Extensions`. No shortcuts, no upward dependencies. The boundaries are real, not aspirational.

## Why Bother?

A few things become possible when the engine is open and modular:

- **New formula languages.** Want LAMBDA-style functional formulas, or something closer to DAX? Drop in a new evaluator extension.
- **Custom storage backends.** Stream cells from a database, a parquet file, or a remote API instead of loading a workbook into memory.
- **Domain-specific spreadsheets.** Financial modelers, scientists, and BI builders all want different things from a grid. A microkernel lets each community ship its own variant without forking the project.
- **Auditability.** Open code, open formula semantics, open dependency model. No more black-box recalc.

## Beyond the Spreadsheet

Calcula is not just an Excel clone. Several features have no equivalent in traditional spreadsheet software:

### Report Distribution (`.calp` Packages)

Spreadsheets are terrible at distribution. You email a copy, someone edits it, and now there are twelve versions of the truth. Calcula replaces the copy-of-a-workbook paradigm with a **publish/subscribe model**:

- **Publish** a workbook as a `.calp` package with versioning and distribution channels
- **Subscribe** from other workbooks to receive upstream updates
- **Override layers** track local edits separately from the upstream source
- **Refresh** rebases your overrides onto the latest published version

Think of it as Git for spreadsheets, but designed for business users who will never touch a command line.

### Writeback

In traditional spreadsheets, data flows one way: someone builds a model, distributes it, and recipients can only read. Calcula's writeback system reverses this:

- Package authors **designate writeback cells** that recipients are allowed to edit
- Recipients fill in their data and **submit changes** back to the source
- **Draft auto-save** ensures nothing is lost mid-entry
- A full **audit trail** tracks every submission: who changed what, and when
- **Commit guards** prevent conflicting edits

This turns a spreadsheet from a read-only report into a two-way data collection tool, without giving up control of the model.

### Unified Filter Ribbon

Excel scatters filtering across individual tables and pivot tables, each with its own disconnected filter state. Calcula introduces a dedicated **Filter ribbon tab** where filters live as first-class objects that can target multiple data sources at once:

- A single filter can drive multiple pivot tables, tables, and charts simultaneously
- Filters are visible and manageable from one central place, not buried inside individual objects
- Combined with slicers and timeline slicers, this creates a dashboard-style filtering experience without leaving the spreadsheet

### Scriptable Objects

Every object in Calcula (charts, slicers, pivot tables) can carry its own TypeScript code:

- **Per-object lifecycle hooks** let a chart react to its own data changes, a slicer run logic on selection, or a pivot table transform its output
- **Script notebooks** provide a Jupyter-style environment inside the spreadsheet for exploration and prototyping
- A **template library** lets you save and reuse scripted objects across workbooks
- **Tiered sandbox** controls what scripts can access, with a consent dialog for distributed packages

### Pivot DSL

Pivot tables can be configured through a text-based **domain-specific language**, not just the visual drag-and-drop editor. This means pivot layouts can be version-controlled, diffed, generated programmatically, or shared as plain text.

### Microkernel Extension Model

Where Excel offers COM add-ins bolted onto a monolithic core, Calcula's extension system is the architecture:

- **57 built-in extensions**, each running through the same public API that third-party extensions use
- No backdoor access: the formatting extension has the same privileges as a plugin you write yourself
- Extensions can register commands, inject UI, add formula functions, subscribe to events, and intercept rendering
- Swap out the charting engine, replace the formula evaluator, or add an entirely new data type, all without forking

## Project Status

Calcula is under active development. Here is an honest summary of where things stand:

### Core Engine

| Area | Status |
| --- | --- |
| Canvas grid with virtual scrolling (1M+ rows) | Working |
| Formula parser and evaluator (430+ functions) | Working |
| Dependency graph and recalculation engine | Working |
| Cross-sheet and cross-workbook references | Working |
| Undo/redo stack | Working |
| File format: `.cala` (ZIP archive of structured JSON) | Working |
| File format: `.calp` (distributable packages) | Working |

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

### Analytics and Visualization

| Area | Status |
| --- | --- |
| Pivot tables (visual editor, DSL, calculated fields) | Working |
| Charts (free-floating, data point overrides, filters) | Working |
| Sparklines (line, column, win/loss) | Working |
| Slicers and timeline slicers | Working |
| Subtotals and consolidation | Working |
| Scenario manager and solver/goal seek | Working |

### Formula Functions (430+)

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
| Database | DSUM, DCOUNT, DAVERAGE, DMAX, DMIN, DSTDEV, DVAR, ... |
| Engineering | BESSELI, ERF, HEX2BIN, HEX2DEC, COMPLEX, CONVERT, ... |

### Beyond Spreadsheet

| Area | Status |
| --- | --- |
| Report distribution (`.calp` publish/subscribe) | Working |
| Writeback (submit, drafts, audit trail) | Working |
| Scripting (object scripts, notebooks, templates) | Working |
| BI engine integration (data connections, models) | Working |
| Formula tracing and dependency visualization | Working |
| Watch window and formula evaluation stepper | Working |
| AI-assisted chat | Early (UI scaffolding, integration planned) |

### Extension System

| Area | Status |
| --- | --- |
| Extension host and lifecycle management | Working |
| 57 built-in extensions loaded through public API | Working |
| Command registry, UI injection, event subscriptions | Working |
| Style interceptors and rendering pipeline hooks | Working |
| Edit guards and commit guards | Working |

The public API is still evolving. If you are looking for something you can ship a workbook in tomorrow, this is not it yet. If you want to explore what a modern spreadsheet engine can look like, pull up a chair.

## Tech Stack

- **Backend:** Rust (workspace with multiple crates)
- **Bridge:** Tauri
- **Frontend:** TypeScript, React, HTML5 Canvas
- **Testing:** Snapshot and golden-file infrastructure, ~60 test suites and growing
- **Target platform:** Windows 11 first, cross-platform as a follow-up

## Getting Started

(Currently for developers only)

1. Clone the repo.
2. Ensure you have Rust and Node.js installed.
3. Run `yarn install` in the `/app` directory.
4. Run `yarn tauri dev`.

## Contributing


## License

