import * as DB from "./db";
import * as Stream from "./stream";
import { copyJson, equalJson, isRecursiveTodo, mergeTaskDocuments, TaskMergeConflict } from "./taskMerge";

export interface RemoteSyncOptions { url: string; token?: string; }
export interface RemoteRecovery {
  id: string;
  key: string;
  at: string;
  reason: "conflict" | "noBaseline" | "rebaseConflict";
  localValue?: unknown;
  remoteValue?: unknown;
  baseValue?: unknown;
  currentVersion?: number;
  conflicts?: string[];
  resolvedAt?: string;
}
export interface RemoteSyncSession extends Stream.Stream<Error> {
  stop: () => void;
  getRecoveries: () => RemoteRecovery[];
  resolveRecovery: (id: string, choice: "local" | "remote") => Promise<void>;
  exportRecovery: () => string;
}
interface Change {
  key: string; value?: unknown; deleted?: boolean; version?: number;
  baseVersion?: number; baseValue?: unknown; todoSchemaVersion?: number;
}
interface Baseline { version: number; value?: unknown; }
interface Metadata { bases: Record<string, Baseline>; recoveries: RemoteRecovery[]; }
interface WriteResponse { ok: boolean; versions?: Record<string, number>; changes?: Change[]; }
const emptyMetadata = (): Metadata => ({ bases: {}, recoveries: [] });
const memoryMetadata = new Map<string, Metadata>();
const fallbackMetadataKeys = new Set<string>();
const activeResolvers = new Map<string, RemoteSyncSession["resolveRecovery"]>();
export const remoteRecoveryEvent = "localflow:sync-recovery";
const scopeKey = (options: RemoteSyncOptions, name: string) => `__localflow_remote_sync__/${encodeURIComponent(options.url.replace(/\/$/, ""))}/${encodeURIComponent(name)}`;

function readMetadata(key: string): Metadata {
  if (fallbackMetadataKeys.has(key)) return copyJson(memoryMetadata.get(key) ?? emptyMetadata());
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Metadata;
      if (parsed.bases && Array.isArray(parsed.recoveries)) return parsed;
    }
    if (typeof localStorage !== "undefined") return emptyMetadata();
  } catch { /* browser storage fallback below */ }
  return copyJson(memoryMetadata.get(key) ?? emptyMetadata());
}

/** Large histories can exceed localStorage quota; keep their baselines in a separate IDB. */
function indexedMetadata(key: string, value?: Metadata): Promise<Metadata | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("localflow/sync-metadata", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("metadata");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const connection = open.result;
      const transaction = connection.transaction("metadata", value ? "readwrite" : "readonly");
      const request = value ? transaction.objectStore("metadata").put(value, key) : transaction.objectStore("metadata").get(key);
      let result: Metadata | undefined;
      request.onsuccess = () => { if (!value) result = request.result as Metadata | undefined; };
      transaction.oncomplete = () => { connection.close(); resolve(result); };
      transaction.onerror = () => { connection.close(); reject(transaction.error); };
      transaction.onabort = () => { connection.close(); reject(transaction.error); };
    };
  });
}

async function loadMetadata(key: string): Promise<Metadata> {
  const local = readMetadata(key);
  if (Object.keys(local.bases).length || local.recoveries.length) return local;
  try {
    if (typeof browser !== "undefined" && browser.storage?.local) {
      const stored = await browser.storage.local.get(key);
      const value = stored[key] as Metadata | undefined;
      if (value?.bases && Array.isArray(value.recoveries)) { memoryMetadata.set(key, value); return copyJson(value); }
    }
  } catch { /* sync still works; the error stream reports a failed subsequent save */ }
  try {
    if (typeof indexedDB !== "undefined") {
      const value = await indexedMetadata(key);
      if (value?.bases && Array.isArray(value.recoveries)) {
        memoryMetadata.set(key, value); fallbackMetadataKeys.add(key); return copyJson(value);
      }
    }
  } catch { /* subsequent writes report unavailable durable recovery storage */ }
  return local;
}

export function readRemoteRecoveries(options: RemoteSyncOptions, name: string): RemoteRecovery[] {
  return copyJson(readMetadata(scopeKey(options, name)).recoveries);
}

export async function resolveRemoteRecovery(options: RemoteSyncOptions, name: string, id: string, choice: "local" | "remote"): Promise<void> {
  const resolver = activeResolvers.get(scopeKey(options, name));
  if (!resolver) throw new Error("Reconnect sync before resolving this recovery.");
  await resolver(id, choice);
}

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) { super(message); }
}
const validChange = (value: unknown): value is Change => typeof value === "object" && value !== null && "key" in value && typeof value.key === "string";
const isTodo = (key: string, ...values: unknown[]) => key === "data/default-todo" || values.some(isRecursiveTodo);

