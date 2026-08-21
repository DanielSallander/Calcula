//! FILENAME: app/src/api/scriptHost/scriptEval/harness.ts
// PURPOSE: Execute one eval candidate against a task's fixture and observe what
//          it actually DID — the OFFLINE driver of the shared preview backend.
// CONTEXT: docs/design/local-model-script-authoring.md §5 (L3), §5c. The
//          grading itself (`gradeOutcome`) is pure and lives in index.ts.
//
//          THIS FILE IS NOW ONE OF TWO DRIVERS. The grid, the 39-method backend
//          and the broker's admit/refuse decision all moved out:
//            - `scriptPreview/grid.ts`     — the cell vocabulary
//            - `scriptPreview/backend.ts`  — the substituted backend
//            - `brokerPolicy.ts`           — `decidePolicy`, the real order
//          The other driver is `hostPreviewScript` (host.ts), which runs the
//          same backend behind a REAL hardened Worker in the app. Keeping one
//          backend for both is the whole point: a corpus that grades against
//          different semantics than the app previews with would certify the
//          wrong thing, and this repo has measured what two implementations of
//          one truth costs.
//
//          WHAT IS REAL HERE. `buildWorkerContext` builds the production
//          context, `wrapModuleSource` performs the production mount transform,
//          hook dispatch is the production `dispatchEvent`, and admission is
//          `decidePolicy` — the same function `brokerCall` enforces with. What
//          is substituted is the backend behind the broker, and only that.
//
//          WHAT IS DIFFERENT FROM THE IN-APP DRIVER, and why it is acceptable
//          here: this driver COMPILES the wrapper with `new Function` because
//          Node has no Worker realm to import a blob module into. So the realm's
//          ambient hardening is approximated by parameter shadowing (an explicit
//          `globalThis.` still reaches Node), which is one of the two reasons
//          untrusted candidates run inside the sandboxed subprocess rather than
//          here (grade-child.mjs: scrubbed env, permission model, hard kill).
//          The in-app driver has no such gap — it uses the real realm.

import { buildWorkerContext, dispatchEvent } from "../worker/contextShims";
import { wrapModuleSource } from "../worker/debugWrapper";
import { decidePolicy, type PolicyIdentity } from "../brokerPolicy";
import { validateScriptSource } from "../scriptValidation";
import type { CapabilityId } from "../capabilityIds";
import { PreviewGrid } from "../scriptPreview/grid";
import { createPreviewBackend, createPreviewState } from "../scriptPreview/backend";
import { drainBrokerTraffic, hookPayload, withTimeout } from "../scriptPreview/runShape";
import type { MountSpec, W2H } from "../protocol";
import type { EvalTask, OutcomeObservation } from "./index";

const SETUP_TIMEOUT_MS = 2_000;
const EVENT_TIMEOUT_MS = 5_000;

/**
 * Run one candidate against a task's outcome spec and report what happened.
 *
 * The mount is the production transform verbatim: `wrapModuleSource`'s own
 * text, evaluated as the function it wraps. `event` names the HOOK the product
 * fires — for a button, `button:clicked` reaches ONLY handlers registered via
 * `context.onClick(handler)`; a script that merely `expose`s a method named
 * "onClick" never hears a click, and this harness reports that exactly as the
 * product behaves (the click-path diagnosis calls it "never registered a click
 * handler"). That fidelity is load-bearing: the corpus shipped teaching the
 * exposed form, and only an executor faithful to the hook path could tell.
 */
