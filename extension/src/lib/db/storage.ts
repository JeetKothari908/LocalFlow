import * as DB from "./db";
import * as Stream from "./stream";

/** IndexedDB storage provider */
// TODO: clean up indexeddb usage, convert to promises and double check error handling
export const indexeddb = (
  db: DB.Database,
  name: string,
): Promise<Stream.Stream<StorageError>> => {
  // Map idb errors to a standard format
  const mapError = (message: string, err: unknown): StorageError => {
    const cause =
      err instanceof Event &&
      err.target instanceof IDBRequest &&
      err.target.error instanceof Error
        ? err.target.error
        : undefined;
    return new StorageError(`IndexedDB: ${name}: ${message}`, { cause });
  };

  return new Promise((resolve, reject) => {
    const rejectError = (message: string) => (err: unknown) => {
      reject(mapError(message, err));
    };

    const open = indexedDB.open(name, 1);
    open.onerror = rejectError("Cannot open database");
    open.onupgradeneeded = () => {
      open.result.createObjectStore("changes");
    };
    open.onsuccess = () => {
      const conn = open.result;

      const trx = conn.transaction("changes", "readonly");
      trx.onerror = rejectError("Cannot read changes from store");

      const changes: DB.Change[] = [];
      const cursor = trx.objectStore("changes").openCursor();
      cursor.onsuccess = () => {
        if (cursor.result) {
          if (typeof cursor.result.key === "string")
            changes.push([cursor.result.key, cursor.result.value]);
          cursor.result.continue();
        } else {
          // Finished loading
          DB.atomic(db, (trx) => {
            changes.forEach(([key, val]) => DB.put(trx, key, val));
          });

          // Write
          const errors = Stream.init<StorageError>();
          DB.listen(
            db,
            batch((changes) => {
              if (DEV) console.log("Storage: saving changes:", changes);

              const trx = conn.transaction("changes", "readwrite");
              trx.oncomplete = () => {}; // nice
              trx.onerror = (error) =>
                Stream.publish(
                  errors,
                  mapError("Cannot write changes to store", error),
                );

              const store = trx.objectStore("changes");
              // TODO: iterator helpers
              for (const [key, val] of changes) {
                if (val === undefined) store.delete(key);
                else store.put(val, key);
              }
            }),
          );
          resolve(errors);
        }
      };
    };
  });
};

/** Web Extension storage provider */
export const extension = async (
  db: DB.Database,
  name: string,
  area: "local" | "sync" | "managed",
): Promise<Stream.Stream<StorageError>> => {
  // Map errors to a standard format
  const mapError = (message: string, err: unknown) =>
    new StorageError(`Extension[${area}]: ${name}: ${message}`, {
      cause: err instanceof Error ? err : undefined,
    });

  const storageArea = browser.storage[area];

  // Pull
  await storageArea
    .get()
    .then((stored) =>
      Object.keys(stored)
        .filter((key) => key.startsWith(name))
        .forEach((key) =>
          DB.put(db, key.substring(name.length + 1), stored[key]),
        ),
    )
    .catch((error) => {
      throw mapError("Cannot read from storage", error);
    });

  // Push
  const errors = Stream.init<StorageError>();
  const handleError = (message: string) => (err: unknown) => {
    Stream.publish(errors, mapError(message, err));
  };
  const write = createExtensionWriter(area);
  DB.listen(
    db,
    batch(
      (changes) => {
        if (DEV) console.log("Storage: saving changes:", changes);

        // TODO: test for both updates and deletes for the same key
        // TODO: iterator helpers
        const changesArray = Array.from(changes);
        const updates = Object.fromEntries(
          changesArray
            .filter(([, val]) => val !== undefined)
            .map(([key, val]) => [`${name}/${key}`, val]),
        );
        const deletes = changesArray
          .filter(([, val]) => val === undefined)
          .map(([key]) => `${name}/${key}`);

        if (Object.keys(updates).length > 0)
          write(
            () => storageArea.set(updates),
            handleError("Cannot write updates to storage"),
          );
        if (deletes.length > 0)
          write(
            () => storageArea.remove(deletes),
            handleError("Cannot write deletes to storage"),
          );
      },
      area === "sync" ? syncBatchTimeout : 0,
    ),
  );

  return errors;
};

