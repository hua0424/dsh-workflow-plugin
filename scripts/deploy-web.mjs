/**
 * Deploy the built plugin into the web profile's local bundle directory
 * (wfgate-style layout). Copies compiled lib + cordis.patch.yml + package.json
 * into ~/.dsh/profiles/web/wfdev so the runtime resolves @deepseek-ai/*
 * from the profiles/node_modules fallback (SAME instances as the host),
 * exactly like the shipped bundles. Runtime deps (yaml/zod) install through
 * the profile's pnpm.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const profileDir = join(homedir(), '.dsh', 'profiles', 'web')
const target = join(profileDir, 'wfdev')

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  console.error('lib/index.js missing — run `pnpm run build` first')
  process.exit(1)
}

mkdirSync(target, { recursive: true })

// Replace lib wholesale (removes old junction/copy trees).
rmSync(join(target, 'lib'), { recursive: true, force: true })
cpSync(join(repoRoot, 'lib'), join(target, 'lib'), { recursive: true })
writeFileSync(join(target, 'cordis.patch.yml'), readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8'), 'utf8')
writeFileSync(join(target, 'package.json'), JSON.stringify({
  name: 'dsh-agent-team-workflow',
  version: '0.1.0',
  type: 'module',
  main: 'lib/index.js',
  dependencies: { yaml: '^2.9.0', zod: '^4.5.4' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  license: 'MIT',
}, null, 2) + '\n', 'utf8')

console.log(`deployed to ${target}`)
console.log('next: restart DSH; verify with /dsh-flow list')
