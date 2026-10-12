// WebGL2 port of PixelsRenderer: a background gradient, then W*W instanced
// shadow quads, then W*W instanced pixel tiles, all driven by the same
// uniforms the Metal version uses (see NOTES.md).
//
// Colour is handled like the original: every colour is LINEAR (the CAMetalLayer
// is RGBA16Float tagged kCGColorSpaceLinearSRGB) and the shadows are alpha
// blended in linear light. WebGL's default framebuffer is gamma encoded, so the
// three passes draw into a multisampled SRGB8_ALPHA8 renderbuffer (the hardware
// blends sRGB attachments in linear), which is resolved and copied 1:1 to the
// canvas with an exact sRGB encode. If that target is unavailable the passes
// draw straight to the canvas and encode per fragment (blending in gamma).

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
    // our R8 texture stores ink as 1 (Apple: BGRA, ink when red < 0.5)
    float on = 0.0;
    if (p.x >= 0 && p.x < size.x && p.y >= 0 && p.y < size.y) on = texelFetch(uBitmap, p, 0).r > 0.5 ? 1.0 : 0.0;
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

// Copies the resolved linear (sRGB-stored) image to the canvas 1:1.
const FS_PRESENT = `#version 300 es
precision highp float;
uniform highp sampler2D uImage;
out vec4 o;
${SRGB_GLSL}
void main() {
    // texelFetch of an SRGB8_ALPHA8 texture decodes to linear
    o = vec4(toSRGB(texelFetch(uImage, ivec2(gl_FragCoord.xy), 0).rgb), 1.0);
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

// --- minimal mat4 helpers (column-major Float32Array) ---
function mat4Identity() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}
function mat4Mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            o[c * 4 + r] = s;
        }
    return o;
}
function mat4RotZ(deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const m = mat4Identity();
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
}
function mat4RotX(deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const m = mat4Identity();
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
}
function mat4Scale(s) {
    const m = mat4Identity();
    m[0] = m[5] = m[10] = s;
    return m;
}
function mat4Ortho(w, h, near, far) {
    const m = mat4Identity();
    m[0] = 2 / w;
    m[5] = 2 / h;
    m[10] = -2 / (far - near);
    m[14] = -(far + near) / (far - near);
    return m;
}
function transform2(m, x, y, z = 0) {
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13]];
}

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
        // look settings (defaults = the values in Apple's shaders)
        this.shadowStrength = 0.375; // peak alpha of a shadow
        this.shadowSize = 1; // multiplier on the 1.125 half-size of the shadow quad
        this.shadowSoftness = 1; // falloff width, fraction of the quad half-size
        this.pixelRatio = 'auto'; // 'auto' = exact device pixels, or a number
        this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
        this.target = null; // offscreen linear target, created on first render
        this.linear = true; // false once the linear target turned out unsupported
        // exact device-pixel size of the canvas (no rounding guesswork, no DPR cap)
        this.devicePixelSize = null;
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                const e = entries[entries.length - 1];
                const box = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
                this.devicePixelSize = box ? [box.inlineSize, box.blockSize] : null;
            });
            try {
                ro.observe(canvas, { box: 'device-pixel-content-box' });
            } catch {
                ro.observe(canvas);
            }
        }
    }

    // Backing-store size in device pixels for the current pixel-ratio setting.
    backingSize() {
        const gl = this.gl;
        let w, h;
        if (this.pixelRatio === 'auto' && this.devicePixelSize) {
            [w, h] = this.devicePixelSize;
        } else {
            const r = this.pixelRatio === 'auto' ? window.devicePixelRatio || 1 : +this.pixelRatio || 1;
            const rect = this.canvas.getBoundingClientRect();
            w = Math.round(rect.width * r);
            h = Math.round(rect.height * r);
        }
        const [mw, mh] = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        const max = Math.min(mw, mh, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
        return [Math.max(1, Math.min(w, max)), Math.max(1, Math.min(h, max))];
    }

    // Multisampled SRGB8_ALPHA8 renderbuffer + single-sample resolve texture.
    ensureTarget(w, h) {
        const gl = this.gl;
        if (!this.linear) return null;
        const t = this.target;
        if (t && t.w === w && t.h === h) return t;
        if (t) {
            gl.deleteFramebuffer(t.msaaFB);
            gl.deleteRenderbuffer(t.msaaRB);
            gl.deleteFramebuffer(t.resolveFB);
            gl.deleteTexture(t.resolveTex);
        }
        const n = { w, h };
        n.msaaRB = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, n.msaaRB);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.SRGB8_ALPHA8, w, h);
        n.msaaFB = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, n.msaaFB);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, n.msaaRB);
        const ok1 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        n.resolveTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, n.resolveTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.SRGB8_ALPHA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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

    uploadBitmap(bitmap) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        if (this.texW !== bitmap.w || this.texH !== bitmap.h) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, bitmap.w, bitmap.h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
            this.texW = bitmap.w;
            this.texH = bitmap.h;
        }
        // R8 stores 0..255; the shader reads 0 or 1 (normalized). Scale the bytes.
        if (!this.scaled || this.scaled.length !== bitmap.data.length) this.scaled = new Uint8Array(bitmap.data.length);
        const s = this.scaled, d = bitmap.data;
        for (let i = 0; i < d.length; i++) s[i] = d[i] ? 255 : 0;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bitmap.w, bitmap.h, gl.RED, gl.UNSIGNED_BYTE, s);
    }

    // Computes the view-projection matrix and the fit scale for the current viewport.
    camera(state, width, height) {
        const aspect = width / height;
        const W = aspect < 0.5 || aspect > 2 ? 180 : 140;
        const H = W / aspect;
        const [a, b] = state.camera;
        // roll about the view axis, then tilt about the (rolled) horizontal axis
        const rot = mat4Mul(mat4RotZ(-a), mat4RotX(-b));
        const proj = mat4Ortho(W, H, 1, 2001);
        const view = mat4Identity();
        view[14] = -1000; // eye at z = +1000 looking down -z
        const base = mat4Mul(proj, mat4Mul(view, rot));
        // fit: smallest scale so the rotated W x W block covers the viewport
        const ax = transform2(base, 1, 0), ay = transform2(base, 0, 1);
        const det = ax[0] * ay[1] - ax[1] * ay[0];
        let fit = 1;
        for (const [vx, vy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const cx = (vx * ay[1] - vy * ay[0]) / det;
            const cy = (-vx * ax[1] + vy * ax[0]) / det;
            fit = Math.max(fit, Math.max(Math.abs(cx), Math.abs(cy)) / (W / 2));
        }
        fit *= W / (W - 2);
        const scale = fit * (1 + 2 * state.zoom);
        const vp = mat4Mul(base, mat4Scale(scale));
        return { vp, W, H, fit, scale };
    }

    render(state, colors, time) {
        const gl = this.gl;
        const canvas = this.canvas;
        const [w, h] = this.backingSize();
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const target = this.ensureTarget(w, h);
        const encode = target ? 0 : 1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.msaaFB : null);
        gl.viewport(0, 0, w, h);
        const cam = this.camera(state, w, h);
        this.lastCamera = cam;
        const { W } = cam;
        // pixelsRectInt (Swift Int32(scroll) truncates) and the uniforms of -[PixelsRenderer draw]
        const sx = Math.trunc(state.scroll[0]) - W / 2, sy = Math.trunc(state.scroll[1]) - W / 2;
        const s = state.scale;
        const anim = [s, 1.25 * s - 0.75, 1.25 * s - 0.5];
        // rampDirection = ramp unit vector * sign(to - from) of the scale animation / W;
        // state.ramp is in bitmap space (y down), the shader works y up
        const ramp = [(state.ramp[0] * state.scaleDirection) / W, (-state.ramp[1] * state.scaleDirection) / W];

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
        gl.uniform2fv(u.uRamp, ramp);
        gl.uniform3fv(u.uAnim, anim);
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
            // resolve the MSAA samples, then encode to the canvas pixel for pixel
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.msaaFB);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolveFB);
            gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, w, h);
            gl.useProgram(this.present.p);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, target.resolveTex);
            gl.uniform1i(this.present.u.uImage, 1);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.activeTexture(gl.TEXTURE0);
        }
    }
}
