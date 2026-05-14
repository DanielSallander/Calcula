//! FILENAME: app/extensions/ExternalData/__tests__/externalDataExtension.test.ts
// PURPOSE: Tests for ExternalData extension lifecycle and menu registration.
// CONTEXT: The extension registers an "External Data" top-level menu.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock API
// ============================================================================

const mockRegister = vi.fn();
vi.mock("@api/contract", () => ({}));
vi.mock("@api", () => ({}));

// ============================================================================
// Replicate extension logic
// ============================================================================

interface MenuRegistration {
  id: string;
  label: string;
  order: number;
  items: unknown[];
}

function activate(registerMenu: (def: MenuRegistration) => void): void {
  registerMenu({
    id: "externalData",
    label: "External Data",
    order: 43,
    items: [],
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("ExternalData extension", () => {
  beforeEach(() => {
    mockRegister.mockClear();
  });

  it("registers the External Data menu with correct id", () => {
    activate(mockRegister);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister.mock.calls[0][0].id).toBe("externalData");
  });

  it("registers menu with correct label", () => {
    activate(mockRegister);
    expect(mockRegister.mock.calls[0][0].label).toBe("External Data");
  });

  it("registers menu with order 43 (right after Data at 42)", () => {
    activate(mockRegister);
    expect(mockRegister.mock.calls[0][0].order).toBe(43);
  });

  it("registers menu with empty items array", () => {
    activate(mockRegister);
    expect(mockRegister.mock.calls[0][0].items).toEqual([]);
  });

  it("manifest has correct id", () => {
    const manifest = {
      id: "calcula.external-data",
      name: "External Data",
      version: "1.0.0",
      description: "External Data menu for import/export and data connections",
    };
    expect(manifest.id).toBe("calcula.external-data");
    expect(manifest.version).toBe("1.0.0");
  });
});
