//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/index.ts
// PURPOSE: The visual form designer's one entry point.
// CONTEXT: M5b of docs/design/typescript-forms.md §14. The AST half it stands
//          on is @api/formDesigner (M5a); everything here is UI, and everything
//          it does ends as code in the script the user already owns — the ONE
//          ARTIFACT rule stated in app/src/api/scriptTranspile.ts's header.

export { FormDesignerPanel } from "./FormDesignerPanel";
export type { FormDesignerPanelProps } from "./FormDesignerPanel";
