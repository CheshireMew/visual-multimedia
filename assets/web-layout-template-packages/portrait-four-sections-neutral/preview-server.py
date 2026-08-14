from __future__ import annotations

import argparse
import errno
import functools
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import webbrowser


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


def create_server(
    host: str,
    port: int,
    handler: type[SimpleHTTPRequestHandler] | functools.partial,
) -> ThreadingHTTPServer:
    if port:
        return ThreadingHTTPServer((host, port), handler)
    first_safe_port = 49152
    last_safe_port = 65535
    width = last_safe_port - first_safe_port + 1
    start = first_safe_port + (os.getpid() % width)
    for offset in range(256):
        candidate = first_safe_port + ((start - first_safe_port + offset) % width)
        try:
            return ThreadingHTTPServer((host, candidate), handler)
        except OSError as error:
            if error.errno not in {errno.EADDRINUSE, errno.EACCES}:
                raise
    raise RuntimeError(
        f"No browser-safe local port is available in {first_safe_port}-{last_safe_port}"
    )


def write_ready_file(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f"{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description="Preview this editable-media package.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--ready-file", type=Path)
    args = parser.parse_args()

    package_root = Path(__file__).resolve().parent
    handler = functools.partial(QuietHandler, directory=str(package_root))
    server = create_server(args.host, args.port, handler)
    actual_host, actual_port = server.server_address[:2]
    url = f"http://{actual_host}:{actual_port}/index.html"
    if args.ready_file:
        write_ready_file(
            args.ready_file.resolve(),
            {
                "protocol": "editable-media-preview-ready",
                "version": 1,
                "pid": os.getpid(),
                "root": str(package_root),
                "url": url,
            },
        )
    print(url, flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