/** Retire old equal-copy task notices when sync is off and no live resolver exists. */
export async function resolveIdenticalOfflineRecoveries(
  options: RemoteSyncOptions,
  name: string,
  localValue: (key: string) => unknown,
): Promise<void> {
  const key = scopeKey(options, name);
  if (activeResolvers.has(key)) return;
  const metadata = await loadMetadata(key);
  if (activeResolvers.has(key)) return;
  let changed = false;
  for (const recovery of metadata.recoveries) {
    if (recovery.resolvedAt || !isTodo(recovery.key, recovery.localValue, recovery.remoteValue)) continue;
    const current = localValue(recovery.key);
    if (!equalJson(current, recovery.localValue) || !equalJson(current, recovery.remoteValue)) continue;
    recovery.resolvedAt = new Date().toISOString();
    changed = true;
  }
  if (!changed) return;
  const saved = copyJson(metadata);
  memoryMetadata.set(key, saved);
  if (!fallbackMetadataKeys.has(key)) {
    try {
      localStorage.setItem(key, JSON.stringify(saved));
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined")
        window.dispatchEvent(new CustomEvent(remoteRecoveryEvent));
      return;
    } catch { /* use durable fallback below */ }
  }
  try {
    localStorage.removeItem(key);
    localStorage.setItem(key, JSON.stringify({ largeMetadata: true }));
  } catch { /* browser storage and IndexedDB remain available */ }
  if (typeof browser !== "undefined" && browser.storage?.local) {
    fallbackMetadataKeys.add(key);
    await browser.storage.local.set({ [key]: saved });
  } else if (typeof indexedDB !== "undefined") {
    fallbackMetadataKeys.add(key);
    await indexedMetadata(key, saved);
  } else throw new Error("Cannot save resolved sync recovery metadata.");
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined")
    window.dispatchEvent(new CustomEvent(remoteRecoveryEvent));
}

