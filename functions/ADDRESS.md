# ADDRESS function

## Introduction

The ADDRESS function creates a cell address as a text string, given a row number and column number. You can specify whether the address should use absolute or relative references and whether it should use A1 or R1C1 reference style.

Use ADDRESS when you need to dynamically construct cell references as text, typically in combination with INDIRECT to create fully dynamic references. It is useful for building formulas that adapt to changing row and column positions, generating reference strings for reporting, or creating cross-sheet references programmatically.

## Syntax

```
=ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| row_num | Required | The row number to use in the cell address. |
| column_num | Required | The column number to use in the cell address. |
| abs_num | Optional | Specifies the reference type. Default is 1 (absolute). |
| a1 | Optional | A logical value. TRUE or omitted uses A1-style; FALSE uses R1C1-style. |
| sheet_text | Optional | The name of the worksheet to include in the address. If omitted, no sheet name is included. |

### abs_num values

| Value | Reference Type | Example |
|-------|---------------|---------|
| 1 | Absolute row and column (default) | $A$1 |
| 2 | Absolute row, relative column | A$1 |
| 3 | Relative row, absolute column | $A1 |
| 4 | Relative row and column | A1 |

## Remarks

- If row_num or column_num is less than 1, ADDRESS returns a #VALUE! error.
- When sheet_text contains spaces or special characters, ADDRESS automatically wraps it in single quotes (e.g., `'My Sheet'!A1`).

## Example

| | A | B |
|---|---|---|
| 1 | **Row** | **Column** |
| 2 | 3 | 2 |
| 3 | | |
| 4 | **Result** | =ADDRESS(A2, B2) |

**Result (B4):** "$B$3"

The formula creates an absolute cell reference for row 3, column 2, producing the text string "$B$3".
