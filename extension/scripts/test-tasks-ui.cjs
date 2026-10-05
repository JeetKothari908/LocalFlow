/* Task UI smoke test using a dedicated Chrome test profile.
 * Start the dev server, then hidden headless Chrome with a NEW --user-data-dir,
 * --remote-debugging-port=8093. Never point this at a personal browser profile.
 * Run: node scripts/test-tasks-ui.cjs [http://127.0.0.1:8092]
 * Screenshots are written beneath ignored dist/browser-qa-artifacts.
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require(require.resolve('ws', {paths:[path.dirname(require.resolve('webpack-dev-server/package.json'))]}));
const assert = require('assert/strict');

async function main() {
  const endpoint = process.env.TASK_UI_CDP || 'http://127.0.0.1:8093';
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const target = targets.find(candidate => candidate.type === 'page');
  assert(target, 'A dedicated headless test page is required');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0; const pending = new Map(); const pageErrors = [];
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id) {
      const callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); message.error ? callback.reject(message.error) : callback.resolve(message.result); }
    } else if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params})); });
  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  const delay = async () => { await new Promise(resolve => setTimeout(resolve, 120)); };
  const eventually = async (condition, message) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) { if (await condition()) return; await delay(); }
    assert(false, message);
  };
  const run = async expression => { const value = await evaluate(expression); await delay(); return value; };
  const click = async (text, scope='document') => {
    await eventually(()=>evaluate(`!![...${scope}.querySelectorAll('button')].find(element=>element.innerText===${JSON.stringify(text)} && !element.disabled)`),'Missing enabled button: '+text);
    return run(`(() => { const button=[...${scope}.querySelectorAll('button')].find(element=>element.innerText===${JSON.stringify(text)}); button.click(); })()`);
  };
  const fill = async (selector, value) => run(`(() => { const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing input: '+${JSON.stringify(selector)}); const prototype=element.tagName==='SELECT'?HTMLSelectElement.prototype:element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event(element.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`);
  const field = async (name, value) => {
    await eventually(()=>evaluate(`!![...document.querySelectorAll('.task-editor label')].find(element=>element.firstChild.textContent===${JSON.stringify(name)})`),'Missing field: '+name);
    return run(`(() => { const label=[...document.querySelectorAll('.task-editor label')].find(element=>element.firstChild.textContent===${JSON.stringify(name)});let group=label.parentElement;while(group && group!==document.querySelector('.task-editor')){if(group.tagName==='DETAILS')group.open=true;group=group.parentElement;}const element=label.querySelector('input,select,textarea');const prototype=element.tagName==='SELECT'?HTMLSelectElement.prototype:element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event(element.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`);
  };
  const open = async title => {
    await eventually(()=>evaluate(`!![...document.querySelectorAll('.task-title')].find(element=>element.textContent===${JSON.stringify(title)})`),'Missing task: '+title);
    await run(`(() => {const button=[...document.querySelectorAll('.TaskWorkspace .task-title'),...document.querySelectorAll('.TodoPlus .task-title')].find(element=>element.textContent===${JSON.stringify(title)});button.click();})()`);
    await ensureSettings();
  };
  const close = () => run(`document.querySelector('button[aria-label="Close task workspace"]').click()`);
  const submit = selector => run(`document.querySelector(${JSON.stringify(selector)}).form.requestSubmit()`);
  const dialogText = () => evaluate(`document.querySelector('.TaskWorkspace')?.innerText ?? ''`);
  const addRoot = async title => { await fill('input[aria-label="New top level task"]', title); await submit('input[aria-label="New top level task"]'); };
  const addChild = async title => { await fill('input[aria-label="New subtask"]', title); await submit('input[aria-label="New subtask"]'); };
  const ensureSettings = async () => {
    if(await evaluate(`!!document.querySelector('.TaskWorkspace') && getComputedStyle(document.querySelector('.workspace-settings')).display==='none'`)) await run(`document.querySelector('.map-toolbar .mobile-settings-toggle').click()`);
  };
  const tabs = async title => {
    await ensureSettings();
    const modes={Subtasks:'focus',Outline:'outline',Dependencies:'dependencies',Timeline:'timeline',History:'history'};
    if(modes[title]) return fill('select[aria-label="Task view"]',modes[title]);
    return click(title, `document.querySelector('.TaskWorkspace')`);
  };
  const save = () => click('Save changes', `document.querySelector('.TaskWorkspace')`);
  const edit = async () => { await ensureSettings(); return click('Edit details', `document.querySelector('.TaskWorkspace')`); };
  const artifacts = path.resolve(__dirname, '../dist/browser-qa-artifacts'); fs.mkdirSync(artifacts,{recursive:true});
  const screenshot = async (name, width, selector) => {
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await delay();
    if (selector) await run(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);
    const {data} = await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(artifacts,name),Buffer.from(data,'base64'));
  };
  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:process.argv[2] || 'http://127.0.0.1:8092'});
    await new Promise(resolve=>setTimeout(resolve,1500));
    if(await evaluate(`!!document.querySelector('.TaskWorkspace')`))await close();
    const today = await evaluate(`(() => {const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})()`);
    const prefix = `QA ${Date.now()}`;
    const project = `${prefix} launch`, build = `${prefix} build`, leaf = `${prefix} domain`, prerequisite = `${prefix} approval`, list = `${prefix} Work`;
    await addRoot(project); await open(project); await addChild(build); await open(build); await addChild(leaf); await open(leaf);
    assert((await evaluate(`document.querySelector('.task-map-panel.map-selected')?.getAttribute('aria-label')`)).includes(project), 'Deep task ancestry must include its project');
    assert(await evaluate(`!!document.querySelector('.legacy-task-menu input[aria-label="Task due date"]') && !!document.querySelector('.legacy-task-menu input[aria-label="Task due time"]') && !!document.querySelector('.legacy-task-menu [aria-label="Task repeat"]') && !!document.querySelector('.legacy-task-menu select[aria-label="Task list"]')`), 'Restored task menu must expose scheduling, repeat, and list controls');
    assert(await evaluate(`!!document.querySelector('.workspace-actions') && !!document.querySelector('.legacy-menu-edit')`), 'Task actions and details editor must remain available');
    await edit(); await field('Deadline',today); await field('Planned start',today); await field('Estimated minutes','30'); await save();
    // Map expansion retains ancestry and never makes the rest of the page inert.
    assert(await evaluate(`!document.querySelector('dialog.TaskWorkspace') && !document.querySelector('.TodoPlus').closest('[inert]')`), 'Subtask map must be non-modal');
    assert(await evaluate(`(() => {const panels=[...document.querySelectorAll('.task-map-panel')];const parent=panels.find(panel=>panel.querySelector('.task-title').textContent===${JSON.stringify(project)});const child=panels.find(panel=>panel.querySelector('.task-title').textContent===${JSON.stringify(build)});const leaf=panels.find(panel=>panel.querySelector('.task-title').textContent===${JSON.stringify(leaf)});return parent && child && leaf && leaf.offsetLeft+leaf.offsetWidth<child.offsetLeft && child.offsetLeft+child.offsetWidth<parent.offsetLeft;})()`), 'Subtasks must form a connected web expanding inward from the right panel');
    assert(await evaluate(`document.querySelector('.workspace-settings').getBoundingClientRect().right<document.querySelector('.workspace-map-area').getBoundingClientRect().left && document.querySelector('.TaskWorkspace').getBoundingClientRect().right<document.querySelector('.TodoPlus').getBoundingClientRect().left`), 'Settings must sit farther left than the map and dashboard');
    assert(await evaluate(`document.querySelector('.map-selected .task-meta').innerText.includes(${JSON.stringify(today)}) && document.querySelector('.map-selected .task-meta').innerText.includes('30 min')`), 'Graph rows must expose task metadata');
    assert(await evaluate(`(() => {const panels=[...document.querySelectorAll('.task-map-panel')];return panels.every(panel=>panel.offsetHeight<=28 && panel.scrollHeight<=panel.clientHeight && panel.querySelector('.task-row-compact').offsetHeight===28) && new Set(panels.map(panel=>panel.offsetWidth)).size===1;})()`), 'Graph nodes must use quarter-height list rows and contain their controls');
    await run(`document.querySelector('.task-map-viewport').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    assert(await evaluate(`getComputedStyle(document.querySelector('.workspace-settings')).display==='none'`), 'Clicking empty map space must dismiss the task menu');
    await click('Menu', `document.querySelector('.TaskWorkspace')`);
    assert(await evaluate(`getComputedStyle(document.querySelector('.workspace-settings')).display!=='none'`), 'Task menu must reopen from the map toolbar');
    const collapsePoint=await evaluate(`(() => {const rect=document.querySelector('.panel:first-of-type .panel-title').getBoundingClientRect();return {x:rect.x+10,y:rect.y+10};})()`);
    for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...collapsePoint,button:'left',clickCount:1});await delay();
    assert(await evaluate(`document.querySelector('.panel:first-of-type .panel-title').getAttribute('aria-expanded')==='false' && !!document.querySelector('.TaskWorkspace') && getComputedStyle(document.querySelector('.workspace-settings')).display!=='none'`), 'Dashboard controls must remain clickable without dismissing the task menu');
    const reopenPoint=await evaluate(`(() => {const rect=document.querySelector('.panel:first-of-type .panel-title').getBoundingClientRect();return {x:rect.x+10,y:rect.y+10};})()`);
    for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...reopenPoint,button:'left',clickCount:1});await delay();
    assert(await evaluate(`document.querySelector('.panel:first-of-type .panel-title').getAttribute('aria-expanded')==='true'`), 'Dashboard must reopen after its layout shifts');
    assert(await evaluate(`(() => {const dock=document.querySelector('.TaskWorkspace').getBoundingClientRect();return dock.width<=600 && dock.height<=Math.min(300,innerHeight/3)+1;})()`), 'Desktop map must stay within its compact width and one-third-height bounds');
    await screenshot('tasks-map-medium.png',850);
    assert(await evaluate(`(() => {const dock=document.querySelector('.TaskWorkspace').getBoundingClientRect();return dock.width<=600 && dock.height<=innerHeight/3+1 && dock.left>=16 && dock.right<=innerWidth-16;})()`), 'Medium-screen map must stay compact and within the viewport');
    await screenshot('tasks-map-desktop.png',1365);
    await screenshot('tasks-map-narrow.png',390);
    assert(await evaluate(`document.querySelector('.TaskWorkspace').getBoundingClientRect().height<=innerHeight/3+1`), 'Narrow map must retain its compact height');
    assert(await evaluate(`(() => {const dock=document.querySelector('.TaskWorkspace').getBoundingClientRect(), row=[...document.querySelectorAll('.TodoPlus .task-row')].find(row=>row.querySelector('.task-title')?.textContent===${JSON.stringify(project)}).getBoundingClientRect();return dock.bottom<=row.top || dock.top>=row.bottom;})()`), 'Narrow-screen map must leave its originating task row reachable');
    await run(`(() => {const panel=[...document.querySelectorAll('.task-map-panel')].find(element=>element.querySelector('.task-title').textContent===${JSON.stringify(project)});panel.querySelector('.task-check').click();})()`);
    assert(await evaluate(`getComputedStyle(document.querySelector('.workspace-settings')).display!=='none' && !!document.querySelector('.completion-confirm')`), 'Parent completion must reveal its review when the settings rail is hidden');
    await tabs('Keep working');
    await close();
    assert(await evaluate(`!![...document.querySelectorAll('.panel:first-of-type .task-title')].find(element=>element.textContent===${JSON.stringify(leaf)})`), 'Deep due task must appear in global Due Today');
    await run(`document.querySelector('.panel:nth-of-type(2) .panel-options summary').click()`);
    await fill('input[aria-label="New list name"]',list); await submit('input[aria-label="New list name"]');
    const listId = await evaluate(`[...document.querySelector('select[aria-label="Choose project list"]').options].find(option=>option.textContent===${JSON.stringify(list)}).value`);
    await open(project); await edit(); await field('List',listId); await save(); await close();
    assert(await evaluate(`!![...document.querySelectorAll('.panel:first-of-type .task-title')].find(element=>element.textContent===${JSON.stringify(leaf)})`), 'Task in custom list must remain in global Due Today');
    await fill('select[aria-label="Choose project list"]',listId);
    await addRoot(prerequisite); await open(prerequisite); await edit(); await field('Estimated minutes','15'); await save();
    const prerequisiteId = await evaluate(`[...document.querySelector('.task-editor')?.querySelectorAll('option') ?? []].find(option=>option.textContent===${JSON.stringify(prerequisite)})?.value ?? ''`);
    await close(); await open(project); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`);
    await eventually(async () => (await dialogText()).includes(leaf), 'Outline expansion must show nested tasks');
    await open(leaf); await tabs('Dependencies');
    const approvalId = prerequisiteId || await evaluate(`[...document.querySelector('select[aria-label="Prerequisite task"]').options].find(option=>option.textContent.includes(${JSON.stringify(prerequisite)})).value`);
    await fill('select[aria-label="Prerequisite task"]',approvalId); await tabs('Add');
    assert((await dialogText()).includes('Waiting on:'), 'Linked prerequisite must block task');
    assert((await dialogText()).includes('Dependency map'), 'Dependency map is available');
    await close(); await open(project); await tabs('Timeline');
    assert((await dialogText()).includes(leaf), 'Timeline must include dated nested task');
    await screenshot('tasks-timeline-desktop.png',1365); await screenshot('tasks-timeline-narrow.png',390);
    await tabs('Shift schedule'); await fill('.schedule-shift input','1');
    assert((await dialogText()).includes('Apply shift'), 'Schedule shift must show preview before applying');
    await tabs('Apply shift'); await tabs('History');
    assert((await dialogText()).includes('1 days'), 'Applied schedule shift must appear in branch history');
    await tabs('Subtasks'); await screenshot('tasks-workspace-narrow.png',390); await close();
    await open(prerequisite); await run(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').click()`);
    assert(!(await dialogText()).includes('Waiting on:'), 'Completed prerequisite has no unresolved own blockers');
    await close();
    // Repeating leaf: completing today creates a frozen occurrence and next due date.
    await open(project); await tabs('Outline'); await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`); await open(leaf);
    await edit(); await field('Deadline',today); await field('Repeat','daily'); await save();
    await run(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').click()`);
    await tabs('History');
    assert((await dialogText()).includes('Recurring occurrences'), 'Recurrence history is available');
    assert(await evaluate(`document.querySelector('.TaskWorkspace .history-view details.occurrence') !== null`), 'Repeating completion must preserve an occurrence snapshot');
    await close(); await open(project); await tabs('Move to trash');
    await fill('select[aria-label="Choose project list"]','trash');
    assert(await evaluate(`!![...document.querySelectorAll('.recovery-row')].find(element=>element.textContent.includes(${JSON.stringify(project)}))`), 'Trashed branch must remain recoverable');
    await run(`(() => {const row=[...document.querySelectorAll('.recovery-row')].find(element=>element.textContent.includes(${JSON.stringify(project)}));row.querySelector('button').click();})()`);
    await fill('select[aria-label="Choose project list"]',listId); await open(project); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`);
    assert((await dialogText()).includes(leaf), 'Restored branch must preserve nesting');
    await screenshot('tasks-outline-desktop.png',1365); await screenshot('tasks-outline-narrow.png',390);
    // Parent completion is deliberate, and repeating branches retain all steps.
    await edit(); await field('Deadline',today); await field('Repeat','daily'); await field('Repeat scope','branch'); await save();
    await run(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').click()`);
    assert((await dialogText()).includes('Complete remaining subtasks'), 'Parent completion must ask before completing unfinished descendants');
    await tabs('Complete remaining subtasks'); await tabs('History');
    assert(await evaluate(`!![...document.querySelectorAll('.TaskWorkspace details.occurrence')].find(element=>element.querySelectorAll('p').length>=3)`), 'Branch recurrence must preserve root and descendants');
    await tabs('Outline');
    assert(!(await dialogText()).includes('Complete remaining subtasks'), 'Successful completion must dismiss confirmation');
    await close();
    // Monthly recurrence must remember day 31 after February's shorter month.
    const monthly = `${prefix} monthly`;
    await addRoot(monthly); await open(monthly); await edit(); await field('Deadline','2027-01-31'); await field('Repeat','monthly'); await save();
    await run(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').click()`);
    assert((await dialogText()).includes('2027-02-28'), 'January 31 must recur on February 28');
    await run(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').click()`);
    assert((await dialogText()).includes('2027-03-31'), 'Monthly recurrence must preserve intended day after clamping');
    await close(); await open(project); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`);
    // Keyboard hierarchy edits expose alternatives to dragging.
    const sibling = `${prefix} checklist`;
    await addChild(sibling);
    await run(`(() => {const button=[...document.querySelectorAll('.TaskWorkspace .task-title')].find(element=>element.textContent===${JSON.stringify(sibling)});button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true,cancelable:true}));})()`);
    await open(sibling);
    assert((await evaluate(`document.querySelector('.task-map-panel.map-selected')?.getAttribute('aria-label')`)).includes(build), 'Alt+Right must indent beneath the previous sibling');
    await close(); await open(project); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`);
    await run(`(() => {const button=[...document.querySelectorAll('.TaskWorkspace .task-title')].find(element=>element.textContent===${JSON.stringify(sibling)});button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true,cancelable:true}));})()`);
    await open(sibling);
    assert(!(await evaluate(`document.querySelector('.task-map-panel.map-selected')?.getAttribute('aria-label')`)).includes(build), 'Alt+Left must outdent one level');
    await close();
    // Archiving fulfilled prerequisites preserves satisfaction; canceling one
    // requires resolution. Archive/unarchive restores the entire project.
    await open(prerequisite); await tabs('Archive'); await open(project); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`); await open(leaf);
    assert(!(await dialogText()).includes('Waiting on:'), 'Archived completed prerequisite must stay satisfied');
    await tabs('Dependencies');
    await run(`(() => {const node=[...document.querySelectorAll('.TaskWorkspace .graph-node')].find(element=>element.querySelector('span').textContent.includes(${JSON.stringify(prerequisite)}));if(!node)throw new Error('Missing prerequisite graph node');node.click();})()`);
    await tabs('Open selected task'); await tabs('Restore branch'); await edit(); await field('State','canceled'); await save();
    await close(); await open(project); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`); await open(leaf);
    await eventually(async () => (await dialogText()).includes('Waiting on:'), 'Canceled prerequisite must block dependent task');
    await close(); await open(project); await tabs('Archive');
    await fill('select[aria-label="Choose project list"]','finished');
    await run(`(() => {const title=[...document.querySelectorAll('.panel .task-title')].find(element=>element.textContent===${JSON.stringify(project)});const button=title.closest('.task-row').parentElement.querySelector('button.open-outline');if(!button)throw new Error('Missing unarchive action');button.click();})()`);
    await fill('select[aria-label="Choose project list"]',listId); await open(project); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`);
    assert((await dialogText()).includes(leaf), 'Unarchiving project must restore descendant visibility');
    await close();
    const projectId = await evaluate(`[...document.querySelector('select[aria-label^="Project for today"]').options].find(option=>option.textContent===${JSON.stringify(project)}).value`);
    await send('Page.navigate',{url:`${process.argv[2] || 'http://127.0.0.1:8092'}#task=${encodeURIComponent(projectId)}`});
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert((await dialogText()).includes(project), 'Stable task URL must reopen workspace after navigation');
    const research = `${prefix} research`, preparation = `${prefix} preparation`;
    await addChild(research); await addChild(preparation); await open(preparation); await tabs('Dependencies');
    const researchId = await evaluate(`[...document.querySelector('select[aria-label="Prerequisite task"]').options].find(option=>option.textContent.includes(${JSON.stringify(research)})).value`);
    await fill('select[aria-label="Prerequisite task"]',researchId); await tabs('Add');
    await close(); await open(project); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+build)}]').click()`); await open(leaf); await tabs('Dependencies');
    const preparationId = await evaluate(`[...document.querySelector('select[aria-label="Prerequisite task"]').options].find(option=>option.textContent.includes(${JSON.stringify(preparation)})).value`);
    await fill('select[aria-label="Prerequisite task"]',preparationId); await tabs('Add');
    await close(); await open(project); await tabs('Dependencies');
    assert(await evaluate(`document.querySelectorAll('.TaskWorkspace .graph-node').length>=4`), 'Dependency graph must display multiple prerequisites and a chain');
    await run(`(() => {const node=[...document.querySelectorAll('.TaskWorkspace .graph-node')].find(element=>element.querySelector('span').textContent.includes(${JSON.stringify(preparation)}));node.click();})()`);
    assert(await evaluate(`document.querySelectorAll('.TaskWorkspace .graph-edge-active').length>=2`), 'Selecting an intermediate node must highlight incoming and outgoing edges');
    await screenshot('tasks-dependencies-desktop.png',1365); await screenshot('tasks-dependencies-narrow.png',390);
    await tabs('Open selected task');
    assert(await evaluate(`document.querySelector('.TaskWorkspace h2').textContent===${JSON.stringify(preparation)}`), 'Selected graph node must open the corresponding task');
    await close();
    // Search reveals its target's ancestors and highlights the selected task.
    await fill('input[aria-label="Search all tasks"]',leaf); await click('Open in outline');
    assert(await evaluate(`document.querySelector('.TaskWorkspace .task-highlighted .task-title')?.textContent===${JSON.stringify(leaf)}`), 'Search must highlight its target in the project outline');
    assert(await evaluate(`document.querySelectorAll('.TaskWorkspace .outline-elbow').length>0`), 'Outline must draw structural connector lines');
    await screenshot('tasks-search-outline-desktop.png',1365); await screenshot('tasks-search-outline-narrow.png',390);
    await close(); await fill('input[aria-label="Search all tasks"]','');
    await open(project); await open(build); await tabs('Dependencies');
    await fill('select[aria-label="Prerequisite task"]',researchId); await tabs('Add');
    await close(); await fill('input[aria-label="Search all tasks"]',leaf); await open(leaf);
    assert((await dialogText()).includes('through '+build), 'Inherited blockers must identify the ancestor that gates this task');
    await tabs('Dependencies'); assert((await dialogText()).includes('Inherited through'), 'Dependency details must name the inherited constraint source');
    await run(`(() => {const node=[...document.querySelectorAll('.TaskWorkspace .graph-node')].find(element=>element.querySelector('span').textContent.includes(${JSON.stringify(leaf)}));node.click();})()`);
    assert(await evaluate(`document.querySelectorAll('.TaskWorkspace .graph-edge-active').length>=4`), 'Selecting a leaf must trace its full unresolved chain and inherited blocker');
    await close(); await fill('input[aria-label="Search all tasks"]','');

    const reviewProject=`${prefix} review`, remaining=`${prefix} remaining`, deepRemaining=`${prefix} nested review`, alreadyDone=`${prefix} previously done`, restoreChild=`${prefix} restore child`;
    await addRoot(reviewProject); await open(reviewProject); await addChild(remaining); await open(remaining); await addChild(deepRemaining); await open(deepRemaining);
    await edit(); await field('Deadline',today); await save(); await close();
    const summaryText=await evaluate(`(() => { const title=[...document.querySelectorAll('.panel:nth-of-type(2) .task-title')].find(element=>element.textContent===${JSON.stringify(reviewProject)});return title.closest('.task-row').innerText;})()`);
    assert(summaryText.includes('1 due today') && summaryText.includes('Next deadline:') && summaryText.includes(deepRemaining), 'Project summary must show daily commitments and next deadline');
    await open(reviewProject); await addChild(alreadyDone); await open(alreadyDone); await run(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').click()`);
    await close(); await open(reviewProject); await edit(); await field('State','done'); await save();
    const preview=await evaluate(`document.querySelector('.TaskWorkspace .completion-preview').innerText`);
    assert(preview.includes(remaining) && preview.includes(deepRemaining) && !preview.includes(alreadyDone), 'Completion preview must list only unfinished descendants at every depth');
    assert(await evaluate(`document.activeElement?.matches('.completion-confirm')`), 'Completion review must receive keyboard focus');
    await screenshot('tasks-completion-desktop.png',1365,'.completion-confirm'); await screenshot('tasks-completion-narrow.png',390,'.completion-confirm');
    await tabs('Keep working'); assert(await evaluate(`!!document.querySelector('.TaskWorkspace .task-editor')`), 'Canceling completion must preserve the details draft');
    await save(); await tabs('Complete remaining subtasks');
    assert(!await evaluate(`!!document.querySelector('.TaskWorkspace .task-editor')`), 'Confirmed details completion must save and close the editor');
    await addChild(restoreChild);
    assert(await evaluate(`document.querySelector('.task-status').innerText.includes('Reopened')`), 'Adding unfinished work must explain reopened ancestors and offer undo');
    assert((await dialogText()).includes('Reopened'), 'Ancestor reopening explanation must also be visible inside the workspace');
    await tabs('Undo');
    assert(await evaluate(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').getAttribute('aria-pressed')==='true'`), 'Undo must restore the completed parent');
    await addChild(restoreChild);
    await open(restoreChild); await tabs('Archive'); await open(reviewProject); await run(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').click()`); await close();
    await fill('select[aria-label="Choose project list"]','finished');
    await run(`(() => {const title=[...document.querySelectorAll('.panel .task-title')].find(element=>element.textContent===${JSON.stringify(restoreChild)});title.closest('.task-row').parentElement.querySelector('button.open-outline').click();})()`);
    assert(await evaluate(`document.querySelector('.task-status').innerText.includes('Reopened')`), 'Unarchiving unfinished work must visibly reopen completed ancestors');
    await fill('select[aria-label="Choose project list"]',listId); await open(reviewProject);
    assert(await evaluate(`document.querySelector('.TaskWorkspace .legacy-menu-title .task-check').getAttribute('aria-pressed')==='false'`), 'Restored unfinished work must leave the parent open');
    assert((await dialogText()).includes(restoreChild), 'Restored unfinished child must be visible');
    await close();
    // Search accepts an ancestor path, not only the result's own title.
    await fill('input[aria-label="Search all tasks"]',`${project} ${build}`);
    assert(await evaluate(`!![...document.querySelectorAll('.panel:nth-of-type(2) .task-title')].find(element=>element.textContent===${JSON.stringify(leaf)})`), 'Full-path search must find deeply nested tasks by their ancestors');
    await fill('input[aria-label="Search all tasks"]','');

    const planningRoot=`${prefix} scheduled outcome`, firstStep=`${prefix} draft`, lastStep=`${prefix} release`, parallelStep=`${prefix} parallel`, outsideStep=`${prefix} outside commitment`, menuStep=`${prefix} menu step`;
    await addRoot(planningRoot); await open(planningRoot); await edit();
    await field('Deadline',today); await field('Due time','02:00'); await field('Planned start',today); await field('Estimated minutes','999'); await save();
    for(const [title,effort] of [[firstStep,'60'],[lastStep,'30'],[parallelStep,'20']]) {
      await addChild(title); await open(title); await edit(); await field('Estimated minutes',effort); await save();
      await close(); await open(planningRoot);
    }
    await open(lastStep); await tabs('Dependencies');
    const firstStepId=await evaluate(`[...document.querySelector('select[aria-label="Prerequisite task"]').options].find(option=>option.textContent.includes(${JSON.stringify(firstStep)})).value`);
    await fill('select[aria-label="Prerequisite task"]',firstStepId); await tabs('Add');
    await close(); await open(planningRoot); await tabs('Timeline');
    assert((await dialogText()).includes('Deadline margin: 30 min'), 'Scheduled analysis must calculate the outcome deadline margin');
    const chain=await evaluate(`document.querySelector('.scheduled-critical-chain').innerText`);
    assert(chain.includes(firstStep) && chain.includes(lastStep) && !chain.includes(parallelStep), 'Scheduled critical path must identify the sequential steps, without double-counting the root');
    await run(`document.querySelector('.schedule-analysis details summary').click()`);
    const parallelSchedule=await evaluate(`[...document.querySelectorAll('.schedule-table tbody tr')].find(row=>row.innerText.includes(${JSON.stringify(parallelStep)})).innerText`);
    assert(parallelSchedule.includes('70 min'), 'Parallel work must report its available scheduling float');
    assert((await dialogText()).includes('3 unfinished subtasks have no deadline'), 'Workspace must distinguish missing child deadlines from the parent deadline');
    await screenshot('tasks-schedule-analysis-desktop.png',1365,'.schedule-analysis');
    await screenshot('tasks-schedule-analysis-narrow.png',390,'.schedule-analysis');
    await close(); await addRoot(outsideStep); await open(outsideStep); await edit();
    const tomorrow=await evaluate(`(() => {const date=new Date(${JSON.stringify(today)}+'T12:00:00');date.setDate(date.getDate()+1);return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');})()`);
    await field('Deadline',tomorrow); await field('Planned start',tomorrow); await field('Estimated minutes','30'); await save(); await tabs('Dependencies');
    const planningRootId=await evaluate(`[...document.querySelector('select[aria-label="Prerequisite task"]').options].find(option=>option.textContent===${JSON.stringify(planningRoot)}).value`);
    await fill('select[aria-label="Prerequisite task"]',planningRootId); await tabs('Add');
    await close(); await open(planningRoot); await tabs('Shift schedule'); await fill('.schedule-shift input','2');
    assert((await dialogText()).includes(outsideStep), 'Branch shift preview must flag affected dependent work in another project');
    await tabs('Cancel'); await tabs('Outline'); await addChild(menuStep);
    const actions=async title=>run(`document.querySelector(${JSON.stringify('button[aria-label="Task actions for '+title+'"]')}).click()`);
    await actions(menuStep);
    await run(`document.querySelector('.TaskWorkspace .workspace-content').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    assert(!await evaluate(`!!document.querySelector('.task-row-actions')`), 'Clicking empty space must dismiss a task row action menu');
    await click('Menu', `document.querySelector('.TaskWorkspace')`);
    await actions(menuStep); await tabs('Indent under previous task'); await open(parallelStep); await open(menuStep);
    assert((await evaluate(`document.querySelector('.task-map-panel.map-selected')?.getAttribute('aria-label')`)).includes(parallelStep), 'Menu indent must carry the task beneath the previous sibling');
    await close(); await open(planningRoot); await tabs('Outline');
    await run(`document.querySelector('button[aria-label=${JSON.stringify('Expand '+parallelStep)}]').click()`);
    await actions(menuStep); await screenshot('tasks-outline-menu-narrow.png',390,'.task-row-actions'); await tabs('Outdent one level'); await open(menuStep);
    assert(!(await evaluate(`document.querySelector('.task-map-panel.map-selected')?.getAttribute('aria-label')`)).includes(parallelStep), 'Menu outdent must return the task to the parent branch');
    await close();
    const exportDirectory=path.join(artifacts,`export-${prefix.replace(/ /g,'-')}`);fs.mkdirSync(exportDirectory,{recursive:true});
    const exportFile=path.join(exportDirectory,`localflow-tasks-${today}.json`);
    await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:exportDirectory});
    await run(`(() => {const options=document.querySelector('.panel:nth-of-type(2) .panel-options');if(!options.open)options.querySelector('summary').click();})()`);
    await click('Export tasks and migration backup');
    await eventually(async () => fs.existsSync(exportFile), 'Task export must download a JSON artifact');
    const exported = JSON.parse(fs.readFileSync(exportFile,'utf8'));
    assert.equal(exported.schemaVersion,2,'Task export must preserve recursive schema');
    assert(exported.items.some(task=>task.contents===project),'Task export must include the created project');
    console.log('Export:',exportFile);
    assert.equal(pageErrors.length,0, 'No unhandled page exceptions');
    console.log(JSON.stringify({ok:true,project,today,artifacts,checks:['nested creation','global due across custom lists','outline','cross-task dependencies','timeline','schedule preview and history','completion','recurrence snapshots','trash restore','parent completion confirmation','branch recurrence snapshots','monthly clamp','keyboard indent and outdent','archived prerequisite satisfaction','canceled prerequisite blocks','archive subtree restore','task deep links','layered dependency graph','highlight and open graph node','JSON export','search target in outline','outline connectors','inherited blocker source','project summary','completion descendant preview','details bulk completion','restoring work reopens ancestors','full unresolved dependency trace','ancestor path search','scheduled critical path and margin','parallel scheduling float','missing child deadlines','cross-project schedule warnings','menu indent and outdent','non-modal inward task map','metadata card panels','left settings rail','interactive dashboard alongside map','narrow map preserves originating row access','hidden rail completion review','compact map viewport bounds','quarter-height list rows'],pageErrors},null,2));
  } finally { socket.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
