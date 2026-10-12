// "Photoshop": Adobe Photoshop 1.0 (1990) on a 1-bit Macintosh, with NASA's Earthrise
// (Apollo 8, AS08-14-2383, public domain) Atkinson-dithered in the document window.
// The crosshair drags a rectangular selection around the Earth, the marching ants crawl,
// and a click in the menu bar applies the blur inside the selection (`let image =
// "PhotoshopBlurred"`, the same screen re-dithered from a box-blurred source inside
// exactly the scripted rectangle 207,66 - 301,142).

import { Control, inRect } from '../controls.js';

export const program = 'Photoshop';
export const images = { Photoshop: null, PhotoshopBlurred: null };

const ANT = 4;          // dash length in pixels (4 inverted, 4 left alone)
const ANT_SPEED = 8;    // pixels per second the dashes crawl clockwise around the rectangle

// --- Marquee: `add marquee at X, Y size W, H` (bottom-left anchored, like canvas /
// cursorrect) is the area in which a mouse drag makes a rectangular selection. Mouse
// down inside it anchors a corner, moving with the button down drags the opposite
// corner (clamped to the area), mouse up fixes it; a click without a drag deselects.
// A mouse down outside the area (the menu bar, the toolbox) leaves the selection alone.
// The selection is drawn as a 1-px marching-ants border: alternating 4-px dashes of the
// perimeter are inverted, the pattern's phase advancing with time.
class MarqueeControl extends Control {
    reset() {
        const w = this.ins.w ?? 100, h = this.ins.h ?? 100;
        this.area = { x: this.x, y: this.y - h + 1, w, h };
        this.anchor = null;   // [x, y] of the corner where the drag started
        this.head = null;     // [x, y] of the dragged corner
        this.dragging = false;
    }
    clampPoint(x, y) {
        const a = this.area;
        return [
            Math.min(a.x + a.w - 1, Math.max(a.x, Math.round(x))),
            Math.min(a.y + a.h - 1, Math.max(a.y, Math.round(y))),
        ];
    }
    mouseDown(x, y) {
        if (!inRect(this.area, x, y)) return;
        this.anchor = this.clampPoint(x, y);
        this.head = this.anchor;
        this.dragging = true;
    }
    mouseMove(x, y, down) {
        if (this.dragging && down) this.head = this.clampPoint(x, y);
    }
    mouseUp(x, y) {
        if (!this.dragging) return;
        this.head = this.clampPoint(x, y);
        this.dragging = false;
        if (this.head[0] === this.anchor[0] && this.head[1] === this.anchor[1]) this.anchor = this.head = null;
    }
    // inclusive selection rectangle, or null
    get selection() {
        if (!this.anchor) return null;
        const [ax, ay] = this.anchor, [hx, hy] = this.head;
        return { x0: Math.min(ax, hx), y0: Math.min(ay, hy), x1: Math.max(ax, hx), y1: Math.max(ay, hy) };
    }
    draw(bm, t) {
        this.drawAnts(bm, t);
        this.drawCrosshairHalo(bm);
    }
    // The system crosshair (CURS 2) has a mask identical to its image, so over the
    // photo's black sky it would vanish. Inside the marquee area we paint the white
    // outline a dilated mask would give; the cursor, drawn after the controls, then
    // puts its 1-px black "+" in the middle of it.
    drawCrosshairHalo(bm) {
        if (this.scene.cursorShape?.() !== 'Crosshair') return;
        const mx = Math.round(this.scene.mouse.x), my = Math.round(this.scene.mouse.y);
        if (!inRect(this.area, mx, my)) return;
        bm.fillRect(mx - 6, my - 1, 13, 3, 0); // the CURS 2 bar spans x-5..x+5 on row y
        bm.fillRect(mx - 1, my - 6, 3, 14, 0); // and y-5..y+6 on column x
    }
    drawAnts(bm, t) {
        const s = this.selection;
        if (!s) return;
        const offset = Math.floor((t ?? 0) * ANT_SPEED);
        let i = 0;
        const ant = (x, y) => {
            if ((((i - offset) % (2 * ANT)) + 2 * ANT) % (2 * ANT) < ANT) bm.set(x, y, bm.get(x, y) ^ 1);
            i++;
        };
        // clockwise from the top-left corner: top, right, bottom, left (each pixel once)
        for (let x = s.x0; x <= s.x1; x++) ant(x, s.y0);
        for (let y = s.y0 + 1; y <= s.y1; y++) ant(s.x1, y);
        if (s.y1 > s.y0) for (let x = s.x1 - 1; x >= s.x0; x--) ant(x, s.y1);
        if (s.x1 > s.x0) for (let y = s.y1 - 1; y > s.y0; y--) ant(s.x0, y);
    }
}

export const controls = { marquee: MarqueeControl };
