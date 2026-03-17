# GET.ROW.HEIGHT function

## Introduction

The GET.ROW.HEIGHT function returns the height in pixels of a specified row. This is a Calcula-specific function that is not available in Microsoft Excel or other spreadsheet applications.

Use GET.ROW.HEIGHT when you need to dynamically reference row dimensions in your formulas, such as for layout calculations, conditional formatting logic based on row sizing, or building dashboards that adapt to custom row heights. This function is particularly useful in templates that need to be aware of their own geometry.

## Syntax

```
=GET.ROW.HEIGHT(row)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| row | Required | The row number (1-indexed) for which you want to retrieve the height. Row 1 is the first row of the spreadsheet. |

### Remarks

- The row argument is 1-indexed. Row 1 corresponds to the first row of the spreadsheet.
- If the specified row has not been customized, the function returns the default row height of 24 pixels.
- If the row number is less than 1 or not a valid number, the function returns an error.
- This function is specific to Calcula and will not work in Excel or other spreadsheet applications. Workbooks using this function may not be fully compatible when exported.

## Example

| | A | B |
|---|---|---|
| 1 | **Row** | **Height (px)** |
| 2 | 1 | =GET.ROW.HEIGHT(1) |
| 3 | 2 | =GET.ROW.HEIGHT(2) |
| 4 | 5 | =GET.ROW.HEIGHT(5) |

Assuming row 1 has been resized to 40 pixels and all other rows use the default height:

| | A | B |
|---|---|---|
| 1 | **Row** | **Height (px)** |
| 2 | 1 | 40 |
| 3 | 2 | 24 |
| 4 | 5 | 24 |

**Result:** Row 1 returns 40 (its custom height), while rows 2 and 5 return 24 (the default height).

### Compatibility Note

This is a Calcula-specific function. It is not available in Microsoft Excel, Google Sheets, or LibreOffice Calc. Workbooks that use this function should be used within Calcula to ensure correct behavior.
