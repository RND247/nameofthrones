import { normalizeName } from "./matcher.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const ALLOWED_OVERRIDE_KEYS = new Set([
  "id",
  "accepted_names_add",
  "name_override",
  "source_url",
]);
const ALLOWED_SOURCE_HOSTS = new Set([
  "anapioficeandfire.com",
  "en.wikipedia.org",
  "gameofthrones.fandom.com",
  "www.fandom.com",
  "www.wikidata.org",
]);

export function validateLevelPayload(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Number.isInteger(payload.schema_version) ||
    !Array.isArray(payload.sources) ||
    !Array.isArray(payload.levels)
  ) {
    return Object.freeze([]);
  }

  const levels = [];
  const seenIds = new Set();

  for (const value of payload.levels) {
    const level = validateLevel(value);
    if (!level || seenIds.has(level.id)) {
      return Object.freeze([]);
    }
    seenIds.add(level.id);
    levels.push(level);
  }

  return Object.freeze(levels);
}

export function validateCharacterPayload(payload, validGroupIds) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Number.isInteger(payload.schema_version) ||
    !Array.isArray(payload.characters) ||
    !(validGroupIds instanceof Set)
  ) {
    return Object.freeze([]);
  }

  const characters = [];

  for (const value of payload.characters) {
    const character = validateCharacter(value, validGroupIds);
    if (!character) {
      return Object.freeze([]);
    }
    characters.push(character);
  }

  return Object.freeze(characters);
}

export function combineCharacters(...collections) {
  const charactersById = new Map();

  for (const collection of collections) {
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const character of collection) {
      if (!charactersById.has(character.id)) {
        charactersById.set(character.id, character);
      }
    }
  }

  return Object.freeze([...charactersById.values()]);
}

export function applyCharacterOverrides(characters, payload) {
  if (!Array.isArray(characters)) {
    return Object.freeze([]);
  }

  const overrides = validateOverrides(payload);
  if (overrides === null) {
    return Object.freeze([]);
  }

  const charactersById = new Map(
    characters.map((character) => [character.id, character]),
  );
  if (
    overrides.some((override) => {
      const character = charactersById.get(override.id);
      if (!character) {
        return true;
      }
      const existingNames = new Set(
        character.acceptedNames.map((name) => normalizeName(name)),
      );
      return override.acceptedNamesAdd.some((name) =>
        existingNames.has(normalizeName(name)),
      );
    })
  ) {
    return Object.freeze([]);
  }

  const overrideById = new Map(
    overrides.map((override) => [override.id, override]),
  );
  return Object.freeze(
    characters.map((character) => {
      const override = overrideById.get(character.id);
      if (!override) {
        return character;
      }

      const acceptedNames = deduplicateNames([
        ...character.acceptedNames,
        ...override.acceptedNamesAdd,
      ]);
      return Object.freeze({
        ...character,
        name: override.nameOverride ?? character.name,
        acceptedNames: Object.freeze(acceptedNames),
        overrideSourceUrl: override.sourceUrl,
      });
    }),
  );
}

export function buildLevelRosters(levels, characters) {
  const rosters = new Map();
  if (!Array.isArray(levels) || !Array.isArray(characters)) {
    return rosters;
  }

  const characterById = new Map(
    characters.map((character) => [character.id, character]),
  );

  for (const level of levels) {
    const roster = level.includeAll
      ? [...characters]
      : level.characterIds
          .map((characterId) => characterById.get(characterId))
          .filter(Boolean);
    rosters.set(level.id, Object.freeze(roster));
  }

  return rosters;
}

function validateLevel(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.description !== "string" ||
    value.description.trim().length === 0
  ) {
    return null;
  }

  if (value.include_all === true) {
    if (
      value.target_count !== undefined ||
      value.character_ids !== undefined
    ) {
      return null;
    }
    return Object.freeze({
      id: value.id,
      name: value.name.trim(),
      description: value.description.trim(),
      includeAll: true,
      targetCount: null,
      characterIds: null,
    });
  }

  if (
    value.include_all !== undefined ||
    !Number.isInteger(value.target_count) ||
    value.target_count < 0 ||
    !Array.isArray(value.character_ids) ||
    !value.character_ids.every(
      (characterId) =>
        typeof characterId === "string" && ID_PATTERN.test(characterId),
    )
  ) {
    return null;
  }

  const characterIds = [...new Set(value.character_ids)];
  if (characterIds.length !== value.target_count) {
    return null;
  }

  return Object.freeze({
    id: value.id,
    name: value.name.trim(),
    description: value.description.trim(),
    includeAll: false,
    targetCount: value.target_count,
    characterIds: Object.freeze(characterIds),
  });
}

