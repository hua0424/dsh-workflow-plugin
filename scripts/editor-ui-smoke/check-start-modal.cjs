async page => {
  const callsOf = () => page.evaluate(() => JSON.stringify(window.__execCalls));
  const setExecMode = (mode) => page.evaluate((m) => { window.__execMode = m; }, mode);
  const setCatalogMode = (mode) => page.evaluate(
    (m) => fetch('/start-control', { method: 'POST', body: JSON.stringify({ mode: m }) }).then((r) => r.text()), mode);
  const entry = () => page.getByRole('button', { name: '启动工作流', exact: true });
  const dialog = () => page.getByRole('dialog', { name: '启动工作流', exact: true });
  const select = () => dialog().getByLabel('选择工作流配置', { exact: true });
  const confirm = () => dialog().getByRole('button', { name: '确定启动', exact: true });
  const reasonsToggle = () => dialog().getByRole('button', { name: /详情/, exact: false });
  const reasonsPanel = () => dialog().getByRole('region', { name: '配置问题详情' });
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

  await page.goto('http://127.0.0.1:43852/start');
  await entry().waitFor({ state: 'visible' });
  await wantEnabled(true, 'Start entry must be enabled for idle session with workspace');

  // #184 下拉呈现全部配置：有效/警告/无效都在 option 里，无效只带简短 error 标注。
  await openFresh();
  await select().waitFor({ state: 'visible' });
  const optionTexts = await select().locator('option').allInnerTexts();
  const joined = optionTexts.join('\n');
  if (!joined.includes('demo.yaml')) throw Error(`Dropdown must list valid entry, got: ${joined}`);
  if (!joined.includes('warned.yaml')) throw Error(`Dropdown must list warning entry, got: ${joined}`);
  if (!joined.includes('仍可启动')) throw Error(`Warning option must keep short label, got: ${joined}`);
  if (!joined.includes('broken.yaml')) throw Error(`Dropdown must list invalid entry, got: ${joined}`);
  if (!joined.includes('error')) throw Error(`Invalid option must carry short error mark, got: ${joined}`);
  if (joined.includes('bad yaml')) throw Error(`Dropdown must not inline full reasons, got: ${joined}`);
  if (!((await dialog().getByText('当前会话上下文会追加到 prompt 中', { exact: false }).count()) > 0)) throw Error('Context hint must be visible');
  if (await page.evaluate(() => window.__execCalls.length) !== 0) throw Error('Open must not execute commands');

  // #184 选中无效配置：出现错误图标、确认保持禁用；点击展开具体报错，再点收起。
  await select().selectOption('broken');
  if (await confirm().isEnabled()) throw Error('Confirm must stay disabled for invalid selection');
  await reasonsToggle().waitFor({ state: 'visible' });
  if (await reasonsToggle().getAttribute('aria-expanded') !== 'false') throw Error('Toggle must start collapsed');
  await reasonsToggle().click();
  await reasonsPanel().waitFor({ state: 'visible' });
  if (await reasonsToggle().getAttribute('aria-expanded') !== 'true') throw Error('Toggle must report expanded');
  if (!((await reasonsPanel().innerText()).includes('bad yaml'))) throw Error('Expanded panel must show the real reason');
  await reasonsToggle().click();
  await reasonsPanel().waitFor({ state: 'hidden' });
  // 切换到另一个配置：报错面板自动收起/更新（有效配置无图标无面板）。
  await select().selectOption('demo');
  if ((await reasonsToggle().count()) > 0) throw Error('Valid selection must not show the reasons icon');
  if ((await reasonsPanel().count()) > 0) throw Error('Switching selection must collapse the reasons panel');
  if (!(await confirm().isEnabled())) throw Error('Valid selection must enable confirm');

  // #184 警告配置：保留可辨识标注，图标展开可见具体原因，仍可确认启动。
  await select().selectOption('warned');
  await reasonsToggle().waitFor({ state: 'visible' });
  await reasonsToggle().click();
  await reasonsPanel().waitFor({ state: 'visible' });
  if (!((await reasonsPanel().innerText()).includes('hand-written protocol keyword'))) throw Error('Warning panel must show the real cause');
  if (!(await confirm().isEnabled())) throw Error('Warning selection must keep confirm enabled');
  // 刷新后收起并按新选择更新。
  await dialog().getByRole('button', { name: '刷新', exact: true }).click();
  await select().waitFor({ state: 'visible' });
  if ((await reasonsPanel().count()) > 0) throw Error('Refresh must collapse the reasons panel');
  // 键盘操作：select 可聚焦，图标按钮聚焦后 Enter 展开。
  await select().selectOption('broken');
  await reasonsToggle().focus();
  await page.keyboard.press('Enter');
  await reasonsPanel().waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  // Escape 关闭原生 dialog：面板随弹窗关闭而不可见（不要求图标切换语义）。
  await dialog().waitFor({ state: 'hidden' });

  // #184 prompt 输入框放大：min-height 约 160px，仍可纵向拉伸；8000 上限语义不变。
  await openFresh();
  await select().selectOption('demo');
  const promptBox = await dialog().getByLabel(/启动 prompt/).evaluate((el) => {
    const style = getComputedStyle(el);
    return { minHeight: style.minHeight, resize: style.resize };
  });
  if (promptBox.minHeight !== '160px') throw Error(`Prompt must grow to ~160px min-height, got: ${promptBox.minHeight}`);
  if (promptBox.resize !== 'vertical') throw Error(`Prompt must stay vertically resizable, got: ${promptBox.resize}`);

  // 选择展示 .yaml，提交用 workflow-id；空 prompt 沿用命令语义。
  await dialog().getByLabel(/启动 prompt/).fill('hello world');
  await confirm().click();
  await dialog().waitFor({ state: 'hidden' });
  if (await callsOf() !== JSON.stringify([{ sessionId: 'sess-1', line: '/dsh-flow start demo hello world' }])) {
    throw Error(`Submit must call native command once with workflow-id, got ${await callsOf()}`);
  }
  // 空 prompt：命令不带多余空格。
  await openFresh();
  await select().selectOption('warned');
  await confirm().click();
  await dialog().waitFor({ state: 'hidden' });
  if (await callsOf() !== JSON.stringify([{ sessionId: 'sess-1', line: '/dsh-flow start warned' }])) {
    throw Error(`Empty prompt must keep command semantics, got ${await callsOf()}`);
  }
  // 内层命令失败：真实原因展示、保留输入、不关闭。
  await openFresh();
  await setExecMode('command-error');
  await select().selectOption('demo');
  await dialog().getByLabel(/启动 prompt/).fill('retry-me');
  await confirm().click();
  await dialog().getByRole('alert').waitFor({ state: 'visible' });
  if (!((await dialog().getByRole('alert').innerText()).includes('已有活动 Run'))) throw Error('Command failure must show real reason');
  if (await dialog().getByLabel(/启动 prompt/).inputValue() !== 'retry-me') throw Error('Failure must retain input');
  // 刷新只读目录，不执行命令；取消无副作用。
  const callsBeforeRefresh = await callsOf();
  await dialog().getByRole('button', { name: '刷新', exact: true }).click();
  await select().waitFor({ state: 'visible' });
  if (await callsOf() !== callsBeforeRefresh) throw Error('Refresh must not execute commands');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  if (await callsOf() !== callsBeforeRefresh) throw Error('Cancel must not execute commands');
  // 未知结果（传输失败）：指引查状态、不自动重试。
  await openFresh();
  await setExecMode('transport-fail');
  await select().selectOption('demo');
  await confirm().click();
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
  await select().waitFor({ state: 'visible' });
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await setCatalogMode('empty');
  await entry().click();
  await dialog().getByText('目录为空', { exact: false }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'hidden' });
  // #184 窄屏不横向溢出（样式按 92vw 约束；此处断言页面无横向溢出 + 约束存在）。
  await setCatalogMode('ok');
  await page.evaluate(() => { window.__renderStart('sess-1'); });
  await entry().click();
  await dialog().waitFor({ state: 'visible' });
  const overflow = await dialog().evaluate((el) => ({
    styleHasViewportCap: Array.from(document.querySelectorAll('style')).some((s) => s.textContent.includes('92vw')),
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    dialogOverflow: el.getBoundingClientRect().width > window.innerWidth,
  }));
  if (!overflow.styleHasViewportCap) throw Error('Dialog styles must cap width by viewport (92vw)');
  if (overflow.pageOverflow) throw Error('Page must not overflow viewport horizontally');
  if (overflow.dialogOverflow) throw Error('Dialog must not overflow viewport horizontally');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  // 快速取消→重开回归（F-001）：陈旧 close 不得关闭新弹窗，目录不永久 loading。
  await setCatalogMode('ok');
  await page.evaluate(() => { window.__execCalls = []; window.__renderStart('sess-1'); });
  await entry().click();
  await dialog().waitFor({ state: 'visible' });
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await entry().click();
  await dialog().waitFor({ state: 'visible' });
  await select().waitFor({ state: 'visible' });
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
  await select().selectOption('demo');
  await page.evaluate(() => { window.__renderStart('sess-2'); });
  await dialog().waitFor({ state: 'hidden' });
  // 提交闸门：挂起时 Escape/取消无法绕过，落定后单次派发。
  await page.evaluate(() => { window.__execCalls = []; window.__renderStart('sess-1'); });
  await setExecMode('hang');
  await entry().click();
  await dialog().waitFor({ state: 'visible' });
  await select().selectOption('demo');
  await confirm().click();
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
  return 'PASS start modal: dropdown all entries with short marks, invalid icon expand/collapse, switch/refresh collapse, warning cause, 160px prompt, workflow-id submit, failure/unknown handling, refresh/cancel side-effect free, disabled states, session-switch cleanup, submit gate, narrow viewport';
}
