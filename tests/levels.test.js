import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCharacterOverrides,
  buildLevelRosters,
  combineCharacters,
  validateCharacterPayload,
  validateLevelPayload,
} from "../src/levels.js";

const groups = new Set(["house-stark", "group-unaffiliated"]);
const arya = {
  id: "arya",
  name: "Arya Stark",
  accepted_names: ["Arya Stark", "Cat of the Canals"],
  group_id: "house-stark",
  house_ids: ["house-stark"],
  book_ids: ["book-1"],
  portrait_path: null,
  source: {},
};
const levelsPayload = {
  schema_version: 1,
  sources: [],
  levels: [
    {
      id: "newcomer",
      name: "Newcomer",
      description: "A short list.",
      target_count: 1,
      character_ids: ["arya"],
    },
    {
      id: "fan",
      name: "Fan",
      description: "A longer list.",
      target_count: 2,
      character_ids: ["arya", "jon"],
    },
    {
      id: "expert",
      name: "Expert",
      description: "Every character.",
      include_all: true,
    },
  ],
};

test("level validation requires the exact nested level structure", () => {
  const levels = validateLevelPayload(levelsPayload);

  assert.equal(levels.length, 3);
  assert.deepEqual(levels[0].characterIds, ["arya"]);
  assert.equal(levels[2].includeAll, true);
  assert.deepEqual(
    validateLevelPayload({
      schema_version: 1,
      sources: [],
      target_count: 1,
      character_ids: ["arya"],
    }),
    [],
  );
});

test("level validation rejects mismatched counts and mixed Expert fields", () => {
  const mismatched = structuredClone(levelsPayload);
  mismatched.levels[0].target_count = 2;
  const mixedExpert = structuredClone(levelsPayload);
  mixedExpert.levels[2].character_ids = ["arya"];

  assert.deepEqual(validateLevelPayload(mismatched), []);
  assert.deepEqual(validateLevelPayload(mixedExpert), []);
});

test("character validation maps snake case records", () => {
  const characters = validateCharacterPayload(
    {
      schema_version: 1,
      characters: [arya],
    },
    groups,
  );

  assert.equal(characters.length, 1);
  assert.equal(characters[0].primaryHouseId, "house-stark");
  assert.deepEqual(characters[0].acceptedNames, [
    "Arya Stark",
    "Cat of the Canals",
  ]);
});

test("existing and show-only characters combine without duplicate IDs", () => {
  const existing = validateCharacterPayload(
    { schema_version: 1, characters: [arya] },
    groups,
  );
  const showOnly = validateCharacterPayload(
    {
      schema_version: 1,
      characters: [
        {
          ...arya,
          id: "show-only",
          name: "Ros",
          accepted_names: ["Ros"],
          group_id: "group-unaffiliated",
          house_ids: [],
          book_ids: [],
          tv_seasons: [1, 2, 3],
          media_scope: "show",
        },
        { ...arya, name: "Duplicate Arya" },
      ],
    },
    groups,
  );

  const combined = combineCharacters(existing, showOnly);
  assert.deepEqual(
    combined.map((character) => character.id),
    ["arya", "show-only"],
  );
  assert.equal(combined[0].name, "Arya Stark");
});

test("alias and display-name overrides apply to reviewed characters", () => {
  const characters = validateCharacterPayload(
    { schema_version: 1, characters: [arya] },
    groups,
  );
  const overridden = applyCharacterOverrides(characters, {
    schema_version: 1,
    overrides: [
      {
        id: "arya",
        name_override: "Arya Stark of Winterfell",
        accepted_names_add: ["Arry"],
        source_url: "https://gameofthrones.fandom.com/wiki/Arya_Stark",
      },
    ],
  });

  assert.deepEqual(overridden[0].acceptedNames, [
    "Arya Stark",
    "Cat of the Canals",
    "Arry",
  ]);
  assert.equal(overridden[0].name, "Arya Stark of Winterfell");
});

test("malformed overrides fail closed", () => {
  const characters = validateCharacterPayload(
    { schema_version: 1, characters: [arya] },
    groups,
  );

  assert.deepEqual(
    applyCharacterOverrides(characters, {
      schema_version: 1,
      overrides: [
        {
          id: "arya",
          accepted_names_add: [],
          name_override: " ",
          source_url: "https://gameofthrones.fandom.com/wiki/Arya_Stark",
        },
      ],
    }),
    [],
  );
  assert.deepEqual(
    applyCharacterOverrides(characters, {
      schema_version: 1,
      overrides: [
        {
          id: "missing",
          accepted_names_add: ["Missing Person"],
          source_url: "https://gameofthrones.fandom.com/wiki/Missing",
        },
      ],
    }),
    [],
  );
  assert.deepEqual(
    applyCharacterOverrides(characters, {
      schema_version: 1,
      overrides: [
        {
          id: "arya",
          accepted_names_add: ["Arry", "arry"],
          source_url:
            "https://gameofthrones.fandom.com:443?source=reviewed",
        },
      ],
    }),
    [],
  );
  assert.deepEqual(
    applyCharacterOverrides(characters, {
      schema_version: 1,
      overrides: [
        {
          id: "arya",
          accepted_names_add: ["<Arya>"],
          source_url: "https://gameofthrones.fandom.com/wiki/Arya_Stark",
        },
      ],
    }),
    [],
  );
});

test("name-only overrides are valid and unsafe sources fail closed", () => {
  const characters = validateCharacterPayload(
    { schema_version: 1, characters: [arya] },
    groups,
  );
  const renamed = applyCharacterOverrides(characters, {
    schema_version: 1,
    overrides: [
      {
        id: "arya",
        name_override: "Arya Stark of Winterfell",
        source_url: "https://gameofthrones.fandom.com/wiki/Arya_Stark",
      },
    ],
  });

  assert.equal(renamed[0].name, "Arya Stark of Winterfell");
  assert.deepEqual(
    applyCharacterOverrides(characters, {
      schema_version: 1,
      overrides: [
        {
          id: "arya",
          accepted_names_add: [""],
          source_url: "https://example.test/arya",
        },
      ],
    }),
    [],
  );
});

test("Expert includes all combined characters", () => {
  const levels = validateLevelPayload(levelsPayload);
  const characters = validateCharacterPayload(
    {
      schema_version: 1,
      characters: [
        arya,
        {
          ...arya,
          id: "jon",
          name: "Jon Snow",
          accepted_names: ["Jon Snow"],
        },
        {
          ...arya,
          id: "show-only",
          name: "Ros",
          accepted_names: ["Ros"],
          group_id: "group-unaffiliated",
        },
      ],
    },
    groups,
  );
  const rosters = buildLevelRosters(levels, characters);

  assert.deepEqual(
    rosters.get("newcomer").map((character) => character.id),
    ["arya"],
  );
  assert.deepEqual(
    rosters.get("expert").map((character) => character.id),
    ["arya", "jon", "show-only"],
  );
});
