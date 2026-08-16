/**
 * Recompute Capita rates in photo-rates-per-capita-2026.json with Empirical
 * Bayes shrinkage — no GHSL re-download required. Also retallies photo counts
 * from the current photos-2026.json so Null Island cleanup is reflected.
 *
 * Run: node scripts/recompute-capita-rates.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  CAPITA_MIN_PHOTOS,
  ebPhotosPerThousand,
  estimateEbParams,
} from './lib/empirical-bayes.mjs'

const root = resolve(import.meta.dirname, '..')
const ratesPath = resolve(root, 'public/data/photo-rates-per-capita-2026.json')
const photosPath = resolve(root, 'public/data/photos-2026.json')

const dataset = JSON.parse(await readFile(ratesPath, 'utf8'))
const photos = JSON.parse(await readFile(photosPath, 'utf8'))
const cellDegrees = dataset.cellDegrees ?? 0.25
const floor = dataset.populationFloor ?? 1_000
const minPhotos = CAPITA_MIN_PHOTOS

function gridKey(lat, lon) {
  return `${Math.floor((lat + 90) / cellDegrees)},${Math.floor(
    (lon + 180) / cellDegrees,
  )}`
}

const photoCounts = new Map()
for (const point of photos.points) {
  const key = gridKey(point.lat, point.lon)
  photoCounts.set(key, (photoCounts.get(key) ?? 0) + 1)
}

const retallied = dataset.cells.map((cell) => {
  const key = gridKey(cell.lat, cell.lon)
  return {
    ...cell,
    photos: photoCounts.get(key) ?? 0,
  }
})

const eb = estimateEbParams(retallied, floor)
let eligible = 0
const cells = retallied.map((cell) => {
  const photosPerThousand =
    cell.photos >= minPhotos
      ? Number(
          ebPhotosPerThousand(
            cell.photos,
            cell.population,
            eb,
            floor,
          ).toFixed(4),
        )
      : 0
  if (cell.photos >= minPhotos) eligible += 1
  return { ...cell, photosPerThousand }
})

const output = {
  ...dataset,
  ebMean: eb.mean,
  ebStrength: eb.strength,
  minPhotos,
  rateMethod: 'empirical-bayes-gamma-poisson',
  photosDatasetDownloadedAt: photos.downloadedAt ?? dataset.photosDatasetDownloadedAt,
  cells,
}

await writeFile(ratesPath, JSON.stringify(output))
console.log(
  `Updated Capita rates: μ=${eb.mean.toExponential(3)} photos/resident, ` +
    `C=${eb.strength.toFixed(1)} residents, ` +
    `${eligible.toLocaleString()} cells with ≥${minPhotos} photos`,
)
