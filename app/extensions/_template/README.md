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

- `index.ts` — Entry point (exports `ExtensionModule`): a menu item, an event
  listener, two commands and a ribbon tab / sidebar panel
- `components/MyRibbonSections.tsx` — two panel sections built only from
  `@api/layout` primitives: a row of `CommandButton` heroes, and a two-row grid
  of `SegmentedChoice` + `Dropdown` + `Checkbox`. **Its header is the design
  system in one page — read it before you build a panel.**
- `components/templatePanel.tsx` — the `PanelDefinition` those sections live in
  (ids, section icons, launcher and collapse behaviour)
- `components/MyPanel.tsx` — a plain task-pane component
- `lib/templateOptions.ts` — the panel's option state, kept outside React so it
  survives the section moving between the ribbon, a launcher flyout and the
  sidebar
- `__tests__/myRibbonSections.test.tsx` — renders both sections on every surface
  and checks the fill rule and that nothing paints a hardcoded colour
- `handlers/` — Menu builders, command handlers
- `lib/` — Pure business logic, state management

## Key Rules

- Import ONLY from `@api` or `@api/*` — never from `@core/*` or `@shell/*`
- Always clean up in `deactivate()` — use the `cleanupFns` pattern
- Use `showToast()` for user feedback
- Wrap batch edits in `beginUndoTransaction()` / `commitUndoTransaction()`
- **Ribbon and sidebar UI comes from `@api/layout`, icons from `RibbonIcon`.**
  No CSS of your own, no colour literals (`npm run lint:boundaries` fails on
  one), no native `<select>` in the ribbon, no emoji or unicode glyphs as icons.
- **The fill rule.** A ribbon section's content is either ONE TALL ROW of 61px
  (heroes, tiles) or TWO ROWS of 28px controls 5px apart (28 + 5 + 28 = 61) —
  never one short row, never three.

See `docs/EXTENSION_GUIDE.md` for the full developer guide,
`docs/design/ribbon-design-system.md` for the ribbon design system and
`docs/design/ICONS.md` for the icon set.
