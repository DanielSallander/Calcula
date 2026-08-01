//! FILENAME: app/src/api/scriptLibraries/typings.ts
// PURPOSE: Generate the `.d.ts` fragment that types a script's `imports`
//          binding, so a declared library is discoverable in the editor instead
//          of being an untyped magic object.
// CONTEXT: The workbench's typings pipeline (scripts/gen-script-typings.mjs)
//          emits the STATIC surface — `context`, the capability shims, the data
//          shapes. A script's imports are not static: they depend on that
//          script's own `// @uses` pragmas and on the workbook's lockfile. So
//          this fragment is generated per script and handed to the editor as an
//          extra lib alongside the static one.
// SECURITY: Types are advisory, never a gate. The authoritative list of
//          callable names is the generated dispatcher in the LIBRARY realm
//          (linker.ts), which routes only `// @export` names, and the ceiling is
//          the intersection computed in ceiling.ts. A stale or hand-edited
//          `.d.ts` cannot make an undeclared export callable — it can only make
//          the editor wrong, and the call still fails at runtime with the
//          library's own error.

import { loadLockfile, findLocked } from "./lockfile";
import { parseUses } from "./usesPragma";

/**
 * The `.d.ts` fragment for one script's declared imports.
 *
 * Every export is typed `(...args: any[]) => Promise<any>` — deliberately, and
 * this is a permanent constraint rather than a gap to fill later: calls cross a
 * structured-clone boundary, so they are ALWAYS async and their arguments and
 * results are always plain data (never functions, class instances or closures).
 * A richer signature would need the library to ship type metadata, which is a
 * separate decision; promising precision the runtime does not enforce would be
 * worse than saying `any`.
 *
 * An alias that is not installed is emitted as a `never`-typed member with a
 * doc comment saying so, so the editor surfaces the missing dependency at
 * authoring time — the same failure the linker raises at mount, only earlier.
 */
export async function generateImportsTypings(source: string): Promise<string> {
  const { uses } = parseUses(source);
  if (uses.length === 0) return "";
  const lockfile = await loadLockfile();

  const members: string[] = [];
  for (const use of uses) {
    const locked = findLocked(lockfile, use.package);
    if (!locked) {
      members.push(
        `  /** NOT INSTALLED: ${use.package}@${use.pin}. Install it from Scripts > Script Libraries; this script will not mount until you do. */`,
        `  readonly ${use.alias}: never;`,
      );
      continue;
    }
    const caps = [...new Set(locked.modules.flatMap((m) => m.capabilities))];
    const exportMembers = [...new Set(locked.modules.flatMap((m) => m.exports))]
      .sort()
      .map(
        (name) =>
          `    /** Exported by ${locked.package}@${locked.resolved}. Always async (structured-clone boundary). */\n` +
          `    readonly ${name}: (...args: any[]) => Promise<any>;`,
      );
    members.push(
      `  /** ${locked.package}@${locked.resolved} (pinned ${locked.pin}, published by ${locked.publisherName || "an unnamed publisher"}).` +
        (caps.length
          ? ` Declares ${caps.join(", ")} — effective only where THIS script declares the same capability.`
          : " Declares no capabilities.") +
        ` */`,
      `  readonly ${use.alias}: {`,
      ...exportMembers,
      `  };`,
    );
  }

  return (
    `/** Libraries this script declared with // @uses. Host-resolved: a script\n` +
    ` *  can only reach what its own pragmas declared and the workbook locked. */\n` +
    `declare const imports: {\n${members.join("\n")}\n};\n`
  );
}
