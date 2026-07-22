//! FILENAME: app/extensions/Charts/components/DesignQueryEditor.tsx
// PURPOSE: Charts adapter around the shared design-query Monaco editor. Fetches
//   the selected connection's BI model (for autocomplete) via the Charts backend
//   channel, then delegates rendering to the shared _shared editor.

import React, { useEffect, useState } from "react";
import { DesignQueryEditor as SharedDesignQueryEditor } from "../../_shared/dsl/pivotLayout/DesignQueryEditor";
import { buildControlHints } from "../../_shared/dsl/pivotLayout/controlHints";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { chartsBackend } from "../lib/chartsBackend";

interface DesignQueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The BI connection whose model drives autocomplete (may be empty). */
  connectionId: string;
}

export function DesignQueryEditor({
  value,
  onChange,
  connectionId,
}: DesignQueryEditorProps): React.ReactElement {
  const [biModel, setBiModel] = useState<BiPivotModelInfo | null>(null);
  // Charts support @param binding like reports — offer the same @-completion.
  const [controlHints] = useState(() => buildControlHints());

  useEffect(() => {
    let cancelled = false;
    if (!connectionId) {
      setBiModel(null);
      return;
    }
    chartsBackend
      .invoke<BiPivotModelInfo | null>("get_connection_bi_model", { connectionId })
      .then((m) => {
        if (!cancelled) setBiModel(m ?? null);
      })
      .catch(() => {
        if (!cancelled) setBiModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  return (
    <SharedDesignQueryEditor
      value={value}
      onChange={onChange}
      biModel={biModel}
      controlHints={controlHints}
      height="220px"
    />
  );
}
