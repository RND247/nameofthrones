import {
  buildNameIndex,
  matchExactName,
} from "./matcher.js";

const STORAGE_KEY = "nameOfThrones:v1:game";
const DEFAULT_PORTRAIT = "./assets/placeholders/default.svg";
const PORTRAIT_ASSET_ROOT = "./assets/";
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const LOCAL_PATH_PATTERN = /^[a-z0-9_./-]+$/i;
const HOUSE_PLACEHOLDERS = Object.freeze([
  ["arryn", "./assets/placeholders/arryn.svg"],
  ["baratheon", "./assets/placeholders/baratheon.svg"],
  ["greyjoy", "./assets/placeholders/greyjoy.svg"],
  ["lannister", "./assets/placeholders/lannister.svg"],
  ["martell", "./assets/placeholders/martell.svg"],
  ["stark", "./assets/placeholders/stark.svg"],
  ["targaryen", "./assets/placeholders/targaryen.svg"],
  ["tully", "./assets/placeholders/tully.svg"],
  ["tyrell", "./assets/placeholders/tyrell.svg"],
]);
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
const elements = {
  filterList: getRequiredElement("house-filters"),
  form: getRequiredElement("name-form"),
  foundCount: getRequiredElement("found-count"),
  houseList: getRequiredElement("house-list"),
  input: getRequiredElement("name-input"),
  loadingState: getRequiredElement("loading-state"),
  message: getRequiredElement("guess-message"),
  progress: getRequiredElement("game-progress"),
  progressLabel: getRequiredElement("progress-label"),
  resetButton: getRequiredElement("reset-button"),
  timer: getRequiredElement("timer"),
  totalCount: getRequiredElement("total-count"),
};

const state = {
  cardsByCharacterId: new Map(),
  characters: [],
  charactersById: new Map(),
  charactersByGroupId: new Map(),
  completedAt: null,
  filterHouseId: "all",
  foundIds: new Set(),
  houses: [],
  nameIndex: new Map(),
  startedAt: null,
  timerIntervalId: null,
};

let resetConfirmationTimeoutId = null;
let skipNextEmptySubmit = false;

elements.form.addEventListener("submit", handleGuess);
elements.input.addEventListener("input", handleGuessInput);
elements.resetButton.addEventListener("click", handleResetClick);

initialize();

async function initialize() {
  try {
    const [housesPayload, charactersPayload] = await Promise.all([
      loadJson("./data/houses.json"),
      loadJson("./data/characters.json"),
    ]);
    const allGroups = uniqueById(
      extractCollection(housesPayload, "groups")
        .map(validateGroup)
        .filter(Boolean),
    );
    const groupIds = new Set(allGroups.map((group) => group.id));
    const characters = uniqueById(
      extractCollection(charactersPayload, "characters")
        .map((character) => validateCharacter(character, groupIds))
        .filter(Boolean),
    );
    const populatedGroupIds = new Set(
      characters.map((character) => character.primaryHouseId),
    );
    const groups = allGroups
      .filter((group) => populatedGroupIds.has(group.id))
      .sort(compareGroups);

    if (groups.length === 0 || characters.length === 0) {
      throw new Error("The archive data is empty or invalid.");
    }

    state.houses = groups;
    state.characters = characters;
    state.charactersById = new Map(
      characters.map((character) => [character.id, character]),
    );
    state.charactersByGroupId = groupCharacters(characters);
    state.nameIndex = buildNameIndex(characters);

    restoreProgress();
    renderFilters();
    renderHouses();
    updateInterface();
    startTimerUpdates();
    elements.loadingState.hidden = true;
  } catch {
    elements.loadingState.textContent =
      "The archives could not be opened. Please refresh and try again.";
    elements.loadingState.classList.add("state-message-error");
    elements.input.disabled = true;
    elements.form.querySelector("button").disabled = true;
  }
}

