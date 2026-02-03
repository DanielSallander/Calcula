//! FILENAME: app/extensions/_standard/conditional-formatting/components/RuleManagerDialog.tsx
// PURPOSE: Dialog for managing conditional formatting rules
// CONTEXT: UI component for creating, editing, reordering, and deleting rules

import React, { useState, useEffect, useCallback } from "react";
import { 
  getRules, 
  addRule, 
  removeRule, 
  updateRule, 
  reorderRules,
  toggleRule,
  generateRuleId,
} from "../index";
import type { ConditionalRule, RuleCondition } from "../types";
import { PRESET_STYLES, COMPARISON_OPERATOR_LABELS, TEXT_OPERATOR_LABELS } from "../types";
import type { IStyleOverride } from "../../../../src/api/styleInterceptors";
import { RuleEditor } from "./RuleEditor";
import { StylePreview } from "./StylePreview";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    fontFamily: "Segoe UI, -apple-system, sans-serif",
    fontSize: "13px",
  },
  header: {
    padding: "12px 16px",
    borderBottom: "1px solid #e0e0e0",
    backgroundColor: "#f5f5f5",
  },
  headerTitle: {
    margin: 0,
    fontSize: "14px",
    fontWeight: 600,
  },
  headerSubtitle: {
    margin: "4px 0 0 0",
    fontSize: "12px",
    color: "#666",
  },
  content: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
  },
  ruleList: {
    width: "300px",
    borderRight: "1px solid #e0e0e0",
    display: "flex",
    flexDirection: "column" as const,
  },
  ruleListHeader: {
    padding: "8px 12px",
    borderBottom: "1px solid #e0e0e0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  ruleListTitle: {
    fontWeight: 600,
    fontSize: "12px",
    textTransform: "uppercase" as const,
    color: "#666",
  },
  ruleListActions: {
    display: "flex",
    gap: "4px",
  },
  ruleListContent: {
    flex: 1,
    overflow: "auto",
    padding: "8px",
  },
  ruleItem: {
    padding: "10px 12px",
    marginBottom: "4px",
    backgroundColor: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: "4px",
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  ruleItemSelected: {
    borderColor: "#0078d4",
    backgroundColor: "#f0f7ff",
  },
  ruleItemDisabled: {
    opacity: 0.5,
  },
  ruleItemName: {
    fontWeight: 500,
    marginBottom: "4px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  ruleItemDescription: {
    fontSize: "11px",
    color: "#666",
  },
  ruleItemRange: {
    fontSize: "10px",
    color: "#999",
    marginTop: "4px",
  },
  editorPanel: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  },
  editorContent: {
    flex: 1,
    padding: "16px",
    overflow: "auto",
  },
  footer: {
    padding: "12px 16px",
    borderTop: "1px solid #e0e0e0",
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
  },
  button: {
    padding: "6px 16px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    backgroundColor: "#fff",
    cursor: "pointer",
    fontSize: "13px",
    transition: "all 0.15s ease",
  },
  buttonPrimary: {
    backgroundColor: "#0078d4",
    borderColor: "#0078d4",
    color: "#fff",
  },
  buttonDanger: {
    color: "#d32f2f",
    borderColor: "#d32f2f",
  },
  iconButton: {
    padding: "4px 8px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    backgroundColor: "#fff",
    cursor: "pointer",
    fontSize: "12px",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#666",
    textAlign: "center" as const,
    padding: "20px",
  },
  emptyStateIcon: {
    fontSize: "48px",
    marginBottom: "16px",
    opacity: 0.3,
  },
  checkbox: {
    width: "16px",
    height: "16px",
    cursor: "pointer",
  },
};

// ============================================================================
// Props
// ============================================================================

