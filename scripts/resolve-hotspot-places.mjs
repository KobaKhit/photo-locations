/**
 * Offline reverse-geocode for hottest / per-capita cluster centroids.
 * Uses Nominatim (1 req/sec). Run: node scripts/resolve-hotspot-places.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPITA_MIN_PHOTOS,
  ebPhotosPerThousand,
  estimateEbParams,
} from './lib/empirical-bayes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const photos = JSON.parse(
  readFileSync(join(root, 'public/data/photos-2026.json'), 'utf8'),
).points
const rates = JSON.parse(
  readFileSync(join(root, 'public/data/photo-rates-per-capita-2026.json'), 'utf8'),
)

const CELL_DEG = 1.5
const LIMIT = 12
const MIN_SEP = 12
const FLOOR = rates.populationFloor ?? 1_000
const MIN_PHOTOS = rates.minPhotos ?? CAPITA_MIN_PHOTOS
const EB =
  rates.ebMean !== undefined && rates.ebStrength !== undefined
    ? { mean: rates.ebMean, strength: rates.ebStrength }
    : estimateEbParams(rates.cells, FLOOR)
const OUT = join(root, 'public/data/hotspot-places-2026.json')

function keyFor(lat, lon) {
  return `${Math.floor(lat / CELL_DEG)},${Math.floor(lon / CELL_DEG)}`
}

function labelKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`
}

function pickSpread(ranked, limit = LIMIT) {
  const picked = []
  for (const candidate of ranked) {
    const tooClose = picked.some(
      (item) =>
        Math.hypot(item.lat - candidate.lat, item.lon - candidate.lon) < MIN_SEP,
    )
    if (!tooClose) picked.push(candidate)
    if (picked.length >= limit) break
  }
  return picked
}

function findRawHotspots() {
  const cells = new Map()
  for (const point of photos) {
    const key = keyFor(point.lat, point.lon)
    const existing = cells.get(key)
    if (!existing) {
      cells.set(key, { latSum: point.lat, lonSum: point.lon, count: 1 })
    } else {
      existing.latSum += point.lat
      existing.lonSum += point.lon
      existing.count += 1
    }
  }
  return pickSpread(
    [...cells.values()]
      .map((cell) => ({
        lat: cell.latSum / cell.count,
        lon: cell.lonSum / cell.count,
        count: cell.count,
      }))
      .sort((a, b) => b.count - a.count),
  )
}

function findPerCapitaHotspotsRanked() {
  const cells = new Map()
  for (const cell of rates.cells) {
    const key = keyFor(cell.lat, cell.lon)
    const existing = cells.get(key)
    if (existing) existing.population += cell.population
    else {
      cells.set(key, {
        latSum: 0,
        lonSum: 0,
        count: 0,
        population: cell.population,
      })
    }
  }
  for (const point of photos) {
    const existing = cells.get(keyFor(point.lat, point.lon))
    if (!existing) continue
    existing.latSum += point.lat
    existing.lonSum += point.lon
    existing.count += 1
  }
  return pickSpread(
    [...cells.values()]
      .filter((cell) => cell.count >= MIN_PHOTOS)
      .map((cell) => ({
        lat: cell.latSum / cell.count,
        lon: cell.lonSum / cell.count,
        count: cell.count,
        rate: ebPhotosPerThousand(cell.count, cell.population, EB, FLOOR),
      }))
      .sort((a, b) => b.rate - a.rate),
  )
}

async function reverse(lat, lon) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  url.searchParams.set('zoom', '8')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('accept-language', 'en')
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'photo-locations/1.0 (https://github.com/KobaKhit/photo-locations)',
      'Accept-Language': 'en',
    },
  })
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`)
  const data = await res.json()
  const address = data.address ?? {}
  const local =
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    address.municipality ||
    address.county ||
    address.state_district ||
    data.name
  const region = address.state || address.region || address.province
  const country = address.country
  const parts = [local, region, country]
    .filter(Boolean)
    .filter((part, index, arr) => arr.indexOf(part) === index)
  return (
    parts.slice(0, 2).join(', ') ||
    data.display_name?.split(',').slice(0, 2).join(',').trim() ||
    null
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const centroids = [
  ...findRawHotspots(),
  ...findPerCapitaHotspotsRanked(),
]
const labels = {}
for (const spot of centroids) {
  const key = labelKey(spot.lat, spot.lon)
  if (key in labels) continue
  process.stdout.write(`resolving ${key} ... `)
  try {
    labels[key] = await reverse(spot.lat, spot.lon)
    console.log(labels[key])
  } catch (error) {
    labels[key] = null
    console.log('FAIL', error instanceof Error ? error.message : error)
  }
  await sleep(1_100)
}

writeFileSync(
  OUT,
  JSON.stringify({ source: 'Nominatim', language: 'en', labels }, null, 2) +
    '\n',
)
console.log(`wrote ${OUT} (${Object.keys(labels).length} labels)`)
