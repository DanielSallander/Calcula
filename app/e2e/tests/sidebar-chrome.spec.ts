/**
 * SIDEBAR CHROME — the Calcula Clusters rail and side panel, live.
 *
 * The redesign moved the activity rail onto --activity-bar-* tokens (a LIGHT
 * rail in the Light skin, with a 40px chip and a 3px accent indicator), gave
 * the side panel the one header recipe the ribbon shares (icon, 12px/600
 * sentence-case title, More and Close as IconButtons) and put the move-panel
 * menu behind More as well as behind right-click. The unit tests render each
 * piece in jsdom; this file checks the contracts that only the running app can:
 *
 *   - the active rail item is announced (`aria-current="true"`) and it is the
 *     SAME attribute that paints it, so the two cannot disagree;
 *   - the side panel title is sentence case in the rendered text, not
 *     CSS-uppercased (innerText is what a reader and a screen reader get);
 *   - More toggles the move menu open AND shut — the press on More must not
 *     reach the menu's outside-press listener first, or the click reopens it;
 *   - Escape closes the menu;
 *   - the two new goldens: the rail with nothing open, and the rail with the
 *     Animation panel open (panel content masked — see takeSidebarScreenshot).
 *
 * Leaves the Animation panel CLOSED and in the SIDEBAR, which is how it found
 * them (panel placement is golden-affecting persisted state).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { softly, takeSidebarScreenshot } from "../helpers/screenshots";

const ANIMATION_PANEL_ID = "animation.timeline";

/* eslint-disable @typescript-eslint/naming-convention -- window debug handles the app itself names */
type RegistryWindow = Window & {
  __CALCULA_PANEL_REGISTRY__: {
    setPlacement: (id: string, placement: string) => void;
    resetPlacement: (id: string) => void;
  };
};
/* eslint-enable @typescript-eslint/naming-convention */

async function setAnimationPlacement(page: Page, placement: "sidebar" | "ribbon"): Promise<void> {
  await page.evaluate(
    ({ id, p }) => {
      (window as unknown as RegistryWindow).__CALCULA_PANEL_REGISTRY__.setPlacement(id, p);
    },
    { id: ANIMATION_PANEL_ID, p: placement },
  );
}

/** Back to the declared default with NO override left in the persisted map. */
async function resetAnimationPlacement(page: Page): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as RegistryWindow).__CALCULA_PANEL_REGISTRY__.resetPlacement(id);
  }, ANIMATION_PANEL_ID);
}

async function closeSidePanelIfOpen(page: Page): Promise<void> {
  const panel = page.locator("[data-side-panel]");
  if ((await panel.count()) > 0 && (await panel.first().isVisible())) {
    await panel.first().getByRole("button", { name: "Close panel" }).click();
    await expect(panel).toHaveCount(0);
  }
}

test.describe("Sidebar chrome (Calcula Clusters)", () => {
  test("rail, side panel header and the More menu: announced, sentence case, toggling, Escape", async ({ appPage }) => {
    const page = appPage;
    try {
      await setAnimationPlacement(page, "sidebar");
      await closeSidePanelIfOpen(page);

      const rail = page.locator("[data-activity-bar]");
      await expect(rail).toBeVisible();
      // Nothing is active while no panel is open.
      await expect(rail.locator('button[aria-current="true"]')).toHaveCount(0);
      await softly(takeSidebarScreenshot(page, "activity-bar-default"));

      // Open the Animation panel from the rail.
      const railButton = rail.getByRole("button", { name: "Animation", exact: true });
      await railButton.click();
      const panel = page.locator("[data-side-panel]");
      await expect(panel).toBeVisible({ timeout: 8000 });
      await expect(railButton).toHaveAttribute("aria-current", "true");

      // The header: sentence case as rendered, the one 12px/600 recipe.
      const header = panel.locator(":scope > div").first();
      const titleFacts = await header.evaluate((h) => {
        const spans = Array.from(h.querySelectorAll("span"));
        const title = spans.find((s) => (s.textContent ?? "").trim().length > 0 && !s.querySelector("svg"));
        if (!title) return null;
        const cs = getComputedStyle(title);
        return {
          text: (title as HTMLElement).innerText.trim(),
          raw: (title.textContent ?? "").trim(),
          transform: cs.textTransform,
          size: cs.fontSize,
          weight: cs.fontWeight,
        };
      });
      expect(titleFacts, "the side panel header has no title").not.toBeNull();
      expect(titleFacts!.transform).toBe("none");
      expect(titleFacts!.text, "the rendered title must be the view title, not an uppercased copy").toBe(titleFacts!.raw);
      expect(titleFacts!.size).toBe("12px");
      expect(Number(titleFacts!.weight)).toBeGreaterThanOrEqual(600);

      // More toggles the move menu: open, then SHUT on the second click.
      const more = header.getByRole("button", { name: "More", exact: true });
      await expect(more).toBeVisible();
      await more.click();
      const moveToRibbon = page.getByRole("button", { name: /Move to Ribbon/ });
      await expect(moveToRibbon, "More must open the move-panel menu").toBeVisible();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      await more.click();
      await expect(moveToRibbon, "a second click on More must close the menu, not reopen it").toBeHidden();
      await expect(more).toHaveAttribute("aria-expanded", "false");

      // Escape closes it too.
      await more.click();
      await expect(moveToRibbon).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(moveToRibbon).toBeHidden();

      // Escape handed focus back to More, and a focus ring is not chrome at
      // rest: park focus on nothing before the golden.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await softly(takeSidebarScreenshot(page, "animation-panel"));

      // Close from the header; the rail forgets the active item.
      await panel.getByRole("button", { name: "Close panel" }).click();
      await expect(panel).toHaveCount(0);
      await expect(railButton).not.toHaveAttribute("aria-current", "true");
    } finally {
      await closeSidePanelIfOpen(page);
      await resetAnimationPlacement(page);
    }
  });

  test("the rail paints the active item from aria-current alone", async ({ appPage }) => {
    const page = appPage;
    try {
      await setAnimationPlacement(page, "sidebar");
      await closeSidePanelIfOpen(page);
      const rail = page.locator("[data-activity-bar]");
      const railButton = rail.getByRole("button", { name: "Animation", exact: true });
      const chipBackground = () =>
        railButton.locator("[data-rail-chip]").evaluate((c) => getComputedStyle(c).backgroundColor);

      // Park the pointer off the rail so :hover does not paint the chip.
      await page.mouse.move(640, 400);
      const inactive = await chipBackground();
      await railButton.click();
      await expect(railButton).toHaveAttribute("aria-current", "true");
      await page.mouse.move(640, 400);
      const active = await chipBackground();
      expect(active, "the active chip must be painted differently from an inactive one").not.toBe(inactive);
    } finally {
      await closeSidePanelIfOpen(page);
      await resetAnimationPlacement(page);
    }
  });
});
