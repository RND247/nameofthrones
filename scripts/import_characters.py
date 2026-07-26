#!/usr/bin/env python3
"""Build deterministic Name of Thrones character and house data.

The preferred source is A Wiki of Ice and Fire's MediaWiki API. The fallback
source is An API of Ice and Fire, which is useful when the wiki blocks API
traffic or cannot provide enough records. Only factual metadata is stored.
"""

import argparse
import hashlib
import html
import json
import os
import re
import stat
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath


WIKI_API_URL = "https://awoiaf.westeros.org/api.php"
WIKI_BASE_URL = "https://awoiaf.westeros.org"
ICE_AND_FIRE_API_URL = "https://anapioficeandfire.com/api"
DEFAULT_USER_AGENT = (
    "NameOfThronesDataImporter/1.0 "
    "(https://github.com/RND247/nameofthrones; data-import)"
)
DEFAULT_LIMIT = 1000
MAX_LIMIT = 3400
DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_FALLBACK_FILE_BYTES = 64 * 1024 * 1024
PAGE_SIZE = 50
SCHEMA_VERSION = 1

ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
NUMBER_AT_END_PATTERN = re.compile(r"/(\d+)/?$")
DISAMBIGUATION_PATTERN = re.compile(r"\s+\(([^()]*)\)\s*$")
HOUSE_CATEGORY_PATTERN = re.compile(
    r"^Category:(House [^:]+?)(?: members| retainers| household)?$",
    re.IGNORECASE,
)
UNNAMED_PATTERN = re.compile(
    r"^(?:unnamed|unknown|unidentified)(?:\b|$)|^(?:a|an|the) unnamed\b",
    re.IGNORECASE,
)
EXCLUDED_MARKERS = (
    "the ice dragon",
    "semi-canon",
    "semi canon",
    "game-only",
    "game only",
    "tv-only",
    "tv only",
    "television-only",
)
MAJOR_HOUSE_NAMES = {
    "house arryn",
    "house baratheon",
    "house bolton",
    "house frey",
    "house greyjoy",
    "house lannister",
    "house martell",
    "house stark",
    "house targaryen",
    "house tully",
    "house tyrell",
}
FALLBACK_GROUPS = (
    {
        "id": "group-citadel",
        "name": "The Citadel",
        "kind": "fallback",
        "region": "Oldtown",
        "major": False,
        "source": None,
    },
    {
        "id": "group-essos",
        "name": "Essos and the Free Cities",
        "kind": "fallback",
        "region": "Essos",
        "major": False,
        "source": None,
    },
    {
        "id": "group-faith",
        "name": "Faith of the Seven",
        "kind": "fallback",
        "region": "Westeros",
        "major": False,
        "source": None,
    },
    {
        "id": "group-free-folk",
        "name": "Free Folk",
        "kind": "fallback",
        "region": "Beyond the Wall",
        "major": False,
        "source": None,
    },
    {
        "id": "group-nights-watch",
        "name": "Night's Watch",
        "kind": "fallback",
        "region": "The Wall",
        "major": False,
        "source": None,
    },
    {
        "id": "group-unaffiliated",
        "name": "Unaffiliated and Unknown",
        "kind": "fallback",
        "region": None,
        "major": False,
        "source": None,
    },
)
BOOK_CATEGORY_MAP = {
    "a game of thrones": "agot",
    "a clash of kings": "acok",
    "a storm of swords": "asos",
    "a feast for crows": "affc",
    "a dance with dragons": "adwd",
    "the winds of winter": "twow",
    "a dream of spring": "ados",
    "the hedge knight": "thk",
    "the sworn sword": "tss",
    "the mystery knight": "tmk",
    "fire & blood": "fab",
    "fire and blood": "fab",
}
ESSOS_CULTURES = {
    "asshai",
    "astapor",
    "braavosi",
    "dothraki",
    "ghiscari",
    "ibbenese",
    "lysene",
    "meereenese",
    "myrish",
    "norvoshi",
    "qarth",
    "qohor",
    "summer isles",
    "tyroshi",
    "valyrian",
    "volantene",
}


