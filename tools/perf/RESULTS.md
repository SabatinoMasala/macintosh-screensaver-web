# Performance fixes: results (2026-10-12)

The fixes for causes S1 to S4 in `FINDINGS.md`, measured with `tools/perf/baseline.mjs`: headless Chromium on ANGLE/Metal, the real M4 Pro GPU.

- **Before**: `baseline-2026-10-12.md` (the diagnosis run), plus a second run of the extended harness against an untouched copy of the pre-fix code in the same session (`REPORT=before`).
- **After**: `after-2026-10-12.md`.

Since the fixes, the harness measures what a user gets by default: `pixelRatio=auto` at the display's real DPR, with the renderer choosing the MSAA level itself. Headless Chromium reports `devicePixelContentBoxSize` in CSS pixels, so the harness emulates the Retina device-pixel size.

## Before / after

| | before | after |
|---|---|---|
| Renders per simulation step (live, 60 Hz headless) | 2.18 – 2.21 (4 on a 120 Hz ProMotion display) | **0.95 – 0.98** (independent of the refresh rate) |
| Bitmap uploads per step (live) | 1.00 | **0.18 – 0.79** (depends on the scene: 0.18 at 14", 0.79 at 1280x800 with a busy scene) |
| Texture bytes per step (sim) | 175 104 every step | 0 when unchanged (most samples: 0, 5.8 K, 11.7 K, 82 K, 163 K) |
| GPU frame ms, 1280x800 @1x (default) | 0.8 – 0.9 | 0.6 – 0.8 (same target, same pixels) |
| GPU frame ms, MacBook Pro 14" @2x | 2.2 – 3.0 | **1.4 – 1.8** (target 2482x1612, 4x) |
| GPU frame ms, MacBook Pro 16" @2x | 2.6 – 2.9 | **1.6** (target 2488x1608, 4x) |
| GPU frame ms, 5K @2x | 4.0 – 4.2 | **1.8 – 1.9** (target 2667x1500, 4x) |
| GPU busy share at 14" (frame ms x renders/s) | 2.4 ms x 66/s ≈ 16 % (x 120/s ≈ 29 %) | 1.8 ms x 29/s ≈ **5 %** |
| GPU busy share at 5K | 4.2 ms x 66/s ≈ 28 % (x 120/s ≈ 50 %) | 1.9 ms x 30/s ≈ **6 %** |
| Offscreen + canvas buffers, 1280x800 / 14" / 16" / 5K | 23 / 136 / 177 / 338 MB | 23 / **99 / 106 / 133** MB |
| While paused (14", panel closed) | 67 rAF/s, 67 renders/s, GPU util 37 %, GPU process CPU 11 %, renderer CPU 5 % | **0 rAF/s, 0 renders/s**, GPU util 0 % (after the first 5 s sample), GPU process CPU 0 %, renderer CPU 0 % |
| Live: system GPU util at 1280x800 / 14" / 5K (ioreg, includes other apps) | 23 / 37 / 42 % | 20 / 25 / 27 % |
| Live: GPU process CPU / renderer CPU | 12 – 13 % / 6 – 7 % | 7 – 8 % / 4 % |
| JS cost per step: upload / render submit (sim) | 0.20 – 0.48 / 0.03 – 0.15 ms | 0.02 – 0.05 / 0.003 – 0.03 ms |
| Garbage per render, uninstrumented (`renderer.render`, `colors.uniforms`, `colors.update`) | over 12 KB per render (GC ran during the loop), 582 B, 138 B | ~0.4 KB, 0, 0 |
| `matchMedia` calls / `getParameter` calls per frame | 2 / 2 | 0 / 0 |
| JS heap after GC (sim, 0 → 5 simulated min) | 14.41 → 15.95 MB | 14.27 → 14.53 MB |
| Soak at 14": renders/s, JS heap, heap after GC, GPU process RSS | 9 min: 58 – 69 renders/s, 15.3 – 17.5 MB, 16.34 MB, 69 – 76 MB | 5 min: 26 – 30 renders/s, 14.4 – 17.0 MB (no trend), **14.58 MB**, 72 – 88 MB |
| Soak GPU-frame probe (3 synced renders with the live loop running) | 2.0 – 4.1 ms, no trend | 1.6 – 3.8 ms, no trend. This probe reads high: the GPU now idles between frames, so it is presumably at lower clocks (not confirmed); the matrix numbers above are the per-frame cost |

GPU frame = the median of render + 1-pixel readback minus the readback floor, MacPaintHello zoomed in, 30 renders back to back (the matrix phase). The timer resolution is 0.1 ms, so neighbouring runs differ by 0.1 to 0.3 ms. The system GPU utilisation from ioreg covers the whole machine (idle readings during the runs: 0 to 49 %), so treat it as a trend, not as the page's own share.

## What changed, per cause

- **S1, render only when there is something new** (`src/main.js`)
  - The loop renders only when the 30 Hz simulation stepped or `invalidate()` marked the frame dirty. Callers of `invalidate()`:
    - the first frame and a program switch;
    - the look sliders, colour, appearance, contrast, pixelRatio and the random-colour action;
    - the renderer's ResizeObserver;
    - a `devicePixelRatio` change (resolution media query);
    - the `prefers-color-scheme` change event.
  - A step whose render inputs (camera, scroll, scale, ramp, zoom, colour uniforms) and bitmap did not change is not rendered either.
  - While paused the requestAnimationFrame loop stops entirely. Unpausing or any `invalidate()` starts it again, and the first frame after a restart advances no time.
  - `window.mac.advance()` still renders explicitly. `window.mac.invalidate` is exposed for tools.
- **S2, pixel cost** (`src/renderer.js`)
  - (a) `invalidateFramebuffer` on the multisampled colour attachment right after the resolve blit.
  - (b) With `pixelRatio` auto, the offscreen target is capped at `MAX_INTERNAL_PIXELS` (4 MP). The canvas keeps its exact device-pixel size, and the present pass upscales with linear filtering, using `texelFetch` 1:1 when the sizes are equal.
  - (c) MSAA is 2x when the target has 2 or more device pixels per CSS pixel, 4x below that. With auto on a Retina display the capped target is at 1.0 – 1.6 px per CSS px, so it keeps 4x; an explicit `pixelRatio` of 2 or 3 renders exactly at that ratio with 2x.
  - `renderer.msaa` and `renderer.maxPixels` are tunable for measurements.
- **S3, uploads** (`src/renderer.js`)
  - `uploadBitmap` compares the bitmap with a copy of the last upload, 4 bytes at a time with an early exit (20 – 50 µs), and returns whether it uploaded.
  - The byte-scaling loop is gone: the R8 texture holds the 0/1 bytes and the shader tests `> 0.0`.
- **S4 and D1/D2, per-frame allocations and synchronous calls**
  - In the renderer: matrices go into preallocated `Float32Array`s and the camera result object is reused; scalar uniforms replace temporary arrays; the GL limits are read once; the CSS size comes from the ResizeObserver instead of `getBoundingClientRect` per frame.
  - `ColorState` keeps one MediaQueryList with a change listener, precomputes the linear system colours and reuses its target and uniform arrays.
  - `main.js` reuses one render-state object. The status line is written only while the UI is visible, only when its text changed and at most every 4th step. It is refreshed when the UI wakes.
  - `Scene.rampVector` returns shared frozen arrays.
  - `sprite.asBitmap()` wraps `sprite.ink` instead of copying it (`Bitmap` takes an optional data array).
  - HyperCard's threshold array was left alone: it is already built lazily, only when a dissolve runs, and shrinking it (16-bit thresholds) would move some pixels' reveal frame.
- **Over-time check**
  - Every listener and observer is registered once. The DPR media-query watcher replaces itself on each change. The UI timer is cleared before it is re-armed. No program adds listeners or intervals.
  - Heap, GL object counts (2 textures, 2 framebuffers, 1 renderbuffer, never re-created during a run) and the GPU frame time stay flat: see the sim and soak sections of `after-2026-10-12.md`.

## Look

Before and after were compared on deterministic screenshots: seeded `Math.random`, the rAF loop stubbed, driven by `mac.advance`, overlays hidden, ANGLE/Metal, pre-fix code against the working tree.

| case | pixels that differ | differ by more than 8/255 | max diff |
|---|---:|---:|---:|
| IconGardenWallpaper, gray, 1280x800 | 0 | 0 | 0 |
| Mines, gray, 1280x800 | 0 | 0 | 0 |
| MacPaintHello, blue, dark, 1280x800 | 0 | 0 | 0 |
| IconGardenWallpaper, MacBook Pro 14" (auto: 2482x1612 target upscaled) | 47.8 % | 2.8 % | 92 |
| Mines, MacBook Pro 14" (auto) | 48.2 % | 3.9 % | 81 |
| Mines, MacBook Pro 14", explicit pixelRatio 2 (2x MSAA) | 2.1 % | 2.1 % | 74 |

- At 1x the output is bit-identical.
- On a Retina-sized canvas the differences are anti-aliasing along the tile and shadow edges: the differing pixels are those edges, plus ±1 dither noise in the background gradient, which is now computed at the target resolution. At 1:1 device pixels the crops cannot be told apart.
- `tools/screenshot.mjs` shots of `?program=IconGardenWallpaper&color=gray` and Mines match the pre-change renders pixel for pixel and print no page errors.

## Not done / options

- **The ≤ 1.5 ms target per frame is met at 14" and 16" only on good runs (1.4 – 1.8 ms) and is missed at 5K (1.8 – 1.9 ms).**
  - What remains is mostly the full-screen passes; "tiles off" costs the same.
  - At 5K the present pass alone writes the 14.7 MP canvas.
  - 2x MSAA on the capped target would give 1.2 ms at 14" and 1.5 ms at 5K, at the price of softer edges, so it was left at 4x.
  - Letting the browser compositor do the upscale would drop that pass and ~100 MB of canvas back buffers at 5K, but it was not done because the brief asked for the upscale in the present pass. It would mean sizing the canvas to the target and leaving the CSS size alone.
  - Because the page now renders at most 30 times a second and not at all while paused, the GPU share fell from 16 – 50 % to about 5 – 6 % anyway.
- **The "worse after a few minutes" theory (thermal throttling and memory pressure) is still an inference.** Confirming it on the owner's Mac needs Activity Monitor → GPU History or `powermetrics`.
