(globalThis as any).BUILD_TARGET = "chromium";
(globalThis as any).DEV = false;
(globalThis as any).window = { addEventListener: jest.fn() };

const { DB, Storage } = jest.requireActual(
  "../index",
) as typeof import("../index");

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

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
