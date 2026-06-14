// Unit tests for the model-scoped bi.query capability (Wave 3). Covers the
// structured-query validator (no raw-SQL surface), the connection-summary
// credential whitelist, and the R19 ceiling enforcement through the broker.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../backend", () => ({ invokeBackend: vi.fn().mockResolvedValue([]) }));

import { vBiQuery } from "../validators";
import { toBiConnectionSummary } from "../biQuerySupport";
import { buildHandleFromDefinition, brokerCall } from "../broker";
import { recordCapabilityGrant, resetAllGrants } from "../capabilities";

const validRequest = {
  measures: ["Sales"],
  groupBy: [{ table: "Date", column: "Year" }],
  filters: [{ column: "Region", table: "Geo", operator: "=", value: "EU" }],
};

describe("vBiQuery (structured, no SQL surface)", () => {
  it("accepts a valid structured query", () => {
    expect(vBiQuery(["conn-1", validRequest])).toBe(true);
    expect(vBiQuery(["conn-1", { measures: [], groupBy: [], filters: [] }])).toBe(true);
  });

  it("rejects a missing or non-string connectionId", () => {
    expect(typeof vBiQuery(["", validRequest])).toBe("string");
    expect(typeof vBiQuery([42 as unknown, validRequest])).toBe("string");
  });

  it("rejects a non-object request (e.g. a raw SQL string)", () => {
    expect(typeof vBiQuery(["c", "SELECT * FROM users"])).toBe("string");
    expect(typeof vBiQuery(["c", null])).toBe("string");
  });

  it("rejects malformed measures/groupBy/filters", () => {
    expect(typeof vBiQuery(["c", { measures: "x", groupBy: [], filters: [] }])).toBe("string");
    expect(typeof vBiQuery(["c", { measures: [], groupBy: [{ table: "t" }], filters: [] }])).toBe("string");
    expect(typeof vBiQuery(["c", { measures: [], groupBy: [], filters: [{ column: "c" }] }])).toBe("string");
  });
});

describe("toBiConnectionSummary (credential whitelist)", () => {
  it("keeps non-sensitive fields and drops connection strings / credentials", () => {
    const conn = {
      id: "c1",
      name: "Prod",
      connectionType: "postgres",
      isConnected: true,
      tableCount: 5,
      measureCount: 3,
      connectionString: "postgres://user:secretpass@host/db",
      server: "db.internal",
      database: "analytics",
      preferredAuth: "password",
    };
    const s = toBiConnectionSummary(conn);
    expect(s).toEqual({
      id: "c1",
      name: "Prod",
      connectionType: "postgres",
      isConnected: true,
      tableCount: 5,
      measureCount: 3,
    });
    // The credential-bearing fields must NOT survive the projection.
    expect(Object.keys(s)).not.toContain("connectionString");
    expect(Object.keys(s)).not.toContain("server");
    expect(JSON.stringify(s)).not.toContain("secretpass");
  });
});

describe("bi.query R19 ceiling (broker)", () => {
  const def = (declared: string[]) => ({
    id: "bi1",
    name: "S",
    objectType: "cell",
    instanceId: null,
    accessLevel: "restricted",
    declaredCapabilities: declared,
  });
  const args = ["c", { measures: [], groupBy: [], filters: [] }];

  beforeEach(() => resetAllGrants());

  it("denies cap.biQuery when bi.query is not declared (PermissionDenied)", async () => {
    const h = buildHandleFromDefinition(def([]));
    await expect(
      brokerCall(h, "cap.biQuery", args, async () => ({})),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
  });

  it("declared-but-ungranted yields CapabilityRequired", async () => {
    const h = buildHandleFromDefinition(def(["bi.query"]));
    await expect(
      brokerCall(h, "cap.biQuery", args, async () => ({})),
    ).rejects.toMatchObject({ code: "CapabilityRequired" });
  });

  it("declared + granted reaches the executor", async () => {
    const h = buildHandleFromDefinition(def(["bi.query"]));
    recordCapabilityGrant("bi1", "bi.query");
    await expect(
      brokerCall(h, "cap.biQuery", args, async () => ({ rowCount: 0 })),
    ).resolves.toEqual({ rowCount: 0 });
  });
});
