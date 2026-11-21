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

if __name__ == "__main__":
    unittest.main()
