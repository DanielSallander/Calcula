# Tablix Engine - Decommissioned

**Status:** Decommissioned (March 2026)

The Tablix feature has been decommissioned and removed from the active codebase.
The source code is preserved here for reference in case we decide to re-implement it in the future.

## What was removed:
- Frontend extension: `app/extensions/Tablix/`
- Rust backend commands: `app/src-tauri/src/tablix/`
- Workspace membership in `core/Cargo.toml`
- Dependency in `app/src-tauri/Cargo.toml`
- Insert menu item, ComponentToggle (Pivot/Tablix switcher), and all Tauri command registrations
- API commands in `app/src/api/backend.ts`

## To re-enable:
1. Add `"tablix-engine"` back to `core/Cargo.toml` workspace members
2. Add `tablix-engine = { path = "../../core/tablix-engine" }` to `app/src-tauri/Cargo.toml`
3. Restore the `app/src-tauri/src/tablix/` module (from git history)
4. Restore the `app/extensions/Tablix/` extension (from git history)
5. Re-register in `app/extensions/index.ts`, `lib.rs`, `backend.ts`, and Insert menu
