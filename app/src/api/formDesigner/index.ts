//! FILENAME: app/src/api/formDesigner/index.ts
// PURPOSE: The visual form designer's ONE door into a script's source: read the
//          designer-owned layout out of it, and write an edited layout back
//          into it.
// CONTEXT: M5a of docs/design/typescript-forms.md §14, the AST half of the
//          drag-and-drop designer. Nothing here draws anything.
//
//          ONE ARTIFACT is the rule the whole milestone lives by, and it is
//          stated in full in app/src/api/scriptTranspile.ts's header: the script
//          IS the layout. There is no layout JSON beside it, no designer state
//          the code does not fully determine, and a script hand-edited in the
//          code editor opens in the designer showing exactly what the code
//          says — because the designer has nowhere else to look.
//
//          A leaf of @api: it imports the transpiler's compiler loader, the
//          form spec and its validator, and nothing from app/extensions.

export { readFormRegion, readParsedFormRegion, parseFormSource } from "./readFormRegion";
export type {
  FormRegionReadOk,
  FormRegionReadResult,
  ParsedFormSource,
} from "./readFormRegion";

export { writeFormRegion, describeCommentLoss, sameFormSpec } from "./writeFormRegion";
export type { FormRegionWriteOptions, FormRegionWriteResult } from "./writeFormRegion";

export { locateFormRegion, detectEol, detectIndentUnit, FORM_REGION_LABEL_RE } from "./formRegion";
export { emitDefineStatement, FormEmitError } from "./formEmit";
export type { FormEmitOptions } from "./formEmit";

export type {
  FormDesignerRefusal,
  FormDesignerRefusalCode,
  FormRegionComment,
  FormRegionSpan,
} from "./types";
