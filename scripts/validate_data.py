#!/usr/bin/env python3
"""Validate Name of Thrones release data without network access."""

import argparse
import json
import re
import sys
import unicodedata
import urllib.parse
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


SCHEMA_VERSION = 1
DEFAULT_EXPECTED_COUNT = 1000
MAX_DATA_FILE_BYTES = 64 * 1024 * 1024
ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
BOOK_ID_PATTERN = re.compile(r"^(?:book-\d+|agot|acok|asos|affc|adwd|twow|ados|thk|tss|tmk|fab)$")
ISO_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$"
)
EXCLUDED_MARKERS = (
    "the ice dragon",
    "semi-canon",
    "semi canon",
    "game-only",
    "game only",
    "tv-only",
    "tv only",
)
ALLOWED_SOURCE_HOSTS = {
    "awoiaf.westeros.org",
    "anapioficeandfire.com",
    "creativecommons.org",
    "github.com",
}
CHARACTER_KEYS = {
    "id",
    "name",
    "accepted_names",
    "gender",
    "culture",
    "born",
    "died",
    "titles",
    "house_ids",
    "group_id",
    "book_ids",
    "pov_book_ids",
    "article_length",
    "portrait_path",
    "source",
    "rank",
}
GROUP_KEYS = {
    "id",
    "name",
    "kind",
    "region",
    "major",
    "source",
}
SOURCE_REFERENCE_KEYS = {
    "source_id",
    "url",
    "revision_id",
    "revision_timestamp",
}


@dataclass(frozen=True)
class ValidationIssue:
    level: str
    code: str
    message: str


def normalized(value):
    return unicodedata.normalize("NFKC", value).casefold().strip()


def error(issues, code, message):
    issues.append(ValidationIssue("error", code, message))


def warning(issues, code, message):
    issues.append(ValidationIssue("warning", code, message))


def is_clean_text(value, maximum, *, allow_empty=False):
    if not isinstance(value, str):
        return False
    if not allow_empty and not value:
        return False
    if value != " ".join(value.split()) or len(value) > maximum:
        return False
    if "<" in value or ">" in value:
        return False
    return not any(unicodedata.category(character) == "Cc" for character in value)


def validate_identifier(value):
    return isinstance(value, str) and bool(ID_PATTERN.fullmatch(value))


def validate_source_url(url, expected_source_id=None):
    if not isinstance(url, str) or len(url) > 2048:
        return False
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.fragment
        or parsed.hostname not in ALLOWED_SOURCE_HOSTS
    ):
        return False
    if expected_source_id == "awoiaf" and parsed.hostname != "awoiaf.westeros.org":
        return False
    if (
        expected_source_id == "an-api-of-ice-and-fire"
        and parsed.hostname != "anapioficeandfire.com"
    ):
        return False
    return True


def validate_portrait_path(path):
    """Allow only safe project-relative files below portraits/."""
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


def validate_source_reference(source, issues, context, known_source_ids):
    if not isinstance(source, dict):
        error(issues, "source_type", "{} source must be an object".format(context))
        return
    missing = SOURCE_REFERENCE_KEYS - set(source)
    extra = set(source) - SOURCE_REFERENCE_KEYS
    if missing or extra:
        error(
            issues,
            "source_schema",
            "{} source keys differ from the schema".format(context),
        )
        return
    source_id = source["source_id"]
    if not validate_identifier(source_id) or (
        known_source_ids is not None and source_id not in known_source_ids
    ):
        error(
            issues,
            "unknown_source",
            "{} uses unknown source {!r}".format(context, source_id),
        )
    if not validate_source_url(source["url"], source_id):
        error(
            issues,
            "source_url",
            "{} has an unsafe or mismatched source URL".format(context),
        )
    revision_id = source["revision_id"]
    revision_timestamp = source["revision_timestamp"]
    if source_id == "awoiaf":
        if context.startswith("character "):
            if not isinstance(revision_id, int) or isinstance(revision_id, bool) or revision_id <= 0:
                error(
                    issues,
                    "revision_id",
                    "{} must track a positive wiki revision".format(context),
                )
            if not isinstance(revision_timestamp, str) or not ISO_TIMESTAMP_PATTERN.fullmatch(
                revision_timestamp
            ):
                error(
                    issues,
                    "revision_timestamp",
                    "{} must track a wiki revision timestamp".format(context),
                )
        elif revision_id is not None or revision_timestamp is not None:
            if not isinstance(revision_id, int) or not isinstance(
                revision_timestamp, str
            ):
                error(
                    issues,
                    "revision_metadata",
                    "{} has invalid optional revision metadata".format(context),
                )
    elif revision_id is not None or revision_timestamp is not None:
        error(
            issues,
            "unsupported_revision",
            "{} claims a revision unsupported by its source".format(context),
        )


