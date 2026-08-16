/**
 * Infer each Flickr owner's home country for Flickr-share normalization, then
 * classify every photo using Eric Fischer's city-duration local/tourist rule.
 * Also stamps population cells with country + Flickr-share rates.
 *
 * Run after download: node scripts/prepare-owners.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { countryAt } from './lib/countries.mjs'
import {
  CAPITA_MIN_PHOTOS,
  ebPhotosPerThousand,
  estimateEbParams,
} from './lib/empirical-bayes.mjs'

const root = resolve(import.meta.dirname, '..')
const photosPath = resolve(root, 'public/data/photos-2026.json')
const ratesPath = resolve(root, 'public/data/photo-rates-per-capita-2026.json')
const ownersPath = resolve(root, 'public/data/owner-homes-2026.json')

const MIN_OWNER_PHOTOS = 2
const PLACE_DEGREES = 0.1
const LOCAL_SPAN_DAYS = 30

function placeKey(lat, lon) {
  return `${Math.floor(lat / PLACE_DEGREES)},${Math.floor(lon / PLACE_DEGREES)}`
}

function dayNumber(taken) {
  if (typeof taken !== 'string' || taken.length < 10) return null
  const value = Date.parse(`${taken.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(value) ? Math.floor(value / 86_400_000) : null
}

console.log('Loading photos…')
const dataset = JSON.parse(await readFile(photosPath, 'utf8'))
const points = dataset.points
console.log(`Assigning countries to ${points.length.toLocaleString()} photos…`)

let withCountry = 0
for (let i = 0; i < points.length; i += 1) {
  const point = points[i]
  const country = countryAt(point.lat, point.lon)
  point.country = country
  if (country) withCountry += 1
  if ((i + 1) % 50_000 === 0) {
    console.log(`  ${((i + 1) / points.length * 100).toFixed(0)}%`)
  }
}
console.log(`Countries resolved for ${withCountry.toLocaleString()} photos`)

/** @type {Map<string, Map<string, Set<string>>>} */
const ownerCountryMonths = new Map()
/** @type {Map<string, number>} */
const ownerPhotoCount = new Map()
/** @type {Map<string, Map<string, number>>} */
const ownerCountryPhotos = new Map()

for (const point of points) {
  if (!point.owner || !point.country) continue
  ownerPhotoCount.set(
    point.owner,
    (ownerPhotoCount.get(point.owner) ?? 0) + 1,
  )
  let byCountry = ownerCountryMonths.get(point.owner)
  if (!byCountry) {
    byCountry = new Map()
    ownerCountryMonths.set(point.owner, byCountry)
  }
  let months = byCountry.get(point.country)
  if (!months) {
    months = new Set()
    byCountry.set(point.country, months)
  }
  const taken = typeof point.taken === 'string' ? point.taken.slice(0, 7) : ''
  if (taken.length === 7) months.add(taken)
  else months.add('unknown')

  let photoByCountry = ownerCountryPhotos.get(point.owner)
  if (!photoByCountry) {
    photoByCountry = new Map()
    ownerCountryPhotos.set(point.owner, photoByCountry)
  }
  photoByCountry.set(
    point.country,
    (photoByCountry.get(point.country) ?? 0) + 1,
  )
}

/** @type {Record<string, { home: string, months: number, photos: number }>} */
const ownerHomes = {}
/** @type {Record<string, number>} */
const flickrUsersByCountry = {}