/** The acknowledged raw document and its version are always stored as one baseline. */
export const remoteSync = async (db: DB.Database, name: string, options: RemoteSyncOptions): Promise<RemoteSyncSession> => {
  const errors = Stream.init<Error>();
  const baseUrl = options.url.replace(/\/$/, "");
  const path = `/v1/stores/${name.split("/").map(encodeURIComponent).join("/")}`;
  const metadataKey = scopeKey(options, name);
  let metadata = readMetadata(metadataKey);
  let active = true, initialized = false, applyingRemote = false, writing = false, pulling = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  let persisting = Promise.resolve();
  const pending = new Map<string, unknown>();
  const blocked = new Set(metadata.recoveries.filter((recovery) => !recovery.resolvedAt).map((recovery) => recovery.key));
  const versions = new Map<string, number>();
  for (const [key, base] of Object.entries(metadata.bases)) versions.set(key, base.version);

  const publishError = (message: string, cause: unknown) => {
    const error = new Error(`Remote sync: ${name}: ${message}. Local edits are saved on this device.`);
    error.name = "StorageError";
    (error as Error & { cause?: unknown }).cause = cause;
    if (active) Stream.publish(errors, error);
  };

  const notifyRecovery = () => {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent !== "undefined")
      window.dispatchEvent(new CustomEvent(remoteRecoveryEvent, { detail: { scope: metadataKey, recoveries: copyJson(metadata.recoveries) } }));
  };

  const persist = () => {
    const value = copyJson(metadata);
    memoryMetadata.set(metadataKey, value);
    try {
      if (typeof localStorage !== "undefined" && !fallbackMetadataKeys.has(metadataKey)) { localStorage.setItem(metadataKey, JSON.stringify(value)); return; }
    } catch { /* extension storage is independent of the synced config namespace */ }
    try {
      if (typeof localStorage !== "undefined") { localStorage.removeItem(metadataKey); localStorage.setItem(metadataKey, JSON.stringify({ largeMetadata: true })); }
    } catch { /* denied/full localStorage still permits an independent durable fallback */ }
    if (typeof browser !== "undefined" && browser.storage?.local) {
      fallbackMetadataKeys.add(metadataKey);
      persisting = persisting.then(() => browser.storage.local.set({ [metadataKey]: value })).catch((error) => publishError("Cannot save sync recovery metadata", error));
    } else if (typeof indexedDB !== "undefined") {
      fallbackMetadataKeys.add(metadataKey);
      persisting = persisting.then(() => indexedMetadata(metadataKey, value)).then(() => undefined).catch((error) => publishError("Cannot save sync recovery metadata", error));
    } else publishError("Persistent sync recovery storage is unavailable", new Error("No local storage provider"));
  };

  const baseline = (key: string, version: number, value: unknown) => {
    versions.set(key, version);
    if (isTodo(key, value, metadata.bases[key]?.value)) {
      metadata.bases[key] = { version, value: copyJson(value) };
      persist();
    }
  };

  const apply = (key: string, value: unknown) => {
    if (!active || equalJson(DB.get(db, key), value)) return;
    applyingRemote = true;
    try { DB.put(db, key, copyJson(value)); } finally { applyingRemote = false; }
  };

  const recover = (key: string, reason: RemoteRecovery["reason"], localValue: unknown, remoteValue: unknown, currentVersion?: number, baseValue?: unknown, conflicts?: string[]) => {
    const previous = metadata.recoveries.find((item) => item.key === key && !item.resolvedAt);
    const recovery: RemoteRecovery = {
      id: previous?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`, key,
      at: previous?.at ?? new Date().toISOString(), reason,
      localValue: copyJson(localValue), remoteValue: copyJson(remoteValue), baseValue: copyJson(baseValue), currentVersion,
      conflicts: conflicts ?? previous?.conflicts,
    };
    metadata.recoveries = previous ? metadata.recoveries.map((item) => item.id === previous.id ? recovery : item) : [...metadata.recoveries, recovery];
    blocked.add(key);
    pending.set(key, copyJson(localValue));
    persist();
    notifyRecovery();
  };

  const request = async <T,>(suffix = "", init?: RequestInit): Promise<T> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(`${baseUrl}${path}${suffix}`, { cache: "no-store", ...init, headers: { ...headers, ...init?.headers } });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new RequestError(`${response.status} ${response.statusText}`, response.status, payload);
    return payload as T;
  };

  const scheduleRetry = () => {
    if (!active || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (initialized) { void pull(); void pump(); } else void initialize();
    }, retryDelay);
    retryDelay = Math.min(60000, retryDelay * 2);
  };

  const prepare = ([key, value]: DB.Change): Change => {
    const change: Change = value === undefined ? { key, deleted: true } : { key, value: copyJson(value) };
    const base = metadata.bases[key];
    if (isTodo(key, value, base?.value)) {
      change.baseVersion = base?.version ?? versions.get(key) ?? 0;
      if (base?.value !== undefined) change.baseValue = copyJson(base.value);
      if (value === undefined || isRecursiveTodo(value)) change.todoSchemaVersion = 2;
    } else if (versions.has(key)) change.baseVersion = versions.get(key);
    return change;
  };

  const pump = async (): Promise<void> => {
    if (!active || !initialized || writing || pulling) return;
    const entries = [...pending].filter(([key]) => !blocked.has(key));
    if (!entries.length) return;
    writing = true;
    const changes = entries.map(prepare);
    try {
      const response = await request<WriteResponse>("/changes", { method: "POST", body: JSON.stringify({ changes, clientId: `extension-${typeof BUILD_TARGET !== "undefined" ? BUILD_TARGET : "web"}` }) });
      if (!response.ok) throw new Error("Server did not acknowledge this write.");
      for (const change of changes) {
        const savedChange = response.changes?.find((item) => item.key === change.key);
        const saved = savedChange ? savedChange.deleted ? undefined : savedChange.value : change.deleted ? undefined : change.value;
        const version = savedChange?.version ?? response.versions?.[change.key] ?? (change.baseVersion ?? 0) + 1;
        const submitted = change.deleted ? undefined : change.value;
        const latest = pending.has(change.key) ? pending.get(change.key) : DB.get(db, change.key);
        // The response snapshot is the baseline even when newer edits arrived in flight.
        baseline(change.key, version, saved);
        if (!active) continue;
        if (equalJson(latest, submitted)) {
          pending.delete(change.key);
          apply(change.key, saved);
        } else if (isRecursiveTodo(submitted) && isRecursiveTodo(latest) && isRecursiveTodo(saved)) {
          try {
            const rebased = mergeTaskDocuments(submitted, latest, saved);
            apply(change.key, rebased);
            if (equalJson(rebased, saved)) pending.delete(change.key); else pending.set(change.key, rebased);
          } catch (error) {
            recover(change.key, "rebaseConflict", latest, saved, version, submitted, error instanceof TaskMergeConflict ? error.conflicts : undefined);
            publishError("New queued edits overlap with merged server changes; review task recovery", error);
          }
        }
      }
      retryDelay = 1000;
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) {
        const payload = error.detail as { detail?: unknown } | undefined;
        const detail = (payload?.detail ?? payload) as { key?: string; currentValue?: unknown; currentVersion?: number; currentDeleted?: boolean; conflicts?: string[] } | undefined;
        const key = detail?.key;
        if (key && changes.some((change) => change.key === key)) {
          const current = detail?.currentDeleted ? undefined : detail?.currentValue;
          const oldBase = metadata.bases[key]?.value;
          if (typeof detail?.currentVersion === "number") baseline(key, detail.currentVersion, current);
          recover(key, "conflict", DB.get(db, key), current, detail?.currentVersion, oldBase, detail?.conflicts);
        } else for (const change of changes) recover(change.key, "conflict", DB.get(db, change.key), undefined, undefined, metadata.bases[change.key]?.value);
        publishError("A concurrent edit requires recovery review", error);
      } else if (error instanceof RequestError && (error.status === 400 || error.status === 422 || error.status === 426 || error.status === 428)) {
        for (const change of changes) recover(change.key, "conflict", DB.get(db, change.key), metadata.bases[change.key]?.value, versions.get(change.key), metadata.bases[change.key]?.value, [error.message]);
        publishError("The server rejected this document; edit it and review recovery before retrying", error);
      } else { publishError("Cannot push changes; retrying automatically", error); scheduleRetry(); }
    } finally {
      writing = false;
    }
    if (active && !retry && [...pending.keys()].some((key) => !blocked.has(key))) void pump();
  };

  const reconcile = (change: Change, initial: boolean) => {
    const key = change.key;
    const remote = change.deleted ? undefined : copyJson(change.value);
    const version = change.version ?? 0;
    const local = DB.get(db, key);
    const base = metadata.bases[key];
    const todo = isTodo(key, local, remote, base?.value);
    if (todo && typeof versions.get(key) === "number" && version < versions.get(key)!) {
      recover(key, "conflict", local, remote, version, base?.value, ["$version: the server snapshot is older than the last acknowledged revision"]);
      return;
    }
    if (blocked.has(key)) {
      recover(key, metadata.recoveries.find((item) => item.key === key && !item.resolvedAt)?.reason ?? "conflict", local, remote, version, base?.value);
      baseline(key, version, remote);
      return;
    }
    if (!initial && versions.get(key) === version) return;
    const dirty = pending.has(key) || (todo && base && !equalJson(local, base.value));
    if (todo && dirty && base && !equalJson(local, remote)) {
      if (isRecursiveTodo(base.value) && isRecursiveTodo(local) && isRecursiveTodo(remote)) {
        try {
          const merged = mergeTaskDocuments(base.value, local, remote);
          baseline(key, version, remote);
          apply(key, merged);
          if (equalJson(merged, remote)) pending.delete(key); else pending.set(key, merged);
          return;
        } catch (error) {
          recover(key, "conflict", local, remote, version, base.value, error instanceof TaskMergeConflict ? error.conflicts : undefined);
          baseline(key, version, remote);
          return;
        }
      }
      recover(key, "conflict", local, remote, version, base.value);
      baseline(key, version, remote);
      return;
    }
    // A locally persisted document with no baseline must never be silently replaced.
    if (initial && todo && !base && local !== undefined && (db.cache.has(key) || pending.has(key)) && !equalJson(local, remote)) {
      recover(key, "noBaseline", local, remote, version);
      baseline(key, version, remote);
      return;
    }
    baseline(key, version, remote);
    if (dirty) {
      if (equalJson(local, remote)) pending.delete(key);
    } else apply(key, remote);
  };

  const snapshot = async (initial: boolean) => {
    const response = await request<{ changes: Change[] }>();
    if (!active) return;
    const remote = Array.isArray(response.changes) ? response.changes.filter(validChange) : [];
    const remoteKeys = new Set(remote.map((change) => change.key));
    // An old recovery no longer needs a choice once the live device and server
    // copies agree. Resolve it through the same "Use server copy" path as the UI.
    for (const recovery of metadata.recoveries.filter((item) => !item.resolvedAt)) {
      const change = remote.find((item) => item.key === recovery.key);
      const remoteValue = change?.deleted ? undefined : change?.value;
      const knownVersion = versions.get(recovery.key);
      if (change && knownVersion !== undefined && (change.version ?? 0) < knownVersion) continue;
      if (!equalJson(DB.get(db, recovery.key), remoteValue)) continue;
      recovery.remoteValue = copyJson(remoteValue);
      recovery.currentVersion = change?.version ?? 0;
      await resolveRecovery(recovery.id, "remote");
    }
    for (const change of remote) {
      const legacyPlan = change.key === "widget/default-plan" && !change.deleted && typeof change.value === "object" && change.value !== null && "key" in change.value && change.value.key === "widget/planOfDay";
      if (legacyPlan) { versions.set(change.key, change.version ?? 0); pending.set(change.key, undefined); continue; }
      reconcile(change, initial);
    }
    if (initial) {
      for (const [key, value] of db) if (!remoteKeys.has(key) && value !== undefined) { versions.set(key, 0); pending.set(key, copyJson(value)); }
      // A known tombstone may have disappeared after server retention/restore.
      for (const [key, base] of Object.entries(metadata.bases)) {
        if (remoteKeys.has(key) || pending.has(key)) continue;
        const local = DB.get(db, key);
        if (!equalJson(local, base.value)) pending.set(key, copyJson(local));
      }
    }
  };

  const initialize = async () => {
    if (!active || initialized || pulling) return;
    pulling = true;
    try {
      await snapshot(true);
      if (!active) return;
      initialized = true;
      retryDelay = 1000;
    } catch (error) { publishError("Cannot fetch initial snapshot; retrying automatically", error); scheduleRetry(); }
    finally { pulling = false; }
    if (initialized) void pump();
  };

  const pull = async () => {
    if (!active || pulling || writing) return;
    if (!initialized) return initialize();
    pulling = true;
    try { await snapshot(false); retryDelay = 1000; }
    catch (error) { publishError("Cannot fetch remote updates; retrying automatically", error); scheduleRetry(); }
    finally { pulling = false; }
    void pump();
  };

  const resolveRecovery: RemoteSyncSession["resolveRecovery"] = async (id, choice) => {
    const recovery = metadata.recoveries.find((item) => item.id === id && !item.resolvedAt);
    if (!recovery) return;
    if (typeof recovery.currentVersion !== "number") throw new Error("Fetch the latest remote snapshot before resolving this recovery.");
    baseline(recovery.key, recovery.currentVersion, recovery.remoteValue);
    if (choice === "remote") { pending.delete(recovery.key); apply(recovery.key, recovery.remoteValue); }
    else pending.set(recovery.key, copyJson(DB.get(db, recovery.key)));
    recovery.resolvedAt = new Date().toISOString();
    blocked.delete(recovery.key);
    persist(); notifyRecovery();
    await pump();
  };

  const onFocus = () => { void pull(); };
  const onClose = () => { if (debounce) { clearTimeout(debounce); debounce = undefined; } void pump(); persist(); };
  const unsubscribe = DB.listen(db, ([key, value]) => {
    if (!active || applyingRemote) return;
    pending.set(key, copyJson(value));
    const recovery = metadata.recoveries.find((item) => item.key === key && !item.resolvedAt);
    if (recovery) { recovery.localValue = copyJson(value); persist(); notifyRecovery(); }
    if (!debounce) debounce = setTimeout(() => { debounce = undefined; void pump(); }, 1000);
  });
  const interval = setInterval(onFocus, 15000);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    window.addEventListener("beforeunload", onClose);
  }
  const session: RemoteSyncSession = {
    ...errors,
    getRecoveries: () => copyJson(metadata.recoveries),
    resolveRecovery,
    exportRecovery: () => JSON.stringify({ server: baseUrl, store: name, exportedAt: new Date().toISOString(), ...metadata }, null, 2),
    stop: () => {
      active = false; unsubscribe();
      if (debounce) clearTimeout(debounce);
      if (retry) clearTimeout(retry);
      clearInterval(interval);
      if (activeResolvers.get(metadataKey) === resolveRecovery) activeResolvers.delete(metadataKey);
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("online", onFocus);
        window.removeEventListener("beforeunload", onClose);
      }
    },
  };
  activeResolvers.set(metadataKey, resolveRecovery);
  void loadMetadata(metadataKey).then(async (loaded) => {
    if (!active) return;
    metadata = loaded;
    for (const recovery of loaded.recoveries) if (!recovery.resolvedAt) blocked.add(recovery.key);
    for (const [key, base] of Object.entries(loaded.bases)) versions.set(key, base.version);
    for (const recovery of metadata.recoveries.filter((item) => !item.resolvedAt)) {
      if (!isTodo(recovery.key, recovery.localValue, recovery.remoteValue)) continue;
      const local = DB.get(db, recovery.key);
      if (!equalJson(local, recovery.localValue) || !equalJson(local, recovery.remoteValue)) continue;
      recovery.currentVersion ??= metadata.bases[recovery.key]?.version ?? 0;
      await resolveRecovery(recovery.id, "remote");
    }
    notifyRecovery();
    void initialize();
  });
  return session;
};
