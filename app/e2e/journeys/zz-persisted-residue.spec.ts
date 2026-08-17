/**
 * THE PERSISTED-RESIDUE GUARD — the last spec in the journey run, on purpose.
 *
 * WHY IT EXISTS. `docs/design/open-items.md` §2.4 recorded that the journey
 * project has no counterpart to the functional project's residue guard. On
 * 2026-08-16 that gap cost a run: `shapes-hometab.spec.ts` test 8 customises the
 * Home-tab ribbon and restores it in a `finally`, the app wedged mid-test, and
 * the `finally` could not do its work — `restoreDefaultHomeLayout(page)` needs a
 * living app, and the failures that leave residue are exactly the ones where
 * there isn't one. The injected `rowBreak` survived in `localStorage` and the
 * NEXT project failed `ribbon-core-default-ribbon.png`, with `deleteColumn`
 * clipped out of the Cells group. The visual project reported a red golden for
 * something no visual spec did.
 *
 * WHY IT GUARDS THE *PERSISTED* SURFACE AND NOT THE WORKBOOK. Disturbing the
 * document is what the journey project is FOR — `new_file`, `open_file`, real
 * window closes. A workbook-residue assertion here would fail by design. What a
 * journey spec must never do is leave the APPLICATION configured differently
 * from how it found it, because that outlives the document, outlives the
 * project, and outlives the run.
 *
 * IT ASSERTS THE VALUE IS DEFAULT — NOT THAT THE KEY IS ABSENT. The first draft
 * of this file asserted absence and failed on a CLEAN app, because two of these
 * keys belong to `zustand/persist` stores that write themselves the moment the
 * store hydrates: `calcula-task-pane` was present with `{"width":320,
 * "dockMode":"docked"}`, which is precisely `initialState`. Absence was the
 * wrong question. A guard that reds a clean run is a guard somebody switches
 * off, which is worse than not having one.
 *
 * THE KEY CATALOGUE LIVES IN `e2e/volatilePersistedState.ts`, not here, because
 * the run-START reset needs the same predicates to tell "a store wrote its own
 * defaults" from "a dead run left residue behind". Two copies existed for about
 * an hour and had already disagreed about what `calcula-task-pane` does.
 *
 * WHAT A FAILURE HERE MEANS. Not that this file is broken: that some spec
 * earlier in the run changed a persisted preference and did not put it back.
 * The message names the key and the consequence. Fix it where it was set — a
 * `finally` that restores it — never here. And note that a `finally` is
 * necessary but NOT sufficient: `global-setup` also resets these on the way IN
 * (see `e2e/volatilePersistedState.ts`), because a teardown cannot run on a
 * dead app.
 *
 * It runs last because the file name sorts last. Do not rename it.
 */
import { test, expect } from "../fixtures";
import { APP_STORAGE_PREFIXES, GOLDEN_AFFECTING_KEYS } from "../volatilePersistedState";

test.describe("Persisted-state residue guard (runs last)", () => {
  test("no journey spec left the application reconfigured", async ({ appPage }) => {
    const storage = await appPage.evaluate((prefixes: readonly string[]) => {
      const out: Record<string, string> = {};
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && prefixes.some((p) => k.startsWith(p))) {
            out[k] = window.localStorage.getItem(k) ?? "";
          }
        }
      } catch {
        return null;
      }
      return out;
    }, APP_STORAGE_PREFIXES as unknown as string[]);

    expect(
      storage,
      "localStorage was unreadable — the guard cannot answer, which is a failure, " +
        "not a pass. A guard that cannot fail is worse than no guard.",
    ).not.toBeNull();

    const disturbed = GOLDEN_AFFECTING_KEYS.filter((k) => !k.isClean(storage![k.key])).map(
      (k) => `${k.key} = ${storage![k.key]}\n    -> ${k.consequence}`,
    );

    expect(
      disturbed,
      "A journey spec left a persisted preference at a NON-DEFAULT value. Each " +
        "entry is a key that survives this run and changes what LATER projects " +
        "photograph. Restore it in the spec that set it (in a `finally`), and " +
        "remember that the run-start reset in e2e/volatilePersistedState.ts is the " +
        "backstop for the case where the app dies before any `finally` can run.\n" +
        `Full app-namespace storage at end of run: ${JSON.stringify(storage, null, 2)}`,
    ).toEqual([]);
  });
});