for (const [owner, byCountry] of ownerCountryMonths) {
  const photos = ownerPhotoCount.get(owner) ?? 0
  if (photos < MIN_OWNER_PHOTOS) continue

  let bestCountry = null
  let bestMonths = -1
  let bestPhotos = -1
  const photoByCountry = ownerCountryPhotos.get(owner) ?? new Map()
  for (const [country, months] of byCountry) {
    const monthCount = months.size
    const photoInCountry = photoByCountry.get(country) ?? 0
    if (
      monthCount > bestMonths ||
      (monthCount === bestMonths && photoInCountry > bestPhotos)
    ) {
      bestMonths = monthCount
      bestPhotos = photoInCountry
      bestCountry = country
    }
  }
  if (!bestCountry) continue
  ownerHomes[owner] = {
    home: bestCountry,
    months: bestMonths,
    photos,
  }
  flickrUsersByCountry[bestCountry] =
    (flickrUsersByCountry[bestCountry] ?? 0) + 1
}

console.log(
  `Inferred country homes for ${Object.keys(ownerHomes).length.toLocaleString()} owners ` +
    `(≥${MIN_OWNER_PHOTOS} geotagged photos)`,
)

// Fischer's method: an owner is local to a place if their photos in that
// place span at least one month. A shorter visit is tourist only if that owner
// has a confirmed local place elsewhere; all remaining photos stay unknown.
/** @type {Map<string, Map<string, { first: number, last: number, count: number }>>} */
const ownerPlaces = new Map()
for (const point of points) {
  if (!point.owner) continue
  const day = dayNumber(point.taken)
  if (day === null) continue
  const key = placeKey(point.lat, point.lon)
  let places = ownerPlaces.get(point.owner)
  if (!places) {
    places = new Map()
    ownerPlaces.set(point.owner, places)
  }
  const current = places.get(key)
  if (current) {
    current.first = Math.min(current.first, day)
    current.last = Math.max(current.last, day)
    current.count += 1
  } else {
    places.set(key, { first: day, last: day, count: 1 })
  }
}

/** @type {Map<string, Set<string>>} */
const ownerLocalPlaces = new Map()
/** @type {Record<string, { home: string, months: number, photos: number, localPlaces: number }>} */
const ownerClassifications = {}
for (const [owner, places] of ownerPlaces) {
  const localPlaces = new Set(
    [...places.entries()]
      .filter(([, place]) => place.last - place.first >= LOCAL_SPAN_DAYS)
      .map(([key]) => key),
  )
  if (localPlaces.size > 0) ownerLocalPlaces.set(owner, localPlaces)
  const countryHome = ownerHomes[owner]
  if (countryHome) {
    ownerClassifications[owner] = {
      ...countryHome,
      localPlaces: localPlaces.size,
    }
  }
}

let local = 0
let tourist = 0
let unknown = 0
for (const point of points) {
  const home = point.owner ? ownerHomes[point.owner]?.home : undefined
  point.home = home
  const key = placeKey(point.lat, point.lon)
  const localPlaces = point.owner ? ownerLocalPlaces.get(point.owner) : undefined
  if (localPlaces?.has(key)) {
    point.role = 'local'
    local += 1
  } else if (localPlaces && localPlaces.size > 0) {
    point.role = 'tourist'
    tourist += 1
  } else {
    point.role = 'unknown'
    unknown += 1
  }
}

dataset.points = points
dataset.count = points.length
dataset.ownerHomesAt = new Date().toISOString()
dataset.roleCounts = { local, tourist, unknown }
dataset.roleMethod =
  'Eric Fischer-inspired: local when owner photos in a 0.1° place cell span ≥30 days; tourist when owner has another local place; otherwise unknown'
await writeFile(photosPath, JSON.stringify(dataset))
console.log(
  `Wrote roles → local ${local.toLocaleString()}, tourist ${tourist.toLocaleString()}, unknown ${unknown.toLocaleString()}`,
)

const ownersPayload = {
  countryHomeMethod:
    'Country home = country with most unique YYYY-MM months among owner geotags in this dataset (≥2 photos)',
  localTouristMethod:
    'Eric Fischer-inspired: local when owner photos in a 0.1° place cell span ≥30 days; tourist when owner has another local place; otherwise unknown',
  inferredAt: new Date().toISOString(),
  minOwnerPhotos: MIN_OWNER_PHOTOS,
  placeDegrees: PLACE_DEGREES,
  localSpanDays: LOCAL_SPAN_DAYS,
  ownerCount: Object.keys(ownerHomes).length,
  flickrUsersByCountry,
  owners: ownerClassifications,
}
await writeFile(ownersPath, JSON.stringify(ownersPayload))
console.log(`Wrote ${ownersPath}`)

