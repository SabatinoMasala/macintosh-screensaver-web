// Daleks (Johan Strandberg, 1984): the Doctor on an 18x12 grid, Daleks that step one
// cell towards him every turn, scrap heaps where they collide.
//
//   add daleks at X, Y      bottom-left corner of the grid (Daleks.png: 112, 246)
//
// Keys (typeCharacter): '1'-'9' move like a numeric keypad (5 = stay), 't' teleports
// to the level's first safe teleport cell, 's' fires the sonic screwdriver (once per
// level) at the eight neighbouring cells. A mouse click in the grid steps towards it.
// After every Doctor turn each Dalek steps towards him (diagonals allowed); two Daleks
// on one cell become a scrap heap, a Dalek running into a heap is scrapped too, a
// Dalek reaching the Doctor ends the game. 10 points per Dalek. Clearing the board
// loads the next level after a short pause. Score / Level values are drawn under the
// grid in Chicago 12; the labels are in the base image.

import { Control, inRect } from '../controls.js';

export const program = 'Daleks';
export const images = { Daleks: null, DaleksSprites: 16 };
export const fonts = ['Chicago12'];

const COLS = 18, ROWS = 12, CELL = 16;
const STEP = 0.25; // slide of one turn (s)
const TELEPORT = 0.6; // flash out + flash in (s)
const SONIC = 0.5; // sonic wave on the neighbouring cells (s)
const NEXT_LEVEL = 1.5; // pause between a cleared board and the next level (s)
const F = { doctor: 0, dalek: 1, heap: 2, flash: [3, 4, 5], sonic: 6 };
// value positions relative to the anchor (measured from the labels in Daleks.png)
const STATUS_BASELINE_DY = 15, SCORE_DX = 54, LEVEL_DX = 213;

// Fixed, deterministic layouts. `teleports` are tried in order; the first safe one wins.
export const LEVELS = [
    // the script plays 4 5 3 s 5 5 t 5 5 5 5 5: a four-Dalek pile-up on turn 2, the
    // screwdriver, a teleport out of the pincer to (4, 6), then the rest file into the heap
    {
        doctor: [8, 6],
        daleks: [[1, 2], [1, 10], [0, 6], [16, 1], [16, 11], [17, 6], [3, 4], [3, 8], [13, 4], [13, 8], [8, 0], [8, 11]],
        teleports: [[12, 6], [4, 6], [12, 8]],
    },
    // the script plays 8 5 5 s 5 7 3: heaps all round, and the last Dalek gets him
    {
        doctor: [9, 5],
        daleks: [[3, 1], [3, 9], [15, 1], [15, 9], [9, 0], [9, 11], [1, 5], [17, 5], [6, 10], [12, 0], [13, 7], [5, 3]],
        teleports: [[13, 6], [5, 6]],
    },
];

function makeLevel(n) {
    if (n <= LEVELS.length) return LEVELS[n - 1];
    // further levels: a fixed pseudo-random layout per level number
    let seed = n * 7919;
    const rnd = (m) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m);
    const doctor = [9, 6];
    const daleks = [];
    while (daleks.length < Math.min(40, 6 + n * 2)) {
        const c = rnd(COLS), r = rnd(ROWS);
        if (Math.max(Math.abs(c - doctor[0]), Math.abs(r - doctor[1])) < 3) continue;
        if (daleks.some(([a, b]) => a === c && b === r)) continue;
        daleks.push([c, r]);
    }
    return { doctor, daleks, teleports: [[2, 2], [15, 9], [15, 2], [2, 9]] };
}

const KEYS = {
    7: [-1, -1], 8: [0, -1], 9: [1, -1],
    4: [-1, 0], 5: [0, 0], 6: [1, 0],
    1: [-1, 1], 2: [0, 1], 3: [1, 1],
};

export class DaleksControl extends Control {
    reset() {
        this.score = 0;
        this.load(1, 0);
    }

    get now() {
        return this.scene.time ?? 0;
    }

