//! FILENAME: app/src/api/dialogs.ts
// PURPOSE: Facade re-export of the Core dialog primitives. This is the import
//          path Extensions use: `import { confirmAsync } from "@api/dialogs"`.
// CONTEXT: The implementation and the full explanation of WHY the raw
//          window.confirm / window.alert / window.prompt globals are banned live
//          in src/core/lib/dialogs.ts. Nothing is added or narrowed here — asking
//          the user a question is a Core primitive, and the facade only makes it
//          reachable from `app/extensions` without a deep core import.
//
// THE ONE-LINE VERSION, because it has shipped as a bug six times:
//   Under Tauri, `window.confirm` returns a PROMISE. `if (!window.confirm(msg))`
//   therefore tests `!Promise`, which is ALWAYS false — the guard never fires and
//   the code runs as though the user pressed OK. Use `await confirmAsync(...)`.

export {
  confirmAsync,
  alertAsync,
  promptAsync,
  PROMPT_DIALOG_ATTR,
} from "../core/lib/dialogs";

export type { DialogTextOptions, ConfirmOptions, PromptOptions } from "../core/lib/dialogs";
