//! FILENAME: app/extensions/BusinessIntelligence/lib/__tests__/biApi.deep.test.ts
// PURPOSE: Deep tests for BI API lifecycle, caching, concurrency, and error handling.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all backend calls
const mockApiCreateConnection = vi.fn();
const mockApiDeleteConnection = vi.fn();
const mockApiUpdateConnection = vi.fn();
const mockApiGetConnections = vi.fn();
const mockApiGetConnection = vi.fn();
const mockApiConnect = vi.fn();
const mockApiDisconnect = vi.fn();
const mockApiBindTable = vi.fn();
const mockApiQuery = vi.fn();
const mockApiInsertResult = vi.fn();
const mockApiRefreshConnection = vi.fn();
const mockApiRefreshAllInMemory = vi.fn();
const mockApiGetModelInfo = vi.fn();
const mockApiGetRegionAtCell = vi.fn();

vi.mock("@api/backend", () => ({
  biCreateConnection: (...args: unknown[]) => mockApiCreateConnection(...args),
  biDeleteConnection: (...args: unknown[]) => mockApiDeleteConnection(...args),
  biUpdateConnection: (...args: unknown[]) => mockApiUpdateConnection(...args),
  biGetConnections: (...args: unknown[]) => mockApiGetConnections(...args),
  biGetConnection: (...args: unknown[]) => mockApiGetConnection(...args),
  biConnect: (...args: unknown[]) => mockApiConnect(...args),
  biDisconnect: (...args: unknown[]) => mockApiDisconnect(...args),
  biBindTable: (...args: unknown[]) => mockApiBindTable(...args),
  biQuery: (...args: unknown[]) => mockApiQuery(...args),
  biInsertResult: (...args: unknown[]) => mockApiInsertResult(...args),
  biRefreshConnection: (...args: unknown[]) => mockApiRefreshConnection(...args),
  biRefreshAllInMemory: (...args: unknown[]) => mockApiRefreshAllInMemory(...args),
  biGetModelInfo: (...args: unknown[]) => mockApiGetModelInfo(...args),
  biGetRegionAtCell: (...args: unknown[]) => mockApiGetRegionAtCell(...args),
}));

