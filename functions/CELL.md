# CELL function

## Introduction
The CELL function returns information about the formatting, location, or contents of a cell. It is useful for creating dynamic formulas that adapt based on cell properties such as address, row number, or column number.

## Syntax
```
=CELL(info_type, [reference])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| info_type | Required | A text string specifying the type of information. |
| reference | Optional | The cell to get information about. If omitted, uses the last changed cell. |

## Remarks
- Common info_type values: "ADDRESS" (cell address), "COL" (column number), "ROW" (row number), "CONTENTS" (cell value), "FILENAME" (file path), "TYPE" (cell type: "l" for label, "v" for value, "b" for blank).
- info_type is not case-sensitive.
- If reference is a range, CELL returns information about the first cell (top-left).

## Example

| | A | B |
|---|---|---|
| 1 | **Data** | **Info** |
| 2 | Hello | =CELL("TYPE", A2) |
| 3 | 42 | =CELL("COL", A3) |

**Result:** B2 = "l" (label/text), B3 = 1 (column A)
