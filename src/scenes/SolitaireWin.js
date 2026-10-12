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
// falls under gravity, bounces off the bottom of the window losing a fifth of its
// speed, and stamps a copy of itself into a persistent trail layer on every
// simulation tick: overlapping copies make the solid stripes of the original. The
// next card goes 0.25 s after the previous one has left the window horizontally,
// or at the latest MAX_GAP after its launch, so long flights overlap.
// The simulation runs in fixed ticks from the start time, so it is deterministic;
// everything is clipped to the window interior.

import { Control, inRect } from '../controls.js';

export const program = 'SolitaireWin';
export const images = { Solitaire: null, SolitaireCards: 32 };

const CW = 32, CH = 44;
const PITCH = 38; // slot pitch, as in Solitaire.js
// window interior relative to the anchor (Solitaire.png: x 116..395, y 55..297 for 126, 106)
const IN_DX = -10, IN_DY = -51, IN_W = 280, IN_H = 243;

const TICK = 1 / 30; // simulation step; one trail copy per card per tick
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
        this.trail = new Uint8Array(IN_W * IN_H); // 0 = nothing, 1 = white, 2 = black
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

    // one simulation step at `s` seconds after the start
    tick(s) {
        const sheet = this.sprite('SolitaireCards');
        if (this.launched < 52 && s >= this.nextLaunch - 1e-9) this.launch(s, sheet);
        for (const c of this.flying) {
            if (c.born === s) continue; // stamped where it left the foundation
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
        const c = { index: i, frame: cardFrame(f, rank), x: this.foundationX(f), y: this.top, vx, vy, born: s };
        this.flying.push(c);
        this.stamp(sheet, c.frame, c.x, c.y);
        this.nextLaunch = s + MAX_GAP;
    }

    // copy a card into the trail layer, clipped to the window interior
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
                this.trail[trow + tx] = sheet.ink[srow + xx] ? 2 : 1;
            }
        }
    }

    // a card drawn straight into the bitmap, clipped to the interior
    blitClipped(bm, sheet, frame, x, y) {
        const a = this.area, fw = sheet.frameW, sx0 = frame * fw;
        for (let yy = 0; yy < sheet.h; yy++) {
            const by = y + yy;
            if (by < a.y || by >= a.y + a.h) continue;
            const srow = yy * sheet.w + sx0;
            for (let xx = 0; xx < fw; xx++) {
                const bx = x + xx;
                if (!inRect(a, bx, by) || !sheet.alpha[srow + xx]) continue;
                bm.data[by * bm.w + bx] = sheet.ink[srow + xx];
            }
        }
    }

    draw(bm) {
        const sheet = this.sprite('SolitaireCards');
        if (!sheet) return;
        const a = this.area, tr = this.trail;
        // the trails, under everything this control draws
        if (this.launched) {
            for (let ty = 0; ty < a.h; ty++) {
                const row = (a.y + ty) * bm.w + a.x, trow = ty * a.w;
                for (let tx = 0; tx < a.w; tx++) {
                    const v = tr[trow + tx];
                    if (v) bm.data[row + tx] = v - 1;
                }
            }
        }
        // what is left on the foundations
        for (let f = 0; f < 4; f++) if (this.counts[f]) bm.blit(sheet, this.foundationX(f), this.top, cardFrame(f, this.counts[f]));
        // the cards in flight, on top
        for (const c of this.flying) this.blitClipped(bm, sheet, c.frame, Math.round(c.x), Math.round(c.y));
    }
}

export const controls = { solitairewin: SolitaireWinControl };
