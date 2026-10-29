import { cpus, freemem, hostname, platform, release, totalmem, uptime } from 'node:os'
import { join } from 'node:path'

import { launch } from '../../src/index.ts'

const launched = await launch({ title: 'System Info', width: 720, height: 520 })
if (launched.isErr()) {
  console.error(launched.error.message)
  process.exit(1)
}

const app = launched.unwrap()

app.serveFolder(join(import.meta.dirname, 'www'))

await app.exposeFunction('systemInfo', () => ({
  runtime: `Node ${process.version}`,
  host: hostname(),
  os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  memory: `${(totalmem() / 1e9).toFixed(1)} GB total, ${(freemem() / 1e9).toFixed(1)} GB free`,
  uptime: `${Math.round(uptime() / 60)} min`,
}))

app.onExit(() => process.exit(0))

await app.load('index.html')
