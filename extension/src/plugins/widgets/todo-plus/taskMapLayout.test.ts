import { taskMapLayout, mapCardHeight } from "./taskMapLayout";
import { Task } from "../todo/types";
const task = (id: string, parentTaskId?: string, order?: number): Task => ({
  id,
  contents: id,
  completed: false,
  parentTaskId,
  order,
});

describe("subtask bracket map", () => {
  it("mirrors branches left without changing vertical alignment or task identities", () => {
    const items = [
      task("root"),
      task("a", "root"),
      task("b", "root"),
      task("deep", "a"),
    ];
    const expanded = new Set(["root", "a"]);
    const right = taskMapLayout(items, "root", expanded, "right");
    const left = taskMapLayout(items, "root", expanded, "left");
    expect(left.width).toBe(right.width);
    expect(left.height).toBe(right.height);
    left.nodes.forEach((node, i) => {
      expect(node.task).toBe(right.nodes[i].task);
      expect(node.y).toBe(right.nodes[i].y);
      expect(node.x).toBe(right.width - right.nodes[i].x - node.width);
    });
    left.edges.forEach(({ parent, child }) => {
      expect(child.x + child.width).toBeLessThan(parent.x);
    });
  });
  it("places children to the right, orders siblings, and centers parents between their branches", () => {
    const layout = taskMapLayout(
      [
        task("root"),
        task("b", "root", 2),
        task("a", "root", 1),
        task("deep", "a"),
      ],
      "root",
      new Set(["root", "a"]),
    );
    const nodes = new Map(layout.nodes.map((node) => [node.task.id, node]));
    expect(nodes.get("a")!.x + nodes.get("a")!.width).toBeLessThan(
      nodes.get("deep")!.x,
    );
    expect(nodes.get("root")!.x + nodes.get("root")!.width).toBeLessThan(
      nodes.get("a")!.x,
    );
    expect(nodes.get("a")!.y).toBeLessThan(nodes.get("b")!.y);
    expect(nodes.get("root")!.y).toBe(
      (nodes.get("a")!.y + nodes.get("b")!.y) / 2,
    );
    expect(nodes.get("b")!.y - nodes.get("a")!.y).toBeGreaterThan(
      mapCardHeight,
    );
    expect(layout.edges).toHaveLength(3);
  });
  it("collapses only the chosen branch and retains completed tasks for tracing", () => {
    const items = [
      task("root"),
      task("a", "root"),
      { ...task("done", "a"), completed: true },
      task("b", "root"),
    ];
    expect(
      taskMapLayout(items, "root", new Set(["root"])).nodes.map(
        (node) => node.task.id,
      ),
    ).toEqual(["root", "a", "b"]);
    expect(
      taskMapLayout(items, "root", new Set(["root", "a"])).nodes.map(
        (node) => node.task.id,
      ),
    ).toContain("done");
  });
  it("supports deep branches iteratively without changing task data", () => {
    const items = Array.from({ length: 6000 }, (_, i) =>
      task(String(i), i ? String(i - 1) : undefined),
    );
    const original = JSON.stringify(items),
      layout = taskMapLayout(items, "0", new Set(items.map((item) => item.id)));
    expect(layout.nodes).toHaveLength(6000);
    expect(layout.edges).toHaveLength(5999);
    expect(JSON.stringify(items)).toBe(original);
    expect(layout.height).toBe(mapCardHeight + 24);
  });
});