    load(level, t) {
        const L = makeLevel(level);
        this.level = level;
        this.layout = L;
        this.doctor = { c: L.doctor[0], r: L.doctor[1], pc: L.doctor[0], pr: L.doctor[1] };
        this.daleks = L.daleks.map(([c, r]) => ({ c, r, pc: c, pr: r, state: 'alive', diedAt: 0 }));
        this.heaps = [];
        this.sonicUsed = false;
        this.turnAt = -1e9;
        this.teleport = null; // {from:[c,r], at}
        this.sonic = null; // {c, r, at}
        this.over = null; // {at}
        this.clearedAt = null;
        this.levelAt = t;
    }

    // the next level comes in on its own once the board has been cleared
    advance(t) {
        if (this.clearedAt != null && t >= this.clearedAt + NEXT_LEVEL) this.load(this.level + 1, this.clearedAt + NEXT_LEVEL);
    }

    update(t) {
        this.advance(t);
    }

    heapAt(c, r) {
        return this.heaps.some((h) => h.c === c && h.r === r);
    }

    isSafe(c, r) {
        if (this.heapAt(c, r)) return false;
        return !this.daleks.some((d) => d.state === 'alive' && Math.max(Math.abs(d.c - c), Math.abs(d.r - r)) <= 1);
    }

    typeCharacter(ch) {
        const t = this.now;
        this.advance(t);
        const k = ch.toLowerCase();
        if (KEYS[k]) this.turn('move', t, ...KEYS[k]);
        else if (k === 't') this.turn('teleport', t);
        else if (k === 's') this.turn('sonic', t);
    }

    gridRect() {
        return { x: this.x, y: this.y - ROWS * CELL + 1, w: COLS * CELL, h: ROWS * CELL };
    }

    mouseDown(x, y) {
        const g = this.gridRect();
        if (!inRect(g, x, y)) return;
        const t = this.now;
        this.advance(t);
        const c = Math.floor((x - g.x) / CELL), r = Math.floor((y - g.y) / CELL);
        this.turn('move', t, Math.sign(c - this.doctor.c), Math.sign(r - this.doctor.r));
    }

    turn(kind, t, dc = 0, dr = 0) {
        if (this.over || this.clearedAt != null) return false;
        const doc = this.doctor;
        let nc = doc.c, nr = doc.r;
        if (kind === 'move') {
            nc += dc;
            nr += dr;
            // walking off the board or into a scrap heap is refused (no turn)
            if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS || this.heapAt(nc, nr)) return false;
        } else if (kind === 'teleport') {
            const target = this.layout.teleports.find(([c, r]) => this.isSafe(c, r));
            if (!target) return false;
            [nc, nr] = target;
        } else if (kind === 'sonic' && this.sonicUsed) {
            return false;
        }

        // finish the previous turn's animations
        this.daleks = this.daleks.filter((d) => d.state === 'alive' || t < d.diedAt);
        for (const d of this.daleks) {
            d.pc = d.c;
            d.pr = d.r;
        }
        doc.pc = doc.c;
        doc.pr = doc.r;
        this.teleport = kind === 'teleport' ? { from: [doc.c, doc.r], at: t } : null;
        doc.c = nc;
        doc.r = nr;
        this.turnAt = t;
        const end = t + STEP;

        if (kind === 'sonic') {
            this.sonicUsed = true;
            this.sonic = { c: doc.c, r: doc.r, at: t };
            for (const d of this.daleks) {
                if (d.state !== 'alive') continue;
                if (Math.max(Math.abs(d.c - doc.c), Math.abs(d.r - doc.r)) === 1) {
                    d.state = 'zapped';
                    d.diedAt = t + SONIC;
                    this.score += 10;
                }
            }
        }