export interface RuleManagerDialogProps {
  sheetIndex: number;
  initialSelection?: { startRow: number; startCol: number; endRow: number; endCol: number };
  onClose: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function RuleManagerDialog({ 
  sheetIndex, 
  initialSelection,
  onClose 
}: RuleManagerDialogProps): React.ReactElement {
  const [rules, setRules] = useState<ConditionalRule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<ConditionalRule | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  
  // Load rules on mount and when sheetIndex changes
  useEffect(() => {
    setRules(getRules(sheetIndex));
  }, [sheetIndex]);
  
  // Refresh rules after changes
  const refreshRules = useCallback(() => {
    setRules(getRules(sheetIndex));
  }, [sheetIndex]);
  
  // Handle rule selection
  const handleSelectRule = useCallback((ruleId: string) => {
    setSelectedRuleId(ruleId);
    setIsCreating(false);
    const rule = rules.find(r => r.id === ruleId);
    if (rule) {
      setEditingRule({ ...rule });
    }
  }, [rules]);
  
  // Handle creating new rule
  const handleNewRule = useCallback(() => {
    const defaultRange = initialSelection ?? {
      startRow: 0,
      startCol: 0,
      endRow: 99,
      endCol: 25,
    };
    
    const newRule: ConditionalRule = {
      id: generateRuleId(),
      name: "New Rule",
      enabled: true,
      condition: {
        type: "cellValue",
        operator: "greaterThan",
        value1: 0,
      },
      style: PRESET_STYLES.lightGreenFill,
      range: defaultRange,
    };
    
    setEditingRule(newRule);
    setSelectedRuleId(null);
    setIsCreating(true);
  }, [initialSelection]);
  
  // Handle saving rule
  const handleSaveRule = useCallback(() => {
    if (!editingRule) return;
    
    if (isCreating) {
      addRule(sheetIndex, editingRule);
    } else {
      updateRule(sheetIndex, editingRule.id, editingRule);
    }
    
    refreshRules();
    setIsCreating(false);
    setSelectedRuleId(editingRule.id);
  }, [editingRule, isCreating, sheetIndex, refreshRules]);
  
  // Handle deleting rule
  const handleDeleteRule = useCallback(() => {
    if (!selectedRuleId) return;
    
    removeRule(sheetIndex, selectedRuleId);
    refreshRules();
    setSelectedRuleId(null);
    setEditingRule(null);
  }, [selectedRuleId, sheetIndex, refreshRules]);
  
  // Handle toggling rule
  const handleToggleRule = useCallback((ruleId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    toggleRule(sheetIndex, ruleId);
    refreshRules();
  }, [sheetIndex, refreshRules]);
  
  // Handle moving rule up/down
  const handleMoveRule = useCallback((direction: "up" | "down") => {
    if (!selectedRuleId) return;
    
    const currentIndex = rules.findIndex(r => r.id === selectedRuleId);
    if (currentIndex === -1) return;
    
    const newIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= rules.length) return;
    
    const newOrder = [...rules];
    [newOrder[currentIndex], newOrder[newIndex]] = [newOrder[newIndex], newOrder[currentIndex]];
    
    reorderRules(sheetIndex, newOrder.map(r => r.id));
    refreshRules();
  }, [selectedRuleId, rules, sheetIndex, refreshRules]);
  
  // Handle editing rule changes
  const handleRuleChange = useCallback((updates: Partial<ConditionalRule>) => {
    if (!editingRule) return;
    setEditingRule({ ...editingRule, ...updates });
  }, [editingRule]);
  
  // Format rule description for display
  const formatRuleDescription = (rule: ConditionalRule): string => {
    const condition = rule.condition;
    
    switch (condition.type) {
      case "cellValue": {
        const opLabel = COMPARISON_OPERATOR_LABELS[condition.operator];
        if (condition.operator === "between" || condition.operator === "notBetween") {
          return `Cell value ${opLabel.toLowerCase()} ${condition.value1} and ${condition.value2}`;
        }
        return `Cell value ${opLabel.toLowerCase()} ${condition.value1}`;
      }
      case "text": {
        const opLabel = TEXT_OPERATOR_LABELS[condition.operator];
        return `Text ${opLabel.toLowerCase()} "${condition.value}"`;
      }
      case "top10":
        return `${condition.direction === "top" ? "Top" : "Bottom"} ${condition.count}${condition.percent ? "%" : ""} values`;
      case "aboveAverage":
        return `Values ${condition.direction} average`;
      case "duplicates":
        return condition.unique ? "Unique values" : "Duplicate values";
      case "formula":
        return `Formula: ${condition.formula}`;
      default:
        return "Custom rule";
    }
  };
  
