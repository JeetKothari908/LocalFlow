import { taskMapLayout } from "./taskMapLayout";
test("touch-sized map cards fit inside the canvas without overlap", () => {
  const layout = taskMapLayout([
    { id: "root", contents: "Project", completed: false },
    { id: "a", contents: "First", completed: false, parentTaskId: "root" },
    { id: "b", contents: "Second", completed: false, parentTaskId: "root" },
  ], "root", new Set(["root"]), "right", { cardWidth: 264, cardHeight: 64, columnGap: 32, rowGap: 16 });
  for (const node of layout.nodes) { expect(node.x + node.width).toBeLessThanOrEqual(layout.width); expect(node.y + 64).toBeLessThanOrEqual(layout.height); }
  const children = layout.nodes.filter(n => n.depth === 1);
  expect(Math.abs(children[0].y - children[1].y)).toBeGreaterThanOrEqual(64);
});
