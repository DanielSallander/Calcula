# PRICEDISC function

## Introduction

The PRICEDISC function returns the price per $100 face value of a discounted security. Discounted securities do not pay periodic interest; instead, they are sold at a price below face value and redeemed at par at maturity. The difference between the purchase price and face value represents the investor's return.

Use PRICEDISC to price Treasury bills, commercial paper, and other money market instruments that trade on a discount basis.

## Syntax

```
=PRICEDISC(settlement, maturity, discount, redemption, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| discount | Required | The security's discount rate. |
| redemption | Required | The security's redemption value per $100 face value. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Discount and redemption must be > 0.
- If basis < 0 or basis > 4, PRICEDISC returns a #NUM! error.

## Example

### Example 1: Treasury bill price

Calculate the price of a discounted security.

| | A | B |
|---|---|---|
| 1 | **Discounted Security Price** | |
| 2 | Settlement date | 2/15/2024 |
| 3 | Maturity date | 8/15/2024 |
| 4 | Discount rate | 5.25% |
| 5 | Redemption | 100 |
| 6 | Basis | 2 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =PRICEDISC(B2, B3, B4, B5, B6) | $97.37 |

**Result:** $97.37

The discounted security is priced at $97.37 per $100 face value. The investor pays $97.37 and receives $100 at maturity, with the $2.63 difference representing the return on the investment.
