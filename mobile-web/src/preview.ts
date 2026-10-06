import { Bridge, CommitReply, DocumentKey, Snapshot } from "../../packages/platform/src/bridge";
import { defaultData } from "../../packages/core/src/tasks/types";
import { createTask, localDate } from "../../packages/core/src/tasks/tasks";
import { performanceData } from "./performanceData";
import { getPlanDate } from "../../packages/core/src/planOfDay/date";

export function previewBridge(): Bridge {
  const dataset = new URLSearchParams(location.search).get("dataset");
  const profile = dataset === "small" || dataset === "medium" || dataset === "large" ? dataset : undefined;
  const key = "localflow.mobile.preview.v1" + (profile ? "." + profile : "");
  let tasks = createTask(defaultData, { id: "welcome", contents: "Make room for what matters", description: "Your shared LocalFlow workspace, adapted for mobile." });
  tasks = createTask(tasks, { id: "first-step", contents: "Plan one useful next step", parentTaskId: "welcome", dueDate: localDate(), estimatedMinutes: 20 });
  if (profile) tasks = { ...tasks, ...performanceData(profile) };
  const initial: Snapshot = { protocol: 1, documents: {
    tasks: { value: tasks, revision: 0, pending: false },
    notes: { value: { items: [], currentFolderId: null, selectedNoteId: null }, revision: 0, pending: false },
    plan: { value: { plans: {}, activeDate: getPlanDate(new Date()) }, revision: 0, pending: false },
  }, status: "Preview · stored in this browser", syncing: false, conflicts: [], drafts: {} };
  let snapshot: Snapshot;
  try { snapshot = JSON.parse(localStorage.getItem(key) || "null") ?? initial; } catch { snapshot = initial; }
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const persist = () => { localStorage.setItem(key, JSON.stringify(snapshot)); listeners.forEach(fn => fn(snapshot)); };
  return {
    async request<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
      const documentKey = payload.key as DocumentKey;
      if (method === "commit" || method === "resolveDraft") {
        if (!snapshot.documents[documentKey] || payload.expectedRevision !== snapshot.documents[documentKey].revision) {
          snapshot = { ...snapshot, drafts: { ...snapshot.drafts, [documentKey]: payload.value } }; persist();
          return { accepted: false, snapshot, error: "Another change arrived." } as T;
        }
        if (method === "resolveDraft") localStorage.setItem(key + ".backup." + documentKey, JSON.stringify(payload.useLocal ? snapshot.documents[documentKey].value : payload.value));
        const value = method === "resolveDraft" && !payload.useLocal ? snapshot.documents[documentKey].value : payload.value;
        const drafts = { ...snapshot.drafts }; delete drafts[documentKey];
        snapshot = { ...snapshot, drafts, documents: { ...snapshot.documents, [documentKey]: { value, revision: snapshot.documents[documentKey].revision + 1, pending: false } } };
        persist(); return { accepted: true, snapshot } as CommitReply as T;
      }
      if (method === "preserveDraft") { snapshot = { ...snapshot, drafts: { ...snapshot.drafts, [documentKey]: payload.value } }; persist(); }
      if (method === "discardDraft") { const drafts = { ...snapshot.drafts }; delete drafts[documentKey]; snapshot = { ...snapshot, drafts }; persist(); }
      if (method === "readEditorDraft") return JSON.parse(localStorage.getItem(key + ".draft." + payload.id) || "null") as T;
      if (method === "writeEditorDraft") localStorage.setItem(key + ".draft." + payload.id, JSON.stringify(payload.value));
      if (method === "history") return { revisions: [] } as T;
      if (method === "settings") throw new Error("Server settings are available in the iOS app. Preview data stays in this browser.");
      if (method === "copyTaskLink") await navigator.clipboard.writeText(`localflow://task/${encodeURIComponent(String(payload.id))}`);
      if (method === "share") {
        const url = URL.createObjectURL(new Blob([String(payload.text)], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = String(payload.filename); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      return snapshot as T;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
