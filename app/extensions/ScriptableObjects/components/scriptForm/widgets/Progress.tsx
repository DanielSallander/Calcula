//! FILENAME: app/extensions/ScriptableObjects/components/scriptForm/widgets/Progress.tsx
// PURPOSE: The `progress` form widget — a track and an accent-coloured bar
//          with a caption, driven by the spec and by `form.update` patches to
//          `value` / `max` / `text`. Exposes the ARIA progressbar contract so
//          the value is readable without the colour.

import React from "react";
import * as S from "../ScriptFormDialog.styles";

export interface ProgressProps {
  widgetName: string;
  value: number;
  max: number;
  text?: string;
  label?: string;
}

export function Progress({ widgetName, value, max, text, label }: ProgressProps): React.ReactElement {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeValue = Number.isFinite(value) ? Math.min(safeMax, Math.max(0, value)) : 0;
  const percent = (safeValue / safeMax) * 100;
  return (
    <div data-form-widget={widgetName} style={{ minWidth: 0 }}>
      <S.ProgressTrack
        role="progressbar"
        aria-label={label ?? text ?? widgetName}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={safeValue}
      >
        <S.ProgressBar style={{ width: `${percent}%` }} />
      </S.ProgressTrack>
      {text ? <S.ProgressText>{text}</S.ProgressText> : null}
    </div>
  );
}
