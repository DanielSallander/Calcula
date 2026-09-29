//! FILENAME: app/extensions/Charts/lib/chartDeleteAnnounce.ts
// PURPOSE: Announce `chart:deleted` only for a delete the BACKEND accepted.
// CONTEXT: Wave-B B7. `performChartDeleteLanded` (index.ts) emitted
//          CHART_DELETED as soon as it asked for the delete, before the
//          backend answered. `delete_chart` refuses on a sheet whose
//          protection does not allow editing objects, and the store then puts
//          the chart back -- so every listener (the extension's own region
//          sync, and any extension subscribed to the public event) had been
//          told about a deletion that never happened. The store's promise
//          (`deleteChart`) resolves to null when the delete landed and to the
//          refusal reason otherwise; the announcement waits for it.

/**
 * Pass `landed` through, calling `announce` once when -- and only when -- it
 * resolves to null (the delete landed). A refusal (a reason) announces nothing.
 */
export function announceWhenDeleteLands(
  landed: Promise<string | null>,
  announce: () => void,
): Promise<string | null> {
  return landed.then((reason) => {
    if (reason === null) announce();
    return reason;
  });
}
