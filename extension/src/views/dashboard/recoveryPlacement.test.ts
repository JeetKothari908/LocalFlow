import { recoveryPlacement } from "./recoveryPlacement";
const anchor = { left: 16, right: 44, top: 16, bottom: 40 };
const viewport = { width: 1365, height: 900 };

test("fits the center gap beside settings when full-height side panels are occupied", () => {
  const placement = recoveryPlacement(
    { left: 308, right: 348, top: 8, bottom: 48 },
    [
      { left: 0, right: 300, top: 0, bottom: 900 },
      { left: 760, right: 1060, top: 0, bottom: 900 },
    ],
    { width: 1060, height: 900 },
    300,
  );
  expect(placement).toEqual({ left: 360, top: 16, width: 388 });
});

test("sits beside dashboard controls and skips a chain of occupied widgets to the right", () => {
  expect(recoveryPlacement(anchor, [], viewport, 300)).toEqual({
    left: 56,
    top: 16,
    width: 460,
  });
  const obstacles = [
    { left: 56, right: 180, top: 16, bottom: 120 },
    { left: 185, right: 310, top: 16, bottom: 150 },
  ];
  expect(recoveryPlacement(anchor, obstacles, viewport, 300)).toEqual({
    left: 322,
    top: 16,
    width: 460,
  });
});

test("does not shift for widgets outside the panel's vertical range", () => {
  expect(
    recoveryPlacement(
      anchor,
      [{ left: 56, right: 600, top: 350, bottom: 500 }],
      viewport,
      300,
    ).left,
  ).toBe(56);
});

test("wraps below an occupied narrow row and stays within the viewport", () => {
  const placement = recoveryPlacement(
    anchor,
    [{ left: 16, right: 370, top: 48, bottom: 180 }],
    { width: 390, height: 900 },
    300,
  );
  expect(placement).toEqual({ left: 16, top: 192, width: 358 });
  expect(placement.left + placement.width).toBeLessThanOrEqual(374);
});
