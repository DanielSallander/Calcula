//! FILENAME: app/extensions/LinkedSheets/__tests__/manifest.test.ts
// PURPOSE: Tests for LinkedSheets manifest and dialog definitions.

import { describe, it, expect, vi } from "vitest";

// Mock the dialog components so we don't pull in React rendering
vi.mock("../components/PublishDialog", () => ({
  PublishDialog: () => null,
}));
vi.mock("../components/BrowseLinkedDialog", () => ({
  BrowseLinkedDialog: () => null,
}));

import {
  LinkedSheetsManifest,
  PublishDialogDefinition,
  BrowseLinkedDialogDefinition,
  PUBLISH_DIALOG_ID,
  BROWSE_LINKED_DIALOG_ID,
} from "../manifest";

// ============================================================================
// Manifest Tests
// ============================================================================

describe("LinkedSheetsManifest", () => {
  it("has a valid extension ID", () => {
    expect(LinkedSheetsManifest.id).toBe("calcula.linked-sheets");
  });

  it("has all required manifest fields", () => {
    expect(LinkedSheetsManifest.name).toBeTruthy();
    expect(LinkedSheetsManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(LinkedSheetsManifest.description).toBeTruthy();
  });
});

// ============================================================================
// Dialog IDs Tests
// ============================================================================

describe("dialog IDs", () => {
  it("PUBLISH_DIALOG_ID is a non-empty string", () => {
    expect(PUBLISH_DIALOG_ID).toBe("linked-sheets-publish");
  });

  it("BROWSE_LINKED_DIALOG_ID is a non-empty string", () => {
    expect(BROWSE_LINKED_DIALOG_ID).toBe("linked-sheets-browse");
  });

  it("dialog IDs are distinct", () => {
    expect(PUBLISH_DIALOG_ID).not.toBe(BROWSE_LINKED_DIALOG_ID);
  });
});

// ============================================================================
// Dialog Definitions Tests
// ============================================================================

describe("PublishDialogDefinition", () => {
  it("has the correct ID", () => {
    expect(PublishDialogDefinition.id).toBe(PUBLISH_DIALOG_ID);
  });

  it("has a component function", () => {
    expect(typeof PublishDialogDefinition.component).toBe("function");
  });
});

describe("BrowseLinkedDialogDefinition", () => {
  it("has the correct ID", () => {
    expect(BrowseLinkedDialogDefinition.id).toBe(BROWSE_LINKED_DIALOG_ID);
  });

  it("has a component function", () => {
    expect(typeof BrowseLinkedDialogDefinition.component).toBe("function");
  });
});
