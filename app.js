const $ = (id) => document.getElementById(id);

const els = {
  file: $("file-input"), clear: $("clear-button"), stage: $("stage"), dropZone: $("drop-zone"), empty: $("empty-state"), canvas: $("ascii-canvas"),
  sourceName: $("source-name"), renderSize: $("render-size"), status: $("status-message"), charset: $("charset"), customCharset: $("custom-charset"),
  columns: $("columns"), fontSize: $("font-size"), colorMode: $("color-mode"), background: $("background"), contrast: $("contrast"),
  contrastValue: $("contrast-value"), brightness: $("brightness"), brightnessValue: $("brightness-value"), saturation: $("saturation"),
  saturationValue: $("saturation-value"), invert: $("invert"), dither: $("dither"), ditherAmount: $("dither-amount"),
  ditherValue: $("dither-value"), motion: $("motion"), duration: $("duration"), fps: $("fps"), png: $("png-button"), gif: $("gif-button"),
  webm: $("webm-button"), svg: $("svg-button"), text: $("text-button"), exportNote: $("export-note"), textDialog: $("text-dialog"), textOutput: $("text-output"),
  textSize: $("text-size"), textClose: $("text-close"), textCopy: $("text-copy"), textDownload: $("text-download")
};

const railButtons = [...document.querySelectorAll(".rail-button[data-tab]")];
const tabPanels = [...document.querySelectorAll(".tab-panel[data-panel]")];
const ctx = els.canvas.getContext("2d", { alpha: true });
const sampleCanvas = document.createElement("canvas");
const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
const orderedDither = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];

let source = null;
let sourceType = "image";
let sourceUrl = "";
let sourceFile = null;
let previewStart = performance.now();
let frameHandle = 0;
let lastDraw = 0;
let busy = false;
let latestText = "";

const state = {
  cols: 96,
  fontSize: 12,
  contrast: 1,
  brightness: 0,
  saturation: 1,
  invert: false,
  colorMode: "source",
  background: "black",
  dither: "none",
  ditherAmount: 18,
  motion: "static"
};

const clamp = (value, minimum = 0, maximum = 255) => Math.max(minimum, Math.min(maximum, value));

function setStatus(message, tone = "") {
  els.status.textContent = message;
  els.status.dataset.tone = tone;
}

function currentCharset() {
  const selected = els.charset.value === "custom" ? els.customCharset.value : els.charset.value;
  return selected && selected.length > 1 ? selected : " @";
}

function sourceDimensions() {
  if (!source) return { width: 16, height: 9 };
  if (sourceType === "video") return { width: source.videoWidth || 16, height: source.videoHeight || 9 };
  return { width: source.naturalWidth || source.width || 16, height: source.naturalHeight || source.height || 9 };
}

function getRows(width, height, columns = state.cols) {
  return Math.max(8, Math.round(columns * (height / width) * 0.56));
}

function resizeOutput(width, height) {
  const rows = getRows(width, height);
  const cellWidth = state.fontSize * 0.62;
  const outputWidth = Math.max(240, Math.round(state.cols * cellWidth));
  const outputHeight = Math.max(120, Math.round(rows * state.fontSize * 1.08));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(outputWidth * dpr);
  const pixelHeight = Math.round(outputHeight * dpr);
  if (els.canvas.width !== pixelWidth || els.canvas.height !== pixelHeight) {
    els.canvas.width = pixelWidth;
    els.canvas.height = pixelHeight;
  }
  els.canvas.style.width = `${outputWidth}px`;
  els.canvas.style.height = `${outputHeight}px`;
  els.renderSize.textContent = `${state.cols} × ${rows}`;
  return { rows, outputWidth, outputHeight, dpr };
}

function motionTransform(time, width, height) {
  const phase = time / 1000;
  if (state.motion === "drift") {
    return { scale: 0.9, x: Math.sin(phase * 1.2) * width * 0.035, y: Math.cos(phase * 0.9) * height * 0.025 };
  }
  if (state.motion === "zoom") {
    return { scale: 0.97 + Math.sin(phase * 0.8) * 0.03, x: 0, y: 0 };
  }
  if (state.motion === "wave") return { scale: 0.96, x: 0, y: 0 };
  return { scale: 1, x: 0, y: 0 };
}

