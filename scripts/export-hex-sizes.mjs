/**
 * Headless batch export: Equal Earth hex photo-count at several hex sizes.
 * Usage: npm run build && node scripts/export-hex-sizes.mjs
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { preview } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'exports')
const sizes = [0.4, 0.5, 0.6]
const previewPort = 4188
const sinkPort = 4190

mkdirSync(outDir, { recursive: true })

const saved = []
const sinkServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end()
    return
  }
  const url = new URL(req.url || '/', `http://127.0.0.1:${sinkPort}`)
  const filename = url.searchParams.get('name')
  if (!filename) {
    res.writeHead(400)
    res.end('missing name')
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const target = join(outDir, filename)
  writeFileSync(target, Buffer.concat(chunks))
  saved.push(target)
  console.log('saved', target)
  res.writeHead(200)
  res.end('ok')
})
await new Promise((resolve) => sinkServer.listen(sinkPort, '127.0.0.1', resolve))

const server = await preview({
  root,
  base: '/photo-locations/',
  preview: { port: previewPort, strictPort: true },
})
const baseUrl =
  server.resolvedUrls?.local?.[0] ??
  `http://127.0.0.1:${previewPort}/photo-locations/`
const pageUrl = `${baseUrl.replace(/\/?$/, '/')}?batchHex=${sizes.join(',')}`
console.log('Preview at', pageUrl)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('page:', msg.text())
})
page.on('pageerror', (err) => console.error('pageerror:', err.message))

await page.addInitScript((port) => {
  window.__hexExportSink = async (blob, filename) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/save?name=${encodeURIComponent(filename)}`,
      { method: 'POST', body: blob },
    )
    if (!res.ok) throw new Error(`sink failed: ${res.status}`)
  }
}, sinkPort)

await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
console.log('Waiting for dataset + export button…')
await page.waitForSelector('.export-button:not([disabled])', {
  timeout: 180_000,
})
console.log('App ready')

await page.getByRole('button', { name: 'Hex', exact: true }).click()
await page.getByRole('button', { name: 'Photos', exact: true }).click()
await page.getByRole('button', { name: 'Equal Earth', exact: true }).click()

for (const label of ['Hottest', 'Per capita', 'Most viewed']) {
  const chip = page.getByRole('button', { name: label, exact: true })
  if (
    (await chip.count()) > 0 &&
    (await chip.getAttribute('aria-pressed')) === 'true'
  ) {
    await chip.click()
  }
}

console.log(`Exporting ${sizes.length} sizes…`)
await page.getByRole('button', { name: /Export 8K/ }).click()
await page.waitForFunction(
  (expected) =>
    document.body.dataset.hexExportsDone === String(expected),
  sizes.length,
  { timeout: 900_000 },
).catch(async () => {
  // Fallback: wait until export button leaves the rendering state and files exist.
  await page.waitForFunction(
    () => {
      const button = document.querySelector('.export-button')
      return (
        button &&
        !button.disabled &&
        !/Rendering/.test(button.textContent || '')
      )
    },
    { timeout: 900_000 },
  )
})

await browser.close()
await server.close()
sinkServer.close()

if (saved.length < sizes.length) {
  console.warn(`Expected ${sizes.length} files, got ${saved.length}`)
  process.exitCode = 1
} else {
  console.log('Done. Files in', outDir)
}
