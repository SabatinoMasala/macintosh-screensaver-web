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
    }

    get isDark() {
        if (this.appearance === 'dark') return true;
        if (this.appearance === 'light') return false;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // "Random" picks one of the fixed colours for each new program.
    pickRandom() {
        const pool = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'gray', 'darkgray'];
        let next;
        do next = pool[Math.floor(Math.random() * pool.length)];
        while (next === this.randomPick && pool.length > 1);
        this.randomPick = next;
    }

    resolveTarget(t) {
        const dark = this.isDark;
        const name = this.color === 'random' ? this.randomPick : this.color;
        switch (name) {
            case 'spectrum': {
                const u = ((t % 60) + 60) % 60 / 60 * 6;
                const i = Math.floor(u) % 6, f = u - Math.floor(u);
                const a = SPECTRUM[i], b = SPECTRUM[(i + 1) % 6];
                return [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * f);
            }
            case 'accent':
                return lin(this.accent || SYSTEM.blue[dark ? 1 : 0]);
            case 'gray':
                return [0.7, 0.7, 0.77];
            case 'darkgray':
                return [0.165, 0.15, 0.15];
            default:
                return lin((SYSTEM[name] || SYSTEM.blue)[dark ? 1 : 0]);
        }
    }

    // Per frame: move the scene colour towards the target (the original blends each frame).
    update(t, dt) {
        this.target = this.resolveTarget(t);
        const k = this.color === 'spectrum' ? 1 : 1 - Math.pow(0.02, dt);
        for (let i = 0; i < 3; i++) this.current[i] += (this.target[i] - this.current[i]) * k;
    }

    uniforms() {
        const dark = this.isDark;
        const factor = dark ? 0.3 : 1;
        const bottom = this.current.map((c) => c * factor);
        const lighten = dark ? 0.09 : 0.26;
        const top = bottom.map((c) => srgbToLinear(linearToSrgb(c) * (1 - lighten) + lighten));
        const pixel = bottom.map((c) => c * this.contrast);
        return { bottom, top, pixel, dark };
    }
}
