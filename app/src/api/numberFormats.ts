//! FILENAME: app/src/api/numberFormats.ts
//! PURPOSE: Number-format seam for extensions.
//! CONTEXT: A narrow module rather than another face on the @api barrel, so a
//!          ribbon or dialog that only needs the number-format vocabulary does
//!          not drag the whole extension graph in behind it.
//!
//!          The vocabulary itself lives in Rust. Five of the eleven entries in
//!          Excel's Home > Number dropdown are REGIONAL -- Excel writes Short
//!          Date / Long Date / Time as `[$-x-sysdate]` / `[$-x-systime]`
//!          handles and takes Currency / Accounting from the OS currency
//!          pattern -- so the format strings cannot be written down on this
//!          side without hard-coding a region, which is what BUG-0064 was.

export {
  previewNumberFormat,
  getRibbonNumberFormats,
} from "../core/lib/tauri-api";

export type {
  PreviewResult,
  RibbonNumberFormat,
} from "../core/lib/tauri-api";