        // every Dalek steps towards the Doctor
        const alive = this.daleks.filter((d) => d.state === 'alive');
        for (const d of alive) {
            d.c += Math.sign(doc.c - d.c);
            d.r += Math.sign(doc.r - d.r);
        }
        const cells = new Map();
        for (const d of alive) {
            const key = d.c + ',' + d.r;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(d);
        }
        for (const group of cells.values()) {
            const { c, r } = group[0];
            if (c === doc.c && r === doc.r) continue;
            if (group.length > 1 || this.heapAt(c, r)) {
                for (const d of group) {
                    d.state = 'scrapped';
                    d.diedAt = end;
                    this.score += 10;
                }
                if (!this.heapAt(c, r)) this.heaps.push({ c, r, bornAt: end });
            }
        }
        if (alive.some((d) => d.state === 'alive' && d.c === doc.c && d.r === doc.r)) this.over = { at: end };
        else if (!this.daleks.some((d) => d.state === 'alive')) this.clearedAt = end;
        return true;
    }

    // --- drawing

    cellXY(c, r) {
        const g = this.gridRect();
        return [g.x + c * CELL, g.y + r * CELL];
    }

    slideXY(pc, pr, c, r, t) {
        const p = Math.min(1, Math.max(0, (t - this.turnAt) / STEP));
        const [x0, y0] = this.cellXY(pc, pr);
        const [x1, y1] = this.cellXY(c, r);
        return [Math.round(x0 + (x1 - x0) * p), Math.round(y0 + (y1 - y0) * p)];
    }

    draw(bm, t) {
        const s = this.sprite('DaleksSprites');
        if (!s) return;
        const g = this.gridRect();
        // keep everything inside the grid
        const put = (frame, x, y) => {
            if (x < g.x - CELL || y < g.y - CELL) return;
            bm.blitInk(s, x, y, frame);
        };

        for (const h of this.heaps) if (t >= h.bornAt) put(F.heap, ...this.cellXY(h.c, h.r));

        for (const d of this.daleks) {
            if (d.state === 'alive' || (d.state === 'scrapped' && t < d.diedAt)) {
                put(F.dalek, ...this.slideXY(d.pc, d.pr, d.c, d.r, t));
            } else if (d.state === 'zapped' && t < d.diedAt) {
                // blinks out under the screwdriver
                if (Math.floor((t - this.sonic.at) / 0.1) % 2 === 0) put(F.dalek, ...this.cellXY(d.c, d.r));
            }
        }

        this.drawDoctor(put, t);

        if (this.sonic && t - this.sonic.at < SONIC) {
            const k = Math.floor((t - this.sonic.at) / 0.1);
            for (let dr = -1; dr <= 1; dr++)
                for (let dc = -1; dc <= 1; dc++) {
                    if (!dc && !dr) continue;
                    const c = this.sonic.c + dc, r = this.sonic.r + dr;
                    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
                    put(k % 2 ? F.flash[2] : F.sonic, ...this.cellXY(c, r));
                }
        }

        this.drawStatus(bm);
        if (this.over && t >= this.over.at) this.drawGameOver(bm, g);
    }

    drawDoctor(put, t) {
        const doc = this.doctor;
        if (this.over && t >= this.over.at) return; // the Dalek stands where he was
        if (this.teleport && t - this.teleport.at < TELEPORT) {
            const u = (t - this.teleport.at) / TELEPORT;
            const n = F.flash.length;
            if (u < 0.5) {
                // flash out at the old cell: doctor, small, burst, sparkle
                const i = Math.floor(u * 2 * (n + 1));
                put(i === 0 ? F.doctor : F.flash[i - 1], ...this.cellXY(...this.teleport.from));
            } else {
                // flash in at the new cell: sparkle, burst, small, doctor
                const i = Math.floor((u - 0.5) * 2 * (n + 1));
                put(i >= n ? F.doctor : F.flash[n - 1 - i], ...this.cellXY(doc.c, doc.r));
            }
            return;
        }
        put(F.doctor, ...this.slideXY(doc.pc, doc.pr, doc.c, doc.r, t));
    }

    drawStatus(bm) {
        const f = this.font('Chicago12');
        const y = this.y + STATUS_BASELINE_DY;
        f.draw(bm, this.x + SCORE_DX, y, String(this.score));
        f.draw(bm, this.x + LEVEL_DX, y, String(this.level));
    }

    drawGameOver(bm, g) {
        const f = this.font('Chicago12');
        const text = 'Game over';
        const w = f.measure(text) + 24, h = 26;
        const x = g.x + Math.round((g.w - w) / 2), y = g.y + Math.round((g.h - h) / 2);
        // alert-style box: black frame, white gap, thick frame
        bm.fillRect(x - 3, y - 3, w + 6, h + 6, 1);
        bm.fillRect(x - 1, y - 1, w + 2, h + 2, 0);
        bm.fillRect(x, y, w, h, 1);
        bm.fillRect(x + 1, y + 1, w - 2, h - 2, 0);
        f.draw(bm, x + 12, y + 17, text);
    }
}

export const controls = { daleks: DaleksControl };