  // Format range for display
  const formatRange = (range: ConditionalRule["range"]): string => {
    const startCol = String.fromCharCode(65 + range.startCol);
    const endCol = String.fromCharCode(65 + range.endCol);
    return `${startCol}${range.startRow + 1}:${endCol}${range.endRow + 1}`;
  };
  
  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.headerTitle}>Conditional Formatting Rules Manager</h2>
        <p style={styles.headerSubtitle}>
          Create and manage rules to highlight cells based on their values
        </p>
      </div>
      
      {/* Content */}
      <div style={styles.content}>
        {/* Rule List */}
        <div style={styles.ruleList}>
          <div style={styles.ruleListHeader}>
            <span style={styles.ruleListTitle}>Rules</span>
            <div style={styles.ruleListActions}>
              <button 
                style={styles.iconButton}
                onClick={handleNewRule}
                title="New Rule"
              >
                +
              </button>
              <button 
                style={styles.iconButton}
                onClick={() => handleMoveRule("up")}
                disabled={!selectedRuleId}
                title="Move Up"
              >
                ^
              </button>
              <button 
                style={styles.iconButton}
                onClick={() => handleMoveRule("down")}
                disabled={!selectedRuleId}
                title="Move Down"
              >
                v
              </button>
            </div>
          </div>
          
          <div style={styles.ruleListContent}>
            {rules.length === 0 ? (
              <div style={styles.emptyState}>
                <div style={styles.emptyStateIcon}>[=]</div>
                <p>No conditional formatting rules</p>
                <button 
                  style={{ ...styles.button, ...styles.buttonPrimary, marginTop: "12px" }}
                  onClick={handleNewRule}
                >
                  Create First Rule
                </button>
              </div>
            ) : (
              rules.map((rule) => (
                <div
                  key={rule.id}
                  style={{
                    ...styles.ruleItem,
                    ...(selectedRuleId === rule.id ? styles.ruleItemSelected : {}),
                    ...(!rule.enabled ? styles.ruleItemDisabled : {}),
                  }}
                  onClick={() => handleSelectRule(rule.id)}
                >
                  <div style={styles.ruleItemName}>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => {}}
                      onClick={(e) => handleToggleRule(rule.id, e)}
                      style={styles.checkbox}
                    />
                    <span>{rule.name || "Unnamed Rule"}</span>
                    <StylePreview style={rule.style} />
                  </div>
                  <div style={styles.ruleItemDescription}>
                    {formatRuleDescription(rule)}
                  </div>
                  <div style={styles.ruleItemRange}>
                    Applies to: {formatRange(rule.range)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        
        {/* Editor Panel */}
        <div style={styles.editorPanel}>
          <div style={styles.editorContent}>
            {editingRule ? (
              <RuleEditor
                rule={editingRule}
                onChange={handleRuleChange}
                isNew={isCreating}
              />
            ) : (
              <div style={styles.emptyState}>
                <p>Select a rule to edit or create a new one</p>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Footer */}
      <div style={styles.footer}>
        {selectedRuleId && !isCreating && (
          <button
            style={{ ...styles.button, ...styles.buttonDanger }}
            onClick={handleDeleteRule}
          >
            Delete Rule
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button style={styles.button} onClick={onClose}>
          Cancel
        </button>
        {editingRule && (
          <button
            style={{ ...styles.button, ...styles.buttonPrimary }}
            onClick={handleSaveRule}
          >
            {isCreating ? "Create Rule" : "Save Changes"}
          </button>
        )}
      </div>
    </div>
  );
}