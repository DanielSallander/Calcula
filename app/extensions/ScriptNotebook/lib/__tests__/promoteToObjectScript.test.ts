//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/promoteToObjectScript.test.ts
// PURPOSE: The security properties of "promote a notebook snippet to an object
//          script" — the notebook's only bridge into the automation world.
// CONTEXT: Three things must hold or the bridge becomes an escalation:
//            1. the promoted script LANDS UNMOUNTED (never auto-mount);
//            2. its capability declarations are DERIVED from what the snippet
//               actually called — never a blanket grant, never widened;
//            3. mounting it later runs nothing: the analysis body sits inside
//               `expose`, not in `setup`.

import { describe, it, expect, vi } from "vitest";

// The module reaches @api for ObjectScriptManager/saveObjectScript; the tests
// drive promotion through the injected host instead, so the barrel is stubbed.
vi.mock("@api", () => ({
  ObjectScriptManager: { registerScript: vi.fn(), mountScript: vi.fn() },
  saveObjectScript: vi.fn(),
}));

import {
  buildPromotedScript,
  methodNameFor,
  planPromotion,
  promoteCellToObjectScript,
  type PromotionHost,
} from "../promoteToObjectScript";

function recordingHost(): PromotionHost & {
  saved: unknown[];
  registered: unknown[];
} {
  const saved: unknown[] = [];
  const registered: unknown[] = [];
  return {
    saved,
    registered,
    save: async (s) => {
      saved.push(s);
    },
    register: (s) => {
      registered.push(s);
    },
  };
}

// ---------------------------------------------------------------------------
// Capability derivation
// ---------------------------------------------------------------------------