def validate_sources_document(document, issues):
    if not isinstance(document, dict):
        error(issues, "sources_document", "sources.json must contain an object")
        return set()
    if set(document) != {"schema_version", "sources", "release_notes"}:
        error(issues, "sources_schema", "sources.json has unexpected top-level keys")
    if document.get("schema_version") != SCHEMA_VERSION:
        error(issues, "schema_version", "sources.json schema version is unsupported")
    sources = document.get("sources")
    if not isinstance(sources, list) or not sources:
        error(issues, "sources_list", "sources.json must contain source records")
        return set()
    source_ids = set()
    for index, source in enumerate(sources):
        context = "source record {}".format(index)
        if not isinstance(source, dict):
            error(issues, "source_record", "{} must be an object".format(context))
            continue
        expected_keys = {
            "id",
            "name",
            "url",
            "license",
            "provenance",
            "limitations",
        }
        if set(source) != expected_keys:
            error(issues, "source_record_schema", "{} has unexpected keys".format(context))
            continue
        source_id = source["id"]
        if not validate_identifier(source_id) or source_id in source_ids:
            error(issues, "source_id", "{} has an invalid or repeated ID".format(context))
        else:
            source_ids.add(source_id)
        if not is_clean_text(source["name"], 150):
            error(issues, "source_name", "{} has an invalid name".format(context))
        if not validate_source_url(source["url"]):
            error(issues, "source_url", "{} has an unsafe URL".format(context))
        if not isinstance(source["license"], dict) or set(source["license"]) != {
            "name",
            "url",
        }:
            error(issues, "source_license", "{} has invalid license data".format(context))
        else:
            if not is_clean_text(source["license"]["name"], 150):
                error(issues, "source_license", "{} has an invalid license name".format(context))
            if not validate_source_url(source["license"]["url"]):
                error(issues, "source_license_url", "{} has an unsafe license URL".format(context))
        for field in ("provenance", "limitations"):
            if not is_clean_text(source[field], 1000):
                error(
                    issues,
                    "source_text",
                    "{} has invalid {}".format(context, field),
                )
    release_notes = document.get("release_notes")
    if not isinstance(release_notes, list) or not release_notes:
        error(issues, "release_notes", "sources.json needs release notes")
    elif any(not is_clean_text(item, 500) for item in release_notes):
        error(issues, "release_notes", "sources.json has invalid release notes")
    return source_ids


