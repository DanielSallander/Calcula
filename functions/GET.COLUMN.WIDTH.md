# GET.COLUMN.WIDTH function

## Introduction

The GET.COLUMN.WIDTH function returns the width in pixels of a specified column. This is a Calcula-specific function that is not available in Microsoft Excel or other spreadsheet applications.

Use GET.COLUMN.WIDTH when you need to reference column dimensions in your formulas, such as for layout calculations, responsive dashboard design, or determining whether content might be truncated in a cell. This function is helpful when building templates that adjust dynamically based on column sizing.

## Syntax

```
=GET.COLUMN.WIDTH(col)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| col | Required | The column number (1-indexed) for which you want to retrieve the width. Column 1 corresponds to column A, column 2 to column B, and so on. |

### Remarks

- The col argument is 1-indexed. Column 1 is column A, column 2 is column B, etc.
- If the specified column has not been customized, the function returns the default column width of 100 pixels.
- If the column number is less than 1 or not a valid number, the function returns an error.
- This function is specific to Calcula and will not work in Excel or other spreadsheet applications. Workbooks using this function may not be fully compatible when exported.

## Example

| | A | B |
|---|---|---|
| 1 | **Column** | **Width (px)** |
| 2 | 1 (A) | =GET.COLUMN.WIDTH(1) |
| 3 | 2 (B) | =GET.COLUMN.WIDTH(2) |
| 4 | 3 (C) | =GET.COLUMN.WIDTH(3) |

Assuming column A has been widened to 200 pixels and column C narrowed to 60 pixels, with column B at the default:

| | A | B |
|---|---|---|
| 1 | **Column** | **Width (px)** |
| 2 | 1 (A) | 200 |
| 3 | 2 (B) | 100 |
| 4 | 3 (C) | 60 |

**Result:** Column A returns 200 (custom width), column B returns 100 (default), and column C returns 60 (custom width).

### Compatibility Note

This is a Calcula-specific function. It is not available in Microsoft Excel, Google Sheets, or LibreOffice Calc. Workbooks that use this function should be used within Calcula to ensure correct behavior.