class ImportFailure(RuntimeError):
    """Raised when an import source cannot produce a safe release."""


def normalized(value):
    """Return a stable comparison form for a string."""
    return unicodedata.normalize("NFKC", value).casefold().strip()


def clean_text(value, *, maximum=300, allow_empty=True):
    """Normalize and bound untrusted external text."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ImportFailure("External data contains a non-string text value")
    value = html.unescape(value)
    value = unicodedata.normalize("NFC", value)
    value = " ".join(value.split())
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise ImportFailure("External data contains a control character")
    if "<" in value or ">" in value:
        raise ImportFailure("External data contains markup in a factual field")
    if len(value) > maximum:
        value = value[:maximum].rstrip()
    if not allow_empty and not value:
        raise ImportFailure("External data contains an empty required field")
    return value


def clean_string_list(values, *, maximum_items=30, maximum_length=300):
    """Clean, deduplicate, and sort an external list of strings."""
    if not isinstance(values, list):
        raise ImportFailure("External data contains a non-list collection")
    result = []
    seen = set()
    for raw_value in values[:maximum_items]:
        value = clean_text(raw_value, maximum=maximum_length)
        key = normalized(value)
        if value and key not in seen:
            seen.add(key)
            result.append(value)
    return sorted(result, key=lambda item: (normalized(item), item))


def validate_https_url(url, allowed_hosts):
    """Validate a source URL and return its normalized form."""
    if not isinstance(url, str) or len(url) > 2048:
        raise ImportFailure("External data contains an invalid URL")
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.hostname not in allowed_hosts
        or parsed.fragment
    ):
        raise ImportFailure("External data contains an unapproved URL")
    return urllib.parse.urlunsplit(parsed)


def numeric_id_from_url(url, label):
    """Extract a positive numeric API object ID from a URL."""
    match = NUMBER_AT_END_PATTERN.search(url)
    if not match or int(match.group(1)) <= 0:
        raise ImportFailure("Invalid {} URL: {!r}".format(label, url))
    return int(match.group(1))


def is_named_character(name):
    """Reject blank and explicit placeholder names."""
    if not name or UNNAMED_PATTERN.search(name):
        return False
    lowered = normalized(name)
    return not any(marker in lowered for marker in EXCLUDED_MARKERS)


def validate_portrait_path(path):
    """Allow only safe project-relative image paths below portraits/."""
    if path is None:
        return True
    if not isinstance(path, str) or not path or len(path) > 240:
        return False
    if "\\" in path or "\x00" in path:
        return False
    parsed = urllib.parse.urlsplit(path)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        return False
    pure_path = PurePosixPath(path)
    if pure_path.is_absolute() or ".." in pure_path.parts or "." in pure_path.parts:
        return False
    if not pure_path.parts or pure_path.parts[0] != "portraits":
        return False
    return pure_path.suffix.casefold() in {".jpg", ".jpeg", ".png", ".webp"}


def load_existing_portrait_paths(path):
    """Read safe, non-null portrait paths from an existing character release."""
    path = Path(path)
    if path.is_symlink():
        raise ImportFailure("Refusing to read a symlinked character output")
    if not path.exists():
        return {}
    document = load_bounded_json_file(path)
    if not isinstance(document, dict) or not isinstance(
        document.get("characters"), list
    ):
        raise ImportFailure(
            "Existing character output has no valid characters array"
        )
    portrait_paths = {}
    seen_ids = set()
    for index, character in enumerate(document["characters"]):
        if not isinstance(character, dict):
            raise ImportFailure(
                "Existing character {} is not an object".format(index)
            )
        character_id = character.get("id")
        if not isinstance(character_id, str) or not ID_PATTERN.fullmatch(character_id):
            raise ImportFailure(
                "Existing character {} has an invalid ID".format(index)
            )
        if character_id in seen_ids:
            raise ImportFailure(
                "Existing character ID is repeated: {}".format(character_id)
            )
        seen_ids.add(character_id)
        portrait_path = character.get("portrait_path")
        if portrait_path is None:
            continue
        if not validate_portrait_path(portrait_path):
            raise ImportFailure(
                "Existing character {} has an unsafe portrait path".format(
                    character_id
                )
            )
        portrait_paths[character_id] = portrait_path
    return portrait_paths


def preserve_existing_portrait_paths(characters, portrait_paths):
    """Restore approved portrait paths only when the stable ID still matches."""
    for character in characters:
        portrait_path = portrait_paths.get(character["id"])
        if portrait_path is not None:
            character["portrait_path"] = portrait_path


def atomic_write_json(path, document):
    """Write JSON through an adjacent temporary file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        document,
        ensure_ascii=False,
        indent=2,
        sort_keys=False,
    ) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="." + path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
        text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


class ApprovedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow only a small number of HTTPS redirects to approved hosts."""

    max_redirections = 5

    def __init__(self, allowed_hosts):
        super().__init__()
        self.allowed_hosts = frozenset(allowed_hosts)

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        validate_https_url(new_url, self.allowed_hosts)
        return super().redirect_request(
            request,
            file_pointer,
            code,
            message,
            headers,
            new_url,
        )


class CachedJsonClient:
    """Small cached HTTPS client with bounded reads and polite delays."""

    def __init__(
        self,
        cache_dir,
        *,
        user_agent=DEFAULT_USER_AGENT,
        timeout=15.0,
        delay=0.75,
        max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES,
        allowed_hosts,
    ):
        if not user_agent.strip() or len(user_agent) > 300:
            raise ValueError("A short, explicit User-Agent is required")
        if timeout <= 0 or timeout > 120:
            raise ValueError("timeout must be between 0 and 120 seconds")
        if delay < 0 or delay > 30:
            raise ValueError("delay must be between 0 and 30 seconds")
        if max_response_bytes < 1024 or max_response_bytes > 64 * 1024 * 1024:
            raise ValueError("max_response_bytes is outside the safe range")
        self.cache_dir = Path(cache_dir).expanduser().resolve()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.user_agent = user_agent
        self.timeout = timeout
        self.delay = delay
        self.max_response_bytes = max_response_bytes
        self.allowed_hosts = frozenset(allowed_hosts)
        self.opener = urllib.request.build_opener(
            ApprovedRedirectHandler(self.allowed_hosts)
        )
        self.last_request_at = None

    def cache_path_for(self, url):
        """Map a URL to a hash-only path that cannot escape the cache root."""
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
        candidate = (self.cache_dir / (digest + ".json")).resolve()
        if os.path.commonpath((str(self.cache_dir), str(candidate))) != str(
            self.cache_dir
        ):
            raise ImportFailure("Unsafe cache path")
        return candidate

    def get_json(self, url):
        """Read JSON from cache or HTTPS."""
        url = validate_https_url(url, self.allowed_hosts)
        cache_path = self.cache_path_for(url)
        if cache_path.exists() or cache_path.is_symlink():
            if cache_path.is_symlink():
                raise ImportFailure("Refusing to read a symlinked cache entry")
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(cache_path, flags)
            with os.fdopen(descriptor, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ImportFailure("Cache entry is not a regular file")
                payload = stream.read(self.max_response_bytes + 1)
            if len(payload) > self.max_response_bytes:
                raise ImportFailure("Cached response exceeds the size limit")
            return self._decode_json(payload, url)

        if self.last_request_at is not None:
            wait = self.delay - (time.monotonic() - self.last_request_at)
            if wait > 0:
                time.sleep(wait)

        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": self.user_agent,
                "Accept": "application/json",
            },
            method="GET",
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                final_url = validate_https_url(response.geturl(), self.allowed_hosts)
                if final_url != url and urllib.parse.urlsplit(final_url).hostname not in (
                    self.allowed_hosts
                ):
                    raise ImportFailure("Redirected to an unapproved host")
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > self.max_response_bytes:
                    raise ImportFailure("Response exceeds the size limit")
                payload = response.read(self.max_response_bytes + 1)
        except (OSError, urllib.error.URLError, ValueError) as error:
            raise ImportFailure("Request failed for {}: {}".format(url, error)) from error
        finally:
            self.last_request_at = time.monotonic()

        if len(payload) > self.max_response_bytes:
            raise ImportFailure("Response exceeds the size limit")
        document = self._decode_json(payload, url)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".response.",
            suffix=".tmp",
            dir=str(self.cache_dir),
        )
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, cache_path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
        return document

    @staticmethod
    def _decode_json(payload, url):
        try:
            return json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ImportFailure("Invalid JSON from {}".format(url)) from error


class MediaWikiClient:
    """MediaWiki API wrapper using the shared safe cache."""

    def __init__(self, http_client):
        self.http_client = http_client

    def query(self, parameters):
        safe_parameters = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
        }
        safe_parameters.update(parameters)
        query = urllib.parse.urlencode(sorted(safe_parameters.items()))
        return self.http_client.get_json(WIKI_API_URL + "?" + query)


def fetch_wiki_category_titles(client, maximum=6000):
    """Walk character category pages without following arbitrary links."""
    pending = [("Category:Characters", 0)]
    visited = set()
    page_titles = set()
    while pending and len(page_titles) < maximum:
        category, depth = pending.pop(0)
        if category in visited or depth > 3:
            continue
        visited.add(category)
        continuation = None
        while len(page_titles) < maximum:
            parameters = {
                "list": "categorymembers",
                "cmtitle": category,
                "cmlimit": "500",
                "cmtype": "page|subcat",
            }
            if continuation:
                parameters["cmcontinue"] = continuation
            document = client.query(parameters)
            members = document.get("query", {}).get("categorymembers", [])
            if not isinstance(members, list):
                raise ImportFailure("Wiki category response has an invalid shape")
            for member in members:
                title = clean_text(member.get("title", ""), maximum=300)
                namespace = member.get("ns")
                if namespace == 0 and title:
                    page_titles.add(title)
                elif namespace == 14 and title and depth < 3:
                    marker = normalized(title)
                    if not any(excluded in marker for excluded in EXCLUDED_MARKERS):
                        pending.append((title, depth + 1))
            continuation = document.get("continue", {}).get("cmcontinue")
            if not continuation:
                break
    return sorted(page_titles, key=lambda item: (normalized(item), item))


def chunks(values, size):
    for index in range(0, len(values), size):
        yield values[index : index + size]


def wiki_book_ids(categories):
    found = set()
    for category in categories:
        lowered = normalized(category)
        for marker, book_id in BOOK_CATEGORY_MAP.items():
            if marker in lowered:
                found.add(book_id)
    return sorted(found)


def wiki_house_names(categories):
    result = set()
    for category in categories:
        match = HOUSE_CATEGORY_PATTERN.match(category)
        if match:
            result.add(clean_text(match.group(1), maximum=150, allow_empty=False))
    return sorted(result, key=lambda item: (normalized(item), item))


def stable_slug(value):
    value = unicodedata.normalize("NFKD", value)
    value = "".join(character for character in value if not unicodedata.combining(character))
    value = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    if not value or not ID_PATTERN.fullmatch(value):
        raise ImportFailure("Cannot build a stable ID from {!r}".format(value))
    return value


def import_from_wiki(client, maximum_candidates=6000):
    """Import factual page metadata from A Wiki of Ice and Fire."""
    titles = fetch_wiki_category_titles(client, maximum=maximum_candidates)
    records = []
    house_names = set()
    seen_page_ids = set()
    for title_batch in chunks(titles, 40):
        document = client.query(
            {
                "prop": "info|revisions|categories",
                "inprop": "url",
                "rvprop": "ids|timestamp",
                "rvlimit": "1",
                "cllimit": "500",
                "redirects": "1",
                "titles": "|".join(title_batch),
            }
        )
        pages = document.get("query", {}).get("pages", [])
        if not isinstance(pages, list):
            raise ImportFailure("Wiki page response has an invalid shape")
        for page in pages:
            if page.get("missing") or page.get("invalid"):
                continue
            page_id = page.get("pageid")
            if not isinstance(page_id, int) or page_id <= 0 or page_id in seen_page_ids:
                continue
            seen_page_ids.add(page_id)
            name = clean_text(page.get("title", ""), maximum=200)
            clean_name = DISAMBIGUATION_PATTERN.sub("", name).strip()
            category_names = [
                clean_text(category.get("title", ""), maximum=300)
                for category in page.get("categories", [])
                if isinstance(category, dict)
            ]
            exclusion_text = normalized(" ".join([name] + category_names))
            if not is_named_character(clean_name) or any(
                marker in exclusion_text for marker in EXCLUDED_MARKERS
            ):
                continue
            revisions = page.get("revisions", [])
            if not revisions or not isinstance(revisions[0].get("revid"), int):
                continue
            revision = revisions[0]
            source_url = validate_https_url(
                page.get("fullurl", ""), {"awoiaf.westeros.org"}
            )
            page_houses = wiki_house_names(category_names)
            house_names.update(page_houses)
            house_ids = ["house-" + stable_slug(house) for house in page_houses]
            books = wiki_book_ids(category_names)
            if not books:
                continue
            is_pov = any("pov character" in normalized(item) for item in category_names)
            records.append(
                {
                    "id": "character-awoiaf-{}".format(page_id),
                    "name": clean_name,
                    "accepted_names": [clean_name] if clean_name == name else [clean_name, name],
                    "gender": "unknown",
                    "culture": None,
                    "born": None,
                    "died": None,
                    "titles": [],
                    "house_ids": house_ids,
                    "group_id": house_ids[0] if house_ids else "group-unaffiliated",
                    "book_ids": books,
                    "pov_book_ids": books if is_pov else [],
                    "article_length": max(0, int(page.get("length", 0))),
                    "portrait_path": None,
                    "source": {
                        "source_id": "awoiaf",
                        "url": source_url,
                        "revision_id": revision["revid"],
                        "revision_timestamp": clean_text(
                            revision.get("timestamp", ""), maximum=40
                        ),
                    },
                }
            )
    houses = []
    for house_name in sorted(house_names, key=lambda item: (normalized(item), item)):
        house_id = "house-" + stable_slug(house_name)
        houses.append(
            {
                "id": house_id,
                "name": house_name,
                "kind": "house",
                "region": None,
                "major": is_major_house(house_name),
                "source": {
                    "source_id": "awoiaf",
                    "url": WIKI_BASE_URL
                    + "/index.php/"
                    + urllib.parse.quote(house_name.replace(" ", "_")),
                    "revision_id": None,
                    "revision_timestamp": None,
                },
            }
        )
    return records, houses


def load_bounded_json_file(path):
    """Load an explicitly supplied fallback export with a hard size limit."""
    path = Path(path)
    with path.open("rb") as stream:
        payload = stream.read(MAX_FALLBACK_FILE_BYTES + 1)
    if len(payload) > MAX_FALLBACK_FILE_BYTES:
        raise ImportFailure("Fallback file exceeds the size limit")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ImportFailure("Fallback file is not valid UTF-8 JSON") from error


def fetch_paginated_collection(http_client, collection):
    """Fetch a bounded collection from An API of Ice and Fire."""
    if collection not in {"characters", "houses"}:
        raise ValueError("Unsupported API collection")
    records = []
    maximum_pages = 100
    for page in range(1, maximum_pages + 1):
        query = urllib.parse.urlencode(
            {"page": page, "pageSize": PAGE_SIZE},
        )
        url = "{}/{}?{}".format(ICE_AND_FIRE_API_URL, collection, query)
        batch = http_client.get_json(url)
        if not isinstance(batch, list):
            raise ImportFailure("Fallback API returned an invalid collection")
        records.extend(batch)
        if len(batch) < PAGE_SIZE:
            return records
    raise ImportFailure("Fallback API exceeded the safe pagination limit")


def is_major_house(name):
    lowered = normalized(name)
    return any(
        lowered == major or lowered.startswith(major + " of ")
        for major in MAJOR_HOUSE_NAMES
    )


def fallback_group_for(raw_record):
    searchable = normalized(
        " ".join(
            [raw_record.get("culture", "")]
            + raw_record.get("titles", [])
            + raw_record.get("aliases", [])
        )
    )
    if "maester" in searchable or "archmaester" in searchable:
        return "group-citadel"
    if any(marker in searchable for marker in ("septon", "septa", "high septon")):
        return "group-faith"
    if any(marker in searchable for marker in ("night's watch", "nights watch")):
        return "group-nights-watch"
    if any(marker in searchable for marker in ("free folk", "wildling")):
        return "group-free-folk"
    culture = normalized(raw_record.get("culture", ""))
    if culture in ESSOS_CULTURES:
        return "group-essos"
    return "group-unaffiliated"


def build_api_houses(raw_houses):
    houses_by_url = {}
    houses = []
    for raw_house in raw_houses:
        if not isinstance(raw_house, dict):
            raise ImportFailure("Fallback API contains an invalid house")
        source_url = validate_https_url(
            raw_house.get("url", ""), {"anapioficeandfire.com"}
        )
        api_id = numeric_id_from_url(source_url, "house")
        name = clean_text(raw_house.get("name", ""), maximum=150)
        if not name:
            continue
        house_id = "house-api-{}".format(api_id)
        house = {
            "id": house_id,
            "name": name,
            "kind": "house",
            "region": clean_text(raw_house.get("region", ""), maximum=100) or None,
            "major": is_major_house(name),
            "source": {
                "source_id": "an-api-of-ice-and-fire",
                "url": source_url,
                "revision_id": None,
                "revision_timestamp": None,
            },
        }
        houses_by_url[source_url] = house
        houses.append(house)
    houses.sort(key=lambda item: (normalized(item["name"]), item["id"]))
    return houses_by_url, houses


def build_api_characters(raw_characters, houses_by_url):
    records = []
    seen_source_urls = set()
    for raw_record in raw_characters:
        if not isinstance(raw_record, dict):
            raise ImportFailure("Fallback API contains an invalid character")
        source_url = validate_https_url(
            raw_record.get("url", ""), {"anapioficeandfire.com"}
        )
        if source_url in seen_source_urls:
            continue
        seen_source_urls.add(source_url)
        api_id = numeric_id_from_url(source_url, "character")
        name = clean_text(raw_record.get("name", ""), maximum=200)
        if not is_named_character(name):
            continue
        books = raw_record.get("books", [])
        pov_books = raw_record.get("povBooks", [])
        if not isinstance(books, list) or not isinstance(pov_books, list):
            raise ImportFailure("Fallback API contains invalid book references")
        all_books = sorted(
            {
                "book-{}".format(numeric_id_from_url(url, "book"))
                for url in books + pov_books
                if url
            }
        )
        pov_book_ids = sorted(
            {
                "book-{}".format(numeric_id_from_url(url, "book"))
                for url in pov_books
                if url
            }
        )
        if not all_books:
            continue
        aliases = clean_string_list(raw_record.get("aliases", []))
        accepted_names = clean_string_list([name] + aliases)
        if any(
            any(marker in normalized(value) for marker in EXCLUDED_MARKERS)
            for value in accepted_names
        ):
            continue
        house_ids = []
        for raw_url in raw_record.get("allegiances", [])[:20]:
            house_url = validate_https_url(raw_url, {"anapioficeandfire.com"})
            house = houses_by_url.get(house_url)
            if house and house["id"] not in house_ids:
                house_ids.append(house["id"])
        house_ids.sort()
        raw_gender = normalized(clean_text(raw_record.get("gender", ""), maximum=20))
        gender = raw_gender if raw_gender in {"female", "male"} else "unknown"
        records.append(
            {
                "id": "character-api-{}".format(api_id),
                "name": name,
                "accepted_names": accepted_names,
                "gender": gender,
                "culture": clean_text(raw_record.get("culture", ""), maximum=100)
                or None,
                "born": clean_text(raw_record.get("born", ""), maximum=300) or None,
                "died": clean_text(raw_record.get("died", ""), maximum=300) or None,
                "titles": clean_string_list(raw_record.get("titles", [])),
                "house_ids": house_ids,
                "group_id": house_ids[0]
                if house_ids
                else fallback_group_for(raw_record),
                "book_ids": all_books,
                "pov_book_ids": pov_book_ids,
                "article_length": None,
                "portrait_path": None,
                "source": {
                    "source_id": "an-api-of-ice-and-fire",
                    "url": source_url,
                    "revision_id": None,
                    "revision_timestamp": None,
                },
            }
        )
    return records


def import_from_ice_and_fire(http_client, fallback_file=None):
    """Import the deterministic fallback API dataset or a saved export."""
    if fallback_file:
        export = load_bounded_json_file(fallback_file)
        if not isinstance(export, dict):
            raise ImportFailure("Fallback export must be a JSON object")
        raw_characters = export.get("characters")
        raw_houses = export.get("houses")
        if not isinstance(raw_characters, list) or not isinstance(raw_houses, list):
            raise ImportFailure(
                "Fallback export must contain character and house arrays"
            )
    else:
        raw_characters = fetch_paginated_collection(http_client, "characters")
        raw_houses = fetch_paginated_collection(http_client, "houses")
    houses_by_url, houses = build_api_houses(raw_houses)
    records = build_api_characters(raw_characters, houses_by_url)
    return records, houses


def ranking_key(character, major_house_ids):
    """Sort stronger release candidates first with stable tie breakers."""
    article_length = character["article_length"] or 0
    has_major_house = any(
        house_id in major_house_ids for house_id in character["house_ids"]
    )
    return (
        -int(bool(character["pov_book_ids"])),
        -len(character["book_ids"]),
        -article_length,
        -int(has_major_house),
        normalized(character["name"]),
        character["source"]["url"],
        character["id"],
    )


def choose_release(records, houses, limit):
    """Deduplicate and choose a deterministic ranked release."""
    if limit <= 0 or limit > MAX_LIMIT:
        raise ImportFailure("limit must be between 1 and {}".format(MAX_LIMIT))
    deduplicated = {}
    for record in records:
        source_key = record["source"]["url"]
        deduplicated.setdefault(source_key, record)
    major_house_ids = {house["id"] for house in houses if house["major"]}
    selected = sorted(
        deduplicated.values(),
        key=lambda item: ranking_key(item, major_house_ids),
    )[:limit]
    for rank, character in enumerate(selected, start=1):
        character["rank"] = rank
    return selected


def release_documents(selected, houses, *, source_mode, limit):
    used_house_ids = {
        house_id for character in selected for house_id in character["house_ids"]
    }
    selected_houses = [
        house for house in houses if house["id"] in used_house_ids
    ] + [dict(group) for group in FALLBACK_GROUPS]
    selected_houses.sort(
        key=lambda item: (
            0 if item["kind"] == "house" else 1,
            normalized(item["name"]),
            item["id"],
        )
    )
    character_document = {
        "schema_version": SCHEMA_VERSION,
        "release": {
            "name": "1.0",
            "target_count": limit,
            "source_mode": source_mode,
            "selection": (
                "POV status, book coverage, article length, major-house membership, "
                "then stable name and source identifiers"
            ),
        },
        "characters": selected,
    }
    house_document = {
        "schema_version": SCHEMA_VERSION,
        "groups": selected_houses,
    }
    return character_document, house_document


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    repository_root = Path(__file__).resolve().parents[1]
    parser.add_argument(
        "--source",
        choices=("auto", "awoiaf", "iceandfire"),
        default="auto",
        help="preferred import source; auto falls back clearly",
    )
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=repository_root / ".cache" / "data-import",
    )
    parser.add_argument("--fallback-file", type=Path)
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--delay", type=float, default=0.75)
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    parser.add_argument(
        "--max-response-bytes",
        type=int,
        default=DEFAULT_MAX_RESPONSE_BYTES,
    )
    parser.add_argument(
        "--characters-output",
        type=Path,
        default=repository_root / "data" / "characters.json",
    )
    parser.add_argument(
        "--houses-output",
        type=Path,
        default=repository_root / "data" / "houses.json",
    )
    return parser.parse_args(argv)


def run_import(arguments):
    if arguments.limit <= 0 or arguments.limit > MAX_LIMIT:
        raise ImportFailure("limit must be between 1 and {}".format(MAX_LIMIT))
    existing_portrait_paths = load_existing_portrait_paths(
        arguments.characters_output
    )
    common_client_options = {
        "user_agent": arguments.user_agent,
        "timeout": arguments.timeout,
        "delay": arguments.delay,
        "max_response_bytes": arguments.max_response_bytes,
    }
    source_mode = arguments.source
    records = None
    houses = None
    if arguments.source in {"auto", "awoiaf"}:
        wiki_http = CachedJsonClient(
            arguments.cache_dir / "awoiaf",
            allowed_hosts={"awoiaf.westeros.org"},
            **common_client_options,
        )
        try:
            records, houses = import_from_wiki(MediaWikiClient(wiki_http))
            if len(records) < arguments.limit:
                raise ImportFailure(
                    "A Wiki of Ice and Fire returned only {} eligible records"
                    .format(len(records))
                )
            source_mode = "awoiaf"
        except ImportFailure as error:
            if arguments.source == "awoiaf":
                raise
            print(
                "Preferred A Wiki of Ice and Fire import failed: {}. "
                "Using An API of Ice and Fire fallback.".format(error),
                file=sys.stderr,
            )
            records = None
            houses = None
            source_mode = "iceandfire-fallback"

    if records is None:
        fallback_http = CachedJsonClient(
            arguments.cache_dir / "iceandfire",
            allowed_hosts={"anapioficeandfire.com"},
            **common_client_options,
        )
        records, houses = import_from_ice_and_fire(
            fallback_http,
            fallback_file=arguments.fallback_file,
        )
    selected = choose_release(records, houses, arguments.limit)
    if len(selected) != arguments.limit:
        raise ImportFailure(
            "Import produced {} eligible records, but {} were required"
            .format(len(selected), arguments.limit)
        )
    preserve_existing_portrait_paths(selected, existing_portrait_paths)
    characters_document, houses_document = release_documents(
        selected,
        houses,
        source_mode=source_mode,
        limit=arguments.limit,
    )
    atomic_write_json(arguments.characters_output, characters_document)
    atomic_write_json(arguments.houses_output, houses_document)
    print(
        "Wrote {} characters and {} groups from {}.".format(
            len(selected),
            len(houses_document["groups"]),
            source_mode,
        )
    )


def main(argv=None):
    arguments = parse_arguments(argv)
    try:
        run_import(arguments)
    except (ImportFailure, OSError, ValueError) as error:
        print("Import failed: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
