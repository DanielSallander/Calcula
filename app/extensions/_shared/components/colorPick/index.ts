//! FILENAME: app/extensions/_shared/components/colorPick/index.ts
// PURPOSE: The shared OS colour-picker hook (preview on `input`, ONE commit on
//          `change`) and the hex form a colour input accepts.
// CONTEXT: Used by the Object pane's colour rows, the Charts panes and the
//          Controls panes. The hook itself lives in the layout kit
//          (`@api/layout`, primitives/useNativeColorPick.ts) since 2026-10-30,
//          because the kit's own colour controls need it too; this barrel keeps
//          the extension-side import path. Kept out of
//          `_shared/components/index.ts`, which is the pivot field-editor barrel.

export { useNativeColorPick, pickerHex } from "@api/layout";
export type { NativeColorPickOptions, NativeColorPickProps } from "@api/layout";
