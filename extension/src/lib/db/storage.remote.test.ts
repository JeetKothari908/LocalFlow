(globalThis as any).BUILD_TARGET = "chromium";
(globalThis as any).DEV = false;
(globalThis as any).window = { addEventListener: jest.fn() };

const { DB, Storage } = jest.requireActual(
  "../index",
) as typeof import("../index");

const flushPromises = async () => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};

const key = "data/default-todo";
const settings = { url: "https://sync.test", token: "secret" };
const todo = (patch: Record<string, unknown> = {}) => ({ schemaVersion: 2, show: 3, items: [{ id: "root", contents: "Project", completed: false, status: "todo", ...patch }], dependencies: [], occurrences: [], activity: [], customLists: [] });
const response = (payload: unknown, status = 200) => ({ ok: status < 400, status, statusText: status === 409 ? "Conflict" : "OK", json: async () => payload });
const snapshot = (value: unknown, version = 1) => response({ changes: [{ key, value, version }] });
const writesOf = (mock: jest.Mock): Array<{ changes: Array<Record<string, unknown>> }> => mock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
  const values = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => values.set(name, value), removeItem: (name: string) => values.delete(name), clear: () => values.clear() };
  (globalThis as any).window = { addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn() };
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("remote sync serializes writes with the latest base version", async () => {
  jest.useFakeTimers();
  const writes: Array<{ changes: Array<Record<string, unknown>> }> = [];
  let version = 1;

  (globalThis as any).fetch = jest.fn(
    async (_url: string, init?: RequestInit) => {
      if (!init?.method) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            changes: [
              {
                key: "data/default-todo",
                value: { items: [] },
                version,
                updatedAt: 100,
              },
            ],
          }),
        };
      }

      const body = JSON.parse(String(init.body));
      writes.push(body);
      version += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ok: true,
          versions: { "data/default-todo": version },
        }),
      };
    },
  );

  const db = DB.init();
  const session = await Storage.remoteSync(db, "tabliss/config", {
    url: "https://sync.test",
    token: "secret",
  });
  await flushPromises();

  expect(DB.get(db, "data/default-todo")).toEqual({ items: [] });

  DB.put(db, "data/default-todo", { items: [{ id: "one" }] });
  jest.advanceTimersByTime(1000);
  await flushPromises();

  DB.put(db, "data/default-todo", { items: [{ id: "two" }] });
  jest.advanceTimersByTime(1000);
  await flushPromises();

  expect(writes).toHaveLength(2);
  expect(writes[0].changes[0].baseVersion).toBe(1);
  expect(writes[1].changes[0].baseVersion).toBe(2);
  session.stop();
});

test("todo writes include the exact acknowledged base JSON and schema capability", async () => {
  jest.useFakeTimers();
  const base = todo({ optionalFutureField: { enabled: true } });
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => init?.method ? response({ ok: true, versions: { [key]: 2 } }) : snapshot(base));
  (globalThis as any).fetch = fetchMock;
  const db = DB.init();
  const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  DB.put(db, key, todo({ contents: "Edited", optionalFutureField: { enabled: true } }));
  jest.advanceTimersByTime(1000); await flushPromises();
  expect(writesOf(fetchMock)[0].changes[0]).toMatchObject({ baseVersion: 1, baseValue: base, todoSchemaVersion: 2 });
  const exported = JSON.parse(session.exportRecovery());
  expect(exported.bases[key].version).toBe(2);
  expect([...db].some(([name]) => name.includes("__localflow_remote_sync__"))).toBe(false);
  session.stop();
});

