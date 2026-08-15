import { mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'photos-2026.json')
const STATE_FILE = join(OUT_DIR, 'download-state.json')

const YEAR_START = '2026-01-01'
const YEAR_END = '2026-12-31'
const PAGES_PER_TILE = 12
const PAGE_SIZE = 250
const TILE_CONCURRENCY = 4
const PAGE_CONCURRENCY = 3
const SAVE_EVERY_TILES = 5

function loadEnv() {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

function buildTiles() {
  const tiles = []
  const bands = [
    { name: 'EU', minLat: 35, maxLat: 72, minLon: -12, maxLon: 42, stepLat: 5, stepLon: 6 },
    { name: 'NA', minLat: 24, maxLat: 50, minLon: -126, maxLon: -66, stepLat: 5, stepLon: 8 },
    { name: 'CA', minLat: 48, maxLat: 62, minLon: -140, maxLon: -52, stepLat: 6, stepLon: 12 },
    { name: 'MX', minLat: 14, maxLat: 32, minLon: -118, maxLon: -86, stepLat: 6, stepLon: 10 },
    { name: 'SA', minLat: -56, maxLat: 12, minLon: -82, maxLon: -34, stepLat: 8, stepLon: 10 },
    { name: 'JP', minLat: 24, maxLat: 46, minLon: 122, maxLon: 146, stepLat: 5, stepLon: 6 },
    { name: 'CN', minLat: 18, maxLat: 44, minLon: 100, maxLon: 124, stepLat: 6, stepLon: 6 },
    { name: 'SEA', minLat: -10, maxLat: 24, minLon: 95, maxLon: 128, stepLat: 6, stepLon: 8 },
    { name: 'IN', minLat: 6, maxLat: 36, minLon: 68, maxLon: 92, stepLat: 6, stepLon: 8 },
    { name: 'ME', minLat: 12, maxLat: 42, minLon: 24, maxLon: 62, stepLat: 8, stepLon: 10 },
    { name: 'AF', minLat: -35, maxLat: 37, minLon: -18, maxLon: 52, stepLat: 10, stepLon: 12 },
    { name: 'AU', minLat: -44, maxLat: -10, minLon: 112, maxLon: 154, stepLat: 8, stepLon: 10 },
    { name: 'NZ', minLat: -48, maxLat: -33, minLon: 165, maxLon: 179, stepLat: 8, stepLon: 8 },
  ]

  for (const band of bands) {
    for (let lat = band.minLat; lat < band.maxLat; lat += band.stepLat) {
      for (let lon = band.minLon; lon < band.maxLon; lon += band.stepLon) {
        const maxLat = Math.min(lat + band.stepLat, band.maxLat)
        const maxLon = Math.min(lon + band.stepLon, band.maxLon)
        tiles.push({
          id: `${band.name}:${lat}:${lon}`,
          name: `${band.name} ${lat.toFixed(0)},${lon.toFixed(0)}`,
          bbox: `${lon},${lat},${maxLon},${maxLat}`,
        })
      }
    }
  }
  return tiles
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

function toPoint(p) {
  const lat = Number(p.latitude)
  const lon = Number(p.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat === 0 && lon === 0) return null
  return {
    id: p.id,
    lat,
    lon,
    title: p.title || 'Untitled',
    views: Number(p.views) || 0,
    url: p.url_s,
    taken: p.datetaken,
  }
}

async function searchPage(apiKey, params) {
  const qs = new URLSearchParams({
    method: 'flickr.photos.search',
    api_key: apiKey,
    format: 'json',
    nojsoncallback: '1',
    has_geo: '1',
    media: 'photos',
    extras: 'geo,date_taken,url_s,views',
    per_page: String(PAGE_SIZE),
    min_taken_date: YEAR_START,
    max_taken_date: YEAR_END,
    sort: 'date-taken-desc',
    ...params,
  })

  const url = `https://api.flickr.com/services/rest/?${qs}`
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url)
    if (!res.ok) {
      if (attempt === 4) throw new Error(`Flickr HTTP ${res.status}`)
      await sleep(500 * attempt)
      continue
    }
    const data = await res.json()
    if (data.stat !== 'ok') {
      // rate limit / transient
      if (attempt < 4 && (data.code === 105 || data.code === 0)) {
        await sleep(1000 * attempt)
        continue
      }
      throw new Error(data.message ?? 'Flickr error')
    }
    return data
  }
  throw new Error('Flickr request failed')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function loadTile(apiKey, tile) {
  const first = await searchPage(apiKey, { bbox: tile.bbox, page: '1' })
  const points = []
  for (const photo of first.photos?.photo ?? []) {
    const point = toPoint(photo)
    if (point) points.push(point)
  }

  const availablePages = Math.min(first.photos?.pages ?? 1, PAGES_PER_TILE)
  if (availablePages <= 1) return points

  const pageNums = Array.from({ length: availablePages - 1 }, (_, i) => i + 2)
  const pages = await mapPool(pageNums, PAGE_CONCURRENCY, async (page) => {
    try {
      return await searchPage(apiKey, { bbox: tile.bbox, page: String(page) })
    } catch {
      return null
    }
  })

  for (const data of pages) {
    for (const photo of data?.photos?.photo ?? []) {
      const point = toPoint(photo)
      if (point) points.push(point)
    }
  }
  return points
}

async function atomicWrite(path, data) {
  // Unique tmp avoids concurrent-writer races; copyFile overwrites on Windows (rename cannot).
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(tmp, data)
  await copyFile(tmp, path)
  await unlink(tmp).catch(() => {})
}

async function main() {
  const env = loadEnv()
  const apiKey = env.FLICKR_KEY || env.VITE_FLICKR_KEY
  if (!apiKey) {
    console.error('Missing FLICKR_KEY in .env')
    process.exit(1)
  }

  await mkdir(OUT_DIR, { recursive: true })

  const tiles = buildTiles()
  const byId = new Map()
  const completed = new Set()

  // Resume from prior run if present.
  try {
    const prev = JSON.parse(await readFile(OUT_FILE, 'utf8'))
    for (const p of prev.points ?? []) byId.set(p.id, p)
    console.log(`Resumed ${byId.size.toLocaleString()} points from ${OUT_FILE}`)
  } catch {
    // fresh
  }
  try {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    for (const id of state.completedTileIds ?? []) completed.add(id)
    console.log(`Skipping ${completed.size} already-finished tiles`)
  } catch {
    // fresh
  }

  let estimatedTotal = null
  try {
    const probe = await searchPage(apiKey, { per_page: '1', page: '1' })
    estimatedTotal = Number(probe.photos?.total) || null
    if (estimatedTotal) {
      console.log(`Flickr reports ~${estimatedTotal.toLocaleString()} geotagged photos in 2026`)
    }
  } catch (e) {
    console.warn('Could not fetch global total:', e.message)
  }

  const pending = tiles.filter((t) => !completed.has(t.id))
  console.log(`Downloading ${pending.length} / ${tiles.length} tiles → ${OUT_FILE}`)

  let finishedSinceSave = 0
  let done = completed.size
  let saveChain = Promise.resolve()

  function save(force = false) {
    if (!force && finishedSinceSave < SAVE_EVERY_TILES) return saveChain
    finishedSinceSave = 0
    const snapshotCount = byId.size
    const snapshotDone = done
    const payload = {
      year: 2026,
      downloadedAt: new Date().toISOString(),
      estimatedTotal,
      count: snapshotCount,
      points: [...byId.values()],
    }
    const statePayload = {
      completedTileIds: [...completed],
      updatedAt: new Date().toISOString(),
    }

    saveChain = saveChain
      .then(async () => {
        await atomicWrite(OUT_FILE, JSON.stringify(payload))
        await atomicWrite(STATE_FILE, JSON.stringify(statePayload, null, 2))
        console.log(`  saved ${snapshotCount.toLocaleString()} points (${snapshotDone}/${tiles.length} tiles)`)
      })
      .catch((e) => {
        console.warn(`  save failed: ${e.message}`)
      })
    return saveChain
  }

  await mapPool(pending, TILE_CONCURRENCY, async (tile) => {
    try {
      const points = await loadTile(apiKey, tile)
      for (const p of points) byId.set(p.id, p)
    } catch (e) {
      console.warn(`  tile failed ${tile.name}: ${e.message}`)
    }
    completed.add(tile.id)
    done += 1
    finishedSinceSave += 1
    process.stdout.write(
      `\r${done}/${tiles.length} tiles · ${byId.size.toLocaleString()} unique points   `,
    )
    await save(false)
  })

  await save(true)
  console.log(`\nDone. Wrote ${byId.size.toLocaleString()} points to ${OUT_FILE}`)
  console.log('Next: npm run dev  → open the map')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
