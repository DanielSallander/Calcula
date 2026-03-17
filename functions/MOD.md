# MOD function

## Introduction
The MOD function returns the remainder after dividing a number by a divisor. It is useful for determining divisibility, creating alternating patterns (e.g., shading every other row), cycling through values, and extracting positional components from numbers. In business applications, MOD helps with scheduling cycles, periodic calculations, and data validation.

## Syntax
```
=MOD(number, divisor)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number for which you want the remainder (dividend). |
| divisor | Required | The number by which you want to divide (must not be zero). |

## Remarks
- If **divisor** is 0, MOD returns a #DIV/0! error.
- The result of MOD has the same sign as the divisor.
- MOD can be expressed as: `number - divisor * INT(number/divisor)`.

## Example

| | A | B |
|---|---|---|
| 1 | **Invoice #** | **Is Even?** |
| 2 | 1047 | =MOD(A2, 2)=0 |
| 3 | 1048 | =MOD(A3, 2)=0 |

**Results:**
- B2: FALSE (1047 is odd, remainder is 1)
- B3: TRUE (1048 is even, remainder is 0)

The formula checks whether an invoice number is even by testing if the remainder when divided by 2 is zero.
