export const V1_STORAGE_KEY = "nameOfThrones:v1:game";
export const V2_STORAGE_KEY = "nameOfThrones:v2:game";
export const STORAGE_VERSION = 2;

export function createProgressState(levelIds) {
  const levels = {};
  for (const levelId of uniqueLevelIds(levelIds)) {
    levels[levelId] = createEmptyLevelProgress();
  }
  return {
    version: STORAGE_VERSION,
    activeDifficulty: null,
    levels,
  };
}

export function sanitizeProgressState(candidate, levelIds, rosterIdsByLevel) {
  const emptyState = createProgressState(levelIds);
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    candidate.version !== STORAGE_VERSION ||
    (candidate.activeDifficulty !== null &&
      !uniqueLevelIds(levelIds).includes(candidate.activeDifficulty)) ||
    candidate.levels === null ||
    typeof candidate.levels !== "object" ||
    Array.isArray(candidate.levels)
  ) {
    return emptyState;
  }

  const levels = {};
  for (const levelId of uniqueLevelIds(levelIds)) {
    const validRosterIds = rosterIdsByLevel.get(levelId) ?? new Set();
    levels[levelId] = sanitizeLevelProgress(
      candidate.levels[levelId],
      validRosterIds,
    );
  }

  return {
    version: STORAGE_VERSION,
    activeDifficulty: candidate.activeDifficulty,
    levels: synchronizeFoundIds(levels, rosterIdsByLevel),
  };
}

export function setActiveDifficulty(state, levelId, levelIds) {
  const allowedLevelIds = uniqueLevelIds(levelIds);
  if (levelId !== null && !allowedLevelIds.includes(levelId)) {
    return state;
  }
  return {
    ...state,
    activeDifficulty: levelId,
  };
}

export function updateLevelProgress(
  state,
  levelId,
  progress,
  rosterIdsByLevel,
) {
  if (
    !Object.hasOwn(state.levels, levelId) ||
    !(rosterIdsByLevel instanceof Map)
  ) {
    return state;
  }

  const levels = {
    ...state.levels,
    [levelId]: sanitizeLevelProgress(
      progress,
      rosterIdsByLevel.get(levelId) ?? new Set(),
    ),
  };

  return {
    ...state,
    levels: synchronizeFoundIds(levels, rosterIdsByLevel),
  };
}

export function resetAllProgress(state) {
  const levels = {};
  for (const levelId of Object.keys(state.levels)) {
    levels[levelId] = createEmptyLevelProgress();
  }

  return {
    ...state,
    levels,
  };
}

export function loadProgressState(
  storage,
  levelIds,
  rosterIdsByLevel,
  expertLevelId,
  now = Date.now(),
) {
  const emptyState = createProgressState(levelIds);
  const v2RawValue = readStorage(storage, V2_STORAGE_KEY);

  if (v2RawValue !== null) {
    const candidate = parseJson(v2RawValue);
    return sanitizeProgressState(candidate, levelIds, rosterIdsByLevel);
  }

  const v1RawValue = readStorage(storage, V1_STORAGE_KEY);
  if (
    v1RawValue === null ||
    !uniqueLevelIds(levelIds).includes(expertLevelId)
  ) {
    return emptyState;
  }

  const legacyProgress = sanitizeLegacyProgress(
    parseJson(v1RawValue),
    rosterIdsByLevel.get(expertLevelId) ?? new Set(),
    now,
  );
  if (legacyProgress === null) {
    return emptyState;
  }

  const migratedState = {
    ...emptyState,
    activeDifficulty: null,
    levels: synchronizeFoundIds(
      {
        ...emptyState.levels,
        [expertLevelId]: legacyProgress,
      },
      rosterIdsByLevel,
    ),
  };

  if (saveProgressState(storage, migratedState)) {
    removeStorage(storage, V1_STORAGE_KEY);
  }
  return migratedState;
}

export function saveProgressState(storage, state) {
  try {
    storage.setItem(V2_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function sanitizeLevelProgress(candidate, validRosterIds) {
  if (!isValidLevelProgress(candidate)) {
    return createEmptyLevelProgress();
  }

  return {
    foundIds: [
      ...new Set(candidate.foundIds.filter((id) => validRosterIds.has(id))),
    ],
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
    filterHouseId: candidate.filterHouseId,
  };
}

function synchronizeFoundIds(levels, rosterIdsByLevel) {
  const sharedFoundIds = new Set(
    Object.values(levels).flatMap((progress) => progress.foundIds),
  );
  const synchronizedLevels = {};

  for (const [levelId, progress] of Object.entries(levels)) {
    const validRosterIds = rosterIdsByLevel.get(levelId) ?? new Set();
    const foundIds = [...sharedFoundIds].filter((id) => validRosterIds.has(id));
    synchronizedLevels[levelId] = {
      ...progress,
      foundIds,
      completedAt:
        foundIds.length === validRosterIds.size ? progress.completedAt : null,
    };
  }

  return synchronizedLevels;
}

function isValidLevelProgress(candidate) {
  return !(
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !Array.isArray(candidate.foundIds) ||
    !candidate.foundIds.every((id) => typeof id === "string") ||
    !isNullableTimestamp(candidate.startedAt) ||
    !isNullableTimestamp(candidate.completedAt) ||
    (candidate.completedAt !== null &&
      (candidate.startedAt === null ||
        candidate.completedAt < candidate.startedAt)) ||
    typeof candidate.filterHouseId !== "string" ||
    candidate.filterHouseId.length === 0
  );
}

function sanitizeLegacyProgress(candidate, validRosterIds, now) {
  if (!isValidLevelProgress(candidate)) {
    return null;
  }
  const progress = sanitizeLevelProgress(candidate, validRosterIds);
  if (
    progress.completedAt !== null &&
    progress.foundIds.length < validRosterIds.size
  ) {
    const elapsed = Math.max(0, progress.completedAt - progress.startedAt);
    return {
      ...progress,
      startedAt: Math.max(1, now - elapsed),
      completedAt: null,
    };
  }
  return progress;
}

function createEmptyLevelProgress() {
  return {
    foundIds: [],
    startedAt: null,
    completedAt: null,
    filterHouseId: "all",
  };
}

function uniqueLevelIds(levelIds) {
  if (!Array.isArray(levelIds)) {
    return [];
  }
  return [
    ...new Set(levelIds.filter((levelId) => typeof levelId === "string")),
  ];
}

function isNullableTimestamp(value) {
  return (
    value === null ||
    (Number.isFinite(value) && Number.isInteger(value) && value > 0)
  );
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readStorage(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function removeStorage(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // Keeping stale v1 data is safer than failing the game.
  }
}
