const FAMOUS_HOUSE_ORDER = Object.freeze([
  "stark",
  "lannister",
  "targaryen",
  "baratheon",
  "greyjoy",
  "tyrell",
  "martell",
  "arryn",
  "tully",
  "bolton",
  "frey",
]);

export function collapseLocationGroups(groups) {
  const accumulators = new Map();
  const groupIdBySourceId = new Map();

  for (const group of groups) {
    const displayName = getDisplayName(group);
    const displayId =
      group.kind === "house"
        ? `display-${slugify(displayName)}`
        : group.id;
    groupIdBySourceId.set(group.id, displayId);

    const current = accumulators.get(displayId);
    if (current) {
      current.major ||= group.major;
      if (group.region) {
        current.regions.add(group.region);
      }
      current.sourceCount += 1;
      continue;
    }

    accumulators.set(displayId, {
      id: displayId,
      name: displayName,
      kind: group.kind,
      major: group.major,
      regions: new Set(group.region ? [group.region] : []),
      source: group.source,
      sourceCount: 1,
    });
  }

  const collapsedGroups = [...accumulators.values()].map((group) =>
    Object.freeze({
      id: group.id,
      name: group.name,
      kind: group.kind,
      major: group.major,
      region:
        group.sourceCount === 1 && group.regions.size === 1
          ? [...group.regions][0]
          : null,
      source: group.sourceCount === 1 ? group.source : null,
    }),
  );

  return Object.freeze({
    groups: Object.freeze(collapsedGroups.sort(compareGroups)),
    groupIdBySourceId,
  });
}

export function remapCharacterGroups(characters, groupIdBySourceId) {
  return characters.map((character) => {
    const primaryHouseId = groupIdBySourceId.get(character.primaryHouseId);
    if (!primaryHouseId) {
      return character;
    }

    const houseIds = [
      ...new Set(
        character.houseIds
          .map((houseId) => groupIdBySourceId.get(houseId))
          .filter(Boolean),
      ),
    ];
    return Object.freeze({
      ...character,
      primaryHouseId,
      houseIds: Object.freeze(houseIds),
    });
  });
}

export function compareGroups(left, right) {
  const famousHouseDifference =
    getFamousHouseRank(left.name) - getFamousHouseRank(right.name);
  if (famousHouseDifference !== 0) {
    return famousHouseDifference;
  }

  const leftRank = left.major ? 0 : left.kind === "fallback" ? 1 : 2;
  const rightRank = right.major ? 0 : right.kind === "fallback" ? 1 : 2;
  return (
    leftRank - rightRank ||
    left.name.localeCompare(right.name, "en", { sensitivity: "base" })
  );
}

function getDisplayName(group) {
  if (group.kind !== "house") {
    return group.name;
  }

  const locationMatch = /^House\s+(.+?)\s+of\s+.+$/iu.exec(group.name);
  return locationMatch ? `House ${locationMatch[1]}` : group.name;
}

function getFamousHouseRank(name) {
  const words = name.toLocaleLowerCase("en-US").match(/\p{L}+/gu) ?? [];
  const index = FAMOUS_HOUSE_ORDER.findIndex((houseName) =>
    words.includes(houseName),
  );
  return index === -1 ? FAMOUS_HOUSE_ORDER.length : index;
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "house";
}
