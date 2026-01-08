// FILENAME: app/src/components/Ribbon/tabs/FormulasTab/icons.tsx
// PURPOSE: SVG icon components for the Formulas ribbon tab.
// CONTEXT: Contains icons for function categories matching Excel's Formulas tab design.

import React from "react";

/**
 * Insert Function icon (fx)
 */
export function InsertFunctionIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <text
        x="4"
        y="18"
        fontSize="14"
        fontStyle="italic"
        fill="currentColor"
        fontFamily="Times New Roman, serif"
      >
        fx
      </text>
    </svg>
  );
}

/**
 * AutoSum icon (Sigma)
 */
export function AutoSumIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <path
        d="M5 4h14v2H8.5l4 5.5-4 5.5H19v2H5v-2l5-5.5L5 6V4z"
        fill="#4a7ebb"
      />
    </svg>
  );
}

/**
 * Recently Used icon (star)
 */
export function RecentlyUsedIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
        fill="none"
        stroke="#4a7ebb"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Financial icon (dollar with coins)
 */
export function FinancialIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <ellipse
        cx="9"
        cy="17"
        rx="6"
        ry="3"
        fill="none"
        stroke="#5b9a4b"
        strokeWidth="1.5"
      />
      <ellipse
        cx="9"
        cy="14"
        rx="6"
        ry="3"
        fill="none"
        stroke="#5b9a4b"
        strokeWidth="1.5"
      />
      <ellipse
        cx="9"
        cy="11"
        rx="6"
        ry="3"
        fill="none"
        stroke="#5b9a4b"
        strokeWidth="1.5"
      />
      <path d="M15 11v6" stroke="#5b9a4b" strokeWidth="1.5" />
      <path d="M3 11v6" stroke="#5b9a4b" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Logical icon (question mark in box)
 */
export function LogicalIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="2"
        fill="none"
        stroke="#9966cc"
        strokeWidth="1.5"
      />
      <text
        x="12"
        y="17"
        fontSize="14"
        fill="#9966cc"
        textAnchor="middle"
        fontFamily="Arial, sans-serif"
        fontWeight="bold"
      >
        ?
      </text>
    </svg>
  );
}

/**
 * Text icon (letter A)
 */
export function TextIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="2"
        fill="none"
        stroke="#c44"
        strokeWidth="1.5"
      />
      <text
        x="12"
        y="17"
        fontSize="14"
        fill="#c44"
        textAnchor="middle"
        fontFamily="Arial, sans-serif"
        fontWeight="bold"
      >
        A
      </text>
    </svg>
  );
}

/**
 * Date & Time icon (clock)
 */
export function DateTimeIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="8"
        fill="none"
        stroke="#cc6633"
        strokeWidth="1.5"
      />
      <path
        d="M12 7v5l3 3"
        stroke="#cc6633"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Lookup & Reference icon (magnifying glass)
 */
export function LookupIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <circle
        cx="10"
        cy="10"
        r="6"
        fill="none"
        stroke="#3399cc"
        strokeWidth="1.5"
      />
      <path
        d="M14.5 14.5L20 20"
        stroke="#3399cc"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Math & Trig icon (theta symbol)
 */
export function MathTrigIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="2"
        fill="none"
        stroke="#339966"
        strokeWidth="1.5"
      />
      <text
        x="12"
        y="17"
        fontSize="13"
        fill="#339966"
        textAnchor="middle"
        fontFamily="Times New Roman, serif"
      >
        {"\u03B8"}
      </text>
    </svg>
  );
}

/**
 * More Functions icon (three dots)
 */
export function MoreFunctionsIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="2"
        fill="none"
        stroke="#993333"
        strokeWidth="1.5"
      />
      <circle cx="8" cy="12" r="1.5" fill="#993333" />
      <circle cx="12" cy="12" r="1.5" fill="#993333" />
      <circle cx="16" cy="12" r="1.5" fill="#993333" />
    </svg>
  );
}

/**
 * Calculator icon for calculation options
 */
export function CalculatorIcon(): React.ReactElement {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="16" y1="10" x2="16" y2="10" />
      <line x1="12" y1="10" x2="12" y2="10" />
      <line x1="8" y1="10" x2="8" y2="10" />
      <line x1="16" y1="14" x2="16" y2="14" />
      <line x1="12" y1="14" x2="12" y2="14" />
      <line x1="8" y1="14" x2="8" y2="14" />
      <line x1="16" y1="18" x2="16" y2="18" />
      <line x1="12" y1="18" x2="12" y2="18" />
      <line x1="8" y1="18" x2="8" y2="18" />
    </svg>
  );
}