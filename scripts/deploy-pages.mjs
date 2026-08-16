/**
 * Build and publish to the gh-pages branch.
 * photos-2026.json is >100 MB, so we ship a gzip copy and omit the raw JSON.
 */
import { createReadStream, createWriteStream, existsSync, unlinkSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const distData = join(root, 'dist', 'data')
const raw = join(distData, 'photos-2026.json')
const gz = join(distData, 'photos-2026.json.gz')

execSync('npm run build', { stdio: 'inherit', cwd: root })

if (!existsSync(raw)) {
  console.error('Missing dist/data/photos-2026.json after build')
  process.exit(1)
}

await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(gz))
unlinkSync(raw)
console.log('Packed photos-2026.json.gz for GitHub Pages')

execSync('npx gh-pages -d dist -m "Deploy photo map to GitHub Pages"', {
  stdio: 'inherit',
  cwd: root,
})
