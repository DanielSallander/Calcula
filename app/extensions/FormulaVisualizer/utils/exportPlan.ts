//! FILENAME: app/extensions/FormulaVisualizer/utils/exportPlan.ts
// PURPOSE: Export the formula evaluation plan as readable YAML text.

import type { FormulaEvalPlan } from "../../../src/api";

export function formatPlanAsYaml(plan: FormulaEvalPlan): string {
  const lines: string[] = [];

  lines.push(`formula: "${plan.formulaText}"`);
  lines.push(`total_steps: ${plan.steps.length}`);
  lines.push("");

  // Build node map for child lookups
  const nodeMap = new Map(plan.nodes.map((n) => [n.id, n]));

  lines.push("evaluation_steps:");
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const node = nodeMap.get(step.nodeId);
    if (!node) continue;

    lines.push(`  - step: ${i + 1}`);
    lines.push(`    operation: ${node.label}`);
    lines.push(`    type: ${node.nodeType}`);
    if (node.subtitle) {
      lines.push(`    arguments: "${node.subtitle}"`);
    }
    lines.push(`    result: ${node.value}`);
    if (node.rawValue != null) {
      lines.push(`    raw_value: ${node.rawValue}`);
    }
    lines.push(`    description: "${step.description}"`);
  }

  lines.push("");
  lines.push("expression_tree:");
  // Render tree starting from root
  const root = nodeMap.get(plan.rootId);
  if (root) {
    renderTreeNode(root, nodeMap, lines, "  ");
  }

  return lines.join("\n");
}

function renderTreeNode(
  node: { id: string; label: string; nodeType: string; subtitle: string; value: string; children: string[]; stepNumber?: number },
  nodeMap: Map<string, typeof node>,
  lines: string[],
  indent: string,
): void {
  const stepLabel = node.stepNumber != null ? ` (#${node.stepNumber})` : "";
  lines.push(`${indent}- ${node.label}${stepLabel}:`);
  lines.push(`${indent}    type: ${node.nodeType}`);
  if (node.subtitle) {
    lines.push(`${indent}    details: "${node.subtitle}"`);
  }
  if (node.value) {
    lines.push(`${indent}    value: ${node.value}`);
  }
  if (node.children.length > 0) {
    lines.push(`${indent}    children:`);
    for (const childId of node.children) {
      const child = nodeMap.get(childId);
      if (child) {
        renderTreeNode(child, nodeMap, lines, indent + "      ");
      }
    }
  }
}
