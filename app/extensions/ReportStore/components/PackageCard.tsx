//! FILENAME: app/extensions/ReportStore/components/PackageCard.tsx
// PURPOSE: Card component displaying package metadata in the browse dialog.

import React from "react";
import type { PackageInfo } from "@api/distribution";

interface PackageCardProps {
  pkg: PackageInfo;
  onImport: (pkg: PackageInfo) => void;
}

export const PackageCard: React.FC<PackageCardProps> = ({ pkg, onImport }) => {
  const contentSummary = pkg.contents
    .map((c) => `${c.name} (${c.type})`)
    .join(", ");

  const displayName = pkg.name || pkg.id || "Unnamed Package";

  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: 6,
        padding: "14px 16px",
        marginBottom: 8,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        backgroundColor: "#fafafa",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <strong style={{ fontSize: 14, color: "#222" }}>{displayName}</strong>
          <span style={{ fontSize: 12, color: "#777" }}>v{pkg.version}</span>
          {pkg.author && (
            <span style={{ fontSize: 12, color: "#777" }}>by {pkg.author}</span>
          )}
        </div>
        {pkg.description && (
          <div style={{ fontSize: 13, color: "#555", marginBottom: 4 }}>
            {pkg.description}
          </div>
        )}
        {pkg.id && pkg.id !== displayName && (
          <div style={{ fontSize: 11, color: "#999", marginBottom: 4 }}>
            {pkg.id}
          </div>
        )}
        <div style={{ fontSize: 12, color: "#777" }}>
          Contents: {contentSummary || "empty"}
        </div>
        {pkg.tags.length > 0 && (
          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
            {pkg.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 3,
                  backgroundColor: "#e8e8e8",
                  color: "#555",
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {pkg.dataSources.length > 0 && (
          <div style={{ fontSize: 12, color: "#b87c00", marginTop: 6 }}>
            Requires {pkg.dataSources.length} data source{pkg.dataSources.length > 1 ? "s" : ""} to be configured
          </div>
        )}
      </div>
      <button
        onClick={() => onImport(pkg)}
        style={{
          padding: "6px 20px",
          borderRadius: 4,
          border: "none",
          backgroundColor: "#0078d4",
          color: "#fff",
          cursor: "pointer",
          marginLeft: 12,
          whiteSpace: "nowrap",
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        Import
      </button>
    </div>
  );
};
