# CUBEKPIMEMBER function

## Introduction

The CUBEKPIMEMBER function returns a property of a Key Performance Indicator (KPI) defined in a Calcula BI model — its current value, its goal/target, or its status. KPIs bundle a base measure, a target, and status bands so a single name carries "how are we doing" semantics; CUBEKPIMEMBER surfaces those pieces into cells.

Use CUBEKPIMEMBER to drive a scorecard: show the KPI's value, its goal, and a status indicator (on/off track) side by side.

## Syntax

```
=CUBEKPIMEMBER(connection, kpi_name, kpi_property, [caption])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| connection | Required | The name of a Calcula BI connection (e.g. `"Sales"`). Unknown name returns `#NAME?`. |
| kpi_name | Required | The name of a KPI defined in the model (e.g. `"Revenue KPI"`). |
| kpi_property | Required | Which property to return: `1` = Value, `2` = Goal, `3` = Status. |
| caption | Optional | A text caption to display instead of the default. |

## Remarks

- `kpi_property` is an integer: `1` returns the KPI's current value (its base measure), `2` returns the goal/target (a constant or a measure), and `3` returns the status computed from value vs. goal via the KPI's status bands.
- Excel's properties `4` (Trend), `5` (Weight), and `6` (CurrentTimeMember) are not modeled in v1 and return `#N/A`.
- The KPI's status (property `3`) is derived from the model's configured bands (e.g. "On Track", "At Risk").
- An unknown KPI name, or a disconnected model, returns `#N/A`.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | =CUBEKPIMEMBER("Sales", "Revenue KPI", 1) | =CUBEKPIMEMBER("Sales", "Revenue KPI", 2) | =CUBEKPIMEMBER("Sales", "Revenue KPI", 3) |

**Result:** A1 is the KPI's value, B1 its goal, C1 its status.

The three cells form a compact scorecard for the Revenue KPI: where it stands, where it should be, and whether it is on track.
