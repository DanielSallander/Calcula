# NPV function

## Introduction

The NPV function calculates the net present value of an investment by using a discount rate and a series of future payments (negative values) and income (positive values). Net present value is a core concept in capital budgeting and investment analysis -- it tells you whether an investment will generate more value than it costs after accounting for the time value of money.

A positive NPV means the investment is expected to be profitable at the given discount rate. A negative NPV means the investment would result in a net loss. NPV is widely used to evaluate business projects, compare investment alternatives, and make go/no-go decisions on capital expenditures.

## Syntax

```
=NPV(rate, value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rate | Required | The rate of discount over the length of one period. |
| value1 | Required | The first cash flow. Values are assumed to occur at the end of each period. |
| value2, ... | Optional | Additional cash flows for subsequent periods. Up to 254 arguments are supported. |

### Important Note on Timing

NPV assumes that all cash flows occur at **equal intervals** and at the **end** of each period. The first cash flow (value1) is discounted one period, the second is discounted two periods, and so on.

If your initial investment occurs at the **beginning** of the first period (time zero, which is typical), do **not** include it in the NPV arguments. Instead, add it separately:

```
=NPV(rate, future_cash_flows) + initial_investment
```

Where initial_investment is a negative number (cash outflow at time zero).

### Sign Conventions

- **Cash outflows** (costs, investments) should be **negative** values.
- **Cash inflows** (revenue, returns) should be **positive** values.

## Example

### Example: Evaluating a business project

A company is considering a project that requires an initial investment of $100,000 and is expected to generate cash flows over 5 years. The company's required rate of return is 10%.

| | A | B |
|---|---|---|
| 1 | **Year** | **Cash Flow** |
| 2 | 0 (Initial) | -$100,000 |
| 3 | 1 | $25,000 |
| 4 | 2 | $30,000 |
| 5 | 3 | $35,000 |
| 6 | 4 | $28,000 |
| 7 | 5 | $22,000 |
| 8 | | |
| 9 | **Discount rate** | 10% |
| 10 | **Formula** | **Result** |
| 11 | =NPV(B9, B3:B7) + B2 | $7,845.51 |

**Result:** $7,845.51

The project has a positive NPV of approximately $7,846, meaning it is expected to generate value above the 10% required return. The company should proceed with the investment.

Note that B2 (the initial investment of -$100,000) is added outside the NPV function because it occurs at time zero (the beginning of the project), not at the end of the first period.

### Remarks

- A common mistake is to include the initial investment inside the NPV function, which would discount it by one period and produce an incorrect result.
- To find the discount rate at which NPV equals zero, use the IRR function.
- NPV assumes cash flows occur at regular intervals. For irregular timing, consider adjusting periods manually.
