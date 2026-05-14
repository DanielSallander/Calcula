//! FILENAME: app/extensions/BusinessIntelligence/lib/__tests__/biApi.test.ts
// PURPOSE: Tests for BI API caching layer and state management.

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

describe("BI API caching layer", () => {
  let biApi: typeof import("../bi-api");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    biApi = await import("../bi-api");
  });

  // =========================================================================
  // Cache state
  // =========================================================================

  describe("cache state", () => {
    it("starts with null caches", () => {
      expect(biApi.getCachedConnections()).toBeNull();
      expect(biApi.getCachedQueryResult()).toBeNull();
      expect(biApi.getCachedQueryRequest()).toBeNull();
      expect(biApi.getCachedActiveConnectionId()).toBeNull();
    });

    it("setCachedActiveConnectionId sets and gets", () => {
      biApi.setCachedActiveConnectionId(42);
      expect(biApi.getCachedActiveConnectionId()).toBe(42);

      biApi.setCachedActiveConnectionId(null);
      expect(biApi.getCachedActiveConnectionId()).toBeNull();
    });
  });

  // =========================================================================
  // Connection Management
  // =========================================================================

  describe("createConnection", () => {
    it("calls backend and invalidates cache", async () => {
      const connInfo = { id: 1, name: "Test", connectionString: "sqlite://test.db", status: "disconnected" };
      mockApiCreateConnection.mockResolvedValue(connInfo);

      const result = await biApi.createConnection({ name: "Test", connectionString: "sqlite://test.db" } as any);

      expect(result).toEqual(connInfo);
      expect(mockApiCreateConnection).toHaveBeenCalledOnce();
      // Cache should be invalidated
      expect(biApi.getCachedConnections()).toBeNull();
    });
  });

  describe("deleteConnection", () => {
    it("calls backend and invalidates cache", async () => {
      mockApiDeleteConnection.mockResolvedValue(undefined);
      await biApi.deleteConnection(1);
      expect(mockApiDeleteConnection).toHaveBeenCalledWith(1);
    });

    it("clears active connection ID if deleting the active one", async () => {
      mockApiDeleteConnection.mockResolvedValue(undefined);
      biApi.setCachedActiveConnectionId(5);

      await biApi.deleteConnection(5);

      expect(biApi.getCachedActiveConnectionId()).toBeNull();
    });

    it("preserves active connection ID if deleting a different one", async () => {
      mockApiDeleteConnection.mockResolvedValue(undefined);
      biApi.setCachedActiveConnectionId(5);

      await biApi.deleteConnection(99);

      expect(biApi.getCachedActiveConnectionId()).toBe(5);
    });
  });

  describe("getConnections", () => {
    it("fetches from backend and populates cache", async () => {
      const connections = [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ];
      mockApiGetConnections.mockResolvedValue(connections);

      const result = await biApi.getConnections();

      expect(result).toEqual(connections);
      expect(biApi.getCachedConnections()).toEqual(connections);
    });
  });

  describe("connect / disconnect", () => {
    it("connect invalidates connection cache", async () => {
      const conn = { id: 1, status: "connected" };
      mockApiConnect.mockResolvedValue(conn);

      const result = await biApi.connect(1);

      expect(result).toEqual(conn);
      expect(mockApiConnect).toHaveBeenCalledWith({ connectionId: 1 });
      expect(biApi.getCachedConnections()).toBeNull();
    });

    it("disconnect invalidates connection cache", async () => {
      const conn = { id: 1, status: "disconnected" };
      mockApiDisconnect.mockResolvedValue(conn);

      const result = await biApi.disconnect(1);

      expect(result).toEqual(conn);
      expect(mockApiDisconnect).toHaveBeenCalledWith(1);
    });
  });

  // =========================================================================
  // Query & Insert
  // =========================================================================

  describe("query", () => {
    it("caches query result, request, and active connection ID", async () => {
      const queryResult = { columns: ["a"], rows: [[1]] };
      const queryRequest = { tableName: "Sales" };
      mockApiQuery.mockResolvedValue(queryResult);

      const result = await biApi.query(7, queryRequest as any);

      expect(result).toEqual(queryResult);
      expect(biApi.getCachedQueryResult()).toEqual(queryResult);
      expect(biApi.getCachedQueryRequest()).toEqual(queryRequest);
      expect(biApi.getCachedActiveConnectionId()).toBe(7);
    });
  });

  describe("insertResult", () => {
    it("throws if no cached query result exists", async () => {
      await expect(biApi.insertResult({} as any)).rejects.toThrow(
        "No query result to insert",
      );
    });

    it("passes cached result and request to backend", async () => {
      // First execute a query to populate cache
      const queryResult = { columns: ["x"], rows: [[1]] };
      const queryRequest = { tableName: "T" };
      mockApiQuery.mockResolvedValue(queryResult);
      await biApi.query(1, queryRequest as any);

      const insertReq = { sheetIndex: 0, startRow: 0, startCol: 0 };
      const insertResp = { rowsInserted: 1 };
      mockApiInsertResult.mockResolvedValue(insertResp);

      const result = await biApi.insertResult(insertReq as any);

      expect(result).toEqual(insertResp);
      expect(mockApiInsertResult).toHaveBeenCalledWith(
        insertReq,
        queryResult,
        queryRequest,
      );
    });
  });

  // =========================================================================
  // Refresh
  // =========================================================================

  describe("refreshConnection", () => {
    it("invalidates connection cache", async () => {
      mockApiRefreshConnection.mockResolvedValue([]);
      // Populate cache first
      mockApiGetConnections.mockResolvedValue([{ id: 1 }]);
      await biApi.getConnections();
      expect(biApi.getCachedConnections()).not.toBeNull();

      await biApi.refreshConnection(1);

      expect(biApi.getCachedConnections()).toBeNull();
    });
  });

  describe("refreshAllInMemory", () => {
    it("delegates to backend", async () => {
      mockApiRefreshAllInMemory.mockResolvedValue(["Sales", "Products"]);

      const result = await biApi.refreshAllInMemory(1);

      expect(result).toEqual(["Sales", "Products"]);
      expect(mockApiRefreshAllInMemory).toHaveBeenCalledWith(1);
    });
  });

  // =========================================================================
  // Model Info & Region Check
  // =========================================================================

  describe("getModelInfo", () => {
    it("delegates to backend", async () => {
      const model = { tables: [] };
      mockApiGetModelInfo.mockResolvedValue(model);

      const result = await biApi.getModelInfo(1);

      expect(result).toEqual(model);
    });

    it("handles null return", async () => {
      mockApiGetModelInfo.mockResolvedValue(null);
      const result = await biApi.getModelInfo(99);
      expect(result).toBeNull();
    });
  });

  describe("getRegionAtCell", () => {
    it("delegates to backend with row and col", async () => {
      const region = { connectionId: 1, tableName: "Sales" };
      mockApiGetRegionAtCell.mockResolvedValue(region);

      const result = await biApi.getRegionAtCell(5, 10);

      expect(result).toEqual(region);
      expect(mockApiGetRegionAtCell).toHaveBeenCalledWith(5, 10);
    });

    it("returns null when no region at cell", async () => {
      mockApiGetRegionAtCell.mockResolvedValue(null);
      const result = await biApi.getRegionAtCell(0, 0);
      expect(result).toBeNull();
    });
  });
});

// =========================================================================
// biEvents constants
// =========================================================================

describe("BiEvents", () => {
  it("has expected event keys", async () => {
    const { BiEvents } = await import("../biEvents");
    expect(BiEvents.CONNECTION_CREATED).toBe("app:bi-connection-created");
    expect(BiEvents.CONNECTION_DELETED).toBe("app:bi-connection-deleted");
    expect(BiEvents.QUERY_EXECUTED).toBe("app:bi-query-executed");
    expect(BiEvents.RESULT_INSERTED).toBe("app:bi-result-inserted");
    expect(BiEvents.REFRESHED).toBe("app:bi-refreshed");
  });

  it("all values are unique", async () => {
    const { BiEvents } = await import("../biEvents");
    const values = Object.values(BiEvents);
    expect(new Set(values).size).toBe(values.length);
  });
});
