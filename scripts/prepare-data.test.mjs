import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

// Exercise the CLI in disposable checkouts. The fake DuckDB records invocations and can fail
// before writing, so these tests need neither DuckDB nor the private workbook.
function fixture(t, { source = true, output = true, duckdb = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prepare-data-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['scripts', 'data', 'public/data', 'bin']) mkdirSync(join(root, dir), { recursive: true })
  copyFileSync(new URL('./prepare-data.mjs', import.meta.url), join(root, 'scripts/prepare-data.mjs'))
  writeFileSync(join(root, 'scripts/prepare.sql'), 'SELECT 1;')
  if (source) writeFileSync(join(root, 'data/source.xlsx'), 'workbook v1')
  if (output) writeFileSync(join(root, 'public/data/pax.parquet'), 'committed parquet')
  if (duckdb) {
    writeFileSync(join(root, 'bin/duckdb'), `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const assert = require('node:assert/strict')
assert.deepEqual(process.argv.slice(2), ['-bail', '-c', '.read ./scripts/prepare.sql'])
const count = existsSync('calls') ? Number(readFileSync('calls')) + 1 : 1
writeFileSync('calls', String(count))
if (readFileSync('scripts/prepare.sql', 'utf8').includes('FAIL')) process.exit(1)
writeFileSync('public/data/pax.parquet', 'generated parquet ' + count)
`, { mode: 0o755 })
  }
  return {
    run: (...args) => {
      const result = spawnSync(process.execPath, [join(root, 'scripts/prepare-data.mjs'), ...args], {
        // A different working directory proves paths are resolved from the script.
        cwd: tmpdir(),
        env: { ...process.env, PATH: duckdb ? `${join(root, 'bin')}${delimiter}${process.env.PATH}` : join(root, 'bin') },
        encoding: 'utf8',
      })
      assert.ifError(result.error)
      return result
    },
    path: name => join(root, name),
    read: name => readFileSync(join(root, name), 'utf8'),
    write: (name, content) => writeFileSync(join(root, name), content),
    calls: () => existsSync(join(root, 'calls')) ? Number(readFileSync(join(root, 'calls'))) : 0,
  }
}

test('a checkout without the workbook uses existing data without DuckDB', t => {
  const f = fixture(t, { source: false, duckdb: false })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /freshness cannot be checked/)
  assert.equal(f.read('public/data/pax.parquet'), 'committed parquet')
  assert.equal(existsSync(f.path('data/.prepared.json')), false)
  assert.equal(f.run('--force').status, 1)
})

test('missing workbook and Parquet fails instead of building an empty site', t => {
  const f = fixture(t, { source: false, output: false })
  assert.equal(f.run().status, 1)
  assert.equal(f.calls(), 0)
})

test('first preparation runs once; unchanged contents preserve output and its timestamp', t => {
  const f = fixture(t)
  const first = f.run()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stderr, /Review it and commit it/)
  const before = statSync(f.path('public/data/pax.parquet')).mtimeMs
  utimesSync(f.path('data/source.xlsx'), new Date(), new Date())
  const again = f.run()
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /unchanged/)
  assert.equal(f.calls(), 1)
  assert.equal(statSync(f.path('public/data/pax.parquet')).mtimeMs, before)
})

test('changed workbook, SQL, replaced output and missing output each trigger preparation', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  for (const [name, content] of [
    ['data/source.xlsx', 'workbook v2'],
    ['scripts/prepare.sql', 'SELECT 2;'],
    ['public/data/pax.parquet', 'different checkout data'],
  ]) {
    f.write(name, content)
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stderr.includes(`Changed: ${name}`), result.stderr)
  }
  unlinkSync(f.path('public/data/pax.parquet'))
  assert.equal(f.run().status, 0)
  assert.equal(f.calls(), 5)
})

test('force refresh runs even when current, and a broken cache can be rebuilt', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  assert.equal(f.run('--force').status, 0)
  f.write('data/.prepared.json', '{broken')
  assert.equal(f.run().status, 0)
  assert.equal(f.calls(), 3)
})

test('failed preparation does not update the cache and is retried next time', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  const cache = f.read('data/.prepared.json')
  const output = f.read('public/data/pax.parquet')
  f.write('scripts/prepare.sql', 'FAIL')
  const failure = f.run()
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /dev\/build stopped/)
  assert.equal(f.read('data/.prepared.json'), cache)
  assert.equal(f.read('public/data/pax.parquet'), output)
  assert.equal(f.run().status, 1)
  assert.equal(f.calls(), 3)
})

test('a refresh without DuckDB fails with an actionable error', t => {
  const f = fixture(t, { duckdb: false })
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /DuckDB is required/)
  assert.equal(existsSync(f.path('data/.prepared.json')), false)
  assert.equal(f.read('public/data/pax.parquet'), 'committed parquet')
})
