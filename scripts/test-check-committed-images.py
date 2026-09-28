#!/usr/bin/env python3
"""Tests for scripts/check-committed-images.py (TAL-390).

Run: python3 scripts/test-check-committed-images.py
"""
import importlib.util
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("check_committed_images", str(Path(__file__).with_name("check-committed-images.py")))
cci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cci)


class AllowedTests(unittest.TestCase):
    def test_shipped_and_tested_assets_are_allowed(self):
        for path in [
            "app/Talaria/Resources/Assets.xcassets/AppIcon.appiconset/icon.png",
            "app/Talaria/Resources/ProviderIcons.xcassets/ProviderIconOpenAI.imageset/openai.svg",
            "app/Talaria/Resources/Talaria.icon/Assets/sandal.png",
            "app/TalariaTests/VisualReferences/session-row-light.png",
            "app/docs/assets/readme/screenshot-chat.png",
            "web/static/brand/favicon.ico",
        ]:
            self.assertTrue(cci.allowed(path), path)

    def test_evidence_screenshots_are_rejected(self):
        for path in [
            "web/docs/pr-media/2548/reload-btn_dark_1280.png",
            "docs/validation/TAL-363/web-refresh-popup-mobile.png",
            "web/docs/ui-ux/evidence/tal233/after-desktop.png",
            "web/docs/images/ui-sessions.PNG",
            "evidence.pdf",
        ]:
            self.assertFalse(cci.allowed(path), path)

    def test_non_images_are_ignored(self):
        for path in ["web/docs/pr-media/2518/PR_BODY.md", "docs/validation/TAL-322/README.md", "web/static/dist/index.html"]:
            self.assertTrue(cci.allowed(path), path)

    def test_a_folder_merely_named_like_a_bundle_suffix_is_not_enough(self):
        self.assertFalse(cci.allowed("docs/not-an.xcassets-folder/screenshot.png"))


if __name__ == "__main__":
    unittest.main()