async function loadJson(path) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Data request failed with status ${response.status}.`);
  }

  return response.json();
}

function extractCollection(payload, key) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (
    payload !== null &&
    typeof payload === "object" &&
    Array.isArray(payload[key])
  ) {
    return payload[key];
  }

  return [];
}

function uniqueById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function validateGroup(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.kind !== "string" ||
    value.kind.trim().length === 0 ||
    (value.region !== null && typeof value.region !== "string") ||
    typeof value.major !== "boolean" ||
    (value.source !== null && typeof value.source !== "object")
  ) {
    return null;
  }

  return Object.freeze({
    id: value.id,
    name: value.name.trim(),
    kind: value.kind.trim(),
    region: typeof value.region === "string" ? value.region.trim() : null,
    major: value.major,
    source: value.source,
  });
}

function validateCharacter(value, groupIds) {
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
    !groupIds.has(value.group_id) ||
    !Array.isArray(value.house_ids) ||
    !value.house_ids.every((id) => typeof id === "string") ||
    !Array.isArray(value.book_ids) ||
    !value.book_ids.every((id) => typeof id === "string") ||
    (value.portrait_path !== null &&
      typeof value.portrait_path !== "string") ||
    (value.source !== null && typeof value.source !== "object")
  ) {
    return null;
  }

  return Object.freeze({
    id: value.id,
    name: value.name.trim(),
    acceptedNames: Object.freeze([...value.accepted_names]),
    primaryHouseId: value.group_id,
    houseIds: Object.freeze(
      value.house_ids.filter((houseId) => groupIds.has(houseId)),
    ),
    bookIds: Object.freeze([...value.book_ids]),
    portraitPath:
      typeof value.portrait_path === "string"
        ? value.portrait_path.trim()
        : null,
    source: value.source,
  });
}

function compareGroups(left, right) {
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

function getFamousHouseRank(name) {
  const words = name.toLocaleLowerCase("en-US").match(/\p{L}+/gu) ?? [];
  const index = FAMOUS_HOUSE_ORDER.findIndex((houseName) =>
    words.includes(houseName),
  );
  return index === -1 ? FAMOUS_HOUSE_ORDER.length : index;
}

function groupCharacters(characters) {
  const charactersByGroupId = new Map();

  for (const character of characters) {
    const members =
      charactersByGroupId.get(character.primaryHouseId) ?? [];
    members.push(character);
    charactersByGroupId.set(character.primaryHouseId, members);
  }

  return charactersByGroupId;
}

function restoreProgress() {
  let savedState;

  try {
    savedState = JSON.parse(readProgressStorage() ?? "null");
  } catch {
    clearProgressStorage();
    return;
  }

  if (savedState === null || typeof savedState !== "object") {
    return;
  }

  if (Array.isArray(savedState.foundIds)) {
    state.foundIds = new Set(
      savedState.foundIds.filter((id) => state.charactersById.has(id)),
    );
  }

  if (Number.isFinite(savedState.startedAt) && savedState.startedAt > 0) {
    state.startedAt = savedState.startedAt;
  }

  if (
    Number.isFinite(savedState.completedAt) &&
    savedState.completedAt >= state.startedAt
  ) {
    state.completedAt = savedState.completedAt;
  }

  if (
    savedState.filterHouseId === "all" ||
    state.houses.some((house) => house.id === savedState.filterHouseId)
  ) {
    state.filterHouseId = savedState.filterHouseId;
  }

  if (
    state.foundIds.size !== state.characters.length &&
    state.completedAt !== null
  ) {
    state.completedAt = null;
  }
}

function saveProgress() {
  const savedState = {
    completedAt: state.completedAt,
    filterHouseId: state.filterHouseId,
    foundIds: [...state.foundIds],
    startedAt: state.startedAt,
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedState));
  } catch {
    setMessage("Progress could not be saved in this browser.", "warning");
  }
}

function readProgressStorage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearProgressStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The game still works when browser storage is blocked.
  }
}

function renderFilters() {
  elements.filterList.replaceChildren();
  elements.filterList.append(createFilterButton("all", "All houses"));

  for (const group of state.houses) {
    elements.filterList.append(createFilterButton(group.id, group.name));
  }
}

function createFilterButton(houseId, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "filter-button";
  button.textContent = label;
  button.dataset.houseId = houseId;
  button.setAttribute(
    "aria-pressed",
    String(state.filterHouseId === houseId),
  );
  button.addEventListener("click", () => {
    state.filterHouseId = houseId;
    applyHouseFilter();
    saveProgress();
  });
  return button;
}

function renderHouses() {
  elements.houseList.replaceChildren();
  state.cardsByCharacterId.clear();

  for (const house of state.houses) {
    const houseCharacters = state.charactersByGroupId.get(house.id) ?? [];
    const section = document.createElement("details");
    section.className = "house-section";
    section.dataset.houseId = house.id;
    section.open = house.major || house.kind === "fallback";

    const summary = document.createElement("summary");
    const crest = document.createElement("span");
    crest.className = "house-crest";
    crest.textContent = getHouseMark(house);
    crest.setAttribute("aria-hidden", "true");

    const heading = document.createElement("span");
    heading.className = "house-heading";
    const name = document.createElement("strong");
    name.textContent = house.name;
    const words = document.createElement("span");
    words.textContent = getGroupDescription(house);
    heading.append(name, words);

    const count = document.createElement("span");
    count.className = "house-count";
    count.dataset.houseCount = house.id;
    summary.append(crest, heading, count);

    const cards = document.createElement("div");
    cards.className = "character-grid";

    for (const character of houseCharacters) {
      const card = createCharacterCard(character, house);
      const existingCards = state.cardsByCharacterId.get(character.id) ?? [];
      existingCards.push(card);
      state.cardsByCharacterId.set(character.id, existingCards);
      cards.append(card);
    }

    section.append(summary, cards);
    elements.houseList.append(section);
  }

  applyHouseFilter();
}

function createCharacterCard(character, house) {
  const card = document.createElement("article");
  card.className = "character-card";

  if (state.foundIds.has(character.id)) {
    populateRevealedCard(card, character, house);
  } else {
    populateHiddenCard(card, house);
  }

  return card;
}

function populateHiddenCard(card, house) {
  card.replaceChildren();
  card.classList.remove("character-card-revealed");

  const silhouette = document.createElement("div");
  silhouette.className = "silhouette";
  silhouette.setAttribute("aria-hidden", "true");
  const mark = document.createElement("span");
  mark.className = "silhouette-mark";
  mark.textContent = getHouseMark(house);
  silhouette.append(mark);

  const hiddenName = document.createElement("p");
  hiddenName.className = "hidden-name";
  hiddenName.textContent = "Name not yet claimed";
  card.append(silhouette, hiddenName);
}

function populateRevealedCard(card, character, house) {
  card.replaceChildren();
  card.classList.add("character-card-revealed");

  const portrait = document.createElement("img");
  portrait.className = "portrait";
  portrait.alt = `Portrait of ${character.name}`;
  portrait.loading = "lazy";
  portrait.decoding = "async";
  const portraitCandidates = getPortraitCandidates(character, house);
  let portraitCandidateIndex = 0;
  portrait.src = portraitCandidates[portraitCandidateIndex];
  portrait.addEventListener("error", () => {
    portraitCandidateIndex += 1;
    if (portraitCandidateIndex < portraitCandidates.length) {
      portrait.src = portraitCandidates[portraitCandidateIndex];
    }
  });

  const details = document.createElement("div");
  details.className = "character-details";
  const name = document.createElement("h3");
  name.textContent = character.name;
  const allegiance = document.createElement("p");
  allegiance.textContent = house.name;
  details.append(name, allegiance);
  card.append(portrait, details);
}

function getPortraitCandidates(character, house) {
  const candidates = [];

  if (
    typeof character.portraitPath === "string" &&
    isSafeLocalPath(character.portraitPath)
  ) {
    candidates.push(`${PORTRAIT_ASSET_ROOT}${character.portraitPath}`);
  }

  candidates.push(getHousePlaceholder(house), DEFAULT_PORTRAIT);
  return [...new Set(candidates)];
}

function getHousePlaceholder(house) {
  const houseNameWords =
    house.name.toLocaleLowerCase("en-US").match(/\p{L}+/gu) ?? [];
  const placeholder = HOUSE_PLACEHOLDERS.find(([houseName]) =>
    houseNameWords.includes(houseName),
  );
  return placeholder?.[1] ?? DEFAULT_PORTRAIT;
}

function isSafeLocalPath(path) {
  return (
    path.length > 0 &&
    LOCAL_PATH_PATTERN.test(path) &&
    !path.startsWith("/") &&
    !path.includes("..")
  );
}

function getHouseMark(house) {
  const words = house.name.trim().split(/\s+/u);
  const initials = words
    .filter((word) => word.length > 0)
    .slice(-2)
    .map((word) => word[0])
    .join("");
  return initials.toLocaleUpperCase("en-US") || "•";
}

function getGroupDescription(group) {
  const kind =
    group.kind.length > 0
      ? `${group.kind[0].toLocaleUpperCase("en-US")}${group.kind.slice(1)}`
      : "Group";
  return [group.region, kind].filter(Boolean).join(" · ");
}

function handleGuess(event) {
  event.preventDefault();
  if (skipNextEmptySubmit && !elements.input.value.trim()) {
    skipNextEmptySubmit = false;
    return;
  }

  skipNextEmptySubmit = false;
  processGuess(elements.input.value, {
    announceAlreadyFound: true,
    announceNoMatch: true,
  });
}

function handleGuessInput() {
  skipNextEmptySubmit = false;
  const guess = elements.input.value;
  if (!guess.trim()) {
    return;
  }

  if (state.startedAt === null) {
    state.startedAt = Date.now();
  }

  const matchedIds = matchExactName(guess, state.nameIndex);
  if (matchedIds.length === 0) {
    return;
  }

  if (
    processGuess(guess, {
      announceAlreadyFound: false,
      announceNoMatch: false,
      matchedIds,
    })
  ) {
    skipNextEmptySubmit = true;
  }
}

function processGuess(
  guess,
  { announceAlreadyFound, announceNoMatch, matchedIds = null },
) {
  if (!guess.trim()) {
    if (announceNoMatch) {
      setMessage("Enter a full character name.", "error");
      elements.input.focus();
    }
    return false;
  }

  if (state.startedAt === null) {
    state.startedAt = Date.now();
  }

  const exactMatchIds = matchedIds ?? matchExactName(guess, state.nameIndex);
  const newlyFoundIds = exactMatchIds.filter((id) => !state.foundIds.has(id));

  if (exactMatchIds.length === 0) {
    if (announceNoMatch) {
      setMessage("No exact match. Check the full name and try again.", "error");
      saveProgress();
    }
    return false;
  }

  if (newlyFoundIds.length === 0) {
    if (announceAlreadyFound) {
      setMessage("That name has already been claimed.", "warning");
      elements.input.select();
    }
    return false;
  }

  for (const id of newlyFoundIds) {
    state.foundIds.add(id);
    revealCharacter(id);
  }

  if (state.foundIds.size === state.characters.length) {
    state.completedAt = Date.now();
  }

  const revealedNames = newlyFoundIds
    .map((id) => state.charactersById.get(id)?.name)
    .filter(Boolean);
  setMessage(`Revealed: ${revealedNames.join(", ")}.`, "success");
  elements.input.value = "";
  updateInterface();
  saveProgress();
  elements.input.focus({ preventScroll: true });
  scrollToRevealedCharacter(newlyFoundIds[0]);
  return true;
}

function revealCharacter(characterId) {
  const character = state.charactersById.get(characterId);
  if (!character) {
    return;
  }

  const house = state.houses.find(
    (candidate) => candidate.id === character.primaryHouseId,
  );
  if (!house) {
    return;
  }

  for (const card of state.cardsByCharacterId.get(characterId) ?? []) {
    populateRevealedCard(card, character, house);
    card.classList.remove("reveal-pulse");
    requestAnimationFrame(() => card.classList.add("reveal-pulse"));
  }
}

function scrollToRevealedCharacter(characterId) {
  const card = state.cardsByCharacterId.get(characterId)?.[0];
  if (!card) {
    return;
  }

  const section = card.closest(".house-section");
  if (section instanceof HTMLDetailsElement) {
    section.open = true;
    if (section.hidden && typeof section.dataset.houseId === "string") {
      state.filterHouseId = section.dataset.houseId;
      applyHouseFilter();
      saveProgress();
    }
  }

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      card.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
    });
  });
}

function updateInterface() {
  const foundCount = state.foundIds.size;
  const totalCount = state.characters.length;
  const percent = totalCount === 0 ? 0 : (foundCount / totalCount) * 100;

  elements.foundCount.textContent = String(foundCount);
  elements.totalCount.textContent = String(totalCount);
  elements.progress.max = Math.max(totalCount, 1);
  elements.progress.value = foundCount;
  elements.progress.textContent = `${Math.round(percent)}%`;
  elements.progressLabel.textContent = `${Math.round(percent)}%`;

  for (const house of state.houses) {
    const houseCharacters = state.charactersByGroupId.get(house.id) ?? [];
    const houseFoundCount = houseCharacters.filter((character) =>
      state.foundIds.has(character.id),
    ).length;
    const count = elements.houseList.querySelector(
      `[data-house-count="${house.id}"]`,
    );
    if (count) {
      count.textContent = `${houseFoundCount}/${houseCharacters.length}`;
      count.setAttribute(
        "aria-label",
        `${houseFoundCount} of ${houseCharacters.length} names found`,
      );
    }
  }

  if (totalCount > 0 && foundCount === totalCount) {
    setMessage("The realm is complete. Every recorded name is yours.", "success");
  }

  updateTimer();
}

function applyHouseFilter() {
  for (const section of elements.houseList.querySelectorAll(".house-section")) {
    section.hidden =
      state.filterHouseId !== "all" &&
      section.dataset.houseId !== state.filterHouseId;
  }

  for (const button of elements.filterList.querySelectorAll(".filter-button")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.houseId === state.filterHouseId),
    );
  }
}

function startTimerUpdates() {
  updateTimer();
  if (state.timerIntervalId === null) {
    state.timerIntervalId = window.setInterval(updateTimer, 1000);
  }
}

function updateTimer() {
  const endTime = state.completedAt ?? Date.now();
  const elapsedMilliseconds =
    state.startedAt === null ? 0 : Math.max(0, endTime - state.startedAt);
  const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);
  elements.timer.textContent = formatDuration(elapsedSeconds);
  elements.timer.dateTime = `PT${elapsedSeconds}S`;
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteSeconds = `${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")}`;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${minuteSeconds}`
    : minuteSeconds;
}

