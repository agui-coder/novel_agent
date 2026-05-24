import json
import shutil
import subprocess
import sys
import unittest
import uuid
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from utils.draft_metadata import DRAFT_BRANCH_NAME, write_draft_metadata  # noqa: E402
from utils.prose_delivery_state import (  # noqa: E402
    PROSE_DELIVERY_STATE_REL_PATH,
    create_or_refresh_prose_delivery_state,
    parse_chapter_spans,
    state_staleness,
)


class V77ProseDeliveryStateTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = ROOT_DIR / ".tmp_tests"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tmp_root / f"v77_prose_delivery_{uuid.uuid4().hex}"
        self.repo_dir = self.temp_dir / "book"
        self.repo_dir.mkdir(parents=True, exist_ok=True)
        self._git("init")
        self._git("config", "user.email", "tests@example.local")
        self._git("config", "user.name", "Novel Agent Tests")
        (self.repo_dir / ".gitignore").write_text(".loregit/\n", encoding="utf-8")
        (self.repo_dir / "metadata.json").write_text(
            json.dumps({"book_id": "book", "book_name": "delivery book"}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (self.repo_dir / "chapter_draft.md").write_text("# 续写草稿\n\n", encoding="utf-8")
        self._git("add", "--", ".gitignore", "metadata.json", "chapter_draft.md")
        self._git("commit", "-m", "seed book")
        self.base_branch = self._git("branch", "--show-current") or "master"
        self.base_commit = self._git("rev-parse", "HEAD")
        self._git("checkout", "-b", DRAFT_BRANCH_NAME)
        self._write_draft(
            "# 续写草稿\n\n"
            "## 第1章 风起\n"
            "正文一。\n\n"
            "```markdown\n"
            "## 第99章 不应解析\n"
            "```\n\n"
            "### CH2 - 云涌\n"
            "正文二。\n"
        )
        self._git("add", "--", "chapter_draft.md")
        self._git("commit", "-m", "write draft package")
        self.draft_commit = self._git("rev-parse", "HEAD")
        write_draft_metadata(
            str(self.repo_dir),
            base_branch=self.base_branch,
            draft_branch=DRAFT_BRANCH_NAME,
            base_commit=self.base_commit,
            draft_commit=self.draft_commit,
            source="test",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo_dir,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        ).stdout.strip()

    def _write_draft(self, text: str) -> None:
        (self.repo_dir / "chapter_draft.md").write_text(text, encoding="utf-8")

    def test_parse_chapter_spans_supports_common_headings_and_skips_fences(self):
        spans = parse_chapter_spans(
            "# 草稿\n\n"
            "### 第 1 章：风起\n"
            "正文一。\n"
            "~~~\n"
            "第3章 假标题\n"
            "~~~\n"
            "Chapter 2: 云涌\n"
            "正文二。\n"
        )

        self.assertEqual([span["number"] for span in spans], [1, 2])
        self.assertEqual(spans[0]["title"], "风起")
        self.assertEqual(spans[1]["title"], "云涌")
        self.assertEqual(spans[0]["heading_line"], 3)
        self.assertEqual(spans[0]["content_start_line"], 4)
        self.assertEqual(spans[0]["end_line"], 7)
        self.assertEqual(spans[1]["review_status"], "pending")
        self.assertEqual(spans[1]["author_status"], "pending")

    def test_create_state_binds_draft_commit_and_keeps_book_repo_clean(self):
        state = create_or_refresh_prose_delivery_state(str(self.repo_dir), "book")

        self.assertEqual(state["schema_version"], 1)
        self.assertEqual(state["book_id"], "book")
        self.assertEqual(state["draft_branch"], DRAFT_BRANCH_NAME)
        self.assertEqual(state["base_branch"], self.base_branch)
        self.assertEqual(state["base_commit"], self.base_commit)
        self.assertEqual(state["draft_commit"], self.draft_commit)
        self.assertEqual(state["status"], "draft_ready")
        self.assertEqual(state["draft_package"]["file"], "chapter_draft.md")
        self.assertEqual(state["draft_package"]["chapter_count"], 2)
        self.assertEqual([span["number"] for span in state["draft_package"]["chapter_spans"]], [1, 2])
        self.assertEqual(state["review_report"]["findings"], [])
        self.assertFalse(state["review_report"]["stale"])
        self.assertTrue((self.repo_dir / PROSE_DELIVERY_STATE_REL_PATH).exists())
        self.assertEqual(self._git("status", "--short"), "")

    def test_state_staleness_reports_changed_draft_commit(self):
        state = create_or_refresh_prose_delivery_state(str(self.repo_dir), "book")
        self._write_draft((self.repo_dir / "chapter_draft.md").read_text(encoding="utf-8") + "\n补写一句。\n")
        self._git("add", "--", "chapter_draft.md")
        self._git("commit", "-m", "revise draft package")
        new_draft_commit = self._git("rev-parse", "HEAD")
        write_draft_metadata(
            str(self.repo_dir),
            base_branch=self.base_branch,
            draft_branch=DRAFT_BRANCH_NAME,
            base_commit=self.base_commit,
            draft_commit=new_draft_commit,
            source="test",
        )

        stale = state_staleness(str(self.repo_dir), state)

        self.assertTrue(stale["stale"])
        self.assertEqual(stale["reasons"], ["draft_commit"])
        self.assertEqual(stale["current"]["draft_commit"], new_draft_commit)
        self.assertEqual(self._git("status", "--short"), "")


if __name__ == "__main__":
    unittest.main()