describe("planPromotion", () => {
  it("declares nothing for a snippet that used no privileged API", () => {
    const plan = planPromotion("const x = 1 + 1;\nconsole.log(x);");
    expect(plan.capabilities).toEqual([]);
    expect(plan.usesModel).toBe(false);
  });

  it("derives bi.query from a model-scoped query", () => {
    const plan = planPromotion("model.query('c1', { measures: ['Revenue'] })");
    expect(plan.capabilities).toEqual(["bi.query"]);
  });

  it("derives bi.sql ONLY when raw SQL was used", () => {
    expect(planPromotion("model.sql('c1', 'SELECT 1')").capabilities).toEqual(["bi.sql"]);
    // ...and does not smuggle bi.sql in behind a plain query.
    expect(planPromotion("model.query('c1', {})").capabilities).not.toContain("bi.sql");
  });

  it("covers the whole bi.query family without over-declaring", () => {
    const plan = planPromotion(
      "model.connections(); model.value('c', '[m]'); model.members('c', 'l'); model.kpi('c', 'k', 1);",
    );
    expect(plan.capabilities).toEqual(["bi.query"]);
  });

  it("refuses to widen to bi.model for model.info — it reports instead", () => {
    const plan = planPromotion("model.info('c1')");
    expect(plan.capabilities).not.toContain("bi.model");
    expect(plan.notes.some((n) => n.api === "model.info(...)")).toBe(true);
  });

  it("flags grid writes as an access-level decision, not an automatic one", () => {
    const plan = planPromotion("Calcula.setCellValue(0, 0, 'x')");
    expect(plan.capabilities).toEqual([]);
    expect(plan.notes.some((n) => /UNLOCKED/.test(n.note))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generated source shape
// ---------------------------------------------------------------------------

describe("buildPromotedScript", () => {
  const base = {
    scriptName: "Revenue check",
    methodName: "revenueCheck",
    notebookName: "Q3",
    cellNumber: 2,
  };

  it("emits one @capability pragma per derived capability and no others", () => {
    const source = buildPromotedScript({
      ...base,
      cellSource: "model.sql('c', 'SELECT 1'); model.query('c', {});",
      plan: planPromotion("model.sql('c', 'SELECT 1'); model.query('c', {});"),
    });
    const pragmas = [...source.matchAll(/^\/\/ @capability (\S+)$/gm)].map((m) => m[1]);
    expect(pragmas.sort()).toEqual(["bi.query", "bi.sql"]);
  });

  it("declares no capability for an inert snippet", () => {
    const cellSource = "1 + 1";
    const source = buildPromotedScript({ ...base, cellSource, plan: planPromotion(cellSource) });
    expect(source).not.toMatch(/@capability/);
  });

  it("puts the analysis inside expose(), so mounting registers but never runs it", () => {
    const cellSource = "Calcula.log('side effect');";
    const source = buildPromotedScript({ ...base, cellSource, plan: planPromotion(cellSource) });
    const exposeAt = source.indexOf('workbook.expose("revenueCheck"');
    const bodyAt = source.indexOf("Calcula.log('side effect');");
    expect(exposeAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeGreaterThan(exposeAt);
    // setup() itself contains only the shim + the expose call.
    expect(source).toMatch(/function setup\(workbook\) \{/);
  });

  it("reproduces the cell verbatim so the reviewer diffs the wrapper, not a rewrite", () => {
    const cellSource = "const r = model.query('c', { measures: ['Revenue'] });\nr.rows.length;";
    const source = buildPromotedScript({ ...base, cellSource, plan: planPromotion(cellSource) });
    for (const line of cellSource.split("\n")) {
      expect(source).toContain(line);
    }
  });

  it("only emits the model shim when the cell actually used model.*", () => {
    const inert = buildPromotedScript({
      ...base,
      cellSource: "1 + 1",
      plan: planPromotion("1 + 1"),
    });
    expect(inert).not.toContain("context.caps.biQuery");

    const uses = buildPromotedScript({
      ...base,
      cellSource: "model.query('c', {})",
      plan: planPromotion("model.query('c', {})"),
    });
    expect(uses).toContain("context.caps.biQuery");
  });

  it("records provenance so the script says where it came from", () => {
    const source = buildPromotedScript({
      ...base,
      cellSource: "1",
      plan: planPromotion("1"),
    });
    expect(source).toContain('Promoted from notebook "Q3", cell 2');
    expect(source).toContain("INACTIVE until you start it");
  });
});

// ---------------------------------------------------------------------------
// Promotion itself
// ---------------------------------------------------------------------------

describe("promoteCellToObjectScript", () => {
  const request = {
    scriptName: "Revenue check",
    methodName: "revenueCheck",
    cellSource: "model.query('c1', { measures: ['Revenue'] })",
    notebookName: "Q3",
    cellNumber: 1,
  };

  it("saves and registers, and NEVER mounts", async () => {
    const host = recordingHost();
    const mountSpy = vi.fn();
    await promoteCellToObjectScript(request, {
      ...host,
      // A mount attempt would have to come through the manager; there is no
      // seam for one here, and this asserts the module never grew one.
      register: (s) => {
        host.registered.push(s);
        mountSpy();
      },
    });
    expect(host.saved).toHaveLength(1);
    expect(host.registered).toHaveLength(1);
    // registerScript was called exactly once — registration, not mounting.
    expect(mountSpy).toHaveBeenCalledTimes(1);

    const api = await import("@api");
    expect(api.ObjectScriptManager.mountScript).not.toHaveBeenCalled();
  });

  it("persists BEFORE registering, so a rejected save leaves nothing live", async () => {
    const order: string[] = [];
    await promoteCellToObjectScript(request, {
      save: async () => {
        order.push("save");
      },
      register: () => {
        order.push("register");
      },
    });
    expect(order).toEqual(["save", "register"]);

    const registered: unknown[] = [];
    await expect(
      promoteCellToObjectScript(request, {
        save: async () => {
          throw new Error("backend rejected");
        },
        register: (s) => registered.push(s),
      }),
    ).rejects.toThrow("backend rejected");
    expect(registered).toHaveLength(0);
  });

  it("promotes at the restricted access level — never straight to unlocked", async () => {
    const host = recordingHost();
    await promoteCellToObjectScript(request, host);
    const saved = host.saved[0] as { accessLevel: string; objectType: string; instanceId: null };
    expect(saved.accessLevel).toBe("restricted");
    expect(saved.objectType).toBe("workbook");
    expect(saved.instanceId).toBeNull();
  });

  it("reports the capabilities it declared", async () => {
    const host = recordingHost();
    const result = await promoteCellToObjectScript(request, host);
    expect(result.capabilities).toEqual(["bi.query"]);
    expect(result.source).toContain("// @capability bi.query");
  });

  it("refuses text cells and empty cells", async () => {
    const host = recordingHost();
    await expect(
      promoteCellToObjectScript({ ...request, cellSource: "//!markdown\n# notes" }, host),
    ).rejects.toThrow(/text cell/i);
    await expect(
      promoteCellToObjectScript({ ...request, cellSource: "   \n" }, host),
    ).rejects.toThrow(/empty/i);
    expect(host.saved).toHaveLength(0);
  });
});

describe("methodNameFor", () => {
  it("produces a usable identifier from a human name", () => {
    expect(methodNameFor("Revenue check")).toBe("revenueCheck");
    expect(methodNameFor("Q3 — cell 2")).toBe("q3Cell2");
    expect(methodNameFor("!!!")).toBe("runAnalysis");
    expect(methodNameFor("")).toBe("runAnalysis");
  });

  it("never starts with a digit", () => {
    expect(/^[A-Za-z_$]/.test(methodNameFor("2024 revenue"))).toBe(true);
  });
});
