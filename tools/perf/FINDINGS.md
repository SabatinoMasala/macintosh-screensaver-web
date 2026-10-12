# Performance findings (2026-10-12, diagnosis)

Complaint: after a few minutes the whole Mac becomes slow while the page runs.

Short answer: the page does **not** accumulate work or memory over time (JS heap,
GL objects, controls, interpolations and process memory are flat over 10
simulated and 9 real minutes). It is **constantly** heavy: it renders a
full-resolution 4× MSAA frame on every display refresh, 2 to 4 times per actual
content change, and never idles, not even while paused. On Apple Silicon that is
a sustained GPU + memory-bandwidth load; the "worse after a few minutes" effect
is most plausibly thermal/power throttling plus memory pressure from the large
buffers (inference, to confirm with Activity Monitor → GPU History or
`powermetrics`).

Measured with `tools/perf/baseline.mjs` (headless Chromium on ANGLE/Metal, real
M4 Pro GPU; see `baseline-2026-10-12.md`). Key numbers:

| | value |
|---|---|
| JS heap after GC at 0 / 5 / 10 simulated min | 14.4 / 16.0 / 16.9 MB (bounded caches), flat in real time |
| processor.step / scene.update / scene.compose | 0.01–0.06 / 0.00–0.04 / 0.02–0.57 ms |
| renderer.uploadBitmap / render (JS submit) | 0.20–0.48 / 0.03–0.20 ms |
| GPU frame, 4× MSAA: 1280×800 / MBP 14" / MBP 16" / 5K | 0.9 / 3.0 / 2.6 / 4.1 ms |
| GPU frame, no MSAA | 1.0 / 1.5 / 1.7 / 2.6 ms |
| GPU frame with every tile collapsed | 1.2 / 1.9 / 2.4 / 3.8 ms (full-screen passes dominate) |
| Offscreen buffers | 23 / 136 / 177 / 338 MB |
| Renders per simulation step (live loop) | 2.2 (60 Hz headless; 4 on ProMotion) |
| Composed bitmap unchanged between steps | 86 % of steps |
| GL objects created per frame / per program | none (all at startup; resize deletes before recreating) |

## Causes, ranked

- **S1. Renders on every rAF although content changes at 30 Hz.** 50 % wasted at
  60 Hz, 75 % at 120 Hz, 100 % while paused. Fix: render only when the loop
  stepped or a dirty flag is set (settings, resize, program switch, first
  frame); nothing while paused.
- **S2. Full device resolution, 4× MSAA, three full-screen passes per frame.**
  Cost follows pixel count, not content; MSAA adds 35–50 %; buffers 136–338 MB.
  Estimated memory traffic 17–42 GB/s at 60 Hz, 34–85 GB/s at 120 Hz, against
  68–100 GB/s total on a base M1/M2. Fixes: `invalidateFramebuffer` after the
  resolve blit; cap the internal resolution (~4 MP or DPR 1.5) and upscale in
  the present pass; 2× or no MSAA at DPR ≥ 2.
- **S3. Texture upload every step although the bitmap is unchanged 86 % of the
  time** (0.2–0.5 ms + 175 KB per step). Fix: dirty flag / compare; drop the
  byte-scaling loop (test `> 0.0` in the shader).
- **S4. Minor per-frame costs:** 5–24 KB garbage per frame (mat4 arrays,
  uniform arrays, state objects), 2 `matchMedia()` calls per frame
  (`ColorState.isDark`), 2 `getParameter` calls per frame,
  `getBoundingClientRect` per frame when pixelRatio is not auto, status line
  rewritten 7.5×/s while invisible.

## Over-time suspects, all cleared

`sprite.asBitmap()` keeps a 175 KB copy per full-screen image (bounded, 5.5 MB
max; could share `sprite.ink`); HyperCard keeps a 0.68 MB threshold array; old
Scenes are collected; `scene.log` ≤ 5 entries; interpolation arrays ≤ 2;
SolitaireWin trails and Canvas layers fixed size; no listeners/timers per program.

## Targets after the fixes

`node tools/perf/baseline.mjs http://127.0.0.1:8767/`: renders per step ≈ 1.0,
GPU frame at 14"/5K size ≤ 1.5 ms, uploads ≈ 0.14 × steps, heap flat, zero GPU
work while paused.
