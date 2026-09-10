// FILENAME: app/extensions/ModelEditor/lib/monacoTheme.ts
// PURPOSE: Re-export of the shared Monaco theme.
// CONTEXT: The implementation moved to `_shared/lib/monacoTheme.ts` once the
//          SHARED command panel needed it too — its Monaco was the last bright
//          white surface left in a dark window, and it is the same component
//          the main window's Command Line renders.
//
//          This file survives as a re-export so the five mount sites in this
//          extension (ExpressionWorkspace, ExpressionEditorModal,
//          SqlEditorModal, transform/FormulaField, transform/ScriptPane) keep
//          their import paths.

export {
  applyModelEditorTheme,
  activeModelEditorTheme,
  defineModelEditorThemes,
  ME_THEME_DARK,
  ME_THEME_LIGHT,
} from "../../_shared/lib/monacoTheme";
