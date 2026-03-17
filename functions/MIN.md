# MIN function

## Introduction
The MIN function returns the smallest numeric value from a set of values or a range of cells. It is useful for identifying the lowest data point in a series, such as the minimum order value, the coldest temperature, or the lowest bid in a procurement process.

MIN ignores empty cells, text, and logical values within range references.

## Syntax
```
=MIN(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range to examine. |
| number2, ... | Optional | Additional numbers, references, or ranges. Up to 255 arguments. |

## Remarks
- Text and logical values in cell references are ignored.
- If arguments contain no numeric values, MIN returns 0.
- Error values in arguments cause MIN to return an error.
- Logical values and text representations of numbers typed directly as arguments are evaluated.

## Example

| | A | B |
|---|---|---|
| 1 | **Supplier** | **Quote ($)** |
| 2 | Acme Corp | 12500 |
| 3 | Beta LLC | 11800 |
| 4 | Gamma Inc | 13200 |
| 5 | Delta Co | 10950 |
| 6 | **Lowest Bid** | =MIN(B2:B5) |

**Result:** 10950

The formula returns 10,950, the lowest supplier quote (Delta Co), helping identify the most competitive bid.
