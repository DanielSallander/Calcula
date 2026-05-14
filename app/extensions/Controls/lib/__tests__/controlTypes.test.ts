//! FILENAME: app/extensions/Controls/lib/__tests__/controlTypes.test.ts
// PURPOSE: Tests for control type definitions and property resolution.

import { describe, it, expect } from "vitest";
import {
  getPropertyDefinitions,
  BUTTON_PROPERTIES,
} from "../types";

// ============================================================================
// Tests
// ============================================================================

describe("getPropertyDefinitions", () => {
  it("returns button properties for 'button' type", () => {
    const defs = getPropertyDefinitions("button");
    expect(defs).toBe(BUTTON_PROPERTIES);
    expect(defs.length).toBeGreaterThan(0);
  });

  it("button has expected core properties", () => {
    const keys = BUTTON_PROPERTIES.map((p) => p.key);
    expect(keys).toContain("text");
    expect(keys).toContain("fill");
    expect(keys).toContain("color");
    expect(keys).toContain("width");
    expect(keys).toContain("height");
    expect(keys).toContain("onSelect");
  });

  it("returns shape properties for 'shape' type", () => {
    const defs = getPropertyDefinitions("shape");
    expect(defs.length).toBeGreaterThan(0);
  });

  it("returns image properties for 'image' type", () => {
    const defs = getPropertyDefinitions("image");
    expect(defs.length).toBeGreaterThan(0);
  });

  it("returns empty array for unknown type", () => {
    expect(getPropertyDefinitions("unknown")).toEqual([]);
    expect(getPropertyDefinitions("")).toEqual([]);
  });

  it("button text supports formula mode", () => {
    const textProp = BUTTON_PROPERTIES.find((p) => p.key === "text");
    expect(textProp?.supportsFormula).toBe(true);
  });

  it("onSelect does not support formula mode", () => {
    const onSelectProp = BUTTON_PROPERTIES.find((p) => p.key === "onSelect");
    expect(onSelectProp?.supportsFormula).toBe(false);
    expect(onSelectProp?.inputType).toBe("code");
  });

  it("all property definitions have required fields", () => {
    for (const prop of BUTTON_PROPERTIES) {
      expect(prop.key).toBeTruthy();
      expect(prop.label).toBeTruthy();
      expect(prop.inputType).toBeTruthy();
      expect(typeof prop.defaultValue).toBe("string");
      expect(typeof prop.supportsFormula).toBe("boolean");
    }
  });
});