/** Web Extension local storage provider with one-time sync import */
export const extensionLocal = async (
  db: DB.Database,
  name: string,
): Promise<Stream.Stream<StorageError>> => {
  const localStored = await browser.storage.local.get();
  const localHasConfig = Object.keys(localStored).some((key) =>
    key.startsWith(name),
  );

  if (!localHasConfig) {
    const syncStored = await browser.storage.sync.get();
    const syncConfig = Object.fromEntries(
      Object.entries(syncStored).filter(([key]) => key.startsWith(name)),
    );
    if (Object.keys(syncConfig).length > 0)
      await browser.storage.local.set(syncConfig);
  }

  return extension(db, name, "local");
};

export interface RemoteSyncOptions {
  url: string;
  token?: string;
}

export interface RemoteSyncSession extends Stream.Stream<StorageError> {
  stop: () => void;
}

interface RemoteSnapshot {
  changes: RemoteChange[];
}

interface RemoteChange {
  key: string;
  value?: unknown;
  deleted?: boolean;
  version?: number;
  updatedAt?: number;
  baseVersion?: number;
}

interface RemoteWriteResponse {
  ok: boolean;
  versions?: Record<string, number>;
  requestId?: string;
}

class RemoteRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const isRemoteChange = (change: unknown): change is RemoteChange =>
  typeof change === "object" &&
  change !== null &&
  "key" in change &&
  typeof change.key === "string";

/** Remote HTTP sync provider */
export const remoteSync = async (
  db: DB.Database,
  name: string,
  options: RemoteSyncOptions,
): Promise<RemoteSyncSession> => {
  const baseUrl = options.url.replace(/\/$/, "");
  const errors = Stream.init<StorageError>();
  let active = true;
  let applyingRemote = false;
  let initialSyncComplete = false;
  const queuedLocalChanges = new Map<string, unknown>();
  const versions = new Map<string, number>();
  let remoteWriteQueue = Promise.resolve();
  const clientId = `extension-${BUILD_TARGET}`;

  const mapError = (message: string, err: unknown) => {
    const detail =
      err instanceof RemoteRequestError && err.status === 409
        ? " A newer version exists on another device; refresh before retrying."
        : "";
    return new StorageError(`Remote sync: ${name}: ${message}.${detail}`, {
      cause: err instanceof Error ? err : undefined,
    });
  };
  const storePath = name.split("/").map(encodeURIComponent).join("/");

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    console.info("[todo-sync] request:", init?.method || "GET", path);
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...init?.headers,
      },
    });

    const payload = await res.json().catch(() => undefined);
    if (!res.ok)
      throw new RemoteRequestError(
        `${res.status} ${res.statusText}`,
        res.status,
        payload,
      );
    return payload as T;
  };

  const postChanges = async (changes: RemoteChange[]): Promise<void> => {
    if (!active) return;
    if (changes.length === 0) return;

    console.info("[todo-sync] pushing local changes:", changes.length);

    const response = await request<RemoteWriteResponse>(
      `/v1/stores/${storePath}/changes`,
      {
        method: "POST",
        body: JSON.stringify({ changes, clientId }),
      },
    );

    for (const [key, version] of Object.entries(response.versions || {}))
      versions.set(key, version);
  };

  const prepareChanges = (changes: Iterable<DB.Change>): RemoteChange[] =>
    Array.from(changes).map(([key, value]) => {
      const change: RemoteChange =
        value === undefined ? { key, deleted: true } : { key, value };
      const baseVersion = versions.get(key);
      if (baseVersion !== undefined) change.baseVersion = baseVersion;
      return change;
    });

  const pushChanges = (changes: Iterable<DB.Change>): Promise<void> =>
    postChanges(prepareChanges(changes));

  const enqueueChanges = (changes: Iterable<DB.Change>): void => {
    const pending = Array.from(changes);
    if (pending.length === 0) return;

    // Build baseVersion only after earlier writes finish so rapid local edits
    // use the version returned by the preceding request.
    const write = remoteWriteQueue.then(() =>
      postChanges(prepareChanges(pending)),
    );
    remoteWriteQueue = write.catch((error) => {
      Stream.publish(errors, mapError("Cannot push local changes", error));
    });
  };

  const runInitialSync = async (): Promise<void> => {
    console.info("[todo-sync] starting remote sync:", baseUrl);
    const snapshot = await request<RemoteSnapshot>(`/v1/stores/${storePath}`);
    if (!active) return;

    const remoteChanges = Array.isArray(snapshot.changes)
      ? snapshot.changes.filter(isRemoteChange)
      : [];
    console.info("[todo-sync] remote changes:", remoteChanges.length);
    for (const change of remoteChanges)
      if (typeof change.version === "number")
        versions.set(change.key, change.version);

    const legacyIosPlanWidgetRecord = remoteChanges.find(
      (change) =>
        !change.deleted &&
        change.key === "widget/default-plan" &&
        typeof change.value === "object" &&
        change.value !== null &&
        "key" in change.value &&
        change.value.key === "widget/planOfDay",
    );

    const legacyIosWidgetDeletions = legacyIosPlanWidgetRecord
      ? [{ key: legacyIosPlanWidgetRecord.key, deleted: true }]
      : [];

    const snapshotChanges = remoteChanges.filter(
      (change) =>
        !legacyIosWidgetDeletions.some(
          (deletion) => deletion.key === change.key,
        ),
    );

    if (snapshotChanges.length === 0) {
      const seedChanges: RemoteChange[] = [];
      for (const [key, value] of db) {
        if (value !== undefined) seedChanges.push({ key, value });
      }

      await postChanges(seedChanges);
      if (!active) return;

      console.info("[todo-sync] seeded remote changes:", seedChanges.length);
    } else {
      applyingRemote = true;
      DB.atomic(db, (trx) => {
        for (const change of snapshotChanges) {
          if (change.deleted) DB.del(trx, change.key);
          else DB.put(trx, change.key, change.value);
        }
      });
      applyingRemote = false;
    }

    if (legacyIosWidgetDeletions.length > 0) {
      await postChanges(
        legacyIosWidgetDeletions.map((change) => ({
          ...change,
          baseVersion: versions.get(change.key),
        })),
      );
      if (!active) return;

      console.info(
        "[todo-sync] removed legacy iOS plan widget records:",
        legacyIosWidgetDeletions.length,
      );
    }

    // Keep startup edits behind the initial snapshot. Changes that arrive
    // while a queued batch is being written are collected for the next pass.
    while (queuedLocalChanges.size > 0) {
      const pending = Array.from(queuedLocalChanges);
      queuedLocalChanges.clear();
      await pushChanges(pending);
    }
    initialSyncComplete = true;
  };

  runInitialSync().catch((error) => {
    applyingRemote = false;
    if (!active) return;
    // Without a snapshot we do not know the remote base versions. Keep all
    // edits local rather than sending an unguarded overwrite.
    active = false;

    const syncError = mapError("Cannot sync initial snapshot", error);
    console.error(syncError);
    setTimeout(() => Stream.publish(errors, syncError), 0);
  });

  const unsubscribe = DB.listen(
    db,
    batch((changes) => {
      if (!active || applyingRemote) return;

      if (!initialSyncComplete) {
        for (const [key, value] of changes) queuedLocalChanges.set(key, value);
        return;
      }

      enqueueChanges(changes);
    }, remoteSyncBatchTimeout),
  );

  return {
    ...errors,
    stop: () => {
      active = false;
      unsubscribe();
    },
  };
};

