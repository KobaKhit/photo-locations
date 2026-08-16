import {
  CAPITA_MIN_PHOTOS,
  ebPhotosPerThousand,
  estimateEbParams,
  type EbParams,
} from './rates'

export type PhotoPoint = {
  id: string
  lat: number
  lon: number
  title: string
  views: number
  url?: string
  taken?: string
  /** Flickr NSID when present. */
  owner?: string
  /** Photo location country (Natural Earth name). */
  country?: string | null
  /** Inferred owner home country. */
  home?: string
  /** local = photo country matches home; tourist otherwise. */
  role?: 'local' | 'tourist' | 'unknown'
}

export type Hotspot = {
  lat: number
  lon: number
  count: number
  /** Distinct Flickr owners in the cluster (when available). */
  photographers?: number
  /** Present for population-normalized hotspot rankings. */
  photosPerThousand?: number
  sample: PhotoPoint
  color: string
  /** City / region label from reverse geocoding */
  placeName: string
}

export type PhotoDataset = {
  year: number
  downloadedAt: string
  estimatedTotal: number | null
  count: number
  points: PhotoPoint[]
  takenThrough?: string
  roleCounts?: {
    local: number
    tourist: number
    unknown: number
  }
  roleMethod?: string
  ownerHomesAt?: string
}

export type PopulationRateCell = {
  lat: number
  lon: number
  photos: number
  population: number
  photosPerThousand: number
  country?: string | null
  touristPhotos?: number
  localPhotos?: number
  flickrUsers?: number
  /** EB-shrunk photos per national Flickr home-user. */
  photosPerFlickrUser?: number
}

export type PopulationRateDataset = {
  source: string
  sourceUrl: string
  populationYear: number
  cellDegrees: number
  populationFloor: number
  /** Empirical Bayes global mean (photos per resident). */
  ebMean?: number
  /** Empirical Bayes prior strength C (in residents). */
  ebStrength?: number
  flickrEbMean?: number
  flickrEbStrength?: number
  flickrUsersByCountry?: Record<string, number>
  /** Minimum photos required for Capita display / ranking. */
  minPhotos?: number
  cells: PopulationRateCell[]
}

const PIN_COLORS = [
  // Okabe–Ito (colorblind-safe categorical markers)
  '#E69F00',
  '#56B4E9',
  '#009E73',
  '#F0E442',
  '#0072B2',
  '#D55E00',
  '#CC79A7',
  '#999999',
]

// Resolve against Vite's base so project-scoped hosting (GitHub Pages) works.
const DATA_URL = `${import.meta.env.BASE_URL}data/photos-2026.json`.replace(
  /([^:]\/)\/+/g,
  '$1',
)
const POPULATION_RATE_URL = `${import.meta.env.BASE_URL}data/photo-rates-per-capita-2026.json`.replace(
  /([^:]\/)\/+/g,
  '$1',
)
const HOTSPOT_PLACES_URL = `${import.meta.env.BASE_URL}data/hotspot-places-2026.json`.replace(
  /([^:]\/)\/+/g,
  '$1',
)

/** Prefer gzip on Pages (file exceeds GitHub’s 100 MB limit uncompressed). */
async function fetchJsonDataset(url: string): Promise<PhotoDataset> {
  const gzUrl = url.replace(/\.json$/i, '.json.gz')
  const gzRes = await fetch(gzUrl)
  if (gzRes.ok && gzRes.body && typeof DecompressionStream !== 'undefined') {
    const stream = gzRes.body.pipeThrough(new DecompressionStream('gzip'))
    const text = await new Response(stream).text()
    return JSON.parse(text) as PhotoDataset
  }

  const res = await fetch(url)
  if (res.status === 404) {
    throw new Error(
      'No data yet. Run `npm run download` first to fetch Flickr photos to public/data/photos-2026.json',
    )
  }
  if (!res.ok) throw new Error(`Failed to load dataset (HTTP ${res.status})`)
  return (await res.json()) as PhotoDataset
}

/** Load previously downloaded Flickr points from disk (served via /public). */
export async function loadDataset(): Promise<PhotoDataset> {
  return fetchJsonDataset(DATA_URL)
}

