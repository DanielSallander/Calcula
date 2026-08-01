//! FILENAME: app/src/api/scriptHost/__tests__/exampleAddin.test.ts
// PURPOSE: Keep the shipped example add-in (docs/examples/addin-tax-tools) HONEST.
//          A documented extension path that nobody executes rots into fiction —
//          this test loads the real bundle, hands it the real sandboxed
//          ExtensionContext, and checks that everything activate() registers is
//          inside the sidecar manifest's declared ceiling (and vice versa).
//          If the docs and the code drift, this fails.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { buildExtensionContext } from "../worker/extensionWorkerContext";
import {
  CONTRIBUTION_DECLARATION_KEY,
  isContributionDeclared,
  normalizeContributionDeclaration,
  type ExtContributionKind,
  type ExtRegistration,
  type WX2H,
} from "../extensionProtocol";
import { CAPABILITY_ID_SET, type CapabilityId } from "../capabilityIds";
import { UDF_ERROR_KEY } from "../../formulaFunctions";

const EXAMPLE_DIR = path.resolve(__dirname, "../../../../../docs/examples/addin-tax-tools");
const BUNDLE = path.join(EXAMPLE_DIR, "tax-tools.js");
const SIDECAR = path.join(EXAMPLE_DIR, "tax-tools.manifest.json");

/** The id a registration claims — mirrors contributionIdOf in the host. */
function claimedId(reg: ExtRegistration): string {
  switch (reg.kind) {
    case "command":
      return reg.id;
    case "menuItem":
      return `${reg.menuId}/${reg.item.id}`;
    case "formula":
      return reg.def.name.toUpperCase();
    case "ribbonButton":
      return reg.button.id;
    case "keybinding":
      return reg.binding.id;
    case "cellStyle":
      return reg.id;
    case "fileFormat":
      return reg.format.id;
    default:
      return "";
  }
}

