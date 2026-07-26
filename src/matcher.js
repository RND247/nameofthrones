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
