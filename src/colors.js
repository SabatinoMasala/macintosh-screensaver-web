// Colour pipeline of PixelsRenderer (all maths in linear RGB, see NOTES.md).
//
// scene colour  -> user setting (system colours, accent, gray, dark gray,
//                  spectrum = hue cycling once per 60 s, random = new per program)
// factor        -> 0.3 in dark appearance, 1 in light
// background    -> bottom = colour * factor,
//                  top = toLinear(mix(toSRGB(bottom), 1, 0.26 light / 0.09 dark))
// pixel tiles   -> colour * factor * contrast   (0.2 screensaver, 0.666 wallpaper)

// macOS system colours (light / dark appearance), sRGB 0..255.
const SYSTEM = {
    blue: [[0, 122, 255], [10, 132, 255]],
    green: [[40, 205, 65], [50, 215, 75]],
    yellow: [[255, 204, 0], [255, 214, 10]],
    orange: [[255, 149, 0], [255, 159, 10]],
    red: [[255, 59, 48], [255, 69, 58]],
    purple: [[175, 82, 222], [191, 90, 242]],
};

export const COLOR_OPTIONS = ['random', 'spectrum', 'accent', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'gray', 'darkgray'];
export const APPEARANCE_OPTIONS = ['automatic', 'light', 'dark'];

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const lin = (rgb255) => rgb255.map((v) => srgbToLinear(v / 255));

// The six "pure" hues the spectrum setting cycles through (linear RGB), sector i..i+1 blends linearly.
const SPECTRUM = [lin(SYSTEM.red[0]), lin(SYSTEM.orange[0]), lin(SYSTEM.yellow[0]), lin(SYSTEM.green[0]), lin(SYSTEM.blue[0]), lin(SYSTEM.purple[0])];
// the system colours in linear RGB, [light, dark] (computed once instead of per step)
const SYSTEM_LINEAR = Object.fromEntries(Object.entries(SYSTEM).map(([k, v]) => [k, [lin(v[0]), lin(v[1])]]));
const GRAY = [0.7, 0.7, 0.77];
const DARK_GRAY = [0.165, 0.15, 0.15];

export class ColorState {
    constructor({ color = 'random', appearance = 'automatic', contrast = 0.2, accent = null } = {}) {
        this.color = color;
        this.appearance = appearance;
        this.contrast = contrast;
        this.accent = accent; // [r,g,b] 0..255 or null
        this.current = [0.7, 0.7, 0.77];
        this.target = [0.7, 0.7, 0.77];
        this.randomPick = null;
        this.pickRandom();
        this.current = this.target.slice();
        this.out = { bottom: [0, 0, 0], top: [0, 0, 0], pixel: [0, 0, 0], dark: false }; // uniforms(), reused
        // one MediaQueryList for 'automatic', kept current by its change event
        // (onChange lets the player re-render when the system appearance flips)
        this.onChange = null;
        this.systemDark = false;
        const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        if (mq) {
            this.systemDark = mq.matches;
            const listener = (e) => {
                this.systemDark = e.matches;
                this.onChange?.();
            };
            if (mq.addEventListener) mq.addEventListener('change', listener);
            else mq.addListener?.(listener); // Safari < 14
        }
    }

    get isDark() {
        if (this.appearance === 'dark') return true;
        if (this.appearance === 'light') return false;
        return this.systemDark;
    }

    // "Random" picks one of the fixed colours for each new program.
    pickRandom() {
        const pool = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'gray', 'darkgray'];
        let next;
        do next = pool[Math.floor(Math.random() * pool.length)];
        while (next === this.randomPick && pool.length > 1);
        this.randomPick = next;
    }

    // The target colour at time t, written into out (default: a new array).
    resolveTarget(t, out = [0, 0, 0]) {
        const dark = this.isDark;
        const name = this.color === 'random' ? this.randomPick : this.color;
        let src;
        switch (name) {
            case 'spectrum': {
                const u = ((t % 60) + 60) % 60 / 60 * 6;
                const i = Math.floor(u) % 6, f = u - Math.floor(u);
                const a = SPECTRUM[i], b = SPECTRUM[(i + 1) % 6];
                for (let k = 0; k < 3; k++) out[k] = a[k] + (b[k] - a[k]) * f;
                return out;
            }
            case 'accent':
                if (this.accent) {
                    if (this.accentLinear?.src !== this.accent) this.accentLinear = { src: this.accent, rgb: lin(this.accent) };
                    src = this.accentLinear.rgb;
                } else src = SYSTEM_LINEAR.blue[dark ? 1 : 0];
                break;
            case 'gray':
                src = GRAY;
                break;
            case 'darkgray':
                src = DARK_GRAY;
                break;
            default:
                src = (SYSTEM_LINEAR[name] || SYSTEM_LINEAR.blue)[dark ? 1 : 0];
        }
        out[0] = src[0]; out[1] = src[1]; out[2] = src[2];
        return out;
    }

    // Per frame: move the scene colour towards the target (the original blends each frame).
    update(t, dt) {
        this.resolveTarget(t, this.target);
        const k = this.color === 'spectrum' ? 1 : 1 - Math.pow(0.02, dt);
        for (let i = 0; i < 3; i++) this.current[i] += (this.target[i] - this.current[i]) * k;
    }

    // The colour uniforms of the renderer. The returned object is reused by the next call.
    uniforms() {
        const dark = this.isDark;
        const factor = dark ? 0.3 : 1;
        const lighten = dark ? 0.09 : 0.26;
        const { bottom, top, pixel } = this.out;
        for (let i = 0; i < 3; i++) {
            const c = this.current[i] * factor;
            bottom[i] = c;
            top[i] = srgbToLinear(linearToSrgb(c) * (1 - lighten) + lighten);
            pixel[i] = c * this.contrast;
        }
        this.out.dark = dark;
        return this.out;
    }
}
