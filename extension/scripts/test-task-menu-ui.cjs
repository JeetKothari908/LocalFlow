/* Run against the web dev server and a dedicated headless Chrome CDP profile. */
const assert = require('assert/strict');
const path = require('path');
const WebSocket = require(require.resolve('ws', {
  paths: [path.dirname(require.resolve('webpack-dev-server/package.json'))],
}));

async function main() {
  const endpoint = process.env.TASK_UI_CDP || 'http://127.0.0.1:8093';
  const tabs = await (await fetch(`${endpoint}/json/list`)).json();
  const tab = tabs.find((item) => item.type === 'page');
  assert(tab, 'A dedicated headless test page is required');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let sequence = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error ? callback.reject(message.error) : callback.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const delay = () => new Promise((resolve) => setTimeout(resolve, 120));
  const run = async (expression) => { await evaluate(expression); await delay(); };
  const eventually = async (expression) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await evaluate(expression)) return;
      await delay();
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  const menu = () => evaluate(`({
    task: document.querySelector('.legacy-menu-title h2')?.textContent,
    visible: getComputedStyle(document.querySelector('.workspace-settings')).display !== 'none'
  })`);
  const mouseClick = async (point) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await delay();
  };
  try {
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1365, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.navigate', { url: process.argv[2] || 'http://127.0.0.1:8092' });
    await eventually(`!!document.querySelector('input[aria-label="New top level task"]')`);
    const root = `Menu QA ${Date.now()}`;
    const other = `${root} other`;
    const child = `${other} child`;
    const addRoot = async (title) => {
      await run(`(() => {
        const input = document.querySelector('input[aria-label="New top level task"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(title)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.form.requestSubmit();
      })()`);
      await eventually(`!![...document.querySelectorAll('.TodoPlus .task-title')].find((item) => item.textContent === ${JSON.stringify(title)})`);
    };
    const titleButton = (title) => `[...document.querySelectorAll('.TodoPlus .task-title')].find((item) => item.textContent === ${JSON.stringify(title)})`;
    await addRoot(root);
    await addRoot(other);
    await run(`${titleButton(root)}.click()`);
    assert.deepEqual(await menu(), { task: root, visible: true });
    await run(`${titleButton(other)}.click()`);
    assert.equal(await evaluate(`!!document.querySelector('.TaskWorkspace')`), false, 'First click on another task should only close the workspace');
    await run(`${titleButton(other)}.click()`);
    assert.deepEqual(await menu(), { task: other, visible: true }, 'Second click may open the other task');
    await eventually(`!!document.querySelector('input[aria-label="New subtask"]')`);
    await run(`(() => {
      const input = document.querySelector('input[aria-label="New subtask"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(child)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form.requestSubmit();
    })()`);
    const childTitle = `[...document.querySelectorAll('.task-map-panel .task-title')].find((item) => item.textContent === ${JSON.stringify(child)})`;
    await eventually(`!!${childTitle}`);
    await run(`${childTitle}.click()`);
    assert.equal(await evaluate(`!!document.querySelector('.TaskWorkspace')`), false, 'Clicking the task map should close the workspace');
    await run(`${titleButton(other)}.click()`);
    assert.deepEqual(await menu(), { task: other, visible: true });
    const header = '.panel:first-of-type .panel-title';
    const before = await evaluate(`document.querySelector(${JSON.stringify(header)}).getAttribute('aria-expanded')`);
    const point = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(header)}).getBoundingClientRect(); return { x: rect.x + 10, y: rect.y + 10 }; })()`);
    await mouseClick(point);
    assert.equal(await evaluate(`!!document.querySelector('.TaskWorkspace')`), false, 'Clicking the page should close the task workspace');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(header)}).getAttribute('aria-expanded')`), before);
    await mouseClick(point);
    assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(header)}).getAttribute('aria-expanded')`), before);
    console.log('Task menu outside-click behavior passed');
  } finally {
    socket.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
