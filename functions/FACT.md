# FACT function

## Introduction
The FACT function returns the factorial of a number. The factorial of n (written as n!) is the product of all positive integers from 1 to n. Factorials are fundamental in combinatorics, probability theory, and statistical distributions. They are used in permutation calculations, series expansions, and various mathematical models.

## Syntax
```
=FACT(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The non-negative integer whose factorial you want. |

## Remarks
- If **number** is negative, FACT returns a #NUM! error.
- If **number** is not an integer, it is truncated to an integer before calculation.
- FACT(0) returns 1 (by mathematical convention, 0! = 1).
- Large values of **number** produce very large results (e.g., FACT(20) = 2,432,902,008,176,640,000).
- If **number** is non-numeric, FACT returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **n** | **n!** |
| 2 | 5 | =FACT(A2) |
| 3 | 0 | =FACT(A3) |
| 4 | 10 | =FACT(A4) |

**Results:**
- B2: 120 (5! = 5 x 4 x 3 x 2 x 1)
- B3: 1 (0! = 1 by definition)
- B4: 3628800 (10! = 10 x 9 x 8 x ... x 1)
