# SHEET function

## Introduction

The SHEET function returns the sheet number of a referenced sheet or the current sheet. Sheet numbers correspond to the order of tabs in the workbook.

## Syntax

```
=SHEET([value])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Optional | A reference or sheet name. If omitted, the current sheet number is returned. |

## Remarks

- If value is omitted, the function returns the number of the current sheet.
- If value is a text string, it is treated as a sheet name.
- If the sheet is not found, #N/A is returned.
- In a single-sheet context, the function always returns 1.

## Example

**Formula:** `=SHEET()`

**Result:** Returns the number of the current sheet (e.g., **1** for the first sheet).
