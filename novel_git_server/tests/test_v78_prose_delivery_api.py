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

import app as gs  # noqa: E402


class V78ProseDeliveryApiTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = ROOT_DIR / ".tmp_tests"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tmp_root / f"v78_prose_delivery_api_{uuid.uuid4().hex}"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.app = gs.create_app(storage_root=str(self.temp_dir))
        self.app.testing = True
        self.client = self.app.test_client()

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _git(self, repo_dir: Path, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=repo_dir,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        ).stdout.strip()

    def _bootstrap_draft(self) -> tuple[str, Path]:
        init = self.client.post("/books/init", json={"book_name": f"v78_{uuid.uuid4().hex}"})
        self.assertEqual(init.status_code, 200)
        book_id = init.get_json()["book_id"]
        repo_dir = self.temp_dir / book_id
        draft_markdown = (
            "# 续写草稿\n\n"
            "## 第1章 风起\n"
            "正文一。\n\n"
            "## 第2章 云涌\n"
            "正文二。\n"
        )
        sync = self.client.post(
            "/api/draft/sync_all",
            json={
                "book_id": book_id,
                "active_file": "chapter_draft.md",
                "write_scope": "active_file_strict",
                "message": "write draft for prose delivery",
                "writes": [
                    {
                        "file_name": "chapter_draft.md",
                        "op": "update",
                        "content": draft_markdown,
                    }
                ],
            },
        )
        self.assertEqual(sync.status_code, 200, sync.get_json())
        self.assertEqual(sync.get_json()["prose_delivery_state"]["status"], "draft_ready")
        return book_id, repo_dir

    def test_refresh_and_state_endpoint_expose_draft_package(self):
        book_id, repo_dir = self._bootstrap_draft()

        refresh = self.client.post("/api/prose_delivery/refresh", json={"book_id": book_id})

        self.assertEqual(refresh.status_code, 200, refresh.get_json())
        body = refresh.get_json()
        state = body["state"]
        self.assertEqual(state["status"], "draft_ready")
        self.assertEqual(state["draft_package"]["chapter_count"], 2)
        self.assertEqual([span["number"] for span in state["draft_package"]["chapter_spans"]], [1, 2])
        self.assertFalse(body["staleness"]["stale"])
        self.assertIn("第1章 风起", body["draft"]["content"])
        self.assertTrue((repo_dir / ".loregit" / "prose_delivery_state.json").exists())
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

        fetched = self.client.get("/api/prose_delivery/state", query_string={"book_id": book_id})
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.get_json()["state"]["draft_commit"], state["draft_commit"])

    def test_manual_save_commits_new_draft_and_marks_review_stale(self):
        book_id, repo_dir = self._bootstrap_draft()
        state = self.client.post("/api/prose_delivery/refresh", json={"book_id": book_id}).get_json()
        original_commit = state["state"]["draft_commit"]
        etag = state["draft"]["etag"]

        save = self.client.post(
            "/api/prose_delivery/manual_save",
            json={
                "book_id": book_id,
                "base_etag": etag,
                "content": state["draft"]["content"] + "\n作者手动补了一句。\n",
            },
        )

        self.assertEqual(save.status_code, 200, save.get_json())
        saved = save.get_json()["state"]
        self.assertEqual(saved["status"], "manual_edit_saved")
        self.assertNotEqual(saved["draft_commit"], original_commit)
        self.assertTrue(saved["review_report"]["stale"])
        self.assertEqual(saved["review_report"]["stale_reason"], "manual_edit_changed_draft")
        self.assertTrue(saved["manual_edit"]["saved"])
        self.assertTrue(saved["manual_edit"]["review_required"])
        self.assertFalse(saved["archive_state"]["eligible"])
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

    def test_review_report_and_rewrite_request_are_control_state_only(self):
        book_id, repo_dir = self._bootstrap_draft()
        self.client.post("/api/prose_delivery/refresh", json={"book_id": book_id})

        review = self.client.post(
            "/api/prose_delivery/review_report",
            json={
                "book_id": book_id,
                "summary": "第2章逻辑需要回看。",
                "findings": [
                    {
                        "id": "logic-001",
                        "chapter_number": 2,
                        "severity": "blocking",
                        "message": "人物动机缺少承接。",
                        "suggestion": "补上上一章决定和本章行动之间的因果。",
                    }
                ],
            },
        )
        self.assertEqual(review.status_code, 200, review.get_json())
        state = review.get_json()["state"]
        self.assertEqual(state["review_report"]["status"], "problem")
        self.assertFalse(state["review_report"]["review_is_author_approval"])
        spans = {span["number"]: span for span in state["draft_package"]["chapter_spans"]}
        self.assertEqual(spans[1]["review_status"], "passed")
        self.assertEqual(spans[2]["review_status"], "problem")
        self.assertTrue(state["archive_state"]["eligible"])

        rewrite = self.client.post(
            "/api/prose_delivery/rewrite_request",
            json={"book_id": book_id, "finding_id": "logic-001"},
        )
        self.assertEqual(rewrite.status_code, 200, rewrite.get_json())
        request_entry = rewrite.get_json()["rewrite_request"]
        rewritten_state = rewrite.get_json()["state"]
        self.assertEqual(request_entry["route_agent_key"], "continuation_agent")
        self.assertTrue(request_entry["no_prose_written_by_backend"])
        self.assertEqual(rewritten_state["status"], "rewrite_requested")
        self.assertEqual(rewritten_state["draft_package"]["chapter_spans"][1]["author_status"], "rewrite_requested")
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

    def test_clear_removes_ignored_state(self):
        book_id, repo_dir = self._bootstrap_draft()
        self.client.post("/api/prose_delivery/refresh", json={"book_id": book_id})

        clear = self.client.post("/api/prose_delivery/clear", json={"book_id": book_id})

        self.assertEqual(clear.status_code, 200)
        self.assertFalse((repo_dir / ".loregit" / "prose_delivery_state.json").exists())
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

    def test_draft_rollback_clears_delivery_state(self):
        book_id, repo_dir = self._bootstrap_draft()
        state = self.client.get("/api/prose_delivery/state", query_string={"book_id": book_id}).get_json()["state"]
        self.assertIsNotNone(state)

        rollback = self.client.post(
            "/api/draft/rollback",
            json={"book_id": book_id, "commit_hash": state["base_commit"]},
        )

        self.assertEqual(rollback.status_code, 200, rollback.get_json())
        self.assertTrue(rollback.get_json()["prose_delivery_state_cleared"])
        self.assertFalse((repo_dir / ".loregit" / "prose_delivery_state.json").exists())
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

    def test_draft_confirm_clears_delivery_state_after_success(self):
        init = self.client.post("/books/init", json={"book_name": f"v78_confirm_{uuid.uuid4().hex}"})
        self.assertEqual(init.status_code, 200)
        book_id = init.get_json()["book_id"]
        repo_dir = self.temp_dir / book_id
        world = self.client.get(
            "/books/get_file",
            query_string={"book_id": book_id, "file_name": "world_model.md"},
        ).get_json()
        sync = self.client.post(
            "/api/draft/sync_all",
            json={
                "book_id": book_id,
                "message": "world only with stale prose state",
                "writes": [
                    {
                        "file_name": "world_model.md",
                        "op": "update",
                        "content": "# 世界模型\n\n确认清理交付状态。",
                        "base_etag": world["etag"],
                    }
                ],
            },
        )
        self.assertEqual(sync.status_code, 200, sync.get_json())
        refresh = self.client.post("/api/prose_delivery/refresh", json={"book_id": book_id})
        self.assertEqual(refresh.status_code, 200, refresh.get_json())
        self.assertTrue((repo_dir / ".loregit" / "prose_delivery_state.json").exists())

        confirm = self.client.post("/api/draft/confirm", json={"book_id": book_id})

        self.assertEqual(confirm.status_code, 200, confirm.get_json())
        self.assertTrue(confirm.get_json()["prose_delivery_state_cleared"])
        self.assertFalse((repo_dir / ".loregit" / "prose_delivery_state.json").exists())
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")


if __name__ == "__main__":
    unittest.main()
