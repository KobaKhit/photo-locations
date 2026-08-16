import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fromUrl } from 'geotiff'
import {
  CAPITA_MIN_PHOTOS,
  ebPhotosPerThousand,
  estimateEbParams,
} from './lib/empirical-bayes.mjs'

const root = resolve(import.meta.dirname, '..')
const photosPath = resolve(root, 'public/data/photos-2026.json')
const outputPath = resolve(root, 'public/data/photo-rates-per-capita-2026.json')

// GHSL GHS-POP R2023A: 2020 resident population, 3 arc-second global grid.
// The source COG's overview level 7 is ~0.1° and uses an average resample;
// each overview pixel represents 128 × 128 source pixels, so values are
// multiplied by 128² to recover population counts before aggregation.
const GHS_POP_COG =
  'https://s3-west.nrp-nautilus.io/public-population/raw/ghs-pop-2020-cog.tif'
const OVERVIEW_LEVEL = 7
const OVERVIEW_SCALE = 2 ** (OVERVIEW_LEVEL * 2)
const CELL_DEGREES = 0.25
const POPULATION_FLOOR = 1_000

function gridKey(lat, lon) {
  return `${Math.floor((lat + 90) / CELL_DEGREES)},${Math.floor(
    (lon + 180) / CELL_DEGREES,
  )}`
}

function gridCellFromKey(key) {
  const [row, col] = key.split(',').map(Number)
  return {
    lat: -90 + (row + 0.5) * CELL_DEGREES,
    lon: -180 + (col + 0.5) * CELL_DEGREES,
  }
}

console.log('Reading Flickr points…')
const dataset = JSON.parse(await readFile(photosPath, 'utf8'))
const photoCounts = new Map()

for (const point of dataset.points) {
  const key = gridKey(point.lat, point.lon)
  photoCounts.set(key, (photoCounts.get(key) ?? 0) + 1)
}

console.log(
  `Photo cells: ${photoCounts.size.toLocaleString()}. Reading GHSL overview…`,
)
const tiff = await fromUrl(GHS_POP_COG)
const baseImage = await tiff.getImage(0)
const image = await tiff.getImage(OVERVIEW_LEVEL)
const [minLon, minLat, maxLon, maxLat] = baseImage.getBoundingBox()
const values = (await image.readRasters())[0]
const width = image.getWidth()
const height = image.getHeight()
const populations = new Map()

// Aggregate every inhabited overview pixel into the 0.25° world grid —
// not only cells that already have Flickr photos — so World pop can render
// the full planet.
for (let y = 0; y < height; y += 1) {
  const lat = maxLat - ((y + 0.5) / height) * (maxLat - minLat)
  for (let x = 0; x < width; x += 1) {
    const value = values[y * width + x]
    if (!Number.isFinite(value) || value <= 0) continue
    const lon = minLon + ((x + 0.5) / width) * (maxLon - minLon)
    const key = gridKey(lat, lon)
    populations.set(key, (populations.get(key) ?? 0) + value * OVERVIEW_SCALE)
  }
}

console.log(
  `Inhabited population cells: ${populations.size.toLocaleString()}. Writing…`,
)

const baseCells = [...populations.entries()].map(([key, rawPopulation]) => {
  const photos = photoCounts.get(key) ?? 0
  const population = Math.round(rawPopulation)
  const { lat, lon } = gridCellFromKey(key)
  return {
    lat: Number(lat.toFixed(3)),
    lon: Number(lon.toFixed(3)),
    photos,
    population,
  }
})

const eb = estimateEbParams(baseCells, POPULATION_FLOOR)
const cells = baseCells
  .map((cell) => ({
    ...cell,
    photosPerThousand:
      cell.photos >= CAPITA_MIN_PHOTOS
        ? Number(
            ebPhotosPerThousand(
              cell.photos,
              cell.population,
              eb,
              POPULATION_FLOOR,
            ).toFixed(4),
          )
        : 0,
  }))
  .filter((cell) => cell.population > 0)

const output = {
  source:
    'GHSL GHS-POP R2023A (European Commission JRC), resident population 2020',
  sourceUrl: 'https://human-settlement.emergency.copernicus.eu/',
  populationYear: 2020,
  cellDegrees: CELL_DEGREES,
  populationFloor: POPULATION_FLOOR,
  ebMean: eb.mean,
  ebStrength: eb.strength,
  minPhotos: CAPITA_MIN_PHOTOS,
  rateMethod: 'empirical-bayes-gamma-poisson',
  photosDatasetDownloadedAt: dataset.downloadedAt,
  cells,
}

await writeFile(outputPath, JSON.stringify(output))
const withPhotos = cells.filter((cell) => cell.photos > 0).length
const withCapita = cells.filter(
  (cell) => cell.photos >= CAPITA_MIN_PHOTOS,
).length
console.log(
  `Wrote ${cells.length.toLocaleString()} inhabited cells ` +
    `(${withPhotos.toLocaleString()} with photos, ` +
    `${withCapita.toLocaleString()} Capita-eligible) to ${outputPath}`,
)
console.log(
  `EB params: μ=${eb.mean.toExponential(3)} photos/resident, ` +
    `C=${eb.strength.toFixed(1)} residents`,
)
