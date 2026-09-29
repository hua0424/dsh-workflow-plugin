async page => {
  await page.reload();
  await page.getByRole('button', {name:'打开目录',exact:true}).click();
  await page.getByRole('button', {name:'demo.yaml',exact:true}).click();
  const canvas=page.locator('.wf-canvas');
  const node=page.getByRole('button', {name:'编辑节点 main',exact:true});
  await node.waitFor();
  const state=async()=>({
    positions:await page.locator('.wf-node, .wf-return-marker').evaluateAll(elements=>elements.map(el=>({left:el.style.left,top:el.style.top}))),
    saveDisabled:await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),
    undoDisabled:await page.getByRole('button',{name:'撤销',exact:true}).isDisabled(),
    redoDisabled:await page.getByRole('button',{name:'重做',exact:true}).isDisabled(),
    files:await page.evaluate(()=>JSON.stringify(window.files)),
  });
  const original=JSON.stringify(await state());
  const point=()=>node.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y};});
  await page.evaluate(()=>{window.panContextMenus=[];document.addEventListener('contextmenu',event=>window.panContextMenus.push(event.defaultPrevented));});
  for(const button of ['right','middle']) {
    // 每一方向均从适应画布出发，连续拖动超过原图边界，不能依赖有限 scroll 范围。
    for(const [dx,dy] of [[140,0],[-140,0],[0,120],[0,-120]]) {
      await page.getByRole('button',{name:'适应画布',exact:true}).click();
      for(let step=0;step<8;step++) {
        const blank=await canvas.evaluate(el=>{
          const r=el.getBoundingClientRect();
          for(let y=r.top+135;y<Math.min(r.bottom,innerHeight)-135;y+=17)for(let x=r.left+155;x<r.right-155;x+=17){
            const t=document.elementFromPoint(x,y);
            if(t&&el.contains(t)&&!t.closest('.wf-node, .wf-return-marker, .wf-edge-hit, .wf-edge-handle-x, .wf-edge-handle-y'))return {x,y};
          }
          return null;
        });
        if(!blank)throw Error('No blank canvas point');
        const before=await point();
        await page.mouse.move(blank.x,blank.y);await page.mouse.down({button});
        await page.mouse.move(blank.x+dx,blank.y+dy,{steps:4});await page.mouse.up({button});
        const after=await point();
        if(Math.abs(after.x-before.x-dx)>1||Math.abs(after.y-before.y-dy)>1)throw Error('Unbounded '+button+' pan failed '+JSON.stringify({dx,dy,step,before,after}));
        await page.mouse.move(blank.x,blank.y);
        if(JSON.stringify(await point())!==JSON.stringify(after))throw Error('Pan continued after release');
      }
    }
  }
  if(JSON.stringify(await state())!==original)throw Error('Pan changed layout, files, dirty or history');
  const menus=await page.evaluate(()=>window.panContextMenus);
  if(!menus.length||menus.some(prevented=>!prevented))throw Error('Right-click menu not suppressed');
  await page.getByRole('button',{name:'适应画布',exact:true}).click();
  const visible=await canvas.evaluate(el=>{const r=el.getBoundingClientRect();return [...el.querySelectorAll('.wf-node,.wf-return-marker')].every(n=>{const b=n.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom;});});
  if(!visible)throw Error('Fit failed to recover all graph nodes');
  await node.click();
  if(await page.locator('.wf-node.wf-selected').count()!==1)throw Error('Node selection failed after pan');
  return 'PASS right/middle unbounded pan in all four directions, release, context menu, unchanged document/history, fit and select';
}