/** Attach EB params and rewrite Capita rates from photos + population. */
export function withEmpiricalBayesRates(
  dataset: PopulationRateDataset,
): PopulationRateDataset {
  const floor = dataset.populationFloor ?? 1_000
  const minPhotos = dataset.minPhotos ?? CAPITA_MIN_PHOTOS
  const params: EbParams =
    dataset.ebMean !== undefined && dataset.ebStrength !== undefined
      ? { mean: dataset.ebMean, strength: dataset.ebStrength }
      : estimateEbParams(dataset.cells, floor)

  return {
    ...dataset,
    ebMean: params.mean,
    ebStrength: params.strength,
    minPhotos,
    cells: dataset.cells.map((cell) => ({
      ...cell,
      photosPerThousand:
        cell.photos >= minPhotos
          ? Number(
              ebPhotosPerThousand(
                cell.photos,
                cell.population,
                params,
                floor,
              ).toFixed(4),
            )
          : 0,
    })),
  }
}

/** Load the offline-prepared population / photo-rate grid (GHSL 2020). */
export async function loadPopulationRates(): Promise<PopulationRateDataset> {
  const res = await fetch(POPULATION_RATE_URL)
  if (!res.ok) {
    throw new Error(`Failed to load population rate grid (HTTP ${res.status})`)
  }
  return withEmpiricalBayesRates((await res.json()) as PopulationRateDataset)
}

export type HotspotPlaceLabels = Record<string, string | null>

/** Offline Nominatim labels keyed by "lat.toFixed(3),lon.toFixed(3)". */
export async function loadHotspotPlaceLabels(): Promise<HotspotPlaceLabels> {
  const res = await fetch(HOTSPOT_PLACES_URL)
  if (!res.ok) return {}
  const data = (await res.json()) as { labels?: HotspotPlaceLabels }
  return data.labels ?? {}
}