def validate_groups_document(document, issues, known_source_ids):
    if not isinstance(document, dict):
        error(issues, "groups_document", "houses.json must contain an object")
        return {}
    if set(document) != {"schema_version", "groups"}:
        error(issues, "groups_schema", "houses.json has unexpected top-level keys")
    if document.get("schema_version") != SCHEMA_VERSION:
        error(issues, "schema_version", "houses.json schema version is unsupported")
    groups = document.get("groups")
    if not isinstance(groups, list) or not groups:
        error(issues, "groups_list", "houses.json must contain groups")
        return {}
    by_id = {}
    normalized_names = {}
    fallback_ids = set()
    for index, group in enumerate(groups):
        context = "group {}".format(index)
        if not isinstance(group, dict) or set(group) != GROUP_KEYS:
            error(issues, "group_schema", "{} differs from the schema".format(context))
            continue
        group_id = group["id"]
        if not validate_identifier(group_id) or group_id in by_id:
            error(issues, "group_id", "{} has an invalid or repeated ID".format(context))
            continue
        by_id[group_id] = group
        if not is_clean_text(group["name"], 150):
            error(issues, "group_name", "{} has an invalid name".format(context))
        else:
            name_key = normalized(group["name"])
            if name_key in normalized_names:
                error(
                    issues,
                    "group_name_collision",
                    "{} and {} have the same normalized name".format(
                        group_id, normalized_names[name_key]
                    ),
                )
            normalized_names[name_key] = group_id
        if group["kind"] not in {"house", "fallback"}:
            error(issues, "group_kind", "{} has an invalid kind".format(context))
        if group["kind"] == "fallback":
            fallback_ids.add(group_id)
            if group["source"] is not None:
                error(
                    issues,
                    "fallback_source",
                    "{} fallback group must not claim an external source".format(context),
                )
        else:
            validate_source_reference(
                group["source"], issues, "house " + group_id, known_source_ids
            )
        if group["region"] is not None and not is_clean_text(group["region"], 100):
            error(issues, "group_region", "{} has an invalid region".format(context))
        if not isinstance(group["major"], bool):
            error(issues, "group_major", "{} major must be boolean".format(context))
    if "group-unaffiliated" not in fallback_ids:
        error(issues, "fallback_group", "The unaffiliated fallback group is missing")
    return by_id


def validate_string_list(
    value,
    issues,
    context,
    code,
    *,
    maximum_items,
    maximum_length,
    allow_empty=False,
):
    if not isinstance(value, list) or len(value) > maximum_items:
        error(issues, code, "{} must be a bounded list".format(context))
        return []
    normalized_values = set()
    for item in value:
        if not is_clean_text(item, maximum_length, allow_empty=allow_empty):
            error(issues, code, "{} contains invalid text".format(context))
            continue
        key = normalized(item)
        if key in normalized_values:
            error(issues, code, "{} contains a repeated value".format(context))
        normalized_values.add(key)
    return value


