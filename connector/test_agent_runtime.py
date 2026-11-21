import os
import tempfile
import threading
import time
import unittest
from unittest import mock

import sys
sys.path.insert(0, os.path.dirname(__file__))
import agent  # noqa: E402


class ChannelWriteNonBlocking(unittest.TestCase):
    # #545: a stuck terminal or slow VNC startup must not block Connection.run.
    def test_shell_write_does_not_block_in_raw_mode(self):
        sent = []
        conn = mock.Mock()
        conn.send = sent.append
        conn.ws = mock.Mock()
        conn.ws.send_binary = lambda *a, **k: None
        sh = agent.Shell(conn, 1, 80, 24)
        try:
            sh.write(b"stty raw -echo; sleep 2\n")
            time.sleep(0.25)
            done = threading.Event()
            err = []

            def writer():
                try:
                    sh.write(b"x" * (1 << 20))
                except BaseException as e:  # noqa: BLE001
                    err.append(e)
                finally:
                    done.set()

            t = threading.Thread(target=writer, daemon=True)
            t0 = time.monotonic()
            t.start()
            finished = done.wait(timeout=0.5)
            dt = time.monotonic() - t0
            self.assertTrue(finished, f"Shell.write blocked for >{dt:.2f}s")
            self.assertEqual(err, [])
        finally:
            sh.close()
            time.sleep(0.1)

    def test_shell_write_overflow_closes_channel(self):
        sent = []
        conn = mock.Mock()
        conn.send = sent.append
        conn.ws = mock.Mock()
        conn.ws.send_binary = lambda *a, **k: None
        sh = agent.Shell(conn, 3, 80, 24)
        try:
            sh.write(b"stty raw -echo; sleep 2\n")
            time.sleep(0.25)
            with mock.patch.object(agent, "CHANNEL_INPUT_LIMIT", 1024):
                t0 = time.monotonic()
                sh.write(b"x" * 2048)
                dt = time.monotonic() - t0
            self.assertLess(dt, 0.5)
            self.assertTrue(any(m.get("op") == "closed" and m.get("ch") == 3 and m.get("code") == 1011 for m in sent), sent)
        finally:
            sh.close()
            time.sleep(0.1)

    def test_shell_echoes_input_and_closes(self):
        out = bytearray()
        conn = mock.Mock()
        conn.send = lambda *a, **k: None
        conn.ws = mock.Mock()
        conn.ws.send_binary = lambda b: out.extend(b[4:])
        sh = agent.Shell(conn, 5, 80, 24)
        try:
            sh.write(b"echo hello-545\n")
            deadline = time.monotonic() + 3
            while b"hello-545" not in out and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertIn(b"hello-545", out)
        finally:
            sh.close()
            time.sleep(0.1)

    def test_screen_open_and_close_while_opening_do_not_block(self):
        conn = agent.Connection({"abilities": {"desktop": True}})
        conn.send = lambda *a, **k: None
        started = threading.Event()
        release = threading.Event()
        fake_screen = mock.Mock()

        def slow_screen(c, ch):
            started.set()
            release.wait(2)
            return fake_screen

        try:
            with mock.patch.object(agent, "Screen", side_effect=slow_screen):
                t0 = time.monotonic()
                conn.handle({"op": "open", "ch": 7, "kind": "vnc"})
                dt = time.monotonic() - t0
                self.assertLess(dt, 0.2)
                self.assertTrue(started.wait(1))
                conn.handle({"op": "close", "ch": 7})
                release.set()
                deadline = time.monotonic() + 1
                while not fake_screen.close.called and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(fake_screen.close.called)
                self.assertNotIn(7, conn.channels)
        finally:
            release.set()


