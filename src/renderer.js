// WebGL2 port of PixelsRenderer: a background gradient, then W*W instanced
// shadow quads, then W*W instanced pixel tiles, all driven by the same
// uniforms the Metal version uses (see NOTES.md).
//
// Colour is handled like the original: every colour is LINEAR (the CAMetalLayer
// is RGBA16Float tagged kCGColorSpaceLinearSRGB) and the shadows are alpha
// blended in linear light. WebGL's default framebuffer is gamma encoded, so the
// three passes draw into a multisampled SRGB8_ALPHA8 renderbuffer (the hardware
// blends sRGB attachments in linear), which is resolved and copied to the
// canvas with an exact sRGB encode. If that target is unavailable the passes
// draw straight to the canvas and encode per fragment (blending in gamma).
//
// Cost control (tools/perf/FINDINGS.md, RESULTS.md): the frame cost follows the
// pixel count, so with pixelRatio 'auto' the offscreen target is capped at
// MAX_INTERNAL_PIXELS and the present pass upscales it to the canvas with linear
// filtering (a tile is 20+ device pixels wide on a Retina screen, so this does
// not show). An explicit pixelRatio renders exactly at that ratio. MSAA is 2x
// once the target has 2 or more device pixels per CSS pixel, 4x below that.

const SRGB_GLSL = `
vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}`;

const VS_BG = `#version 300 es
precision highp float;
const vec2 corners[4] = vec2[4](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(1,1));
out vec2 vUv;
void main() {
    vec2 c = corners[gl_VertexID];
    vUv = c * 0.5 + 0.5;
    gl_Position = vec4(c, 0.0, 1.0);
}`;

