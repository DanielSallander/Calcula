//! FILENAME: app/extensions/_shared/components/bindings/index.ts
// PURPOSE: The shared fx widgets of property bindings (D-BIND, WP-D S8a):
//          `BindableField` (a property field with an fx switch) and the
//          `BindingFormulaEditor` it shows while fx is on. Every pane that
//          offers to bind a property imports them from here -- never its own
//          copy -- and writes through `@api/objectBindings`.

export {
  BindableField,
  describeResolved,
  formulaToCommit,
  isUnchangedBinding,
} from "./BindableField";
export type { BindableFieldProps } from "./BindableField";
export {
  BindingFormulaEditor,
  BINDING_ANALYSIS_DEBOUNCE_MS,
  measureToken,
  spliceAt,
} from "./BindingFormulaEditor";
export type { BindingFormulaEditorProps } from "./BindingFormulaEditor";