class HungNetworkShare(unittest.TestCase):
    # #546: one hung network mount must not stall disks() or the rest of Sampler.
    def test_disks_skips_hung_mount_and_does_not_pile_up(self):
        mounts = "srv:/export /mnt/nas nfs4 rw 0 0\n/dev/sda1 / ext4 rw 0 0\n"
        release = threading.Event()
        nas_calls = {"n": 0}
        ok_st = mock.Mock(f_blocks=100, f_frsize=4096, f_bfree=40)

        def fake_statvfs(path):
            if path == "/mnt/nas":
                nas_calls["n"] += 1
                release.wait(5)
                raise OSError("timed out")
            return ok_st

        try:
            with mock.patch.object(agent, "read", lambda p, *a: mounts if p == "/proc/mounts" else ""), mock.patch("os.statvfs", side_effect=fake_statvfs):
                t0 = time.monotonic()
                got = agent.disks(stat_timeout=0.15)
                dt = time.monotonic() - t0
                self.assertLess(dt, 1.0)
                self.assertEqual(got, [{"mount": "/", "total": 409600, "used": 245760}])
                got2 = agent.disks(stat_timeout=0.15)
                self.assertEqual(got2, [{"mount": "/", "total": 409600, "used": 245760}])
                self.assertEqual(nas_calls["n"], 1)
        finally:
            release.set()
            time.sleep(0.05)

    def test_sampler_keeps_updating_when_disk_hangs(self):
        release = threading.Event()
        clock = {"n": 100.0}
        counts = {"mem": 0, "up": 0}

        def mem():
            counts["mem"] += 1
            return {"total": 1000, "used": counts["mem"] * 10}, {"total": 0, "used": 0}

        def up():
            counts["up"] += 1
            return counts["up"] * 10.0

        def hung_disk():
            release.wait(5)
            return []

        s = agent.create_sampler(
            now=lambda: clock["n"],
            intervals={**agent.DEFAULT_INTERVALS, "memory": 1, "uptime": 1, "disk": 1},
            read={"cpu": lambda: 5.0, "memory": mem, "uptime": up, "disk": hung_disk},
            spawn=lambda target: object(),
        )
        try:
            t0 = time.monotonic()
            snap = s.get()
            self.assertLess(time.monotonic() - t0, 1.0)
            self.assertEqual(snap["mem"]["used"], 10)
            self.assertEqual(snap["uptime"], 10.0)
            clock["n"] += 1.0
            self.assertTrue(s.service())
            self.assertEqual(s.peek()["mem"]["used"], 20)
            self.assertEqual(s.peek()["uptime"], 20.0)
        finally:
            release.set()
            s.stop()
            time.sleep(0.05)


class ReportHelloInterval(unittest.TestCase):
    # #432: refresh hello once every 5 minutes, not 3-4 times per 10s window.
    def test_hello_sent_once_per_300_seconds(self):
        conn = agent.Connection({"abilities": {}})
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        last_hello = 0.0
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}):
            for step in range(1, 3001):
                t = float(step * 3)
                last_hello = conn._report_step(sampler, last_hello, t)
        hellos = [m for m in sent if m.get("op") == "hello"]
        self.assertEqual(len(hellos), 30)

    def test_no_burst_after_300_second_mark(self):
        conn = agent.Connection({"abilities": {}})
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        last_hello = 0.0
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}):
            for t in (297.0, 300.0, 303.0, 306.0, 309.0):
                last_hello = conn._report_step(sampler, last_hello, t)
        self.assertEqual(len([m for m in sent if m.get("op") == "hello"]), 1)
        self.assertEqual(last_hello, 300.0)


class NonUtf8Read(unittest.TestCase):
    # #543: one non-UTF-8 byte in /proc/mounts must not empty the whole Disks list.
    def test_read_and_disks_survive_non_utf8_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            mounts = os.path.join(d, "mounts")
            with open(mounts, "wb") as f:
                f.write(b"/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /mnt/caf\xe9 ext4 rw 0 0\n")
            text = agent.read(mounts)
            self.assertIn("/mnt/caf\ufffd", text)
            orig_read = agent.read
            st = mock.Mock(f_blocks=100, f_frsize=4096, f_bfree=50)
            with mock.patch.object(agent, "read", lambda p, default="": orig_read(mounts, default) if p == "/proc/mounts" else ""), mock.patch("os.statvfs", lambda p: st):
                got = [x["mount"] for x in agent.disks()]
            self.assertEqual(got, ["/", "/mnt/caf\ufffd"])

if __name__ == "__main__":
    unittest.main()
