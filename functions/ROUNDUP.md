# ROUNDUP function

## Introduction
The ROUNDUP function rounds a number up, away from zero, to a specified number of digits. Unlike ROUND, which follows standard rounding rules, ROUNDUP always rounds away from zero regardless of the digit being rounded. This is useful in scenarios where you need conservative estimates, such as calculating material quantities where you must always round up to avoid shortages.

## Syntax
```
=ROUNDUP(number, num_digits)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to round up. |
| num_digits | Required | The number of decimal places to round to. |

### num_digits behavior
- **Positive:** Rounds up to the specified number of decimal places.
- **Zero:** Rounds up to the nearest integer.
- **Negative:** Rounds up to the left of the decimal point (e.g., -1 rounds up to the nearest 10).

## Remarks
- ROUNDUP always rounds away from zero: positive numbers get larger, negative numbers become more negative.
- ROUNDUP(2.01, 0) returns 3, not 2.
- ROUNDUP(-2.01, 0) returns -3, not -2.

## Example

| | A | B |
|---|---|---|
| 1 | **Area (sq ft)** | **Tiles Needed** |
| 2 | 142.3 | =ROUNDUP(A2/12, 0) |

**Result:** 12

If each tile covers 12 square feet, 142.3 / 12 = 11.858. ROUNDUP ensures you purchase 12 tiles rather than rounding down to 11 and falling short.
