# DELTA function

## Introduction
The DELTA function tests whether two values are equal. It returns 1 if the values are equal and 0 otherwise. This is the Kronecker delta function, commonly used in engineering to filter and test for equality conditions.

## Syntax
```
=DELTA(number1, [number2])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number. |
| number2 | Optional | The second number. If omitted, defaults to 0. |

## Remarks
- If either argument is non-numeric, DELTA returns a #VALUE! error.
- DELTA is useful for summing counts of equal values. Use SUMPRODUCT with DELTA to count matching pairs across ranges.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Value 1** | **Value 2** | **Equal?** |
| 2 | 5 | 5 | =DELTA(A2, B2) |
| 3 | 5 | 4 | =DELTA(A3, B3) |

**Result in C2:** 1 (the values are equal)
**Result in C3:** 0 (the values are not equal)
