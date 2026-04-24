# Philosophy

## The Spreadsheet is an Operating System

A spreadsheet is not a single application -- it is a *platform*. Formatting, charts, pivot tables, data validation, sorting -- these are all applications that happen to run on a grid. Calcula treats them that way. The grid is the kernel. Everything else is a guest.

## Independence Through Boundaries

Every layer in Calcula exists in deliberate isolation. The Core knows nothing about what runs on top of it. Extensions know nothing about each other. The API is a narrow, typed contract -- the only door between worlds. This is not defensive programming; it is the architecture itself. If a boundary would need to be violated to build a feature, the boundary is improved instead.

## No First-Class Citizens

Built-in extensions receive no privileges that a third-party extension cannot have. Bold, charts, pivot tables -- they all go through the same public API. If the API is insufficient, we expand the API rather than create a backdoor. This is the dogfooding principle taken to its logical conclusion: the platform is only as capable as its extension surface.

## Primitives, Not Features

The Core provides *mechanisms*, not *policies*. It offers a way to read and write ranges, emit events, register commands -- but never decides what those capabilities should be used for. Sorting is not a grid primitive; the ability to reorder cells is. This separation keeps the kernel small, stable, and universally useful.

## Performance is Architecture

Calcula targets a million rows not by optimizing late, but by choosing the right foundations early. Rust for computation, Canvas for rendering, virtualization for layout. Performance is not a feature we add -- it is a consequence of the materials we build with.

## The Bridge, Not the Monolith

Rust and TypeScript each do what they do best. Rust owns data, computation, and persistence. TypeScript owns interaction, layout, and user experience. Tauri is a thin bridge, not a framework. Each side is complete in its own domain.

## Extensibility is the Product

The extension system is not a nice-to-have bolted on after the core is "done." It *is* the product. Every user-facing feature validates that the extension API is rich enough, discoverable enough, and fast enough to build real things. If it isn't, the API is the bug.

## AI as a First-Class Collaborator

AI is not an afterthought or a bolt-on assistant. Calcula is designed from the ground up to be legible to AI -- through structured context serialization, tool-use interfaces, and an architecture that an LLM can reason about. The goal is a spreadsheet that can be understood, queried, and manipulated by both humans and machines through the same principled API.
