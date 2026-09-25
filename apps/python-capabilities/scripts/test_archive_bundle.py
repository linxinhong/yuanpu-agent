import pathlib
import tarfile
import tempfile
import unittest

from archive_bundle import archive_bundle


class ArchiveBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.root = self.base / "bundle"
        self.root.mkdir()
        self.output = self.base / "bundle.tar.gz"
        (self.root / "data").mkdir()
        (self.root / "data" / "python").write_bytes(b"runtime")

    def link(self, target, path, directory=False):
        try:
            path.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            if getattr(error, "winerror", None) == 1314:
                self.skipTest("Creating Windows symlinks requires privilege")
            raise

    def test_internal_links_are_regular_members(self):
        self.link("data/python", self.root / "Python")
        self.link("data", self.root / "alias", True)
        archive_bundle(self.root, self.output)
        with tarfile.open(self.output) as archive:
            self.assertTrue(all(item.isfile() or item.isdir() for item in archive))
            self.assertEqual(archive.extractfile("bundle/Python").read(), b"runtime")
            self.assertEqual(archive.extractfile("bundle/alias/python").read(), b"runtime")

    def test_external_link_is_rejected(self):
        (self.base / "outside").write_bytes(b"not in bundle")
        self.link("../outside", self.root / "escape")
        with self.assertRaisesRegex(ValueError, "escapes root"):
            archive_bundle(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_directory_cycle_is_rejected(self):
        self.link("..", self.root / "data" / "cycle", True)
        with self.assertRaisesRegex(ValueError, "cycle"):
            archive_bundle(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_broken_link_is_rejected(self):
        self.link("missing", self.root / "broken")
        with self.assertRaises(FileNotFoundError):
            archive_bundle(self.root, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
