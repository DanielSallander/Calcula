//! FILENAME: app/extensions/DefinedNames/lib/invalidNameMessage.ts
// PURPOSE: The sentence the New Name and New Function dialogs show for a name
//          Excel's rule refuses (`isValidDefinedName`, @api/definedNameSyntax).
// CONTEXT: Excel's own text, measured live [Excel 16, 2026-11-06, lane
//          namescalp p1.ps1: `Names.Add("1abc")`, `"a b"` and `"A1"` each
//          raise exactly this]. The dialogs said a name may hold "only
//          letters, numbers, underscores, and periods", which stopped being
//          the rule when `\` and `?` became name characters (BUG-0741). Shown
//          with `white-space: pre-line`, so its lines stay Excel's lines.

export const INVALID_NAME_MESSAGE =
  "The syntax of this name isn't correct.\n\n" +
  "Verify that the name:\n" +
  "-Starts with a letter or underscore (_)\n" +
  "-Doesn't include a space or character that isn't allowed\n" +
  "-Doesn't conflict with an existing name in the workbook.";
