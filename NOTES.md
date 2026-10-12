# Reverse-engineering notes: macOS "Macintosh" screensaver / wallpaper

Source: `/System/Library/ExtensionKit/Extensions/WallpaperMacintoshExtension.appex`
(macOS 26.6.2, bundle version 245.6, "Macintosh 40th Anniversary", © 2024 Apple).
Copied verbatim into `assets/apple/original/` (binary + Resources) by
`scripts/extract-apple-assets.sh`; gitignored, never committed.

## Architecture (from the Swift type names, strings and the render function)

The extension is a tiny scripted scene player:

- 15 `*.program` scripts (plain text, a BASIC-like DSL) describe scenes: which
  512×342 1-bit screen image to show, which interactive controls to overlay, and
  a timeline of camera/scroll/mouse/keyboard actions.
- `PixelsRenderer` (Metal) draws the current 1-bit bitmap as a field of little
  square tiles seen from a tilted orthographic camera, on a coloured gradient
  background, with a soft shadow under every "on" pixel.
- `Processor` interprets the script; `Control` subclasses (Button, ImageButton,
  RadioButton(Group), Slider, Text, TimeText, DateText, Caret, Puzzle, Menu,
  StartupIcon, Cursor, CursorRect, AnimatedIcon, FinderIcon, Canvas) are
  composited into the bitmap in CoreGraphics before upload.
- `programRandomizer` / `colorRandomizer` pick the next program and (for the
  "Random" colour setting) the next colour.

## DSL grammar (the exact regexes from the binary)

```
/^\s*add (button|imagebutton|radiobutton|radiobuttongroup|slider|text|time|date|caret|puzzle|menu|startupicon|cursor|cursorrect|icon|findericon|canvas)(?: at (\d+), ?(\d+))?(?: size (\d+), ?(\d+))?(?: value (\d+))?(?: action "(\w+)")?(?: name "(\w+)")?\s*$/
/^\s*reset controls\s*$/
/^\s*(scale|zoom) (?:to )?(in|out|[\d.-]+)(?: over ([\d.]+) seconds?(?: curve (linear|easein|easeout|easeinout|easeoutback))?(?: async "(\w+)")?)?\s*$/
/^\s*(camera|scroll|mouse) to ([\d.-]+), ?([\d.-]+)(?: over ([\d.]+) seconds?(?: curve (linear|easein|easeout|easeinout))?(?: async "(\w+)")?)?\s*$/
/^\s*mouse (down|up|click)\s*$/
/^\s*keyboard "(.*)"\s*$/
/^\s*let (\w+) = (\d+)\s*$/
/^\s*let (\w+) = "(.*)"\s*$/
/^\s*(\w+):\s*$/
/^\s*goto (\w+)\s*$/
/^\s*gosub (\w+)\s*$/
/^\s*return\s*$/
/^\s*cancel async "(\w+)"\s*$/
/^\s*wait for "(\w+)" to complete\s*$/
/^\s*wait until ([\d.]+) seconds? before "(\w+)" completes\s*$/
/^\s*wait for ([\d.]+) seconds?\s*$/
/^\s*(start|end) simultaneous\s*$/
```

Plus `exit`, `//` comments. Variables used by the scripts: `image`, `scene`,
`cursor` (None / Arrow / Automatic / Crosshair / Text), `ramp` (None / Right /
Left / Up / Down). Instruction classes: AddControl, CancelIdentifier, Exit,
GoSub, GoTo, Interpolation, Keyboard, Label, Let, Mouse, ResetControls, Return,
Simultaneous, WaitDuration, WaitIdentifier, WaitUntil.

## Coordinate conventions

- The scene is 512×342 pixels, y down (classic Mac). `scroll to x, y` is the
  bitmap point the camera looks at; `mouse to x, y` is the cursor hotspot.
