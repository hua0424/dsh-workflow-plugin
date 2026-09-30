async page => {
  const callsOf = () => page.evaluate(() => JSON.stringify(window.__execCalls));
  const setExecMode = (mode) => page.evaluate((m) => { window.__execMode = m; }, mode);
  const setCatalogMode = (mode) => page.evaluate(
    (m) => fetch('/start-control', { method: 'POST', body: JSON.stringify({ mode: m }) }).then((r) => r.text()), mode);
  const entry = () => page.getByRole('button', { name: '启动工作流', exact: true });
  const dialog = () => page.getByRole('dialog', { name: '启动工作流', exact: true });
  /* F-002 自动等待断言：React 18 提交异步落定，轮询至期望使能态（替代一次性 isEnabled 读取）。 */
  const wantEnabled = async (want, msg) => {
    const start = Date.now();
    for (;;) {
      let actual = null;
      try { actual = await entry().isEnabled(); } catch { actual = null; }
      if (actual === want) return;
      if (Date.now() - start > 8000) throw Error(msg);
      await page.waitForTimeout(60);
    }
  };
  const openFresh = async () => {
    await setCatalogMode('ok');
    await setExecMode('success');
    await page.evaluate(() => { window.__execCalls = []; window.__renderStart('sess-1'); });
    await entry().click();
    await dialog().waitFor({ state: 'visible' });
  };
  const chooseDemo = async () => dialog().getByRole('radio', { name: 'demo.yaml' }).check();

  await page.goto('http://127.0.0.1:43852/start');
  await entry().waitFor({ state: 'visible' });
  await wantEnabled(true, 'Start entry must be enabled for idle session with workspace');

  // 打开只读目录：有效/警告可选、无效不可选；打开本身不执行命令。
  await openFresh();
  const demo = dialog().getByRole('radio', { name: 'demo.yaml' });
  const warned = dialog().getByRole('radio', { name: /warned\.yaml/ });
  const broken = dialog().getByRole('radio', { name: /broken\.yaml/ });
  if (!await demo.isEnabled() || !await warned.isEnabled()) throw Error('valid/warning entries must be selectable');
  if (await broken.isEnabled()) throw Error('invalid entry must not be selectable');
  if (!((await dialog().getByText('当前会话上下文会追加到 prompt 中', { exact: false }).count()) > 0)) throw Error('Context hint must be visible');
  if (await page.evaluate(() => window.__execCalls.length) !== 0) throw Error('Open must not execute commands');
  // 选择展示 .yaml，提交用 workflow-id；空 prompt 沿用命令语义。
  await chooseDemo();
  await dialog().getByLabel(/启动 prompt/).fill('hello world');
  await dialog().getByRole('button', { name: '确定启动', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  if (await callsOf() !== JSON.stringify([{ sessionId: 'sess-1', line: '/dsh-flow start demo hello world' }])) {
    throw Error(`Submit must call native command once with workflow-id, got ${await callsOf()}`);
  }
  // 空 prompt：命令不带多余空格。
  await openFresh();
  await dialog().getByRole('radio', { name: /warned\.yaml/ }).check();
  await dialog().getByRole('button', { name: '确定启动', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  if (await callsOf() !== JSON.stringify([{ sessionId: 'sess-1', line: '/dsh-flow start warned' }])) {
    throw Error(`Empty prompt must keep command semantics, got ${await callsOf()}`);
  }
  // 内层命令失败：真实原因展示、保留输入、不关闭。
  await openFresh();
  await setExecMode('command-error');
  await chooseDemo();
  await dialog().getByLabel(/启动 prompt/).fill('retry-me');
  await dialog().getByRole('button', { name: '确定启动', exact: true }).click();
  await dialog().getByRole('alert').waitFor({ state: 'visible' });
  if (!((await dialog().getByRole('alert').innerText()).includes('已有活动 Run'))) throw Error('Command failure must show real reason');
  if (await dialog().getByLabel(/启动 prompt/).inputValue() !== 'retry-me') throw Error('Failure must retain input');
  // 刷新只读目录，不执行命令；取消无副作用。
  const callsBeforeRefresh = await callsOf();
  await dialog().getByRole('button', { name: '刷新', exact: true }).click();
  await dialog().getByRole('radio', { name: 'demo.yaml' }).waitFor({ state: 'visible' });
  if (await callsOf() !== callsBeforeRefresh) throw Error('Refresh must not execute commands');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  if (await callsOf() !== callsBeforeRefresh) throw Error('Cancel must not execute commands');
  // 未知结果（传输失败）：指引查状态、不自动重试。
  await openFresh();
  await setExecMode('transport-fail');
  await chooseDemo();
  await dialog().getByRole('button', { name: '确定启动', exact: true }).click();
  await dialog().getByRole('alert').waitFor({ state: 'visible' });
  const unknownText = await dialog().getByRole('alert').innerText();
  if (!unknownText.includes('结果未知') || !unknownText.includes('status') || !unknownText.includes('不要自动重试')) {
    throw Error(`Unknown result must guide status check without retry, got: ${unknownText}`);
  }
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  // 目录失败可刷新重试；空目录有明确提示。
  await page.evaluate(() => { window.__renderStart('sess-1'); });
  await setCatalogMode('error');
  await entry().click();
  await dialog().getByText('读取目录失败', { exact: false }).waitFor({ state: 'visible' });
  await setCatalogMode('ok');
  await dialog().getByRole('button', { name: '刷新重试', exact: true }).click();
  await dialog().getByRole('radio', { name: 'demo.yaml' }).waitFor({ state: 'visible' });
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await setCatalogMode('empty');
  await entry().click();
  await dialog().getByText('目录为空', { exact: false }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'hidden' });
  // 快速取消→重开回归（F-001）：陈旧 close 不得关闭新弹窗，目录不永久 loading。
  await setCatalogMode('ok');
  await page.evaluate(() => { window.__execCalls = []; window.__renderStart('sess-1'); });
  await entry().click();
  await dialog().waitFor({ state: 'visible' });
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await entry().click();
  await dialog().waitFor({ state: 'visible' });
  await dialog().getByRole('radio', { name: 'demo.yaml' }).waitFor({ state: 'visible' });
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  // 禁用态：运行中/提交中/无 workspace（自动等待 React 提交落定）。
  await page.evaluate(() => { window.__renderStart('sess-1'); window.__setSessionState({ running: true }); });
  await wantEnabled(false, 'Running session must disable entry');
  await page.evaluate(() => { window.__setSessionState({ running: false }); window.__setInputPhase('submitting'); });
  await wantEnabled(false, 'Submitting session must disable entry');
  await page.evaluate(() => { window.__setInputPhase('plain'); window.__renderStart('sess-9'); });
  await wantEnabled(false, 'Session without workspace must disable entry');
  await page.evaluate(() => { window.__renderStart('sess-1'); });
  await wantEnabled(true, 'Entry must recover when session is idle again');
  // 切换会话关闭弹窗，不带走旧选择。
  await setCatalogMode('ok');
  await entry().click();
  await dialog().waitFor({ state: 'visible' });
  await chooseDemo();
  await page.evaluate(() => { window.__renderStart('sess-2'); });
  await dialog().waitFor({ state: 'hidden' });
  // 提交闸门：挂起时 Escape/取消无法绕过，落定后单次派发。
  await page.evaluate(() => { window.__execCalls = []; window.__renderStart('sess-1'); });
  await setExecMode('hang');
  await entry().click();
  await dialog().waitFor({ state: 'visible' });
  await chooseDemo();
  await dialog().getByRole('button', { name: '确定启动', exact: true }).click();
  await page.waitForTimeout(150);
  if (await dialog().getByRole('button', { name: '取消', exact: true }).isEnabled()) throw Error('Cancel must lock while submitting');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  if (!((await dialog().count()) > 0)) throw Error('Escape must not bypass the submit gate');
  await page.evaluate(() => { window.__resolveHang(); });
  await dialog().waitFor({ state: 'hidden' });
  if (await callsOf() !== JSON.stringify([{ sessionId: 'sess-1', line: '/dsh-flow start demo' }])) {
    throw Error(`Hang must settle exactly once, got ${await callsOf()}`);
  }
  return 'PASS start modal: readonly list valid/warning/invalid, hint, workflow-id submit, failure/unknown handling, refresh/cancel side-effect free, disabled states, session-switch cleanup, submit gate';
}
