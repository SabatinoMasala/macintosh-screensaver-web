// Klondike, won: the bouncing-cards cascade of Windows Solitaire, in 1-bit, in the
// Klondike window. Added scene (not part of Apple's set).
//
//   add solitairewin at X, Y [value N]
//
// Same anchor as `add solitaire` (the bottom-left corner of the stock slot) and the
// same SolitaireCards strip (32x44 frames: suit * 13 + rank - 1, suits spades,
// hearts, clubs, diamonds). It draws a finished game: the four foundations complete
// (a king on top of each), stock, waste and columns empty (the base image shows
// their outlined slots).
//
// The cascade starts on `keyboard "w"`, or by itself `value` seconds after the
// control was added / reset. Cards leave the foundations one at a time, kings first
// (KS KH KC KD, then the queens, ...). Each is launched with a horizontal speed from
// a fixed table (direction alternating per foundation) and a small upward kick,
// falls under gravity and bounces off the bottom of the window losing a fifth of its
// speed. The next card goes 0.25 s after the previous one has left the window
// horizontally, or at the latest MAX_GAP after its launch, so long flights overlap.
//
// Layering, as in the original, which stamps every flying card onto the screen at
// every step: the window interior is ONE persistent table layer. It starts as the
// finished game (the four kings over the base image's slots). On every simulation
// tick each card in flight is stamped into it, oldest launch first, so the newest
// copy ends on top, over whatever is there: other trails, the empty slots and the
// foundation piles alike (overlapping copies make the solid stripes). When a card
// is launched, its pile is redrawn into the layer at that moment (the next card, or
// the base image's empty slot after the ace), so a pile only stays visible until
// the next trail crosses it. draw() shows the layer, then the cards in flight
// (newest last), so a moving card is always above its own trail. Only opaque sprite
// pixels are copied (the rounded corners keep what is underneath), and everything
// is clipped to the window interior: the title bar and frame are never covered.
// The simulation runs in fixed ticks from the start time, so it is deterministic.

import { Control } from '../controls.js';

export const program = 'SolitaireWin';
export const images = { Solitaire: null, SolitaireCards: 32 };

const CW = 32, CH = 44;
const PITCH = 38; // slot pitch, as in Solitaire.js
// window interior relative to the anchor (Solitaire.png: x 116..395, y 55..297 for 126, 106)
const IN_DX = -10, IN_DY = -51, IN_W = 280, IN_H = 243;

const TICK = 1 / 30; // simulation step; one stamp per card per tick
const GRAVITY = 400; // px / s^2
const RESTITUTION = 0.8;
const PAUSE = 0.25; // after a card leaves, the next one goes
const MAX_GAP = 1.1; // ... but never later than this after the previous launch

// Fixed launch tables (px / s). Horizontal speeds are magnitudes; the direction
// alternates per foundation (see launchVelocity). Vertical kicks are upward.
const VX = [118, 64, 152, 100, 170, 48, 134, 108, 186, 80, 160, 124, 144];
const VY = [-40, -150, -15, -95, -60, -5, -120];

const cardFrame = (suit, rank) => suit * 13 + rank - 1;

function launchVelocity(i) {
    // i = 0.. in launch order; foundation i % 4 alternates left / right on each visit
    const dir = (i + Math.floor(i / 4)) % 2 ? 1 : -1;
    return { vx: dir * VX[i % VX.length], vy: VY[i % VY.length] };
}

class SolitaireWinControl extends Control {
    reset() {
        this.left = this.x;
        this.top = this.y - CH + 1;
        this.area = { x: this.x + IN_DX, y: this.y + IN_DY, w: IN_W, h: IN_H };
        this.floorY = this.area.y + this.area.h - CH; // card top when its bottom row is the last interior row
        // the table: 0 = the base image shows, 1 = white, 2 = black
        this.table = new Uint8Array(IN_W * IN_H);
        this.dealt = false; // the kings go in once the card strip is loaded
        this.counts = [13, 13, 13, 13]; // cards left on each foundation
        this.flying = [];
        this.launched = 0;
        this.started = false;
        this.bornAt = null;
        this.startAt = 0;
        this.ticks = 0;
        this.nextLaunch = 0;
    }

    foundationX(f) {
        return this.left + PITCH * (3 + f);
    }

    typeCharacter(ch) {
        if (ch === 'w' || ch === 'W') this.start(this.scene.time ?? 0);
    }
    start(t) {
        if (this.started) return;
        this.started = true;
        this.startAt = t;
        this.ticks = 0;
        this.nextLaunch = 0; // seconds after startAt
    }

    update(t) {
        if (this.bornAt == null) this.bornAt = t;
        if (!this.started && this.value != null && t - this.bornAt >= this.value) this.start(t);
        if (!this.started) return;
        while (this.startAt + (this.ticks + 1) * TICK <= t + 1e-9) this.tick(++this.ticks * TICK);
    }