function drawSourceSample(columns, rows, time = 0, animated = true) {
  sampleCanvas.width = columns;
  sampleCanvas.height = rows;
  sampleCtx.clearRect(0, 0, columns, rows);
  sampleCtx.imageSmoothingEnabled = true;
  if (!source) return sampleCtx.getImageData(0, 0, columns, rows);

  const transform = animated ? motionTransform(time, columns, rows) : { scale: 1, x: 0, y: 0 };
  const drawWidth = columns * transform.scale;
  const drawHeight = rows * transform.scale;
  const drawX = (columns - drawWidth) / 2 + transform.x;
  const drawY = (rows - drawHeight) / 2 + transform.y;

  // The character grid already compensates for glyph aspect ratio, so stretching the
  // complete source into this grid preserves its visual proportions without cropping.
  sampleCtx.drawImage(source, drawX, drawY, drawWidth, drawHeight);
  return sampleCtx.getImageData(0, 0, columns, rows);
}

function glyphDensity(red, green, blue, row, column, time, background = state.background) {
  let luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  luminance = ((luminance - 128) * state.contrast) + 128 + state.brightness;
  luminance = clamp(luminance);
  let density = background === "black" ? luminance : 255 - luminance;
  if (state.invert) density = 255 - density;

  if (state.dither === "ordered") {
    const offset = (orderedDither[row % 4][column % 4] / 15) - 0.5;
    density += offset * state.ditherAmount * 2;
  } else if (state.dither === "noise") {
    const seed = Math.sin((row * 127.1) + (column * 311.7) + Math.floor(time / 120) * 0.17) * 43758.5453;
    density += ((seed - Math.floor(seed)) - 0.5) * state.ditherAmount * 2;
  }
  return clamp(density);
}

function sourceColor(red, green, blue) {
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  return {
    red: Math.round(clamp(luminance + (red - luminance) * state.saturation)),
    green: Math.round(clamp(luminance + (green - luminance) * state.saturation)),
    blue: Math.round(clamp(luminance + (blue - luminance) * state.saturation))
  };
}

