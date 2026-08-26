import { cpus, freemem, hostname, platform, release, totalmem, uptime } from 'node:os'

import { launch } from '../../src/index'

// Imported as text so the example works the same under `bun run` and
// `bun build --compile`, where there is no www folder on disk. Bun types every
// .html import as an HTMLBundle for its bundler, so the text form needs a cast.
import indexHtmlBundle from './www/index.html' with { type: 'text' }

const indexHtml = indexHtmlBundle as unknown as string

const app = await launch({ title: 'System Info', width: 720, height: 520 })

app.serveEmbedded({ 'index.html': indexHtml })

await app.exposeFunction('systemInfo', () => ({
  runtime: `Bun ${Bun.version}`,
  host: hostname(),
  os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  memory: `${(totalmem() / 1e9).toFixed(1)} GB total, ${(freemem() / 1e9).toFixed(1)} GB free`,
  uptime: `${Math.round(uptime() / 60)} min`,
}))

app.onExit(() => process.exit(0))

await app.load('index.html')
