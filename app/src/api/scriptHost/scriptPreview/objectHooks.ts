//! FILENAME: app/src/api/scriptHost/scriptPreview/objectHooks.ts
// PURPOSE: Which hooks an object type can fire, read from the generated
//          surface's own type->interface table.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.1.
//
//          WHY IT EXISTS. A preview that only runs `setup` sees half a script:
//          for most object types the actual work is in a handler, and a handler
//          that throws is invisible until something fires it. The draft gate
//          has no task description and cannot know which hook matters — but it
//          knows the OBJECT TYPE, a required field of `draft_object_script`,
//          and the object type determines which hooks exist at all.
//
//          TWO LESSONS ARE BAKED IN, both from this feature's own adversarial
//          review (2026-08-21):
//           1. The first version derived the interface NAME by convention
//              ("button" -> "ButtonContext"), which was wrong for "textbox"
//              (its context is BaseObjectContext) and would misfire again on
//              the next irregular name. `OBJECT_TYPE_CONTEXTS` is the probe's
//              own table, emitted into the generated policy, so the mapping
//              cannot drift from the shim that builds the contexts.
//           2. The generated surface used to DEDUPLICATE chains across
//              interfaces, attributing every same-named hook to the
//              alphabetically first context that carried it — so slicer, table,
//              timeline and row read as hookless and a preview never fired
//              their handlers, while the worker really registers them
//              (`contextShims.ts` case "slicer": onSelectionChange, ...). The
//              dedup key now includes the interface; objectHooks.test.ts pins
//              the recovered per-type hooks so the collapse cannot return.

import { OBJECT_TYPE_CONTEXTS, SCRIPT_SURFACE } from "../generated/scriptSurfacePolicy";

const IFACE_BY_TYPE = new Map<string, string>(OBJECT_TYPE_CONTEXTS.map(([t, i]) => [t, i]));

/**
 * The context interface an object type's script is handed, per the probe's own
 * table. Undefined for a type the generator does not know — which is a fact to
 * surface, not to paper over with a guessed name.
 */
export function contextInterfaceFor(objectType: string): string | undefined {
  return IFACE_BY_TYPE.get(objectType);
}

/**
 * Every hook an object of this type can fire, in the surface's own order.
 *
 * Empty for a type whose context declares no hooks of its own — which is a
 * fact about the object, not a failure: a preview then simply runs `setup`
 * and reports that. (BaseObjectContext-backed types like "textbox" land here
 * honestly; before the dedup fix, slicer/table/timeline/row landed here
 * WRONGLY, and a throwing handler graded clean.)
 */
export function objectHooksFor(objectType: string): string[] {
  const iface = IFACE_BY_TYPE.get(objectType);
  if (!iface) return [];
  return SCRIPT_SURFACE.filter((m) => m.iface === iface && /^on[A-Z]/.test(m.chain)).map((m) => m.chain);
}