describe("the shipped example add-in", () => {
  const sidecar = JSON.parse(fs.readFileSync(SIDECAR, "utf8")) as Record<string, unknown>;
  const declared = normalizeContributionDeclaration(sidecar.contributes);

  it("has a sidecar manifest the host can actually read", () => {
    expect(sidecar.id).toBe("calcula.example.tax-tools");
    expect(sidecar.workerSupport).toBe(true);
    // Every declared capability must be a recognized id, or the ceiling silently
    // shrinks and the author never learns why their function was refused.
    for (const cap of (sidecar.capabilities ?? []) as string[]) {
      expect(CAPABILITY_ID_SET.has(cap as CapabilityId), cap).toBe(true);
    }
    expect(declared.formulas).toEqual(["VATRATE", "VATAMOUNT"]);
  });

  it("activates inside the sandboxed context and registers only DECLARED contributions", async () => {
    // Imported the SAME way the sandbox does: as a self-contained ES module
    // from an inline URL. That also proves the bundle has no bare imports the
    // worker could not resolve.
    const dataUrl =
      "data:text/javascript;base64," +
      Buffer.from(fs.readFileSync(BUNDLE, "utf8"), "utf8").toString("base64");
    const mod = (await import(/* @vite-ignore */ dataUrl)) as {
      default: { manifest: Record<string, unknown>; activate: (ctx: unknown) => unknown };
    };
    const addin = mod.default;
    expect(addin.manifest.id).toBe(sidecar.id);

    const posted: WX2H[] = [];
    const { context } = buildExtensionContext(
      (msg) => posted.push(msg),
      { name: "Tax Tools", version: "1.0.0", provenance: "distributed" },
      declared,
    );

    const teardown = addin.activate(context);
    expect(typeof teardown, "activate must return its teardown").toBe("function");

    const registrations = posted
      .filter((m): m is Extract<WX2H, { t: "register" }> => m.t === "register")
      .map((m) => m.reg);
    expect(registrations.length).toBeGreaterThan(0);

    for (const reg of registrations) {
      if (reg.kind === "event") continue;
      const kind = reg.kind as ExtContributionKind;
      const id = claimedId(reg);
      expect(
        isContributionDeclared(declared, kind, id),
        `the example registers a ${kind} "${id}" that its sidecar manifest does not declare — the host would refuse it`,
      ).toBe(true);
    }

    // ...and nothing declared is left unimplemented (a declared-but-absent
    // contribution shows in the manager as a promise the add-in did not keep).
    const registeredByKind = new Map<string, Set<string>>();
    for (const reg of registrations) {
      if (reg.kind === "event") continue;
      const set = registeredByKind.get(reg.kind) ?? new Set<string>();
      set.add(claimedId(reg).toUpperCase());
      registeredByKind.set(reg.kind, set);
    }
    for (const [kind, key] of Object.entries(CONTRIBUTION_DECLARATION_KEY)) {
      for (const declaredId of declared[key] ?? []) {
        expect(
          registeredByKind.get(kind)?.has(declaredId.toUpperCase()),
          `the sidecar declares ${kind} "${declaredId}" but the bundle never registers it`,
        ).toBe(true);
      }
    }

    // The worksheet function really computes — the whole point of the slice.
    const formulaReg = registrations.find(
      (r): r is Extract<ExtRegistration, { kind: "formula" }> =>
        r.kind === "formula" && r.def.name.toUpperCase() === "VATAMOUNT",
    );
    expect(formulaReg).toBeDefined();

    // Drive the handler the way the host does: invokeHandler -> handlerResult.
    const built = buildExtensionContext(
      (msg) => posted.push(msg),
      { name: "Tax Tools", version: "1.0.0", provenance: "distributed" },
      declared,
    );
    const secondTeardown = addin.activate(built.context);
    const secondRegs = posted
      .filter((m): m is Extract<WX2H, { t: "register" }> => m.t === "register")
      .map((m) => m.reg);
    const secondFormula = secondRegs
      .filter((r): r is Extract<ExtRegistration, { kind: "formula" }> => r.kind === "formula")
      .find((r) => r.def.name.toUpperCase() === "VATAMOUNT");
    expect(secondFormula).toBeDefined();
    posted.length = 0;
    await built.runtime.invokeHandler(1, secondFormula!.handlerId, [100, "SE"]);
    const answer = posted.find(
      (m): m is Extract<WX2H, { t: "handlerResult" }> => m.t === "handlerResult",
    );
    expect(answer?.ok).toBe(true);
    expect(answer?.value).toBe(25);

    // An unknown country is an explicit cell error, not a wrong number.
    posted.length = 0;
    await built.runtime.invokeHandler(2, secondFormula!.handlerId, [100, "ZZ"]);
    const errAnswer = posted.find(
      (m): m is Extract<WX2H, { t: "handlerResult" }> => m.t === "handlerResult",
    );
    expect(errAnswer?.value).toEqual({ [UDF_ERROR_KEY]: "#N/A" });

    (teardown as () => void)();
    (secondTeardown as () => void)();
  });

  it("cannot reach a surface the sandbox does not offer", () => {
    const { context } = buildExtensionContext(
      () => {},
      { name: "Tax Tools", version: "1.0.0", provenance: "distributed" },
      declared,
    );
    const ctx = context as Record<string, unknown>;
    for (const surface of ["keyboard", "settings", "cellEditors"]) {
      expect(() => ctx[surface], surface).toThrow(/not available to a sandboxed extension/);
    }
    const ui = ctx.ui as Record<string, unknown>;
    for (const surface of ["taskPanes", "dialogs", "panels", "activityBar", "statusBar"]) {
      expect(() => ui[surface], surface).toThrow(/not available to a sandboxed extension/);
    }
    const grid = ctx.grid as Record<string, unknown>;
    for (const surface of ["decorations", "editGuards", "cellTypes", "layers"]) {
      expect(() => grid[surface], surface).toThrow(/not available to a sandboxed extension/);
    }
    // The one thing the message must NOT say any more: "run it on the main
    // thread". That escape hatch does not exist and must never be advertised.
    try {
      void ctx.keyboard;
    } catch (e) {
      expect((e as Error).message).not.toMatch(/main thread/i);
    }
  });
});