function handleResetClick() {
  if (elements.resetButton.dataset.confirming !== "true") {
    elements.resetButton.dataset.confirming = "true";
    elements.resetButton.textContent = "Confirm reset";
    setMessage("Select Confirm reset to erase your progress.", "warning");
    resetConfirmationTimeoutId = window.setTimeout(
      cancelResetConfirmation,
      5000,
    );
    return;
  }

  if (resetConfirmationTimeoutId !== null) {
    window.clearTimeout(resetConfirmationTimeoutId);
  }
  cancelResetConfirmation();

  state.foundIds.clear();
  state.startedAt = null;
  state.completedAt = null;
  clearProgressStorage();

  for (const character of state.characters) {
    const house = state.houses.find(
      (candidate) => candidate.id === character.primaryHouseId,
    );
    if (!house) {
      continue;
    }
    for (const card of state.cardsByCharacterId.get(character.id) ?? []) {
      populateHiddenCard(card, house);
    }
  }

  updateInterface();
  setMessage("Game reset. The names are hidden again.", "success");
  elements.input.value = "";
  elements.input.focus();
}

function cancelResetConfirmation() {
  elements.resetButton.dataset.confirming = "false";
  elements.resetButton.textContent = "Reset game";
  resetConfirmationTimeoutId = null;
}

function setMessage(message, type) {
  elements.message.textContent = message;
  elements.message.dataset.type = type;
}

function getRequiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required interface element is missing: ${id}`);
  }
  return element;
}
