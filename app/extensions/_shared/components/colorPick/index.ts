//! FILENAME: app/extensions/_shared/components/colorPick/index.ts
// PURPOSE: The shared OS colour-picker hook (preview on `input`, ONE commit on
//          `change`) and the hex form a colour input accepts.
// CONTEXT: Used by the Object pane's colour rows and the Charts panes. Lives in
//          _shared so extensions do not import each other's internals. Kept out
//          of `_shared/components/index.ts`, which is the pivot field-editor barrel.

export { useNativeColorPick, pickerHex } from "./useNativeColorPick";
export type { NativeColorPickOptions, NativeColorPickProps } from "./useNativeColorPick";
