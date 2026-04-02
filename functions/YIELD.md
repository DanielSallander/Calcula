# YIELD function

## Introduction

The YIELD function returns the yield to maturity of a security that pays periodic interest. Yield to maturity is the total annual return an investor earns if they purchase a bond at its current market price and hold it until maturity, assuming all coupon payments are reinvested at the same rate.

Use YIELD to evaluate the return on a bond investment, compare different bonds, or determine whether a bond's market price offers an acceptable return.

## Syntax

```
=YIELD(settlement, maturity, rate, pr, redemption, frequency, [basis])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| settlement | Required | The security's settlement date. |
| maturity | Required | The security's maturity date. |
| rate | Required | The security's annual coupon rate. |
| pr | Required | The security's price per $100 face value. |
| redemption | Required | The security's redemption value per $100 face value. |
| frequency | Required | The number of coupon payments per year. 1 = annual, 2 = semi-annual, 4 = quarterly. |
| basis | Optional | The day count basis to use. 0 or omitted = US (NASD) 30/360, 1 = Actual/actual, 2 = Actual/360, 3 = Actual/365, 4 = European 30/360. |

### Remarks

- Settlement must be before maturity.
- Rate must be >= 0. Pr and redemption must be > 0.
- Frequency must be 1, 2, or 4.
- If basis < 0 or basis > 4, YIELD returns a #NUM! error.
- YIELD is calculated through iteration and may not converge for all inputs. If it cannot find a result, it returns a #NUM! error.

## Example

### Example 1: Bond yield to maturity

Calculate the yield on a bond purchased at a premium.

| | A | B |
|---|---|---|
| 1 | **Bond Yield** | |
| 2 | Settlement date | 3/15/2024 |
| 3 | Maturity date | 3/15/2034 |
| 4 | Coupon rate | 6.00% |
| 5 | Price | $104.50 |
| 6 | Redemption | 100 |
| 7 | Frequency | 2 |
| 8 | Basis | 0 |
| 9 | | |
| 10 | **Formula** | **Result** |
| 11 | =YIELD(B2, B3, B4, B5, B6, B7, B8) | 5.49% |

**Result:** 5.49%

The bond purchased at $104.50 (a premium) yields 5.49% to maturity. The yield is lower than the 6% coupon rate because the investor pays more than par value and will receive only $100 at maturity, reducing the overall return.
