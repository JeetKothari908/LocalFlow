import { Bridge, CommitReply, DocumentKey, Documents, Snapshot, transactionId } from "./bridge";

type Pending = { value: unknown; generation: number; inFlight: boolean; blocked: boolean; error?: string; savedGeneration?: number; draftSaving?: boolean; draftError?: string; resolving?: boolean };
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/** Optimistic rendering with serialized, revision-checked native persistence. */
export class DocumentClient {
  snapshot?: Snapshot;
  private pending = new Map<DocumentKey, Pending>();
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private draftWrites = new Map<DocumentKey, Promise<void>>();
  constructor(readonly bridge: Bridge) {}

  async start() {
    this.unsubscribe = this.bridge.subscribe(snapshot => this.receive(snapshot));
    this.receive(await this.bridge.request<Snapshot>("snapshot"));
  }
  stop() { this.unsubscribe?.(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { this.listeners.forEach(listener => listener()); }
  receive(snapshot: Snapshot) {
    if (snapshot.protocol !== 1) throw new Error("Update LocalFlow to use this interface.");
    if (snapshot.epoch !== undefined && this.snapshot?.epoch !== undefined && snapshot.epoch < this.snapshot.epoch) return;
    // A reply to an earlier request can arrive after a newer native broadcast.
    if (this.snapshot) for (const key of ["tasks", "notes", "plan"] as const) {
      if (snapshot.documents[key].revision < this.snapshot.documents[key].revision) {
        snapshot = { ...snapshot, documents: { ...snapshot.documents, [key]: this.snapshot.documents[key] } };
      }
    }
    this.snapshot = snapshot;
    for (const key of Object.keys(snapshot.drafts) as DocumentKey[]) {
      if (!this.pending.has(key)) this.pending.set(key, { value: snapshot.drafts[key], generation: 0, savedGeneration: 0, inFlight: false, blocked: true, error: "A draft was preserved. Review it before saving." });
    }
    this.emit();
  }
  value<K extends DocumentKey>(key: K): Documents[K] {
    return (this.pending.get(key)?.value ?? this.snapshot!.documents[key].value) as Documents[K];
  }
  state(key: DocumentKey) { return this.pending.get(key); }
  set<K extends DocumentKey>(key: K, value: Documents[K]) {
    if (!this.snapshot) throw new Error("Wait for your local data to load.");
    const previous = this.pending.get(key);
    if (previous?.resolving) return;
    this.pending.set(key, { ...previous, value: copy(value), generation: (previous?.generation ?? 0) + 1, inFlight: previous?.inFlight ?? false, blocked: previous?.blocked ?? false });
    this.emit();
    if (previous?.blocked) void this.preserveDraft(key).catch(() => {});
    else void this.flush(key);
  }
  /** Only one draft write per document may run, so late replies cannot undo typing. */
  private preserveDraft(key: DocumentKey): Promise<void> {
    const running = this.draftWrites.get(key);
    if (running) return running;
    const operation = Promise.resolve().then(async () => {
      let pending = this.pending.get(key);
      while (pending?.blocked && pending.savedGeneration !== pending.generation) {
        const generation = pending.generation, value = copy(pending.value);
        pending.draftSaving = true; pending.draftError = undefined; this.emit();
        await this.bridge.request("preserveDraft", { key, value });
        pending = this.pending.get(key);
        if (pending) pending.savedGeneration = generation;
      }
    }).catch(error => {
      const pending = this.pending.get(key);
      if (pending) pending.draftError = `Draft not saved on this device: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }).finally(() => {
      this.draftWrites.delete(key);
      const pending = this.pending.get(key);
      if (pending) pending.draftSaving = false;
      this.emit();
    });
    this.draftWrites.set(key, operation);
    return operation;
  }
  private async flush(key: DocumentKey) {
    const pending = this.pending.get(key);
    if (!pending || pending.inFlight || pending.blocked || !this.snapshot) return;
    const generation = pending.generation;
    const revision = this.snapshot.documents[key].revision;
    const submitted = copy(pending.value);
    pending.inFlight = true;
    try {
      const reply = await this.bridge.request<CommitReply>("commit", { key, value: submitted, expectedRevision: revision, transactionId: transactionId() });
      const current = this.pending.get(key)!;
      current.inFlight = false;
      if (!reply.accepted) {
        current.blocked = true;
        current.error = reply.error ?? "Your data changed. Review the preserved draft.";
        // Preserve the newest edit, including typing that happened while committing.
        await this.preserveDraft(key);
        this.receive(reply.snapshot);
        return;
      }
      if (current.generation === generation) this.pending.delete(key);
      // Keep queued edits tied to the exact accepted base. A later remote update
      // must cause a CAS rejection, never authorize overwriting that update.
      const acceptedRevision = reply.snapshot.documents[key].revision;
      this.receive(reply.snapshot);
      if (this.pending.has(key) && this.snapshot!.documents[key].revision !== acceptedRevision) {
        const queued = this.pending.get(key)!;
        queued.blocked = true; queued.error = "Another change arrived while saving. Review your draft.";
        await this.preserveDraft(key);
      } else if (this.pending.has(key)) void this.flush(key);
      this.emit();
    } catch (error) {
      const current = this.pending.get(key);
      if (current) { current.inFlight = false; current.blocked = true; current.error = error instanceof Error ? error.message : String(error); }
      if (current && !current.draftError) await this.preserveDraft(key).catch(() => {});
      this.emit();
    }
  }
  async resolveDraft(key: DocumentKey, keep: boolean) {
    const pending = this.pending.get(key);
    if (!pending || pending.inFlight) return;
    if (pending.resolving || !this.snapshot) return;
    // Use the revision displayed during review; a later update needs a new decision.
    const expectedRevision = this.snapshot.documents[key].revision;
    pending.resolving = true; this.emit();
    try {
      await this.preserveDraft(key);
      const reply = await this.bridge.request<CommitReply>("resolveDraft", { key, value: copy(pending.value), expectedRevision, transactionId: transactionId(), useLocal: keep });
      if (!reply.accepted) {
        this.receive(reply.snapshot);
        throw new Error(reply.error ?? "Another change arrived. Review both copies again.");
      }
      this.pending.delete(key);
      this.receive(reply.snapshot);
    } finally { pending.resolving = false; this.emit(); }
  }
}