export function placeLabelKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`
}

/** Apply offline place names when present; leave coordinate fallback otherwise. */
export function applyPlaceLabels(
  hotspots: Hotspot[],
  labels: HotspotPlaceLabels,
): Hotspot[] {
  return hotspots.map((hotspot) => {
    const label = labels[placeLabelKey(hotspot.lat, hotspot.lon)]
    return label ? { ...hotspot, placeName: label } : hotspot
  })
}

/** Grid-cluster points; return the densest cells as pin hotspots, spread globally. */
export function findHotspots(points: PhotoPoint[], limit = 12, cellDeg = 1.5): Hotspot[] {
  type Cell = {
    latSum: number
    lonSum: number
    count: number
    owners: Set<string>
    best: PhotoPoint
  }
  const cells = new Map<string, Cell>()

  for (const p of points) {
    const key = `${Math.floor(p.lat / cellDeg)},${Math.floor(p.lon / cellDeg)}`
    const existing = cells.get(key)
    if (!existing) {
      cells.set(key, {
        latSum: p.lat,
        lonSum: p.lon,
        count: 1,
        owners: new Set(p.owner ? [p.owner] : []),
        best: p,
      })
    } else {
      existing.latSum += p.lat
      existing.lonSum += p.lon
      existing.count += 1
      if (p.owner) existing.owners.add(p.owner)
      if (p.views > existing.best.views) existing.best = p
    }
  }

  const ranked = [...cells.values()]
    .map((c) => ({
      lat: c.latSum / c.count,
      lon: c.lonSum / c.count,
      count: c.count,
      photographers: c.owners.size || undefined,
      sample: c.best,
    }))
    .sort((a, b) => b.count - a.count)

  const picked: typeof ranked = []
  const minSepDeg = 12
  for (const candidate of ranked) {
    const tooClose = picked.some(
      (p) => Math.hypot(p.lat - candidate.lat, p.lon - candidate.lon) < minSepDeg,
    )
    if (!tooClose) picked.push(candidate)
    if (picked.length >= limit) break
  }

  for (const candidate of ranked) {
    if (picked.length >= limit) break
    if (!picked.includes(candidate)) picked.push(candidate)
  }

  return picked.map((c, i) => ({
    ...c,
    color: PIN_COLORS[i % PIN_COLORS.length],
    placeName: formatCoords(c.lat, c.lon),
  }))
}

/**
 * Rank photography clusters by EB-shrunk photos per 1,000 residents.
 * Population and photos are aggregated into the same coarse cells used by
 * findHotspots, then geographically spread so one region cannot fill the list.
 * Cells below CAPITA_MIN_PHOTOS are excluded so sparse deserts cannot dominate.
 */
export function findPerCapitaHotspots(
  points: PhotoPoint[],
  populationRates: PopulationRateDataset,
  limit = 12,
  cellDeg = 1.5,
): Hotspot[] {
  type Cell = {
    latSum: number
    lonSum: number
    count: number
    population: number
    best?: PhotoPoint
  }
  const cells = new Map<string, Cell>()
  const keyFor = (lat: number, lon: number) =>
    `${Math.floor(lat / cellDeg)},${Math.floor(lon / cellDeg)}`
  const floor = populationRates.populationFloor ?? 1_000
  const minPhotos = populationRates.minPhotos ?? CAPITA_MIN_PHOTOS
  const eb: EbParams =
    populationRates.ebMean !== undefined &&
    populationRates.ebStrength !== undefined
      ? {
          mean: populationRates.ebMean,
          strength: populationRates.ebStrength,
        }
      : estimateEbParams(populationRates.cells, floor)

  for (const cell of populationRates.cells) {
    const key = keyFor(cell.lat, cell.lon)
    const existing = cells.get(key)
    if (existing) {
      existing.population += cell.population
    } else {
      cells.set(key, {
        latSum: 0,
        lonSum: 0,
        count: 0,
        population: cell.population,
      })
    }
  }

  for (const point of points) {
    const key = keyFor(point.lat, point.lon)
    const existing = cells.get(key)
    if (!existing) continue
    existing.latSum += point.lat
    existing.lonSum += point.lon
    existing.count += 1
    if (!existing.best || point.views > existing.best.views) {
      existing.best = point
    }
  }

  const ranked = [...cells.values()]
    .filter(
      (cell): cell is Cell & { best: PhotoPoint } =>
        cell.count >= minPhotos && !!cell.best,
    )
    .map((cell) => ({
      lat: cell.latSum / cell.count,
      lon: cell.lonSum / cell.count,
      count: cell.count,
      photosPerThousand: ebPhotosPerThousand(
        cell.count,
        cell.population,
        eb,
        floor,
      ),
      sample: cell.best,
    }))
    .sort((a, b) => b.photosPerThousand - a.photosPerThousand)

  const picked: typeof ranked = []
  const minSepDeg = 12
  for (const candidate of ranked) {
    const tooClose = picked.some(
      (item) =>
        Math.hypot(item.lat - candidate.lat, item.lon - candidate.lon) <
        minSepDeg,
    )
    if (!tooClose) picked.push(candidate)
    if (picked.length >= limit) break
  }

  for (const candidate of ranked) {
    if (picked.length >= limit) break
    if (!picked.includes(candidate)) picked.push(candidate)
  }

  return picked.map((cell, index) => ({
    ...cell,
    color: PIN_COLORS[index % PIN_COLORS.length],
    placeName: formatCoords(cell.lat, cell.lon),
  }))
}

/**
 * Rank clusters by EB-shrunk photos per national Flickr home-user base.
 */
export function findFlickrShareHotspots(
  points: PhotoPoint[],
  populationRates: PopulationRateDataset,
  limit = 12,
  cellDeg = 1.5,
): Hotspot[] {
  type Cell = {
    latSum: number
    lonSum: number
    count: number
    flickrUsers: number
    best?: PhotoPoint
  }
  const cells = new Map<string, Cell>()
  const keyFor = (lat: number, lon: number) =>
    `${Math.floor(lat / cellDeg)},${Math.floor(lon / cellDeg)}`
  const minPhotos = populationRates.minPhotos ?? CAPITA_MIN_PHOTOS
  const eb: EbParams =
    populationRates.flickrEbMean !== undefined &&
    populationRates.flickrEbStrength !== undefined
      ? {
          mean: populationRates.flickrEbMean,
          strength: populationRates.flickrEbStrength,
        }
      : estimateEbParams(
          populationRates.cells
            .filter((cell) => cell.photos > 0 && (cell.flickrUsers ?? 0) > 0)
            .map((cell) => ({
              photos: cell.photos,
              population: Math.max(cell.flickrUsers ?? 1, 1),
            })),
          1,
        )

  for (const cell of populationRates.cells) {
    const key = keyFor(cell.lat, cell.lon)
    const existing = cells.get(key)
    const flickrUsers = cell.flickrUsers ?? 0
    if (existing) {
      existing.flickrUsers = Math.max(existing.flickrUsers, flickrUsers)
    } else {
      cells.set(key, {
        latSum: 0,
        lonSum: 0,
        count: 0,
        flickrUsers,
      })
    }
  }

  for (const point of points) {
    const key = keyFor(point.lat, point.lon)
    const existing = cells.get(key)
    if (!existing) continue
    existing.latSum += point.lat
    existing.lonSum += point.lon
    existing.count += 1
    if (!existing.best || point.views > existing.best.views) {
      existing.best = point
    }
  }

  const ranked = [...cells.values()]
    .filter(
      (cell): cell is Cell & { best: PhotoPoint } =>
        cell.count >= minPhotos && !!cell.best,
    )
    .map((cell) => ({
      lat: cell.latSum / cell.count,
      lon: cell.lonSum / cell.count,
      count: cell.count,
      photosPerThousand:
        ebPhotosPerThousand(
          cell.count,
          Math.max(cell.flickrUsers, 1),
          eb,
          1,
        ) / 1000,
      sample: cell.best,
    }))
    .sort(
      (a, b) => (b.photosPerThousand ?? 0) - (a.photosPerThousand ?? 0),
    )

  const picked: typeof ranked = []
  const minSepDeg = 12
  for (const candidate of ranked) {
    const tooClose = picked.some(
      (item) =>
        Math.hypot(item.lat - candidate.lat, item.lon - candidate.lon) <
        minSepDeg,
    )
    if (!tooClose) picked.push(candidate)
    if (picked.length >= limit) break
  }

  for (const candidate of ranked) {
    if (picked.length >= limit) break
    if (!picked.includes(candidate)) picked.push(candidate)
  }

  return picked.map((cell, index) => ({
    ...cell,
    color: PIN_COLORS[index % PIN_COLORS.length],
    placeName: formatCoords(cell.lat, cell.lon),
  }))
}

/** Top photos by view count (unique ids). */
export function findMostViewed(points: PhotoPoint[], limit = 8): PhotoPoint[] {
  return [...points].sort((a, b) => b.views - a.views).slice(0, limit)
}

function formatCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(1)}°${ns}, ${Math.abs(lon).toFixed(1)}°${ew}`
}

