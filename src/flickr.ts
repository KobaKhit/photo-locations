export type PhotoPoint = {
  id: string
  lat: number
  lon: number
  title: string
  views: number
  url?: string
  taken?: string
}

export type Hotspot = {
  lat: number
  lon: number
  count: number
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
}

export type PopulationRateCell = {
  lat: number
  lon: number
  photos: number
  population: number
  photosPerThousand: number
}

export type PopulationRateDataset = {
  source: string
  sourceUrl: string
  populationYear: number
  cellDegrees: number
  populationFloor: number
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

/** Load previously downloaded Flickr points from disk (served via /public). */
export async function loadDataset(): Promise<PhotoDataset> {
  const res = await fetch(DATA_URL)
  if (res.status === 404) {
    throw new Error(
      'No data yet. Run `npm run download` first to fetch Flickr photos to public/data/photos-2026.json',
    )
  }
  if (!res.ok) throw new Error(`Failed to load dataset (HTTP ${res.status})`)
  return (await res.json()) as PhotoDataset
}

/** Load the offline-prepared population / photo-rate grid (GHSL 2020). */
export async function loadPopulationRates(): Promise<PopulationRateDataset> {
  const res = await fetch(POPULATION_RATE_URL)
  if (!res.ok) {
    throw new Error(`Failed to load population rate grid (HTTP ${res.status})`)
  }
  return (await res.json()) as PopulationRateDataset
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
  type Cell = { latSum: number; lonSum: number; count: number; best: PhotoPoint }
  const cells = new Map<string, Cell>()

  for (const p of points) {
    const key = `${Math.floor(p.lat / cellDeg)},${Math.floor(p.lon / cellDeg)}`
    const existing = cells.get(key)
    if (!existing) {
      cells.set(key, { latSum: p.lat, lonSum: p.lon, count: 1, best: p })
    } else {
      existing.latSum += p.lat
      existing.lonSum += p.lon
      existing.count += 1
      if (p.views > existing.best.views) existing.best = p
    }
  }

  const ranked = [...cells.values()]
    .map((c) => ({
      lat: c.latSum / c.count,
      lon: c.lonSum / c.count,
      count: c.count,
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
 * Rank photography clusters by photos per 1,000 residents instead of raw count.
 * Population and photos are aggregated into the same coarse cells used by
 * findHotspots, then geographically spread so one region cannot fill the list.
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
    .filter((cell): cell is Cell & { best: PhotoPoint } => cell.count > 0 && !!cell.best)
    .map((cell) => ({
      lat: cell.latSum / cell.count,
      lon: cell.lonSum / cell.count,
      count: cell.count,
      photosPerThousand:
        (cell.count * 1_000) /
        Math.max(cell.population, populationRates.populationFloor),
      sample: cell.best,
    }))
    .sort((a, b) => b.photosPerThousand - a.photosPerThousand)

  const picked: typeof ranked = []
  const minSepDeg = 12
  for (const candidate of ranked) {
    const tooClose = picked.some(
      (item) => Math.hypot(item.lat - candidate.lat, item.lon - candidate.lon) < minSepDeg,
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
