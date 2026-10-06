import { Data as Tasks } from "../../core/src/tasks/types";
import { Data as Notes } from "../../core/src/notes/data";
import { Data as Plan } from "../../core/src/planOfDay/types";

export const protocolVersion = 1;
export type DocumentKey = "tasks" | "notes" | "plan";
export type Documents = { tasks: Tasks; notes: Notes; plan: Plan };
export type Route = "tasks" | "notes" | "plan";
export type DocumentSnapshot<T> = { value: T; revision: number; pending: boolean };
export type Conflict = { key: DocumentKey; detail: string; local: unknown; remote: unknown };
export type Snapshot = {
  protocol: 1;
  epoch?: number;
  documents: { [K in DocumentKey]: DocumentSnapshot<Documents[K]> };
  status: string;
  error?: string;
  syncing: boolean;
  timeZone?: string;
  conflicts: Conflict[];
  drafts: Partial<Record<DocumentKey, unknown>>;
};
export type Commit = { key: DocumentKey; value: unknown; expectedRevision: number; transactionId: string };
export type CommitReply = { accepted: boolean; snapshot: Snapshot; error?: string };
export type Revision = { version: number; changedAt: number; operation: string; value: unknown; deleted?: boolean };
export interface Bridge {
  request<T>(method: string, payload?: Record<string, unknown>): Promise<T>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
}
export const transactionId = () => `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Both the iOS host and preview implement this exact, versioned contract. */
export function nativeBridge(): Bridge {
  return {
    async request<T>(method: string, payload = {}): Promise<T> {
      const host = (window as any).webkit?.messageHandlers?.localflow;
      if (!host) throw new Error("The native connection is unavailable. Reopen LocalFlow.");
      const reply = await host.postMessage({ protocol: protocolVersion, method, ...payload });
      if (reply?.error && reply?.ok === false) throw new Error(reply.error);
      return reply as T;
    },
    subscribe(listener) {
      const receive = (event: Event) => listener((event as CustomEvent<Snapshot>).detail);
      window.addEventListener("localflow:snapshot", receive);
      return () => window.removeEventListener("localflow:snapshot", receive);
    },
  };
}
