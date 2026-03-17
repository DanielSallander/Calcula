# SUM function

## Introduction
The SUM function adds all the numbers in a range of cells or a set of values. It is one of the most commonly used functions in any spreadsheet, useful for totaling columns of financial data, aggregating quantities, or combining any set of numeric values.

SUM automatically ignores text values, logical values, and empty cells within a referenced range, making it robust for use in mixed-data environments such as invoices, budgets, and inventory sheets.

## Syntax
```
=SUM(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range to add. |
| number2, ... | Optional | Additional numbers, cell references, or ranges to add. Up to 255 arguments. |

## Remarks
- Cells that contain text, logical values (TRUE/FALSE), or are empty are ignored when part of a range reference.
- If an argument is an error value (e.g., #VALUE!, #REF!), SUM returns that error.
- If a text value is passed directly as an argument (not as a cell reference), SUM returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Region** | **Sales** |
| 2 | North | 15000 |
| 3 | South | 22000 |
| 4 | East | 18500 |
| 5 | West | 19700 |
| 6 | **Total** | =SUM(B2:B5) |

**Result:** 75200

The formula adds all four regional sales figures to produce a company-wide total.
