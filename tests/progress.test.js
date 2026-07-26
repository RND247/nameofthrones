import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_VERSION,
  V1_STORAGE_KEY,
  V2_STORAGE_KEY,
  createProgressState,
  loadProgressState,
  resetAllProgress,
  setActiveDifficulty,
  updateLevelProgress,
} from "../src/progress.js";

const levelIds = ["newcomer", "fan", "expert"];
const rosterIdsByLevel = new Map([
  ["newcomer", new Set(["arya"])],
  ["fan", new Set(["arya", "jon"])],
  ["expert", new Set(["arya", "jon", "ros"])],
]);

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

test("found characters count in every level that contains them", () => {
  let state = createProgressState(levelIds);
  assert.equal(state.version, STORAGE_VERSION);
  state = updateLevelProgress(
    state,
    "newcomer",
    {
      foundIds: ["arya"],
      startedAt: 100,
      completedAt: 200,
      filterHouseId: "house-stark",
    },
    rosterIdsByLevel,
  );
  assert.deepEqual(state.levels.newcomer.foundIds, ["arya"]);
  assert.deepEqual(state.levels.fan.foundIds, ["arya"]);
  assert.deepEqual(state.levels.expert.foundIds, ["arya"]);

  state = updateLevelProgress(
    state,
    "fan",
    {
      foundIds: ["arya", "jon"],
      startedAt: 300,
      completedAt: null,
      filterHouseId: "all",
    },
    rosterIdsByLevel,
  );

  assert.deepEqual(state.levels.newcomer.foundIds, ["arya"]);
  assert.deepEqual(state.levels.fan.foundIds, ["arya", "jon"]);
  assert.deepEqual(state.levels.expert.foundIds, ["arya", "jon"]);
});

test("switching changes only the active difficulty", () => {
  const initial = createProgressState(levelIds);
  const newcomer = setActiveDifficulty(initial, "newcomer", levelIds);
  const fan = setActiveDifficulty(newcomer, "fan", levelIds);

  assert.equal(fan.activeDifficulty, "fan");
  assert.deepEqual(fan.levels, initial.levels);
  assert.equal(setActiveDifficulty(fan, "missing", levelIds), fan);
});

test("saved progress is shared when an older state is loaded", () => {
  const storage = new FakeStorage({
    [V2_STORAGE_KEY]: JSON.stringify({
      version: STORAGE_VERSION,
      activeDifficulty: "fan",
      levels: {
        newcomer: {
          foundIds: ["arya"],
          startedAt: 100,
          completedAt: 200,
          filterHouseId: "all",
        },
        fan: {
          foundIds: ["jon"],
          startedAt: 300,
          completedAt: null,
          filterHouseId: "all",
        },
        expert: {
          foundIds: ["ros"],
          startedAt: 400,
          completedAt: null,
          filterHouseId: "all",
        },
      },
    }),
  });
  const state = loadProgressState(
    storage,
    levelIds,
    rosterIdsByLevel,
    "expert",
  );

  assert.deepEqual(state.levels.newcomer.foundIds, ["arya"]);
  assert.deepEqual(state.levels.fan.foundIds, ["arya", "jon"]);
  assert.deepEqual(state.levels.expert.foundIds, ["arya", "jon", "ros"]);
});

test("reset clears shared progress from every level", () => {
  let state = createProgressState(levelIds);
  state = updateLevelProgress(
    state,
    "newcomer",
    {
      foundIds: ["arya"],
      startedAt: 100,
      completedAt: 200,
      filterHouseId: "house-stark",
    },
    rosterIdsByLevel,
  );
  state = updateLevelProgress(
    state,
    "fan",
    {
      foundIds: ["arya", "jon"],
      startedAt: 300,
      completedAt: null,
      filterHouseId: "all",
    },
    rosterIdsByLevel,
  );
  const reset = resetAllProgress(state);

  assert.deepEqual(reset.levels.newcomer, {
    foundIds: [],
    startedAt: null,
    completedAt: null,
    filterHouseId: "all",
  });
  assert.deepEqual(reset.levels.fan, reset.levels.newcomer);
  assert.deepEqual(reset.levels.expert, reset.levels.newcomer);
});

