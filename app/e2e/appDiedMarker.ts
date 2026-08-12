//! FILENAME: app/e2e/appDiedMarker.ts
// PURPOSE: THE one path of the "the application went away" marker file.
// CONTEXT: Three files need this path and they are the three stages of one
//          mechanism (§3bx): `global-setup.ts` CLEARS it so a banner can only
//          ever be about this run, `fixtures.ts` WRITES it the moment a CDP
//          connect proves the app is gone, and `global-teardown.ts` READS it to
//          end the run with a banner instead of a number.
//
//          All three computed it independently. `fixtures.ts` even exported its
//          constant with the comment "Exported so the teardown cannot look in a
//          different place" -- and the teardown looked in a different place
//          anyway, by re-joining the same three segments itself. Three copies
//          that happened to agree is not one source of truth; it is a drift
//          waiting for the first person who moves `results/`, and the failure
//          mode is silent: the marker is written, nobody reads it, and the run
//          ends with "N failed" again -- which is precisely the lie §3bx exists
//          to stop telling.
//
//          This module is a LEAF on purpose. `global-setup.ts` runs in Node
//          before the test runner exists, so it must be able to take this path
//          without importing `fixtures.ts` and dragging the Playwright fixture
//          graph in with it.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Written by `e2e/fixtures.ts` when the harness proves the app is gone, cleared
 * by `global-setup.ts` at the start of every run, read by `global-teardown.ts`.
 */
export const APP_DIED_MARKER = path.join(HERE, "results", "APP-DIED.txt");