describe("BI API deep tests", () => {
  let biApi: typeof import("../bi-api");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    biApi = await import("../bi-api");
  });

  // =========================================================================
  // Connection lifecycle
  // =========================================================================

  describe("connection lifecycle: create -> connect -> query -> disconnect -> delete", () => {
    it("walks through the full lifecycle", async () => {
      const connInfo = { id: 1, name: "TestDB", connectionString: "sqlite://test.db", status: "disconnected" };
      mockApiCreateConnection.mockResolvedValue(connInfo);
      const created = await biApi.createConnection({ name: "TestDB", connectionString: "sqlite://test.db" } as any);
      expect(created.id).toBe(1);
      expect(biApi.getCachedConnections()).toBeNull();

      // Connect
      const connected = { ...connInfo, status: "connected" };
      mockApiConnect.mockResolvedValue(connected);
      const connResult = await biApi.connect(1);
      expect(connResult.status).toBe("connected");
      expect(biApi.getCachedConnections()).toBeNull();

      // Query
      const queryResult = { columns: ["name", "value"], rows: [["A", 1], ["B", 2]] };
      mockApiQuery.mockResolvedValue(queryResult);
      const qr = await biApi.query(1, { tableName: "Sales" } as any);
      expect(qr.rows).toHaveLength(2);
      expect(biApi.getCachedActiveConnectionId()).toBe(1);
      expect(biApi.getCachedQueryResult()).toEqual(queryResult);

      // Disconnect
      const disconnected = { ...connInfo, status: "disconnected" };
      mockApiDisconnect.mockResolvedValue(disconnected);
      const dcResult = await biApi.disconnect(1);
      expect(dcResult.status).toBe("disconnected");

      // Delete
      mockApiDeleteConnection.mockResolvedValue(undefined);
      await biApi.deleteConnection(1);
      expect(biApi.getCachedActiveConnectionId()).toBeNull();
    });
  });

  // =========================================================================
  // Multiple simultaneous connections
  // =========================================================================

  describe("multiple simultaneous connections", () => {
    it("tracks the active connection as queries switch between connections", async () => {
      const qr1 = { columns: ["a"], rows: [[1]] };
      const qr2 = { columns: ["b"], rows: [[2]] };
      mockApiQuery.mockResolvedValueOnce(qr1).mockResolvedValueOnce(qr2);

      await biApi.query(10, { tableName: "T1" } as any);
      expect(biApi.getCachedActiveConnectionId()).toBe(10);
      expect(biApi.getCachedQueryResult()).toEqual(qr1);

      await biApi.query(20, { tableName: "T2" } as any);
      expect(biApi.getCachedActiveConnectionId()).toBe(20);
      expect(biApi.getCachedQueryResult()).toEqual(qr2);
    });

    it("deleting one connection does not affect another active connection", async () => {
      biApi.setCachedActiveConnectionId(10);
      mockApiDeleteConnection.mockResolvedValue(undefined);

      await biApi.deleteConnection(20);

      expect(biApi.getCachedActiveConnectionId()).toBe(10);
    });

    it("getConnections returns all connections regardless of active", async () => {
      const conns = [
        { id: 1, name: "A", status: "connected" },
        { id: 2, name: "B", status: "disconnected" },
        { id: 3, name: "C", status: "connected" },
      ];
      mockApiGetConnections.mockResolvedValue(conns);

      const result = await biApi.getConnections();
      expect(result).toHaveLength(3);
      expect(biApi.getCachedConnections()).toEqual(conns);
    });
  });

  // =========================================================================
  // Model info caching with invalidation
  // =========================================================================

  describe("model info caching with invalidation", () => {
    it("getModelInfo calls backend each time (no client-side cache)", async () => {
      const model = { tables: [{ name: "Sales" }] };
      mockApiGetModelInfo.mockResolvedValue(model);

      await biApi.getModelInfo(1);
      await biApi.getModelInfo(1);

      expect(mockApiGetModelInfo).toHaveBeenCalledTimes(2);
    });

    it("returns different models for different connections", async () => {
      const m1 = { tables: [{ name: "A" }] };
      const m2 = { tables: [{ name: "B" }, { name: "C" }] };
      mockApiGetModelInfo.mockResolvedValueOnce(m1).mockResolvedValueOnce(m2);

      const r1 = await biApi.getModelInfo(1);
      const r2 = await biApi.getModelInfo(2);

      expect(r1!.tables).toHaveLength(1);
      expect(r2!.tables).toHaveLength(2);
    });
  });

  // =========================================================================
  // Query result caching across connection switches
  // =========================================================================

  describe("query result caching across connection switches", () => {
    it("overrides cached query when switching connections", async () => {
      const qr1 = { columns: ["x"], rows: [[1]] };
      const qr2 = { columns: ["y"], rows: [[2], [3]] };
      mockApiQuery.mockResolvedValueOnce(qr1).mockResolvedValueOnce(qr2);

      await biApi.query(1, { tableName: "T1" } as any);
      expect(biApi.getCachedQueryRequest()).toEqual({ tableName: "T1" });

      await biApi.query(2, { tableName: "T2" } as any);
      expect(biApi.getCachedQueryRequest()).toEqual({ tableName: "T2" });
      expect(biApi.getCachedQueryResult()).toEqual(qr2);
    });

    it("insertResult uses the most recent query result after switching", async () => {
      const qr1 = { columns: ["a"], rows: [[1]] };
      const qr2 = { columns: ["b"], rows: [[2]] };
      mockApiQuery.mockResolvedValueOnce(qr1).mockResolvedValueOnce(qr2);

      await biApi.query(1, { tableName: "T1" } as any);
      await biApi.query(2, { tableName: "T2" } as any);

      mockApiInsertResult.mockResolvedValue({ rowsInserted: 1 });
      await biApi.insertResult({ sheetIndex: 0, startRow: 0, startCol: 0 } as any);

      expect(mockApiInsertResult).toHaveBeenCalledWith(
        { sheetIndex: 0, startRow: 0, startCol: 0 },
        qr2,
        { tableName: "T2" },
      );
    });
  });

  // =========================================================================
  // Error handling for all API operations
  // =========================================================================

  describe("error handling", () => {
    it("createConnection propagates backend errors", async () => {
      mockApiCreateConnection.mockRejectedValue(new Error("DB unreachable"));
      await expect(biApi.createConnection({} as any)).rejects.toThrow("DB unreachable");
    });

    it("connect propagates backend errors", async () => {
      mockApiConnect.mockRejectedValue(new Error("Auth failed"));
      await expect(biApi.connect(1)).rejects.toThrow("Auth failed");
    });

    it("disconnect propagates backend errors", async () => {
      mockApiDisconnect.mockRejectedValue(new Error("Timeout"));
      await expect(biApi.disconnect(1)).rejects.toThrow("Timeout");
    });

    it("query propagates backend errors and does not cache", async () => {
      mockApiQuery.mockRejectedValue(new Error("SQL syntax error"));
      await expect(biApi.query(1, {} as any)).rejects.toThrow("SQL syntax error");
      // Cache should remain null since module was freshly imported
      expect(biApi.getCachedQueryResult()).toBeNull();
    });

    it("deleteConnection propagates backend errors", async () => {
      mockApiDeleteConnection.mockRejectedValue(new Error("Not found"));
      await expect(biApi.deleteConnection(999)).rejects.toThrow("Not found");
    });

    it("updateConnection propagates backend errors", async () => {
      mockApiUpdateConnection.mockRejectedValue(new Error("Validation failed"));
      await expect(biApi.updateConnection({} as any)).rejects.toThrow("Validation failed");
    });

    it("refreshConnection propagates backend errors", async () => {
      mockApiRefreshConnection.mockRejectedValue(new Error("Connection lost"));
      await expect(biApi.refreshConnection(1)).rejects.toThrow("Connection lost");
    });

    it("insertResult throws when no cached result (before any query)", async () => {
      await expect(biApi.insertResult({} as any)).rejects.toThrow("No query result to insert");
    });

    it("bindTable propagates backend errors", async () => {
      mockApiBindTable.mockRejectedValue(new Error("Table not found"));
      await expect(biApi.bindTable(1, {} as any)).rejects.toThrow("Table not found");
    });
  });

  // =========================================================================
  // BiEvents uniqueness and naming conventions
  // =========================================================================

  describe("BiEvents naming conventions", () => {
    it("all event values follow the app:bi-* pattern", async () => {
      const { BiEvents } = await import("../biEvents");
      for (const value of Object.values(BiEvents)) {
        expect(value).toMatch(/^app:bi-[a-z-]+$/);
      }
    });

    it("all event keys are SCREAMING_SNAKE_CASE", async () => {
      const { BiEvents } = await import("../biEvents");
      for (const key of Object.keys(BiEvents)) {
        expect(key).toMatch(/^[A-Z][A-Z_]+$/);
      }
    });

    it("all event values are unique strings", async () => {
      const { BiEvents } = await import("../biEvents");
      const values = Object.values(BiEvents);
      expect(new Set(values).size).toBe(values.length);
    });

    it("has at least 5 event types", async () => {
      const { BiEvents } = await import("../biEvents");
      expect(Object.keys(BiEvents).length).toBeGreaterThanOrEqual(5);
    });
  });

  // =========================================================================
  // Region-at-cell with overlapping BI regions
  // =========================================================================

  describe("getRegionAtCell edge cases", () => {
    it("returns region info when cell is within a BI region", async () => {
      const region = { connectionId: 1, tableName: "Sales", startRow: 0, startCol: 0, endRow: 100, endCol: 5 };
      mockApiGetRegionAtCell.mockResolvedValue(region);

      const result = await biApi.getRegionAtCell(50, 3);
      expect(result).toEqual(region);
      expect(mockApiGetRegionAtCell).toHaveBeenCalledWith(50, 3);
    });

    it("returns null for cells outside any BI region", async () => {
      mockApiGetRegionAtCell.mockResolvedValue(null);
      const result = await biApi.getRegionAtCell(9999, 9999);
      expect(result).toBeNull();
    });

    it("returns the correct region when multiple regions exist", async () => {
      // Backend determines which region the cell belongs to
      const regionA = { connectionId: 1, tableName: "A" };
      const regionB = { connectionId: 2, tableName: "B" };
      mockApiGetRegionAtCell.mockResolvedValueOnce(regionA).mockResolvedValueOnce(regionB);

      const r1 = await biApi.getRegionAtCell(0, 0);
      const r2 = await biApi.getRegionAtCell(200, 0);

      expect(r1!.tableName).toBe("A");
      expect(r2!.tableName).toBe("B");
    });

    it("handles boundary cells (row 0, col 0)", async () => {
      mockApiGetRegionAtCell.mockResolvedValue({ connectionId: 1, tableName: "Origin" });
      const result = await biApi.getRegionAtCell(0, 0);
      expect(result!.tableName).toBe("Origin");
    });
  });

  // =========================================================================
  // updateConnection cache invalidation
  // =========================================================================

  describe("updateConnection", () => {
    it("invalidates connection cache after update", async () => {
      // Populate cache
      mockApiGetConnections.mockResolvedValue([{ id: 1, name: "Old" }]);
      await biApi.getConnections();
      expect(biApi.getCachedConnections()).not.toBeNull();

      // Update
      mockApiUpdateConnection.mockResolvedValue({ id: 1, name: "New" });
      await biApi.updateConnection({ id: 1, name: "New" } as any);

      expect(biApi.getCachedConnections()).toBeNull();
    });
  });

  // =========================================================================
  // getConnection (single, no cache)
  // =========================================================================

  describe("getConnection", () => {
    it("delegates directly to backend without caching", async () => {
      const conn = { id: 5, name: "Single", status: "connected" };
      mockApiGetConnection.mockResolvedValue(conn);

      const result = await biApi.getConnection(5);

      expect(result).toEqual(conn);
      expect(mockApiGetConnection).toHaveBeenCalledWith(5);
    });
  });

  // =========================================================================
  // bindTable
  // =========================================================================

  describe("bindTable", () => {
    it("delegates to backend with connectionId and request", async () => {
      mockApiBindTable.mockResolvedValue("Sales");
      const result = await biApi.bindTable(1, { tableName: "Sales" } as any);
      expect(result).toBe("Sales");
      expect(mockApiBindTable).toHaveBeenCalledWith(1, { tableName: "Sales" });
    });
  });
});
