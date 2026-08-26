// FILENAME: app/extensions/_shared/cli/optionSchema.ts
// PURPOSE: Declarative option vocabulary per verb+kind. ONE table drives
//          validation (unknown `key=` -> CliError naming the valid keys),
//          completion (option-key suggestions) and help usage lines — the
//          Model Editor CLI triplicated this (writers.ts truth, OPTION_KEYS
//          completion mirror, help/reference docs) and the copies drifted.
// CONTEXT: A domain may opt into STRICT validation per kind table; the model
//          domain starts completion-only (its writers must be audited against
//          the mirror before strictness can be turned on — documented drift).

import { CliError } from "./lex";
import { usedOptKeys } from "./parse";
import type { GenericCommand } from "./parse";

export interface CliOptionSpec {
  key: string;
  type: "string" | "number" | "boolean" | "list" | "enum";
  /** Enum members, for completion and help. */
  values?: string[];
  help?: string;
  /** Alternative spellings accepted by VALIDATION only — never completed,
   *  never shown in help, never emitted by anything that renders a command.
   *
   *  This exists because validation must not be stricter than the thing that
   *  actually runs the command. `transform` forwards its statement to the
   *  engine's parser, which resolves option keys case-insensitively and knows
   *  the command line's older spellings; rejecting one here would refuse a
   *  command the engine would have accepted. */
  aliases?: string[];
}

/** Options accepted per verb for one kind ("set" -> [...], "add" -> [...]).
 *  A verb absent from the table accepts NO options under strict validation. */
export type CliOptionTable = Record<string, CliOptionSpec[]>;

/** Validate a command's used option keys against the specs for its verb.
 *  `strict: false` is a no-op (completion-only mode). */
export function validateOptions(
  cmd: GenericCommand,
  table: CliOptionTable | undefined,
  strict: boolean,
): void {
  if (!strict) return;
  const specs = table?.[cmd.verb] ?? [];
  const known = new Set(specs.map((s) => s.key));
  // Compared case-INSENSITIVELY, and lowercased on both sides because the
  // lexer already lowercases what the user typed. A spec key spelled in the
  // engine's canonical camelCase (`nameColumn`) would otherwise match nothing
  // it validates, so the option would be rejected while completion offered it.
  const accepted = new Set(
    specs.flatMap((s) => [s.key, ...(s.aliases ?? [])]).map((k) => k.toLowerCase()),
  );
  for (const key of usedOptKeys(cmd)) {
    if (!accepted.has(key.toLowerCase())) {
      const hint =
        known.size > 0
          ? `valid options: ${[...known].map((k) => k + "=").join(", ")}`
          : `'${cmd.verb}' takes no options here`;
      throw new CliError(`Unknown option '${key}=' (${hint})`, cmd.line);
    }
  }
}

/** The option keys to complete for a verb+kind (deduped, table order). */
export function optionKeysFor(
  table: CliOptionTable | undefined,
  verb: string,
): CliOptionSpec[] {
  return table?.[verb] ?? [];
}
