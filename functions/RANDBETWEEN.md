# RANDBETWEEN function

## Introduction
The RANDBETWEEN function returns a random integer between two specified values (inclusive on both ends). It is simpler than using RAND with arithmetic when you need whole numbers within a defined range. Common uses include generating random test data, simulating dice rolls, creating random IDs, and selecting random samples from numbered lists.

## Syntax
```
=RANDBETWEEN(bottom, top)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| bottom | Required | The smallest integer the function can return. |
| top | Required | The largest integer the function can return. |

## Remarks
- RANDBETWEEN is volatile: it recalculates each time the worksheet recalculates.
- If **bottom** > **top**, RANDBETWEEN returns a #NUM! error.
- Both **bottom** and **top** are inclusive -- the returned value can equal either endpoint.
- Non-integer arguments are truncated to integers.

## Example

| | A | B |
|---|---|---|
| 1 | **Employee** | **Random Group (1-5)** |
| 2 | Alice | =RANDBETWEEN(1, 5) |
| 3 | Bob | =RANDBETWEEN(1, 5) |
| 4 | Carol | =RANDBETWEEN(1, 5) |

**Result:** Each employee is randomly assigned a group number between 1 and 5 (e.g., 3, 1, 5). Values change on each recalculation.
