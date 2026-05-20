import json
import shutil
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from pipelines import summary_archive as pipeline  # noqa: E402


def _batch_payload(*, start: int, end: int, chapters: list[int]) -> str:
    return json.dumps(
        {
            "批次概览": [f"第{start}-{end}章推进了本批主线。"],
            "章节索引": [
                {"章号": chapter, "标题": f"第{chapter}章", "简述": f"第{chapter}章的关键剧情被归档。"}
                for chapter in chapters
            ],
            "不可逆事实": [f"第{start}-{end}章已经形成不可逆事实。"],
            "未闭合线索与承诺": [f"第{start}-{end}章留下后续承诺。"],
            "关系与状态变化": [f"第{start}-{end}章更新关系状态。"],
            "下游创作约束": [f"第{start}-{end}章约束后续续写。"],
        },
        ensure_ascii=False,
    )


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
        self._write_chapter("0001_start.md", "# 第一章\n\nsource text one " * 20)
        self._write_chapter("0002_turn.md", "# 第二章\n\nsource text two " * 20)
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
            return _batch_payload(start=1, end=2, chapters=[1, 2])

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
        self.assertIn("只返回一个 JSON 对象", prompts[0])
        self.assertIn("章节索引", prompts[0])
        self.assertIn("所有解释、总结、项目内容都必须使用简体中文", prompts[0])
        self.assertNotIn("Write in the same language", prompts[0])
        summary = (self.repo_dir / "summary.md").read_text(encoding="utf-8")
        self.assertIn(pipeline.ARCHIVE_MARKER, summary)
        self.assertIn("# 全书阅读档案索引", summary)
        self.assertIn("- 生成方式：并发结构化抽取，后端确定性渲染", summary)
        self.assertIn("## 批次归档：第1-2章", summary)
        self.assertIn("## 章节索引", summary)
        self.assertIn("- 第1章《第一章》：第1章的关键剧情被归档。", summary)
        self.assertIn("- 第2章《第二章》：第2章的关键剧情被归档。", summary)
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

    def test_pipeline_batches_in_parallel_but_renders_in_chapter_order(self):
        for number in range(3, 7):
            self._write_chapter(f"{number:04d}_chapter.md", f"# 第{number}章\n\n正文 {number} " * 20)
        self._git("add", "--", "chapters")
        self._git("commit", "-m", "add more chapters")

        def fake_model(prompt: str) -> str:
            if "第1-2章" in prompt:
                time.sleep(0.05)
                return _batch_payload(start=1, end=2, chapters=[1, 2])
            if "第3-4章" in prompt:
                time.sleep(0.01)
                return _batch_payload(start=3, end=4, chapters=[3, 4])
            return _batch_payload(start=5, end=6, chapters=[5, 6])

        result = pipeline.run_pipeline(
            book_id="book",
            book_dir=self.repo_dir,
            book_name="summary book",
            max_batch_chapters=2,
            max_workers=3,
            invoke_model=fake_model,
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["total_batches"], 3)
        summary = (self.repo_dir / "summary.md").read_text(encoding="utf-8")
        self.assertLess(summary.index("## 批次归档：第1-2章"), summary.index("## 批次归档：第3-4章"))
        self.assertLess(summary.index("## 批次归档：第3-4章"), summary.index("## 批次归档：第5-6章"))

    def test_pipeline_rejects_missing_chapter_coverage_without_writing_summary(self):
        before_head = self._git("rev-parse", "HEAD")

        def fake_model(_prompt: str) -> str:
            return _batch_payload(start=1, end=2, chapters=[1])

        with self.assertRaisesRegex(RuntimeError, "未覆盖"):
            pipeline.run_pipeline(
                book_id="book",
                book_dir=self.repo_dir,
                book_name="summary book",
                invoke_model=fake_model,
                max_retries=0,
            )

        self.assertFalse((self.repo_dir / "summary.md").exists())
        self.assertEqual(self._git("rev-parse", "HEAD"), before_head)
        self.assertEqual(self._git("status", "--short"), "")

    def test_pipeline_rejects_conversational_preamble_without_writing_summary(self):
        before_head = self._git("rev-parse", "HEAD")

        def fake_model(_prompt: str) -> str:
            payload = json.loads(_batch_payload(start=1, end=2, chapters=[1, 2]))
            payload["批次概览"] = ["好的，已经按照您的要求生成摘要。"]
            return json.dumps(payload, ensure_ascii=False)

        with self.assertRaisesRegex(RuntimeError, "缺少有效字段：批次概览"):
            pipeline.run_pipeline(
                book_id="book",
                book_dir=self.repo_dir,
                book_name="summary book",
                invoke_model=fake_model,
                max_retries=0,
            )

        self.assertFalse((self.repo_dir / "summary.md").exists())
        self.assertEqual(self._git("rev-parse", "HEAD"), before_head)
        self.assertEqual(self._git("status", "--short"), "")

    def test_pipeline_batches_by_byte_limit_and_reports_progress(self):
        events: list[dict] = []

        def fake_model(prompt: str) -> str:
            if "第1-1章" in prompt:
                return _batch_payload(start=1, end=1, chapters=[1])
            return _batch_payload(start=2, end=2, chapters=[2])

        result = pipeline.run_pipeline(
            book_id="book",
            book_dir=self.repo_dir,
            book_name="summary book",
            max_batch_bytes=80,
            max_workers=2,
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
        done_generating = [event for event in events if event["status"] == "generating" and event.get("batch") == 2]
        self.assertTrue(done_generating)

    def test_pipeline_returns_no_chapters_without_model_call(self):
        empty_dir = self.temp_dir / "empty"
        empty_dir.mkdir()

        def fail_model(_prompt: str) -> str:
            raise AssertionError("model should not be called")

        result = pipeline.run_pipeline(book_id="empty", book_dir=empty_dir, invoke_model=fail_model)

        self.assertEqual(result["status"], "no_chapters")


if __name__ == "__main__":
    unittest.main()