test("v1 state migrates into Expert and is removed after a successful save", () => {
  const storage = new FakeStorage({
    [V1_STORAGE_KEY]: JSON.stringify({
      foundIds: ["arya", "not-in-roster"],
      startedAt: 100,
      completedAt: null,
      filterHouseId: "house-stark",
    }),
  });
  const state = loadProgressState(
    storage,
    levelIds,
    rosterIdsByLevel,
    "expert",
  );

  assert.equal(state.activeDifficulty, null);
  assert.deepEqual(state.levels.expert.foundIds, ["arya"]);
  assert.deepEqual(state.levels.newcomer.foundIds, ["arya"]);
  assert.deepEqual(state.levels.fan.foundIds, ["arya"]);
  assert.equal(storage.getItem(V1_STORAGE_KEY), null);
  assert.notEqual(storage.getItem(V2_STORAGE_KEY), null);
});

test("v1 state remains when the v2 save fails", () => {
  const legacyValue = JSON.stringify({
    foundIds: ["arya"],
    startedAt: 100,
    completedAt: null,
    filterHouseId: "all",
  });
  const storage = new FakeStorage(
    { [V1_STORAGE_KEY]: legacyValue },
    true,
  );

  loadProgressState(storage, levelIds, rosterIdsByLevel, "expert");
  assert.equal(storage.getItem(V1_STORAGE_KEY), legacyValue);
  assert.equal(storage.getItem(V2_STORAGE_KEY), null);
});

test("completed v1 time is preserved when Expert gains new characters", () => {
  const storage = new FakeStorage({
    [V1_STORAGE_KEY]: JSON.stringify({
      foundIds: ["arya", "jon"],
      startedAt: 100,
      completedAt: 400,
      filterHouseId: "all",
    }),
  });
  const state = loadProgressState(
    storage,
    levelIds,
    rosterIdsByLevel,
    "expert",
    1_000,
  );

  assert.equal(state.levels.expert.startedAt, 700);
  assert.equal(state.levels.expert.completedAt, null);
  assert.deepEqual(state.levels.expert.foundIds, ["arya", "jon"]);
});

test("malformed v2 state fails closed", () => {
  const storage = new FakeStorage({
    [V2_STORAGE_KEY]: JSON.stringify({
      version: STORAGE_VERSION,
      activeDifficulty: "newcomer",
      levels: {
        newcomer: {
          foundIds: "arya",
          startedAt: "yesterday",
          completedAt: null,
          filterHouseId: "all",
        },
      },
    }),
  });
  const state = loadProgressState(
    storage,
    levelIds,
    rosterIdsByLevel,
    "expert",
  );

  assert.deepEqual(state.levels.newcomer.foundIds, []);
  assert.equal(state.levels.newcomer.startedAt, null);
  assert.deepEqual(state.levels.fan.foundIds, []);
});

test("unversioned v2 state fails closed", () => {
  const storage = new FakeStorage({
    [V2_STORAGE_KEY]: JSON.stringify({
      activeDifficulty: "newcomer",
      levels: {},
    }),
  });
  const state = loadProgressState(
    storage,
    levelIds,
    rosterIdsByLevel,
    "expert",
  );

  assert.equal(state.version, STORAGE_VERSION);
  assert.equal(state.activeDifficulty, null);
  assert.deepEqual(state.levels.expert.foundIds, []);
});

test("malformed v1 state is not migrated or removed", () => {
  const legacyValue = JSON.stringify({
    foundIds: "arya",
    startedAt: 100,
    completedAt: null,
    filterHouseId: "all",
  });
  const storage = new FakeStorage({ [V1_STORAGE_KEY]: legacyValue });
  const state = loadProgressState(
    storage,
    levelIds,
    rosterIdsByLevel,
    "expert",
  );

  assert.equal(state.activeDifficulty, null);
  assert.deepEqual(state.levels.expert.foundIds, []);
  assert.equal(storage.getItem(V1_STORAGE_KEY), legacyValue);
  assert.equal(storage.getItem(V2_STORAGE_KEY), null);
});
