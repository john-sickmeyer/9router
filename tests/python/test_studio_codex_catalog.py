import importlib.util
import pathlib
import contextlib
import io
import json
import tempfile
from unittest.mock import patch
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("studio_catalog", ROOT / "scripts/studio-codex-catalog.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CONFIG = (ROOT / "open-sse/config/studioControls.js").read_text()


class CatalogTest(unittest.TestCase):
    def fixture(self):
        return {"models": [{"slug": slug, "base_instructions": "Native instructions",
            "context_window": 272000, "tool_mode": "code_mode_only",
            "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}, {"effort": "ultra"}],
            "default_service_tier": "priority", "service_tiers": [{"id": "priority"}]}
            for slug in ["gpt-6.1-sol", "gpt-6-astra"]]}

    def test_preserves_native_metadata_and_independent_effort(self):
        original = self.fixture()
        actual = module.build_catalog(original, CONFIG)["models"]
        self.assertEqual(len(actual), 6)
        self.assertEqual(len({entry["slug"] for entry in actual}), 6)
        for index, entry in enumerate(actual):
            self.assertEqual(entry["slug"], original["models"][index // 3]["slug"] + "@" + ["standard", "fast", "ultrafast"][index % 3])
            for field in ["base_instructions", "context_window", "tool_mode", "supported_reasoning_levels"]:
                self.assertEqual(entry[field], original["models"][index // 3][field])
            self.assertIsNone(entry["default_service_tier"])
            self.assertEqual(entry["service_tiers"], [])
        self.assertEqual(actual[2]["display_name"], "GPT-6.1 Sol Ultrafast")
        actual[0]["supported_reasoning_levels"][0]["effort"] = "changed"
        self.assertEqual(actual[1]["supported_reasoning_levels"][0]["effort"], "low")
        self.assertEqual(original["models"][0]["supported_reasoning_levels"][0]["effort"], "low")

    def test_rejects_missing_model(self):
        with self.assertRaisesRegex(ValueError, "both Studio models"):
            module.build_catalog({"models": self.fixture()["models"][:1]}, CONFIG)

    def test_rejects_missing_effort_metadata(self):
        catalog = self.fixture()
        catalog["models"][0]["supported_reasoning_levels"] = []
        with self.assertRaisesRegex(ValueError, "incomplete"):
            module.build_catalog(catalog, CONFIG)

    def test_written_codex_menu_contains_only_openai_models(self):
        catalog = self.fixture()
        catalog['models'].append({'slug': 'gpt-5.5', 'tool_mode': None, 'use_responses_lite': False,
            'model_messages': {'instructions_template': 'You are Codex, based on GPT-5.'}})
        with tempfile.TemporaryDirectory() as temp:
            destination = pathlib.Path(temp) / 'models.json'
            with patch.object(module.sys, 'argv', ['catalog', '0.166.0', str(destination)]), \
                    patch.object(module.urllib.request, 'urlopen', return_value=io.StringIO(json.dumps(catalog))), \
                    contextlib.redirect_stdout(io.StringIO()):
                module.main()
            actual = json.loads(destination.read_text())['models']
        self.assertEqual(len(actual), 6)
        self.assertEqual({m['slug'].split('@')[0] for m in actual}, {'gpt-6.1-sol', 'gpt-6-astra'})


if __name__ == "__main__":
    unittest.main()
