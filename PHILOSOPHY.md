# Philosophy

## The Spreadsheet is an Operating System

A spreadsheet is not a single application -- it is a *platform*. Formatting, charts, pivot tables, data validation, sorting -- these are all applications that happen to run on a grid. Calcula treats them that way. The grid is the kernel. Everything else is a guest.

## Never Wait for the Vendor

Excel's greatest gift was that a user with a specific problem could build a specific solution -- with formulas, with VBA, with add-ins -- without asking anyone's permission. The industry's drift toward locked-down BI tools took that away: closed visual galleries, closed data models, and feature requests that wait years on a vendor's roadmap. Calcula's measure of success is the opposite: when a user hits a wall, the platform offers them a way *through* it -- a script, a function, an extension -- today, not in a future release. The data model itself is no exception: measures, relationships, hierarchies, KPIs, and security roles are authored inside Calcula (the Model Editor window -- Power Pivot's place in Excel, not a separate vendor tool), so the semantic layer is as user-buildable as the grid on top of it.

## Power Without Hidden Code

VBA did not fail because it was powerful; it failed because the power was invisible. Code hid inside binary files, ran with the full authority of the machine, and a recipient could never quite know what a workbook would do when opened. Calcula keeps the power and removes the darkness: custom code is written in TypeScript, lives where it can be seen and audited, must run inside a tiered sandbox, and must cross no trust boundary without explicit consent. You should never have to wonder *where the code is* or *what it can touch*.

## Distribution is Part of the Model

A spreadsheet that can only be shared by emailing copies of itself will always end in twelve versions of the truth. Calcula treats distribution as an engine capability, not an afterthought: workbooks are published as versioned packages, consumers subscribe to updates, local changes live in override layers -- and data flows back upstream through audited writeback. Sharing a model and collecting data are part of the spreadsheet itself, not chores delegated to an inbox. This holds for the data model literally: a BI model is published as a signed, versioned `dataset` package -- never a loose file -- and the transparency rule extends to publishing itself: every publish reports exactly what shipped and what could not, because a silent drop is just hidden behavior wearing a different coat.

## Independence Through Boundaries

Every layer in Calcula exists in deliberate isolation. The Core knows nothing about what runs on top of it. Extensions know nothing about each other. The API is a narrow, typed contract -- the only door between worlds. This is not defensive programming; it is the architecture itself. If a boundary would need to be violated to build a feature, the boundary is improved instead. This discipline extends to *time* as well as layers: Animation can temporarily modify model state for preview without polluting the undo stack or persisting across sessions -- stopping playback restores the original state, leaving no trace. The grid's edit history records only committed changes, never intermediate simulation frames.

## No First-Class Citizens

Built-in extensions receive no privileges that a third-party extension cannot have. Bold, charts, pivot tables -- they all go through the same public API. If the API is insufficient, we expand the API rather than create a backdoor. This is the dogfooding principle taken to its logical conclusion: the platform is only as capable as its extension surface.

## Primitives, Not Features

The Core provides *mechanisms*, not *policies*. It offers a way to read and write ranges, emit events, register commands -- but never decides what those capabilities should be used for. Sorting is not a grid primitive; the ability to reorder cells is. This separation keeps the kernel small, stable, and universally useful.

## Bricks of Every Size

Excel was lego: bricks anyone could build anything with. Calcula's ambition is *smaller bricks*. Customization must not stop at the feature level -- the unit of tinkering scales down to a single cell (its rendering, its editor, what a click does) and up to a layer across the whole grid. Every visual and behavioral element the grid draws should, in the limit, be a brick a user can replace or compose. Two rules keep this from ever costing stability: untrusted code never runs inside the frame -- sandboxed scripts declare state that trusted renderers interpret, and interaction reaches scripts as asynchronous events -- and every brick's writes flow through the same undoable, audited pipeline as a keystroke. The paint loop and the undo stack are sacred; everything else is negotiable.

## Performance is Architecture

Calcula targets a million rows not by optimizing late, but by choosing the right foundations early. Rust for computation, Canvas for rendering, virtualization for layout. Performance is not a feature we add -- it is a consequence of the materials we build with.

## The Bridge, Not the Monolith

Rust and TypeScript each do what they do best. Rust owns data, computation, and persistence. TypeScript owns interaction, layout, and user experience. Tauri is a thin bridge, not a framework. Each side is complete in its own domain.

## Extensibility is the Product

The extension system is not a nice-to-have bolted on after the core is "done." It *is* the product. Every user-facing feature validates that the extension API is rich enough, discoverable enough, and fast enough to build real things. If it isn't, the API is the bug. Capability-gated backend channels (`createBackendChannel("Animation")`) and feature-neutral facades (`@api/chartParams`, so one extension can drive another's params without importing it) show that validation in practice: when an extension needs to reach the backend or steer a sibling, the answer is a capability-constrained, auditable door -- not a thin wire-through and never a backdoor. If that door proves insufficient, the API itself is enriched.

## AI as a First-Class Collaborator

AI is not an afterthought or a bolt-on assistant. Calcula is designed from the ground up to be legible to AI -- through structured context serialization, tool-use interfaces, and an architecture that an LLM can reason about. The goal is a spreadsheet that can be understood, queried, and manipulated by both humans and machines through the same principled API.
