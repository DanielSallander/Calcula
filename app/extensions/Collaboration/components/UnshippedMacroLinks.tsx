// FILENAME: app/extensions/Collaboration/components/UnshippedMacroLinks.tsx
// PURPOSE: The buttons on the ticked sheets that run a macro this push does
//          not publish -- each with the remedy that works (M4).
// CONTEXT: A button that links a macro the application does not ship reaches
//          every subscriber dead, or worse, finds a macro of THEIRS under that
//          id. That used to be a warning printed after the version was written;
//          now the push is refused by name (`CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED`)
//          and the preview lists every such button here first:
//            * your own macro       -> tick "Include in application" right here,
//                                      after reading its code;
//            * another application's -> unlink the button (it can never run it);
//            * missing               -> unlink the button, or restore the macro.

import React from "react";
import type { UnshippedMacroLinkItem, WithheldContent } from "@api";
import { describeUnshippedLink } from "../lib/pushReadiness";
import { IncludeControl } from "./WithheldContentList";

const boxStyle: React.CSSProperties = {
  fontSize: "12px",
  margin: "8px 0",
  padding: "6px 8px",
  border: "1px solid #f5c2c7",
  borderRadius: 4,
  background: "#fdf2f2",
};

/**
 * One row per button, and -- for your own macro -- the include tick in place,
 * taken from the withheld list the same preview returned. Renders nothing when
 * every linked macro ships.
 */
export function UnshippedMacroLinks({
  links,
  withheld,
}: {
  links: readonly UnshippedMacroLinkItem[];
  withheld: readonly WithheldContent[];
}): React.ReactElement | null {
  if (links.length === 0) return null;
  return (
    <div data-testid="unshipped-macro-links" style={boxStyle}>
      <div style={{ fontWeight: 600, color: "#c5221f", marginBottom: 4 }}>
        Buttons that run a macro this push leaves out ({links.length})
      </div>
      <div style={{ opacity: 0.75, marginBottom: 4 }}>
        Every subscriber would get a button that does nothing, so the push is refused until each is fixed.
      </div>
      {links.map((link) => {
        const macro =
          link.remedy === "include"
            ? withheld.find((w) => w.kind === "moduleScript" && w.id === link.macroId)
            : undefined;
        return (
          <div key={`${link.kind}-${link.cell}`} data-testid={`unshipped-${link.cell}`} style={{ margin: "2px 0" }}>
            <div>{describeUnshippedLink(link)}</div>
            {macro && <IncludeControl item={macro} scope="link-" />}
          </div>
        );
      })}
    </div>
  );
}
