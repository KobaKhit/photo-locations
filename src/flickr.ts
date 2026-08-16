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
      const placeName =
        [data.city || data.locality, data.principalSubdivision, data.countryName]
          .filter(Boolean)
          .filter((part, i, arr) => arr.indexOf(part) === i)
          .slice(0, 2)
          .join(', ') || h.placeName
      out.push({ ...h, placeName })
    } catch {
      out.push(h)
    }
  }
  return out
}
