import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("task_notify", Path(__file__).parents[1] / "server.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = {"token": "test-token-" * 5, "speaker": "fixed-test-speaker",
                       "database": str(Path(self.temp.name) / "queue.sqlite3")}
        self.service = module.Notifications(self.config)
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), module.make_handler(self.service))
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.service.db.close()
        self.temp.cleanup()

    def request(self, body=None, token=None, path="/hooks/task-completed", raw=None):
        data = raw if raw is not None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.http.server_port}{path}", data=data,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {token or self.config['token']}"})
        try:
            response = self.client.open(req, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def event(self, **extra):
        return {"source": "PiWeb", "task": "test task", "event_id": "test-event", **extra}

    def test_unauthorized_request_never_reaches_queue(self):
        self.assertEqual(self.request(self.event(), token="incorrect")[0], 401)
        self.assertEqual(self.service.db.execute("SELECT COUNT(*) FROM notifications").fetchone()[0], 0)

    def test_queue_is_persistent_and_duplicate_event_is_not_replayed(self):
        self.assertEqual(self.request(self.event()), (202, {"status": "queued"}))
        with patch.object(self.service, "deliver", return_value={"ok": True}) as deliver:
            self.assertTrue(self.service.work_once())
            deliver.assert_called_once_with("PiWeb", "test task")
        other = module.Notifications(self.config)
        try:
            self.assertEqual(other.enqueue(self.event()), (200, {"status": "duplicate"}))
            self.assertFalse(other.work_once())
        finally:
            other.db.close()

    def test_interrupted_queue_item_is_recovered(self):
        self.service.enqueue(self.event())
        self.service.db.execute("UPDATE notifications SET state='sending'")
        self.service.db.commit()
        other = module.Notifications(self.config)
        try:
            self.assertEqual(other.db.execute("SELECT state FROM notifications").fetchone()[0], "queued")
        finally:
            other.db.close()

    def test_delivery_uses_fixed_speaker_and_dry_run(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return b'{"ok":true,"status":"dry_run"}'
        with patch.object(self.service.transport, "open", return_value=Response()) as send:
            self.service.deliver("PiWeb", "example", True)
            body = json.loads(send.call_args.args[0].data)
            self.assertEqual(body["speaker"], "fixed-test-speaker")
            self.assertTrue(body["dry_run"])

    def test_dry_run_does_not_enqueue_or_allow_speaker_override(self):
        with patch.object(self.service, "deliver", return_value={"device": "fixed-test-speaker"}) as deliver:
            code, body = self.request(self.event(dry_run=True, speaker="untrusted-target"))
            self.assertEqual(code, 200)
            self.assertEqual(body["device"], "fixed-test-speaker")
            deliver.assert_called_once_with("PiWeb", "test task", True)
        self.assertEqual(self.service.db.execute("SELECT COUNT(*) FROM notifications").fetchone()[0], 0)

    def test_rejects_malformed_and_oversize_input(self):
        for body in ([], self.event(task=""), self.event(task="x" * 161), self.event(task="a\nb")):
            self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(self.request(raw=b"{" + b"x" * 4096)[0], 413)
        self.assertEqual(self.request(raw=b"not-json")[0], 400)
        self.assertEqual(self.request(self.event(), path="/speak")[0], 404)

    def test_rate_limit_does_not_block_retry_of_existing_event(self):
        for i in range(10):
            self.assertEqual(self.request(self.event(event_id=str(i)))[0], 202)
        self.assertEqual(self.request(self.event(event_id="extra"))[0], 429)
        self.assertEqual(self.request(self.event(event_id="0")), (200, {"status": "duplicate"}))

    def test_failed_delivery_is_retried_and_then_stops(self):
        self.service.enqueue(self.event())
        with patch.object(self.service, "deliver", side_effect=module.DeliveryError("offline")):
            for i in range(3):
                self.assertTrue(self.service.work_once())
                self.service.db.execute("UPDATE notifications SET next_at=0")
                self.service.db.commit()
        self.assertEqual(self.service.db.execute("SELECT state,attempts FROM notifications").fetchone(), ("failed", 3))
        self.assertFalse(self.service.work_once())


if __name__ == "__main__":
    unittest.main()
