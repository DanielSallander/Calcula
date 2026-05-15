//! FILENAME: app/extensions/JsonView/lib/useJsonToggle.ts
// PURPOSE: Shared React hook for Phase C — GUI/JSON toggle on config panels.
// CONTEXT: Manages json mode state, fetches JSON on toggle-on, applies on request.

import { useState, useCallback, useRef } from "react";
import { getObjectJson, setObjectJson } from "@api/jsonView";

export interface UseJsonToggleResult {
  /** Whether we're in JSON editing mode. */
  isJsonMode: boolean;
  /** Toggle between GUI and JSON mode. */
  toggle: () => void;
  /** Current JSON text in editor. */
  json: string;
  /** Update the JSON text (from editor onChange). */
  setJson: (value: string) => void;
  /** Apply the current JSON to the backend. Returns true on success. */
  apply: () => Promise<boolean>;
  /** Revert to last-fetched JSON. */
  revert: () => void;
  /** Whether the JSON has been modified since last fetch. */
  dirty: boolean;
  /** Current error message (syntax or apply error), or null. */
  error: string | null;
  /** Whether an async operation is in progress. */
  loading: boolean;
}

/**
 * Hook for managing GUI/JSON toggle state on a config panel.
 *
 * @param objectType - e.g. "chart", "table", "slicer"
 * @param objectId - The object's ID as a string
 * @param onApplied - Optional callback invoked after successful apply (to refresh GUI state)
 */
export function useJsonToggle(
  objectType: string,
  objectId: string,
  onApplied?: () => void,
): UseJsonToggleResult {
  const [isJsonMode, setIsJsonMode] = useState(false);
  const [json, setJson] = useState("");
  const [originalJson, setOriginalJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dirty = json !== originalJson;

  const toggle = useCallback(async () => {
    if (!isJsonMode) {
      // Entering JSON mode: fetch current JSON
      setLoading(true);
      setError(null);
      try {
        const fetched = await getObjectJson(objectType, objectId);
        setJson(fetched);
        setOriginalJson(fetched);
        setIsJsonMode(true);
      } catch (err) {
        setError(`Failed to load JSON: ${String(err)}`);
      } finally {
        setLoading(false);
      }
    } else {
      // Leaving JSON mode
      setIsJsonMode(false);
      setError(null);
    }
  }, [isJsonMode, objectType, objectId]);

  const apply = useCallback(async (): Promise<boolean> => {
    // Validate syntax
    try {
      JSON.parse(json);
    } catch {
      setError("Invalid JSON syntax");
      return false;
    }

    setLoading(true);
    try {
      await setObjectJson(objectType, objectId, json);
      setOriginalJson(json);
      setError(null);
      onApplied?.();
      return true;
    } catch (err) {
      setError(`Apply failed: ${String(err)}`);
      return false;
    } finally {
      setLoading(false);
    }
  }, [objectType, objectId, json, onApplied]);

  const revert = useCallback(() => {
    setJson(originalJson);
    setError(null);
  }, [originalJson]);

  const handleSetJson = useCallback((value: string) => {
    setJson(value);
    // Validate syntax on change
    try {
      JSON.parse(value);
      setError(null);
    } catch (e) {
      if (e instanceof SyntaxError) {
        setError(`Syntax: ${e.message}`);
      }
    }
  }, []);

  return {
    isJsonMode,
    toggle,
    json,
    setJson: handleSetJson,
    apply,
    revert,
    dirty,
    error,
    loading,
  };
}