test("startup rebases offline local task edits onto remote edits using persisted baseline", async () => {
  jest.useFakeTimers();
  const base = todo();
  let server = base, version = 1;
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => init?.method ? response({ ok: true, versions: { [key]: ++version } }) : snapshot(server, version));
  (globalThis as any).fetch = fetchMock;
  const first = await Storage.remoteSync(DB.init(), "tabliss/config", settings);
  await flushPromises(); first.stop();
  const db = DB.init(); DB.put(db, key, todo({ contents: "Offline rename" }));
  server = todo({ dueDate: "2026-10-02" }); version = 2;
  const second = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  expect((DB.get(db, key) as any).items[0]).toMatchObject({ contents: "Offline rename", dueDate: "2026-10-02" });
  expect(writesOf(fetchMock).at(-1)?.changes[0]).toMatchObject({ baseVersion: 2, baseValue: server });
  expect(second.getRecoveries()).toEqual([]);
  second.stop();
});

test("startup preserves a divergent local task document with no baseline and offers recovery", async () => {
  jest.useFakeTimers();
  const local = todo({ contents: "Local project" }), remote = todo({ contents: "Other device" });
  const fetchMock = jest.fn(async () => snapshot(remote, 4));
  (globalThis as any).fetch = fetchMock;
  const db = DB.init(); DB.put(db, key, local);
  const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  expect(DB.get(db, key)).toEqual(local);
  expect(writesOf(fetchMock)).toHaveLength(0);
  const recovery = session.getRecoveries()[0];
  expect(recovery).toMatchObject({ reason: "noBaseline", localValue: local, remoteValue: remote, currentVersion: 4 });
  await session.resolveRecovery(recovery.id, "remote");
  expect(DB.get(db, key)).toEqual(remote);
  expect(session.getRecoveries()[0]).toMatchObject({ localValue: local, resolvedAt: expect.any(String) });
  expect(Storage.readRemoteRecoveries(settings, "tabliss/config")).toHaveLength(1);
  session.stop();
});

test("startup resolves stale identical recoveries without changing records or uploading", async () => {
  jest.useFakeTimers();
  const widgetKey = "data/widget/todo";
  const notesKey = "data/default-notes";
  const widget = todo({ contents: "Same on both sides" });
  const localNotes = { items: [{ id: "note", contents: "Local" }] };
  const remoteNotes = { items: [{ id: "note", contents: "Server" }] };
  const metadataKey = `__localflow_remote_sync__/${encodeURIComponent(settings.url)}/${encodeURIComponent("tabliss/config")}`;
  localStorage.setItem(metadataKey, JSON.stringify({
    bases: {},
    recoveries: [
      { id: "absent", key, at: "2026-10-02T02:09:53Z", reason: "noBaseline" },
      { id: "same-widget", key: widgetKey, at: "2026-10-02T02:09:53Z", reason: "noBaseline", localValue: widget, remoteValue: widget, currentVersion: 2 },
      { id: "different-notes", key: notesKey, at: "2026-10-02T02:09:53Z", reason: "noBaseline", localValue: localNotes, remoteValue: remoteNotes, currentVersion: 1 },
    ],
  }));
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method) throw new Error("Equal recoveries must not upload");
    return response({ changes: [
      { key: widgetKey, value: widget, version: 2 },
      { key: notesKey, value: remoteNotes, version: 1 },
    ] });
  });
  (globalThis as any).fetch = fetchMock;
  const db = DB.init();
  DB.put(db, widgetKey, widget);
  DB.put(db, notesKey, localNotes);
  const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  const recoveries = session.getRecoveries();
  expect(recoveries.filter((item) => !item.resolvedAt).map((item) => item.id)).toEqual(["different-notes"]);
  expect(Storage.readRemoteRecoveries(settings, "tabliss/config").filter((item) => !item.resolvedAt).map((item) => item.id)).toEqual(["different-notes"]);
  expect(DB.get(db, widgetKey)).toEqual(widget);
  expect(DB.get(db, notesKey)).toEqual(localNotes);
  expect(writesOf(fetchMock)).toHaveLength(0);
  session.stop();
});