function validateCharacter(value, validGroupIds) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    !Array.isArray(value.accepted_names) ||
    !value.accepted_names.every((name) => typeof name === "string") ||
    typeof value.group_id !== "string" ||
    !validGroupIds.has(value.group_id) ||
    !Array.isArray(value.house_ids) ||
    !value.house_ids.every((id) => typeof id === "string") ||
    !Array.isArray(value.book_ids) ||
    !value.book_ids.every((id) => typeof id === "string") ||
    (value.portrait_path !== null &&
      typeof value.portrait_path !== "string") ||
    (value.source !== null && typeof value.source !== "object") ||
    (value.tv_seasons !== undefined &&
      (!Array.isArray(value.tv_seasons) ||
        !value.tv_seasons.every(
          (season) => Number.isInteger(season) && season > 0,
        ))) ||
    (value.media_scope !== undefined &&
      typeof value.media_scope !== "string")
  ) {
    return null;
  }

  return Object.freeze({
    id: value.id,
    name: value.name.trim(),
    acceptedNames: Object.freeze(deduplicateNames(value.accepted_names)),
    primaryHouseId: value.group_id,
    houseIds: Object.freeze(
      value.house_ids.filter((houseId) => validGroupIds.has(houseId)),
    ),
    bookIds: Object.freeze([...value.book_ids]),
    portraitPath:
      typeof value.portrait_path === "string"
        ? value.portrait_path.trim()
        : null,
    source: value.source,
    tvSeasons: Array.isArray(value.tv_seasons)
      ? Object.freeze([...value.tv_seasons])
      : Object.freeze([]),
    mediaScope:
      typeof value.media_scope === "string" ? value.media_scope : null,
  });
}

function validateOverrides(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Number.isInteger(payload.schema_version) ||
    !Array.isArray(payload.overrides)
  ) {
    return null;
  }

  const overrides = [];
  const seenIds = new Set();
  const seenSourceUrls = new Set();
  for (const value of payload.overrides) {
    const keys =
      value !== null && typeof value === "object" ? Object.keys(value) : [];
    const acceptedNames = Array.isArray(value?.accepted_names_add)
      ? value.accepted_names_add
      : [];
    const normalizedAcceptedNames = acceptedNames.map((name) =>
      normalizeName(name),
    );
    const hasAcceptedNames = Object.hasOwn(value ?? {}, "accepted_names_add");
    const hasNameOverride = Object.hasOwn(value ?? {}, "name_override");
    if (
      value === null ||
      typeof value !== "object" ||
      keys.some((key) => !ALLOWED_OVERRIDE_KEYS.has(key)) ||
      typeof value.id !== "string" ||
      !ID_PATTERN.test(value.id) ||
      seenIds.has(value.id) ||
      (hasAcceptedNames &&
        (!Array.isArray(value.accepted_names_add) ||
          value.accepted_names_add.length > 30 ||
          !value.accepted_names_add.every((name) =>
            isCleanText(name, 300),
          ) ||
          new Set(normalizedAcceptedNames).size !==
            normalizedAcceptedNames.length)) ||
      (hasNameOverride && !isCleanText(value.name_override, 200)) ||
      (acceptedNames.length === 0 && !hasNameOverride) ||
      typeof value.source_url !== "string" ||
      !isAllowedSourceUrl(value.source_url) ||
      seenSourceUrls.has(value.source_url)
    ) {
      return null;
    }
    seenIds.add(value.id);
    seenSourceUrls.add(value.source_url);
    overrides.push(
      Object.freeze({
        id: value.id,
        acceptedNamesAdd: Object.freeze([...acceptedNames]),
        nameOverride:
          typeof value.name_override === "string"
            ? value.name_override.trim()
            : null,
        sourceUrl: value.source_url,
      }),
    );
  }
  return overrides;
}

function isCleanText(value, maxLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim().replace(/\s+/gu, " ") &&
    !/[<>\p{Cc}]/u.test(value)
  );
}

function isAllowedSourceUrl(value) {
  try {
    if (
      value.length === 0 ||
      value.length > 2048 ||
      value !== value.trim() ||
      /[\\<>\s]/u.test(value) ||
      /^https:\/\/[^/]+:\d+(?:[/?#]|$)/iu.test(value)
    ) {
      return false;
    }
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hash === "" &&
      ALLOWED_SOURCE_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function deduplicateNames(names) {
  const namesByNormalizedValue = new Map();

  for (const name of names) {
    const normalizedName = normalizeName(name);
    if (normalizedName && !namesByNormalizedValue.has(normalizedName)) {
      namesByNormalizedValue.set(normalizedName, name.trim());
    }
  }

  return [...namesByNormalizedValue.values()];
}
