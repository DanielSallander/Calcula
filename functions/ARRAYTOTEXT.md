# ARRAYTOTEXT function

## Introduction
The ARRAYTOTEXT function converts an array of values into a single text string. It is useful for displaying the contents of a range or dynamic array as a readable text representation, particularly for debugging or reporting purposes.

## Syntax
```
=ARRAYTOTEXT(array, [format])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The array or range to convert to text. |
| format | Optional | 0 = concise format (default) with comma-separated values, 1 = strict format with braces, semicolons, and quoted strings. |

## Remarks
- In concise format (0), values are separated by commas and spaces.
- In strict format (1), the output uses array literal syntax with curly braces, commas for columns, and semicolons for rows.
- Empty cells are represented as empty strings in strict format.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | 10 | 20 | 30 |
| 2 | **Result** | =ARRAYTOTEXT(A1:C1, 0) | |

**Result:** B2 = "10, 20, 30"
