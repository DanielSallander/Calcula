//! FILENAME: app/extensions/AutoSum/components/AutoSumEditHost.tsx
// PURPOSE: An invisible shell component that lends Core's edit opener
//          (useEditing().startEditing) to lib/editOpener.ts.
// CONTEXT: See lib/editOpener.ts for why the opener must be the hook's. Mounted
//          by the shell frame through @api/ui registerShellComponent, so it is
//          there whether or not the formula bar is shown. Renders nothing.

import { useEffect } from "react";
import { useEditing } from "@api/editing";
import { lendEditOpener } from "../lib/editOpener";

export function AutoSumEditHost(): null {
  const { startEditing } = useEditing();
  // startEditing closes over the grid state of THIS render (it edits the
  // selection's active cell), so the opener is re-lent whenever it changes.
  useEffect(() => lendEditOpener(startEditing), [startEditing]);
  return null;
}
