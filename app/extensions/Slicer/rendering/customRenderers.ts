//! FILENAME: app/extensions/Slicer/rendering/customRenderers.ts
// PURPOSE: Registry for custom slicer item renderers from scriptable objects.
// CONTEXT: Allows user scripts to override how individual slicer items are drawn.

/** Custom item renderer function signature. */
export type SlicerItemRendererFn = (
  item: { text: string; selected: boolean; hasData: boolean; index: number },
  ctx: CanvasRenderingContext2D,
  bounds: { x: number; y: number; width: number; height: number },
) => void;

/** Canvas-style property overrides for a slicer. */
export interface SlicerStyleOverrides {
  backgroundColor?: string;
  headerBackgroundColor?: string;
  headerTextColor?: string;
  itemBackgroundColor?: string;
  itemTextColor?: string;
  selectedBackgroundColor?: string;
  selectedTextColor?: string;
  borderColor?: string;
  borderRadius?: number;
  opacity?: number;
}

// ---- Registry ----

const itemRenderers = new Map<string, SlicerItemRendererFn>();
const styleOverrides = new Map<string, SlicerStyleOverrides>();

/** Register a custom item renderer for a specific slicer. */
export function setSlicerItemRenderer(slicerId: string, renderer: SlicerItemRendererFn | null): () => void {
  if (renderer) {
    itemRenderers.set(slicerId, renderer);
  } else {
    itemRenderers.delete(slicerId);
  }
  return () => itemRenderers.delete(slicerId);
}

/** Get the custom item renderer for a slicer (or null for default). */
export function getSlicerItemRenderer(slicerId: string): SlicerItemRendererFn | null {
  return itemRenderers.get(slicerId) ?? null;
}

/** Set a style override property for a slicer. */
export function setSlicerStyleOverride(slicerId: string, name: string, value: string): void {
  let overrides = styleOverrides.get(slicerId);
  if (!overrides) {
    overrides = {};
    styleOverrides.set(slicerId, overrides);
  }
  (overrides as Record<string, string>)[name] = value;
}

/** Get all style overrides for a slicer. */
export function getSlicerStyleOverrides(slicerId: string): SlicerStyleOverrides | null {
  return styleOverrides.get(slicerId) ?? null;
}

/** Clear all custom renderers and overrides. */
export function clearCustomRenderers(): void {
  itemRenderers.clear();
  styleOverrides.clear();
}
