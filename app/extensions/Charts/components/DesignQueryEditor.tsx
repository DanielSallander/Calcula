//! FILENAME: app/extensions/Charts/components/DesignQueryEditor.tsx
// PURPOSE: Charts adapter around the shared design-query Monaco editor. Fetches
//   the selected connection's BI model (for autocomplete) via the Charts backend
//   channel, then delegates rendering to the shared _shared editor.

import React, { useEffect, useState } from "react";
import { DesignQueryEditor as SharedDesignQueryEditor } from "../../_shared/dsl/pivotLayout/DesignQueryEditor";
import { buildControlHints } from "../../_shared/dsl/pivotLayout/controlHints";
import type { DesignQueryRequest } from "../../_shared/dsl/pivotLayout/designQuery";
import type { DryRunSummary } from "../../_shared/dsl/pivotLayout/draft";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { chartsBackend } from "../lib/chartsBackend";

interface DesignQueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The BI connection whose model drives autocomplete (may be empty). */
  connectionId: string;
  /**
   * Size the editor to the query between two bounds (the object pane's Design
   * tab: a narrow pane where a fixed 220px box is mostly void). Omitted, the
   * editor keeps its fixed 220px (the chart dialog).
   */
  autoHeight?: { min: number; max: number };
}

export function DesignQueryEditor({
  value,
  onChange,
  connectionId,
  autoHeight,
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
      autoHeight={autoHeight}
      assist={{ connectionId, dryRun: dryRunDesignQuery }}
    />
  );
}

/** The dry run over the Charts door: the size of the view, nothing materialised. */
async function dryRunDesignQuery(request: DesignQueryRequest): Promise<DryRunSummary> {
  const view = await chartsBackend.invoke<{ rowCount: number; colCount: number }>("run_design_query", { request });
  return { rowCount: view?.rowCount ?? 0, colCount: view?.colCount ?? 0 };
}
