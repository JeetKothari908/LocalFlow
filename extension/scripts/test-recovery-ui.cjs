/* Run against a dedicated headless Chrome profile on port 8093 and dev server
 * on port 8092. This seeds only fake local recoveries with remote sync disabled.
 * Never run against a personal browser profile.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const WebSocket = require(
  require.resolve("ws", {
    paths: [path.dirname(require.resolve("webpack-dev-server/package.json"))],
  }),
);

async function main() {
  const endpoint = process.env.TASK_UI_CDP || "http://127.0.0.1:8093";
  const target = (await (await fetch(`${endpoint}/json/list`)).json()).find(
    (item) => item.type === "page",
  );
  assert(target, "A dedicated test page is required");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const pending = new Map(),
    errors = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.id) {
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        message.error
          ? callback.reject(message.error)
          : callback.resolve(message.result);
      }
    } else if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails)
      throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 150));
  const eventually = async (expression, message) => {
    for (let count = 0; count < 40; count++) {
      if (await evaluate(expression)) return;
      await wait();
    }
    assert(false, message);
  };
  const artifacts = path.resolve(__dirname, "../dist/browser-qa-artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  const screenshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(artifacts, name), Buffer.from(data, "base64"));
  };
  const task = (id, contents, extra = {}) => ({
    id,
    contents,
    completed: false,
    ...extra,
  });
  const base = {
    schemaVersion: 2,
    items: [
      task("root", "Launch website"),
      task("build", "Build website", {
        parentTaskId: "root",
        dueDate: "2026-10-02",
        repeat: { type: "weekly", days: [1] },
      }),
    ],
  };
  const local = {
    schemaVersion: 2,
    items: [
      task("root", "Launch website"),
      task("build", "Build website", {
        parentTaskId: "root",
        dueDate: "2026-10-03",
        repeat: { type: "weekly", days: [1] },
      }),
      task("local", "Device step"),
    ],
  };
  const remote = {
    schemaVersion: 2,
    items: [
      task("root", "Launch new website"),
      task("build", "Build website", {
        parentTaskId: "root",
        dueDate: "2026-10-05",
        repeat: { type: "daily" },
      }),
      task("server", "Server step"),
    ],
  };
  const recoveries = [
    {
      id: "task-conflict",
      key: "data/default-todo",
      at: "2026-10-02T02:09:53Z",
      reason: "conflict",
      localValue: local,
      remoteValue: remote,
      baseValue: base,
      currentVersion: 9,
      conflicts: ["items[build].dueDate"],
    },
    {
      id: "unexpected-format",
      key: "data/legacy-settings",
      at: "2026-10-02T02:09:53Z",
      reason: "noBaseline",
      localValue: { show: 3 },
      remoteValue: { show: 5 },
      currentVersion: 2,
    },
    {
      id: "absent-null",
      key: "data/missing-example",
      at: "2026-10-02T02:09:53Z",
      reason: "conflict",
      remoteValue: null,
      currentVersion: 3,
    },
    {
      id: "equal",
      key: "data/equal-example",
      at: "2026-10-02T02:09:53Z",
      reason: "noBaseline",
      localValue: { items: [] },
      remoteValue: { items: [] },
      currentVersion: 1,
    },
    {
      id: "note",
      key: "data/default-notes",
      at: "2026-10-02T02:09:53Z",
      reason: "conflict",
      localValue: {
        items: [{ id: "note-1", contents: "Device note\nOriginal body" }],
      },
      remoteValue: {
        items: [{ id: "note-1", contents: "Server note\nChanged body" }],
      },
      currentVersion: 2,
    },
  ];
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1365,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", {
      url: process.argv[2] || "http://127.0.0.1:8092",
    });
    await eventually(
      `!!document.querySelector('.Dashboard .Overlay')`,
      "Dashboard must load",
    );
    await evaluate(
      `(() => {const url='http://127.0.0.1:8094';localStorage.setItem('todo-sync/settings',JSON.stringify({enabled:false,url,token:''}));localStorage.setItem('__localflow_remote_sync__/'+encodeURIComponent(url)+'/'+encodeURIComponent('tabliss/config'),JSON.stringify({bases:{},recoveries:${JSON.stringify(recoveries)}}));})()`,
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const request=indexedDB.open('tabliss/config',1);request.onsuccess=()=>{const connection=request.result,transaction=connection.transaction('changes','readwrite');transaction.objectStore('changes').put(false,'focus');transaction.oncomplete=()=>{connection.close();resolve()};transaction.onerror=()=>reject(transaction.error)};request.onerror=()=>reject(request.error)})`,
    );
    await send("Page.reload");
    await eventually(
      `!!document.querySelector('.SyncRecovery')`,
      "Main dashboard must show recovery",
    );
    await eventually(
      `(() => {const bar=document.querySelector('.SettingsBar').getBoundingClientRect(),settings=document.querySelector('.settings-trigger').getBoundingClientRect(),recovery=document.querySelector('.SyncRecovery').getBoundingClientRect(),widgets=document.querySelector('.Widgets').getBoundingClientRect();return bar.left===0 && bar.right===innerWidth && bar.top===0 && settings.right<recovery.left && recovery.right<=innerWidth && widgets.top===bar.bottom;})()`,
      "Recovery must sit beside settings in a full-width bar above the widgets",
    );
    assert(
      await evaluate(`!document.querySelector('.recovery-content')`),
      "Recovery details start closed so the bar stays compact",
    );
    await evaluate(`document.querySelector('.recovery-heading').click()`);
    assert(
      await evaluate(
        `!document.querySelector('.TodoPlus .SyncRecovery') && document.querySelectorAll('.SyncRecovery').length===1`,
      ),
      "Recovery is mounted once outside the todo widget",
    );
    assert(
      await evaluate(
        `(() => {const rows=[...document.querySelectorAll('.recovery-difference-group tbody tr')];const due=rows.find(row=>row.querySelector('code').textContent==='items[build].dueDate');return due && due.innerText.includes('Deadline date') && due.innerText.includes('2026-10-03') && due.innerText.includes('2026-10-05') && due.innerText.includes('2026-10-02') && rows.some(row=>row.innerText.includes('Only on server') && row.innerText.includes('Server step')) && rows.some(row=>row.innerText.includes('Only on this device') && row.innerText.includes('Device step'));})()`,
      ),
      "Comparison must show deadlines, baseline, and added/removed task records",
    );
    const text = await evaluate(
      `document.querySelector('.SyncRecovery').innerText`,
    );
    assert(
      text.includes("items[build].repeat.type") &&
        text.includes('"weekly"') &&
        text.includes('"daily"'),
      "Repeat changes are shown exactly",
    );
    assert(
      text.includes("Object with fields: show") &&
        !text.includes("No task document"),
      "Unexpected formats must have accurate summaries",
    );
    assert(
      text.includes("Record absent") && text.includes("Stored value is null"),
      "Missing and null values must differ",
    );
    assert(
      text.includes("saved copies are identical"),
      "Stale equal-copy recoveries must be explicit",
    );
    assert(
      text.includes("Notes") &&
        text.includes("Note:") &&
        text.includes("Contents"),
      "Non-task records must have appropriate names",
    );
    assert(
      await evaluate(
        `document.querySelectorAll('.recovery-record').length===5 && [...document.querySelectorAll('.recovery-actions button')].every(button=>button.disabled)`,
      ),
      "All recovery records are available, with choices disabled when sync is off",
    );
    await screenshot("sync-recovery-desktop.png");
    await evaluate(`document.querySelector('.recovery-heading').click()`);
    assert(
      await evaluate(
        `!document.querySelector('.recovery-content') && document.querySelector('.SettingsBar').getBoundingClientRect().height===48`,
      ),
      "Recovery can collapse without resolving or losing copies",
    );
    await evaluate(`document.querySelector('.recovery-heading').click()`);
    await wait();
    assert(
      await evaluate(`(() => {const bar=document.querySelector('.SettingsBar').getBoundingClientRect(),content=document.querySelector('.recovery-content').getBoundingClientRect();return content.top>=bar.bottom && bar.height===48;})()`),
      "Expanded recovery details open below the compact bar",
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await wait();
    assert(
      await evaluate(
        `(() => {const rect=document.querySelector('.recovery-content').getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth-8 && rect.bottom<=innerHeight-8;})()`,
      ),
      "Recovery details stay within a narrow viewport",
    );
    await screenshot("sync-recovery-narrow.png");
    await evaluate(
      `new Promise((resolve,reject)=>{const request=indexedDB.open('tabliss/config',1);request.onsuccess=()=>{const connection=request.result,transaction=connection.transaction('changes','readwrite');transaction.objectStore('changes').put(true,'focus');transaction.oncomplete=()=>{connection.close();resolve()};transaction.onerror=()=>reject(transaction.error)};request.onerror=()=>reject(request.error)})`,
    );
    await send("Page.reload");
    await eventually(
      `!!document.querySelector('.SyncRecovery') && !document.querySelector('.TodoPlus')`,
      "Recovery must remain available when all widgets are hidden",
    );
    await evaluate(`document.querySelector('.recovery-heading').click()`);
    const downloads = path.join(artifacts, "recovery-export");
    fs.mkdirSync(downloads, { recursive: true });
    await send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloads,
    });
    await evaluate(
      `const button=[...document.querySelectorAll('.SyncRecovery button')].find(button=>button.innerText==='Export both copies');button.scrollIntoView({block:'center'});button.click()`,
    );
    const exported = path.join(downloads, "localflow-task-recovery.json");
    for (let attempt = 0; attempt < 40 && !fs.existsSync(exported); attempt++)
      await wait();
    assert(fs.existsSync(exported), "Export must download");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(exported, "utf8")),
      recoveries,
      "Export must preserve every raw recovery copy",
    );
    assert.equal(errors.length, 0, "No unhandled browser exceptions");
    console.log(
      JSON.stringify(
        {
          ok: true,
          checks: [
            "full-width settings bar placement",
            "outside todo widget",
            "exact fields and baseline",
            "added/removed task identities",
            "repeat changes",
            "unexpected formats",
            "missing versus null",
            "equal-copy notice",
            "non-task labels",
            "disabled choices",
            "collapse preserves recovery",
            "expanded details below bar",
            "narrow viewport",
            "visible without widgets",
            "complete recovery export",
          ],
          artifacts,
        },
        null,
        2,
      ),
    );
  } finally {
    socket.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
