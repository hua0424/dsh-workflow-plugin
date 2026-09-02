import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOriginRepo, runProgram } from '../src/programs/runner.ts'

test('parseOriginRepo handles git ssh form', () => {
  assert.deepEqual(parseOriginRepo('git@github.com:acme/server.git'), { owner: 'acme', repo: 'server' })
})

test('parseOriginRepo handles https form', () => {
  assert.deepEqual(parseOriginRepo('https://github.com/acme/server.git'), { owner: 'acme', repo: 'server' })
  assert.deepEqual(parseOriginRepo('https://github.com/acme/server/'), { owner: 'acme', repo: 'server' })
})

test('parseOriginRepo rejects non-github remotes', () => {
  assert.equal(parseOriginRepo('git@gitlab.com:acme/server.git'), undefined)
  assert.equal(parseOriginRepo(''), undefined)
  assert.equal(parseOriginRepo('not a url'), undefined)
})

test('runProgram captures output of a real command', () => {
  const result = runProgram('git', ['--version'])
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /git version/)
  assert.equal(result.failedToStart, false)
})

test('runProgram reports ENOENT for missing commands', () => {
  const result = runProgram('definitely-not-a-real-command-xyz', ['--x'])
  assert.equal(result.failedToStart, true)
  assert.match(result.stderr, /not found/i)
})
