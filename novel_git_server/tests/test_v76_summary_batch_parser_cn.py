import shutil
import sys
import unittest
import uuid
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from pipelines.batch_parser import parse_summary_batches  # noqa: E402


class V76SummaryBatchParserCnTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = ROOT_DIR / ".tmp_tests"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tmp_root / f"v76_summary_batch_parser_{uuid.uuid4().hex}"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.summary_path = self.temp_dir / "summary.md"

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_parse_chinese_batch_headings_as_canonical_titles(self):
        self.summary_path.write_text(
            """# 全书阅读档案索引

---

# 批次归档正文

## 批次归档：第1-3章

## 批次概览
- 第一批。

## 批次归档：第4-6章

## 批次概览
- 第二批。
""",
            encoding="utf-8",
        )

        batches = parse_summary_batches(self.summary_path)

        self.assertEqual(len(batches), 2)
        self.assertEqual(batches[0]["title"], "批次归档：第1-3章")
        self.assertEqual(batches[0]["chapter_start"], 1)
        self.assertEqual(batches[0]["chapter_end"], 3)
        self.assertIn("第一批", batches[0]["text"])
        self.assertEqual(batches[1]["title"], "批次归档：第4-6章")

    def test_parse_legacy_english_batch_headings_without_breaking_old_books(self):
        self.summary_path.write_text(
            """# Full Book Archive Index

# Batch Archives

## Batch Archive: CH7-CH9

## Batch Overview
- legacy batch.
""",
            encoding="utf-8",
        )

        batches = parse_summary_batches(self.summary_path)

        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["title"], "批次归档：第7-9章")
        self.assertEqual(batches[0]["chapter_start"], 7)
        self.assertEqual(batches[0]["chapter_end"], 9)
        self.assertIn("legacy batch", batches[0]["text"])


if __name__ == "__main__":
    unittest.main()
