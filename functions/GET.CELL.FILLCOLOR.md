# GET.CELL.FILLCOLOR function

## Introduction

The GET.CELL.FILLCOLOR function returns the background fill color of a specified cell as a CSS color string. This is a Calcula-specific function that is not available in Microsoft Excel or other spreadsheet applications.

Use GET.CELL.FILLCOLOR when you need to programmatically read the background color of a cell. This is useful for building conditional logic based on cell formatting, creating formatting audit tools, or developing dashboards that react to color-coded data. For example, you might use this function to check whether a cell has been highlighted in red as a warning indicator.

## Syntax

```
=GET.CELL.FILLCOLOR(cell_ref)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| cell_ref | Required | A reference to the cell whose background fill color you want to retrieve. This should be a single cell reference (e.g., A1, B5). |

### Remarks

- The function returns the color as a CSS color string. This may be in hex format (e.g., `#FF0000` for red) or rgba format (e.g., `rgba(255, 0, 0, 1)`), depending on how the color was applied.
- If the cell has no custom background color (i.e., uses the default fill), the function returns an empty string or the default background color value.
- The cell_ref should reference a single cell. If a range is provided, the behavior may be undefined.
- This function reads the current formatting state. If the cell's fill color changes (e.g., through conditional formatting or user action), the function result updates accordingly.
- This function is specific to Calcula and will not work in Excel or other spreadsheet applications.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Cell** | **Fill Color** | **Status** |
| 2 | (red background) | =GET.CELL.FILLCOLOR(A2) | =IF(B2="#FF0000", "Alert", "OK") |
| 3 | (green background) | =GET.CELL.FILLCOLOR(A3) | =IF(B3="#FF0000", "Alert", "OK") |
| 4 | (no fill) | =GET.CELL.FILLCOLOR(A4) | =IF(B4="#FF0000", "Alert", "OK") |

| | A | B | C |
|---|---|---|---|
| 1 | **Cell** | **Fill Color** | **Status** |
| 2 | | #FF0000 | Alert |
| 3 | | #00FF00 | OK |
| 4 | | | OK |

**Result:** The formula in B2 returns `#FF0000` (red), B3 returns `#00FF00` (green), and B4 returns an empty string (no custom fill). The Status column uses this information to flag cells with a red background as "Alert."

### Practical Use Case

This function bridges the gap between visual formatting and formula logic. In traditional spreadsheets, cell colors are purely visual and cannot be referenced in formulas. GET.CELL.FILLCOLOR allows you to create formulas that respond to formatting, enabling use cases such as:

- Auditing color-coded spreadsheets
- Validating that status indicators match expected values
- Building summary reports based on color-coded categories

### Compatibility Note

This is a Calcula-specific function. It is not available in Microsoft Excel, Google Sheets, or LibreOffice Calc. Workbooks that use this function should be used within Calcula to ensure correct behavior.
