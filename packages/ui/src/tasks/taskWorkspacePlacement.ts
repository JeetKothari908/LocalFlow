import { MapDirection } from "./taskMapLayout";

type Rect = { left: number; right: number; top: number; bottom: number };

/** Dock in the center gap when possible; on small screens, leave the clicked row free. */
export function taskWorkspacePlacement(
  origin: Rect,
  row: Rect,
  direction: MapDirection,
  viewport: { width: number; height: number },
  oppositePanel?: Rect,
) {
  const margin = 16;
  const height = Math.min(300, viewport.height / 3);
  const maxTop = viewport.height - height - margin;
  // Keep the dashboard controls accessible even when a task begins at the very top.
  const clampTop = (top: number) =>
    Math.max(Math.min(64, maxTop), Math.min(top, maxTop));
  const available =
    direction === "left"
      ? origin.left - (oppositePanel?.right ?? 0) - margin * 2
      : (oppositePanel?.left ?? viewport.width) - origin.right - margin * 2;
  if (available >= 220) {
    const width = Math.min(600, available);
    return {
      left:
        direction === "left"
          ? origin.left - width - margin
          : origin.right + margin,
      top: clampTop(row.top),
      width,
      height,
    };
  }
  const width = Math.min(600, viewport.width - margin * 2);
  const above = row.top - margin;
  const below = viewport.height - row.bottom - margin;
  return {
    left: Math.max(
      margin,
      Math.min(origin.left, viewport.width - width - margin),
    ),
    top: clampTop(
      above >= below ? row.top - height - margin : row.bottom + margin,
    ),
    width,
    height,
  };
}
