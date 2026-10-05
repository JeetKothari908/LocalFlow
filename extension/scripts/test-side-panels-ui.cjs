/* Uses only the dedicated headless Chrome test profile on port 8093.
 * Run with the dev server on 8092. Seeds fake widgets and tasks in that profile.
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
  assert(target, "An isolated test page is required");
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
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 150));
  const eventually = async (expression, message) => {
    for (let i = 0; i < 40; i++) {
      if (await evaluate(expression)) return;
      await wait();
    }
    assert(false, message);
  };
  const click = async (selector) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`,
    );
    const point = await evaluate(
      `(() => {const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2};})()`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
    await wait();
  };
  const resize = async (width) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await wait();
  };
  const artifacts = path.resolve(__dirname, "../dist/browser-qa-artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  const screenshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(artifacts, name), Buffer.from(data, "base64"));
  };
  const store = async (entries) =>
    evaluate(
      `new Promise((resolve,reject)=>{const request=indexedDB.open('tabliss/config',1);request.onsuccess=()=>{const connection=request.result,transaction=connection.transaction('changes','readwrite');const store=transaction.objectStore('changes');for(const [key,value] of ${JSON.stringify(entries)})store.put(value,key);transaction.oncomplete=()=>{connection.close();resolve()};transaction.onerror=()=>reject(transaction.error)};request.onerror=()=>reject(request.error)})`,
    );
  const widget = (id, key, position, order) => ({
    id,
    key,
    display: { position },
    order,
  });
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await resize(1365);
    await send("Page.navigate", {
      url: process.argv[2] || "http://127.0.0.1:8092",
    });
    await eventually(
      `!!document.querySelector('.Dashboard')`,
      "Dashboard must load",
    );
    await evaluate(
      `(() => {localStorage.setItem('todo-sync/settings',JSON.stringify({enabled:false,url:'',token:''}));for(const key of Object.keys(localStorage))if(key.startsWith('__localflow_remote_sync__/'))localStorage.removeItem(key);})()`,
    );
    const tasks = {
      schemaVersion: 2,
      items: [
        { id: "launch", contents: "Launch website", completed: false },
        {
          id: "build",
          contents: "Build website",
          completed: false,
          parentTaskId: "launch",
          dueDate: "2026-10-12",
        },
        {
          id: "design",
          contents: "Design homepage",
          completed: false,
          parentTaskId: "build",
          dueDate: "2026-10-07",
          repeat: { type: "weekly", days: [1] },
        },
        {
          id: "publish",
          contents: "Publish website",
          completed: false,
          parentTaskId: "launch",
          dueDate: "2026-10-15",
        },
      ],
    };
    await store([
      ["focus", false],
      ["showQuotes", true],
      [
        "widget/default-todo",
        widget("default-todo", "widget/todo", "bottomRight", 3),
      ],
      ["data/default-todo", tasks],
      ["widget/qa-notes", widget("qa-notes", "widget/notes", "topLeft", 4)],
      [
        "widget/qa-second-notes",
        widget("qa-second-notes", "widget/notes", "middleLeft", 5),
      ],
      [
        "widget/qa-plan",
        widget("qa-plan", "widget/planOfDay", "bottomLeft", 6),
      ],
    ]);
    await send("Page.reload");
    await eventually(
      `document.querySelectorAll('.SidePanel').length===2`,
      "Both side panels must load",
    );
    assert(
      await evaluate(
        `[...document.querySelectorAll('.SidePanel')].every(panel=>{const box=panel.getBoundingClientRect(),bar=document.querySelector('.SettingsBar').getBoundingClientRect();return box.top===bar.bottom && box.bottom===innerHeight;})`,
      ),
      "Side panels must fill the space below the settings bar",
    );
    assert(
      await evaluate(
        `(() => {const bar=document.querySelector('.SettingsBar').getBoundingClientRect(),settings=document.querySelector('.settings-trigger').getBoundingClientRect();return bar.left===0 && bar.right===innerWidth && settings.left>=0 && settings.right<document.querySelector('.side-panel-left').getBoundingClientRect().right;})()`,
      ),
      "Settings must sit at the left of the full-width bar",
    );
    assert(
      await evaluate(
        `(() => {const panel=document.querySelector('.side-panel-left'),slots=[...panel.querySelectorAll('.Slot')];return slots.map(slot=>slot.classList[1]).join(',')==='topLeft,middleLeft,bottomLeft' && slots.every((slot,i)=>!i || slots[i-1].getBoundingClientRect().bottom<=slot.getBoundingClientRect().top) && panel.scrollHeight>panel.clientHeight;})()`,
      ),
      "Sections must retain vertical order and scroll when needed",
    );
    const rightScroll = await evaluate(
      `document.querySelector('.side-panel-right').scrollTop`,
    );
    await evaluate(`document.querySelector('.side-panel-left').scrollTop=240`);
    await wait();
    assert.equal(
      await evaluate(`document.querySelector('.side-panel-right').scrollTop`),
      rightScroll,
      "Side panels scroll independently",
    );
    await click(".TodoPlus .task-title");
    await eventually(
      `document.querySelector('.TaskWorkspace')?.dataset.direction==='left'`,
      "Right panel map must open leftward",
    );
    assert(
      await evaluate(
        `(() => {const dock=document.querySelector('.TaskWorkspace').getBoundingClientRect();return dock.left>document.querySelector('.side-panel-left').getBoundingClientRect().right && dock.right<document.querySelector('.side-panel-right').getBoundingClientRect().left;})()`,
      ),
      "Map must fit between both side panels",
    );
    await screenshot("side-panels-map-left.png");
    await click('button[aria-label="Close task workspace"]');
    await store([
      [
        "widget/default-todo",
        widget("default-todo", "widget/todo", "topLeft", 3),
      ],
      ["widget/qa-notes", widget("qa-notes", "widget/notes", "topRight", 4)],
      [
        "widget/qa-second-notes",
        widget("qa-second-notes", "widget/notes", "middleRight", 5),
      ],
      [
        "widget/qa-plan",
        widget("qa-plan", "widget/planOfDay", "bottomRight", 6),
      ],
    ]);
    await send("Page.reload");
    await eventually(
      `!!document.querySelector('.side-panel-left .TodoPlus')`,
      "Task list must move into the left panel",
    );
    await click(".TodoPlus .task-title");
    await eventually(
      `document.querySelector('.TaskWorkspace')?.dataset.direction==='right'`,
      "Left panel map must open rightward",
    );
    assert(
      await evaluate(
        `(() => {const parent=document.querySelector('.task-map-panel[data-task-id="launch"]'),child=document.querySelector('.task-map-panel[data-task-id="build"]');return parent.offsetLeft+parent.offsetWidth<child.offsetLeft && document.querySelector('.workspace-map-area').getBoundingClientRect().right<document.querySelector('.workspace-settings').getBoundingClientRect().left;})()`,
      ),
      "Left-origin map must mirror its bracket and settings rail",
    );
    await click('.task-map-panel[data-task-id="build"] .task-title');
    await eventually(
      `!!document.querySelector('.task-map-panel[data-task-id="design"] .task-meta')`,
      "Nested branch must remain explorable",
    );
    assert(
      await evaluate(
        `document.querySelector('.task-map-panel[data-task-id="design"] .task-meta').innerText.toLowerCase().includes('weekly')`,
      ),
      "Map rows must retain repeat metadata",
    );
    await screenshot("side-panels-map-right.png");
    for (const width of [1000, 850, 390]) {
      await resize(width);
      assert(
        await evaluate(
          `(() => {const panels=[...document.querySelectorAll('.SidePanel')].map(panel=>panel.getBoundingClientRect());const dock=document.querySelector('.TaskWorkspace').getBoundingClientRect();return panels[0].right<panels[1].left && dock.left>=16 && dock.right<=innerWidth-16 && dock.height<=innerHeight/3+1;})()`,
        ),
        "Both panels and compact map must fit at width " + width,
      );
      assert(
        await evaluate(
          `(() => {const bar=document.querySelector('.SettingsBar').getBoundingClientRect(),settings=document.querySelector('.settings-trigger').getBoundingClientRect();return bar.left===0 && bar.right===innerWidth && settings.left>=0 && settings.right<=bar.right;})()`,
        ),
        "Settings bar must span the screen at width " + width,
      );
      await screenshot(`side-panels-${width}.png`);
    }
    await click('button[aria-label="Close task workspace"]');
    await click(".TodoPlus .panel-title");
    assert(
      await evaluate(
        `document.querySelector('.TodoPlus .panel-title').getAttribute('aria-expanded')==='false'`,
      ),
      "Narrow panel controls must remain clickable",
    );
    await click(".settings-trigger");
    await eventually(
      `!!document.querySelector('.Settings')`,
      "Settings icon in the top bar must remain clickable",
    );
    assert(
      await evaluate(
        `document.querySelector('.Settings').innerText.includes('Left panel')`,
      ),
      "Settings must identify the panels",
    );
    await evaluate(`document.querySelector('.Settings > a').click()`);
    await wait();
    await resize(1365);
    // Create an actual change, then verify the dashboard does not expose Undo above the lists.
    await evaluate(
      `(() => {const element=document.querySelector('input[aria-label="New top level task"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,'New commitment');element.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait();
    await evaluate(
      `document.querySelector('input[aria-label="New top level task"]').form.requestSubmit()`,
    );
    await wait();
    assert(
      await evaluate(
        `!document.querySelector('.TodoPlus .task-status button')`,
      ),
      "Dashboard Undo must be removed after an edit",
    );
    // Fake recovery only; sync remains disabled.
    await evaluate(
      `(() => {const url='http://127.0.0.1:8094';localStorage.setItem('todo-sync/settings',JSON.stringify({enabled:false,url,token:''}));localStorage.setItem('__localflow_remote_sync__/'+encodeURIComponent(url)+'/'+encodeURIComponent('tabliss/config'),JSON.stringify({bases:{},recoveries:[{id:'qa-panel-recovery',key:'data/default-todo',at:'2026-10-02T02:09:53Z',reason:'conflict',localValue:{items:[]},remoteValue:{items:[{id:'server',contents:'Server record',completed:false}]},currentVersion:1}]}));})()`,
    );
    await send("Page.reload");
    await eventually(
      `!!document.querySelector('.SyncRecovery') && document.querySelector('.SyncRecovery').getBoundingClientRect().left>document.querySelector('.settings-trigger').getBoundingClientRect().right`,
      "Recovery must follow the settings icon in the bar",
    );
    assert(
      await evaluate(
        `document.querySelector('.SyncRecovery').getBoundingClientRect().right<=document.querySelector('.SettingsBar').getBoundingClientRect().right`,
      ),
      "Recovery notice must fit inside the settings bar",
    );
    await screenshot("side-panels-recovery.png");
    assert.equal(errors.length, 0, "No unhandled page exceptions");
    console.log(
      JSON.stringify(
        {
          ok: true,
          checks: [
            "panels below settings bar",
            "section order",
            "independent scrolling",
            "settings at left of full-width bar",
            "leftward and rightward bracket maps",
            "mirrored settings rail",
            "nested metadata",
            "desktop and narrow bounds",
            "narrow controls",
            "dashboard Undo removed",
            "recovery beside settings",
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
