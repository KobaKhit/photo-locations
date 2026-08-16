/**
 * Offline country lookup from world-atlas 110m polygons (d3-geo).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feature } from 'topojson-client'
import { geoContains } from 'd3-geo'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const topology = JSON.parse(
  readFileSync(join(root, 'node_modules/world-atlas/countries-110m.json'), 'utf8'),
)
const collection = feature(topology, topology.objects.countries)

/** @type {{ name: string, feature: import('geojson').Feature }[]} */
const countries = collection.features.map((f) => ({
  name: f.properties?.name || String(f.id),
  feature: f,
}))

/** Cache recent lookups (rounded coords) for speed. */
const cache = new Map()

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {string | null}
 */
export function countryAt(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`
  if (cache.has(key)) return cache.get(key)

  const point = [lon, lat]
  let name = null
  for (const country of countries) {
    if (geoContains(country.feature, point)) {
      name = country.name
      break
    }
  }
  cache.set(key, name)
  return name
}

export function allCountryNames() {
  return countries.map((c) => c.name)
}