test("offline cleanup retires only identical task recoveries matching current local data", async () => {
  const widgetKey = "data/widget/todo";
  const widget = todo({ contents: "Same on both sides" });
  const metadataKey = `__localflow_remote_sync__/${encodeURIComponent(settings.url)}/${encodeURIComponent("tabliss/config")}`;
  localStorage.setItem(metadataKey, JSON.stringify({
    bases: {},
    recoveries: [
      { id: "absent", key, at: "2026-10-02T02:09:53Z", reason: "noBaseline" },
      { id: "same-widget", key: widgetKey, at: "2026-10-02T02:09:53Z", reason: "noBaseline", localValue: widget, remoteValue: widget },
      { id: "changed-task", key: "data/changed-task", at: "2026-10-02T02:09:53Z", reason: "noBaseline", localValue: widget, remoteValue: widget },
    ],
  }));
  const db = DB.init();
  DB.put(db, widgetKey, widget);
  DB.put(db, "data/changed-task", todo({ contents: "A newer local edit" }));
  await Storage.resolveIdenticalOfflineRecoveries(settings, "tabliss/config", (name) => DB.get(db, name));
  const unresolved = Storage.readRemoteRecoveries(settings, "tabliss/config").filter((item) => !item.resolvedAt);
  expect(unresolved.map((item) => item.id)).toEqual(["changed-task"]);
  expect(DB.get(db, widgetKey)).toEqual(widget);
  expect(DB.get(db, "data/changed-task")).toEqual(todo({ contents: "A newer local edit" }));
});

test("equal saved task copies are resolved even when the sync server is unavailable", async () => {
  jest.useFakeTimers();
  const widgetKey = "data/widget/todo";
  const widget = todo({ contents: "Same on both sides" });
  const metadataKey = `__localflow_remote_sync__/${encodeURIComponent(settings.url)}/${encodeURIComponent("tabliss/config")}`;
  localStorage.setItem(metadataKey, JSON.stringify({ bases: {}, recoveries: [
    { id: "absent", key, at: "2026-10-02T02:09:53Z", reason: "noBaseline" },
    { id: "same-widget", key: widgetKey, at: "2026-10-02T02:09:53Z", reason: "noBaseline", localValue: widget, remoteValue: widget },
  ] }));
  (globalThis as any).fetch = jest.fn(async () => { throw new Error("Offline"); });
  const db = DB.init();
  DB.put(db, widgetKey, widget);
  const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  expect(session.getRecoveries().every((item) => Boolean(item.resolvedAt))).toBe(true);
  expect(DB.get(db, widgetKey)).toEqual(widget);
  session.stop();
});

test("merged response rebases newer queued edits and uses the merged version on the next write", async () => {
  jest.useFakeTimers();
  const base = todo();
  let release: (value: unknown) => void = () => {};
  let writeCount = 0;
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return snapshot(base);
    writeCount++;
    if (writeCount === 1) return new Promise((resolve) => { release = resolve; });
    return response({ ok: true, versions: { [key]: 4 } });
  });
  (globalThis as any).fetch = fetchMock;
  const db = DB.init();
  const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  DB.put(db, key, todo({ contents: "Renamed" }));
  jest.advanceTimersByTime(1000); await flushPromises();
  DB.put(db, key, todo({ contents: "Renamed", description: "Added during request" }));
  const merged = todo({ contents: "Renamed", dueDate: "2026-10-03" });
  release(response({ ok: true, versions: { [key]: 3 }, changes: [{ key, value: merged, version: 3 }] }));
  await flushPromises();
  expect((DB.get(db, key) as any).items[0]).toMatchObject({ contents: "Renamed", description: "Added during request", dueDate: "2026-10-03" });
  const writes = writesOf(fetchMock);
  expect(writes).toHaveLength(2);
  expect(writes[1].changes[0]).toMatchObject({ baseVersion: 3, baseValue: merged });
  expect((writes[1].changes[0].value as any).items[0].description).toBe("Added during request");
  session.stop();
});

