// push-via-api.mjs 外部行为测试（node:test 直跑）：
// 本地 git 用真实临时仓库；gh api 网络侧经 PUSH_VIA_API_GH seam stub 到本地 bare 仓库的真实 git 对象，
// 使脚本的逐 blob SHA 校验与 tree 级等价核验走真实 git 语义。不断言内部实现细节。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'push-via-api.mjs');
const fakeGh = join(repoRoot, 'test', 'push-via-api-fake-gh.mjs');

function sh(cwd, cmd, ...args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
function setup() {
  const work = mkdtempSync(join(tmpdir(), 'pva-work-'));
  const bare = mkdtempSync(join(tmpdir(), 'pva-bare-')) + '/remote.git';
  sh(work, 'git', 'init', '--bare', bare);
  sh(work, 'git', 'init', '-b', 'main', '.');
  sh(work, 'git', 'config', 'user.email', 't@t'); sh(work, 'git', 'config', 'user.name', 't');
  writeFileSync(join(work, 'a.txt'), 'hello\n');
  mkdirSync(join(work, 'src/lib'), { recursive: true });
  writeFileSync(join(work, 'src/lib/deep.txt'), 'deep v1\n');
  sh(work, 'git', 'add', '-A');
  sh(work, 'git', 'commit', '-m', 'base');
  // 远端预置 base 提交（本地路径 push，无凭据交互）；脚本 verify 经命名 remote fetch
  sh(work, 'git', 'push', bare, 'main:refs/heads/topic');
  sh(work, 'git', 'remote', 'add', 'origin', bare);
  const baseSha = sh(work, 'git', 'rev-parse', 'HEAD').trim();
  // 本地新提交：修改 + 新增嵌套文件 + 删除 + 多行 message
  writeFileSync(join(work, 'a.txt'), 'hello v2\n');
  writeFileSync(join(work, 'src/lib/extra.md'), 'line1\nline2\nline3\n');
  sh(work, 'git', 'rm', '-q', 'src/lib/deep.txt');
  sh(work, 'git', 'add', '-A');
  execFileSync('git', ['commit', '-m', 'feat: 多行标题', '-m', '正文第一行\n正文第二行'], { cwd: work });
  const refsFile = join(work, 'heads.json');
  writeFileSync(refsFile, JSON.stringify({ topic: baseSha }));
  return { work, bare, refsFile, logFile: join(work, 'requests.jsonl') };
}

test('push-via-api 端到端：逐 blob 校验 + tree 级等价核验通过，五坑语义正确', () => {
  const { work, bare, refsFile, logFile } = setup();
  try {
    const out = execFileSync(process.execPath, [script, 'HEAD', 'topic'], {
      cwd: work, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, PUSH_VIA_API_GH: fakeGh, FAKE_GIT_DIR: bare, FAKE_REFS: refsFile, FAKE_LOG: logFile,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    // 输出契约：commit SHA + 两级核验证据
    assert.match(out, /blob 校验: \d+ 项全部匹配预期 SHA/);
    assert.match(out, /tree 级等价核验通过: [0-9a-f]{40}/);
    const commit = /DONE ([0-9a-f]{40})/.exec(out)[1];

    // 远端 ref 落到孪生 commit，tree 与本地等价
    const remoteSha = JSON.parse(readFileSync(refsFile, 'utf8')).topic;
    assert.equal(remoteSha, commit);
    const remoteTree = sh(work, 'git', 'rev-parse', `${remoteSha}^{tree}`).trim();
    const localTree = sh(work, 'git', 'rev-parse', 'HEAD^{tree}').trim();
    assert.equal(remoteTree, localTree);
    // 多行 message 完整保留（坑⑤）
    assert.equal(sh(work, 'git', 'log', '-1', '--format=%B', remoteSha), sh(work, 'git', 'log', '-1', '--format=%B', 'HEAD'));

    // 请求序列语义（坑①③④）：blob 内容取 git 对象、trees 无 base_tree 且含完整条目表、parents=远端 head
    const reqs = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const treeReqs = reqs.filter((r) => r.kind === 'tree');
    assert.ok(treeReqs.length >= 3, `含子目录应递归建多棵树，实得 ${treeReqs.length}`);
    for (const t of treeReqs) assert.equal(t.base_tree, undefined);
    const commitReq = reqs.find((r) => r.kind === 'commit');
    assert.equal(commitReq.parents.length, 1);
    assert.equal(commitReq.parents[0], sh(work, 'git', 'rev-parse', `${remoteSha}^`).trim());
    assert.ok(commitReq.message.includes('正文第二行'));
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('push-via-api dry-run 不写远端；远端 ref 缺失时明确报错', () => {
  const { work, bare, refsFile } = setup();
  try {
    const before = readFileSync(refsFile, 'utf8');
    const out = execFileSync(process.execPath, [script, 'HEAD', 'topic', '--dry-run'], {
      cwd: work, encoding: 'utf8',
      env: { ...process.env, PUSH_VIA_API_GH: fakeGh, FAKE_GIT_DIR: bare, FAKE_REFS: refsFile },
    });
    assert.match(out, /\[dry-run\]/);
    assert.equal(readFileSync(refsFile, 'utf8'), before);

    writeFileSync(refsFile, JSON.stringify({}));
    let err = null;
    try {
      execFileSync(process.execPath, [script, 'HEAD', 'missing-branch'], {
        cwd: work, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, PUSH_VIA_API_GH: fakeGh, FAKE_GIT_DIR: bare, FAKE_REFS: refsFile },
      });
    } catch (e) { err = e; }
    assert.ok(err, '远端 ref 缺失应失败');
    assert.match(err.stderr.toString(), /阶段: ref/);
    assert.match(err.stderr.toString(), /三段式/);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});
