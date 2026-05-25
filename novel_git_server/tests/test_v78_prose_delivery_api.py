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
        self.assertFalse(state["archive_state"]["eligible"])
        self.assertEqual(state["archive_state"]["blocked_reason"], "review_findings_require_rewrite_or_author_approval")

        rewrite = self.client.post(
            "/api/prose_delivery/rewrite_request",
            json={"book_id": book_id, "finding_id": "logic-001"},
        )
        self.assertEqual(rewrite.status_code, 200, rewrite.get_json())
        request_entry = rewrite.get_json()["rewrite_request"]
        rewritten_state = rewrite.get_json()["state"]
        self.assertEqual(request_entry["route_agent_key"], "continuation_agent")
        self.assertTrue(request_entry["no_prose_written_by_backend"])
        self.assertEqual(request_entry["handoff_context"]["previous_draft_file"], "chapter_draft.md")
        self.assertIn("error_archive.md", request_entry["handoff_context"]["must_read_files"])
        self.assertEqual(request_entry["handoff_context"]["review_finding"]["id"], "logic-001")
        self.assertIn("人物动机", request_entry["handoff_context"]["review_finding"]["message"])
        self.assertEqual(rewritten_state["status"], "rewrite_requested")
        self.assertEqual(rewritten_state["draft_package"]["chapter_spans"][1]["author_status"], "rewrite_requested")
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

    def test_rewrite_request_is_marked_completed_when_new_draft_arrives(self):
        book_id, repo_dir = self._bootstrap_draft()
        self.client.post("/api/prose_delivery/refresh", json={"book_id": book_id})
        review = self.client.post(
            "/api/prose_delivery/review_report",
            json={
                "book_id": book_id,
                "summary": "第2章需要补因果。",
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
        rewrite = self.client.post(
            "/api/prose_delivery/rewrite_request",
            json={"book_id": book_id, "finding_id": "logic-001"},
        )
        self.assertEqual(rewrite.status_code, 200, rewrite.get_json())
        prior_commit = rewrite.get_json()["state"]["draft_commit"]

        rewritten_draft = (
            "# 续写草稿\n\n"
            "## 第1章 风起\n"
            "正文一。\n\n"
            "## 第2章 云涌\n"
            "正文二，补上上一章决定和本章行动之间的因果。\n"
        )
        sync = self.client.post(
            "/api/draft/sync_all",
            json={
                "book_id": book_id,
                "active_file": "chapter_draft.md",
                "write_scope": "active_file_strict",
                "message": "rewrite draft after review",
                "writes": [
                    {
                        "file_name": "chapter_draft.md",
                        "op": "update",
                        "content": rewritten_draft,
                    }
                ],
            },
        )
        self.assertEqual(sync.status_code, 200, sync.get_json())
        next_state = sync.get_json()["prose_delivery_state"]
        self.assertEqual(next_state["status"], "draft_ready")
        self.assertNotEqual(next_state["draft_commit"], prior_commit)
        self.assertEqual(next_state["rewrite_requests"][-1]["status"], "completed")
        self.assertEqual(next_state["rewrite_requests"][-1]["prior_draft_commit"], prior_commit)
        self.assertEqual(next_state["rewrite_requests"][-1]["completed_draft_commit"], next_state["draft_commit"])
        spans = {span["number"]: span for span in next_state["draft_package"]["chapter_spans"]}
        self.assertEqual(spans[2]["author_status"], "rewrite_completed")
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

    def test_review_report_rebuilds_missing_delivery_state(self):
        book_id, repo_dir = self._bootstrap_draft()
        clear = self.client.post("/api/prose_delivery/clear", json={"book_id": book_id})
        self.assertEqual(clear.status_code, 200, clear.get_json())

        review = self.client.post(
            "/api/prose_delivery/review_report",
            json={
                "book_id": book_id,
                "summary": "状态文件缺失时仍然可以记录审核问题。",
                "findings": [
                    {
                        "id": "logic-001",
                        "chapter_number": 2,
                        "severity": "blocking",
                        "message": "人物动机缺少承接。",
                        "suggestion": "补足因果链。",
                    }
                ],
            },
        )

        self.assertEqual(review.status_code, 200, review.get_json())
        state = review.get_json()["state"]
        self.assertEqual(state["review_report"]["status"], "problem")
        self.assertEqual(state["draft_package"]["chapter_count"], 2)
        self.assertTrue((repo_dir / ".loregit" / "prose_delivery_state.json").exists())

        rewrite = self.client.post(
            "/api/prose_delivery/rewrite_request",
            json={"book_id": book_id, "finding_id": "logic-001"},
        )
        self.assertEqual(rewrite.status_code, 200, rewrite.get_json())
        self.assertEqual(rewrite.get_json()["state"]["status"], "rewrite_requested")
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

    def test_review_error_archive_append_commits_as_control_file_without_staling_delivery_state(self):
        book_id, repo_dir = self._bootstrap_draft()
        state_before = self.client.get("/api/prose_delivery/state", query_string={"book_id": book_id}).get_json()["state"]
        base_branch = state_before["base_branch"]
        old_base_commit = state_before["base_commit"]
        old_draft_commit = state_before["draft_commit"]
        archive = self.client.get(
            "/books/get_markdown_outline",
            query_string={"book_id": book_id, "file_name": "error_archive.md"},
        )
        self.assertEqual(archive.status_code, 200, archive.get_json())

        append = self.client.post(
            "/api/draft/append_markdown_section",
            json={
                "book_id": book_id,
                "file_name": "error_archive.md",
                "section_path": ["错误档案"],
                "content": "\n### 未标定日期 / 审核 / chapter_draft.md\n\n- 来源：REVIEW_AGENT\n- 约束：测试约束。\n",
                "base_etag": archive.get_json()["etag"],
                "origin": "explicit_user_write",
                "message": "review archive direct commit",
            },
        )

        self.assertEqual(append.status_code, 200, append.get_json())
        body = append.get_json()
        self.assertTrue(body["direct_commit"])
        self.assertFalse(body["review_required"])
        self.assertEqual(body["branch"], base_branch)
        self.assertTrue(body.get("draft_branch_synced"))
        self.assertIn("测试约束", self._git(repo_dir, "show", f"{base_branch}:error_archive.md"))
        self.assertIn("测试约束", self._git(repo_dir, "show", "draft/sandbox:error_archive.md"))
        self.assertNotEqual(self._git(repo_dir, "rev-parse", base_branch), old_base_commit)
        self.assertNotEqual(self._git(repo_dir, "rev-parse", "draft/sandbox"), old_draft_commit)
        self.assertEqual(self._git(repo_dir, "diff", "--name-only", base_branch, "draft/sandbox"), "chapter_draft.md")

        refreshed_state = self.client.get("/api/prose_delivery/state", query_string={"book_id": book_id}).get_json()
        self.assertFalse(refreshed_state["staleness"]["stale"], refreshed_state)
        self.assertEqual(self._git(repo_dir, "status", "--short"), "")

    def test_confirm_blocks_chapter_draft_until_prose_review_passes(self):
        book_id, repo_dir = self._bootstrap_draft()

        unreviewed = self.client.post("/api/draft/confirm", json={"book_id": book_id})
        self.assertEqual(unreviewed.status_code, 409, unreviewed.get_json())
        self.assertEqual(unreviewed.get_json()["code"], "PROSE_DELIVERY_REVIEW_NOT_PASSED")

        review = self.client.post(
            "/api/prose_delivery/review_report",
            json={
                "book_id": book_id,
                "summary": "有真实问题，需要先打回。",
                "findings": [
                    {
                        "id": "logic-001",
                        "chapter_number": 2,
                        "severity": "blocking",
                        "message": "人物动机缺少承接。",
                        "suggestion": "补足因果链。",
                    }
                ],
            },
        )
        self.assertEqual(review.status_code, 200, review.get_json())

        problem = self.client.post("/api/draft/confirm", json={"book_id": book_id})
        self.assertEqual(problem.status_code, 409, problem.get_json())
        self.assertEqual(problem.get_json()["code"], "PROSE_DELIVERY_REVIEW_NOT_PASSED")
        self.assertFalse(problem.get_json()["archive_eligible"])

        passed = self.client.post(
            "/api/prose_delivery/review_report",
            json={"book_id": book_id, "summary": "作者确认本轮可归档。", "findings": []},
        )
        self.assertEqual(passed.status_code, 200, passed.get_json())
        self.assertTrue(passed.get_json()["state"]["archive_state"]["eligible"])

        confirm = self.client.post("/api/draft/confirm", json={"book_id": book_id})
        self.assertEqual(confirm.status_code, 200, confirm.get_json())
        self.assertTrue(confirm.get_json()["prose_delivery_state_cleared"])
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
