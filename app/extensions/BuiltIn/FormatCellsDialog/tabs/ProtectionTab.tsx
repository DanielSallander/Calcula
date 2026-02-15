//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/ProtectionTab.tsx
// PURPOSE: Protection tab for the Format Cells dialog.

import React from "react";
import styled from "styled-components";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";

const v = (name: string) => `var(${name})`;

export function ProtectionTab(): React.ReactElement {
  const { locked, formulaHidden, setLocked, setFormulaHidden } =
    useFormatCellsStore();

  return (
    <Container>
      <Section>
        <CheckboxLabel>
          <input
            type="checkbox"
            checked={locked}
            onChange={(e) => setLocked(e.target.checked)}
          />
          Locked
        </CheckboxLabel>

        <CheckboxLabel>
          <input
            type="checkbox"
            checked={formulaHidden}
            onChange={(e) => setFormulaHidden(e.target.checked)}
          />
          Hidden
        </CheckboxLabel>
      </Section>

      <InfoBox>
        <InfoTitle>About Cell Protection</InfoTitle>
        <InfoText>
          Locking cells or hiding formulas has no effect unless the worksheet is
          protected. To protect the worksheet, use the Review tab and click
          "Protect Sheet." The Locked property prevents cells from being changed.
          The Hidden property hides formulas in the formula bar when the
          worksheet is protected.
        </InfoText>
      </InfoBox>
    </Container>
  );
}

// Styled Components
const Container = styled.div`
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
`;

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: ${v("--text-primary")};
  cursor: pointer;

  input {
    width: 16px;
    height: 16px;
  }
`;

const InfoBox = styled.div`
  padding: 12px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 6px;
`;

const InfoTitle = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${v("--text-primary")};
  margin-bottom: 8px;
`;

const InfoText = styled.div`
  font-size: 12px;
  color: ${v("--text-secondary")};
  line-height: 1.5;
`;
