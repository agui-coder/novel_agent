import shutil
import subprocess
import sys
import unittest
import uuid
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from agents.world_draft_git import (  # noqa: E402
    DRAFT_BRANCH_NAME,
    _draft_review_metadata,
    _filter_changed_draft_files_by_git_diff,
)


class V72ReviewChangedFilesTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = ROOT_DIR / ".tmp_tests"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tmp_root / f"v72_review_changed_files_{uuid.uuid4().hex}"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.repo_dir = self.temp_dir / "book"
        self.repo_dir.mkdir(parents=True, exist_ok=True)
        self._git("init")
        self._git("config", "user.name", "LoreGit Bot")
        self._git("config", "user.email", "loregit@example.local")

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _git(self, *args: str) -> str:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(self.repo_dir),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return proc.stdout.strip()

    def _write(self, file_name: str, content: str) -> None:
        path = self.repo_dir / file_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_snapshot_noise_is_filtered_by_real_draft_diff(self):
        outline_files = [
            "arc_outline.md",
            "brainstorm.md",
            "chapter_outline.md",
            "master_outline.md",
        ]
        for file_name in outline_files:
            self._write(file_name, f"# {file_name}\n\n主线内容\n")
        self._git("add", "--all")
        self._git("commit", "-m", "baseline")

        self._git("checkout", "-b", DRAFT_BRANCH_NAME)
        self._write("brainstorm.md", "# brainstorm.md\n\n草稿分支真实改动\n")
        self._git("add", "brainstorm.md")
        self._git("commit", "-m", "draft updates brainstorm only")

        noisy_changed_files = [
            {
                "file_name": file_name,
                "before": {"etag": f"before-{file_name}"},
                "after": {"etag": f"after-{file_name}"},
            }
            for file_name in outline_files
        ]

        filtered = _filter_changed_draft_files_by_git_diff(
            str(self.repo_dir),
            noisy_changed_files,
            outline_files,
        )

        self.assertEqual([item["file_name"] for item in filtered], ["brainstorm.md"])

    def test_filter_falls_back_when_draft_branch_is_missing(self):
        self._write("world_model.md", "# 世界模型\n")
        self._git("add", "--all")
        self._git("commit", "-m", "baseline")

        changed_files = [
            {
                "file_name": "world_model.md",
                "before": {"etag": "before"},
                "after": {"etag": "after"},
            }
        ]

        self.assertEqual(
            _filter_changed_draft_files_by_git_diff(str(self.repo_dir), changed_files, ["world_model.md"]),
            changed_files,
        )

    def test_branch_scoped_diff_uses_source_branch_after_checkout_changes(self):
        self._write("chapter_outline.md", "# 逐章大纲\n\nmaster\n")
        self._write("world_model.md", "# 世界模型\n\nmaster\n")
        self._git("add", "--all")
        self._git("commit", "-m", "baseline master")

        self._git("checkout", "-b", "plot/source")
        self._write("world_model.md", "# 世界模型\n\nsource only\n")
        self._git("add", "world_model.md")
        self._git("commit", "-m", "source branch world")

        self._git("checkout", "-b", DRAFT_BRANCH_NAME)
        self._write("chapter_outline.md", "# 逐章大纲\n\nsource draft card\n")
        self._git("add", "chapter_outline.md")
        self._git("commit", "-m", "draft updates outline only")

        self._git("checkout", "master")

        noisy_changed_files = [
            {
                "file_name": "chapter_outline.md",
                "before": {"etag": "before-outline"},
                "after": {"etag": "after-outline"},
            },
            {
                "file_name": "world_model.md",
                "before": {"etag": "before-world"},
                "after": {"etag": "after-world"},
            },
        ]

        filtered = _filter_changed_draft_files_by_git_diff(
            str(self.repo_dir),
            noisy_changed_files,
            ["chapter_outline.md", "world_model.md"],
        )
        metadata = _draft_review_metadata(str(self.repo_dir))

        self.assertEqual(metadata["base_branch"], "plot/source")
        self.assertEqual([item["file_name"] for item in filtered], ["chapter_outline.md"])


if __name__ == "__main__":
    unittest.main()