const syncBatchTimeout = 1500;
const syncWriteInterval = 3000;
const syncQuotaRetryTimeout = 60 * 1000;
const remoteSyncBatchTimeout = 1000;

const createExtensionWriter = (area: "local" | "sync" | "managed") => {
  if (area !== "sync")
    return (
      write: () => Promise<unknown>,
      handleError: (err: unknown) => void,
    ) => write().catch(handleError);

  let queue = Promise.resolve();
  let lastWrite = 0;

  return (
    write: () => Promise<unknown>,
    handleError: (err: unknown) => void,
  ): void => {
    const run = async (): Promise<void> => {
      const wait = Math.max(0, lastWrite + syncWriteInterval - Date.now());
      if (wait) await delay(wait);

      try {
        await write();
        lastWrite = Date.now();
      } catch (error) {
        if (isSyncQuotaError(error)) {
          await delay(syncQuotaRetryTimeout);
          return run();
        }
        throw error;
      }
    };

    queue = queue.then(run, run).catch(handleError);
  };
};

const isSyncQuotaError = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes("MAX_WRITE_OPERATIONS_PER_MINUTE");

const delay = (timeout: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, timeout));

const batch = (
  flush: (batch: Iterable<DB.Change>) => void,
  timeout = 0,
): DB.Listener => {
  const changes = new Map();
  let timer: number | null = null;

  const run = () => {
    flush(changes);
    changes.clear();
    timer = null;
  };

  // If there are pending changes on browser close, flush immediately
  window.addEventListener("beforeunload", () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  });

  return ([key, val]) => {
    changes.set(key, val);
    if (!timer) timer = setTimeout(run, timeout);
  };
};

/** Storage Error */
class StorageError extends Error {
  override name = "StorageError";
}