- `add <control> at x, y` is the control's **bottom-left** corner (verified
  pixel-exact: the puzzle grid ends at y=200 for `add puzzle at 400, 200`, the
  caret of `add caret at 381, 164 size 1, 18` fills the blink-demo box, the
  radio buttons of `at 155, 247` land on the "1 0" circles). Controls draw
  upward from that point; the Menu adds its own image height (213) so
  `add menu at 266, 0` hangs from the menu bar.
- Exception: `add cursor at x, y` is the cursor's **hotspot**, the same as
  `mouse to` (top-left = `(x − hotX, y − hotY)`). Verified 2026-10-11 against
  IconGarden.png: the Watch (`at 215, 151`, hotspot 8, 8, top-left 207, 143)
  then clears the base ink by 6 px left / right / top, and the Ball (`at 171,
  180`, hotspot 7, 7, top-left 164, 173) by 8 / 8 / 7 / 7 px, the best-centred
  of all placements. The bottom-left reading (top-left `(x, y − 15)`) put
  the watch strap on the clipboard's bottom edge (row 136) and the ball
  flush against the document's bottom border (row 165).
- IconGarden's `add icon` sprites (32×32, bottom-left, top-left `(x, y −
  31)`) all sit in their holes with ≥ 3 px of white around the union of their
  frames (CloseBox 6/6/6/6, Trash 4/4/·/4); its caret (`at 241, 128 size 1,
  15`, rows 114–128) lies on the axis of the dotted blink arcs (x 232↔250,
  rows 114–128).
- `add cursor at 406, 2451` in IconGarden is an off-screen typo in Apple's
  script; keep it.

## Renderer (decompiled from `-[PixelsRenderer draw]`, 0x100008424)

- Orthographic projection. The visible window is `W` bitmap pixels wide, with
  `W = 140` normally and `180` when the aspect ratio is < 0.5 or > 2. Height is
  `W / aspect`. Depth: eye at z = -1000, lookAt origin, up (0,1,0); z range
  mapped with `-0.0005 z - 1.0005` (near 1, far 2001).
- Camera `camera to a, b`: quaternion rotation about Z by `a` degrees, then
  about the (rotated) X axis by `-b` degrees. Scripts use (±22.5, 45).
- A `W×W` block of pixels around the scroll point is drawn with instancing
  (`instanceCount = W²`; `pixelsRectInt = (int(scroll) - W/2, …, W)`,
  `translate = scroll - bitmapCenter` for the sub-pixel offset).
- Model scale = fit × (1 + 2·zoom) where fit makes the rotated W×W block cover
  the viewport (max over the projected corner extents, times W/(W-2)).
  `zoom in` = 1 (3× magnification, used for the MacPaint menubar close-up),
  `zoom out` = 0.
- Pixel quad: ±0.45 (so 0.1 gap between tiles); shadow quad ±1.125 at z=-0.45;
  background quad ±1 (scaled to the viewport). Shaders: pixelVertex /
  pixelFragment, shadowFragment, backgroundVertex / backgroundFragment.
- The shaders ARE readable: split `default.metallib` keeping each function's
  20-byte bitcode wrapper header (`tools/metallib_split.py`) and Homebrew's
  `llvm-dis` (LLVM 20) disassembles the AIR. Output in `assets/apple/shaders/*.ll`
  (regenerated by `scripts/extract-apple-assets.sh` when python3 + llvm-dis
  are installed; Apple's code, so gitignored):
  - `pixelFragment` returns `uniforms.color`, flat (no edge softening).
  - `shadowFragment`: `t = clamp(|modelPosition.xy| / 1.125, 0, 1)`,
    `s = 1 - smoothstep(t)` per axis (t²(3−2t)), returns
    `float4(color.rgb, 0.375 · s.x · s.y)`: the shadow is the TILE colour, a
    separable soft box over the whole ±1.125 quad, peak alpha 0.375.
  - `backgroundVertex` picks backgroundColorTop for y > 0, else Bottom;
    `backgroundFragment` returns the interpolated colour (no dither).
  - `pixelVertex` (used by both the tile and the shadow pass): a texel is "on"
    when its red < 0.5 (black ink). Every quad (tile AND shadow) is scaled by
    `on × k` around `scroll − p − 1`, with `k = animation.x` when
    rampDirection is zero and otherwise a smoothstep wipe along the ramp's x
    (or y) axis. Full derivation and the port: "Rendering decisions" below.
- Pipeline state: layer pixel format 0x73 (RGBA16Float) with colorspace
  `kCGColorSpaceLinearSRGB`, so all colours are linear and the shadow blend
  (sourceRGB = sourceAlpha, destinationRGB = oneMinusSourceAlpha) happens in
  linear light. No sampleCount is set (no MSAA); drawable = bounds ×
  contentsScale. Bitmap texture BGRA8Unorm (0x50).
- Uniforms (208 bytes): viewProjectionMatrix, bitmapSize, bitmapSizeInt,
  pixelsRectInt, translate, rampDirection, animation, backgroundColorTop,
  backgroundColorBottom, color.
  - `animation = (s, 1.25 s - 0.75, 1.25 s - 0.5, 0)` with `s` the `scale`
    value (scale in = 1, scale out = 0): the tile reveal animation.
  - `rampDirection = dir × d / W` where dir is the `ramp` variable's unit
    vector (an ivar written when `let ramp` runs, 0x100005f24) and `d` is the
    Processor float at +0x54: `copysign(1, to − from)` of the running `scale`
    interpolation (0 when equal), NOT a scroll speed. (An earlier version of
    this note said "smoothedSpeed"; corrected 2026-10-11.)
  - `translate = (scroll − bitmapSize.zw, 0, 0)`, `bitmapSizeInt =
    (int(bitmapSize.x), int(bitmapSize.y), 0, 0)`, `pixelsRectInt =
    (int(scroll.x) − W/2, int(scroll.y) − W/2, W, 0)` (Swift `Int32()`,
    truncating).
- Colours: scene colour comes from the user's colour setting (NSColor
  systemBlue/Green/Yellow/Orange/Red/Purple, the accent colour, Gray =
  (0.70, 0.70, 0.77), Dark Gray = (0.165, 0.15, 0.15), Spectrum = hue cycling,
  Random = new colour per program, blended towards the target each frame).
  `factor = 0.3` in dark appearance, `1` in light.
  - backgroundColorBottom = sceneColor × factor
  - backgroundColorTop = toLinear(mix(toSRGB(bottom), 1, 0.26 light / 0.09 dark))
  - pixel colour = sceneColor × factor × contrast, contrast = 0.666 as a
    screensaver, 0.2 as a desktop wallpaper (smoothed 0.96/0.04 per frame).
- Display link runs at 30 fps (`setPreferredFrameRateRange` 30/30/30).

## Resource formats

- `*.png` 512×342 scene images (1-bit content), plus sprite sheets:
  HappyMac 14×32×32, StartupIcons 3×32×32, ResEdit 19×32×32, CloseBox 4,
  Bomb 4, Trash 2, Clarus 2, Disks 2 (all 32×32), FolderIcon/TrashIcon 4×64×48,
  RadioButton 4×16×16, RadioButtonSystem1Number0/1 4×16×16, CancelButton
  2×74×18, PuzzleTiles 16×19×19, Slider 23×11, MacWriteStyleMenu 119×213.
- `CURS_<id>.bin`: classic 16×16 cursors, 32 bytes image + 32 bytes mask +
  hotspot (y, x) big-endian. ids: 0 arrow, 1 I-beam, 2 crosshair, 4 watch,
  128–136 hand frames, 2400–2406 watch frames, 25001–25008 beach-ball frames,
  −20709…−20714 Clarus frames. `acur_<id>.bin` = frame count + CURS ids.
  Brush cursor is drawn in code (4×4 filled ellipse).
- `Chicago12.bin`, `Geneva9.bin`, `Geneva12.bin`, `Monaco9.bin`: classic
  Macintosh `NFNT` resources (fontType, firstChar, lastChar, widMax, kernMax,
  nDescent, fRectWidth, fRectHeight, owTLoc, ascent, descent, leading,
  rowWords, bitImage, locTable, owTable).
- `default.metallib`: compiled AIR only (no source).

## Per-control facts used by the reimplementation

- `scale in` = 1, `scale out` = 0 (number form accepted); `zoom` likewise.
- Menu: 20 px title, 16 px items, separator row not selectable; the chosen
  item flashes with a 0.2 s period (on 0.1 s) for 0.6 s, then the menu closes.
- Slider: 23×11 knob, offset range −1…85 px upward from the anchor, snaps to
  `floor((offset + 5) / 12) * 12` on release; `value` is the initial offset
  (the System 6 slider has none and the script's drag only makes sense with 24).
- Caret visible while `t mod 2·interval < interval`; the interval comes from
  the `caretSlow` / `caretNormal` / `caretFast` actions (values not recovered).
- Animated icons advance one frame every `value` ticks of 1/60 s; the startup
  floppy's "?" blinks with a 1.5 s period (50 % duty); a click turns it into
  the happy Mac.
- Puzzle: 4×4 cells, 19 px tiles on a 20 px pitch, frame 0 of PuzzleTiles is
  the empty cell. The scripted clicks are only valid slides if the empty cell
  starts top-left, so that is the initial layout.
- Calculator: buttons carry a digit as `action`; the display Text has
  `action "0"` (initial content, right-aligned at its x) and `value 6` (max
  digits). The scripted presses type 1, 9, 8, 4.
- Radio buttons without an image (`name "None"`, or with a size) invert their
  rectangle while selected; image radios use frames off / off-pressed / on /
  on-pressed. The base images never carry the highlight.
- Text: `keyboard "..."` types into it (newline = new line); dragging with the
  Text cursor selects (inverted) text. Typing speed is not in the binary (12
  chars/s here).
- FinderIcon: 64×48 with label; frames normal / selected / full / full
  selected (trash). Dragging shows a dotted outline; dropping on the trash hides
  the icon and fills the trash.
- Canvas: 4 px round brush, 4 px round-capped strokes (CGContext line width 4,
  round cap, 4×4 filled ellipse in the binary).

## Rendering decisions in the web version

- The reveal (`scale`) and the `ramp` effect are a straight port of
  `pixelVertex` (2026-10-11; `assets/apple/shaders/pixelVertex.ll`, CPU side from
  `-[PixelsRenderer draw]` 0x100008dbc–0x1000090d0 and the interpolation
  updater 0x10000fae8). Signature: `(uniforms, vertexBuffer float4[],
  texture, vertex_id, instance_id) → (position, modelPosition)`.
  Per instance `i` and vertex `v`, in plain maths:
  - Pixel: `p = (rect.x + i mod rect.z, rect.y + i div rect.z)` (unsigned
    div/rem by `W`), `rect = pixelsRectInt`.
  - Ink: `on = 1` iff `0 ≤ p.x < bitmapSizeInt.x`, `0 ≤ p.y < bitmapSizeInt.y`
    and the texture sampled at pixel coordinate `p + 0.5` has red < 0.5; else
    0. Out-of-bitmap instances skip the sample.
  - Centre: `m = bitmapSize.zw − (p + 0.5) − 0.5`, world `c = translate.xy +
    m`. Since `translate = scroll − bitmapSize.zw`, `bitmapSize.zw` cancels:
    `c = scroll − p − 1`. So the camera (world origin) looks at bitmap point
    `scroll − 0.5`, i.e. an integer scroll centres the pixel `scroll − 1`.
    Apple's x axis is mirrored (pixels further right have smaller world x);
    its view, eye at z = −1000 looking at +z, mirrors it back.
  - Size factor `k`:
    - `rampDirection.x ≠ 0`: `u = c.x · rampDirection.x`;
      `else if rampDirection.y ≠ 0`: `u = c.y · rampDirection.y`;
      then `t = clamp((u − animation.y) / (animation.z − animation.y), 0, 1)`,
      `k = 1 − t²(3 − 2t)`.
    - both zero: `k = animation.x = s` (every tile at the same scale, no
      easing in the shader; the script's curve is in `s`).
  - Position: `P = translate.xyz + (m, 0) + k · on · vertex.xyz`,
    `position = viewProjectionMatrix · (P, 1)`; `modelPosition = vertex`
    unscaled (so the shadow's falloff is never squashed, it shrinks
    geometrically with the quad). Shadow and tile passes are the SAME
    function, only the vertex buffer differs: tiles ±0.45 at z 0, shadows
    ±1.125 at z −0.45, so `k` also scales the shadow's z offset.
  - Off pixels are not culled: `on = 0` (or `k = 0`) collapses all four
    vertices onto the centre, a zero-area quad that rasterises nothing.
  - The wipe: `animation.z − animation.y = 0.25` always, and `|u| ≤ 0.5` over
    the W×W block when `|rampDirection| = 1/W` (`|c| ≤ W/2`). As `s` goes
    0 → 1 the full-size threshold `animation.y = 1.25 s − 0.75` goes −0.75 →
    0.5: at `s = 0` nothing is drawn (every `u ≥ −0.5 = animation.z`), at
    `s = 1` everything is full size (`u ≤ 0.5 = animation.y`); in between,
    tiles with `u < animation.y` are full size, those beyond
    `animation.z` are gone, and a band 0.25·W pixels wide grows smoothly.
    Lowest `u` appears first.
  - Ramp direction (CPU): the `ramp` string is matched against
    none/left/right/up/down and mapped to Apple-world vectors
    left (1,0), right (−1,0), up (0,1), down (0,−1); times `d = copysign(1,
    to − from)` of the latest `scale` interpolation (+1 for `scale in`, −1
    for `scale out`, 0 for an immediate `scale out` from 0 at program start
    or after init), divided by `W`. Because Apple's x is mirrored, "right"
    makes `u` grow to the right of the screen: during `scale in` the image is
    wiped on from the left edge towards the right, and with `d = −1` during
    `scale out` the same sign flip makes the tiles vanish from the left
    first, so the wipe travels rightwards both times (up/down likewise travel
    up/down). With ramp None, or `d = 0`, the whole bitmap scales uniformly
    by `s`.
  - Port (`VS_TILE` in `src/renderer.js`): our world is x right / y up seen
    from +z, so `c = (p.x + 1 − scroll.x, scroll.y − p.y − 1)` and
    `uRamp = (dir.x, −dir.y) · d / W` with `dir` in bitmap space
    (`Scene.rampVector`, y down: right (1,0), up (0,−1)); x of both is the
    negation of Apple's, so `c.x · uRamp.x` is identical. `d` is
    `scene.vars.scaleDirection`, set by `Processor.startInterp` for every
    `scale` instruction (immediate ones included), mirroring the Processor
    field at +0x54. The earlier main.js "smoothed scroll speed" was a guess
    and is gone; so are the reconstruction's radial disc, random stagger, the
    shadow's 0.6 minimum size and the `vVis` factor on the shadow alpha
    (Apple's shadowFragment has none). `pixelsRectInt` now truncates like
    Swift's `Int32()`. Zero-size quads are culled outright (same pixels).
  - Consequence for the steady state: with `k = 1` the only change from the
    reconstruction is the half-pixel centring (`scroll − 0.5` instead of
    `scroll`): the camera looks half a bitmap pixel further up-left, so the
    picture sits half a tile further down-right (in the bitmap's frame,
    before the roll) than in the pre-port screenshots.
  - Shadow z: Apple's −0.45 is towards its eye at z = −1000. Our camera
    (eye at +1000, tilt `−b`) sees ours at −0.45 displaced the same way on
    screen, because the x-mirror plus the opposite tilt sign compose to the
    same projection; so `uZ = −0.45` stays.
- Roll sign: the system thumbnail shows the scene rolled counter-clockwise for
  `camera to -22.5, 45`, so the web version rotates by −a about the view axis
  and tilts by −b about the horizontal axis.
- Shadows are drawn first (instanced soft boxes, 2.5× the tile, at z=−0.45 so
  the tilt displaces them), then the tiles; no depth test, like the original's
  three draw calls (background, shadows, tiles).
- Crispness (2026-10-11). The first version looked noticeably softer than the
  real screensaver. Cause: the shadow, which differed from shadowFragment in
  four ways that all smeared a dark halo over the gaps: it was BLACK instead
  of the tile colour, used a box `max(|x|,|y|)` falloff (squared) instead of
  the separable `s.x · s.y` product (so corners and gaps stayed dark), got a
  1.6× boost in dark mode, and was blended in GAMMA space (each fragment did
  `pow(c, 1/2.2)` before blending) while Metal blends in linear light, where a
  37.5 % overlay reads much lighter. The falloff width itself was not the
  problem: Apple's fades over the whole ±1.125 quad. Fixes:
  - FS_TILE's shadow is now shadowFragment verbatim: tile colour, peak alpha
    `uShadowStrength` (default 0.375), `1 − smoothstep(1 − softness, 1, |local|)`
    per axis, multiplied (softness 1 = Apple's `smoothstep(0, 1, t)`), quad
    half-size `1.125 × uShadowSize` (default 1). No dark-mode boost.
  - Linear blending: the three passes draw into a 4× multisampled
    `SRGB8_ALPHA8` renderbuffer (the hardware blends sRGB attachments in
    linear), resolved by a blit and copied 1:1 to the canvas by a present pass
    (`texelFetch` at `gl_FragCoord`, exact sRGB encode, no filtering). Shaders
    output linear colours; the per-fragment `pow(1/2.2)` is gone (it was also
    the wrong curve for darks). The background dither is applied in the
    encoded domain before storing. If the target is incomplete, the passes
    fall back to drawing straight to the canvas with a per-fragment encode
    (`uEncode`). The canvas context now has `antialias: false` (MSAA lives
    in the offscreen target). Apple uses no MSAA at all; we keep 4× because
    rotated tiles alias badly at 1× on non-Retina screens.
  - Canvas size: the DPR cap of 2 and `floor(clientWidth × dpr)` are gone.
    The backing store follows `ResizeObserver` `devicePixelContentBoxSize`
    (exact device pixels, so no resampling under browser zoom or fractional
    DPRs), falling back to `round(rect × devicePixelRatio)` where that box
    is unsupported (Safari). In headless Chromium at DPR 2 the backing
    store was already 2560×1600 for a 1280×800 canvas, so resolution was not
    the visible cause there; it only bit at DPR > 2 or zoomed pages.
  - Verified against the system thumbnail by putting our render through the
    same 214×130 downscale: background tones match exactly (light median
    221 / p95 228, dark 131 / 139), tiles and shadow match in style; Apple's
    darkest 1 % is a little darker (101 vs 116 light), which the
    thumbnail's own 1.5 px-tile rasterisation can explain.
- Live look settings (panel `S`, URL params, persisted in localStorage as
  `mac.<key>`): `shadow` (peak alpha, 0.375), `shadowSize` (× the 1.125
  quad, 1), `shadowSoftness` (falloff width as a fraction of the quad, 1;
  lower = harder edge, the inside stays at full strength), `pixelRatio`
  (`auto` = exact device pixels, or 1 / 2 / 3).
- The 30 Hz fixed simulation step mirrors the original's display link.

## Tooling notes

- REA's Hopper bridge opened the binary but never answered afterwards (the
  bridge timed out at startup each time); everything above came from
  `otool -tV` of the arm64e slice with a small resolver for `__objc_stubs`
  selectors and `adrp`/`ldr` literal pools (`tools/`).
- Swift symbols are stripped; type and field names come from the reflection
  metadata strings.
