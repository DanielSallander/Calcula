//! FILENAME: app/src/api/scriptHost/scriptPreview/objectHooks.ts
// PURPOSE: Which hooks an object type can fire, derived from the generated
//          surface rather than written down twice.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          WHY IT EXISTS. A preview that only runs `setup` sees half a script:
//          for most object types the actual work is in a handler, and a handler
//          that throws is invisible until something fires it. The draft gate has
//          no task description and cannot know which one matters — but it does
//          know the OBJECT TYPE, which is a required field of
//          `draft_object_script`, and the object type determines which hooks
//          exist at all.
//
//          DERIVED, NOT LISTED. `SCRIPT_SURFACE` already carries every member's
//          interface, and hook registrations are the `on*` members of an
//          object's own context. A hand-written map would be a second source of
//          truth that drifts the first time a hook is added — the exact shape
//          this feature has been bitten by twice (the prompt teaching a dead
//          `expose('onClick')`, and `codeInventory` filing macros under the
//          wrong realm). `objectHooks.test.ts` pins that every drafted object
//          type resolves to a real interface.

import { SCRIPT_SURFACE } from "../generated/scriptSurfacePolicy";

/**
 * The context interface an object type's script is handed.
 *
 * The generator names them `<Type>Context` — `button` -> `ButtonContext`. This
 * is a naming convention rather than a declared mapping, which is why the test
 * asserts every drafted type resolves; a rename shows up as a failure rather
 * than as an object type that silently stops being previewed with its hooks.
 */
export function contextInterfaceFor(objectType: string): string {
  return `${objectType.charAt(0).toUpperCase()}${objectType.slice(1)}Context`;
}

/**
 * Every hook an object of this type can fire, in the surface's own order.
 *
 * Empty for a type with no hooks of its own — which is a fact about the object,
 * not a failure: a preview then simply runs `setup` and reports that.
 */
export function objectHooksFor(objectType: string): string[] {
  const iface = contextInterfaceFor(objectType);
  return SCRIPT_SURFACE.filter((m) => m.iface === iface && /^on[A-Z]/.test(m.chain)).map((m) => m.chain);
}
