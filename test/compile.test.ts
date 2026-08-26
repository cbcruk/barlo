/**
 * barlo's headline advantage over Carlo is a single-file executable, so the
 * compiled path is worth testing rather than assuming.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')

test('a compiled binary serves embedded assets and answers exposed calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'barlo-compile-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><h1 id="t">compiled</h1>')
  writeFileSync(
    join(dir, 'app.ts'),
    `import index from './index.html' with { type: 'text' }
     import { launch } from ${JSON.stringify(join(REPO, 'src/index.ts'))}
     const app = await launch({ width: 480, height: 360 })
     app.serveEmbedded({ 'index.html': index })
     await app.exposeFunction('mul', (a, b) => a * b)
     await app.load('index.html')
     console.log(JSON.stringify({
       text: await app.evaluate('document.getElementById("t").textContent'),
       rpc: await app.evaluate('mul(6, 7)'),
       chromeless: await app.evaluate('outerHeight - innerHeight') < 30,
     }))
     app.exit()
     process.exit(0)`,
  )

  const build = Bun.spawnSync([process.execPath, 'build', '--compile', join(dir, 'app.ts'),
    '--outfile', join(dir, 'app-bin')])
  expect(build.exitCode, build.stderr.toString()).toBe(0)

  // Run somewhere the source tree is not reachable, so nothing can fall back to disk.
  const run = Bun.spawnSync([join(dir, 'app-bin')], { cwd: tmpdir(), env: process.env })
  const stdout = run.stdout.toString()
  const line = stdout.split('\n').find(l => l.startsWith('{'))
  expect(line, `stdout: ${stdout}\nstderr: ${run.stderr.toString()}`).toBeTruthy()

  expect(JSON.parse(line!)).toEqual({ text: 'compiled', rpc: 42, chromeless: true })
}, 180_000)
