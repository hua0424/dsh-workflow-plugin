// 测试用假 gh：把 gh api Git Data 请求落到本地 bare 仓库的真实 git 对象上，
// 使 push-via-api.mjs 的 fetch + tree 级等价核验走真实 git 语义。
// 环境变量：FAKE_GIT_DIR（bare 仓库）、FAKE_REFS（heads json 文件）、FAKE_LOG（请求记录 jsonl，可选）。
// 仅覆盖 push-via-api.mjs 实际用到的子命令，其余一律 exit 99。
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const G = ['--git-dir', process.env.FAKE_GIT_DIR];
function git(input, ...args) {
  return execFileSync('git', [...G, ...args],
    { input, maxBuffer: 256 * 1024 * 1024 }).toString();
}
const args = process.argv.slice(2);
function log(req) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(req) + '\n');
}
function readInput() {
  const i = args.indexOf('--input');
  if (i === -1) return {};
  return JSON.parse(readFileSync(args[i + 1], 'utf8'));
}
function refs() {
  return JSON.parse(readFileSync(process.env.FAKE_REFS, 'utf8'));
}
function writeRefs(r) {
  writeFileSync(process.env.FAKE_REFS, JSON.stringify(r));
}

const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
const path = args.find((a) => a.startsWith('repos/')) ?? '';

if (args[0] === 'repo') {
  // repo view --json nameWithOwner（脚本仅请求该字段）
  // 脚本带 -q '.nameWithOwner'，jq 过滤后取原始值
  console.log('t/r');
  process.exit(0);
}
if (path.startsWith('repos/t/r/git/ref/heads/')) {
  const name = path.replace('repos/t/r/git/ref/heads/', '');
  const r = refs()[name];
  if (!r) process.exit(1);
  console.log(JSON.stringify({ object: { sha: r } }));
  process.exit(0);
}
if (method === 'POST' && path === 'repos/t/r/git/blobs') {
  const { content } = readInput();
  const buf = Buffer.from(content, 'base64');
  const sha = git(buf, 'hash-object', '-w', '--stdin').trim();
  log({ kind: 'blob', sha, bytes: buf.length });
  console.log(JSON.stringify({ sha }));
  process.exit(0);
}
if (method === 'POST' && path === 'repos/t/r/git/trees') {
  const { tree } = readInput();
  log({ kind: 'tree', entries: tree.map((e) => ({ ...e })) });
  if ('base_tree' in readInput()) process.exit(98); // 坑③：禁止 base_tree
  const sorted = [...tree].sort((a, b) => {
    const an = a.type === 'tree' ? a.path + '/' : a.path;
    const bn = b.type === 'tree' ? b.path + '/' : b.path;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const lines = sorted.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}`).join('\n');
  console.log(JSON.stringify({ sha: git(lines, 'mktree').trim() }));
  process.exit(0);
}
if (method === 'POST' && path === 'repos/t/r/git/commits') {
  const { message, tree, parents } = readInput();
  log({ kind: 'commit', tree, parents, message });
  const commitArgs = ['commit-tree', tree];
  for (const p of parents ?? []) commitArgs.push('-p', p);
  console.log(JSON.stringify({ sha: git(message, ...commitArgs).trim() }));
  process.exit(0);
}
if (method === 'PATCH' && path.startsWith('repos/t/r/git/refs/heads/')) {
  const name = path.replace('repos/t/r/git/refs/heads/', '');
  // F2 测试 seam：FAKE_PATCH_FAIL=error 模拟非缺失失败（ref 仍在）；
  // =missing 模拟竞态（step1 后远端分支被删，PATCH 404 且重查亦缺失）
  if (process.env.FAKE_PATCH_FAIL === 'error') {
    console.error('HTTP 422: Update is not a fast forward');
    process.exit(1);
  }
  if (process.env.FAKE_PATCH_FAIL === 'missing') {
    const r = refs(); delete r[name]; writeRefs(r);
    console.error('HTTP 404: Reference does not exist');
    process.exit(1);
  }
  const r = refs(); r[name] = readInput().sha; writeRefs(r);
  git('', 'update-ref', `refs/heads/${name}`, r[name]); // 物化到 bare，脚本 verify 的 fetch 才能看到
  log({ kind: 'ref-update', ref: name, sha: r[name] });
  process.exit(0);
}
if (method === 'POST' && path === 'repos/t/r/git/refs') {
  const { ref, sha } = readInput();
  const name = ref.replace('refs/heads/', '');
  const r = refs(); r[name] = sha; writeRefs(r);
  git('', 'update-ref', `refs/heads/${name}`, sha);
  log({ kind: 'ref-create', ref: name, sha });
  process.exit(0);
}
process.exit(99);