    // the finished game: every foundation's top card into the table
    deal(sheet) {
        if (this.dealt || !sheet) return;
        this.dealt = true;
        for (let f = 0; f < 4; f++) this.drawPile(sheet, f);
    }

    // a foundation as it is now: its top card, or (after the ace) the base image's empty slot
    drawPile(sheet, f) {
        const x = this.foundationX(f);
        if (this.counts[f]) return this.stamp(sheet, cardFrame(f, this.counts[f]), x, this.top);
        const a = this.area;
        for (let y = this.top; y < this.top + CH; y++) {
            if (y < a.y || y >= a.y + a.h) continue;
            for (let xx = x; xx < x + CW; xx++) if (xx >= a.x && xx < a.x + a.w) this.table[(y - a.y) * a.w + xx - a.x] = 0;
        }
    }

    // one simulation step at `s` seconds after the start
    tick(s) {
        const sheet = this.sprite('SolitaireCards');
        this.deal(sheet);
        if (this.launched < 52 && s >= this.nextLaunch - 1e-9) this.launch(s, sheet);
        // launch order, oldest first: the newest card's copy ends on top
        for (const c of this.flying) {
            if (c.born === s) continue; // still where it left the foundation
            c.vy += GRAVITY * TICK;
            c.x += c.vx * TICK;
            c.y += c.vy * TICK;
            if (c.y > this.floorY) {
                c.y = this.floorY - (c.y - this.floorY) * RESTITUTION;
                c.vy = -c.vy * RESTITUTION;
            }
            const x = Math.round(c.x);
            if (x + CW <= this.area.x || x >= this.area.x + this.area.w) {
                c.gone = true;
                if (c.index === this.launched - 1) this.nextLaunch = Math.min(this.nextLaunch, s + PAUSE);
                continue;
            }
            this.stamp(sheet, c.frame, x, Math.round(c.y));
        }
        this.flying = this.flying.filter((c) => !c.gone);
    }

    launch(s, sheet) {
        const i = this.launched++;
        const f = i % 4;
        const rank = this.counts[f]--;
        const { vx, vy } = launchVelocity(i);
        this.flying.push({ index: i, frame: cardFrame(f, rank), x: this.foundationX(f), y: this.top, vx, vy, born: s });
        this.drawPile(sheet, f); // the next card shows (the leaving one is drawn above it)
        this.nextLaunch = s + MAX_GAP;
    }

    // a card into the table, opaque pixels only, clipped to the window interior
    stamp(sheet, frame, x, y) {
        if (!sheet) return;
        const a = this.area, fw = sheet.frameW, sx0 = frame * fw;
        for (let yy = 0; yy < sheet.h; yy++) {
            const ty = y + yy - a.y;
            if (ty < 0 || ty >= a.h) continue;
            const srow = yy * sheet.w + sx0, trow = ty * a.w;
            for (let xx = 0; xx < fw; xx++) {
                const tx = x + xx - a.x;
                if (tx < 0 || tx >= a.w || !sheet.alpha[srow + xx]) continue;
                this.table[trow + tx] = sheet.ink[srow + xx] ? 2 : 1;
            }
        }
    }

    // a card straight into the bitmap, opaque pixels only, clipped to the interior
    blitClipped(bm, sheet, frame, x, y) {
        const a = this.area, fw = sheet.frameW, sx0 = frame * fw;
        const y0 = Math.max(y, a.y), y1 = Math.min(y + sheet.h, a.y + a.h);
        const x0 = Math.max(x, a.x), x1 = Math.min(x + fw, a.x + a.w);
        for (let by = y0; by < y1; by++) {
            const srow = (by - y) * sheet.w + sx0 - x, row = by * bm.w;
            for (let bx = x0; bx < x1; bx++) if (sheet.alpha[srow + bx]) bm.data[row + bx] = sheet.ink[srow + bx];
        }
    }

    draw(bm) {
        const sheet = this.sprite('SolitaireCards');
        if (!sheet) return;
        this.deal(sheet);
        // the table (the window interior), over the base image
        const a = this.area, tb = this.table;
        for (let ty = 0; ty < a.h; ty++) {
            const row = (a.y + ty) * bm.w + a.x, trow = ty * a.w;
            for (let tx = 0; tx < a.w; tx++) {
                const v = tb[trow + tx];
                if (v) bm.data[row + tx] = v - 1;
            }
        }
        // the cards in flight, newest last: always the topmost thing
        for (const c of this.flying) this.blitClipped(bm, sheet, c.frame, Math.round(c.x), Math.round(c.y));
    }
}

export const controls = { solitairewin: SolitaireWinControl };
