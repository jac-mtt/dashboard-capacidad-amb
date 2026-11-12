// Refresh the tracked Parquet only when the local workbook or SQL changes.
// The cache lives beside the workbook in the ignored data/ directory; CI has neither.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const sourcePath = 'data/source.xlsx'
const sqlPath = 'scripts/prepare.sql'
const outputPath = 'public/data/pax.parquet'
const cachePath = 'data/.prepared.json'

function readOptional(path) {
  try {
    return readFileSync(new URL(path, root))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function hash(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function readCache() {
  try {
    return JSON.parse(readOptional(cachePath)?.toString() ?? 'null')
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function prepare() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--force')) {
    throw new Error('Usage: pnpm data:prepare [--force]')
  }
  const force = args.includes('--force')
  const source = readOptional(sourcePath)
  const output = readOptional(outputPath)

  if (!source) {
    if (force || !output?.length) {
      throw new Error(`Add ${sourcePath} before preparing data; no workbook is available.`)
    }
    console.warn(`[data] No ${sourcePath}; using existing ${outputPath}. Its freshness cannot be checked.`)
    return
  }

  const current = {
    source: hash(source),
    sql: hash(readFileSync(new URL(sqlPath, root))),
    output: output?.length ? hash(output) : null,
  }
  const previous = readCache()
  if (!force && current.output && Object.keys(current).every(key => current[key] === previous?.[key])) {
    console.log('[data] Workbook and SQL unchanged; using existing Parquet.')
    return
  }

  const changed = [
    ['source', sourcePath],
    ['sql', sqlPath],
    ['output', outputPath],
  ].filter(([key]) => current[key] !== previous?.[key]).map(([, path]) => path)
  const reason = force ? 'Forced refresh' : !previous ? 'First preparation in this checkout' : `Changed: ${changed.join(', ')}`
  console.warn(`[data] ${reason}. Regenerating ${outputPath}…`)
  mkdirSync(new URL('public/data/', root), { recursive: true })
  // Stop at the first SQL error, before the final COPY can overwrite valid data.
  const result = spawnSync('duckdb', ['-bail', '-c', '.read ./scripts/prepare.sql'], {
    cwd: fileURLToPath(root),
    stdio: 'inherit',
  })
  if (result.error?.code === 'ENOENT') {
    throw new Error('DuckDB is required to refresh data. Install/activate it with mise, then retry.')
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error('Data preparation failed; dev/build stopped. Fix the workbook or SQL and retry.')
  }

  const prepared = readOptional(outputPath)
  if (!prepared?.length) throw new Error(`DuckDB did not produce ${outputPath}.`)
  // Do not mark data as current if an input changed while DuckDB was reading it.
  if (hash(readFileSync(new URL(sourcePath, root))) !== current.source
    || hash(readFileSync(new URL(sqlPath, root))) !== current.sql) {
    throw new Error('Workbook or SQL changed during preparation; rerun the command.')
  }
  writeFileSync(new URL(cachePath, root), `${JSON.stringify({ ...current, output: hash(prepared) }, null, 2)}\n`)
  console.warn(`[data] Updated ${outputPath}. Review it and commit it with any SQL changes before publishing.`)
}

try {
  prepare()
} catch (error) {
  console.error(`[data] ${error.message}`)
  process.exitCode = 1
}
