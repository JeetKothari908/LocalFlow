import React, { useEffect, useMemo, useState } from "react";
import { getSyncSettings, subscribeSyncSettings } from "../../db/syncSettings";
import { db } from "../../db/state";
import { DB } from "../../lib";
import {
  readRemoteRecoveries,
  resolveRemoteRecovery,
  resolveIdenticalOfflineRecoveries,
  remoteRecoveryEvent,
  RemoteRecovery,
} from "../../lib/db/storage";
import {
  recoveryDifferences,
  recoveryRecordName,
  recoveryFieldName,
  recoveryValueSummary,
  recoveryValueText,
} from "../../lib/db/recoveryDiff";
import "./SyncRecovery.sass";

function RecoveryComparison({ recovery }: { recovery: RemoteRecovery }) {
  const differences = useMemo(
    () =>
      recoveryDifferences(
        recovery.localValue,
        recovery.remoteValue,
        recovery.baseValue,
        recovery.key,
      ),
    [recovery],
  );
  const groups = new Map<string, { title: string; rows: typeof differences }>();
  for (const difference of differences) {
    const group = groups.get(difference.group) ?? {
      title: difference.groupTitle,
      rows: [],
    };
    group.rows.push(difference);
    groups.set(difference.group, group);
  }
  const hasBase = Object.hasOwn(recovery, "baseValue");
  return (
    <div className="recovery-comparison">
      <dl className="recovery-copy-summary">
        <dt>This device</dt>
        <dd>{recoveryValueSummary(recovery.localValue)}</dd>
        <dt>Server</dt>
        <dd>{recoveryValueSummary(recovery.remoteValue)}</dd>
      </dl>
      {differences.length ? (
        <p>
          {differences.length} difference{differences.length === 1 ? "" : "s"}.
        </p>
      ) : (
        <p className="recovery-equal">
          The saved copies are identical. This is an unresolved recovery from an
          earlier difference.
        </p>
      )}
      {[...groups.entries()].map(([id, group]) => (
        <details
          key={id}
          className="recovery-difference-group"
          open={group.rows.length <= 8}
        >
          <summary>
            {group.title} <span>({group.rows.length})</span>
          </summary>
          <div className="recovery-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Field / record</th>
                  <th>This device</th>
                  <th>Server</th>
                  {hasBase && <th>Saved sync baseline</th>}
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.path}>
                    <th scope="row">
                      <strong className="recovery-field-name">
                        {recoveryFieldName(row.path, recovery.key)}
                      </strong>
                      <code>{row.path}</code>
                      <small>
                        {!row.localPresent
                          ? "Only on server"
                          : !row.remotePresent
                            ? "Only on this device"
                            : "Changed"}
                      </small>
                    </th>
                    <td>
                      <pre>
                        {recoveryValueText(row.local, row.localPresent)}
                      </pre>
                    </td>
                    <td>
                      <pre>
                        {recoveryValueText(row.remote, row.remotePresent)}
                      </pre>
                    </td>
                    {hasBase && (
                      <td>
                        <pre>
                          {recoveryValueText(row.base, row.basePresent)}
                        </pre>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      {recovery.conflicts?.length ? (
        <details className="recovery-conflict-paths">
          <summary>Why automatic sync stopped</summary>
          <ul>
            {recovery.conflicts.map((path, index) => (
              <li key={index}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <details className="recovery-raw-copies">
        <summary>Complete stored copies</summary>
        <h4>This device</h4>
        <pre>
          {recoveryValueText(
            recovery.localValue,
            recovery.localValue !== undefined,
          )}
        </pre>
        <h4>Server</h4>
        <pre>
          {recoveryValueText(
            recovery.remoteValue,
            recovery.remoteValue !== undefined,
          )}
        </pre>
        {hasBase && (
          <>
            <h4>Saved sync baseline</h4>
            <pre>{recoveryValueText(recovery.baseValue, true)}</pre>
          </>
        )}
      </details>
    </div>
  );
}

export default function SyncRecovery() {
  const [recoveries, setRecoveries] = useState<RemoteRecovery[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let resolvingOffline = false;
    const refresh = () =>
      setRecoveries(
        readRemoteRecoveries(getSyncSettings(), "tabliss/config").filter(
          (item) => !item.resolvedAt,
        ),
      );
    const update = () => {
      refresh();
      const settings = getSyncSettings();
      if (settings.enabled || resolvingOffline) return;
      resolvingOffline = true;
      void resolveIdenticalOfflineRecoveries(
        settings,
        "tabliss/config",
        (key) => DB.get(db, key as `data/${string}`),
      ).then(refresh).catch((reason) => {
        console.error("Cannot clear identical sync recoveries", reason);
      }).finally(() => { resolvingOffline = false; });
    };
    update();
    window.addEventListener(remoteRecoveryEvent, update);
    const unsubscribe = subscribeSyncSettings(update);
    return () => {
      window.removeEventListener(remoteRecoveryEvent, update);
      unsubscribe();
    };
  }, []);
  const active = recoveries.length > 0;
  if (!active) return null;
  const resolve = async (
    recovery: RemoteRecovery,
    choice: "local" | "remote",
  ) => {
    setBusy(true);
    setError("");
    try {
      await resolveRemoteRecovery(
        getSyncSettings(),
        "tabliss/config",
        recovery.id,
        choice,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const exportRecovery = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(recoveries, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "localflow-task-recovery.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="SyncRecovery" aria-label="Sync recovery">
      <header>
        <button
          className="recovery-heading"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          Sync needs a decision <span>({recoveries.length})</span>
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </button>
      </header>
      {expanded && (
        <div className="recovery-content">
          <p>Compare the saved copies before choosing which record to keep.</p>
          {recoveries.map((item) => (
            <details key={item.id} className="recovery-record" open>
              <summary>
                {recoveryRecordName(item.key)}{" "}
                <small>{new Date(item.at).toLocaleString()}</small>
              </summary>
              <p className="recovery-record-key">
                Record: <code>{item.key}</code>
              </p>
              {item.reason === "noBaseline" && (
                <p>No common sync version is available.</p>
              )}
              <RecoveryComparison recovery={item} />
              <div className="recovery-actions">
                <button
                  disabled={busy || !getSyncSettings().enabled}
                  onClick={() => resolve(item, "local")}
                >
                  Keep device copy
                </button>
                <button
                  disabled={busy || !getSyncSettings().enabled}
                  onClick={() => resolve(item, "remote")}
                >
                  Use server copy
                </button>
              </div>
            </details>
          ))}
          <button onClick={exportRecovery}>Export both copies</button>
          {error && (
            <p role="alert" className="recovery-error">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
