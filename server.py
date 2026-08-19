"""Local static server and FFmpeg frame encoder for ASCII Image Lab."""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("ASCII_TOOL_PORT", "8765"))


def ffmpeg_path() -> str | None:
    configured = os.environ.get("FFMPEG_PATH")
    if configured and Path(configured).exists():
        return configured
    return shutil.which("ffmpeg")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(f"[ascii-tool] {format % args}")

    def _send_bytes(self, data: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        self._send_bytes(json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8", status)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json({"ok": True, "ffmpeg": bool(ffmpeg_path()), "root": str(ROOT)})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/encode":
            self._send_json({"error": "Not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 150 * 1024 * 1024:
                raise ValueError("Request is empty or larger than 150 MB")
            payload = json.loads(self.rfile.read(length))
            fmt = payload.get("format")
            fps = max(1, min(60, int(payload.get("fps", 24))))
            frames = payload.get("frames")
            if fmt not in {"gif", "webm"} or not isinstance(frames, list) or not frames:
                raise ValueError("Expected a GIF or WebM request with at least one frame")
            if len(frames) > 600:
                raise ValueError("Maximum export length is 600 frames")
            executable = ffmpeg_path()
            if not executable:
                raise RuntimeError("FFmpeg was not found on PATH")

            with tempfile.TemporaryDirectory(prefix="ascii-tool-") as work:
                workdir = Path(work)
                for index, encoded in enumerate(frames):
                    if not isinstance(encoded, str):
                        raise ValueError("Frame data must be base64 strings")
                    if "," in encoded:
                        encoded = encoded.split(",", 1)[1]
                    (workdir / f"frame_{index:05d}.png").write_bytes(base64.b64decode(encoded, validate=True))
                output = workdir / f"output.{fmt}"
                command = [executable, "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(fps), "-i", str(workdir / "frame_%05d.png")]
                if fmt == "gif":
                    command += ["-vf", "split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=sierra2_4a", str(output)]
                else:
                    command += ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-b:v", "0", "-crf", "32", str(output)]
                result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.strip() or "FFmpeg failed")
                content_type = "image/gif" if fmt == "gif" else "video/webm"
                self._send_bytes(output.read_bytes(), content_type)
        except Exception as error:
            self._send_json({"error": str(error)}, 400)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"ASCII Image Lab running at http://{HOST}:{PORT}/")
    print(f"FFmpeg: {ffmpeg_path() or 'not found'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()
