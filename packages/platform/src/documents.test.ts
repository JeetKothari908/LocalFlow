import { Bridge, CommitReply, Snapshot } from "./bridge";
import { DocumentClient } from "./documents";
import { defaultData } from "../../core/src/tasks/types";

function snapshot(): Snapshot {
  return { protocol: 1, documents: {
    tasks: { value: { ...defaultData, items: [] }, revision: 1, pending: false },
    notes: { value: { items: [], selectedNoteId: null, currentFolderId: null }, revision: 1, pending: false },
    plan: { value: { plans: {} }, revision: 1, pending: false },
  }, status: "Saved locally", syncing: false, conflicts: [], drafts: {} };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup() {
  let current = snapshot();
  let listener: (state: Snapshot) => void = () => {};
  const commits: Array<{ payload: any; resolve: (value: CommitReply) => void; reject: (error: Error) => void }> = [];
  const request = jest.fn((method: string, payload: any = {}) => {
    if (method === "commit") return new Promise<CommitReply>((resolve, reject) => commits.push({ payload, resolve, reject }));
    if (method === "preserveDraft") current = { ...current, drafts: { ...current.drafts, [payload.key]: payload.value } };
    if (method === "resolveDraft") {
      current = { ...current, drafts: {}, documents: { ...current.documents, [payload.key]: { value: payload.useLocal ? payload.value : current.documents[payload.key as "plan"].value, revision: payload.expectedRevision + 1, pending: true } } };
      return Promise.resolve({ accepted: true, snapshot: current });
    }
    return Promise.resolve(current);
  });
  const bridge: Bridge = { request: request as Bridge["request"], subscribe(fn) { listener = fn; return () => {}; } };
  return { client: new DocumentClient(bridge), bridge, commits, request,
    remote(state: Snapshot) { current = state; listener(state); },
    accepted(index: number) {
      const { payload, resolve } = commits[index];
      current = { ...current, drafts: {}, documents: { ...current.documents, [payload.key]: { value: payload.value, revision: payload.expectedRevision + 1, pending: true } } };
      resolve({ accepted: true, snapshot: current });
    },
  };
}

test("rapid typing is serialized and the latest edit uses the acknowledged revision", async () => {
  const h = setup(); await h.client.start();
  h.client.set("plan", { plans: { "2026-10-05": "a" } });
  h.client.set("plan", { plans: { "2026-10-05": "ab" } });
  expect(h.commits).toHaveLength(1);
  expect(h.client.value("plan").plans["2026-10-05"]).toBe("ab");
  h.accepted(0); await tick();
  expect(h.commits).toHaveLength(2);
  expect(h.commits[1].payload.expectedRevision).toBe(2);
  h.accepted(1); await tick();
  expect(h.client.state("plan")).toBeUndefined();
  expect(h.client.snapshot!.documents.plan.pending).toBe(true);
});

test("remote updates cannot silently authorize overwriting a pending edit", async () => {
  const h = setup(); await h.client.start();
  h.client.set("plan", { plans: { local: "first" } });
  h.client.set("plan", { plans: { local: "second" } });
  const remote = snapshot(); remote.documents.plan = { value: { plans: { remote: "new" } }, revision: 9, pending: false };
  h.remote(remote);
  const reply = snapshot(); reply.documents.plan = { value: { plans: { local: "first" } }, revision: 2, pending: true };
  h.commits[0].resolve({ accepted: true, snapshot: reply }); await tick();
  expect(h.client.snapshot!.documents.plan.revision).toBe(9);
  expect(h.client.value("plan").plans.local).toBe("second");
  expect(h.client.state("plan")?.blocked).toBe(true);
  expect(h.commits).toHaveLength(1);
  expect(h.request).toHaveBeenCalledWith("preserveDraft", { key: "plan", value: { plans: { local: "second" } } });
});

test("a stale commit preserves typing that happened after submission", async () => {
  const h = setup(); await h.client.start();
  h.client.set("plan", { plans: { day: "a" } }); h.client.set("plan", { plans: { day: "latest" } });
  h.commits[0].resolve({ accepted: false, snapshot: snapshot(), error: "Conflict" }); await tick();
  expect(h.client.state("plan")?.error).toBe("Conflict");
  expect(h.request).toHaveBeenCalledWith("preserveDraft", { key: "plan", value: { plans: { day: "latest" } } });
});

test("failed persistence never reports a saved document or loses the visible edit", async () => {
  const h = setup(); await h.client.start(); h.client.set("plan", { plans: { day: "keep me" } });
  h.commits[0].reject(new Error("Disk full")); await tick();
  expect(h.client.state("plan")?.blocked).toBe(true);
  expect(h.client.value("plan").plans.day).toBe("keep me");
  expect(h.client.snapshot!.documents.plan.revision).toBe(1);
});

test("preserved drafts reopen for explicit review and can be discarded", async () => {
  const h = setup(); const state = snapshot(); state.drafts.plan = { plans: { draft: "offline" } };
  h.remote(state); await h.client.start();
  expect(h.client.state("plan")?.blocked).toBe(true);
  await h.client.resolveDraft("plan", false);
  expect(h.client.state("plan")).toBeUndefined();
  expect(h.client.value("plan").plans).toEqual({});
});

test("documents have independent save queues", async () => {
  const h = setup(); await h.client.start();
  h.client.set("plan", { plans: { day: "plan" } });
  h.client.set("notes", { items: [], selectedNoteId: null, currentFolderId: null });
  expect(h.commits.map(c => c.payload.key)).toEqual(["plan", "notes"]);
  h.accepted(0); h.accepted(1); await tick();
});

test("incompatible bridge snapshots fail explicitly", () => {
  const h = setup(); expect(() => h.client.receive({ ...snapshot(), protocol: 2 } as any)).toThrow("Update LocalFlow");
});

test("typing after a conflict survives a new client and keeps the accepted document", async () => {
  const h = setup(), state = snapshot(); state.drafts.plan = { plans: { day: "old draft" } };
  h.remote(state); await h.client.start();
  h.client.set("plan", { plans: { day: "new typing" } }); await tick();
  const reopened = new DocumentClient(h.bridge); await reopened.start();
  expect(reopened.value("plan").plans.day).toBe("new typing");
  expect(reopened.snapshot!.documents.plan.value.plans).toEqual({});
  expect(h.client.state("plan")?.draftSaving).toBe(false);
});

test("blocked draft writes serialize and coalesce typing during a slow write", async () => {
  const h = setup(), state = snapshot(); state.drafts.plan = { plans: {} }; h.remote(state); await h.client.start();
  let finish!: () => void;
  const base = h.bridge.request;
  h.bridge.request = ((method: string, payload: any) => method === "preserveDraft" && payload.value.plans.day === "a"
    ? new Promise<any>(resolve => { finish = () => { void base(method, payload).then(resolve); }; }) : base(method, payload)) as Bridge["request"];
  h.client.set("plan", { plans: { day: "a" } }); await tick();
  h.client.set("plan", { plans: { day: "ab" } });
  h.client.set("plan", { plans: { day: "abc" } }); await tick();
  expect(h.client.state("plan")?.draftSaving).toBe(true);
  finish(); await tick();
  const reopened = new DocumentClient(h.bridge); await reopened.start();
  expect(reopened.value("plan").plans.day).toBe("abc");
  expect(h.request.mock.calls.filter(([method]) => method === "preserveDraft").map(([, payload]) => payload.value.plans.day)).toEqual(["a", "abc"]);
});

test("draft write failure stays visible and can retry before resolution", async () => {
  const h = setup(), state = snapshot(); state.drafts.plan = { plans: {} }; h.remote(state); await h.client.start();
  const base = h.bridge.request;
  h.bridge.request = ((method: string, payload: any) => method === "preserveDraft" ? Promise.reject(new Error("Disk full")) : base(method, payload)) as Bridge["request"];
  h.client.set("plan", { plans: { day: "recover me" } }); await tick();
  expect(h.client.state("plan")?.draftError).toContain("Draft not saved");
  await expect(h.client.resolveDraft("plan", true)).rejects.toThrow("Disk full");
  h.bridge.request = base;
  await h.client.resolveDraft("plan", true);
  expect(h.client.state("plan")).toBeUndefined();
  expect(h.request).toHaveBeenCalledWith("resolveDraft", expect.objectContaining({ useLocal: true, expectedRevision: 1 }));
});

test("resolution submits the reviewed revision and preserves review on a newer change", async () => {
  const h = setup(), state = snapshot(); state.drafts.plan = { plans: { day: "draft" } }; h.remote(state); await h.client.start();
  const newer = snapshot(); newer.documents.plan.revision = 2;
  const base = h.bridge.request;
  h.bridge.request = ((method: string, payload: any) => {
    if (method === "resolveDraft") {
      expect(payload.expectedRevision).toBe(1);
      return Promise.resolve({ accepted: false, snapshot: newer, error: "Review again" });
    }
    return base(method, payload);
  }) as Bridge["request"];
  await expect(h.client.resolveDraft("plan", true)).rejects.toThrow("Review again");
  expect(h.client.value("plan").plans.day).toBe("draft");
  expect(h.client.state("plan")?.blocked).toBe(true);
});

test("an older native broadcast cannot resurrect a resolved draft", async () => {
  const h = setup(), old = snapshot(); old.epoch = 4; old.drafts.plan = { plans: { day: "old draft" } };
  const latest = snapshot(); latest.epoch = 5;
  h.client.receive(latest); h.client.receive(old);
  expect(h.client.state("plan")).toBeUndefined();
  expect(h.client.snapshot?.epoch).toBe(5);
});
