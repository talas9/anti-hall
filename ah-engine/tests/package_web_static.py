#!/usr/bin/env python3
"""The ah-web disk assets travel with its optional binary, outside the plugin tree."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]


class WebPackageTests(unittest.TestCase):
    def test_web_assets_ship_with_the_server_only(self):
        with tempfile.TemporaryDirectory(prefix="ah-web-package-") as scratch:
            root = Path(scratch)
            engine = root / "ah-engine"
            scripts = engine / "scripts"
            scripts.mkdir(parents=True)
            shutil.copyfile(REPO / "ah-engine/scripts/package.sh", scripts / "package.sh")
            # Isolate packaging from Cargo discovery/builds; only its metadata helper is stubbed.
            (scripts / "lib-target.sh").write_text('cargo_target_dir() { printf "%s\\n" "$CARGO_TARGET_DIR"; }\n')
            (engine / "Cargo.toml").write_text('version = "0.2.0"\n')
            (engine / "README.md").write_text("fixture\n")
            (root / "LICENSE").write_text("fixture\n")
            target = root / "artifacts"
            binaries = target / "fixture-triple/release"
            binaries.mkdir(parents=True)
            for binary in ("ah-engine", "ah-hook", "ah-web"):
                (binaries / binary).write_bytes(binary.encode())
            static = root / "ah-web/web/static"
            shutil.copytree(REPO / "ah-web/web/static", static)
            env = dict(os.environ, CARGO_TARGET_DIR=str(target), AH_HOOK_BIN=str(binaries / "ah-hook"), AH_WEB_BIN=str(binaries / "ah-web"))
            expected = (static / "vendor/apexcharts.min.js").read_bytes()
            self.assertTrue(expected.startswith(b"/*!\n * ApexCharts v4.7.0"))
            for with_web in (True, False):
                out = root / ("with-web" if with_web else "without-web")
                env["AH_WEB_BIN"] = str(binaries / ("ah-web" if with_web else "missing"))
                subprocess.run(["bash", str(scripts / "package.sh"), "fixture-triple", str(out)], env=env, check=True, capture_output=True)
                archive = out / "ah-engine-v0.2.0-fixture-triple.tar.gz"
                prefix = "ah-engine-v0.2.0-fixture-triple"
                with tarfile.open(archive) as tar:
                    self.assertEqual(f"{prefix}/ah-web" in tar.getnames(), with_web)
                    member = f"{prefix}/web/static/vendor/apexcharts.min.js"
                    self.assertEqual(member in tar.getnames(), with_web)
                    if with_web:
                        self.assertEqual(tar.extractfile(member).read(), expected)
                        self.assertEqual(tar.getmember(member).mode, 0o644)
                self.assertEqual(archive.with_suffix(".gz.sha256").read_text().split()[0], hashlib.sha256(archive.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
