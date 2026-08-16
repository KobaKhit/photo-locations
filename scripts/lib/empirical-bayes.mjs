/**
 * Empirical Bayes (Gamma–Poisson) shrinkage — shared by Node prep scripts.
 * Keep in sync with src/rates.ts.
 */

export const CAPITA_MIN_PHOTOS = 5

export function estimateEbParams(items, populationFloor = 1_000) {
  const usable = items.filter((item) => item.photos > 0 && item.population > 0)
  let sumPhotos = 0
  let sumPopulation = 0
  for (const item of usable) {
    const population = Math.max(item.population, 1)
    sumPhotos += item.photos
    sumPopulation += population
  }

  const mean = sumPopulation > 0 ? sumPhotos / sumPopulation : 0
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

export function ebPhotosPerThousand(
  photos,
  population,
  params,
  populationFloor = 1,
) {
  const exposure = Math.max(population, populationFloor)
  const { mean, strength } = params
  return (1_000 * (photos + strength * mean)) / (exposure + strength)
}