// Stamp population grid with country + Flickr-share rates when rates exist.
try {
  const rates = JSON.parse(await readFile(ratesPath, 'utf8'))
  const floor = rates.populationFloor ?? 1_000
  console.log(`Updating ${rates.cells.length.toLocaleString()} population cells…`)

  const photoCounts = new Map()
  const touristCounts = new Map()
  const localCounts = new Map()
  const cellDegrees = rates.cellDegrees ?? 0.25
  const gridKey = (lat, lon) =>
    `${Math.floor((lat + 90) / cellDegrees)},${Math.floor((lon + 180) / cellDegrees)}`

  for (const point of points) {
    const key = gridKey(point.lat, point.lon)
    photoCounts.set(key, (photoCounts.get(key) ?? 0) + 1)
    if (point.role === 'tourist') {
      touristCounts.set(key, (touristCounts.get(key) ?? 0) + 1)
    } else if (point.role === 'local') {
      localCounts.set(key, (localCounts.get(key) ?? 0) + 1)
    }
  }

  const stamped = rates.cells.map((cell) => {
    const key = gridKey(cell.lat, cell.lon)
    const country = countryAt(cell.lat, cell.lon)
    const photos = photoCounts.get(key) ?? cell.photos ?? 0
    const flickrUsers = country
      ? Math.max(flickrUsersByCountry[country] ?? 0, 1)
      : 1
    return {
      ...cell,
      photos,
      country,
      touristPhotos: touristCounts.get(key) ?? 0,
      localPhotos: localCounts.get(key) ?? 0,
      flickrUsers,
      photosPerFlickrUser: photos > 0 ? photos / flickrUsers : 0,
    }
  })

  const ebFlickr = estimateEbParams(
    stamped
      .filter((c) => c.photos > 0)
      .map((c) => ({
        photos: c.photos,
        population: c.flickrUsers,
      })),
    1,
  )

  const cells = stamped.map((cell) => ({
    ...cell,
    photosPerFlickrUser:
      cell.photos >= CAPITA_MIN_PHOTOS
        ? Number(
            ebPhotosPerThousand(
              cell.photos,
              cell.flickrUsers,
              ebFlickr,
              1,
            ).toFixed(4),
          ) / 1000
        : 0,
  }))

  // Reuse Capita EB on resident population with refreshed photo counts.
  const ebPop = estimateEbParams(cells, floor)
  for (const cell of cells) {
    cell.photosPerThousand =
      cell.photos >= CAPITA_MIN_PHOTOS
        ? Number(
            ebPhotosPerThousand(
              cell.photos,
              cell.population,
              ebPop,
              floor,
            ).toFixed(4),
          )
        : 0
  }

  const output = {
    ...rates,
    ebMean: ebPop.mean,
    ebStrength: ebPop.strength,
    flickrEbMean: ebFlickr.mean,
    flickrEbStrength: ebFlickr.strength,
    minPhotos: CAPITA_MIN_PHOTOS,
    rateMethod: 'empirical-bayes-gamma-poisson',
    flickrUsersByCountry,
    photosDatasetDownloadedAt: dataset.downloadedAt,
    ownerHomesAt: dataset.ownerHomesAt,
    cells,
  }
  await writeFile(ratesPath, JSON.stringify(output))
  console.log(`Updated ${ratesPath}`)
} catch (error) {
  console.warn(
    'Population rates not updated:',
    error instanceof Error ? error.message : error,
  )
}

console.log('Done. Restart the map to load local / tourist / Flickr-share metrics.')
