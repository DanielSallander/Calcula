# OFFSET function

## Introduction

The OFFSET function returns a reference to a range that is a specified number of rows and columns from a starting cell or range. You can also specify the height and width of the returned range.

Use OFFSET to create dynamic ranges that shift based on calculated positions. It is frequently used in dynamic named ranges, chart data sources that automatically expand, and formulas that need to reference a range relative to a known anchor point. OFFSET is a volatile function, so it recalculates on every worksheet change.

## Syntax

```
=OFFSET(reference, rows, cols, [height], [width])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| reference | Required | The starting cell or range from which the offset is applied. |
| rows | Required | The number of rows to move from the reference. Positive moves down, negative moves up. |
| cols | Required | The number of columns to move from the reference. Positive moves right, negative moves left. |
| height | Optional | The number of rows in the returned range. If omitted, uses the same height as reference. |
| width | Optional | The number of columns in the returned range. If omitted, uses the same width as reference. |

## Remarks

- OFFSET does not physically move cells; it returns a reference to a new location.
- If the resulting reference is outside the worksheet boundaries, OFFSET returns a #REF! error.
- Height and width must be positive numbers. A value of 0 or negative returns a #REF! error.
- OFFSET is a volatile function and recalculates every time the worksheet recalculates, which can affect performance.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | 10 | 20 | 30 |
| 2 | 40 | 50 | 60 |
| 3 | 70 | 80 | 90 |
| 4 | | | |
| 5 | **Result** | =OFFSET(A1, 2, 1) | |

**Result (B5):** 80

The formula starts at A1, moves 2 rows down and 1 column to the right, landing on cell B3 which contains 80.
