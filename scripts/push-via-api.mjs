#!/usr/bin/env node
// push-via-api.mjs — 仓库无关：经 gh api Git Data 把本地提交发布到远端 ref。
// 覆盖 docs/dsh-workflow/INDEX.md「gh api Git Data 发布提交」五坑：
//   ① blob 内容取 git 对象（git cat-file blob <sha>），不取工作树字节；
//   ② 含子目录的树自底向上递归创建；
//   ③ POST /git/trees 省略 base_tree、提交完整条目表；
//   ④ commit 的 parents 取远端 head；
//   ⑤ 多行 message 经 JSON --input 文件构造。
// 用法：node scripts/push-via-api.mjs <localRef> <remoteRef> [--remote origin] [--repo owner/name] [--dry-run] [--skip-verify]
// 输出：发布的远端 commit SHA、逐 blob SHA 校验与 tree 级等价核验结果。
// 核验通过后本地回齐需手动执行（脚本只打印指引，不做破坏性操作）。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------- CLI ----------
const args = process.argv.slice(2);
function usage() {
  console.error('用法: node scripts/push-via-api.mjs <localRef> <remoteRef> [--remote origin] [--repo owner/name] [--dry-run] [--skip-verify]');
  process.exit(2);
}
if (args.length < 2 || args.filter((a) => !a.startsWith('--')).length !== 2) usage();
const [localRef, remoteRefRaw] = args.filter((a) => !a.startsWith('--'));
let remote = 'origin', repo = null, dryRun = false, skipVerify = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--remote') remote = args[++i];
  else if (args[i] === '--repo') repo = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--skip-verify') skipVerify = true;
  else if (!args[i].startsWith('--')) { /* 位置参数，已取 */ }
  else usage();
}
const remoteRef = remoteRefRaw.replace(/^refs\/heads\//, '');

const tmpDir = mkdtempSync(join(tmpdir(), 'push-via-api-'));
process.on('exit', () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { maxBuffer: 256 * 1024 * 1024, ...opts });
}
function git(...a) { return run('git', a).toString().trim(); }
// 提交 message 取 commit 对象原文（首个空行之后的全部字节）：坑⑤要求孪生 commit 的 message 与本地一致，
// 而 git() 的 trim 会丢掉末尾换行（git 生成的提交恒以 \n 结尾），发布出去即与本地 message 不逐字节等价。
function commitMessage(sha) {
  const raw = run('git', ['cat-file', 'commit', sha]).toString('utf8');
  return raw.slice(raw.indexOf('\n\n') + 2);
}
// 测试 seam：PUSH_VIA_API_GH 指向替代 gh 的脚本（以 node 执行），生产恒为 'gh'
function gh(...a) {
  const stub = process.env.PUSH_VIA_API_GH;
  return stub ? run(process.execPath, [stub, ...a]).toString().trim() : run('gh', a).toString().trim();
}

