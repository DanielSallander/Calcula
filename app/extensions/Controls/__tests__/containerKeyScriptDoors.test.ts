//! FILENAME: app/extensions/Controls/__tests__/containerKeyScriptDoors.test.ts
// PURPOSE: WP-C S14 at the HOST tier -- a control's VISUAL CONTAINER keys have
//          two script doors, and they must give one answer per fact:
//            * the KEY door: `context.setProperty("containerTitleColor", v)` on
//              a shape's own context (aspect `shape.setProperty`);
//            * the POINTER door: WP-D's handle,
//              `context.self.setProperty("/properties/containerTitleColor", v)`
//              (aspect `property.set`).
//          The same bad value is refused through both with the SAME sentence,
//          before anything reaches the backend; a good value on the pointer
//          door reaches Rust as the control the REAL script instance id
//          (`control-<sheet>-<row>-<col>`) names, mapped by Controls' own
//          `control` registration (WP-D `bindingRefForInstance`, review R2-5).
//          And WP-D's chart handle reaches a chart's container:
//          `api.object("chart", id).setProperty("/spec/container/border/radius", 8)`
//          is ONE setLiteral; `/spec/container/title/text` has no catalog row
//          and is refused before Rust is asked.
// CONTEXT: The round trip is the real one: the worker shim builds the
//          envelope, the real broker policy (`decidePolicy`, vSetState's rows)
//          admits or refuses it, and the executor answers the shim's promise --
//          the harness of src/api/scriptHost/__tests__/scriptObjectHandleDoor.test.ts,
//          here with Controls' REAL registration and the backend doubled.
//          That Rust stores the chart's radius as ONE "Edit chart" undo step,
//          and that `set_control_property_core` re-checks the key with the same
//          sentence, is pinned in Rust: container_literal_tests.rs
//          (a_chart_container_literal_rides_update_chart_core,
//          both_control_container_doors_refuse_with_one_sentence).
//
//          SABOTAGE (confirmed 2026-10-16): delete the `checkControlContainerValue`
//          call from checkShapeSetProperty -> the key-door half of "one fact,
//          one sentence" goes red (the key door ADMITS the bad value);
//          delete the `controlContainerKeyRefusal` (b0) block from
//          checkPropertySetAspect -> the pointer-door half goes red for the
//          colour and the enum (the catalog's own sentence wins); hand the
//          keyed check `controlPropertyString(value)` instead of
//          `controlLiteralText(...)` -> the rgb() and "TOPLEFT" writes, which
//          Rust stores as #0080ff / topLeft, are refused.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

type BindingRequest = { op: string; [k: string]: unknown };

/** Every `object_bindings` request the seam sent, in order. */
const sent: BindingRequest[] = [];

const invokeBackend = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "object_bindings") {
    const req = (args as { request: BindingRequest }).request;
    sent.push(req);
    if (req.op === "setLiteral") return { kind: "literalSet", domains: ["objects"] };
    return { kind: "ack" };
  }
  return null;
});
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: (cmd: string, args?: Record<string, unknown>) => invokeBackend(cmd, args),
}));

/** The control the backend holds at (sheet 0, row 5, col 2), and its uid. */
const SHAPE_INSTANCE = "control-0-5-2";
const SHAPE_UID = "0190f00d-0000-7000-8000-000000000502";
const getControlMetadata = vi.fn(async (sheetIndex: number, row: number, col: number) =>
  sheetIndex === 0 && row === 5 && col === 2 ? { controlType: "shape", uid: SHAPE_UID, properties: {} } : null,
);
vi.mock("../lib/controlApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/controlApi")>()),
  getControlMetadata: (s: number, r: number, c: number) => getControlMetadata(s, r, c),
}));

import { executeBindingSetAspect, executeBindingGetAspect } from "@api/scriptHost/host";
import { BrokerError } from "@api/scriptHost/broker";
import { decidePolicy } from "@api/scriptHost/brokerPolicy";
import { getGrantSet, revokeScriptGrants } from "@api/scriptHost/capabilities";
import type { CapabilityId } from "@api/scriptHost/capabilityIds";
import { buildWorkerContext } from "@api/scriptHost/worker/contextShims";
import type { MountSpec, W2H } from "@api/scriptHost/protocol";
import { registerControlBindableProperties } from "../lib/controlBindings";

const CHART_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

let seq = 0;
const scriptIds: string[] = [];

/**
 * A mounted shape script (own object = the shape at control-0-5-2) with the
 * host's dispatch: policy, then the executor, then settle. `keyWrites` records
 * the `shape.setProperty` calls the policy ADMITTED (what the executor would
 * hand to Controls' door).
 */
