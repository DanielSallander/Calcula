# INT function

## Introduction
The INT function rounds a number down to the nearest integer. For positive numbers, it simply removes the decimal portion. For negative numbers, it rounds away from zero toward the more negative integer (e.g., INT(-3.2) returns -4, not -3). INT is commonly used to extract the whole number portion from a value, calculate ages from dates, or determine how many complete units fit a given quantity.

## Syntax
```
=INT(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number you want to round down to the nearest integer. |

## Remarks
- INT always rounds down (toward negative infinity), not toward zero.
- For positive numbers: INT(4.9) = 4.
- For negative numbers: INT(-4.1) = -5 (rounds to the more negative integer).
- To truncate toward zero regardless of sign, use the TRUNC function instead.

## Example

| | A | B |
|---|---|---|
| 1 | **Total Hours** | **Complete Hours** |
| 2 | 37.75 | =INT(A2) |
| 3 | -2.3 | =INT(A3) |

**Results:**
- B2: 37 (the decimal portion is dropped)
- B3: -3 (rounded down toward negative infinity, not toward zero)

For payroll calculations with positive hours, INT reliably extracts the whole-hour component.
