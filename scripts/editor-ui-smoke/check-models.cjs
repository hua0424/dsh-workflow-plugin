async page => {
  await page.getByRole('tab',{name:'角色',exact:true}).click();
  const judge=page.locator('.wf-judge');
  await judge.getByRole('combobox',{name:'模型 provider',exact:true}).selectOption('deepseek');
  await judge.getByRole('combobox',{name:'modelId',exact:true}).selectOption('demo-model');
  await judge.getByRole('button',{name:'应用模型',exact:true}).click();
  await page.getByRole('tab',{name:'YAML',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.wf-preview pre').textContent.includes('modelId: demo-model'));
  await page.getByRole('tab',{name:'节点',exact:true}).click();
  const row=page.locator('.wf-node-card input').first();
  const button=page.locator('.wf-node-card').getByRole('button',{name:'改名',exact:true}).first();
  const a=await row.boundingBox(),b=await button.boundingBox();
  if(Math.abs(a.y-b.y)>8)throw Error('Field and button not aligned');
  await page.evaluate(()=>window.optimizationChecksPassed=true);
}
