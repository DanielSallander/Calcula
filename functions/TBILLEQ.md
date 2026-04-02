# TBILLEQ function

## Introduction

The TBILLEQ function returns the bond-equivalent yield for a Treasury bill. Treasury bills are quoted on a discount basis, but the bond-equivalent yield converts this to an annualized yield based on a 365-day year, making it comparable to coupon bond yields.

Use TBILLEQ to compare Treasury bill returns with bond returns on an equivalent basis.

## Syntax

```
=TBILLEQ(settlement, maturity, discount)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The Treasury bill's settlement date. |
| maturity | Required | The Treasury bill's maturity date. Must be within one year of settlement. |
| discount | Required | The Treasury bill's discount rate. |

### Remarks

- Settlement must be before maturity.
- Maturity cannot be more than one year after settlement.
- Discount must be > 0.
- If any argument is invalid, TBILLEQ returns a #NUM! error.

## Example

### Example 1: Bond-equivalent yield of a T-bill

| | A | B |
|---|---|---|
| 1 | **T-Bill Bond-Equivalent Yield** | |
| 2 | Settlement date | 3/15/2024 |
| 3 | Maturity date | 6/15/2024 |
| 4 | Discount rate | 5.00% |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =TBILLEQ(B2, B3, B4) | 5.13% |

**Result:** 5.13%

The bond-equivalent yield of 5.13% is higher than the 5.00% discount rate. This is because the discount rate is based on face value, while the bond-equivalent yield is based on the purchase price, which is lower. The conversion allows direct comparison with coupon bond yields.