type ReverseGeoResult = {
  city?: string
  locality?: string
  principalSubdivision?: string
  countryName?: string
  continent?: string
  localityInfo?: {
    administrative?: Array<{ name?: string; description?: string; order?: number }>
    informative?: Array<{ name?: string; description?: string; order?: number }>
  }
}

function placeNameFromReverseGeo(data: ReverseGeoResult, fallback: string): string {
  const admin = [...(data.localityInfo?.administrative ?? [])]
    .filter((item) => item.name)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
  const informative = [...(data.localityInfo?.informative ?? [])]
    .filter((item) => item.name)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))

  const local =
    data.city ||
    data.locality ||
    informative[0]?.name ||
    admin[0]?.name
  const region = data.principalSubdivision || admin[1]?.name || admin[0]?.name
  const country = data.countryName || data.continent

  const parts = [local, region === local ? country : region, country]
    .filter(Boolean)
    .filter((part, index, arr) => arr.indexOf(part) === index)
  return parts.slice(0, 2).join(', ') || fallback
}

/** Resolve hotspot coordinates to city/region names (BigDataCloud, no API key). */
export async function resolvePlaceNames(hotspots: Hotspot[]): Promise<Hotspot[]> {
  const out: Hotspot[] = []
  for (const h of hotspots) {
    try {
      const qs = new URLSearchParams({
        latitude: String(h.lat),
        longitude: String(h.lon),
        localityLanguage: 'en',
      })
      const res = await fetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?${qs}`,
      )
      if (!res.ok) {
        out.push(h)
        continue
      }
      const data = (await res.json()) as ReverseGeoResult
      out.push({ ...h, placeName: placeNameFromReverseGeo(data, h.placeName) })
    } catch {
      out.push(h)
    }
  }
  return out
}
