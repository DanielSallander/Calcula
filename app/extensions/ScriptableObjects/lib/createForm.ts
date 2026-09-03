//! FILENAME: app/extensions/ScriptableObjects/lib/createForm.ts
// PURPOSE: The ONE place a new form script is minted — Insert > Form and the
//          manager pane's "New form" both come here, so the identity rule has
//          a single author.
// CONTEXT: A form (objectType "form") is a per-instance object script with no
//          backing workbook object. Its instanceId is therefore MINTED HERE as
//          a fresh UUID rather than derived from an anchor cell or supplied by
//          a caller: anchor-derived ids lose their script on copy
//          (Controls/lib/controlClipboard.ts), and "the file never chooses its
//          identity" is the rule template import already enforces.
//
//          Names are auto-numbered "Form1", "Form2", ... unique among forms
//          case-insensitively, because other scripts will address a form by
//          NAME (host-resolved among mounted forms) and an ambiguous name is a
//          loud refusal rather than a first-wins guess.

import { ObjectScriptManager, getScaffoldTemplate, saveObjectScript } from "@api";
import type { ObjectScriptDefinition } from "@api/scriptableObjects";

/** The next free "FormN" name, case-insensitive among existing forms. */
export function nextFormName(existing: readonly ObjectScriptDefinition[]): string {
  const taken = new Set(
    existing.filter((s) => s.objectType === "form").map((s) => s.name.toLowerCase()),
  );
  let n = 1;
  while (taken.has(`form${n}`)) n++;
  return `Form${n}`;
}

/**
 * Mint, register and persist a new form script from the scaffold.
 *
 * Persisted BEFORE it is returned so the editor window (which reloads the
 * script list from the backend) can find it; a save failure is reported, not
 * swallowed, because a form the user sees in the editor but that does not
 * survive a reload is exactly the "it vanished" defect.
 */
export async function createFormScript(): Promise<ObjectScriptDefinition> {
  const name = nextFormName(ObjectScriptManager.getAllScripts());
  const script: ObjectScriptDefinition = {
    id: crypto.randomUUID(),
    name,
    objectType: "form",
    instanceId: crypto.randomUUID(),
    source: getScaffoldTemplate("form", name),
    accessLevel: "restricted",
  };
  ObjectScriptManager.registerScript(script);
  await saveObjectScript(script);
  return script;
}
