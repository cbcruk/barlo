/**
 * Lints exported symbols for missing JSDoc and type-checks every `@example`
 * block.
 *
 * The rules in `.claude/rules/jsdoc.md` ask for documentation on every exported
 * symbol and for examples that run when pasted. Both are easy to let rot, so
 * they are checked rather than trusted. Run with `bun run docs:check`.
 *
 * @module
 */

import { Glob } from 'bun'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/** Top-level `export` forms that need their own JSDoc block. */
const EXPORT = /^export (async function|function|class|interface|type|const|default)\b/

/** Class and interface members, which need documenting too. */
const MEMBER = /^  (?!#|\/|\*|\})(?:readonly |static |async |get |set )*[A-Za-z_$][\w$]*\s*[(<:=]/

const missing: string[] = []
const examples: { file: string; code: string }[] = []

for (const rel of [...new Glob('src/**/*.ts').scanSync(ROOT)].sort()) {
  const text = await Bun.file(join(ROOT, rel)).text()
  const lines = text.split('\n')

  let inType = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^export (class|interface)/.test(line)) inType = true
    if (line === '}') inType = false

    if (line.startsWith('export default')) continue
    if (!EXPORT.test(line) && !(inType && MEMBER.test(line))) continue

    let j = i - 1
    while (j >= 0 && lines[j]!.trim() === '') j--
    if (j < 0 || !lines[j]!.trim().endsWith('*/')) {
      missing.push(`${rel}:${i + 1}  ${line.trim().slice(0, 72)}`)
    }
  }

  for (const match of text.matchAll(/\*\s*```ts\n([\s\S]*?)\*\s*```/g)) {
    const code = match[1]!
      .split('\n')
      .map(l => l.replace(/^\s*\*\s?/, ''))
      .join('\n')
    examples.push({ file: rel, code })
  }
}

console.log(`exported symbols missing JSDoc: ${missing.length}`)
for (const entry of missing) console.log(`  ${entry}`)

// Type-check each example as its own module, from inside the repo so that
// `barlo` and `bun-types` resolve the way they do for a user.
const dir = mkdtempSync(join(ROOT, 'node_modules', '.doccheck-'))
try {
  examples.forEach((example, n) => {
    writeFileSync(join(dir, `ex${n}_${example.file.replace(/\W/g, '_')}.ts`), example.code)
  })
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['ESNext', 'DOM'],
        target: 'ESNext',
        module: 'Preserve',
        moduleResolution: 'bundler',
        types: ['bun-types'],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        paths: { barlo: ['../../src/index.ts'] },
      },
      include: ['*.ts'],
    }),
  )

  const tsc = Bun.spawnSync(['bunx', 'tsc', '--noEmit', '-p', dir], { cwd: ROOT })
  const output = (tsc.stdout.toString() + tsc.stderr.toString()).trim()

  console.log(`example blocks type-checked: ${examples.length}`)
  console.log(output || 'all example blocks OK')

  process.exit(missing.length === 0 && !output ? 0 : 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
