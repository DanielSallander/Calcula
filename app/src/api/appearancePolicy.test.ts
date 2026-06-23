//! FILENAME: app/src/api/appearancePolicy.test.ts
import { describe, it, expect } from "vitest";
import { resolveEffectiveSkinId } from "./appearancePolicy";
import { BUILTIN_DEFAULT_SKIN_ID } from "../core/theme/builtInSkins";

describe("resolveEffectiveSkinId (advisory precedence: user > org > built-in)", () => {
  it("falls back to the built-in default when nothing is set", () => {
    expect(resolveEffectiveSkinId(null, null)).toBe(BUILTIN_DEFAULT_SKIN_ID);
  });

  it("uses the org advisory default when the user has not chosen", () => {
    expect(resolveEffectiveSkinId({ defaultSkinId: "acme" }, null)).toBe("acme");
  });

  it("the user's explicit choice always wins over the org default", () => {
    expect(resolveEffectiveSkinId({ defaultSkinId: "acme" }, "calcula.dark")).toBe("calcula.dark");
  });

  it("the user's choice wins even with no policy", () => {
    expect(resolveEffectiveSkinId(null, "calcula.dark")).toBe("calcula.dark");
  });

  it("honors an explicit built-in default override", () => {
    expect(resolveEffectiveSkinId(null, null, "my.default")).toBe("my.default");
  });
});
