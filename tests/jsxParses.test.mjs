import { describe, it } from 'node:test'
import glob from 'glob'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import assert from 'node:assert'

const projectRoot = resolve(import.meta.dirname, '..')

const jsxFiles = glob.sync('src/**/*.jsx', { cwd: projectRoot })
const jsFiles = glob.sync('src/**/*.js', { cwd: projectRoot })
const allFiles = [...jsxFiles, ...jsFiles]

function parseWithEsbuild(file) {
  const result = spawnSync('npx', ['esbuild', file, '--outfile=/dev/null'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30000,
  })
  return {
    file,
    ok: result.status === 0,
    stdout: result.stdout?.trim(),
    stderr: result.stderr?.trim(),
  }
}

describe('esbuild JSX/JS parse check', () => {
  for (const file of allFiles) {
    it(`parses: ${file}`, () => {
      const result = parseWithEsbuild(file)
      if (!result.ok) {
        console.error(`\nESBuild failed for ${file}:`)
        console.error(result.stderr)
      }
      assert.ok(result.ok, `esbuild parse failed for ${file}: ${result.stderr}`)
    })
  }
})