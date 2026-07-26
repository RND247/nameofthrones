const COMBINING_MARKS = /\p{M}+/gu;
const APOSTROPHES = /[\u2018\u2019\u201B\u02BC\uFF07`´]/gu;
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;
const UNSAFE_PUNCTUATION = /[^\p{L}\p{N}'-]+/gu;
const APOSTROPHE_SPACING = /\s*'\s*/gu;
const HYPHEN_SPACING = /\s*-\s*/gu;
const REPEATED_WHITESPACE = /\s+/gu;

export function normalizeName(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(APOSTROPHES, "'")
    .replace(DASHES, "-")
    .toLocaleLowerCase("en-US")
    .replace(UNSAFE_PUNCTUATION, " ")
    .replace(APOSTROPHE_SPACING, "'")
    .replace(HYPHEN_SPACING, "-")
    .replace(REPEATED_WHITESPACE, " ")
    .trim();
}

export function buildNameIndex(characters) {
  const matchesByName = new Map();

  if (!Array.isArray(characters)) {
    return matchesByName;
  }

  for (const character of characters) {
    if (
      character === null ||
      typeof character !== "object" ||
      typeof character.id !== "string" ||
      character.id.trim().length === 0 ||
      typeof character.name !== "string"
    ) {
      continue;
    }

    const candidateNames = [
      character.name,
      ...(Array.isArray(character.acceptedNames)
        ? character.acceptedNames
        : []),
    ];

    for (const candidateName of candidateNames) {
      const normalizedName = normalizeName(candidateName);
      if (!normalizedName) {
        continue;
      }

      const ids = matchesByName.get(normalizedName) ?? new Set();
      ids.add(character.id);
      matchesByName.set(normalizedName, ids);
    }
  }

  return new Map(
    [...matchesByName].map(([normalizedName, ids]) => [
      normalizedName,
      Object.freeze([...ids]),
    ]),
  );
}

export function buildSuggestionIndex(characters) {
  if (!Array.isArray(characters)) {
    return Object.freeze([]);
  }

  const suggestionsByNormalizedName = new Map();
  for (const character of characters) {
    if (
      character === null ||
      typeof character !== "object" ||
      typeof character.name !== "string"
    ) {
      continue;
    }

    const candidateNames = [
      character.name,
      ...(Array.isArray(character.acceptedNames)
        ? character.acceptedNames
        : []),
    ];
    for (const candidateName of candidateNames) {
      const normalizedName = normalizeName(candidateName);
      if (
        normalizedName &&
        !suggestionsByNormalizedName.has(normalizedName)
      ) {
        suggestionsByNormalizedName.set(
          normalizedName,
          Object.freeze({
            normalizedName,
            suggestion: candidateName.trim(),
          }),
        );
      }
    }
  }

  return Object.freeze([...suggestionsByNormalizedName.values()]);
}

export function matchExactName(value, nameIndex) {
  if (!(nameIndex instanceof Map)) {
    return [];
  }

  const normalizedName = normalizeName(value);
  if (!normalizedName) {
    return [];
  }

  return [...(nameIndex.get(normalizedName) ?? [])];
}

export function findClosestName(value, suggestionIndex) {
  const normalizedName = normalizeName(value);
  if (
    normalizedName.length < 4 ||
    !Array.isArray(suggestionIndex) ||
    suggestionIndex.length === 0
  ) {
    return null;
  }

  let bestMatch = null;
  let hasEqualMatch = false;

  for (const candidate of suggestionIndex) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.normalizedName !== "string" ||
      typeof candidate.suggestion !== "string" ||
      candidate.normalizedName === normalizedName
    ) {
      continue;
    }

    const maximumLength = Math.max(
      normalizedName.length,
      candidate.normalizedName.length,
    );
    const maximumDistance = getMaximumSuggestionDistance(maximumLength);
    const lengthDifference = Math.abs(
      normalizedName.length - candidate.normalizedName.length,
    );
    if (
      lengthDifference > maximumDistance ||
      candidate.normalizedName.startsWith(normalizedName)
    ) {
      continue;
    }

    const distance = levenshteinDistanceWithin(
      normalizedName,
      candidate.normalizedName,
      maximumDistance,
    );
    if (distance === null || distance === 0) {
      continue;
    }

    const match = {
      distance,
      maximumLength,
      suggestion: candidate.suggestion,
    };
    if (isBetterMatch(match, bestMatch)) {
      bestMatch = match;
      hasEqualMatch = false;
    } else if (isEqualMatch(match, bestMatch)) {
      hasEqualMatch = true;
    }
  }

  return bestMatch && !hasEqualMatch ? bestMatch.suggestion : null;
}

function getMaximumSuggestionDistance(length) {
  if (length <= 6) {
    return 1;
  }
  if (length <= 10) {
    return 2;
  }
  if (length <= 15) {
    return 3;
  }
  return 4;
}

function levenshteinDistanceWithin(left, right, maximumDistance) {
  let previousRow = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const currentRow = [leftIndex];
    let rowMinimum = currentRow[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex] + 1,
        previousRow[rightIndex - 1] + substitutionCost,
      );
      currentRow.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maximumDistance) {
      return null;
    }
    previousRow = currentRow;
  }

  const distance = previousRow[right.length];
  return distance <= maximumDistance ? distance : null;
}

function isBetterMatch(candidate, current) {
  if (current === null) {
    return true;
  }

  const candidateRatio = candidate.distance / candidate.maximumLength;
  const currentRatio = current.distance / current.maximumLength;
  return (
    candidateRatio < currentRatio ||
    (candidateRatio === currentRatio &&
      candidate.distance < current.distance)
  );
}

function isEqualMatch(candidate, current) {
  return (
    current !== null &&
    candidate.distance * current.maximumLength ===
      current.distance * candidate.maximumLength &&
    candidate.distance === current.distance &&
    candidate.suggestion !== current.suggestion
  );
}
