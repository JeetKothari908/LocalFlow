export type RecoveryRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** Try beside the controls, skipping occupied widgets to the right; wrap if needed. */
export function recoveryPlacement(
  anchor: RecoveryRect,
  obstacles: RecoveryRect[],
  viewport: { width: number; height: number },
  panelHeight: number,
) {
  const margin = 16,
    gap = 12;
  const maxWidth = Math.min(460, viewport.width - margin * 2);
  const minWidth = Math.min(260, maxWidth);
  const height = Math.min(panelHeight, viewport.height - margin * 2);
  const firstTop = Math.max(margin, anchor.top);
  const rows = [
    firstTop,
    ...new Set([
      anchor.bottom + gap,
      ...obstacles.map((item) => item.bottom + gap),
    ]),
  ].filter(
    (top) => top >= firstTop && top + height <= viewport.height - margin,
  );
  for (const [index, top] of rows.entries()) {
    let left = index ? margin : Math.max(margin, anchor.right + gap);
    for (let attempt = 0; attempt <= obstacles.length; attempt++) {
      let width = Math.min(maxWidth, viewport.width - margin - left);
      if (width < minWidth) break;
      const nextObstacle = obstacles
        .filter(
          (item) =>
            item.left > left && item.bottom > top && item.top < top + height,
        )
        .sort((a, b) => a.left - b.left)[0];
      if (nextObstacle && nextObstacle.left - gap - left >= minWidth)
        width = Math.min(width, nextObstacle.left - gap - left);
      const occupied = obstacles.filter(
        (item) =>
          item.right > left &&
          item.left < left + width &&
          item.bottom > top &&
          item.top < top + height,
      );
      if (!occupied.length) return { left, top, width };
      left = Math.max(...occupied.map((item) => item.right)) + gap;
    }
  }
  // A crowded/narrow viewport still needs an accessible, scrollable recovery panel.
  return {
    left: margin,
    top: Math.min(
      anchor.bottom + gap,
      Math.max(margin, viewport.height - height - margin),
    ),
    width: maxWidth,
  };
}
