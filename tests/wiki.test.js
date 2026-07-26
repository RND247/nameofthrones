import assert from "node:assert/strict";
import test from "node:test";

import { buildWikiUrl } from "../src/wiki.js";

test("wiki links search for the character's canonical name", () => {
  const url = new URL(
    buildWikiUrl({
      name: "Arya Stark",
      acceptedNames: ["Arya Underfoot"],
    }),
  );

  assert.equal(url.hostname, "awoiaf.westeros.org");
  assert.equal(url.searchParams.get("title"), "Special:Search");
  assert.equal(url.searchParams.get("search"), "Arya Stark");
  assert.equal(url.searchParams.get("go"), "Go");
});

test("numbered characters use their full family alias", () => {
  const url = new URL(
    buildWikiUrl({
      name: "Aegon I",
      acceptedNames: ["Aegon the Conqueror", "Aegon I Targaryen"],
    }),
  );

  assert.equal(url.searchParams.get("search"), "Aegon I Targaryen");
});

test("trusted Wiki of Ice and Fire links are used directly", () => {
  assert.equal(
    buildWikiUrl({
      name: "Hodor",
      acceptedNames: [],
      overrideSourceUrl: "https://awoiaf.westeros.org/index.php/Hodor",
    }),
    "https://awoiaf.westeros.org/index.php/Hodor",
  );
});

test("unsafe direct links are replaced with a trusted wiki search", () => {
  const url = new URL(
    buildWikiUrl({
      name: "Jon Snow",
      acceptedNames: [],
      overrideSourceUrl: "https://example.com/redirect",
    }),
  );

  assert.equal(url.hostname, "awoiaf.westeros.org");
  assert.equal(url.searchParams.get("search"), "Jon Snow");
  assert.equal(buildWikiUrl(null), null);
});
