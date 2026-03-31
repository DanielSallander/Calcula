# SHEETS function

## Introduction

The SHEETS function returns the number of sheets in a reference or in the entire workbook.

## Syntax

```
=SHEETS([reference])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| reference | Optional | A reference. If omitted, the total number of sheets in the workbook is returned. |

## Remarks

- If reference is omitted, the function returns the count of all sheets in the workbook.
- If a single cell or range reference is provided, the function returns 1.
- In a single-sheet context, the function always returns 1.

## Example

**Formula:** `=SHEETS()`

**Result:** Returns the total number of sheets in the workbook (e.g., **3** if there are 3 sheets).