def validate_character(
    character,
    index,
    issues,
    groups_by_id,
    known_source_ids,
    seen_ids,
    seen_source_urls,
    accepted_name_owners,
):
    context = "character {}".format(index)
    if not isinstance(character, dict) or set(character) != CHARACTER_KEYS:
        error(issues, "character_schema", "{} differs from the schema".format(context))
        return
    character_id = character["id"]
    context = "character {}".format(character_id)
    if not validate_identifier(character_id) or character_id in seen_ids:
        error(issues, "character_id", "{} has an invalid or repeated ID".format(context))
    else:
        seen_ids.add(character_id)
    name = character["name"]
    if not is_clean_text(name, 200):
        error(issues, "character_name", "{} has an invalid name".format(context))
    elif any(marker in normalized(name) for marker in EXCLUDED_MARKERS):
        error(issues, "excluded_character", "{} is not allowed".format(context))
    accepted_names = validate_string_list(
        character["accepted_names"],
        issues,
        context + " accepted_names",
        "accepted_names",
        maximum_items=30,
        maximum_length=300,
    )
    if isinstance(name, str) and not any(
        normalized(item) == normalized(name) for item in accepted_names
    ):
        error(
            issues,
            "primary_name_missing",
            "{} name is absent from accepted_names".format(context),
        )
    for accepted_name in accepted_names:
        accepted_name_owners[normalized(accepted_name)].append(
            (accepted_name, character_id)
        )
    if character["gender"] not in {"female", "male", "unknown"}:
        error(issues, "gender", "{} has an invalid gender".format(context))
    for field, maximum in (("culture", 100), ("born", 300), ("died", 300)):
        value = character[field]
        if value is not None and not is_clean_text(value, maximum):
            error(issues, field, "{} has invalid {}".format(context, field))
    validate_string_list(
        character["titles"],
        issues,
        context + " titles",
        "titles",
        maximum_items=30,
        maximum_length=300,
    )
    house_ids = character["house_ids"]
    if not isinstance(house_ids, list) or len(house_ids) > 20:
        error(issues, "house_ids", "{} has invalid house IDs".format(context))
        house_ids = []
    else:
        if len(house_ids) != len(set(house_ids)):
            error(issues, "house_ids", "{} repeats a house ID".format(context))
        for house_id in house_ids:
            if (
                not validate_identifier(house_id)
                or house_id not in groups_by_id
                or groups_by_id[house_id].get("kind") != "house"
            ):
                error(
                    issues,
                    "unknown_house",
                    "{} references unknown house {!r}".format(context, house_id),
                )
    group_id = character["group_id"]
    if group_id not in groups_by_id:
        error(
            issues,
            "unknown_group",
            "{} references unknown group {!r}".format(context, group_id),
        )
    elif house_ids and group_id not in house_ids:
        error(
            issues,
            "primary_group",
            "{} primary group must be one of its houses".format(context),
        )
    elif not house_ids and groups_by_id[group_id].get("kind") != "fallback":
        error(
            issues,
            "fallback_group",
            "{} without a house must use a fallback group".format(context),
        )
    book_ids = character["book_ids"]
    pov_book_ids = character["pov_book_ids"]
    if (
        not isinstance(book_ids, list)
        or not book_ids
        or len(book_ids) != len(set(book_ids))
        or any(not isinstance(item, str) or not BOOK_ID_PATTERN.fullmatch(item) for item in book_ids)
    ):
        error(issues, "book_ids", "{} needs valid book coverage".format(context))
        book_ids = []
    if (
        not isinstance(pov_book_ids, list)
        or len(pov_book_ids) != len(set(pov_book_ids))
        or any(item not in book_ids for item in pov_book_ids)
    ):
        error(issues, "pov_book_ids", "{} has invalid POV book coverage".format(context))
    article_length = character["article_length"]
    if article_length is not None and (
        not isinstance(article_length, int)
        or isinstance(article_length, bool)
        or article_length < 0
        or article_length > 10_000_000
    ):
        error(issues, "article_length", "{} has invalid article length".format(context))
    if not validate_portrait_path(character["portrait_path"]):
        error(issues, "portrait_path", "{} has an unsafe portrait path".format(context))
    validate_source_reference(
        character["source"], issues, context, known_source_ids
    )
    if isinstance(character["source"], dict):
        source_url = character["source"].get("url")
        if source_url in seen_source_urls:
            error(
                issues,
                "duplicate_source",
                "{} repeats source URL {}".format(context, source_url),
            )
        elif isinstance(source_url, str):
            seen_source_urls.add(source_url)
    rank = character["rank"]
    if not isinstance(rank, int) or isinstance(rank, bool) or rank <= 0:
        error(issues, "rank", "{} has an invalid rank".format(context))


