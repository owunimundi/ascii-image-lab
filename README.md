# ASCII Image Lab

Local image/video-to-ASCII converter based on the extracted 21st.dev ASCII editor design language.

The editor keeps the full source frame, supports black, white, and transparent output canvases, and separates Style, Adjust, Effects, and Motion into working parameter tabs.

## Run it

From PowerShell:

```powershell
cd C:\Users\(YourName)\design-extract-output\21stdevasciiimage\local-ascii-tool
python .\server.py
```

Open in a Chromium-based browser.

## Exports

- PNG is rendered directly from the browser canvas.
- SVG is a true vector glyph export for static images. Choose the transparent canvas to omit the background rectangle.
- WebM is recorded locally with the browser's `MediaRecorder` API.
- GIF frames are rendered in the browser and encoded by the local FFmpeg bridge.
- Text creates paste-ready monochrome ASCII for static images only. The grid is aspect-correct and never exceeds 64 columns by 72 rows.

The server binds only to `127.0.0.1`; it does not upload source media anywhere.
