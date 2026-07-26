import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseLocationGroups,
  remapCharacterGroups,
} from "../src/groups.js";

const groups = [
  {
    id: "baratheon-dragonstone",
    name: "House Baratheon of Dragonstone",
    kind: "house",
    region: "The Crownlands",
    major: true,
    source: {},
  },
  {
    id: "baratheon-kings-landing",
    name: "House Baratheon of King's Landing",
    kind: "house",
    region: "The Crownlands",
    major: true,
    source: {},
  },
  {
    id: "baratheon-storms-end",
    name: "House Baratheon of Storm's End",
    kind: "house",
    region: "The Stormlands",
    major: true,
    source: {},
  },
  {
    id: "stark-winterfell",
    name: "House Stark of Winterfell",
    kind: "house",
    region: "The North",
    major: true,
    source: {},
  },
  {
    id: "group-free-folk",
    name: "Free Folk",
    kind: "fallback",
    region: "Beyond the Wall",
    major: false,
    source: null,
  },
];

test("location branches collapse into one house", () => {
  const result = collapseLocationGroups(groups);
  const baratheonGroups = result.groups.filter(
    (group) => group.name === "House Baratheon",
  );

  assert.equal(baratheonGroups.length, 1);
  assert.equal(baratheonGroups[0].id, "display-house-baratheon");
  assert.equal(baratheonGroups[0].region, null);
  assert.equal(
    result.groupIdBySourceId.get("baratheon-dragonstone"),
    "display-house-baratheon",
  );
  assert.equal(
    result.groupIdBySourceId.get("baratheon-storms-end"),
    "display-house-baratheon",
  );
});

test("characters from location branches move into the collapsed house", () => {
  const collapsed = collapseLocationGroups(groups);
  const characters = [
    {
      id: "stannis",
      primaryHouseId: "baratheon-dragonstone",
      houseIds: ["baratheon-dragonstone"],
    },
    {
      id: "renly",
      primaryHouseId: "baratheon-storms-end",
      houseIds: ["baratheon-storms-end"],
    },
  ];
  const remapped = remapCharacterGroups(
    characters,
    collapsed.groupIdBySourceId,
  );

  assert.deepEqual(
    remapped.map((character) => character.primaryHouseId),
    ["display-house-baratheon", "display-house-baratheon"],
  );
});

test("known houses stay ahead of fallback and minor groups", () => {
  const result = collapseLocationGroups(groups);

  assert.deepEqual(
    result.groups.map((group) => group.name),
    ["House Stark", "House Baratheon", "Free Folk"],
  );
});
