#!/usr/bin/env python3
"""serve.py - the hosting half of this port.

Three jobs, and a static host can do none of them:

  1. isolation headers. SharedArrayBuffer - and therefore any threaded browser
     port - only exists in a cross-origin-isolated context. EaglercraftX itself
     does not use SharedArrayBuffer, but the port keeps COOP/COEP on anyway: it
     costs nothing, it is what the OPFS asset cache and a future worker split
     need, and it means the same origin can host a threaded build unchanged.
  2. HTTP Range / 206. The asset layer (web/app/assetcache.js) pulls
     classes.wasm (14.2 MB) and assets.epk (11.7 MB) in 512 KiB blocks and
     caches them in OPFS, exactly the way the Halo CE port streams an XISO and
     the way the GTA V build pulled 4 KB blocks. Python's stock server answers
     Range with a plain 200, which silently turns that into a full re-download.
  3. /telemetry. The port POSTs frame stats, screen changes, crash reports and
     a log tail here; they append to telemetry.jsonl. That is the bo1z pattern,
     and it is the only way a hosted port can tell you that the build you
     deployed is the build that is running.
"""
import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
BUILD = os.path.join(WEB, "build")
TELEMETRY = os.path.join(ROOT, "tools", "telemetry.jsonl")
try:
    with open(TELEMETRY, "a"):
        pass
except OSError:
    TELEMETRY = os.path.join(os.environ.get("TMPDIR", "/tmp"), "browser-minecraft-telemetry.jsonl")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".epk": "application/octet-stream",
    ".epw": "application/octet-stream",
    ".lang": "text/plain; charset=utf-8",
    ".teadbg": "application/octet-stream",
    ".png": "image/png",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json",
}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME}
    # the asset streamer makes dozens of Range requests for one artifact;
    # HTTP/1.0 would open a fresh connection for every one of them
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def isolation_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Permissions-Policy", "cross-origin-isolated=(self)")

    def end_headers(self):
        self.isolation_headers()
        super().end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self.health()
        if path.startswith("/build/"):
            return self.serve_file(os.path.join(BUILD, path[len("/build/"):]))
        self.path = path
        return super().do_GET()

    def do_HEAD(self):
        path = urlparse(self.path).path
        if path.startswith("/build/"):
            f = os.path.join(BUILD, path[len("/build/"):])
            if not os.path.isfile(f):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(os.path.splitext(f)[1], "application/octet-stream"))
            self.send_header("Content-Length", str(os.path.getsize(f)))
            self.send_header("Accept-Ranges", "bytes")
            self.isolation_headers()
            self.end_headers()
            return
        return super().do_HEAD()

    def health(self):
        man = None
        mp = os.path.join(BUILD, "manifest.json")
        if os.path.isfile(mp):
            try:
                with open(mp) as f:
                    man = json.load(f)
            except Exception:
                man = None
        out = json.dumps({
            "ok": True,
            "isolated": True,
            "engine": (man or {}).get("engine"),
            "toolchain": (man or {}).get("toolchain"),
            "artifacts": len(((man or {}).get("artifacts") or {})),
            "bytes": (man or {}).get("total_bytes"),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def serve_file(self, fpath):
        fpath = os.path.abspath(fpath)
        if not fpath.startswith(BUILD) or not os.path.isfile(fpath):
            self.send_error(404)
            return
        size = os.path.getsize(fpath)
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            unit, _, spec = rng.partition("=")
            lo, _, hi = spec.partition("-")
            start = int(lo or 0)
            end = int(hi) if hi else size - 1
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", MIME.get(os.path.splitext(fpath)[1], "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.isolation_headers()
        self.end_headers()
        with open(fpath, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_POST(self):
        if urlparse(self.path).path != "/telemetry":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b"{}"
        try:
            rec = json.loads(body)
        except Exception:
            rec = {"raw": body[:4000].decode("utf-8", "replace")}
        rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            with open(TELEMETRY, "a") as f:
                f.write(json.dumps(rec) + "\n")
        except OSError as e:
            sys.stderr.write("telemetry write failed: %s\n" % e)
        out = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    # a PaaS injects PORT and will not route a service that binds loopback:
    # Render scans 0.0.0.0 for an open port and fails the deploy otherwise
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8766"))
    hosted = bool(os.environ.get("RENDER")) or bool(os.environ.get("DYNO"))
    host = sys.argv[2] if len(sys.argv) > 2 else os.environ.get(
        "HOST", "0.0.0.0" if hosted else "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"http://{host}:{port}/   (web={WEB})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
