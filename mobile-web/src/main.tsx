import React, { useEffect, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import Tasks from "../../packages/ui/src/tasks/TaskDashboard";
import { Notes } from "../../packages/ui/src/notes/Notes";
import Plan from "../../packages/ui/src/planOfDay/PlanOfDay";
import { DeviceTimeProvider } from "../../packages/ui/src/time";
import { PlatformContext } from "../../packages/ui/src/platform";
import Icon from "../../packages/ui/src/Icon";
import { DocumentClient } from "../../packages/platform/src/documents";
import { Bridge, DocumentKey, nativeBridge, Revision, Route, Snapshot } from "../../packages/platform/src/bridge";
import { previewBridge } from "./preview";
import { MobileDialog } from "./MobileDialog";
import "./mobile.scss";

const preview = new URLSearchParams(location.search).get("preview") === "1" && /^https?:$/.test(location.protocol);
const bridge = preview ? previewBridge() : nativeBridge();
const client = new DocumentClient(bridge);
const routes: Route[] = ["tasks", "notes", "plan"];

function Recovery({ onClose, bridge }: { onClose: () => void; bridge: Bridge }) {
  const [key, setKey] = useState<DocumentKey>("tasks");
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<Revision>();
  useEffect(() => {
    let active = true; setError(""); setRevisions([]); setSelection(undefined); setBusy(true);
    bridge.request<{ revisions: Revision[] }>("history", { key }).then(result => { if (active) setRevisions(result.revisions); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [key]);
  const restore = async () => {
    if (!selection) return; setBusy(true);
    try { client.receive(await bridge.request<Snapshot>("restoreRevision", { key, version: selection.version, baseVersion: revisions[0]?.version })); onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <MobileDialog label="Recovery" busy={busy} onClose={onClose}><header><h2>Recovery</h2><button disabled={busy} onClick={onClose}>Done</button></header>
    <p>Restore a previous server version. Task trash and recurring history are also available in Tasks.</p>
    <button onClick={() => bridge.request("exportBackup", { key }).catch(e => setError(e.message))}>Export preserved backup</button>
    <label>Document<select value={key} onChange={e => setKey(e.target.value as DocumentKey)}>{routes.map(route => <option key={route} value={route}>{route}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Loading…</p>}
    {!busy && !revisions.length && <p>No saved server revisions.</p>}
    {revisions.map(revision => <article key={revision.version}><strong>Version {revision.version}</strong><p>{new Date(revision.changedAt * 1000).toLocaleString()} · {revision.operation}</p><button disabled={busy} onClick={() => setSelection(revision)}>Review restore</button></article>)}
    {selection && <section className="restore-review"><h3>Restore version {selection.version}?</h3><p>This replaces the selected synced document. Your current copy is retained in recovery storage.</p><details><summary>Preview document</summary><pre>{JSON.stringify(selection.value ?? null, null, 2)}</pre></details><button disabled={busy} onClick={restore}>Restore version</button><button onClick={() => setSelection(undefined)}>Cancel</button></section>}
  </MobileDialog>;
}

function App() {
  const [, redraw] = useReducer(n => n + 1, 0);
  const [route, setRoute] = useState<Route>("tasks");
  const [fatal, setFatal] = useState("");
  const [message, setMessage] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [review, setReview] = useState<DocumentKey>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const unsubscribe = client.subscribe(redraw);
    client.start().then(() => bridge.request("ready")).catch(e => setFatal(e.message));
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{ route: Route; taskId?: string; eventId?: string }>).detail;
      if (!routes.includes(detail.route)) return;
      setRoute(detail.route);
      if (detail.taskId) { location.hash = `task=${encodeURIComponent(detail.taskId)}`; }
      if (detail.eventId) void bridge.request("routeAcknowledged", { eventId: detail.eventId }).catch(e => setMessage(e.message));
    };
    window.addEventListener("localflow:route", navigate);
    const viewport = () => {
      document.documentElement.style.setProperty("--visible-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
      document.documentElement.style.setProperty("--viewport-top", `${window.visualViewport?.offsetTop ?? 0}px`);
    };
    window.visualViewport?.addEventListener("resize", viewport); window.visualViewport?.addEventListener("scroll", viewport); viewport();
    return () => { unsubscribe(); client.stop(); window.removeEventListener("localflow:route", navigate); window.visualViewport?.removeEventListener("resize", viewport); window.visualViewport?.removeEventListener("scroll", viewport); };
  }, []);
  const action = async (method: string, payload = {}) => { try { setMessage(""); await bridge.request(method, payload); } catch (error) { setMessage((error as Error).message); } };
  if (fatal) return <main className="boot-state"><h1>LocalFlow</h1><p role="alert">{fatal}</p><button onClick={() => location.reload()}>Try again</button></main>;
  if (!client.snapshot) return <main className="boot-state"><h1>LocalFlow</h1><p role="status">Opening your workspace…</p></main>;
  const snapshot = client.snapshot;
  const pending = client.state(route);
  const hasBlocked = routes.some(key => client.state(key)?.blocked);
  const status = pending?.draftError ? "Draft not saved" : pending?.draftSaving || (pending?.blocked && pending.savedGeneration !== pending.generation) ? "Saving draft..." : pending?.blocked ? "Draft saved locally; needs review" : pending ? "Saving…" : snapshot.documents[route].pending ? "Saved locally · waiting to sync" : snapshot.status;
  return <PlatformContext.Provider value={{ layout: "mobile", exportDocument: (text, filename) => { void action("share", { text, filename }); }, copyTaskLink: async id => { await bridge.request("copyTaskLink", { id }); }, taskRoute: id => { void action("taskRoute", id ? { id } : {}); }, readEditorDraft: id => bridge.request("readEditorDraft", { id }), writeEditorDraft: async (id, value) => { await bridge.request("writeEditorDraft", { id, value }); } }}>
    <DeviceTimeProvider timeZone={snapshot.timeZone}><div className={`mobile-app route-${route}`}>
      <header className="app-header"><div><span className="eyebrow">LOCALFLOW</span><h1>{route === "plan" ? "Your day" : route === "notes" ? "Notes" : "Tasks"}</h1></div><div className="header-actions"><button aria-label="Recovery" onClick={() => setRecovery(true)}><Icon name="archive" size={20} /></button><button aria-label="Sync now" disabled={snapshot.syncing} onClick={() => action("refresh")}><Icon name="refresh-cw" size={20} /></button><button aria-label="Sync settings" onClick={() => action("settings")}><Icon name="settings" size={20} /></button></div></header>
      <div className="sync-status" role="status">{status}</div>
      {(message || snapshot.error) && <p className="mobile-error" role="alert">{message || snapshot.error}</p>}
      {(hasBlocked || snapshot.conflicts.length > 0) && <aside className="review-banner"><span>Changes need review. Check the save status before closing the app.</span>{routes.filter(key => client.state(key)?.blocked || snapshot.conflicts.some(c => c.key === key)).map(key => <button key={key} onClick={() => setReview(key)}>Review {key}</button>)}</aside>}
      <main className="screens">
        <section hidden={route !== "tasks"} aria-label="Tasks"><Tasks data={client.value("tasks")} setData={value => client.set("tasks", value)} /></section>
        <section hidden={route !== "notes"} aria-label="Notes"><Notes data={client.value("notes")} setData={value => client.set("notes", value)} /></section>
        <section hidden={route !== "plan"} aria-label="Plan"><Plan data={client.value("plan")} setData={value => client.set("plan", value)} /></section>
      </main>
      {preview && <nav className="preview-tabs" aria-label="Main navigation">{routes.map(key => <button key={key} aria-current={key === route ? "page" : undefined} onClick={() => setRoute(key)}>{key}</button>)}<button onClick={() => setMessage("Alerts use native iOS notification services and are available in the installed app.")}>Alerts</button></nav>}
      {recovery && <Recovery bridge={bridge} onClose={() => setRecovery(false)} />}
      {review && <MobileDialog label="Review changes" busy={busy} onClose={() => setReview(undefined)}><header><h2>Review {review}</h2><button disabled={busy} onClick={() => setReview(undefined)}>Done</button></header><p role="alert">{client.state(review)?.draftError ?? client.state(review)?.error ?? snapshot.conflicts.find(c => c.key === review)?.detail}</p><p>Review both versions. Your decision keeps the unchosen copy in recovery storage.</p><details><summary>Your local copy</summary><pre>{JSON.stringify(client.value(review), null, 2)}</pre></details><details><summary>Latest synced copy</summary><pre>{JSON.stringify(snapshot.conflicts.find(c => c.key === review)?.remote ?? snapshot.documents[review].value, null, 2)}</pre></details>{[true, false].map(keep => <button key={String(keep)} disabled={busy} onClick={async () => { setBusy(true); try { if (client.state(review)?.blocked) await client.resolveDraft(review, keep); else client.receive(await bridge.request<Snapshot>("resolveConflict", { key: review, useLocal: keep })); setReview(undefined); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } }}>{keep ? "Keep my copy" : "Use latest copy"}</button>)}</MobileDialog>}
    </div></DeviceTimeProvider>
  </PlatformContext.Provider>;
}

class Boundary extends React.Component<React.PropsWithChildren<{}>, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <main className="boot-state"><h1>Workspace unavailable</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>Reopen workspace</button></main> : this.props.children; }
}
createRoot(document.getElementById("root")!).render(<Boundary><App /></Boundary>);
