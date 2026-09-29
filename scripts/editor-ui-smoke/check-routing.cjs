async page => {
  await page.reload();
  await page.getByRole('button',{name:'打开目录',exact:true}).click();
  await page.getByRole('button',{name:'demo.yaml',exact:true}).click();
  const title=page.getByRole('button',{name:'编辑节点 main',exact:true});
  await title.waitFor();await title.click();
  const rename=page.locator('.wf-node-card input').first();
  await rename.fill('buffer-preserved');
  const width=()=>page.locator('.wf-canvas').evaluate(el=>el.getBoundingClientRect().width);
  const expanded=await width();
  await page.getByRole('button',{name:'收起属性',exact:true}).click();
  if(await width()<expanded+200)throw Error('Collapsed inspector did not enlarge canvas');
  await page.getByRole('button',{name:'展开属性',exact:true}).click();
  if(await rename.inputValue()!=='buffer-preserved')throw Error('Inspector collapse discarded unapplied form');
  await rename.fill('main');
  const edge=page.locator('.wf-edge[data-edge="edge:main:done"]');
  const line=edge.locator('.wf-edge-line');
  const original=await line.getAttribute('d');
  if(!original||/[CQAST]/i.test(original))throw Error('Expected orthogonal M/H/V edge: '+original);
  const hit=await edge.locator('.wf-edge-hit').evaluate(el=>{const p=el.getPointAtLength(18);const screen=new DOMPoint(p.x,p.y).matrixTransform(el.getScreenCTM());return {x:screen.x,y:screen.y};});
  await page.mouse.click(hit.x,hit.y);
  if(!await edge.evaluate(el=>el.classList.contains('wf-edge-selected')))throw Error('Click did not highlight selected edge');
  const normalStroke=await page.locator('.wf-edge:not(.wf-edge-selected) .wf-edge-line').first().evaluate(el=>getComputedStyle(el).stroke);
  const selectedStroke=await line.evaluate(el=>getComputedStyle(el).stroke);
  if(normalStroke===selectedStroke)throw Error('Selected edge has no distinct stroke');
  await page.getByRole('button',{name:'放大画布',exact:true}).click();
  const zoom=await page.locator('.wf-canvas-surface').evaluate(el=>Number(el.style.transform.match(/scale\(([^)]+)\)/)[1]));
  for(const [selector,dx,dy] of [['.wf-edge-handle-x',44,0],['.wf-edge-handle-y',0,44]]) {
    const before=await line.getAttribute('d');
    const handle=edge.locator(selector);
    const coordinate=dx?'cx':'cy';
    const routeBefore=Number(await handle.getAttribute(coordinate));
    const b=await handle.boundingBox();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
    await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:6});await page.mouse.up();
    const after=await line.getAttribute('d');
    const routeAfter=Number(await handle.getAttribute(coordinate));
    if(Math.abs(routeAfter-routeBefore-44/zoom)>1)throw Error('Route drag did not compensate zoom '+JSON.stringify({routeBefore,routeAfter,zoom}));
    if(after===before)throw Error('Route handle drag did not change edge: '+selector);
    await page.getByRole('button',{name:'撤销',exact:true}).click();
    if(await line.getAttribute('d')!==before)throw Error('One undo must restore entire route drag');
    await page.getByRole('button',{name:'重做',exact:true}).click();
    if(await line.getAttribute('d')!==after)throw Error('Route redo failed');
  }
  const keyboard=edge.locator('.wf-edge-handle-x');
  const keyboardBefore=Number(await keyboard.getAttribute('cx'));
  await keyboard.focus();await keyboard.press('Shift+ArrowRight');
  if(Number(await keyboard.getAttribute('cx'))!==keyboardBefore+40)throw Error('Keyboard route move failed');
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  if(Number(await keyboard.getAttribute('cx'))!==keyboardBefore)throw Error('Keyboard route undo failed');
  const routed=await line.getAttribute('d');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(()=>Object.entries(window.files).some(([name,text])=>name.endsWith('.json')&&JSON.parse(text).main['edge:main:done']));
  const stored=await page.evaluate(()=>JSON.parse(Object.entries(window.files).find(([name])=>name.endsWith('.json'))[1]).main['edge:main:done']);
  if(!Number.isFinite(stored.x)||!Number.isFinite(stored.y))throw Error('Route coordinates not persisted');
  // 必须在实际放大状态验收屏幕坐标与世界坐标换算。
  if(zoom<=1)throw Error('Routing drag must be exercised with zoom > 1');
  await page.getByRole('button',{name:'打开目录',exact:true}).click();
  await page.getByRole('button',{name:'demo.yaml',exact:true}).click();
  await line.waitFor();
  if(await line.getAttribute('d')!==routed)throw Error('Reopen lost saved route');
  return 'PASS inspector collapse width/form preservation, orthogonal routing, selected stroke, zoomed x/y drag, keyboard adjustment, one-step undo/redo and save/reopen '+JSON.stringify({zoom,stored});
}



