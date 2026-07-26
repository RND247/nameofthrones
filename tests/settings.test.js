import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_SPELLING_HELPER_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
} from "../src/settings.js";

class FakeStorage {
  constructor(values = {}, failWrites = false) {
    this.values = new Map(Object.entries(values));
    this.failWrites = failWrites;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.failWrites) {
      throw new Error("Storage blocked");
    }
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("settings default to enabled", () => {
  assert.deepEqual(loadSettings(new FakeStorage()), {
    autoScrollEnabled: true,
    darkModeEnabled: true,
    spellingHelperEnabled: true,
  });
});

test("saved settings restore every toggle", () => {
  const storage = new FakeStorage();
  const settings = {
    autoScrollEnabled: false,
    darkModeEnabled: false,
    spellingHelperEnabled: false,
  };

  assert.equal(saveSettings(storage, settings), true);
  assert.deepEqual(loadSettings(storage), settings);
});

test("legacy spelling preference migrates after a successful save", () => {
  const storage = new FakeStorage({
    [LEGACY_SPELLING_HELPER_STORAGE_KEY]: "false",
  });
  const settings = loadSettings(storage);

  assert.equal(settings.spellingHelperEnabled, false);
  assert.equal(saveSettings(storage, settings), true);
  assert.equal(storage.getItem(LEGACY_SPELLING_HELPER_STORAGE_KEY), null);
  assert.notEqual(storage.getItem(SETTINGS_STORAGE_KEY), null);
});

test("malformed settings use safe defaults", () => {
  const storage = new FakeStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({
      autoScrollEnabled: "yes",
      darkModeEnabled: false,
      spellingHelperEnabled: 1,
    }),
  });

  assert.deepEqual(loadSettings(storage), {
    autoScrollEnabled: true,
    darkModeEnabled: false,
    spellingHelperEnabled: true,
  });
});

test("blocked writes fail without deleting the legacy preference", () => {
  const storage = new FakeStorage(
    { [LEGACY_SPELLING_HELPER_STORAGE_KEY]: "false" },
    true,
  );

  assert.equal(
    saveSettings(storage, {
      autoScrollEnabled: true,
      darkModeEnabled: true,
      spellingHelperEnabled: false,
    }),
    false,
  );
  assert.equal(
    storage.getItem(LEGACY_SPELLING_HELPER_STORAGE_KEY),
    "false",
  );
});
