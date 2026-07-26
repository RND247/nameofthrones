import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts import import_characters
from scripts import validate_data


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


class CheckedInReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.characters = validate_data.load_json(
            REPOSITORY_ROOT / "data" / "characters.json"
        )
        cls.houses = validate_data.load_json(
            REPOSITORY_ROOT / "data" / "houses.json"
        )
        cls.sources = validate_data.load_json(
            REPOSITORY_ROOT / "data" / "sources.json"
        )
        cls.show_characters = validate_data.load_json(
            REPOSITORY_ROOT / "data" / "show-characters.json"
        )
        cls.levels = validate_data.load_json(
            REPOSITORY_ROOT / "data" / "levels.json"
        )
        cls.overrides = validate_data.load_json(
            REPOSITORY_ROOT / "data" / "character-overrides.json"
        )

    def validate_release(self, **changes):
        documents = {
            "characters_document": self.characters,
            "groups_document": self.houses,
            "sources_document": self.sources,
            "show_characters_document": self.show_characters,
            "levels_document": self.levels,
            "overrides_document": self.overrides,
            "expected_count": 1000,
        }
        documents.update(changes)
        return validate_data.validate_documents(**documents)

    def test_release_has_exactly_1015_valid_characters(self):
        issues = self.validate_release()
        errors = [issue for issue in issues if issue.level == "error"]
        self.assertEqual([], errors)
        self.assertEqual(1000, len(self.characters["characters"]))
        self.assertEqual(15, len(self.show_characters["characters"]))

    def test_level_rosters_have_exact_counts_and_subset_order(self):
        levels = {level["id"]: level for level in self.levels["levels"]}
        newcomer_ids = levels["newcomer"]["character_ids"]
        fan_ids = levels["fan"]["character_ids"]
        self.assertEqual(40, len(newcomer_ids))
        self.assertEqual(250, len(fan_ids))
        self.assertTrue(set(newcomer_ids) < set(fan_ids))
        self.assertIs(levels["expert"]["include_all"], True)

    def test_show_records_are_show_only_and_bookless(self):
        for character in self.show_characters["characters"]:
            self.assertEqual("tv_only", character["media_scope"])
            self.assertEqual([], character["book_ids"])
            self.assertTrue(character["tv_seasons"])
            self.assertEqual(
                len(character["tv_seasons"]),
                len(set(character["tv_seasons"])),
            )
            self.assertTrue(
                all(1 <= season <= 8 for season in character["tv_seasons"])
            )

    def test_duplicate_id_across_book_and_show_is_rejected(self):
        show_characters = copy.deepcopy(self.show_characters)
        show_characters["characters"][0]["id"] = self.characters["characters"][0]["id"]
        issues = self.validate_release(
            show_characters_document=show_characters
        )
        self.assertIn(
            "character_id",
            {issue.code for issue in issues if issue.level == "error"},
        )

    def test_invalid_show_season_is_rejected(self):
        show_characters = copy.deepcopy(self.show_characters)
        show_characters["characters"][0]["tv_seasons"] = [0, 8, 8]
        issues = self.validate_release(
            show_characters_document=show_characters
        )
        self.assertIn(
            "tv_seasons",
            {issue.code for issue in issues if issue.level == "error"},
        )

    def test_unknown_and_duplicate_roster_ids_are_rejected(self):
        levels = copy.deepcopy(self.levels)
        levels["levels"][0]["character_ids"][-1] = levels["levels"][0][
            "character_ids"
        ][0]
        levels["levels"][1]["character_ids"][-1] = "unknown-character"
        issues = self.validate_release(levels_document=levels)
        error_codes = {issue.code for issue in issues if issue.level == "error"}
        self.assertIn("level_roster_duplicate", error_codes)
        self.assertIn("level_character_id", error_codes)

    def test_override_alias_must_be_new_and_unique(self):
        overrides = copy.deepcopy(self.overrides)
        target_id = overrides["overrides"][0]["id"]
        target = next(
            character
            for character in self.characters["characters"]
            if character["id"] == target_id
        )
        overrides["overrides"][0]["accepted_names_add"] = [
            target["accepted_names"][0],
            target["accepted_names"][0],
        ]
        issues = self.validate_release(overrides_document=overrides)
        self.assertIn(
            "override_aliases",
            {issue.code for issue in issues if issue.level == "error"},
        )

    def test_name_only_override_is_valid(self):
        overrides = copy.deepcopy(self.overrides)
        hodor_override = next(
            override
            for override in overrides["overrides"]
            if override["id"] == "character-api-2"
        )
        hodor_override.pop("accepted_names_add")
        issues = self.validate_release(overrides_document=overrides)
        self.assertEqual(
            [],
            [issue for issue in issues if issue.level == "error"],
        )

    def test_override_requires_aliases_or_clean_name(self):
        overrides = copy.deepcopy(self.overrides)
        hodor_override = next(
            override
            for override in overrides["overrides"]
            if override["id"] == "character-api-2"
        )
        hodor_override.pop("accepted_names_add")
        hodor_override.pop("name_override")
        issues = self.validate_release(overrides_document=overrides)
        self.assertIn(
            "override_content",
            {issue.code for issue in issues if issue.level == "error"},
        )

        hodor_override["name_override"] = " <script> "
        issues = self.validate_release(overrides_document=overrides)
        self.assertIn(
            "override_name",
            {issue.code for issue in issues if issue.level == "error"},
        )

    def test_override_rejects_unknown_duplicate_ids_and_unsafe_urls(self):
        overrides = copy.deepcopy(self.overrides)
        overrides["overrides"][0]["id"] = "unknown-character"
        overrides["overrides"][1]["id"] = overrides["overrides"][2]["id"]
        overrides["overrides"][2]["source_url"] = "https://github.com/private/source"
        issues = self.validate_release(overrides_document=overrides)
        error_codes = {issue.code for issue in issues if issue.level == "error"}
        self.assertIn("override_id", error_codes)
        self.assertIn("override_source_url", error_codes)

    def test_made_up_source_ids_are_rejected(self):
        characters = copy.deepcopy(self.characters)
        characters["characters"][0]["source"]["source_id"] = "made-up-source"
        levels = copy.deepcopy(self.levels)
        levels["sources"][0]["id"] = "made-up-source"
        show_characters = copy.deepcopy(self.show_characters)
        show_characters["characters"][0]["source"][
            "source_id"
        ] = "made-up-source"
        issues = self.validate_release(
            characters_document=characters,
            levels_document=levels,
            show_characters_document=show_characters,
        )
        error_codes = {issue.code for issue in issues if issue.level == "error"}
        self.assertIn("level_source_id", error_codes)
        self.assertGreaterEqual(
            len(
                [
                    issue
                    for issue in issues
                    if issue.level == "error" and issue.code == "unknown_source"
                ]
            ),
            2,
        )

    def test_invalid_level_source_date_is_rejected(self):
        levels = copy.deepcopy(self.levels)
        levels["sources"][0]["accessed_at"] = "2026-02-30"
        issues = self.validate_release(levels_document=levels)
        self.assertIn(
            "level_source_date",
            {issue.code for issue in issues if issue.level == "error"},
        )

    def test_release_has_no_excluded_character_markers(self):
        for character in self.characters["characters"]:
            searchable = " ".join(
                [character["name"]] + character["accepted_names"]
            ).casefold()
            for marker in validate_data.EXCLUDED_MARKERS:
                self.assertNotIn(marker, searchable)

    def test_every_character_uses_a_known_group(self):
        known_groups = {group["id"] for group in self.houses["groups"]}
        for character in self.characters["characters"]:
            self.assertIn(character["group_id"], known_groups)
            self.assertTrue(set(character["house_ids"]).issubset(known_groups))

    def test_same_accepted_name_is_a_warning_not_an_error(self):
        characters = copy.deepcopy(self.characters)
        shared_alias = "Shared Test Alias"
        characters["characters"][0]["accepted_names"].append(shared_alias)
        characters["characters"][1]["accepted_names"].append(shared_alias)
        issues = validate_data.validate_documents(
            characters,
            self.houses,
            self.sources,
            expected_count=1000,
        )
        matching = [
            issue
            for issue in issues
            if issue.code == "accepted_name_collision"
            and shared_alias in issue.message
        ]
        self.assertEqual(1, len(matching))
        self.assertEqual("warning", matching[0].level)


