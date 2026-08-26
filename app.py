#!/usr/bin/env python3
"""Calendar Viewer: static frontend and remote ICS loader."""

import http.client
import mimetypes
import os
import socket
import ssl
import sys
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
MAX_BYTES = 25 * 1024 * 1024
TIMEOUT = 30
TLS_CONTEXT = ssl._create_unverified_context()
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _csv_env(name, default=""):
    return tuple(
        item.strip().lower()
        for item in os.environ.get(name, default).split(",")
        if item.strip()
    )


def _host_gateway():
    configured = os.environ.get("HOST_GATEWAY", "").strip()
    if configured:
        return configured
    if Path("/.dockerenv").exists() or Path("/run/.containerenv").exists():
        return "host.docker.internal"
    return ""


HOST_GATEWAY = _host_gateway()
LOCAL_HOST_SUFFIXES = _csv_env("LOCAL_HOST_SUFFIXES", ".test,.localhost")
LOCAL_HOSTS = set(_csv_env("LOCAL_HOSTS"))


def _is_local_dev_host(hostname):
    if not hostname:
        return False
    host = hostname.lower().rstrip(".")
    if host in LOCAL_HOSTS or host in LOOPBACK_HOSTS:
        return True
    for suffix in LOCAL_HOST_SUFFIXES:
        token = suffix if suffix.startswith(".") else f".{suffix}"
        if host == token.lstrip(".") or host.endswith(token):
            return True
    return False


def _uses_host_gateway(hostname):
    return bool(HOST_GATEWAY) and _is_local_dev_host(hostname)


class GatewayHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.create_connection(
            (HOST_GATEWAY, self.port), self.timeout, self.source_address
        )
        try:
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        if self._tunnel_host:
            self._tunnel()


class GatewayHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        self.sock = socket.create_connection(
            (HOST_GATEWAY, self.port), self.timeout, self.source_address
        )
        try:
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        if self._tunnel_host:
            self._tunnel()
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


def _http_connection(host, **kwargs):
    hostname = urllib.parse.urlsplit(f"//{host}").hostname or host
    factory = GatewayHTTPConnection if _uses_host_gateway(hostname) else http.client.HTTPConnection
    return factory(host, **kwargs)


def _https_connection(host, **kwargs):
    hostname = urllib.parse.urlsplit(f"//{host}").hostname or host
    factory = GatewayHTTPSConnection if _uses_host_gateway(hostname) else http.client.HTTPSConnection
    return factory(host, **kwargs)


class DevHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_http_connection, req)


class DevHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_https_connection, req, context=self._context)


OPENER = urllib.request.build_opener(DevHTTPHandler(), DevHTTPSHandler(context=TLS_CONTEXT))


class AppHandler(BaseHTTPRequestHandler):
    server_version = "calendar-viewer/1.0"

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_HEAD(self):
        self._handle(send_body=False)

    def do_GET(self):
        self._handle(send_body=True)

    def _handle(self, send_body):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        if route == "/health":
            self._text(200, "ok", send_body)
        elif route == "/fetch":
            target = urllib.parse.parse_qs(parsed.query).get("url", [""])[0].strip()
            self._fetch(target, send_body)
        else:
            self._serve_static(parsed.path, send_body)

    def _fetch(self, target, send_body):
        if target.startswith("webcal://"):
            target = "https://" + target[len("webcal://") :]
        if not target.startswith(("http://", "https://")):
            return self._text(400, "Use an http, https, or webcal URL.", send_body)

        request = urllib.request.Request(
            target,
            headers={
                "User-Agent": "calendar-viewer/1.0",
                "Accept": "text/calendar, text/plain, */*",
            },
        )
        try:
            with OPENER.open(request, timeout=TIMEOUT) as response:
                body = response.read(MAX_BYTES + 1)
        except Exception as error:
            return self._text(502, f"Could not load calendar: {error}", send_body)

        if len(body) > MAX_BYTES:
            return self._text(413, "Calendar is too large.", send_body)

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _serve_static(self, request_path, send_body):
        if not DIST.is_dir():
            return self._text(
                503,
                "Frontend not built. Run: pnpm install && pnpm build",
                send_body,
            )

        relative = urllib.parse.unquote(request_path).lstrip("/") or "index.html"
        candidate = (DIST / relative).resolve()
        try:
            candidate.relative_to(DIST.resolve())
        except ValueError:
            return self._text(404, "Not found.", send_body)

        if not candidate.is_file():
            candidate = DIST / "index.html"
        try:
            body = candidate.read_bytes()
        except OSError:
            return self._text(404, "Not found.", send_body)

        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
        }:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _text(self, status, text, send_body=True):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} {fmt % args}\n")


class AppServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def parse_args(args):
    port = int(os.environ.get("PORT", "8787"))
    initial_url = None
    for arg in args:
        if arg.isdigit():
            port = int(arg)
        elif arg.startswith(("http://", "https://", "webcal://")):
            initial_url = arg
        else:
            raise SystemExit("Usage: python3 app.py [port] [ics-url]")
    return port, initial_url


if __name__ == "__main__":
    server_port, calendar_url = parse_args(sys.argv[1:])
    bind = os.environ.get("BIND", "127.0.0.1")
    page = f"http://localhost:{server_port}/"
    if calendar_url:
        page += "?url=" + urllib.parse.quote(calendar_url, safe="")
    print(f"Calendar Viewer: {page}", flush=True)
    if HOST_GATEWAY:
        suffixes = ", ".join(LOCAL_HOST_SUFFIXES)
        print(f"Host gateway: {HOST_GATEWAY} for {suffixes} and localhost", flush=True)
    AppServer((bind, server_port), AppHandler).serve_forever()
