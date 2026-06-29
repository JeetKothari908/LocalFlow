import React from "react";
import { SyncSettings } from "../../db/syncSettings";

type Props = {
  settings: SyncSettings;
};

type Revision = {
  id: number;
  key: string;
  version: number;
  value?: unknown;
  deleted: boolean;
  changedAt: number;
  clientId?: string | null;
  operation: "baseline" | "write" | "restore";
  restoredFrom?: number | null;
};

type HistoryResponse = {
  revisions: Revision[];
};

const store = "tabliss/config";
const historyKeys = [
  { key: "data/default-todo", label: "Todos" },
  { key: "data/default-notes", label: "Notes" },
  { key: "data/default-plan-of-day", label: "Plan of the Day" },
];

const summarize = (revision: Revision): string => {
  if (revision.deleted) return "Deleted";
  if (
    typeof revision.value !== "object" ||
    revision.value === null ||
    Array.isArray(revision.value)
  )
    return "Saved value";

  const value = revision.value as Record<string, unknown>;
  if (Array.isArray(value.items))
    return `${value.items.length} ${revision.key.includes("notes") ? "nodes" : "items"}`;
  if (
    typeof value.plans === "object" &&
    value.plans !== null &&
    !Array.isArray(value.plans)
  )
    return `${Object.keys(value.plans).length} dated plans`;
  return "Saved settings";
};

const RevisionHistory: React.FC<Props> = ({ settings }) => {
  const [selectedKey, setSelectedKey] = React.useState(historyKeys[0].key);
  const [revisions, setRevisions] = React.useState<Revision[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [message, setMessage] = React.useState<string>();

  const request = React.useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const baseUrl = settings.url.trim().replace(/\/$/, "");
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(settings.token.trim()
            ? { authorization: `Bearer ${settings.token.trim()}` }
            : {}),
          ...init?.headers,
        },
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        const detail =
          typeof payload?.detail === "string"
            ? payload.detail
            : `${response.status} ${response.statusText}`;
        throw new Error(detail);
      }
      return payload as T;
    },
    [settings.token, settings.url],
  );

  const loadHistory = React.useCallback(async () => {
    if (!settings.enabled || !settings.url.trim()) return;
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({
        store,
        key: selectedKey,
        limit: "50",
      });
      const result = await request<HistoryResponse>(`/v1/history?${query}`);
      setRevisions(result.revisions);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Cannot load history",
      );
    } finally {
      setLoading(false);
    }
  }, [request, selectedKey, settings.enabled, settings.url]);

  React.useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const restore = async (revision: Revision) => {
    if (
      !confirm(
        `Restore ${historyKeys.find((item) => item.key === selectedKey)?.label} version ${revision.version}?`,
      )
    )
      return;

    setLoading(true);
    setError(undefined);
    try {
      await request("/v1/history/restore", {
        method: "POST",
        body: JSON.stringify({
          store,
          key: selectedKey,
          version: revision.version,
          baseVersion: revisions[0]?.version,
          clientId: `extension-${BUILD_TARGET}`,
        }),
      });
      setMessage(`Restored version ${revision.version}. Reloading…`);
      window.setTimeout(() => window.location.reload(), 500);
    } catch (restoreError) {
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : "Cannot restore revision",
      );
      setLoading(false);
    }
  };

  const purge = async () => {
    if (
      !confirm(
        "Permanently erase all older revisions for this data? The current value will be retained as the new baseline.",
      )
    )
      return;

    setLoading(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const query = new URLSearchParams({ store, key: selectedKey });
      await request(`/v1/history?${query}`, { method: "DELETE" });
      setMessage("Older revisions permanently erased.");
      await loadHistory();
    } catch (purgeError) {
      setError(
        purgeError instanceof Error
          ? purgeError.message
          : "Cannot erase history",
      );
      setLoading(false);
    }
  };

  if (!settings.enabled || !settings.url.trim()) return null;

  return (
    <div className="revision-history">
      <h3>Revision history</h3>
      <label>
        Data
        <select
          value={selectedKey}
          onChange={(event) => {
            setSelectedKey(event.target.value);
            setMessage(undefined);
          }}
        >
          {historyKeys.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      {loading && <p className="info">Loading…</p>}
      {error && <p className="history-error">{error}</p>}
      {message && <p className="history-message">{message}</p>}
      {!loading && !error && revisions.length === 0 && (
        <p className="info">No revisions recorded yet.</p>
      )}

      <div className="history-list">
        {revisions.map((revision, index) => (
          <div className="history-entry" key={revision.id}>
            <div>
              <strong>Version {revision.version}</strong>
              {index === 0 && <span className="history-current">current</span>}
              <small>
                {new Date(revision.changedAt * 1000).toLocaleString()} ·{" "}
                {revision.operation}
                {revision.restoredFrom ? ` from v${revision.restoredFrom}` : ""}
              </small>
              <small>{summarize(revision)}</small>
            </div>
            {index !== 0 && (
              <button
                className="button button--secondary"
                disabled={loading}
                onClick={() => restore(revision)}
                type="button"
              >
                Restore
              </button>
            )}
          </div>
        ))}
      </div>

      {revisions.length > 1 && (
        <button
          className="button history-purge"
          disabled={loading}
          onClick={purge}
          type="button"
        >
          Erase older revisions
        </button>
      )}
    </div>
  );
};

export default RevisionHistory;
