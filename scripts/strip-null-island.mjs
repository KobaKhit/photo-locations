/**
 * Audit / strip Null Island and near-zero placeholder geotags from the
 * published Flickr dataset (no re-crawl required).
 *
 * Run: node scripts/strip-null-island.mjs
 * Dry run: node scripts/strip-null-island.mjs --dry-run
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const photosPath = resolve(root, 'public/data/photos-2026.json')
const RADIUS_DEG = 0.05
const dryRun = process.argv.includes('--dry-run')

const dataset = JSON.parse(await readFile(photosPath, 'utf8'))
const before = dataset.points.length
const kept = []
let removed = 0

for (const point of dataset.points) {
  if (Math.hypot(point.lat, point.lon) < RADIUS_DEG) {
    removed += 1
    continue
  }
  kept.push(point)
}

console.log(
  `Null Island audit: ${removed.toLocaleString()} of ${before.toLocaleString()} ` +
    `points within ${RADIUS_DEG}° of (0,0)`,
)

if (dryRun) {
  console.log('Dry run — dataset not modified.')
  process.exit(0)
}

if (removed === 0) {
  console.log('Nothing to strip.')
  process.exit(0)
}

dataset.points = kept
dataset.count = kept.length
await writeFile(photosPath, JSON.stringify(dataset))
console.log(`Wrote ${kept.length.toLocaleString()} points to ${photosPath}`)
