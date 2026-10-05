import {
  recoveryDifferences,
  recoveryValueSummary,
  recoveryValueText,
} from "./recoveryDiff";

test("compares task edits by identity, with the actual common value and distinct missing fields", () => {
  const base = {
    items: [{ id: "root", contents: "Launch", dueDate: "2026-10-02" }],
  };
  const local = {
    items: [
      {
        id: "root",
        contents: "Launch website",
        dueDate: "2026-10-02",
        parentTaskId: "parent",
      },
      { id: "local", contents: "Device step" },
    ],
  };
  const remote = {
    items: [
      { id: "server", contents: "Server step" },
      { id: "root", contents: "Launch", dueDate: "2026-10-05" },
    ],
  };
  const rows = recoveryDifferences(local, remote, base);
  expect(rows.find((row) => row.path === "items[root].contents")).toMatchObject(
    {
      local: "Launch website",
      remote: "Launch",
      base: "Launch",
      basePresent: true,
    },
  );
  expect(rows.find((row) => row.path === "items[root].dueDate")).toMatchObject({
    local: "2026-10-02",
    remote: "2026-10-05",
    base: "2026-10-02",
  });
  expect(
    rows.find((row) => row.path === "items[root].parentTaskId"),
  ).toMatchObject({
    localPresent: true,
    remotePresent: false,
    basePresent: false,
  });
  expect(rows.find((row) => row.path === "items[local]")).toMatchObject({
    localPresent: true,
    remotePresent: false,
    groupTitle: "Task: Device step · local",
  });
  expect(rows.find((row) => row.path === "items[server]")).toMatchObject({
    localPresent: false,
    remotePresent: true,
  });
});

test("identifies reordering separately from task edits and supports generic records", () => {
  const a = { id: "a", contents: "A" },
    b = { id: "b", contents: "B" };
  expect(
    recoveryDifferences({ items: [a, b] }, { items: [b, a] }),
  ).toMatchObject([
    { path: "items.$order", local: ["a", "b"], remote: ["b", "a"] },
  ]);
  expect(
    recoveryDifferences(
      { notes: { text: "Device" }, repeat: { days: [1, 3] } },
      { notes: { text: "Server" }, repeat: { days: [1, 4] } },
    ).map((row) => row.path),
  ).toEqual(["notes.text", "repeat.days"]);
});

test("distinguishes absent, null, malformed, empty, and plain text values without dropping differences", () => {
  expect(recoveryValueSummary(undefined)).toContain("absent");
  expect(recoveryValueSummary(null)).toContain("null");
  expect(recoveryValueSummary({ show: 3 })).toContain("fields: show");
  expect(recoveryValueSummary({ items: [] })).toContain("0 items");
  expect(recoveryValueSummary("text")).toContain("Text value");
  expect(recoveryValueText(null, true)).toBe("null");
  expect(recoveryValueText(undefined, false)).toBe("Not present");
  expect(recoveryValueText("", true)).toBe('""');
  expect(recoveryDifferences(undefined, null)[0]).toMatchObject({
    localPresent: false,
    remotePresent: true,
    remote: null,
  });
  expect(recoveryDifferences({ show: 3 }, { show: 5 })[0]).toMatchObject({
    path: "show",
    local: 3,
    remote: 5,
  });
  expect(recoveryDifferences({ items: [] }, { items: [] })).toEqual([]);
});

test("retains complete added records and all metadata differences without mutating saved copies", () => {
  const local = {
    items: [
      {
        id: "a",
        contents: "Task",
        repeat: { type: "weekly", days: [1] },
        description: "Line one\nLine two",
      },
    ],
    customLists: [{ id: "work", name: "Work" }],
  };
  const remote = {
    items: [
      { id: "a", contents: "Task", repeat: { type: "daily" }, description: "" },
    ],
    customLists: [],
  };
  const original = JSON.stringify([local, remote]);
  const rows = recoveryDifferences(local, remote);
  expect(rows.map((row) => row.path)).toEqual(
    expect.arrayContaining([
      "items[a].repeat.type",
      "items[a].repeat.days",
      "items[a].description",
      "customLists[work]",
    ]),
  );
  expect(rows.find((row) => row.path === "customLists[work]")?.local).toEqual(
    local.customLists[0],
  );
  expect(JSON.stringify([local, remote])).toBe(original);
});
