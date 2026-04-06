# Extension Template

Copy this folder to create a new Calcula extension.

## Getting Started

1. Copy `_template/` to `extensions/YourExtensionName/`
2. Edit `index.ts`:
   - Update the `manifest` (id, name, description)
   - Add your logic in `activate()`
   - Clean up in `deactivate()`
3. Register in `extensions/manifest.ts`:
   ```typescript
   import YourExtension from "./YourExtensionName";
   // Add to builtInExtensions array:
   export const builtInExtensions = [..., YourExtension];
   ```
4. Run `npm run dev` from `app/` to see it load

## Files

- `index.ts` — Entry point (exports `ExtensionModule`)
- `components/` — React components (task panes, dialogs, overlays)
- `handlers/` — Menu builders, command handlers
- `lib/` — Pure business logic, state management

## Key Rules

- Import ONLY from `@api` or `@api/*` — never from `@core/*` or `@shell/*`
- Always clean up in `deactivate()` — use the `cleanupFns` pattern
- Use `showToast()` for user feedback
- Wrap batch edits in `beginUndoTransaction()` / `commitUndoTransaction()`

See `docs/EXTENSION_GUIDE.md` for the full developer guide.