export async function runTaskOutcome(task: EvalTask, source: string): Promise<OutcomeObservation> {
  const outcome = task.outcome;
  if (!outcome) throw new Error(`task ${task.id} carries no outcome spec`);

  const grid = new PreviewGrid();
  for (const seed of outcome.fixture ?? []) grid.setInput(seed.row, seed.col, seed.value);
  const seededInputs = grid.inputSnapshot();

  let hookError: string | undefined;

  const declared = new Set<CapabilityId>(validateScriptSource(source).declared as CapabilityId[]);

  const state = createPreviewState({ grid, stubs: outcome.stubs });
  const backend = createPreviewBackend(state);
  const output = state.output;

  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: `eval-${task.id}`,
    objectType: task.objectType,
    instanceId: "eval-instance",
    tier: "unlocked",
    capabilities: [...declared] as MountSpec["capabilities"],
    apiVersion: "1.0",
    source: "",
    scriptName: task.id,
    snapshot: {},
  };

  // The identity admission is decided against. Unlike the in-app preview — whose
  // handle declares NOTHING, so every capability-bearing call is refused — the
  // corpus deliberately admits what the candidate DECLARED: these tasks exist to
  // grade behaviour that uses `caps.fetch` / storage / dialogs, and the backend
  // answers those from canned stubs. Nothing here can reach a real capability;
  // there is no host to reach one through.
  const identity: PolicyIdentity = {
    tier: "unlocked",
    grants: declared,
    declaredCapabilities: declared,
  };

  let settle: (callId: number, ok: boolean, value?: unknown, error?: { code: string; message: string }) => void =
    () => {};
  const post = (msg: W2H): void => {
    if (msg.t === "error") {
      // dispatchEvent reports a throwing/rejecting handler here and RETURNS
      // NORMALLY — reading only the dispatch result would call that a clean
      // run, which is the async-silent-failure shape this project keeps
      // finding. First error wins; later ones add no verdict.
      hookError ??= msg.message;
      return;
    }
    if (msg.t !== "call") return;
    const { callId, method, args } = msg;
    queueMicrotask(() => {
      const decision = decidePolicy(identity, method, args);
      if (!decision.admitted) {
        settle(callId, false, undefined, { code: decision.code, message: decision.message });
        return;
      }
      try {
        settle(callId, true, backend(method, args), undefined);
      } catch (e) {
        settle(callId, false, undefined, {
          code: "HostError",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  };

  const { context, rt } = buildWorkerContext(spec, post);
  settle = (callId, ok, value, error) => rt.settleCall(callId, ok, value, error);
  state.exposedNames = () => [...rt.exposed.keys()];

  const finish = (ran: boolean, error?: string): OutcomeObservation => {
    let totalChanges = 0;
    const seen = new Set<string>();
    for (const { row, col, cell } of grid.entries()) {
      const k = `${row},${col}`;
      seen.add(k);
      if ((seededInputs.get(k) ?? "") !== cell.input) totalChanges++;
    }
    for (const [k, input] of seededInputs) {
      if (!seen.has(k) && input !== "") totalChanges++;
    }
    const readBack = (outcome.expect ?? []).map((e) => ({
      row: e.row,
      col: e.col,
      value: grid.input(e.row, e.col),
    }));
    return { ran, error, harnessGap: state.gap, readBack, output: [...output], totalChanges };
  };

  // The production mount transform, verbatim. The blob-import step is replaced
  // by compiling the same wrapper text as a function expression; the prefix
  // check makes a wrapper-shape change a loud failure instead of a drifted one.
  const wrapped = wrapModuleSource(source);
  const PREFIX = "export default ";
  if (!wrapped.startsWith(PREFIX)) {
    throw new Error("wrapModuleSource no longer emits the expected wrapper; update harness.ts with it");
  }
  // Realm parity for the ambient globals. The worker realm NEUTERS its network
  // and storage globals (`workerHardening.ts` NEUTERED_GLOBALS) and has no
  // `process`/`require` at all; Node has all of them, and a candidate calling
  // bare `fetch()` here would otherwise make a REAL network request from
  // untrusted code — while in the product that same script throws. Shadowing
  // via an outer function's parameters covers every bare reference in the
  // candidate body; reaching them through an explicit `globalThis.` is not
  // covered, which is one of the two reasons untrusted candidates run inside
  // the sandboxed subprocess rather than here.
  const NEUTERED = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts"];
  const ABSENT = ["process", "require", "module", "exports", "Buffer", "__dirname", "__filename"];
  const neuteredStub = (name: string) => () => {
    throw new Error(`${name} is not available (sandboxed worker realm)`);
  };
  let entry: (ctx: unknown) => unknown;
  try {
    const factory = new Function(
      ...NEUTERED,
      ...ABSENT,
      `"use strict"; return (${wrapped.slice(PREFIX.length)});`,
    ) as (...shadows: unknown[]) => (ctx: unknown) => unknown;
    entry = factory(...NEUTERED.map(neuteredStub), ...ABSENT.map(() => undefined));
  } catch (e) {
    return finish(false, `the script failed to compile: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    await withTimeout(Promise.resolve(entry(context)), SETUP_TIMEOUT_MS, "setup(context)");
  } catch (e) {
    return finish(false, `setup(context) threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!rt.hooks.has(outcome.event)) {
    const exposedInstead = rt.exposed.has(outcome.event);
    return finish(
      false,
      exposedInstead
        ? `the script exposes a method named "${outcome.event}", but the product fires the ` +
            `"${outcome.event}" HOOK — context.expose(...) never receives it. Register it with ` +
            `context.${outcome.event}(handler).`
        : `the script never registers the "${outcome.event}" hook (for a button, the click handler is ` +
            `context.onClick(handler))`,
    );
  }

  // Sequential fires: a persistence task ("count clicks across sessions")
  // cannot be separated from a reset by a single click — both write "1".
  const fires = Math.max(1, outcome.eventCount ?? 1);
  for (let i = 0; i < fires; i++) {
    try {
      await withTimeout(
        Promise.resolve(dispatchEvent(rt, outcome.event, hookPayload(outcome.event), post)),
        EVENT_TIMEOUT_MS,
        `the "${outcome.event}" handler`,
      );
    } catch (e) {
      return finish(false, `the "${outcome.event}" handler failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const stuck = await drainBrokerTraffic(() => rt.pending.size, EVENT_TIMEOUT_MS);
    if (stuck !== undefined) return finish(false, stuck);
    if (hookError !== undefined) {
      return finish(false, `the "${outcome.event}" handler threw: ${hookError}`);
    }
  }
  return finish(true);
}