function mountShape(tier: "restricted" | "unlocked") {
  const scriptId = `s14-door-${++seq}`;
  scriptIds.push(scriptId);
  const handle = {
    scriptId,
    scriptName: "Container door test",
    tier,
    objectType: "shape",
    instanceId: SHAPE_INSTANCE,
    origin: { kind: "local" as const },
    grants: getGrantSet(scriptId),
    declaredCapabilities: new Set<CapabilityId>(),
  };
  const mw = {
    handle,
    definition: {
      id: scriptId,
      name: "Container door test",
      objectType: "shape",
      instanceId: SHAPE_INSTANCE,
      source: "export function setup(context) {}",
    },
  } as unknown as Parameters<typeof executeBindingSetAspect>[0];
  const posted: W2H[] = [];
  const built = buildWorkerContext(
    {
      protocolVersion: 1,
      scriptId,
      objectType: "shape",
      instanceId: SHAPE_INSTANCE,
      tier,
      capabilities: [],
      apiVersion: "1.0.0",
      scriptName: "Container door test",
      snapshot: {},
      source: "",
    } as unknown as MountSpec,
    (msg) => posted.push(msg),
  );
  const keyWrites: Array<[string, string]> = [];
  async function pump(): Promise<void> {
    while (posted.length > 0) {
      const msg = posted.shift()!;
      if (msg.t !== "call") continue;
      const decision = decidePolicy(handle, msg.method, msg.args);
      if (!decision.admitted) {
        built.rt.settleCall(msg.callId, false, undefined, { code: decision.code, message: decision.message });
        continue;
      }
      try {
        let value: unknown;
        if (msg.method === "api.objectSetState" || msg.method === "api.objectGetState") {
          const [objectType, id, aspect, aspectArgs] = msg.args as [string, string, string, unknown[]];
          const target = { objectType, instanceId: id, door: "api" as const };
          value = msg.method === "api.objectSetState"
            ? await executeBindingSetAspect(mw, target, aspect, aspectArgs)
            : await executeBindingGetAspect(target, aspect, aspectArgs);
        } else {
          const [aspect, aspectArgs] = msg.args as [string, unknown[]];
          if (aspect === "shape.setProperty") {
            keyWrites.push(aspectArgs as [string, string]);
            value = undefined;
          } else {
            const target = { objectType: "shape", instanceId: SHAPE_INSTANCE, door: "own" as const };
            value = msg.method === "object.setState"
              ? await executeBindingSetAspect(mw, target, aspect, aspectArgs)
              : await executeBindingGetAspect(target, aspect, aspectArgs);
          }
        }
        built.rt.settleCall(msg.callId, true, value);
      } catch (e) {
        const err = e as BrokerError;
        built.rt.settleCall(msg.callId, false, undefined, { code: err.code ?? "HostError", message: err.message });
      }
    }
  }
  return { context: built.context as Record<string, any>, pump, keyWrites };
}

/** A promise's rejection (or a failure if it resolved). */
async function rejectionOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected a refusal, but the call was admitted");
}

let offRegistration: () => void = () => {};

beforeAll(() => {
  offRegistration = registerControlBindableProperties();
});

afterAll(() => {
  offRegistration();
  for (const id of scriptIds) revokeScriptGrants(id);
});

beforeEach(() => {
  sent.length = 0;
  getControlMetadata.mockClear();
});

describe("one fact, one sentence: the key door and the pointer door refuse a bad container value alike", () => {
  // [key, value for the key door (text), value for the pointer door (JSON), Rust's sentence]
  const cases: Array<[string, string, unknown, string]> = [
    ["containerTitleColor", "red", "red", "containerTitleColor must be empty or a #rgb, #rrggbb or #rrggbbaa colour."],
    ["containerTitleFontSize", "200", 200, "containerTitleFontSize must be a number from 6 to 96."],
    [
      "containerShadowPosition",
      "middle",
      "middle",
      "containerShadowPosition must be one of: bottomRight, bottom, bottomLeft, right, center, left, topRight, top, topLeft.",
    ],
    [
      "containerTitleText",
      "t".repeat(1025),
      "t".repeat(1025),
      "containerTitleText must be text of at most 1024 characters.",
    ],
  ];

  for (const tier of ["restricted", "unlocked"] as const) {
    for (const [key, keyValue, pointerValue, sentence] of cases) {
      it(`${tier}: ${key} -- both doors refuse with "${sentence.slice(0, 40)}..."`, async () => {
        const { context, pump, keyWrites } = mountShape(tier);

        const byKey = context.setProperty(key, keyValue);
        await pump();
        const keyRefusal = await rejectionOf(byKey);

        const byPointer = context.self.setProperty(`/properties/${key}`, pointerValue);
        await pump();
        const pointerRefusal = await rejectionOf(byPointer);

        expect(keyRefusal.code).toBe("ValidationError");
        expect(pointerRefusal.code).toBe("ValidationError");
        // Both are own-object calls (object.setState), so the broker's prefix
        // is the same too: the WHOLE message is one sentence for one fact.
        expect(keyRefusal.message).toBe(`object.setState: ${sentence}`);
        expect(pointerRefusal.message).toBe(keyRefusal.message);
        // Refused before the tier check and before any backend call.
        expect(keyWrites).toEqual([]);
        expect(sent).toEqual([]);
      });
    }
  }
});

