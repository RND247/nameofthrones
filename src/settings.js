export const SETTINGS_STORAGE_KEY = "nameOfThrones:settings:v1";
export const LEGACY_SPELLING_HELPER_STORAGE_KEY =
  "nameOfThrones:settings:spellingHelperEnabled";

const DEFAULT_SETTINGS = Object.freeze({
  autoScrollEnabled: true,
  darkModeEnabled: true,
  spellingHelperEnabled: true,
});

export function loadSettings(storage) {
  const defaults = {
    ...DEFAULT_SETTINGS,
    spellingHelperEnabled:
      readStorage(storage, LEGACY_SPELLING_HELPER_STORAGE_KEY) !== "false",
  };
  const candidate = parseJson(readStorage(storage, SETTINGS_STORAGE_KEY));
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return defaults;
  }

  return {
    autoScrollEnabled:
      typeof candidate.autoScrollEnabled === "boolean"
        ? candidate.autoScrollEnabled
        : defaults.autoScrollEnabled,
    darkModeEnabled:
      typeof candidate.darkModeEnabled === "boolean"
        ? candidate.darkModeEnabled
        : defaults.darkModeEnabled,
    spellingHelperEnabled:
      typeof candidate.spellingHelperEnabled === "boolean"
        ? candidate.spellingHelperEnabled
        : defaults.spellingHelperEnabled,
  };
}

export function saveSettings(storage, settings) {
  if (!isValidSettings(settings)) {
    return false;
  }

  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    storage.removeItem(LEGACY_SPELLING_HELPER_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function isValidSettings(settings) {
  return (
    settings !== null &&
    typeof settings === "object" &&
    !Array.isArray(settings) &&
    typeof settings.autoScrollEnabled === "boolean" &&
    typeof settings.darkModeEnabled === "boolean" &&
    typeof settings.spellingHelperEnabled === "boolean"
  );
}

function readStorage(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function parseJson(value) {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