// backgroundVertex picks top/bottom per vertex and the rasteriser interpolates
// the linear colour; backgroundFragment returns it as is.
const FS_BG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uTop, uBottom;
uniform int uEncode;       // 1: write gamma-encoded (no linear target)
out vec4 o;
${SRGB_GLSL}
// tiny dither (in the encoded domain) so the gradient does not band
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
    vec3 c = toSRGB(mix(uBottom, uTop, vUv.y));
    c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
    o = vec4(uEncode == 1 ? c : toLinear(clamp(c, 0.0, 1.0)), 1.0);
}`;

// Shared instanced vertex shader for shadows and tiles: a port of Apple's
// pixelVertex (tools/shaders/pixelVertex.ll, derivation in NOTES.md). Apple's
// world has x mirrored (its camera looks from z = -1000 towards +z); ours is
// x right / y up seen from +z, so x and the ramp's x are negated together and
// every product below is identical to the original.
//   p     = pixelsRect.xy + (instance % W, instance / W)
//   on    = p inside the bitmap && texel(p) is ink
//   world = scroll - p - 1                         (Apple frame; here (p.x + 1 - scroll.x, scroll.y - p.y - 1))
//   k     = ramp.x != 0 ? 1 - smoothstep((world.x * ramp.x - anim.y) / (anim.z - anim.y))
//         : ramp.y != 0 ? 1 - smoothstep((world.y * ramp.y - anim.y) / (anim.z - anim.y))
//         : anim.x
//   pos   = (world, 0) + k * on * quadVertex       (quad: +-0.45 z 0 tiles, +-1.125 z -0.45 shadows)
const VS_TILE = `#version 300 es
precision highp float;
precision highp int;
uniform mat4 uVP;
uniform sampler2D uBitmap;
uniform ivec4 uRect;      // pixelsRectInt: int(scroll) - W/2, int(scroll) - W/2, W, W
uniform vec2 uScroll;     // camera target in bitmap pixels (translate + bitmapSize.zw)
uniform vec2 uRamp;       // rampDirection (ramp unit vector * sign of the running scale animation / W), x right / y up
uniform vec3 uAnim;       // animation: (scale, 1.25 scale - 0.75, 1.25 scale - 0.5)
uniform float uHalf;      // half size of the quad (0.45 tile, 1.125 x shadow size for the shadow)
uniform float uZ;         // z of the quad (0 tile, -0.45 shadow)
const vec2 corners[4] = vec2[4](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(1,1));
out vec2 vLocal;
void main() {
    int W = uRect.z;
    ivec2 p = ivec2(uRect.x + gl_InstanceID % W, uRect.y + gl_InstanceID / W);
    ivec2 size = textureSize(uBitmap, 0);
    // our R8 texture holds the bitmap bytes as they are: 0 = white, nonzero = ink
    // (1/255 once normalized; Apple: BGRA, ink when red < 0.5)
    float on = 0.0;
    if (p.x >= 0 && p.x < size.x && p.y >= 0 && p.y < size.y) on = texelFetch(uBitmap, p, 0).r > 0.0 ? 1.0 : 0.0;
    // Apple: translate + bitmapSize.zw - (p + 0.5) - 0.5 = scroll - p - 1 (x mirrored here)
    vec2 world = vec2(float(p.x) + 1.0 - uScroll.x, uScroll.y - float(p.y) - 1.0);
    float k;
    if (uRamp.x != 0.0) {
        float t = clamp((world.x * uRamp.x - uAnim.y) / (uAnim.z - uAnim.y), 0.0, 1.0);
        k = 1.0 - t * t * (3.0 - 2.0 * t);
    } else if (uRamp.y != 0.0) {
        float t = clamp((world.y * uRamp.y - uAnim.y) / (uAnim.z - uAnim.y), 0.0, 1.0);
        k = 1.0 - t * t * (3.0 - 2.0 * t);
    } else {
        k = uAnim.x;
    }
    float g = k * on;
    vLocal = corners[gl_VertexID];
    if (g == 0.0) {
        // Apple emits a zero-area quad; skip it outright
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }
    vec3 pos = vec3(world, 0.0) + g * vec3(vLocal * uHalf, uZ);
    gl_Position = uVP * vec4(pos, 1.0);
}`;

// pixelFragment returns uniforms.color, flat. shadowFragment (disassembled):
//   t = clamp(|modelPosition.xy| / 1.125, 0, 1); s = 1 - smoothstep(t)  (per axis)
//   return float4(color.rgb, 0.375 * s.x * s.y)
// i.e. the shadow is the TILE colour, a separable soft box over the whole
// +-1.125 quad. vLocal is modelPosition / half-size, so with size 1 and
// softness 1 this is exactly Apple's; softness < 1 keeps the inner part solid
// and fades over the outer (softness) fraction of the quad only.
const FS_TILE = `#version 300 es
precision highp float;
precision highp int;
in vec2 vLocal;
uniform vec3 uColor;          // linear
uniform int uShadow;
uniform int uEncode;
uniform float uShadowStrength; // peak alpha (Apple: 0.375)
uniform float uShadowSoftness; // falloff width as a fraction of the quad half-size (Apple: 1)
out vec4 o;
${SRGB_GLSL}
void main() {
    vec3 c = uEncode == 1 ? toSRGB(uColor) : uColor;
    if (uShadow == 1) {
        vec2 t = clamp(abs(vLocal), 0.0, 1.0);
        vec2 s = 1.0 - smoothstep(vec2(1.0 - uShadowSoftness), vec2(1.0), t);
        o = vec4(c, uShadowStrength * s.x * s.y);
    } else {
        o = vec4(c, 1.0);
    }
}`;

// Copies the resolved linear (sRGB-stored) image to the canvas: 1:1 when the
// target has the canvas size, else upscaled with linear filtering (an
// SRGB8_ALPHA8 texture is decoded to linear before it is filtered).
const FS_PRESENT = `#version 300 es
precision highp float;
uniform highp sampler2D uImage;
uniform int uScaled;
uniform vec2 uInvSize;    // 1 / canvas size
out vec4 o;
${SRGB_GLSL}
void main() {
    vec3 c = uScaled == 1 ? texture(uImage, gl_FragCoord.xy * uInvSize).rgb
                          : texelFetch(uImage, ivec2(gl_FragCoord.xy), 0).rgb;
    o = vec4(toSRGB(c), 1.0);
}`;

function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
    return s;
}
function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        uniforms[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u: uniforms };
}

// --- minimal mat4 helpers (column-major Float32Array, written into `out`, no allocation) ---
function mat4Identity(m) {
    m.fill(0);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}
// out must be neither a nor b
function mat4Mul(out, a, b) {
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            out[c * 4 + r] = s;
        }
    return out;
}
function mat4RotZ(m, deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    mat4Identity(m);
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
}
function mat4RotX(m, deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    mat4Identity(m);
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
}
function mat4Scale(m, s) {
    mat4Identity(m);
    m[0] = m[5] = m[10] = s;
    return m;
}
function mat4Ortho(m, w, h, near, far) {
    mat4Identity(m);
    m[0] = 2 / w;
    m[5] = 2 / h;
    m[10] = -2 / (far - near);
    m[14] = -(far + near) / (far - near);
    return m;
}
const mat4 = () => new Float32Array(16);
// scratch matrices of camera()
const RZ = mat4(), RX = mat4(), ROT = mat4(), PROJ = mat4(), VIEW = mat4(), VIEWROT = mat4(), SCALE = mat4();

// With pixelRatio 'auto' the offscreen target is scaled down to at most this many
// pixels (the canvas keeps its exact device-pixel size; the present pass upscales).
export const MAX_INTERNAL_PIXELS = 4_000_000;

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        // no default-framebuffer MSAA: antialiasing happens in the offscreen target
        const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false });
        if (!gl) throw new Error('WebGL2 is required');
        this.gl = gl;
        this.bg = program(gl, VS_BG, FS_BG);
        this.tile = program(gl, VS_TILE, FS_TILE);
        this.present = program(gl, VS_BG, FS_PRESENT);
        this.vao = gl.createVertexArray();
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.texW = 0;
        this.texH = 0;
        this.uploaded = null; // copy of the bytes last uploaded (uploadBitmap skips identical frames)
        // look settings (defaults = the values in Apple's shaders)
        this.shadowStrength = 0.375; // peak alpha of a shadow
        this.shadowSize = 1; // multiplier on the 1.125 half-size of the shadow quad
        this.shadowSoftness = 1; // falloff width, fraction of the quad half-size
        this.pixelRatio = 'auto'; // 'auto' = device pixels, target capped at maxPixels; or an exact number
        this.maxPixels = MAX_INTERNAL_PIXELS;
        this.msaa = 'auto'; // 'auto' = 2x at >= 2 device px per CSS px, 4x below; or an exact sample count
        // GL limits, read once
        this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
        const [mw, mh] = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        this.maxSize = Math.min(mw, mh, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
        this.samples = 0; // sample count of the current target
        this.target = null; // offscreen linear target, created on first render
        this.linear = true; // false once the linear target turned out unsupported
        this.cam = { vp: mat4(), base: mat4(), W: 0, H: 0, fit: 1, scale: 1 };
        this.size = [0, 0, 0, 0]; // canvas w, h, target w, h (backingSize() result, reused)
        this.onResize = null; // called after the canvas changed size (main.js re-renders)
        // exact device-pixel size and CSS size of the canvas, from the ResizeObserver
        this.devicePixelSize = null;
        const r = canvas.getBoundingClientRect();
        this.cssSize = [r.width, r.height];
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                const e = entries[entries.length - 1];
                const box = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
                this.devicePixelSize = box ? [box.inlineSize, box.blockSize] : null;
                const css = e.contentBoxSize && e.contentBoxSize[0];
                this.cssSize = css ? [css.inlineSize, css.blockSize] : [e.contentRect.width, e.contentRect.height];
                this.onResize?.();
            });
            try {
                ro.observe(canvas, { box: 'device-pixel-content-box' });
            } catch {
                ro.observe(canvas);
            }
        }
    }

    // Canvas size in device pixels for the current pixel-ratio setting, and the size of
    // the offscreen target (the same, unless 'auto' had to cap it). Returns this.size.
    backingSize() {
        let w, h, explicit = this.pixelRatio !== 'auto';
        if (!explicit && this.devicePixelSize) {
            [w, h] = this.devicePixelSize;
        } else {
            const r = explicit ? +this.pixelRatio || 1 : window.devicePixelRatio || 1;
            w = Math.round(this.cssSize[0] * r);
            h = Math.round(this.cssSize[1] * r);
        }
        const max = this.maxSize;
        w = Math.max(1, Math.min(w, max));
        h = Math.max(1, Math.min(h, max));
        let tw = w, th = h;
        if (!explicit && w * h > this.maxPixels) {
            const f = Math.sqrt(this.maxPixels / (w * h));
            tw = Math.max(1, Math.round(w * f));
            th = Math.max(1, Math.round(h * f));
        }
        const s = this.size;
        s[0] = w; s[1] = h; s[2] = tw; s[3] = th;
        return s;
    }

    // MSAA sample count for a target of tw device pixels across.
    sampleCount(tw) {
        let n;
        if (this.msaa !== 'auto') n = +this.msaa || 0;
        else {
            const ratio = this.cssSize[0] > 0 ? tw / this.cssSize[0] : window.devicePixelRatio || 1;
            n = ratio >= 2 ? 2 : 4;
        }
        return Math.min(n, this.maxSamples);
    }

    // Multisampled (or plain, with 0 samples) SRGB8_ALPHA8 renderbuffer + single-sample resolve texture.
    ensureTarget(w, h, samples) {
        const gl = this.gl;
        if (!this.linear) return null;
        const t = this.target;
        if (t && t.w === w && t.h === h && t.samples === samples) return t;
        if (t) {
            gl.deleteFramebuffer(t.msaaFB);
            gl.deleteRenderbuffer(t.msaaRB);
            gl.deleteFramebuffer(t.resolveFB);
            gl.deleteTexture(t.resolveTex);
        }
        const n = { w, h, samples, filter: gl.NEAREST };
        n.msaaRB = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, n.msaaRB);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.SRGB8_ALPHA8, w, h);
        n.msaaFB = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, n.msaaFB);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, n.msaaRB);
        const ok1 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        n.resolveTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, n.resolveTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.SRGB8_ALPHA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        n.resolveFB = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, n.resolveFB);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, n.resolveTex, 0);
        const ok2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!ok1 || !ok2) {
            console.warn('linear render target unavailable, blending in gamma space');
            this.linear = false;
            this.target = null;
            return null;
        }
        this.target = n;
        return n;
    }

    // Uploads the scene bitmap unless it equals the last upload. Returns whether it uploaded.
    uploadBitmap(bitmap) {
        const gl = this.gl;
        const d = bitmap.data;
        let prev = this.uploaded;
        if (prev && this.texW === bitmap.w && this.texH === bitmap.h && prev.bytes.length === d.length) {
            // compare 4 bytes at a time when the buffer allows it (175 KB: some 20-40 us)
            let same = true;
            if (d.byteOffset % 4 === 0 && d.length % 4 === 0) {
                if (this.wordsOf !== d) {
                    this.wordsOf = d;
                    this.words = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
                }
                const a = this.words, b = prev.words;
                for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) { same = false; break; }
            } else {
                const b = prev.bytes;
                for (let i = 0; i < d.length; i++) if (d[i] !== b[i]) { same = false; break; }
            }
            if (same) return false;
        }
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        if (this.texW !== bitmap.w || this.texH !== bitmap.h) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, bitmap.w, bitmap.h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
            this.texW = bitmap.w;
            this.texH = bitmap.h;
        }
        // the bytes go up as they are (0 / 1); the shader tests for nonzero
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bitmap.w, bitmap.h, gl.RED, gl.UNSIGNED_BYTE, d);
        if (!prev || prev.bytes.length !== d.length) {
            const words = new Uint32Array((d.length + 3) >> 2);
            prev = this.uploaded = { words, bytes: new Uint8Array(words.buffer, 0, d.length) };
        }
        prev.bytes.set(d);
        return true;
    }

    // Computes the view-projection matrix and the fit scale for the current viewport
    // into this.cam (reused; the caller must not keep it across frames).
    camera(state, width, height) {
        const aspect = width / height;
        const W = aspect < 0.5 || aspect > 2 ? 180 : 140;
        const H = W / aspect;
        const a = state.camera[0], b = state.camera[1];
        const cam = this.cam;
        // roll about the view axis, then tilt about the (rolled) horizontal axis
        mat4Mul(ROT, mat4RotZ(RZ, -a), mat4RotX(RX, -b));
        mat4Ortho(PROJ, W, H, 1, 2001);
        mat4Identity(VIEW);
        VIEW[14] = -1000; // eye at z = +1000 looking down -z
        const base = mat4Mul(cam.base, PROJ, mat4Mul(VIEWROT, VIEW, ROT));
        // fit: smallest scale so the rotated W x W block covers the viewport
        const ax0 = base[0] + base[12], ax1 = base[1] + base[13]; // base * (1, 0, 0, 1)
        const ay0 = base[4] + base[12], ay1 = base[5] + base[13]; // base * (0, 1, 0, 1)
        const det = ax0 * ay1 - ax1 * ay0;
        let fit = 1;
        for (let i = 0; i < 4; i++) {
            const vx = i & 1 ? 1 : -1, vy = i & 2 ? 1 : -1;
            const cx = (vx * ay1 - vy * ay0) / det;
            const cy = (-vx * ax1 + vy * ax0) / det;
            fit = Math.max(fit, Math.max(Math.abs(cx), Math.abs(cy)) / (W / 2));
        }
        fit *= W / (W - 2);
        const scale = fit * (1 + 2 * state.zoom);
        mat4Mul(cam.vp, base, mat4Scale(SCALE, scale));
        cam.W = W;
        cam.H = H;
        cam.fit = fit;
        cam.scale = scale;
        return cam;
    }

    render(state, colors, time) {
        const gl = this.gl;
        const canvas = this.canvas;
        const size = this.backingSize();
        const w = size[0], h = size[1];
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const target = this.ensureTarget(size[2], size[3], this.sampleCount(size[2]));
        this.samples = target ? target.samples : 0;
        // the passes draw at the target size; without a target, straight to the canvas
        const rw = target ? target.w : w, rh = target ? target.h : h;
        const encode = target ? 0 : 1;
        // with 0 samples the "msaa" renderbuffer is single-sampled: render into it all the same
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.msaaFB : null);
        gl.viewport(0, 0, rw, rh);
        const cam = this.camera(state, rw, rh);
        this.lastCamera = cam;
        const W = cam.W;
        // pixelsRectInt (Swift Int32(scroll) truncates) and the uniforms of -[PixelsRenderer draw]
        const sx = Math.trunc(state.scroll[0]) - W / 2, sy = Math.trunc(state.scroll[1]) - W / 2;
        const s = state.scale;
        // rampDirection = ramp unit vector * sign(to - from) of the scale animation / W;
        // state.ramp is in bitmap space (y down), the shader works y up

        gl.disable(gl.DEPTH_TEST);
        gl.bindVertexArray(this.vao);

        // background
        gl.disable(gl.BLEND);
        gl.useProgram(this.bg.p);
        gl.uniform3fv(this.bg.u.uTop, colors.top);
        gl.uniform3fv(this.bg.u.uBottom, colors.bottom);
        gl.uniform1i(this.bg.u.uEncode, encode);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // tiles + shadows
        gl.useProgram(this.tile.p);
        const u = this.tile.u;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(u.uBitmap, 0);
        gl.uniformMatrix4fv(u.uVP, false, cam.vp);
        gl.uniform4i(u.uRect, sx, sy, W, W);
        gl.uniform2f(u.uScroll, state.scroll[0], state.scroll[1]);
        gl.uniform2f(u.uRamp, (state.ramp[0] * state.scaleDirection) / W, (-state.ramp[1] * state.scaleDirection) / W);
        gl.uniform3f(u.uAnim, s, 1.25 * s - 0.75, 1.25 * s - 0.5);
        gl.uniform3fv(u.uColor, colors.pixel);
        gl.uniform1i(u.uEncode, encode);
        gl.uniform1f(u.uShadowStrength, this.shadowStrength);
        gl.uniform1f(u.uShadowSoftness, Math.min(1, Math.max(0.02, this.shadowSoftness)));

        // Metal: sourceRGB = sourceAlpha, destinationRGB = oneMinusSourceAlpha
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1i(u.uShadow, 1);
        gl.uniform1f(u.uHalf, 1.125 * this.shadowSize);
        gl.uniform1f(u.uZ, -0.45);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, W * W);

        gl.disable(gl.BLEND);
        gl.uniform1i(u.uShadow, 0);
        gl.uniform1f(u.uHalf, 0.45);
        gl.uniform1f(u.uZ, 0);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, W * W);

        if (target) {
            // resolve the samples, drop them (the next frame redraws every pixel, so a tiled
            // GPU need neither store nor reload them), then encode to the canvas
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.msaaFB);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolveFB);
            gl.blitFramebuffer(0, 0, rw, rh, 0, 0, rw, rh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
            gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, INVALIDATE_COLOR);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, w, h);
            gl.useProgram(this.present.p);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, target.resolveTex);
            const scaled = rw !== w || rh !== h;
            const filter = scaled ? gl.LINEAR : gl.NEAREST;
            if (target.filter !== filter) {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
                target.filter = filter;
            }
            gl.uniform1i(this.present.u.uImage, 1);
            gl.uniform1i(this.present.u.uScaled, scaled ? 1 : 0);
            gl.uniform2f(this.present.u.uInvSize, 1 / w, 1 / h);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.activeTexture(gl.TEXTURE0);
        }
    }
}

const INVALIDATE_COLOR = [0x8ce0]; // COLOR_ATTACHMENT0
