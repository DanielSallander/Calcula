# SUMIF function

## Introduction
The SUMIF function adds the values in a range that meet a single condition. It is particularly useful for conditional totaling, such as summing sales for a specific product, totaling expenses in a particular category, or aggregating values that exceed a threshold.

SUMIF supports wildcard characters (* and ?) in text criteria and comparison operators (>, <, >=, <=, <>) in numeric criteria, giving you flexibility in defining which cells to include in the sum.

## Syntax
```
=SUMIF(range, criteria, [sum_range])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| range | Required | The range of cells to evaluate against the criteria. |
| criteria | Required | The condition that determines which cells to sum. Can be a number, expression, text string, or cell reference. |
| sum_range | Optional | The actual cells to sum. If omitted, the cells in **range** are summed. |

### Criteria examples
- A number: `100` matches cells equal to 100.
- A comparison: `">100"` matches cells greater than 100.
- Text: `"Apples"` matches cells containing the text "Apples".
- Wildcards: `"A*"` matches any text starting with "A".

## Remarks
- If **sum_range** is provided, it must have the same dimensions as **range**. Only the top-left cell of **sum_range** is used to determine the actual range to sum.
- Empty cells in **range** are treated as zero values.
- Criteria are case-insensitive for text comparisons.

## Example

| | A | B |
|---|---|---|
| 1 | **Category** | **Amount** |
| 2 | Rent | 2500 |
| 3 | Utilities | 350 |
| 4 | Rent | 2500 |
| 5 | Groceries | 600 |
| 6 | Utilities | 400 |
| 7 | **Total Rent** | =SUMIF(A2:A6, "Rent", B2:B6) |

**Result:** 5000

The formula sums only the amounts in column B where the corresponding category in column A is "Rent".
