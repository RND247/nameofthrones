import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNameIndex,
  buildSuggestionIndex,
  findClosestName,
  matchExactName,
  normalizeName,
} from "../src/matcher.js";

const characters = [
  {
    id: "arya-stark",
    name: "Arya Stark",
    acceptedNames: ["Arya Underfoot", "Cat of the Canals"],
  },
  {
    id: "sandor-clegane",
    name: "Sandor Clegane",
    acceptedNames: ["The Hound"],
  },
  {
    id: "hound-legacy",
    name: "Hound Legacy",
    acceptedNames: ["The Hound", "The Hound"],
  },
  {
    id: "oberyn-martell",
    name: "Oberyn Nymeros Martell",
    acceptedNames: ["The Red Viper"],
  },
  {
    id: "dunk",
    name: "Duncan the Tall",
    acceptedNames: ["Dunk’s the lunk", "Ser Duncan-the-Tall"],
  },
];

test("normalizeName handles case, outside whitespace, and repeated whitespace", () => {
  assert.equal(
    normalizeName("  ARYA \t  Stark\n"),
    "arya stark",
  );
});

test("normalizeName removes Unicode diacritics", () => {
  assert.equal(
    normalizeName("Sér Jóráh Mörmont"),
    "ser jorah mormont",
  );
});

test("normalizeName standardizes curly apostrophes and Unicode hyphens", () => {
  assert.equal(normalizeName("DUNK’S THE LUNK"), "dunk's the lunk");
  assert.equal(
    normalizeName("Ser Duncan \u2013 the \u2014 Tall"),
    "ser duncan-the-tall",
  );
});

test("normalizeName handles punctuation without using it as a pattern", () => {
  assert.equal(
    normalizeName("Oberyn, Nymeros (Martell)!"),
    "oberyn nymeros martell",
  );
  assert.equal(normalizeName(null), "");
});

test("buildNameIndex includes canonical and accepted names", () => {
  const index = buildNameIndex(characters);

  assert.deepEqual(matchExactName("ARYA   UNDERFOOT", index), ["arya-stark"]);
  assert.deepEqual(matchExactName("Oberyn Nymeros Martell", index), [
    "oberyn-martell",
  ]);
});

test("one accepted name can reveal more than one character", () => {
  const index = buildNameIndex(characters);

  assert.deepEqual(matchExactName("The Hound", index), [
    "sandor-clegane",
    "hound-legacy",
  ]);
});

test("a family name reveals every numbered character with that name", () => {
  const index = buildNameIndex(
    [
      {
        id: "aegon-first",
        name: "Aegon I",
        acceptedNames: ["Aegon the Conqueror"],
        primaryHouseId: "house-targaryen",
      },
      {
        id: "aegon-second",
        name: "Aegon II",
        acceptedNames: ["Aegon the Elder"],
        primaryHouseId: "house-targaryen",
      },
      {
        id: "young-griff",
        name: "Aegon Targaryen",
        acceptedNames: ["Young Griff"],
        primaryHouseId: "house-targaryen",
      },
    ],
    [
      {
        id: "house-targaryen",
        name: "House Targaryen of King's Landing",
      },
    ],
  );

  assert.deepEqual(matchExactName("Aegon Targaryen", index), [
    "aegon-first",
    "aegon-second",
    "young-griff",
  ]);
  assert.deepEqual(matchExactName("Aegon I Targaryen", index), [
    "aegon-first",
  ]);
});

test("duplicate accepted names do not duplicate character IDs", () => {
  const index = buildNameIndex(characters);

  assert.deepEqual(matchExactName("The Hound", index), [
    "sandor-clegane",
    "hound-legacy",
  ]);
});

test("matching stays exact after normalization", () => {
  const index = buildNameIndex(characters);

  assert.deepEqual(matchExactName("Arya", index), []);
  assert.deepEqual(matchExactName("Tall", index), []);
  assert.deepEqual(matchExactName("", index), []);
});

test("matching supports normalized apostrophes, hyphens, and punctuation", () => {
  const index = buildNameIndex(characters);

  assert.deepEqual(matchExactName("Dunk's the lunk", index), ["dunk"]);
  assert.deepEqual(matchExactName("Ser Duncan‑the‑Tall", index), ["dunk"]);
  assert.deepEqual(matchExactName("The Red Viper!", index), [
    "oberyn-martell",
  ]);
});

test("spelling suggestions correct close full-name guesses", () => {
  const suggestions = buildSuggestionIndex([
    ...characters,
    {
      id: "daenerys-targaryen",
      name: "Daenerys Targaryen",
      acceptedNames: ["Daenerys Stormborn"],
    },
  ]);

  assert.equal(
    findClosestName("daynerys targarian", suggestions),
    "Daenerys Targaryen",
  );
  assert.equal(findClosestName("Arya Strak", suggestions), "Arya Stark");
  assert.equal(
    findClosestName("Daenerys Stormbrn", suggestions),
    "Daenerys Stormborn",
  );
});

test("spelling suggestions do not complete partial or unrelated names", () => {
  const suggestions = buildSuggestionIndex(characters);

  assert.equal(findClosestName("Arya Stark", suggestions), null);
  assert.equal(findClosestName("Arya", suggestions), null);
  assert.equal(findClosestName("Arya Star", suggestions), null);
  assert.equal(findClosestName("Sand", suggestions), null);
  assert.equal(findClosestName("Completely Different", suggestions), null);
});

test("spelling suggestions fail closed for ambiguous and invalid input", () => {
  const suggestions = buildSuggestionIndex([
    { id: "one", name: "Mira Reed", acceptedNames: [] },
    { id: "two", name: "Myra Reed", acceptedNames: [] },
  ]);

  assert.equal(findClosestName("Mera Reed", suggestions), null);
  assert.equal(findClosestName("Arya Strak", null), null);
  assert.deepEqual(buildSuggestionIndex(null), []);
});

test("invalid collections and index values fail closed", () => {
  assert.equal(buildNameIndex(null).size, 0);
  assert.deepEqual(matchExactName("Arya Stark", null), []);
  assert.equal(
    buildNameIndex([
      null,
      { id: 42, name: "Wrong ID", acceptedNames: [] },
      { id: "", name: "Empty ID", acceptedNames: [] },
    ]).size,
    0,
  );
});
