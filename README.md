# Calcula

Is it possible to create an "Excel-class" application with the help of AI? 

Lets find out! 

Calcula is an open-source spreadsheet engine project. 

### "Just another spreadsheet application"
Calcula is an exploration into whether we can build a modern "Excel-class" engine using a strict **Microkernel Architecture** (inspired by VSCode) and a high-performance **Rust** backbone.

**Status:** [EXPERIMENTAL / UNDER CONSTRUCTION]
Calcula is currently a "research project in code." It is not ready for production use, but it is very much ready for architectural debate and early-stage contribution.

## The Vision
- **Rust-Powered Brain:** Formula parsing and dependency graphing handled by Rust for memory safety and raw speed.
- **Canvas-Driven Face:** A specialized TypeScript + React frontend that renders cells on HTML5 Canvas to handle millions of rows without breaking a sweat.
- **Strictly Modular:** Everything—from Bold text to Pivot tables—is an extension. The core engine knows nothing about "Formatting."
- **Windows Native:** Designed to feel at home on Windows 11.

## Why Calcula?
Excel is perhaps the most successful "programming language" in the world. We want to see if we can build an open alternative that is as extensible as VSCode but as powerful as a desktop grid engine.

## Getting Started
(Currently for developers only)
1. Clone the repo.
2. Ensure you have Rust and Node.js installed.
3. Run `yarn install` in the /app directory.
4. Run `yarn tauri dev`.
