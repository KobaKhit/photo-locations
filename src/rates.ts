/**
 * Empirical Bayes (Gamma–Poisson) shrinkage for photos-per-resident rates.
 * Shrinks noisy sparse-pop cells toward the global mean so Capita maps are
 * not dominated by deserts with a handful of photos.
 */

export type RateObservation = {
  photos: number
  population: number
}

export type EbParams = {
  /** Global mean photos per resident. */
  mean: number
  /** Prior strength C in residents; larger → more shrinkage. */
  strength: number
}

/** Minimum photos before a cell/hex is shown or ranked in Capita mode. */
export const CAPITA_MIN_PHOTOS = 5

/**
 * Estimate μ and C from photographed cells via method of moments.
 * Variance is fit only on cells with enough photos and population so a few
 * desert outliers cannot collapse C→1 (no shrinkage).
 * θ̂_i = (n_i + Cμ) / (p_i + C)
 */
export function estimateEbParams(
  items: RateObservation[],
  populationFloor = 1_000,
): EbParams {
  const usable = items.filter(
    (item) => item.photos > 0 && item.population > 0,
  )
  let sumPhotos = 0
  let sumPopulation = 0
  for (const item of usable) {
    const population = Math.max(item.population, 1)
    sumPhotos += item.photos
    sumPopulation += population
  }

  const mean = sumPopulation > 0 ? sumPhotos / sumPopulation : 0
  // Floor C at the population floor so a cell with ~floor residents is
  // shrunk ~50% toward the global mean — enough to cool deserts.
  const minStrength = Math.max(populationFloor, 1_000)
  if (usable.length < 2 || mean <= 0) {
    return { mean, strength: minStrength }
  }

  const stable = usable.filter(
    (item) =>
      item.photos >= CAPITA_MIN_PHOTOS &&
      item.population >= populationFloor,
  )
  if (stable.length < 2) {
    return { mean, strength: minStrength }
  }

  let weightSum = 0
  let weightedSq = 0
  let sumStablePop = 0
  for (const item of stable) {
    const population = item.population
    const rate = item.photos / population
    weightSum += population
    weightedSq += population * (rate - mean) ** 2
    sumStablePop += population
  }

  const observedVar = weightedSq / weightSum
  const meanExposure = sumStablePop / stable.length
  const samplingVar = mean / meanExposure
  const betweenVar = Math.max(observedVar - samplingVar, mean * mean * 1e-8)
  const strength = Math.max((mean * mean) / betweenVar, minStrength)

  return { mean, strength }
}

/** Shrunk photos per 1,000 residents. */
export function ebPhotosPerThousand(
  photos: number,
  population: number,
  params: EbParams,
  populationFloor = 1,
): number {
  const exposure = Math.max(population, populationFloor)
  const { mean, strength } = params
  return (1_000 * (photos + strength * mean)) / (exposure + strength)
}

/** Raw (unshrunk) photos per 1,000 residents — kept for comparison / tooling. */
export function rawPhotosPerThousand(
  photos: number,
  population: number,
  populationFloor = 1,
): number {
  if (photos <= 0) return 0
  return (photos * 1_000) / Math.max(population, populationFloor)
}
