import json
import os
import shutil
import sys
import unittest
import uuid
import importlib.util
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = ROOT_DIR.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import app as gs  # noqa: E402
from utils.book_storage import ensure_book_layout  # noqa: E402


class V79PublicDemoModeTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = ROOT_DIR / ".tmp_tests"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tmp_root / f"v79_public_demo_{uuid.uuid4().hex}"
        self.storage_root = self.temp_dir / "storage"
        self.template_id = "template_book"
        ensure_book_layout(self.template_id, str(self.storage_root), book_name="演示模板书")
        chapter_dir = self.storage_root / self.template_id / "chapters"
        chapter_dir.mkdir(parents=True, exist_ok=True)
        (chapter_dir / "0001_start.md").write_text("# 第一章\n\n模板正文\n", encoding="utf-8")

        self.env_patch = patch.dict(
            os.environ,
            {
                "PUBLIC_DEMO_MODE": "1",
                "PUBLIC_DEMO_TEMPLATE_BOOK_ID": self.template_id,
                "PUBLIC_DEMO_SESSION_TTL_SECONDS": "600",
                "PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT": "25",
                "PUBLIC_DEMO_WORLD_INIT_LIMIT": "1",
            },
        )
        self.env_patch.start()
        self.app = gs.create_app(storage_root=str(self.storage_root))
        self.app.testing = True
        self.client = self.app.test_client()

    def tearDown(self) -> None:
        self.env_patch.stop()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_storage_root_env_is_honored_without_explicit_argument(self):
        self.env_patch.stop()
        self.env_patch = patch.dict(
            os.environ,
            {
                "STORAGE_ROOT": str(self.storage_root),
                "PUBLIC_DEMO_MODE": "1",
                "PUBLIC_DEMO_TEMPLATE_BOOK_ID": self.template_id,
                "PUBLIC_DEMO_SESSION_TTL_SECONDS": "600",
                "PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT": "25",
                "PUBLIC_DEMO_WORLD_INIT_LIMIT": "1",
            },
        )
        self.env_patch.start()

        env_app = gs.create_app()
        self.assertEqual(Path(env_app.config["STORAGE_ROOT"]), self.storage_root.resolve())
        env_app.testing = True
        resp = env_app.test_client().get("/api/demo/session")
        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(resp.get_json()["template_book_id"])

    def test_static_proxy_does_not_treat_bookshelf_as_books_api(self):
        proxy_path = PROJECT_ROOT / "deploy" / "public_demo" / "static_proxy.py"
        spec = importlib.util.spec_from_file_location("public_demo_static_proxy", proxy_path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertFalse(module.should_proxy_path("/bookshelf.html"))
        self.assertTrue(module.should_proxy_path("/books"))
        self.assertTrue(module.should_proxy_path("/books/list"))

    def test_bookshelf_gets_session_scoped_template_copy(self):
        resp = self.client.get("/books/list")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["total"], 1)
        demo_book_id = body["books"][0]["book_id"]
        self.assertTrue(demo_book_id.startswith("demo_"))
        self.assertTrue(demo_book_id.endswith(f"_{self.template_id}"))
        self.assertTrue((self.storage_root / demo_book_id / "chapters" / "0001_start.md").exists())

        second_client = self.app.test_client()
        second = second_client.get("/books/list")
        second_book_id = second.get_json()["books"][0]["book_id"]
        self.assertNotEqual(second_book_id, demo_book_id)

    def test_config_save_and_manual_init_are_forbidden(self):
        config_resp = self.client.post("/api/runtime/config", json={"values": {"DIFY_BASE_URL": "http://example/v1"}})
        self.assertEqual(config_resp.status_code, 403)
        self.assertEqual(config_resp.get_json()["code"], "PUBLIC_DEMO_CONFIG_READONLY")

        init_resp = self.client.post("/books/init", json={"book_id": "new_book", "book_name": "new book"})
        self.assertEqual(init_resp.status_code, 403)
        self.assertEqual(init_resp.get_json()["code"], "PUBLIC_DEMO_IMPORT_ONLY")

    def test_online_import_maps_to_session_book_and_limits_to_25_chapters(self):
        payload = {
            "book_name": "在线导入书",
            "author": "作者",
            "chapter_count": 30,
            "quality": {"can_confirm": True, "risk_level": "ok", "issues": []},
            "chapters": [
                {"target_file": f"{idx:04d}_chapter.md", "markdown": f"# 第{idx}章\n\n正文"}
                for idx in range(1, 31)
            ],
        }
        with (
            patch("agents.tomato_import._download_online_book", return_value=payload),
            patch("agents.tomato_import._trigger_summary_generation"),
        ):
            resp = self.client.post("/books/tomato/online_import", json={"book_id": "source_30", "overwrite": True})

        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertTrue(body["book_id"].startswith("demo_"))
        self.assertEqual(body["saved_count"], 25)
        self.assertEqual(body["public_demo_limit"]["original_chapter_count"], 30)
        chapters = sorted((self.storage_root / body["book_id"] / "chapters").glob("*.md"))
        self.assertEqual(len(chapters), 25)

    def test_world_init_only_once_per_session(self):
        list_resp = self.client.get("/books/list")
        demo_book_id = list_resp.get_json()["books"][0]["book_id"]
        summary_path = self.storage_root / demo_book_id / "summary.md"
        summary_path.write_text("# 阅读档案\n\n## Batch Archive: CH1-CH1\n\n- 测试\n", encoding="utf-8")

        def fake_parse_summary_batches(_summary_path):
            return [{"batch_id": "b1"}]

        def fake_run_pipeline(**kwargs):
            kwargs["sse_queue"].put({"event": "done", "data": {"status": "success"}})

        with (
            patch("pipelines.batch_parser.parse_summary_batches", side_effect=fake_parse_summary_batches),
            patch("pipelines.world_model_init.run_pipeline", side_effect=fake_run_pipeline),
        ):
            first = self.client.post("/api/world/init_batch_pipeline", json={"book_id": demo_book_id})
            self.assertEqual(first.status_code, 200)
            first_text = first.data.decode("utf-8")
            self.assertIn("event: ack", first_text)

        second = self.client.post("/api/world/init_batch_pipeline", json={"book_id": demo_book_id})
        self.assertEqual(second.status_code, 200)
        second_text = second.data.decode("utf-8")
        self.assertIn("PUBLIC_DEMO_WORLD_INIT_LIMIT", second_text)


if __name__ == "__main__":
    unittest.main()
