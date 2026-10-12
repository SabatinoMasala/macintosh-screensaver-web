// HyperCard (Bill Atkinson, 1987): the Home stack's first card, and the Address
// stack's first card reached with HyperCard's "dissolve" visual effect.
//
// `add dissolve at X, Y size W, H [action "dissolve"|"wipe"] name "<image>"`
// is a hot rectangle (bottom-left anchor, like `button`) that inverts while
// pressed. Releasing the mouse inside it plays a visual effect to the image
// named by `name`: "dissolve" (the default, any other action too) replaces the
// pixels in a pseudo-random but fixed order over 1.2 s, "wipe" reveals the new
// card from the left edge to the right over 2 s. Afterwards the destination
// stays on screen, so the script's base image never has to change.
//
// All dissolve controls of a scene share one "screen" state (which card is
// showing, which effect ran last). The first dissolve control paints it, so
// the press highlights of the others always land on top. A control whose
// destination is already showing, or any control while an effect is still
// running, ignores the mouse: the Address card's Home button may sit over the
// Home card's icons without ever reacting there.

import { Control, inRect } from '../controls.js';

export const program = 'HyperCard';
export const images = { HyperCard: null, HyperCardAddress: null };

const DURATION = { dissolve: 1.2, wipe: 2.0 };
const STATE = Symbol('hypercard');

// per-pixel reveal thresholds in [0, 1): an integer hash of (x, y), fixed for every run
let thresholds = null;
function thresholdsFor(w, h) {
    if (thresholds && thresholds.w === w && thresholds.h === h) return thresholds.t;
    const t = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            let k = Math.imul(x, 374761393) + Math.imul(y, 668265263);
            k = Math.imul(k ^ (k >>> 13), 1274126177);
            k ^= k >>> 16;
            t[y * w + x] = (k >>> 0) / 4294967296;
        }
    thresholds = { w, h, t };
    return t;
}

class DissolveControl extends Control {
    constructor(ins, scene) {
        super(ins, scene);
        this.added = true;
    }
    reset() {
        this.rect = { x: this.x, y: this.y - (this.ins.h ?? 32) + 1, w: this.ins.w ?? 32, h: this.ins.h ?? 32 };
        this.pressed = false;
        // `reset controls` restores the screen too (the constructor's reset must not:
        // a control added later would otherwise undo an effect that already ran)
        if (this.added) this.scene[STATE] = null;
    }
    get screen() {
        // shown: the image the screen shows (or is heading to); effect: the last one started
        return (this.scene[STATE] ??= { shown: null, effect: null });
    }
    get mode() {
        return this.action === 'wipe' ? 'wipe' : 'dissolve';
    }
    progress(effect, t) {
        return Math.min(1, Math.max(0, (t - effect.start) / effect.duration));
    }
    active() {
        const s = this.screen;
        if (s.effect && this.progress(s.effect, this.scene.time ?? 0) < 1) return false;
        return (s.shown ?? this.scene.vars.image) !== this.name;
    }
    mouseDown(x, y) {
        this.pressed = inRect(this.rect, x, y) && this.active();
    }
    mouseUp(x, y) {
        if (this.pressed && inRect(this.rect, x, y) && this.active() && this.sprite(this.name)) {
            const s = this.screen;
            const from = s.shown ?? this.scene.vars.image;
            s.effect = { from, to: this.name, mode: this.mode, start: this.scene.time ?? 0, duration: DURATION[this.mode] };
            s.shown = this.name;
        }
        this.pressed = false;
    }
    paintScreen(bm, t) {
        const e = this.screen.effect;
        if (!e) return;
        const base = this.scene.vars.image;
        const to = this.sprite(e.to);
        if (!to) return;
        const p = this.progress(e, t);
        if (p >= 1) {
            if (e.to !== base) bm.data.set(to.ink);
            return;
        }
        // the card being left, unless it is the base image the bitmap already holds
        const from = e.from !== base ? this.sprite(e.from) : null;
        if (from) bm.data.set(from.ink);
        const d = bm.data, ink = to.ink, w = bm.w, h = bm.h;
        if (e.mode === 'wipe') {
            const edge = Math.round(p * w);
            for (let y = 0; y < h; y++) d.set(ink.subarray(y * w, y * w + edge), y * w);
        } else {
            const th = thresholdsFor(w, h);
            for (let i = 0; i < d.length; i++) if (th[i] < p) d[i] = ink[i];
        }
    }
    draw(bm, t) {
        const first = this.scene.controls.find((c) => c instanceof DissolveControl);
        if (first === this) this.paintScreen(bm, t);
        if (this.pressed) bm.invertRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    }
}

export const controls = { dissolve: DissolveControl };