function glyphColor(red, green, blue) {
  if (state.colorMode === "mono") return state.background === "black" ? "#ffffff" : "#010101";
  if (state.colorMode === "blue") return "#0008ff";
  const color = sourceColor(red, green, blue);
  return `rgb(${color.red}, ${color.green}, ${color.blue})`;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderFrame(time = 0) {
  const { width, height } = sourceDimensions();
  const output = resizeOutput(width, height);
  const { rows, dpr } = output;
  const columns = state.cols;
  const pixels = drawSourceSample(columns, rows, time, true).data;
  const chars = currentCharset();
  const backgroundColor = state.background === "white" ? "#ffffff" : "#010101";

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  if (state.background !== "transparent") {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
  }
  ctx.scale(dpr, dpr);
  ctx.font = `${Math.max(6, state.fontSize)}px "Courier New", monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const cellWidth = output.outputWidth / columns;
  const cellHeight = output.outputHeight / rows;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = (row * columns + column) * 4;
      const alpha = pixels[index + 3];
      if (alpha < 18) continue;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const density = glyphDensity(red, green, blue, row, column, time);
      const char = chars[Math.min(chars.length - 1, Math.floor((density / 255) * (chars.length - 1)))];
      if (char === " ") continue;

      const wave = state.motion === "wave" ? Math.sin(time / 280 + row * 0.42) * state.fontSize * 0.48 : 0;
      ctx.fillStyle = glyphColor(red, green, blue);
      ctx.globalAlpha = alpha / 255;
      ctx.fillText(char, column * cellWidth, row * cellHeight + wave);
    }
  }
  ctx.globalAlpha = 1;
  return output;
}

function drawPreview(timestamp) {
  const elapsed = timestamp - previewStart;
  if (!lastDraw || timestamp - lastDraw > 12) {
    if (sourceType === "video" && source && source.readyState >= 2 && source.paused) source.play().catch(() => {});
    renderFrame(elapsed);
    lastDraw = timestamp;
  }
  frameHandle = requestAnimationFrame(drawPreview);
}

function activateTab(tabName) {
  railButtons.forEach((button) => {
    const selected = button.dataset.tab === tabName;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  tabPanels.forEach((panel) => {
    const selected = panel.dataset.panel === tabName;
    panel.hidden = !selected;
    panel.classList.toggle("active", selected);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName() {
  return (sourceFile?.name || "ascii-art").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
}

function staticImageExportAvailable() {
  return Boolean(source && sourceType === "image" && state.motion === "static");
}

function textExportAvailable() {
  return staticImageExportAvailable();
}

function updateExportState() {
  const unavailable = !source || busy;
  els.png.disabled = unavailable;
  els.gif.disabled = unavailable;
  els.webm.disabled = unavailable;
  els.svg.disabled = busy || !staticImageExportAvailable();
  els.text.disabled = busy || !textExportAvailable();
  els.exportNote.textContent = state.motion === "static"
    ? "SVG and text are available for static images. GIF uses local FFmpeg."
    : "SVG and text are disabled in animation modes. GIF uses local FFmpeg.";
}

function setBusy(nextBusy) {
  busy = nextBusy;
  updateExportState();
}

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
    setStatus("Choose an image or video file.", "error");
    return;
  }
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceFile = file;
  sourceUrl = URL.createObjectURL(file);
  sourceType = file.type.startsWith("video/") ? "video" : "image";

  if (sourceType === "video") {
    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.src = sourceUrl;
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", reject, { once: true });
    });
    source = video;
    video.play().catch(() => {});
  } else {
    const image = new Image();
    image.decoding = "async";
    image.src = sourceUrl;
    await image.decode();
    source = image;
  }

  els.sourceName.textContent = file.name;
  els.stage.classList.remove("empty");
  els.empty.hidden = true;
  previewStart = performance.now();
  lastDraw = 0;
  setStatus(`${sourceType === "video" ? "Video" : "Image"} loaded — full frame preserved.`, "ok");
  updateExportState();
  renderFrame(0);
}

function clearSource() {
  source = null;
  sourceFile = null;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = "";
  els.file.value = "";
  els.sourceName.textContent = "No source loaded";
  els.renderSize.textContent = "—";
  els.stage.classList.add("empty");
  els.empty.hidden = false;
  setStatus("Ready for a source.");
  updateExportState();
  renderFrame(0);
}

function syncControls() {
  state.cols = Math.max(24, Math.min(220, Number(els.columns.value) || 96));
  state.fontSize = Math.max(6, Math.min(28, Number(els.fontSize.value) || 12));
  state.contrast = Number(els.contrast.value);
  state.brightness = Number(els.brightness.value);
  state.saturation = Number(els.saturation.value);
  state.invert = els.invert.checked;
  state.colorMode = els.colorMode.value;
  state.background = els.background.value;
  state.dither = els.dither.value;
  state.ditherAmount = Number(els.ditherAmount.value);
  state.motion = els.motion.value;
  els.contrastValue.textContent = state.contrast.toFixed(2);
  els.brightnessValue.textContent = String(state.brightness);
  els.saturationValue.textContent = state.saturation.toFixed(2);
  els.ditherValue.textContent = String(state.ditherAmount);
  els.customCharset.hidden = els.charset.value !== "custom";
  els.stage.dataset.background = state.background;
  updateExportState();
  if (source) renderFrame(performance.now() - previewStart);
}

async function exportPng() {
  if (!source) {
    setStatus("Load a source before exporting.", "error");
    return;
  }
  renderFrame(performance.now() - previewStart);
  els.canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, `${baseName()}.png`);
    setStatus("Full-frame PNG exported.", "ok");
  }, "image/png");
}

function generateSvgOutput() {
  const { width, height } = sourceDimensions();
  const output = resizeOutput(width, height);
  const columns = state.cols;
  const rows = output.rows;
  const pixels = drawSourceSample(columns, rows, 0, false).data;
  const chars = currentCharset();
  const cellWidth = output.outputWidth / columns;
  const cellHeight = output.outputHeight / rows;
  const elements = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${output.outputWidth}" height="${output.outputHeight}" viewBox="0 0 ${output.outputWidth} ${output.outputHeight}" role="img" aria-label="ASCII art exported by ASCII Image Lab">`,
    "<title>ASCII art exported by ASCII Image Lab</title>"
  ];

  if (state.background !== "transparent") {
    elements.push(`<rect width="100%" height="100%" fill="${state.background === "white" ? "#ffffff" : "#010101"}"/>`);
  }
  elements.push(`<g font-family="Courier New, monospace" font-size="${state.fontSize}" xml:space="preserve">`);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = (row * columns + column) * 4;
      const alpha = pixels[index + 3];
      if (alpha < 18) continue;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const density = glyphDensity(red, green, blue, row, column, 0);
      const char = chars[Math.min(chars.length - 1, Math.floor((density / 255) * (chars.length - 1)))];
      if (char === " ") continue;
      const x = (column * cellWidth).toFixed(2);
      const y = (row * cellHeight).toFixed(2);
      const opacity = alpha < 250 ? ` fill-opacity="${(alpha / 255).toFixed(3)}"` : "";
      elements.push(`<text x="${x}" y="${y}" dominant-baseline="text-before-edge" fill="${glyphColor(red, green, blue)}"${opacity}>${escapeXml(char)}</text>`);
    }
  }
  elements.push("</g>", "</svg>");
  return elements.join("\n");
}

