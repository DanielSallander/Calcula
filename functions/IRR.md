# IRR function

## Introduction

The IRR function returns the internal rate of return for a series of cash flows represented by values in an array. The internal rate of return is the discount rate at which the net present value (NPV) of all cash flows equals zero. In other words, IRR tells you the annualized effective compounded return rate of an investment.

IRR is one of the most important metrics in capital budgeting and investment analysis. It allows you to compare the profitability of different investments on an equal basis. A project with an IRR higher than the company's cost of capital is generally considered a good investment.

## Syntax

```
=IRR(values, [guess])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| values | Required | A range or array of values containing the cash flows. The values must contain at least one positive and one negative number. Cash flows are assumed to occur at regular intervals. |
| guess | Optional | A number that you guess is close to the result of IRR. If omitted, 0.1 (10%) is used as the default guess. |

### Sign Conventions

- **Cash outflows** (investments, costs) must be **negative** values.
- **Cash inflows** (returns, revenue) must be **positive** values.

The values array must contain at least one negative and one positive value for IRR to calculate.

### Remarks

- IRR uses an iterative technique to find the rate. Starting with the guess, IRR cycles through the calculation until the result is accurate within 0.00001%. If IRR cannot find a result after 20 iterations, the #NUM! error is returned.
- If IRR returns #NUM!, try a different value for guess.
- The cash flows in values are assumed to occur at equal intervals (e.g., monthly or annually).
- IRR is closely related to NPV. The IRR is the rate at which NPV equals zero: NPV(IRR, values) = 0.

## Example

### Example: Evaluating a real estate investment

An investor purchases a rental property and projects the following annual cash flows over 5 years:

| | A | B |
|---|---|---|
| 1 | **Year** | **Cash Flow** |
| 2 | 0 | -$250,000 |
| 3 | 1 | $42,000 |
| 4 | 2 | $45,000 |
| 5 | 3 | $48,000 |
| 6 | 4 | $50,000 |
| 7 | 5 | $310,000 |
| 8 | | |
| 9 | **Formula** | **Result** |
| 10 | =IRR(B2:B7) | 18.5% |

**Result:** Approximately 18.5%

The investment has an internal rate of return of about 18.5%. Year 0 represents the purchase price (-$250,000). Years 1-4 represent net rental income. Year 5 includes both rental income and the proceeds from selling the property ($50,000 rent + $260,000 sale = $310,000).

If the investor's required return is 12%, this investment exceeds the threshold and is worth pursuing.

### Example: Comparing two projects

| | A | B | C |
|---|---|---|---|
| 1 | **Year** | **Project A** | **Project B** |
| 2 | 0 | -$100,000 | -$100,000 |
| 3 | 1 | $40,000 | $10,000 |
| 4 | 2 | $40,000 | $20,000 |
| 5 | 3 | $40,000 | $90,000 |
| 6 | | |
| 7 | **IRR** | =IRR(B2:B5) | =IRR(C2:C5) |
| 8 | **Result** | 9.7% | 5.2% |

Project A has a higher IRR (9.7%) than Project B (5.2%), making it the more attractive investment based on this metric.
