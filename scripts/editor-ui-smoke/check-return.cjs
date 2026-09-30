async page => {
  const filesOf = () => page.evaluate(() => JSON.stringify(window.files));
  await page.reload();
  await page.evaluate(() => { window.__selectedPanel = 'unset'; });
  await page.getByRole('button', { name: '打开目录', exact: true }).click();
  await page.getByRole('button', { name: 'demo.yaml', exact: true }).click();
  // 读取是异步 RPC：等 draft 渲染（=busy 已清）再断言空闲可返回，与脏检查段同一落定信号。
  await page.getByRole('button', { name: '编辑节点 main', exact: true }).waitFor({ state: 'visible' });
  const back = page.getByRole('button', { name: '返回对话', exact: true });
  await back.waitFor({ state: 'visible' });
  if (!await back.isEnabled()) throw Error('Back entry must be enabled when idle');
  const beforeFiles = await filesOf();
  // 干净返回：直接回到原 Conversation，不产生新文件/命令记录。
  await back.click();
  if (await page.evaluate(() => window.__selectedPanel) !== null) throw Error('Clean back must selectPanel(null)');
  if (await filesOf() !== beforeFiles) throw Error('Clean back must not mutate files');
  // 脏状态：制造未保存修改（节点指令应用），取消保留全部状态。
  await page.reload();
  await page.evaluate(() => { window.__selectedPanel = 'unset'; });
  await page.getByRole('button', { name: '打开目录', exact: true }).click();
  await page.getByRole('button', { name: 'demo.yaml', exact: true }).click();
  const title = page.getByRole('button', { name: '编辑节点 main', exact: true });
  await title.waitFor({ state: 'visible' });
  await title.click();
  await page.getByRole('button', { name: '编辑节点指令', exact: true }).click();
  const instruction = page.getByRole('dialog', { name: '节点指令', exact: true }).getByRole('textbox');
  await instruction.fill('返回冒烟草稿');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  if (!await page.getByRole('button', { name: '保存', exact: true }).isEnabled()) throw Error('Edit must leave dirty state');
  let asked = false;
  page.once('dialog', async dialog => { asked = true; await dialog.dismiss(); });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  if (!asked) throw Error('Dirty back must ask for confirmation');
  if (await page.evaluate(() => window.__selectedPanel) === null) throw Error('Cancel must stay in editor');
  if (!await page.getByRole('button', { name: '保存', exact: true }).isEnabled()) throw Error('Cancel must retain dirty changes');
  await page.getByRole('button', { name: '编辑节点指令', exact: true }).click();
  if (await instruction.inputValue() !== '返回冒烟草稿') throw Error('Cancel discarded draft input');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  // 确认放弃：返回且不自动保存（内存文件无新 YAML/布局写入）。
  const filesBeforeLeave = await filesOf();
  page.once('dialog', async dialog => { await dialog.accept(); });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  if (await page.evaluate(() => window.__selectedPanel) !== null) throw Error('Confirm must selectPanel(null)');
  if (await filesOf() !== filesBeforeLeave) throw Error('Confirm must not auto-save');
  return 'PASS back visible, clean return selectPanel(null), dirty cancel retains state, confirm abandons without save';
}
