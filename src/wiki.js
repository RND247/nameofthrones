const WIKI_HOST = "awoiaf.westeros.org";
const WIKI_SEARCH_URL = `https://${WIKI_HOST}/index.php`;
const REGNAL_NAME = /^.+\s+[IVXLCDM]+$/u;

export function buildWikiUrl(character) {
  if (
    character === null ||
    typeof character !== "object" ||
    typeof character.name !== "string" ||
    !character.name.trim()
  ) {
    return null;
  }

  const directUrl = getTrustedDirectUrl(character.overrideSourceUrl);
  if (directUrl !== null) {
    return directUrl;
  }

  const searchName = getSearchName(character);
  const parameters = new URLSearchParams({
    go: "Go",
    search: searchName,
    title: "Special:Search",
  });
  return `${WIKI_SEARCH_URL}?${parameters.toString()}`;
}

function getTrustedDirectUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === WIKI_HOST &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function getSearchName(character) {
  const name = character.name.trim();
  if (!REGNAL_NAME.test(name) || !Array.isArray(character.acceptedNames)) {
    return name;
  }

  const fullRegnalName = character.acceptedNames.find((acceptedName) => {
    if (typeof acceptedName !== "string") {
      return false;
    }
    return acceptedName
      .trim()
      .toLocaleLowerCase("en-US")
      .startsWith(`${name.toLocaleLowerCase("en-US")} `);
  });
  return fullRegnalName?.trim() || name;
}
