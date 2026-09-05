//! FILENAME: app/src/api/pointerClaims.ts
// PURPOSE: API facade for the grid's POINTER CLAIM rule.
// CONTEXT: Re-exports the Core primitive so an extension that stacks its own
//          DOM over the grid canvas can say "this press is mine" without
//          re-typing the attribute name and without importing core/lib.
//          Extensions must import from here (or from `@api`), NOT from
//          core/lib directly. See core/lib/pointerClaims.ts for why the claim
//          is an attribute on the element rather than a registered predicate.

export {
  POINTER_CLAIM_ATTR,
  SECONDARY_MOUSE_BUTTON,
  type ClaimablePointerEvent,
  type ClaimableKeyEvent,
  findPointerClaim,
  isPointerClaimed,
  isKeyClaimed,
  claimPointer,
  releasePointerClaim,
  hasPointerClaim,
} from "../core/lib/pointerClaims";