describe("a good container value on the pointer door reaches Rust as the control the REAL instance id names", () => {
  it("control-0-5-2 resolves through Controls' registration to the backend uid", async () => {
    const { context, pump } = mountShape("restricted");
    expect(context.self.kind).toBe("shape");

    const done = context.self.setProperty("/properties/containerTitleColor", "rgb(0, 128, 255)");
    await pump();
    await expect(done).resolves.toBeUndefined();

    // The anchor was read from the BACKEND (the uid is never cached), and the
    // literal goes to Rust as that control, labelled as a restricted script.
    expect(getControlMetadata).toHaveBeenCalledWith(0, 5, 2);
    const set = sent.filter((r) => r.op === "setLiteral");
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({
      object: { kind: "control", id: SHAPE_UID },
      path: "/properties/containerTitleColor",
      value: "rgb(0, 128, 255)", // Rust's literal door stores it as #0080ff
      source: { kind: "script", unlocked: false },
    });
  });

  it("the key door admits the same fact spelled as the control stores it", async () => {
    const { context, pump, keyWrites } = mountShape("restricted");
    const done = context.setProperty("containerTitleColor", "#0080ff");
    await pump();
    await expect(done).resolves.toBeUndefined();
    expect(keyWrites).toEqual([["containerTitleColor", "#0080ff"]]);
  });

  it("an enum in any case is admitted on the pointer door (Rust canonicalises it)", async () => {
    const { context, pump } = mountShape("unlocked");
    const done = context.self.setProperty("/properties/containerShadowPosition", "TOPLEFT");
    await pump();
    await expect(done).resolves.toBeUndefined();
    expect(sent.find((r) => r.op === "setLiteral")).toMatchObject({
      object: { kind: "control", id: SHAPE_UID },
      path: "/properties/containerShadowPosition",
    });
  });

  it("an instance id that names no control is refused, and nothing is sent", async () => {
    const { pump, context } = mountShape("unlocked");
    const done = context.api.object("shape", "control-0-99-99").setProperty("/properties/containerTitleShow", true);
    await pump();
    const refusal = await rejectionOf(done);
    expect(refusal.code).toBe("ValidationError");
    expect(refusal.message).toMatch(/'shape' 'control-0-99-99' is not an object with bindable properties/);
    expect(sent.filter((r) => r.op === "setLiteral")).toEqual([]);
  });

  it("lockAspect is never bound, so it has no pointer at all (the key door still takes it)", async () => {
    const { context, pump, keyWrites } = mountShape("unlocked");
    const byPointer = context.self.setProperty("/properties/containerLockAspect", true);
    await pump();
    expect((await rejectionOf(byPointer)).code).toBe("ValidationError");
    const byKey = context.setProperty("containerLockAspect", "true");
    await pump();
    await expect(byKey).resolves.toBeUndefined();
    expect(keyWrites).toEqual([["containerLockAspect", "true"]]);
    expect(sent.filter((r) => r.op === "setLiteral")).toEqual([]);
  });
});

describe("WP-D's chart handle reaches the chart's container", () => {
  it("api.object(\"chart\", id).setProperty(\"/spec/container/border/radius\", 8) is ONE setLiteral", async () => {
    const { context, pump } = mountShape("unlocked");
    const done = context.api.object("chart", CHART_ID).setProperty("/spec/container/border/radius", 8);
    await pump();
    await expect(done).resolves.toBeUndefined();
    const set = sent.filter((r) => r.op === "setLiteral");
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({
      object: { kind: "chart", id: CHART_ID },
      path: "/spec/container/border/radius",
      value: 8,
      source: { kind: "script", unlocked: true },
    });
  });

  it("an out-of-range radius is refused with the container's sentence, before Rust is asked", async () => {
    const { context, pump } = mountShape("unlocked");
    const done = context.api.object("chart", CHART_ID).setProperty("/spec/container/border/radius", 101);
    await pump();
    const refusal = await rejectionOf(done);
    expect(refusal.message).toBe("api.objectSetState: border.radius must be a number from 0 to 100.");
    expect(sent).toEqual([]);
  });

  it("/spec/container/title/text has no catalog row (the title has ONE spelling, spec.title): refused", async () => {
    const { context, pump } = mountShape("unlocked");
    const done = context.api.object("chart", CHART_ID).setProperty("/spec/container/title/text", "x");
    await pump();
    const refusal = await rejectionOf(done);
    expect(refusal.code).toBe("ValidationError");
    expect(refusal.message).toMatch(/not a property any kind/);
    expect(sent).toEqual([]);
  });
});
