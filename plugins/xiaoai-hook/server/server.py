#!/usr/bin/env python3
"""Authenticated task notifications forwarded to a loopback-only Mijia service."""
from __future__ import annotations

import collections
import hmac
import json
import logging
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

log = logging.getLogger("task-notify")


class DeliveryError(Exception):
    pass


class Notifications:
    def __init__(self, config: dict):
        self.token = config["token"]
        self.speaker = config["speaker"]
        self.backend = config.get("backend", "http://127.0.0.1:9393/speak")
        self.template = config.get("template", "{source}，{task}，已完成。")
        self.transport = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.lock = threading.Condition()
        self.timestamps = collections.deque()
        self.stopped = False
        db_path = Path(config["database"])
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS notifications (
            event_id TEXT PRIMARY KEY, source TEXT NOT NULL, task TEXT NOT NULL,
            state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            next_at REAL NOT NULL, updated REAL NOT NULL)""")
        self.db.execute("UPDATE notifications SET state='queued' WHERE state='sending'")
        self.db.commit()

    def validate(self, body):
        if not isinstance(body, dict):
            raise ValueError("JSON object required")
        result = {}
        for field, maximum in (("event_id", 200), ("source", 80), ("task", 160)):
            value = body.get(field, "PiWeb" if field == "source" else "")
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                raise ValueError(f"invalid {field}")
            value = value.strip()
            if any(ord(c) < 32 for c in value):
                raise ValueError(f"invalid {field}")
            result[field] = value
        if "dry_run" in body and not isinstance(body["dry_run"], bool):
            raise ValueError("invalid dry_run")
        result["dry_run"] = body.get("dry_run", False)
        return result

    def allow_request(self):
        now = time.monotonic()
        with self.lock:
            while self.timestamps and self.timestamps[0] < now - 60:
                self.timestamps.popleft()
            if len(self.timestamps) >= 10:
                return False
            self.timestamps.append(now)
            return True

    def enqueue(self, body):
        with self.lock:
            if self.db.execute("SELECT 1 FROM notifications WHERE event_id=?", (body["event_id"],)).fetchone():
                return 200, {"status": "duplicate"}
            if not self.allow_request():
                return 429, {"error": "rate limited"}
            pending = self.db.execute("SELECT COUNT(*) FROM notifications WHERE state IN ('queued','sending')").fetchone()[0]
            if pending >= 100:
                return 503, {"error": "queue full"}
            now = time.time()
            self.db.execute("DELETE FROM notifications WHERE state IN ('sent','failed') AND updated < ?", (now - 7 * 86400,))
            self.db.execute("INSERT INTO notifications(event_id,source,task,state,next_at,updated) VALUES(?,?,?,'queued',?,?)",
                            (body["event_id"], body["source"], body["task"], now, now))
            self.db.commit()
            self.lock.notify_all()
        return 202, {"status": "queued"}

    def deliver(self, source, task, dry_run=False):
        payload = {"text": self.template.format(source=source, task=task),
                   "speaker": self.speaker, "dry_run": dry_run}
        req = urllib.request.Request(self.backend, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self.transport.open(req, timeout=20) as response:
                result = json.loads(response.read(65536))
        except (OSError, ValueError, urllib.error.URLError) as error:
            raise DeliveryError(type(error).__name__) from error
        accepted = {"dry_run"} if dry_run else {"done", "accepted"}
        if result.get("ok") is not True or result.get("status") not in accepted:
            raise DeliveryError("Mijia rejected notification")
        return result

    def work_once(self):
        with self.lock:
            row = self.db.execute("SELECT event_id,source,task,attempts FROM notifications WHERE state='queued' AND next_at<=? ORDER BY next_at LIMIT 1", (time.time(),)).fetchone()
            if row is None:
                return False
            event_id, source, task, attempts = row
            self.db.execute("UPDATE notifications SET state='sending',updated=? WHERE event_id=?", (time.time(), event_id))
            self.db.commit()
        try:
            self.deliver(source, task)
            state, next_at = "sent", time.time()
            log.info("notification delivered")
        except DeliveryError as error:
            state = "failed" if attempts >= 2 else "queued"
            next_at = time.time() + 5 * (attempts + 1)
            log.warning("notification delivery %s (%s)", state, error)
        with self.lock:
            self.db.execute("UPDATE notifications SET state=?,attempts=?,next_at=?,updated=? WHERE event_id=?",
                            (state, attempts + 1, next_at, time.time(), event_id))
            self.db.commit()
        return True

    def worker(self):
        while not self.stopped:
            if not self.work_once():
                with self.lock:
                    self.lock.wait(timeout=1)

    def close(self):
        self.stopped = True
        with self.lock:
            self.lock.notify_all()


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TaskNotify"
        sys_version = ""
        timeout = 10

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_):
            pass

        def send_json(self, code, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if code == 429:
                self.send_header("Retry-After", "60")
            self.end_headers()
            try:
                self.wfile.write(data)
            except OSError:
                pass

        def do_GET(self):
            if self.path == "/health":
                return self.send_json(200, {"ok": True})
            self.send_json(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/hooks/task-completed":
                return self.send_json(404, {"error": "not found"})
            expected = f"Bearer {service.token}".encode()
            supplied = self.headers.get("Authorization", "").encode()
            if not hmac.compare_digest(supplied, expected):
                return self.send_json(401, {"error": "unauthorized"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096 or self.headers.get("Transfer-Encoding"):
                    return self.send_json(413, {"error": "invalid body size"})
                body = service.validate(json.loads(self.rfile.read(size)))
            except (ValueError, OSError):
                return self.send_json(400, {"error": "invalid notification"})
            if body["dry_run"]:
                if not service.allow_request():
                    return self.send_json(429, {"error": "rate limited"})
                try:
                    result = service.deliver(body["source"], body["task"], True)
                    return self.send_json(200, {"ok": True, "status": "dry_run", "device": result.get("device")})
                except DeliveryError:
                    return self.send_json(502, {"error": "speaker validation failed"})
            code, response = service.enqueue(body)
            self.send_json(code, response)

    return Handler


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = os.environ.get("NOTIFY_TOKEN", "")
    speaker = os.environ.get("NOTIFY_SPEAKER", "")
    if len(token) < 32 or not speaker:
        raise SystemExit("Set NOTIFY_TOKEN (32+ characters) and NOTIFY_SPEAKER")
    service = Notifications({"token": token, "speaker": speaker,
                             "backend": os.environ.get("NOTIFY_BACKEND", "http://127.0.0.1:9393/speak"),
                             "template": os.environ.get("NOTIFY_TEXT_TEMPLATE", "{source}，{task}，已完成。"),
                             "database": os.environ.get("NOTIFY_DATABASE", "/var/lib/task-notify/notifications.sqlite3")})
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("NOTIFY_PORT", "18766"))), make_handler(service))
    threading.Thread(target=service.worker, daemon=True).start()
    log.info("task notification service ready")
    try:
        server.serve_forever()
    finally:
        service.close()
        server.server_close()


if __name__ == "__main__":
    main()
