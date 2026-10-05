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
  const clickElement = async (expression) => {
    await run(`(${expression}).scrollIntoView({ block: 'center', inline: 'center' })`);
    const point = await evaluate(`(() => {
      const element = (${expression});
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (!element.contains(document.elementFromPoint(x, y)))
        throw new Error('Test control is obscured: ' + element.outerHTML);
      return { x, y };
    })()`);
    await mouseClick(point);
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
    assert.deepEqual(await menu(), { task: other, visible: true }, 'One click on another task must open it without being swallowed');
    await clickElement(`document.querySelector('.legacy-menu-edit')`);
    await clickElement(`document.querySelector('.task-editor input[required]')`);
    assert.equal(await evaluate(`!!document.querySelector('.task-editor') && !!document.activeElement.closest('.task-editor')`), true, 'Clicking details must focus the editor without dismissing it');
    await clickElement(`document.querySelector('.legacy-menu-edit')`);
    await eventually(`!!document.querySelector('input[aria-label="New subtask"]')`);
    await clickElement(`document.querySelector('input[aria-label="New subtask"]')`);
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'New subtask', 'The composer must receive clicks outside the settings rail');
    await run(`(() => {
      const input = document.querySelector('input[aria-label="New subtask"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(child)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form.requestSubmit();
    })()`);
    const childTitle = `[...document.querySelectorAll('.task-map-panel .task-title')].find((item) => item.textContent === ${JSON.stringify(child)})`;
    await eventually(`!!${childTitle}`);
    await clickElement(childTitle);
    assert.deepEqual(await menu(), { task: child, visible: true }, 'Clicking the map must select the child and keep its menu open');
    await clickElement(`(${childTitle}).closest('.task-row').querySelector('.task-check')`);
    assert.equal(await evaluate(`document.querySelector('.legacy-menu-title .task-check').getAttribute('aria-pressed')`), 'true', 'The map checkbox must complete the task without dismissing the workspace');
    await clickElement(`document.querySelector('button[aria-label="Close task workspace"]')`);
    assert.equal(await evaluate(`!!document.querySelector('.TaskWorkspace')`), false, 'The explicit close button must still work');
    await run(`${titleButton(other)}.click()`);
    assert.deepEqual(await menu(), { task: other, visible: true });
    const header = '.panel:first-of-type .panel-title';
    const before = await evaluate(`document.querySelector(${JSON.stringify(header)}).getAttribute('aria-expanded')`);
    const point = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(header)}).getBoundingClientRect(); return { x: rect.x + 10, y: rect.y + 10 }; })()`);
    await mouseClick(point);
    assert.equal(await evaluate(`!!document.querySelector('.TaskWorkspace')`), false, 'Clicking the page should close the task workspace');
    assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(header)}).getAttribute('aria-expanded')`), before, 'The same outside click must also operate the dashboard control');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
    });
    await run(`${titleButton(other)}.click()`);
    await eventually(`document.querySelector('.TaskWorkspace')?.dataset.compact === 'true'`);
    await clickElement(`document.querySelector('.settings-heading .mobile-settings-toggle')`);
    assert.deepEqual(await menu(), { task: other, visible: false }, 'Hide must retain the compact workspace');
    await clickElement(`document.querySelector('input[aria-label="New subtask"]')`);
    assert.equal(await evaluate(`!!document.querySelector('.TaskWorkspace')`), true, 'The map remains interactive with its menu hidden');
    await run(`document.querySelector(${JSON.stringify(header)}).click()`);
    assert.equal(await evaluate(`!!document.querySelector('.TaskWorkspace')`), false, 'Outside clicks must also close a compact workspace with a hidden menu');
    console.log('Task menu internal controls and outside-click behavior passed');
  } finally {
    socket.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
