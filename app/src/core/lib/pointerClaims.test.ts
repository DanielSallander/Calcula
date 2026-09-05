//! FILENAME: app/src/core/lib/pointerClaims.test.ts
// PURPOSE: The generic rule — a pointer press whose TARGET lies inside a
//          claiming element is not the grid's press — and the two exemptions
//          that keep a claimant from trapping the user (the secondary button,
//          and an element that is not hit-testable at all).
// CONTEXT: This is the one rule behind three shipped defects (a right-click
//          running a macro, a declared hit rectangle that took nothing, an
//          on-grid form widget that never focused). See pointerClaims.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  POINTER_CLAIM_ATTR,
  SECONDARY_MOUSE_BUTTON,
  claimPointer,
  findPointerClaim,
  hasPointerClaim,
  isKeyClaimed,
  isPointerClaimed,
  releasePointerClaim,
} from "./pointerClaims";

describe("pointer claims", () => {
  let gridArea: HTMLElement;
  let canvas: HTMLElement;
  let claimant: HTMLElement;
  let inner: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    // The real shape: Core binds its mousedown to the ANCESTOR, and every
    // on-grid surface is appended beside the canvas underneath it.
    gridArea = document.createElement("div");
    canvas = document.createElement("canvas");
    claimant = document.createElement("div");
    inner = document.createElement("input");
    claimant.appendChild(inner);
    gridArea.appendChild(canvas);
    gridArea.appendChild(claimant);
    document.body.appendChild(gridArea);
  });

  // ==========================================================================
  // The rule
  // ==========================================================================

  it("a press inside a claiming element is not the grid's press", () => {
    claimPointer(claimant, "shape-1");
    expect(isPointerClaimed({ target: claimant, button: 0 })).toBe(true);
  });

  it("a press outside every claim IS the grid's press", () => {
    claimPointer(claimant, "shape-1");
    expect(isPointerClaimed({ target: canvas, button: 0 })).toBe(false);
  });

  it("with nobody claiming anything, no press is claimed", () => {
    expect(isPointerClaimed({ target: claimant, button: 0 })).toBe(false);
    expect(isPointerClaimed({ target: inner, button: 0 })).toBe(false);
    expect(isPointerClaimed({ target: canvas, button: 0 })).toBe(false);
  });

  // ==========================================================================
  // ...read from the TARGET's ancestors, never from geometry
  // ==========================================================================

  it("a press on a DESCENDANT of the claimant is claimed too", () => {
    claimPointer(claimant, "placement-1");
    // The input inside an embedded form's card is the live case: it must be
    // covered by the claim, or the grid preventDefaults its focus away.
    expect(isPointerClaimed({ target: inner, button: 0 })).toBe(true);
    expect(findPointerClaim(inner)).toBe(claimant);
  });

  it("the claim is read from the ancestors, not from the claimant's box", () => {
    // Same pixels, different targets: an element that OVERLAPS the claimant
    // geometrically but is not inside it is not claimed. This is the whole
    // difference from `checkOverlayBody`, which is pure geometry and therefore
    // cannot tell "over the shape's box" from "on the element the script put
    // there". No layout is involved here at all — jsdom has none — which is the
    // point: the rule needs none.
    const sibling = document.createElement("div");
    gridArea.appendChild(sibling);
    claimPointer(claimant, "shape-1");
    expect(isPointerClaimed({ target: sibling, button: 0 })).toBe(false);
    expect(findPointerClaim(sibling)).toBeNull();
  });

  it("an ANCESTOR of the claimant is not claimed (the walk goes up, not down)", () => {
    claimPointer(claimant, "shape-1");
    expect(isPointerClaimed({ target: gridArea, button: 0 })).toBe(false);
  });

  it("a claim on an ancestor covers a nested claimant's subtree once", () => {
    claimPointer(gridArea, "outer");
    claimPointer(claimant, "inner");
    // `closest` stops at the NEAREST claim, which is the owner that should be
    // told about the press if anyone ever asks.
    expect(findPointerClaim(inner)).toBe(claimant);
  });

  // ==========================================================================
  // The exemptions
  // ==========================================================================

  it("RIGHT-CLICK is never claimed", () => {
    claimPointer(claimant, "shape-1");
    expect(isPointerClaimed({ target: inner, button: SECONDARY_MOUSE_BUTTON })).toBe(false);
    expect(SECONDARY_MOUSE_BUTTON).toBe(2);
  });

  it("the middle button IS claimed (only the secondary button is exempt)", () => {
    claimPointer(claimant, "shape-1");
    expect(isPointerClaimed({ target: inner, button: 1 })).toBe(true);
  });

  it("a press with no button reported is treated as primary", () => {
    claimPointer(claimant, "shape-1");
    expect(isPointerClaimed({ target: inner })).toBe(true);
  });

  it("releasing gives the pointer back to the grid, and is idempotent", () => {
    claimPointer(claimant, "shape-1");
    releasePointerClaim(claimant);
    releasePointerClaim(claimant);
    expect(hasPointerClaim(claimant)).toBe(false);
    expect(isPointerClaimed({ target: inner, button: 0 })).toBe(false);
  });

  it("a null or non-element target is never claimed", () => {
    claimPointer(claimant, "shape-1");
    expect(isPointerClaimed({ target: null, button: 0 })).toBe(false);
    expect(findPointerClaim(null)).toBeNull();
    expect(findPointerClaim(window as unknown as EventTarget)).toBeNull();
  });

  // ==========================================================================
  // What the attribute is
  // ==========================================================================

  // ==========================================================================
  // The keyboard is the same rule
  // ==========================================================================

  it("a keystroke inside a claiming element is not the grid's keystroke", () => {
    claimPointer(claimant, "placement-1");
    expect(isKeyClaimed({ target: inner })).toBe(true);
  });

  it("a keystroke outside every claim IS the grid's", () => {
    claimPointer(claimant, "placement-1");
    expect(isKeyClaimed({ target: canvas })).toBe(false);
    expect(isKeyClaimed({ target: gridArea })).toBe(false);
  });

  it("the keyboard has NO secondary-button exemption to be got round", () => {
    // The pointer exempts the right button so a claimant cannot trap the user;
    // a keystroke carries no button at all, and the way out is Tab/Escape
    // moving focus off the claimant — which leaves the claim by the front door.
    claimPointer(claimant, "placement-1");
    expect(isKeyClaimed({ target: inner })).toBe(true);
  });

  it("a keystroke covers a <select> and a <button>, which no tag list did", () => {
    // The two elements an on-grid form is actually made of, and the reason the
    // rule is an ancestor walk rather than a longer list of tag names.
    const dropdown = document.createElement("select");
    const ok = document.createElement("button");
    claimant.appendChild(dropdown);
    claimant.appendChild(ok);
    claimPointer(claimant, "placement-1");
    expect(isKeyClaimed({ target: dropdown })).toBe(true);
    expect(isKeyClaimed({ target: ok })).toBe(true);
  });

  it("a null or non-element target is never key-claimed", () => {
    claimPointer(claimant, "placement-1");
    expect(isKeyClaimed({ target: null })).toBe(false);
    expect(isKeyClaimed({ target: window as unknown as EventTarget })).toBe(false);
  });

  // ==========================================================================
  // A hidden claimant holds nothing
  // ==========================================================================

  it("a claim hidden with display:none is no claim, for pointer or key", () => {
    claimPointer(claimant, "placement-1");
    // `hideHost` in the embedded form layer writes exactly this on a card that
    // scrolled out of the viewport or whose sheet is not the active one. The
    // element stays, so the ATTRIBUTE stays.
    claimant.style.display = "none";
    expect(isKeyClaimed({ target: inner })).toBe(false);
    expect(isPointerClaimed({ target: inner, button: 0 })).toBe(false);
    expect(findPointerClaim(inner)).toBeNull();
  });

  it("visibility:hidden and the hidden attribute count as hidden too", () => {
    claimPointer(claimant, "placement-1");
    claimant.style.visibility = "hidden";
    expect(isKeyClaimed({ target: inner })).toBe(false);

    claimant.style.visibility = "";
    expect(isKeyClaimed({ target: inner })).toBe(true);

    claimant.setAttribute("hidden", "");
    expect(isKeyClaimed({ target: inner })).toBe(false);
  });

  it("a claim inside a hidden ANCESTOR is hidden too", () => {
    // Hiding is inherited, so the walk must not stop at the claimant's own
    // style: a whole layer can be hidden above the card that claimed.
    const layer = document.createElement("div");
    gridArea.appendChild(layer);
    layer.appendChild(claimant);
    claimPointer(claimant, "placement-1");
    layer.style.display = "none";
    expect(isKeyClaimed({ target: inner })).toBe(false);
  });

  it("showing the claimant again brings the claim back", () => {
    claimPointer(claimant, "placement-1");
    claimant.style.display = "none";
    expect(isKeyClaimed({ target: inner })).toBe(false);
    claimant.style.display = "block";
    expect(isKeyClaimed({ target: inner })).toBe(true);
    expect(isPointerClaimed({ target: inner, button: 0 })).toBe(true);
  });

  it("the claim is an attribute on the element, carrying the owner's label", () => {
    claimPointer(claimant, "placement-42");
    expect(claimant.getAttribute(POINTER_CLAIM_ATTR)).toBe("placement-42");
    // Removing the ELEMENT removes the claim — no second bookkeeping step that
    // can drift, which is the reason this is an attribute and not a registry.
    claimant.remove();
    expect(document.querySelector(`[${POINTER_CLAIM_ATTR}]`)).toBeNull();
  });
});