// 全部 JSON 请求体经临时文件 --input 传入：坑⑤（多行 message / 二进制 blob 的 base64 都不受命令行长度与管道限制）
function ghApiJson(method, path, body) {
  const file = join(tmpDir, `body-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(body));
  return gh('api', '--method', method, path, '--input', file);
}

// ls-tree 行解析（F4：blob 枚举与远端复用枚举共用同一解析器，避免两处手写漂移）
function parseLsTree(output) {
  const rows = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const tabIndex = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tabIndex).split(' ');
    rows.push({ path: line.slice(tabIndex + 1), mode, type, sha });
  }
  return rows;
}

function fail(stage, msg) {
  console.error(`[push-via-api] 失败（阶段: ${stage}）: ${msg}`);
  process.exit(1);
}

// ---------- 0. 解析仓库与本地提交 ----------
if (!repo) repo = gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner');
const api = `repos/${repo}/git`;
const localCommit = git('rev-parse', `${localRef}^{commit}`);
console.log(`仓库 ${repo}；本地提交 ${localCommit} → 远端 refs/heads/${remoteRef}`);

// ---------- 1. 远端 head（坑④：parents 取远端 head）----------
let remoteHead;
try {
  const ref = JSON.parse(gh('api', `repos/${repo}/git/ref/heads/${remoteRef}`));
  remoteHead = ref.object.sha;
  git('cat-file', '-e', `${remoteHead}^{commit}`);
} catch {
  fail('ref', `远端分支 refs/heads/${remoteRef} 不存在或其 head 本地不可达。请先用 INDEX 备忘三段式建远端分支（gh api POST repos/<owner>/<repo>/git/refs），再重跑本脚本。`);
}
console.log(`远端 head（作为 commit parents）: ${remoteHead}`);

// ---------- 2. 本地提交的完整条目表（坑③：整树提交，不做增量 base_tree）----------
const entries = new Map(); // path -> { mode, type, sha }
for (const { path, mode, type, sha } of parseLsTree(git('ls-tree', '-r', '--full-tree', localCommit))) {
  entries.set(path, { mode, type, sha });
}
const changed = git('diff-tree', '-r', '--name-status', remoteHead, localCommit)
  .split('\n').filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status, path: rest.join('\t') };
  });
console.log(`相对远端 head 变更 ${changed.length} 个路径；本地树共 ${entries.size} 个条目`);

// ---------- 3. 逐 blob 发布并按 SHA 校验（坑①）----------
const remoteBlobShas = new Set();
for (const { type, sha } of parseLsTree(git('ls-tree', '-r', '--full-tree', remoteHead))) {
  if (type === 'blob') remoteBlobShas.add(sha);
}
const blobChecks = [];
for (const { status, path } of changed) {
  if (status === 'D') continue;
  const meta = entries.get(path);
  if (!meta || meta.type !== 'blob') fail('blob', `路径 ${path} 不在本地提交树中或非 blob: ${JSON.stringify(meta)}`);
  if (dryRun || remoteBlobShas.has(meta.sha)) {
    blobChecks.push({ path, sha: meta.sha, ...(remoteBlobShas.has(meta.sha) ? { reused: true } : { dryRun: true }) });
    continue;
  }
  // 内容取 git 对象字节（非工作树），base64 经临时文件传给 gh api
  const buf = run('git', ['cat-file', 'blob', meta.sha]);
  const returned = JSON.parse(ghApiJson('POST', `${api}/blobs`, { content: buf.toString('base64'), encoding: 'base64' })).sha;
  if (returned !== meta.sha) fail('blob', `blob SHA 不符: ${path} 期望 ${meta.sha} 实得 ${returned}`);
  blobChecks.push({ path, sha: meta.sha, created: true });
}
console.log(`blob 校验: ${blobChecks.length} 项全部匹配预期 SHA`);

// ---------- 4. 自底向上递归建树（坑②③）----------
// paths 为相对当前层 tree 的路径；entries 以仓库根全路径（prefix + p）为键
function buildTree(paths, prefix = '') {
  const dirs = new Map();
  const files = [];
  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash === -1) files.push(p);
    else {
      const dir = p.slice(0, slash);
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push(p.slice(slash + 1));
    }
  }
  const tree = [];
  for (const [dir, sub] of dirs) tree.push({ path: dir, mode: '040000', type: 'tree', sha: buildTree(sub, `${prefix}${dir}/`) });
  for (const p of files) {
    // F1：透传条目真实类型，非 blob（submodule 等 type commit）显式 fail-closed，
    // 与 blob 阶段的 changed 路径检查同强度，不静默写坏远端树
    const meta = entries.get(prefix + p);
    if (!meta) fail('tree', `路径 ${prefix + p} 不在本地提交树中`);
    if (meta.type !== 'blob') fail('tree', `路径 ${prefix + p} 为 ${meta.type} 类型（submodule 等）暂不支持经本脚本发布`);
    tree.push({ path: p, mode: meta.mode, type: 'blob', sha: meta.sha });
  }
  if (dryRun) return 'dry-run-tree';
  return JSON.parse(ghApiJson('POST', `${api}/trees`, { tree })).sha;
}
const newTree = buildTree([...entries.keys()]);
console.log(`tree: ${newTree}`);

// ---------- 5. 建 commit（坑④⑤：parents=远端 head，多行 message 走 JSON）----------
let newCommit = 'dry-run-commit';
if (!dryRun) {
  newCommit = JSON.parse(ghApiJson('POST', `${api}/commits`, {
    message: commitMessage(localCommit),
    tree: newTree,
    parents: [remoteHead],
  })).sha;
}
console.log(`commit: ${newCommit}（tree 等价于本地 ${localCommit}）`);

// ---------- 6. 更新远端 ref ----------
if (dryRun) {
  console.log('[dry-run] 未写远端；实际执行将 PATCH refs/heads/' + remoteRef + '（不存在则 POST refs）');
} else {
  // F2：PATCH 失败先重查 ref 是否存在——缺失才 POST 创建（gh 报错走 stdio 直出，
  // 此处 catch 到的 message 不带 HTTP 状态，故不用正则分类，而以 GET 重查为准）；
  // 其余失败 fail-closed 报真实原因。parents=[remoteHead] 使 PATCH 天然 fast-forward，
  // 故不再传 spec 未要求的 force:true
  try {
    ghApiJson('PATCH', `${api}/refs/heads/${remoteRef}`, { sha: newCommit });
  } catch {
    let refMissing = false;
    try { gh('api', `repos/${repo}/git/ref/heads/${remoteRef}`); } catch { refMissing = true; }
    if (refMissing) {
      ghApiJson('POST', `${api}/refs`, { ref: `refs/heads/${remoteRef}`, sha: newCommit });
    } else {
      fail('ref', `更新远端 ref 失败（ref 仍存在，不自动创建；请据上方 gh 报错排查后重跑）`);
    }
  }
  console.log(`ref 更新: refs/heads/${remoteRef} → ${newCommit}`);
}

// ---------- 7. 核验：逐 blob（第 3 步）+ tree 级等价（fetch 后 diff --exit-code）----------
// --skip-verify 保留理由：受限网络下 fetch 常被断，允许显式跳过脚本内核验
//（发布路径不变，调用方自行核对 tree 等价）；默认仍走两级核验
if (dryRun || skipVerify) {
  console.log('[skip] 跳过 tree 级等价核验');
} else {
  // 经命名 remote（--remote，默认 origin）fetch 做等价核验：目标场景即受限网络，ssh 22 常被断
  git('fetch', '--quiet', remote, `refs/heads/${remoteRef}`);
  git('diff', '--quiet', '--exit-code', 'FETCH_HEAD', localCommit); // 非零即内容不等价，抛错终止
  const remoteTree = git('rev-parse', 'FETCH_HEAD^{tree}');
  const localTree = git('rev-parse', `${localCommit}^{tree}`);
  if (remoteTree !== localTree) fail('verify', `tree SHA 不等价: 远端 ${remoteTree} vs 本地 ${localTree}`);
  console.log(`tree 级等价核验通过: ${remoteTree}`);
  // F5：回齐指引不再假设 localRef 为分支名（SHA 时 checkout 无意义），
  // 与 operations.md 口径一致：fetch + reset --hard 到已取回的远端头（先切到待回齐分支）
  console.log('[回齐指引] 远端为孪生 commit（同 tree 不同 SHA），本地回齐需手动执行（先切到待回齐分支）：');
  console.log(`  git fetch ${remote} ${remoteRef} && git reset --hard FETCH_HEAD`);
}
console.log(`DONE ${newCommit}`);
