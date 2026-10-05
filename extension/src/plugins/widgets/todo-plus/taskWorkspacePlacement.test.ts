import { taskWorkspacePlacement } from "./taskWorkspacePlacement";

const viewport = { width: 1440, height: 900 };
const leftPanel = { left: 0, right: 400, top: 0, bottom: 900 };
const rightPanel = { left: 1040, right: 1440, top: 0, bottom: 900 };
const row = { left: 20, right: 380, top: 450, bottom: 500 };

test("keeps dashboard settings accessible when the originating task is near the top", () => {
  const dock = taskWorkspacePlacement(
    leftPanel,
    { ...row, top: 24, bottom: 50 },
    "right",
    viewport,
  );
  expect(dock.top).toBeGreaterThanOrEqual(64);
});

test.each(["left", "right"] as const)(
  "opens %s into the gap without covering either side panel",
  (direction) => {
    const dock = taskWorkspacePlacement(
      direction === "right" ? leftPanel : rightPanel,
      row,
      direction,
      viewport,
      direction === "right" ? rightPanel : leftPanel,
    );
    expect(dock.left).toBeGreaterThan(leftPanel.right);
    expect(dock.left + dock.width).toBeLessThan(rightPanel.left);
    expect(dock.width).toBeLessThanOrEqual(600);
    expect(dock.height).toBe(300);
    expect(dock.top).toBe(row.top);
  },
);

test.each([80, 720])(
  "keeps the clicked row reachable at y=%s on a narrow screen",
  (top) => {
    const origin = { left: 64, right: 390, top: 0, bottom: 900 };
    const clicked = { left: 80, right: 370, top, bottom: top + 40 };
    const dock = taskWorkspacePlacement(origin, clicked, "left", {
      width: 390,
      height: 900,
    });
    expect(dock.left).toBeGreaterThanOrEqual(16);
    expect(dock.left + dock.width).toBeLessThanOrEqual(374);
    expect(dock.top).toBeGreaterThanOrEqual(16);
    expect(dock.top + dock.height).toBeLessThanOrEqual(884);
    expect(
      dock.top + dock.height <= clicked.top || dock.top >= clicked.bottom,
    ).toBe(true);
  },
);
