import argparse
import base64
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "generate_portraits.py"
SPEC = importlib.util.spec_from_file_location("generate_portraits", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load portrait pipeline for tests.")
portrait_pipeline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(portrait_pipeline)


class FakeStatusError(Exception):
    def __init__(
        self,
        message="private response text",
        *,
        status_code=500,
        body=None,
        request_id="request-safe-id",
    ):
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.request_id = request_id


class FakeImages:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class PortraitPipelineTests(unittest.TestCase):
    def character(self, **changes):
        value = {
            "id": "arya-stark",
            "name": "Arya",
            "house": "House Stark",
            "appearance": "young, dark hair, practical wool clothing",
            "sourceLinks": ["https://example.test/characters/arya"],
        }
        value.update(changes)
        return value

    def test_safe_filename_is_id_derived_and_bounded(self):
        self.assertEqual(
            portrait_pipeline.safe_filename_id(" ../Arya_Stark?! "),
            "arya-stark",
        )
        self.assertLessEqual(
            len(portrait_pipeline.safe_filename_id("A" * 200)),
            80,
        )
        with self.assertRaises(portrait_pipeline.PipelineError):
            portrait_pipeline.safe_filename_id("../../")

    def test_manifest_rejects_filename_collision(self):
        characters = [
            self.character(id="arya stark"),
            self.character(id="arya-stark", name="Different entry"),
        ]
        with self.assertRaisesRegex(
            portrait_pipeline.PipelineError,
            "same safe filename",
        ):
            portrait_pipeline.sync_manifest(
                characters,
                {"portraits": []},
                now="2026-01-01T00:00:00Z",
            )

    def test_prompt_has_required_safety_direction(self):
        prompt = portrait_pipeline.build_prompt(self.character())
        for phrase in (
            "head-and-shoulders",
            "illuminated-manuscript",
            "no resemblance to any real actor",
            "Do not copy official artwork",
            "named living artist",
            "no text",
            "No graphic violence",
        ):
            self.assertIn(phrase.lower(), prompt.lower())

    def test_manifest_sync_sets_fields_and_never_approves(self):
        manifest = portrait_pipeline.sync_manifest(
            [self.character()],
            {"portraits": []},
            now="2026-01-01T00:00:00Z",
        )
        record = manifest["portraits"][0]
        required = {
            "prompt",
            "model",
            "status",
            "generated_path",
            "review_status",
            "source_links",
            "created_at",
            "updated_at",
            "generated_at",
            "reviewed_at",
        }
        self.assertTrue(required.issubset(record))
        self.assertEqual(record["model"], "gpt-image-2")
        self.assertEqual(record["status"], "pending")
        self.assertEqual(record["review_status"], "pending")
        self.assertEqual(
            record["placeholder_path"],
            "assets/placeholders/stark.svg",
        )

    def test_manifest_sync_resumes_interrupted_record(self):
        old = portrait_pipeline.sync_manifest(
            [self.character()],
            {"portraits": []},
            now="2026-01-01T00:00:00Z",
        )
        old["portraits"][0]["status"] = "generating"
        synced = portrait_pipeline.sync_manifest(
            [self.character()],
            old,
            now="2026-01-02T00:00:00Z",
        )
        self.assertEqual(synced["portraits"][0]["status"], "pending")
        self.assertEqual(
            synced["portraits"][0]["created_at"],
            "2026-01-01T00:00:00Z",
        )

    def test_source_links_accept_http_without_credentials(self):
        links = portrait_pipeline.extract_source_links(
            self.character(
                sourceLinks=[
                    "https://example.test/good",
                    "https://user:password@example.test/bad",
                    "https://example.test/bad?token=secret",
                    "file:///tmp/private",
                    {"url": "http://example.test/also-good"},
                ]
            )
        )
        self.assertEqual(
            links,
            ["https://example.test/good", "http://example.test/also-good"],
        )

    def test_nested_source_and_house_id_match_data_schema(self):
        character = self.character(
            house=None,
            sourceLinks=None,
            house_ids=["house-stark"],
            group_id="house-stark",
            source={"url": "https://example.test/characters/arya"},
            titles=["Princess"],
            culture="Northmen",
        )
        manifest = portrait_pipeline.sync_manifest(
            [character],
            {"portraits": []},
            now="2026-01-01T00:00:00Z",
        )
        record = manifest["portraits"][0]
        self.assertEqual(record["house"], "house-stark")
        self.assertEqual(
            record["placeholder_path"],
            "assets/placeholders/stark.svg",
        )
        self.assertEqual(
            record["source_links"],
            ["https://example.test/characters/arya"],
        )
        self.assertIn("titles: Princess", record["prompt"])
        self.assertIn("culture: Northmen", record["prompt"])

    def test_numeric_house_id_uses_safe_name_theme_fallback(self):
        character = self.character(
            name="Eddard Stark",
            house=None,
            house_ids=["house-api-362"],
            group_id="house-api-362",
        )
        self.assertEqual(
            portrait_pipeline.placeholder_path(character),
            "assets/placeholders/stark.svg",
        )

    def test_dry_run_does_not_require_sdk_key_or_network(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest_path = Path(temp_dir) / "portrait-manifest.json"
            args = argparse.Namespace(execute=False, limit=None, confirm=None)
            with (
                mock.patch.object(
                    portrait_pipeline,
                    "read_characters",
                    return_value=[self.character()],
                ),
                mock.patch.object(
                    portrait_pipeline,
                    "read_manifest",
                    return_value={"version": 1, "portraits": []},
                ),
                mock.patch.object(
                    portrait_pipeline,
                    "MANIFEST_PATH",
                    manifest_path,
                ),
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(portrait_pipeline, "OpenAI", None),
                mock.patch("builtins.print"),
            ):
                result = portrait_pipeline.run(args)
            self.assertEqual(result, 0)
            saved = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["portraits"][0]["status"], "pending")

    def test_execute_requires_limit_confirmation_and_key(self):
        with self.assertRaisesRegex(portrait_pipeline.PipelineError, "--limit"):
            portrait_pipeline.validate_execute_options(
                argparse.Namespace(execute=True, limit=None, confirm=None)
            )
        with self.assertRaisesRegex(portrait_pipeline.PipelineError, "--confirm"):
            portrait_pipeline.validate_execute_options(
                argparse.Namespace(execute=True, limit=1, confirm="yes")
            )
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            self.assertRaisesRegex(portrait_pipeline.PipelineError, "OPENAI_API_KEY"),
        ):
            portrait_pipeline.validate_execute_options(
                argparse.Namespace(
                    execute=True,
                    limit=portrait_pipeline.MAX_BATCH_LIMIT,
                    confirm=portrait_pipeline.CONFIRMATION,
                )
            )

    def test_limit_is_bounded(self):
        with self.assertRaisesRegex(portrait_pipeline.PipelineError, "between"):
            portrait_pipeline.validate_execute_options(
                argparse.Namespace(
                    execute=True,
                    limit=portrait_pipeline.MAX_BATCH_LIMIT + 1,
                    confirm=portrait_pipeline.CONFIRMATION,
                )
            )

    def test_base64_png_validation_rejects_wrong_signature_and_large_input(self):
        valid_bytes = portrait_pipeline.PNG_SIGNATURE + b"safe-data"
        encoded = base64.b64encode(valid_bytes).decode("ascii")
        self.assertEqual(
            portrait_pipeline.decode_and_validate_png(encoded),
            valid_bytes,
        )
        wrong = base64.b64encode(b"not a png").decode("ascii")
        with self.assertRaisesRegex(portrait_pipeline.PipelineError, "not a PNG"):
            portrait_pipeline.decode_and_validate_png(wrong)
        with (
            mock.patch.object(portrait_pipeline, "MAX_BASE64_CHARS", 3),
            self.assertRaisesRegex(portrait_pipeline.PipelineError, "size limit"),
        ):
            portrait_pipeline.decode_and_validate_png(encoded)

    def test_images_request_retries_transient_failure_with_jitter(self):
        response = SimpleNamespace(
            data=[SimpleNamespace(b64_json="encoded-image")]
        )
        client = SimpleNamespace(
            images=FakeImages([FakeStatusError(status_code=429), response])
        )
        sleep = mock.Mock()
        result = portrait_pipeline.call_images_api(
            client,
            "secret prompt must not be logged",
            sleep=sleep,
            random_value=lambda: 0.25,
            max_retries=2,
        )
        self.assertEqual(result, "encoded-image")
        self.assertEqual(len(client.images.calls), 2)
        self.assertEqual(sleep.call_args_list, [mock.call(1.25)])
        request = client.images.calls[0]
        self.assertEqual(request["model"], "gpt-image-2")
        self.assertEqual(request["output_format"], "png")
        self.assertEqual(request["response_format"], "b64_json")

    def test_moderation_failure_is_sanitized_and_not_approved(self):
        private_message = "blocked because of private prompt details"
        error = FakeStatusError(
            private_message,
            status_code=400,
            body={
                "error": {
                    "code": "content_policy_violation",
                    "message": private_message,
                }
            },
        )
        manifest = portrait_pipeline.sync_manifest(
            [self.character()],
            {"portraits": []},
            now="2026-01-01T00:00:00Z",
        )
        record = manifest["portraits"][0]
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest_path = Path(temp_dir) / "manifest.json"
            with (
                mock.patch.object(
                    portrait_pipeline,
                    "call_images_api",
                    side_effect=error,
                ),
                self.assertRaises(FakeStatusError),
            ):
                portrait_pipeline.generate_record(
                    SimpleNamespace(),
                    record,
                    manifest,
                    manifest_path=manifest_path,
                    output_dir=Path(temp_dir) / "portraits",
                )
            saved_text = manifest_path.read_text(encoding="utf-8")
        self.assertEqual(record["status"], "moderation_blocked")
        self.assertEqual(record["review_status"], "pending")
        self.assertNotIn(private_message, saved_text)
        self.assertEqual(record["error"]["kind"], "moderation")

    def test_atomic_manifest_write_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            target = directory / "target.json"
            target.write_text("{}", encoding="utf-8")
            link = directory / "manifest.json"
            link.symlink_to(target)
            with self.assertRaisesRegex(
                portrait_pipeline.PipelineError,
                "symbolic-link",
            ):
                portrait_pipeline.atomic_write_json(link, {"portraits": []})

    def test_review_actions_are_mutually_exclusive_with_generation(self):
        parser = portrait_pipeline.build_parser()
        with mock.patch("sys.stderr"):
            with self.assertRaises(SystemExit):
                parser.parse_args(
                    ["--execute", "--approve", "arya-stark", "--limit", "1"]
                )
            with self.assertRaises(SystemExit):
                parser.parse_args(
                    ["--approve", "arya-stark", "--reject", "arya-stark"]
                )

    def test_approved_webp_files_are_not_gitignored(self):
        ignore_text = (
            SCRIPT_PATH.parents[1] / ".gitignore"
        ).read_text(encoding="utf-8")
        self.assertNotIn("assets/portraits/*.webp", ignore_text)
        self.assertIn("assets/portraits/*.png", ignore_text)
        self.assertIn("assets/portraits/.*.tmp", ignore_text)

    def test_approve_publishes_validated_generated_portrait(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_dir = root / "assets" / "portraits"
            output_dir.mkdir(parents=True)
            webp_path = output_dir / "arya-stark.webp"
            webp_path.write_bytes(b"mock-webp")
            characters_path = root / "data" / "characters.json"
            characters_path.parent.mkdir()
            characters_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "characters": [
                            self.character(portrait_path=None),
                        ],
                    }
                ),
                encoding="utf-8",
            )
            manifest_path = root / "data" / "portrait-manifest.json"
            manifest = portrait_pipeline.sync_manifest(
                [self.character()],
                {"portraits": []},
                now="2026-01-01T00:00:00Z",
            )
            record = manifest["portraits"][0]
            record["status"] = "generated"
            record["generated_path"] = "assets/portraits/arya-stark.webp"

            with mock.patch.object(
                portrait_pipeline,
                "validate_webp_file",
            ) as validate:
                portrait_pipeline.review_portrait(
                    manifest,
                    "arya-stark",
                    approve=True,
                    manifest_path=manifest_path,
                    characters_path=characters_path,
                    output_dir=output_dir,
                )

            validate.assert_called_once_with(webp_path)
            saved_characters = json.loads(
                characters_path.read_text(encoding="utf-8")
            )
            saved_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(
                saved_characters["characters"][0]["portrait_path"],
                "portraits/arya-stark.webp",
            )
            self.assertEqual(
                saved_manifest["portraits"][0]["review_status"],
                "approved",
            )
            self.assertIsNotNone(
                saved_manifest["portraits"][0]["reviewed_at"]
            )

    def test_reject_clears_publication_without_deleting_webp(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_dir = root / "portraits"
            output_dir.mkdir()
            webp_path = output_dir / "arya-stark.webp"
            webp_path.write_bytes(b"keep-this-file")
            characters_path = root / "characters.json"
            characters_path.write_text(
                json.dumps(
                    {
                        "characters": [
                            self.character(
                                portrait_path="portraits/arya-stark.webp"
                            )
                        ]
                    }
                ),
                encoding="utf-8",
            )
            manifest_path = root / "manifest.json"
            manifest = portrait_pipeline.sync_manifest(
                [self.character()],
                {"portraits": []},
                now="2026-01-01T00:00:00Z",
            )
            manifest["portraits"][0]["status"] = "generated"
            manifest["portraits"][0][
                "generated_path"
            ] = "assets/portraits/arya-stark.webp"

            with mock.patch.object(
                portrait_pipeline,
                "validate_webp_file",
            ) as validate:
                portrait_pipeline.review_portrait(
                    manifest,
                    "arya-stark",
                    approve=False,
                    manifest_path=manifest_path,
                    characters_path=characters_path,
                    output_dir=output_dir,
                )

            validate.assert_not_called()
            saved_characters = json.loads(
                characters_path.read_text(encoding="utf-8")
            )
            self.assertIsNone(
                saved_characters["characters"][0]["portrait_path"]
            )
            self.assertEqual(
                manifest["portraits"][0]["review_status"],
                "rejected",
            )
            self.assertTrue(webp_path.exists())
            self.assertEqual(webp_path.read_bytes(), b"keep-this-file")

    def test_approve_requires_generated_status_and_safe_file(self):
        manifest = portrait_pipeline.sync_manifest(
            [self.character()],
            {"portraits": []},
            now="2026-01-01T00:00:00Z",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            characters_path = root / "characters.json"
            characters_path.write_text(
                json.dumps({"characters": [self.character()]}),
                encoding="utf-8",
            )
            output_dir = root / "portraits"
            output_dir.mkdir()
            with self.assertRaisesRegex(
                portrait_pipeline.PipelineError,
                "generated portrait",
            ):
                portrait_pipeline.review_portrait(
                    manifest,
                    "arya-stark",
                    approve=True,
                    manifest_path=root / "manifest.json",
                    characters_path=characters_path,
                    output_dir=output_dir,
                )

            manifest["portraits"][0]["status"] = "generated"
            manifest["portraits"][0][
                "generated_path"
            ] = "assets/portraits/arya-stark.webp"
            with self.assertRaisesRegex(
                portrait_pipeline.PipelineError,
                "missing or unsafe",
            ):
                portrait_pipeline.review_portrait(
                    manifest,
                    "arya-stark",
                    approve=True,
                    manifest_path=root / "manifest.json",
                    characters_path=characters_path,
                    output_dir=output_dir,
                )

    def test_webp_validation_checks_format_and_dimensions(self):
        valid_image = mock.MagicMock()
        valid_image.__enter__.return_value = valid_image
        valid_image.format = "WEBP"
        valid_image.size = (512, 512)
        image_module = mock.Mock()
        image_module.open.return_value = valid_image
        portrait_pipeline.validate_webp_file(
            Path("mock.webp"),
            image_module=image_module,
        )
        valid_image.load.assert_called_once()

        wrong_size = mock.MagicMock()
        wrong_size.__enter__.return_value = wrong_size
        wrong_size.format = "WEBP"
        wrong_size.size = (1024, 1024)
        image_module.open.return_value = wrong_size
        with self.assertRaisesRegex(
            portrait_pipeline.PipelineError,
            "512x512",
        ):
            portrait_pipeline.validate_webp_file(
                Path("mock.webp"),
                image_module=image_module,
            )

        wrong_format = mock.MagicMock()
        wrong_format.__enter__.return_value = wrong_format
        wrong_format.format = "PNG"
        wrong_format.size = (512, 512)
        image_module.open.return_value = wrong_format
        with self.assertRaisesRegex(
            portrait_pipeline.PipelineError,
            "WebP",
        ):
            portrait_pipeline.validate_webp_file(
                Path("mock.webp"),
                image_module=image_module,
            )

    def test_review_rolls_back_character_data_if_manifest_write_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_dir = root / "portraits"
            output_dir.mkdir()
            (output_dir / "arya-stark.webp").write_bytes(b"mock-webp")
            characters_path = root / "characters.json"
            original_document = {
                "characters": [self.character(portrait_path=None)]
            }
            characters_path.write_text(
                json.dumps(original_document),
                encoding="utf-8",
            )
            manifest_path = root / "manifest.json"
            manifest = portrait_pipeline.sync_manifest(
                [self.character()],
                {"portraits": []},
                now="2026-01-01T00:00:00Z",
            )
            manifest["portraits"][0]["status"] = "generated"
            manifest["portraits"][0][
                "generated_path"
            ] = "assets/portraits/arya-stark.webp"
            real_atomic_write = portrait_pipeline.atomic_write_json

            def fail_manifest_write(path, value):
                if path == manifest_path:
                    raise portrait_pipeline.PipelineError("mock failure")
                real_atomic_write(path, value)

            with (
                mock.patch.object(
                    portrait_pipeline,
                    "validate_webp_file",
                ),
                mock.patch.object(
                    portrait_pipeline,
                    "atomic_write_json",
                    side_effect=fail_manifest_write,
                ),
                self.assertRaisesRegex(
                    portrait_pipeline.PipelineError,
                    "restored",
                ),
            ):
                portrait_pipeline.review_portrait(
                    manifest,
                    "arya-stark",
                    approve=True,
                    manifest_path=manifest_path,
                    characters_path=characters_path,
                    output_dir=output_dir,
                )

            restored = json.loads(characters_path.read_text(encoding="utf-8"))
            self.assertEqual(restored, original_document)
            self.assertEqual(
                manifest["portraits"][0]["review_status"],
                "pending",
            )


if __name__ == "__main__":
    unittest.main()
