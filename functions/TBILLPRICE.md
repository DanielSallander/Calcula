# TBILLPRICE function

## Introduction

The TBILLPRICE function returns the price per $100 face value for a Treasury bill. Treasury bills are sold at a discount and redeemed at face value; this function calculates the dollar price based on the discount rate and days to maturity.

Use TBILLPRICE to determine the purchase price of a Treasury bill given its discount rate.

## Syntax

```
=TBILLPRICE(settlement, maturity, discount)
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
- If any argument is invalid, TBILLPRICE returns a #NUM! error.

## Example

### Example 1: Treasury bill price

| | A | B |
|---|---|---|
| 1 | **T-Bill Price** | |
| 2 | Settlement date | 3/15/2024 |
| 3 | Maturity date | 9/15/2024 |
| 4 | Discount rate | 5.25% |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =TBILLPRICE(B2, B3, B4) | $97.32 |

**Result:** $97.32

A Treasury bill with a 5.25% discount rate and approximately 184 days to maturity is priced at $97.32 per $100 face value. The investor pays $97.32 and receives $100 at maturity, with the $2.68 difference representing the return.