function exportSvg() {
  if (!staticImageExportAvailable()) {
    setStatus("SVG export is available only for static images.", "error");
    return;
  }
  const svg = generateSvgOutput();
  downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${baseName()}.svg`);
  setStatus(state.background === "transparent" ? "Transparent vector SVG exported." : "Vector SVG exported.", "ok");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function captureFrames() {
  const fps = Number(els.fps.value);
  const duration = Number(els.duration.value);
  const total = fps * duration;
  const frames = [];
  const wasPlaying = sourceType === "video" && source && !source.paused;
  if (sourceType === "video" && source) await source.play().catch(() => {});
  for (let index = 0; index < total; index += 1) {
    renderFrame((index / fps) * 1000);
    frames.push(els.canvas.toDataURL("image/png").split(",")[1]);
    await wait(2);
  }
  if (sourceType === "video" && source && !wasPlaying) source.pause();
  return { frames, fps };
}

async function exportGif() {
  if (!source) {
    setStatus("Load a source before exporting.", "error");
    return;
  }
  setBusy(true);
  setStatus("Rendering GIF frames…");
  try {
    const { frames, fps } = await captureFrames();
    const response = await fetch("/encode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "gif", fps, frames })
    });
    if (!response.ok) throw new Error(await response.text());
    downloadBlob(await response.blob(), `${baseName()}.gif`);
    setStatus("Full-frame GIF exported with local FFmpeg.", "ok");
  } catch (error) {
    setStatus(`GIF export failed: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

async function exportWebm() {
  if (!source) {
    setStatus("Load a source before exporting.", "error");
    return;
  }
  if (!window.MediaRecorder || !els.canvas.captureStream) {
    setStatus("This browser cannot record WebM.", "error");
    return;
  }
  setBusy(true);
  setStatus("Recording WebM…");
  try {
    const fps = Number(els.fps.value);
    const duration = Number(els.duration.value);
    const stream = els.canvas.captureStream(fps);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const done = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
    recorder.start();
    const frameMilliseconds = 1000 / fps;
    const total = fps * duration;
    for (let index = 0; index < total; index += 1) {
      renderFrame(index * frameMilliseconds);
      await wait(frameMilliseconds);
    }
    recorder.stop();
    await done;
    downloadBlob(new Blob(chunks, { type: mime || "video/webm" }), `${baseName()}.webm`);
    setStatus("Full-frame WebM exported.", "ok");
  } catch (error) {
    setStatus(`WebM export failed: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

function generateTextOutput() {
  const { width, height } = sourceDimensions();
  const maxColumns = 64;
  const maxRows = 72;
  let columns = maxColumns;
  let rows = Math.max(1, Math.round(columns * (height / width) * 0.56));
  if (rows > maxRows) {
    rows = maxRows;
    columns = Math.max(1, Math.round(rows / ((height / width) * 0.56)));
  }

  const pixels = drawSourceSample(columns, rows, 0, false).data;
  const chars = currentCharset();
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    let line = "";
    for (let column = 0; column < columns; column += 1) {
      const index = (row * columns + column) * 4;
      if (pixels[index + 3] < 18) {
        line += " ";
        continue;
      }
      const density = glyphDensity(pixels[index], pixels[index + 1], pixels[index + 2], row, column, 0, "white");
      line += chars[Math.min(chars.length - 1, Math.floor((density / 255) * (chars.length - 1)))];
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  const actualWidth = Math.max(0, ...lines.map((line) => line.length));
  return { text: lines.join("\n"), width: actualWidth, height: rows };
}

function openTextOutput() {
  if (!textExportAvailable()) {
    setStatus("Text copy is available only for static images.", "error");
    return;
  }
  const result = generateTextOutput();
  latestText = result.text;
  els.textOutput.value = result.text;
  els.textSize.textContent = `${result.width} × ${result.height} characters · maximum 64 × 72`;
  if (typeof els.textDialog.showModal === "function") els.textDialog.showModal();
  else els.textDialog.setAttribute("open", "");
}

async function copyTextOutput() {
  try {
    await navigator.clipboard.writeText(latestText);
  } catch {
    els.textOutput.focus();
    els.textOutput.select();
    document.execCommand("copy");
  }
  els.textCopy.textContent = "Copied";
  setStatus("ASCII text copied to the clipboard.", "ok");
  setTimeout(() => { els.textCopy.textContent = "Copy text"; }, 1400);
}

function closeTextDialog() {
  if (typeof els.textDialog.close === "function") els.textDialog.close();
  else els.textDialog.removeAttribute("open");
}

els.file.addEventListener("change", (event) => loadFile(event.target.files[0]).catch((error) => setStatus(`Could not load file: ${error.message}`, "error")));
els.clear.addEventListener("click", clearSource);
els.stage.addEventListener("click", () => { if (!source) els.file.click(); });
els.stage.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !source) {
    event.preventDefault();
    els.file.click();
  }
});
els.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); els.dropZone.classList.add("dragging"); });
els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("dragging"));
els.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  els.dropZone.classList.remove("dragging");
  loadFile(event.dataTransfer.files[0]).catch((error) => setStatus(`Could not load file: ${error.message}`, "error"));
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => { if (!els.dropZone.contains(event.target)) event.preventDefault(); });
document.querySelectorAll(".controls input:not([type='file']), .controls select").forEach((control) => {
  control.addEventListener("input", syncControls);
  control.addEventListener("change", syncControls);
});
railButtons.forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.tab)));
els.png.addEventListener("click", exportPng);
els.svg.addEventListener("click", exportSvg);
els.gif.addEventListener("click", exportGif);
els.webm.addEventListener("click", exportWebm);
els.text.addEventListener("click", openTextOutput);
els.textClose.addEventListener("click", closeTextDialog);
els.textCopy.addEventListener("click", copyTextOutput);
els.textDownload.addEventListener("click", () => downloadBlob(new Blob([latestText], { type: "text/plain;charset=utf-8" }), `${baseName()}.txt`));
els.textDialog.addEventListener("click", (event) => { if (event.target === els.textDialog) closeTextDialog(); });

activateTab("style");
syncControls();
renderFrame(0);
cancelAnimationFrame(frameHandle);
frameHandle = requestAnimationFrame(drawPreview);
