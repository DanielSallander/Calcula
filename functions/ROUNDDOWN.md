# ROUNDDOWN function

## Introduction
The ROUNDDOWN function rounds a number down, toward zero, to a specified number of digits. Unlike ROUND, which uses standard rounding rules, ROUNDDOWN always truncates toward zero. This is useful when you need to ensure values are not overestimated, such as calculating available inventory, determining how many complete units fit in a space, or conservative financial projections.

## Syntax
```
=ROUNDDOWN(number, num_digits)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to round down. |
| num_digits | Required | The number of decimal places to round to. |

### num_digits behavior
- **Positive:** Rounds down to the specified number of decimal places.
- **Zero:** Rounds down to the nearest integer.
- **Negative:** Rounds down to the left of the decimal point (e.g., -1 rounds down to the nearest 10).

## Remarks
- ROUNDDOWN always rounds toward zero: positive numbers get smaller, negative numbers become less negative.
- ROUNDDOWN(2.99, 0) returns 2.
- ROUNDDOWN(-2.99, 0) returns -2.

## Example

| | A | B |
|---|---|---|
| 1 | **Total Budget** | **Full Units Affordable** |
| 2 | 9750 | =ROUNDDOWN(A2/400, 0) |

**Result:** 24

With a budget of 9,750 and a unit cost of 400, you can afford 9750/400 = 24.375 units. ROUNDDOWN gives 24, reflecting the maximum number of complete units purchasable.