def validate_documents(
    characters_document,
    groups_document,
    sources_document,
    *,
    expected_count=DEFAULT_EXPECTED_COUNT,
):
    """Return all validation errors and warnings."""
    issues = []
    known_source_ids = validate_sources_document(sources_document, issues)
    groups_by_id = validate_groups_document(
        groups_document, issues, known_source_ids
    )
    if not isinstance(characters_document, dict):
        error(issues, "characters_document", "characters.json must contain an object")
        return issues
    if set(characters_document) != {"schema_version", "release", "characters"}:
        error(
            issues,
            "characters_schema",
            "characters.json has unexpected top-level keys",
        )
    if characters_document.get("schema_version") != SCHEMA_VERSION:
        error(
            issues,
            "schema_version",
            "characters.json schema version is unsupported",
        )
    release = characters_document.get("release")
    if not isinstance(release, dict) or set(release) != {
        "name",
        "target_count",
        "source_mode",
        "selection",
    }:
        error(issues, "release_schema", "characters.json release metadata is invalid")
    characters = characters_document.get("characters")
    if not isinstance(characters, list):
        error(issues, "characters_list", "characters.json must contain characters")
        return issues
    if expected_count is not None and len(characters) != expected_count:
        error(
            issues,
            "character_count",
            "Expected {} characters, found {}".format(expected_count, len(characters)),
        )
    if isinstance(release, dict) and release.get("target_count") != len(characters):
        error(
            issues,
            "release_count",
            "Release target_count does not match the character array",
        )
    seen_ids = set()
    seen_source_urls = set()
    accepted_name_owners = defaultdict(list)
    for index, character in enumerate(characters):
        validate_character(
            character,
            index,
            issues,
            groups_by_id,
            known_source_ids,
            seen_ids,
            seen_source_urls,
            accepted_name_owners,
        )
    ranks = [
        character.get("rank")
        for character in characters
        if isinstance(character, dict)
    ]
    if ranks != list(range(1, len(characters) + 1)):
        error(issues, "rank_order", "Character ranks must be consecutive and ordered")
    for name_key, owners in sorted(accepted_name_owners.items()):
        owner_ids = sorted({owner_id for _, owner_id in owners})
        if len(owner_ids) > 1:
            display_name = sorted(
                {display for display, _ in owners},
                key=lambda item: (normalized(item), item),
            )[0]
            warning(
                issues,
                "accepted_name_collision",
                "Accepted name {!r} identifies {} records: {}".format(
                    display_name,
                    len(owner_ids),
                    ", ".join(owner_ids),
                ),
            )
    return issues


def load_json(path):
    path = Path(path)
    with path.open("rb") as stream:
        payload = stream.read(MAX_DATA_FILE_BYTES + 1)
    if len(payload) > MAX_DATA_FILE_BYTES:
        raise ValueError("{} exceeds the size limit".format(path))
    return json.loads(payload.decode("utf-8"))


def parse_arguments(argv=None):
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--characters",
        type=Path,
        default=repository_root / "data" / "characters.json",
    )
    parser.add_argument(
        "--houses",
        type=Path,
        default=repository_root / "data" / "houses.json",
    )
    parser.add_argument(
        "--sources",
        type=Path,
        default=repository_root / "data" / "sources.json",
    )
    parser.add_argument(
        "--expected-count",
        type=int,
        default=DEFAULT_EXPECTED_COUNT,
        help="override the release count; use --allow-any-count for no count check",
    )
    parser.add_argument("--allow-any-count", action="store_true")
    parser.add_argument("--warnings-as-errors", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    if arguments.expected_count < 0:
        print("Validation failed: expected count cannot be negative", file=sys.stderr)
        return 2
    try:
        characters_document = load_json(arguments.characters)
        groups_document = load_json(arguments.houses)
        sources_document = load_json(arguments.sources)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error_value:
        print("Validation failed: {}".format(error_value), file=sys.stderr)
        return 2
    expected_count = None if arguments.allow_any_count else arguments.expected_count
    issues = validate_documents(
        characters_document,
        groups_document,
        sources_document,
        expected_count=expected_count,
    )
    for issue in issues:
        output = sys.stderr if issue.level == "error" else sys.stdout
        print("{} [{}] {}".format(issue.level.upper(), issue.code, issue.message), file=output)
    errors = [issue for issue in issues if issue.level == "error"]
    warnings = [issue for issue in issues if issue.level == "warning"]
    if errors or (warnings and arguments.warnings_as_errors):
        return 1
    print(
        "Validated {} characters with {} warning(s).".format(
            len(characters_document["characters"]),
            len(warnings),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
