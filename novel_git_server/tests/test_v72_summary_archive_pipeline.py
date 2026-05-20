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

from pipelines import summary_archive as pipeline  # noqa: E402


class V72SummaryArchivePipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = ROOT_DIR / ".tmp_tests"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tmp_root / f"v72_summary_archive_{uuid.uuid4().hex}"
        self.repo_dir = self.temp_dir / "book"
        (self.repo_dir / "chapters").mkdir(parents=True, exist_ok=True)
        self._git("init")
        self._git("config", "user.email", "tests@example.local")
        self._git("config", "user.name", "Novel Agent Tests")
        (self.repo_dir / "metadata.json").write_text(
            json.dumps({"book_id": "book", "book_name": "summary book"}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        self._write_chapter("0001_start.md", "# Chapter One\n\nsource text one " * 20)
        self._write_chapter("0002_turn.md", "# Chapter Two\n\nsource text two " * 20)
        self._git("add", "--", "metadata.json", "chapters")
        self._git("commit", "-m", "seed chapters")

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

    def _write_chapter(self, name: str, content: str) -> None:
        (self.repo_dir / "chapters" / name).write_text(content.rstrip() + "\n", encoding="utf-8")

    def test_pipeline_writes_summary_metadata_and_leaves_repo_clean(self):
        prompts: list[str] = []

        def fake_model(prompt: str) -> str:
            prompts.append(prompt)
            return """
## Batch Archive: CH1-2

## 批次概览
- 两个源章节已经归档，G2 与 AWP 这类专名可以保留，但说明必须是中文。

## 章节索引
- 第1章：开局
- 第2章：转折

## 不可逆事实
- 已发生事实
"""

        result = pipeline.run_pipeline(
            book_id="book",
            book_dir=self.repo_dir,
            book_name="summary book",
            invoke_model=fake_model,
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["chapter_count"], 2)
        self.assertEqual(result["total_batches"], 1)
        self.assertEqual(len(prompts), 1)
        self.assertIn("所有标题、解释、总结、项目符号都必须使用简体中文", prompts[0])
        self.assertIn("专有名词可以保留原文", prompts[0])
        self.assertNotIn("Write in the same language", prompts[0])
        summary = (self.repo_dir / "summary.md").read_text(encoding="utf-8")
        self.assertIn(pipeline.ARCHIVE_MARKER, summary)
        self.assertIn("# 全书阅读档案索引", summary)
        self.assertIn("## 批次归档：第1-2章", summary)
        self.assertIn("### 章节索引摘录", summary)
        for stale_heading in [
            "Full Book Archive Index",
            "Batch Archive",
            "Batch Overview",
            "Batch Index",
            "Irreversible Facts",
            "Batch Archives",
        ]:
            self.assertNotIn(stale_heading, summary)
        metadata = json.loads((self.repo_dir / "metadata.json").read_text(encoding="utf-8"))
        self.assertTrue(metadata["summary_complete"])
        self.assertEqual(metadata["total_chapters"], 2)
        self.assertEqual(metadata["processed_batches"], 1)
        self.assertEqual(self._git("status", "--short"), "")
        changed = set(self._git("show", "--name-only", "--format=", "HEAD").splitlines())
        self.assertEqual(changed, {"summary.md", "metadata.json"})

    def test_pipeline_batches_by_byte_limit_and_reports_progress(self):
        events: list[dict] = []

        def fake_model(prompt: str) -> str:
            if "第1-1章" in prompt:
                return "## 批次归档：第1-1章\n\n## 批次概览\n- 第一批\n\n## 章节索引\n- 第1章\n"
            return "## 批次归档：第2-2章\n\n## 批次概览\n- 第二批\n\n## 章节索引\n- 第2章\n"

        result = pipeline.run_pipeline(
            book_id="book",
            book_dir=self.repo_dir,
            book_name="summary book",
            max_batch_bytes=80,
            invoke_model=fake_model,
            progress_callback=events.append,
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["total_batches"], 2)
        statuses = [event["status"] for event in events]
        self.assertIn("reading", statuses)
        self.assertIn("generating", statuses)
        self.assertIn("writing", statuses)
        self.assertIn("done", statuses)

    def test_pipeline_returns_no_chapters_without_model_call(self):
        empty_dir = self.temp_dir / "empty"
        empty_dir.mkdir()

        def fail_model(_prompt: str) -> str:
            raise AssertionError("model should not be called")

        result = pipeline.run_pipeline(book_id="empty", book_dir=empty_dir, invoke_model=fail_model)

        self.assertEqual(result["status"], "no_chapters")


if __name__ == "__main__":
    unittest.main()
