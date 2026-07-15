//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/FormulaAutocompleteOverlay.styles.ts
// PURPOSE: Styled-components for the formula autocomplete dropdown and argument hints.
// CONTEXT: Uses the same theme token pattern as the rest of the codebase.

import styled, { css } from "styled-components";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Dropdown item content pieces (declared first so DropdownItem can reference
// them in its `$isSelected` descendant styling below).
// ============================================================================

export const FunctionNameContainer = styled.span`
  font-weight: 600;
  font-size: 12px;
  color: ${v("--text-primary")};
  grid-column: 1;
  grid-row: 1;
  font-family: "Consolas", "Courier New", monospace;
`;

export const CategoryTag = styled.span`
  font-size: 10px;
  color: ${v("--text-secondary")};
  background: ${v("--bg-surface-disabled")};
  padding: 1px 5px;
  border-radius: 3px;
  grid-column: 2;
  grid-row: 1;
  align-self: center;
  white-space: nowrap;
`;

export const Description = styled.span`
  font-size: 11px;
  color: ${v("--text-secondary")};
  grid-column: 1 / -1;
  grid-row: 2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
`;

export const MatchHighlight = styled.span`
  color: ${v("--accent-color")};
  font-weight: 700;
`;

// ============================================================================
// Dropdown Container & Items
// ============================================================================

export const DropdownContainer = styled.div`
  position: fixed;
  z-index: 10000;
  background: ${v("--bg-surface")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  overflow-y: auto;
  padding: 2px 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
`;

// The keyboard/active selection must read at a glance, and must be clearly
// distinct from a plain mouse hover. A hovered-but-not-selected row gets a
// subtle tint; the selected row gets a solid accent fill with inverted text
// and a bright left indicator bar. (The overlay also moves selection to the
// row under the pointer, so a hovered row usually IS the selected row.)
export const DropdownItem = styled.div<{ $isSelected: boolean }>`
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  background: transparent;
  border-left: 3px solid transparent;

  &:hover {
    background: ${v("--accent-color-light")};
  }

  ${(p) =>
    p.$isSelected &&
    css`
      background: ${v("--accent-color")};
      border-left-color: rgba(255, 255, 255, 0.9);

      /* Keep the strong fill even while the pointer is over this row. */
      &:hover {
        background: ${v("--accent-color")};
      }

      ${FunctionNameContainer} {
        color: #ffffff;
      }
      ${Description} {
        color: rgba(255, 255, 255, 0.88);
      }
      ${CategoryTag} {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.22);
      }
      /* On the accent fill the accent-colored match text would vanish; make it
         legible with a white underline instead. */
      ${MatchHighlight} {
        color: #ffffff;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
    `}
`;

// ============================================================================
// Argument Hint Tooltip (intellisense card)
// ============================================================================

export const ArgumentHintContainer = styled.div`
  position: fixed;
  z-index: 10001;
  background: ${v("--bg-surface")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 7px 10px;
  max-width: 360px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
`;

export const SignatureLine = styled.div`
  font-family: "Consolas", "Courier New", monospace;
  font-size: 12px;
  color: ${v("--text-secondary")};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const FnName = styled.span`
  font-weight: 700;
  color: ${v("--text-primary")};
`;

// The active argument is rendered as a filled chip so the user can see at a
// glance which parameter they are currently entering.
export const ActiveArg = styled.span`
  font-weight: 700;
  color: #ffffff;
  background: ${v("--accent-color")};
  border-radius: 3px;
  padding: 0 4px;
`;

export const InactiveArg = styled.span`
  color: ${v("--text-secondary")};
`;

export const ActiveParamLabel = styled.div`
  margin-top: 5px;
  font-size: 11px;
  color: ${v("--text-primary")};
`;

export const ParamOptionalNote = styled.span`
  margin-left: 5px;
  font-size: 10px;
  font-style: italic;
  color: ${v("--text-tertiary")};
`;

export const HintDescription = styled.div`
  margin-top: 5px;
  font-size: 11px;
  line-height: 1.35;
  color: ${v("--text-secondary")};
  white-space: normal;
`;
