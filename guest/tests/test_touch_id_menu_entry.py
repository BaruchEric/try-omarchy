from __future__ import annotations

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile
import unittest


GUEST = Path(__file__).resolve().parents[1]
SCRIPT = GUEST / "scripts/install-touch-id-menu-entry.py"
SPEC = spec_from_file_location("install_touch_id_menu_entry", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
menu_installer = module_from_spec(SPEC)
SPEC.loader.exec_module(menu_installer)


class TouchIDMenuEntryTests(unittest.TestCase):
    def test_compact_objects_keep_the_entry_inside_the_object(self) -> None:
        for original in ('{}\n', '{"personal": true}\n', '{"personal": true\n}\n'):
            with self.subTest(original=original), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "menu.jsonc"
                path.write_text(original)
                menu_installer.install(path)
                updated = path.read_text()
                self.assertEqual(updated, '{\n' + menu_installer.ENTRY + original[1:])
                self.assertTrue(updated.rstrip().endswith('}'))
                menu_installer.install(path)
                self.assertEqual(path.read_text(), updated)

    def test_preserves_existing_jsonc_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".config/omarchy/extensions/omarchy-menu.jsonc"
            path.parent.mkdir(parents=True)
            original = '{\n  // User comment.\n  "personal": {"label":"Personal"},\n}\n'
            path.write_text(original, encoding="utf-8")

            menu_installer.install(path)
            first = path.read_text(encoding="utf-8")
            menu_installer.install(path)

            self.assertIn(menu_installer.ENTRY_ID, first)
            self.assertIn("// User comment.", first)
            self.assertIn('"personal": {"label":"Personal"}', first)
            self.assertEqual(path.read_text(encoding="utf-8"), first)

    def test_creates_a_missing_extension(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "extensions/omarchy-menu.jsonc"
            menu_installer.install(path)
            self.assertIn(menu_installer.ENTRY_ID, path.read_text(encoding="utf-8"))

    def test_rejects_a_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            target = base / "target"
            target.write_text("{}\n", encoding="utf-8")
            path = base / "menu.jsonc"
            path.symlink_to(target)
            with self.assertRaises(SystemExit):
                menu_installer.install(path)


if __name__ == "__main__":
    unittest.main()