class ValidatorUnitTests(unittest.TestCase):
    def test_portrait_paths_are_project_relative(self):
        valid = (
            None,
            "portraits/arya-stark.webp",
            "portraits/stark/arya.png",
        )
        invalid = (
            "",
            "/portraits/arya.webp",
            "../portraits/arya.webp",
            "portraits/../../secret.jpg",
            "portraits\\arya.jpg",
            "https://example.com/arya.jpg",
            "images/arya.jpg",
            "portraits/arya.svg",
        )
        for value in valid:
            self.assertTrue(validate_data.validate_portrait_path(value), value)
        for value in invalid:
            self.assertFalse(validate_data.validate_portrait_path(value), value)

    def test_source_urls_reject_credentials_and_unapproved_hosts(self):
        self.assertTrue(
            validate_data.validate_source_url(
                "https://awoiaf.westeros.org/index.php/Arya_Stark",
                "awoiaf",
            )
        )
        self.assertFalse(
            validate_data.validate_source_url(
                "https://user:password@awoiaf.westeros.org/index.php/Arya_Stark",
                "awoiaf",
            )
        )
        self.assertFalse(
            validate_data.validate_source_url(
                "https://example.com/index.php/Arya_Stark",
                "awoiaf",
            )
        )


class ImporterUnitTests(unittest.TestCase):
    def test_default_user_agent_uses_project_url(self):
        self.assertIn(
            "https://github.com/RND247/nameofthrones",
            import_characters.DEFAULT_USER_AGENT,
        )

    def test_cached_client_reads_preseeded_cache_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            client = import_characters.CachedJsonClient(
                directory,
                delay=0,
                allowed_hosts={"anapioficeandfire.com"},
            )
            url = "https://anapioficeandfire.com/api/characters?page=1&pageSize=1"
            cache_path = client.cache_path_for(url)
            cache_path.write_text('{"cached": true}', encoding="utf-8")
            self.assertEqual({"cached": True}, client.get_json(url))

    def test_cached_client_rejects_symlink_and_oversized_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory) / "cache"
            cache_root.mkdir()
            client = import_characters.CachedJsonClient(
                cache_root,
                delay=0,
                max_response_bytes=1024,
                allowed_hosts={"anapioficeandfire.com"},
            )
            url = "https://anapioficeandfire.com/api/characters/1"
            cache_path = client.cache_path_for(url)
            outside = Path(directory) / "outside.json"
            outside.write_text("{}", encoding="utf-8")
            cache_path.symlink_to(outside)
            with self.assertRaises(import_characters.ImportFailure):
                client.get_json(url)
            cache_path.unlink()
            cache_path.write_bytes(b"x" * 1025)
            with self.assertRaises(import_characters.ImportFailure):
                client.get_json(url)

    def test_offline_regeneration_preserves_safe_portrait_by_stable_id(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            characters_output = root / "characters.json"
            houses_output = root / "houses.json"
            fallback_file = root / "fallback.json"
            portrait_path = "portraits/character-api-3.webp"
            characters_output.write_text(
                json.dumps(
                    {
                        "characters": [
                            {
                                "id": "character-api-3",
                                "portrait_path": portrait_path,
                            },
                            {
                                "id": "character-api-99",
                                "portrait_path": "portraits/old-character.webp",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            fallback_file.write_text(
                json.dumps(
                    {
                        "characters": [
                            self._api_character(
                                3,
                                "Named Character",
                                ["https://anapioficeandfire.com/api/books/1"],
                            )
                        ],
                        "houses": [],
                    }
                ),
                encoding="utf-8",
            )
            arguments = import_characters.parse_arguments(
                [
                    "--source",
                    "iceandfire",
                    "--fallback-file",
                    str(fallback_file),
                    "--cache-dir",
                    str(root / "cache"),
                    "--limit",
                    "1",
                    "--characters-output",
                    str(characters_output),
                    "--houses-output",
                    str(houses_output),
                ]
            )
            import_characters.run_import(arguments)
            regenerated = json.loads(characters_output.read_text(encoding="utf-8"))
            self.assertEqual(
                portrait_path,
                regenerated["characters"][0]["portrait_path"],
            )
            self.assertNotIn(
                "character-api-99",
                {
                    character["id"]
                    for character in regenerated["characters"]
                },
            )

    def test_regeneration_rejects_unsafe_existing_portrait(self):
        with tempfile.TemporaryDirectory() as directory:
            characters_output = Path(directory) / "characters.json"
            characters_output.write_text(
                json.dumps(
                    {
                        "characters": [
                            {
                                "id": "character-api-3",
                                "portrait_path": "../private/character.webp",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(import_characters.ImportFailure):
                import_characters.load_existing_portrait_paths(
                    characters_output
                )

    def test_regeneration_rejects_symlinked_character_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real_output = root / "real-characters.json"
            real_output.write_text('{"characters": []}', encoding="utf-8")
            linked_output = root / "characters.json"
            linked_output.symlink_to(real_output)
            with self.assertRaises(import_characters.ImportFailure):
                import_characters.load_existing_portrait_paths(linked_output)

    def test_importer_and_validator_use_same_portrait_rules(self):
        paths = (
            None,
            "portraits/character.webp",
            "portraits/family/character.png",
            "../portraits/character.webp",
            "assets/portraits/character.webp",
            "portraits/character.svg",
            "https://example.com/character.webp",
        )
        for path in paths:
            self.assertEqual(
                validate_data.validate_portrait_path(path),
                import_characters.validate_portrait_path(path),
                path,
            )

    def test_fallback_excludes_blank_and_bookless_characters(self):
        house_url = "https://anapioficeandfire.com/api/houses/1"
        raw_houses = [
            {
                "url": house_url,
                "name": "House Test",
                "region": "The North",
            }
        ]
        houses_by_url, _ = import_characters.build_api_houses(raw_houses)
        raw_characters = [
            self._api_character(1, "", ["https://anapioficeandfire.com/api/books/1"]),
            self._api_character(2, "Bookless", []),
            self._api_character(
                3,
                "Named Character",
                ["https://anapioficeandfire.com/api/books/1"],
                allegiances=[house_url],
            ),
        ]
        records = import_characters.build_api_characters(
            raw_characters, houses_by_url
        )
        self.assertEqual(["Named Character"], [record["name"] for record in records])
        self.assertEqual(["house-api-1"], records[0]["house_ids"])

    def test_release_selection_is_deterministic(self):
        houses = [
            {
                "id": "house-stark",
                "name": "House Stark",
                "kind": "house",
                "region": "The North",
                "major": True,
                "source": None,
            }
        ]
        lower = self._rankable_character(
            "character-api-2",
            "Second",
            ["book-1"],
            [],
            500,
        )
        higher = self._rankable_character(
            "character-api-1",
            "First",
            ["book-1"],
            ["book-1"],
            100,
        )
        first_order = import_characters.choose_release(
            copy.deepcopy([lower, higher]), houses, 2
        )
        second_order = import_characters.choose_release(
            copy.deepcopy([higher, lower]), houses, 2
        )
        self.assertEqual(
            [record["id"] for record in first_order],
            [record["id"] for record in second_order],
        )
        self.assertEqual("character-api-1", first_order[0]["id"])
        self.assertEqual([1, 2], [record["rank"] for record in first_order])

    @staticmethod
    def _api_character(api_id, name, books, allegiances=None):
        return {
            "url": "https://anapioficeandfire.com/api/characters/{}".format(api_id),
            "name": name,
            "gender": "Unknown",
            "culture": "",
            "born": "",
            "died": "",
            "titles": [],
            "aliases": [],
            "allegiances": allegiances or [],
            "books": books,
            "povBooks": [],
        }

    @staticmethod
    def _rankable_character(character_id, name, books, pov_books, length):
        return {
            "id": character_id,
            "name": name,
            "accepted_names": [name],
            "gender": "unknown",
            "culture": None,
            "born": None,
            "died": None,
            "titles": [],
            "house_ids": [],
            "group_id": "group-unaffiliated",
            "book_ids": books,
            "pov_book_ids": pov_books,
            "article_length": length,
            "portrait_path": None,
            "source": {
                "source_id": "an-api-of-ice-and-fire",
                "url": "https://anapioficeandfire.com/api/characters/{}".format(
                    character_id.rsplit("-", 1)[-1]
                ),
                "revision_id": None,
                "revision_timestamp": None,
            },
        }


if __name__ == "__main__":
    unittest.main()