test("same-field conflict retains local edits and recovery copies until explicit resolution", async () => {
  jest.useFakeTimers();
  const base = todo(), remote = todo({ contents: "Remote rename" });
  let attempts = 0;
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return snapshot(base);
    if (++attempts === 1) return response({ detail: { key, currentValue: remote, currentVersion: 2, conflicts: ["items[root].contents"] } }, 409);
    return response({ ok: true, versions: { [key]: 3 } });
  });
  (globalThis as any).fetch = fetchMock;
  const db = DB.init(); const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  DB.put(db, key, todo({ contents: "Local rename" }));
  jest.advanceTimersByTime(1000); await flushPromises();
  expect((DB.get(db, key) as any).items[0].contents).toBe("Local rename");
  expect(session.getRecoveries()[0]).toMatchObject({ reason: "conflict", conflicts: ["items[root].contents"], remoteValue: remote });
  DB.put(db, key, todo({ contents: "Newer local rename" }));
  jest.advanceTimersByTime(1000); await flushPromises();
  expect(writesOf(fetchMock)).toHaveLength(1);
  expect((session.getRecoveries()[0].localValue as any).items[0].contents).toBe("Newer local rename");
  await session.resolveRecovery(session.getRecoveries()[0].id, "local");
  expect(writesOf(fetchMock)[1].changes[0]).toMatchObject({ baseVersion: 2, baseValue: remote });
  expect((DB.get(db, key) as any).items[0].contents).toBe("Newer local rename");
  session.stop();
});

test("remote polling merges dirty task edits and never echoes clean snapshots", async () => {
  jest.useFakeTimers();
  let server = todo(), version = 1;
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => init?.method ? response({ ok: true, versions: { [key]: ++version } }) : snapshot(server, version));
  (globalThis as any).fetch = fetchMock;
  const db = DB.init(); const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  server = todo({ dueDate: "2026-10-04" }); version = 2;
  jest.advanceTimersByTime(15000); await flushPromises();
  expect(DB.get(db, key)).toEqual(server);
  expect(writesOf(fetchMock)).toHaveLength(0);
  const focus = (window.addEventListener as jest.Mock).mock.calls.find(([name]) => name === "focus")?.[1];
  DB.put(db, key, todo({ dueDate: "2026-10-04", contents: "Local" }));
  server = todo({ dueDate: "2026-10-04", description: "Remote" }); version = 3;
  focus(); await flushPromises();
  expect((DB.get(db, key) as any).items[0]).toMatchObject({ contents: "Local", description: "Remote" });
  session.stop();
});

test("failed network writes retain pending edits, retry, and stop removes every timer and listener", async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return snapshot(todo());
    if (++attempts === 1) throw new Error("Offline");
    return response({ ok: true, versions: { [key]: 2 } });
  });
  (globalThis as any).fetch = fetchMock;
  const db = DB.init(); const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  DB.put(db, key, todo({ description: "Must survive" }));
  jest.advanceTimersByTime(1000); await flushPromises();
  expect(attempts).toBe(1);
  jest.advanceTimersByTime(1000); await flushPromises();
  expect(attempts).toBe(2);
  expect((DB.get(db, key) as any).items[0].description).toBe("Must survive");
  DB.put(db, key, todo({ description: "Next edit" }));
  session.stop();
  expect(db.listeners.size).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  expect(window.removeEventListener).toHaveBeenCalledTimes(3);
  jest.advanceTimersByTime(60000); await flushPromises();
  expect(attempts).toBe(2);
});

test("schema upgrade rejection retains the document for review without retrying the rejected upload", async () => {
  jest.useFakeTimers();
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => init?.method ? response({ detail: "Task schema update required" }, 428) : snapshot(todo()));
  (globalThis as any).fetch = fetchMock;
  const db = DB.init(); const session = await Storage.remoteSync(db, "tabliss/config", settings);
  await flushPromises();
  const local = todo({ description: "Keep this work" });
  DB.put(db, key, local); jest.advanceTimersByTime(1000); await flushPromises();
  expect(DB.get(db, key)).toEqual(local);
  expect(session.getRecoveries()[0]).toMatchObject({ localValue: local, currentVersion: 1, reason: "conflict" });
  jest.advanceTimersByTime(60000); await flushPromises();
  expect(writesOf(fetchMock)).toHaveLength(1);
  session.stop();
});
