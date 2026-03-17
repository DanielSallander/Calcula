# INDIRECT function

## Introduction

The INDIRECT function returns the reference specified by a text string. It converts a text representation of a cell address into an actual cell reference, allowing you to dynamically construct references within formulas.

Use INDIRECT when you need to build cell references from text values, such as when referencing different sheets dynamically, creating references based on user input, or constructing range addresses by concatenating row and column identifiers. It is particularly powerful for building summary sheets that pull data from multiple worksheets.

## Syntax

```
=INDIRECT(ref_text, [a1])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| ref_text | Required | A text string that represents a cell reference, a range, or a defined name. |
| a1 | Optional | A logical value that specifies the reference style. TRUE or omitted uses A1-style; FALSE uses R1C1-style. |

## Remarks

- If ref_text is not a valid cell reference, INDIRECT returns a #REF! error.
- INDIRECT is a volatile function, meaning it recalculates every time the worksheet recalculates, which can impact performance in large workbooks.
- When referencing another sheet, include the sheet name in the text string (e.g., `"Sheet2!A1"`).
- Changes to the worksheet structure (inserting/deleting rows or columns) do not update the text string inside INDIRECT, which can be both an advantage and a risk.

## Example

| | A | B |
|---|---|---|
| 1 | **Cell Address** | **Value** |
| 2 | B5 | =INDIRECT(A2) |
| 3 | | |
| 4 | | |
| 5 | | 100 |

**Result (B2):** 100

The formula reads the text "B5" from A2, converts it to a reference to cell B5, and returns the value 100 stored there.
