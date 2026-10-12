// Tetris (Spectrum HoloByte, 1988) as it looked on the 1-bit Mac: a 10x20 well of
// 10 px cells, each tetromino type drawn with its own 8x8 fill pattern inside a 1 px
// border (TetrisBlocks, one 10x10 frame per type), a Next preview and the
// Score / Lines / Level boxes. Added scene, not part of Apple's set.
//
// `add tetris at X, Y`: (X, Y) is the bottom-left pixel of the well's interior
// (206, 276 in Tetris.png). Cell (c, r) has its top-left at (X + 10c, Y - 199 + 10r).
// The Score / Lines / Level / Next boxes of the base image are found from the
// same anchor (offsets below), so the control paints all of the game each frame.
//
// Keys (delivered by `keyboard "..."`): 'l' left, 'r' right, 'u' rotate clockwise,
// 'd' soft drop one row (never locks), ' ' hard drop, 'p' pause / resume (the script pauses the
// game across the fades between sub-scenes so no piece lands unplanned).
// Gravity: one row every 0.5 s at level 1, x0.8 per level. Full lines flash twice
// (inverted) and then clear. Everything is deterministic: a fixed pre-filled well,
// a fixed piece sequence, a fixed 30 Hz step; reset() restores the initial game.

import { Control } from '../controls.js';

export const program = 'Tetris';
export const images = { Tetris: null, TetrisBlocks: 10 };
export const fonts = ['Chicago12'];

const COLS = 10, ROWS = 20, CELL = 10;
const I = 0, O = 1, T = 2, S = 3, Z = 4, J = 5, L = 6;
const LETTERS = 'IOTSZJL';

// spawn-state cells [col, row] inside an n x n box; rotation is (x, y) -> (n-1-y, x)
const SHAPES = [
    { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]], spawn: [3, -1] }, // I
    { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], spawn: [4, 0] }, // O
    { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]], spawn: [3, 0] }, // T
    { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]], spawn: [3, 0] }, // S
    { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]], spawn: [3, 0] }, // Z
    { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]], spawn: [3, 0] }, // J
    { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]], spawn: [3, 0] }, // L
];
const ROTATIONS = SHAPES.map(({ n, cells }) => {
    if (n === 2) return [cells];
    const states = [cells];
    for (let k = 1; k < 4; k++) states.push(states[k - 1].map(([x, y]) => [n - 1 - y, x]));
    return states;
});

// The game in progress when the scene opens: rows 14..19, column 9 left open
// below row 15 for the closing I piece.
const PREFILL = [
    'LLL.......',
    'JZZT..S...',
    'JZZTTSSOO.',
    'JJTTSSLOO.',
    'IIIIZZLLZ.',
    'OOSSTTTZZ.',
];
// The piece sequence (cycled). The script's keystrokes are written for it.
const SEQUENCE = [O, T, J, L, S, I, O, T, Z, L, S, J, I];
const START = { score: 2416, lines: 8 };

const FLASH_PHASE = 0.12; // inverted / normal, twice
const LINE_SCORE = [0, 40, 100, 300, 1200];

// boxes of the base image, relative to the anchor (left, top from the well's top)
const BOX = {
    score: { dx: -86, dy: 17, w: 76, h: 20 },
    lines: { dx: -86, dy: 59, w: 76, h: 20 },
    level: { dx: -86, dy: 101, w: 76, h: 20 },
    next: { dx: 112, dy: 17, w: 75, h: 50 },
};

class TetrisControl extends Control {
    reset() {
        this.grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(-1));
        PREFILL.forEach((row, i) => {
            const r = ROWS - PREFILL.length + i;
            [...row].forEach((ch, c) => (this.grid[r][c] = LETTERS.indexOf(ch)));
        });
        this.seq = 0;
        this.score = START.score;
        this.lines = START.lines;
        this.paused = false;
        this.flash = null; // {rows, t}
        this.acc = 0;
        this.spawn();
    }
    get level() {
        return 1 + Math.floor(this.lines / 10);
    }
    get interval() {
        return 0.5 * Math.pow(0.8, this.level - 1);
    }
    get top() {
        return this.y - ROWS * CELL + 1;
    }
    spawn() {
        const type = SEQUENCE[this.seq % SEQUENCE.length];
        this.seq++;
        this.next = SEQUENCE[this.seq % SEQUENCE.length];
        const [px, py] = SHAPES[type].spawn;
        this.piece = { type, rot: 0, x: px, y: py };
        this.acc = 0;
        if (!this.fits(this.piece)) this.reset(); // game over: start again
    }
    cells(p) {
        return ROTATIONS[p.type][p.rot % ROTATIONS[p.type].length].map(([cx, cy]) => [p.x + cx, p.y + cy]);
    }
    fits(p) {
        return this.cells(p).every(([c, r]) => c >= 0 && c < COLS && r < ROWS && (r < 0 || this.grid[r][c] < 0));
    }
    tryMove(dx, dy, drot = 0) {
        const p = { ...this.piece, x: this.piece.x + dx, y: this.piece.y + dy, rot: this.piece.rot + drot };
        if (!this.fits(p)) return false;
        this.piece = p;
        return true;
    }
    rotate() {
        // clockwise, with a one-column nudge off the walls
        for (const dx of [0, -1, 1]) if (this.tryMove(dx, 0, 1)) return;
    }
    lock() {
        for (const [c, r] of this.cells(this.piece)) if (r >= 0) this.grid[r][c] = this.piece.type;
        this.piece = null;
        const full = [];
        for (let r = 0; r < ROWS; r++) if (this.grid[r].every((v) => v >= 0)) full.push(r);
        if (full.length) this.flash = { rows: full, t: 0 };
        else this.spawn();
    }
    clearRows(rows) {
        this.grid = this.grid.filter((_, r) => !rows.includes(r));
        while (this.grid.length < ROWS) this.grid.unshift(new Array(COLS).fill(-1));
        this.score += LINE_SCORE[rows.length] * this.level;
        this.lines += rows.length;
    }
    typeCharacter(ch) {
        if (ch === 'p') {
            this.paused = !this.paused;
            return;
        }
        if (this.paused || this.flash || !this.piece) return;
        switch (ch) {
            case 'l': this.tryMove(-1, 0); break;
            case 'r': this.tryMove(1, 0); break;
            case 'u': this.rotate(); break;
            case 'd': // never locks: landing is left to gravity, so a following ' ' cannot hit the next piece
                if (this.tryMove(0, 1)) this.score += 1;
                break;
            case ' ': {
                let n = 0;
                while (this.tryMove(0, 1)) n++;
                this.score += 2 * n;
                this.lock();
                break;
            }
        }
    }
    update(t, dt) {
        if (this.paused) return;
        if (this.flash) {
            this.flash.t += dt;
            if (this.flash.t >= 4 * FLASH_PHASE) {
                this.clearRows(this.flash.rows);
                this.flash = null;
                this.spawn();
            }
            return;
        }
        if (!this.piece) return;
        this.acc += dt;
        while (this.piece && this.acc >= this.interval) {
            this.acc -= this.interval;
            if (!this.tryMove(0, 1)) this.lock();
        }
    }
    box(name) {
        const b = BOX[name];
        return { x: this.x + b.dx, y: this.top + b.dy, w: b.w, h: b.h };
    }
    draw(bm) {
        const blocks = this.sprite('TetrisBlocks');
        const cell = (c, r, type) => {
            if (r < 0) return;
            const x = this.x + c * CELL, y = this.top + r * CELL;
            if (blocks) bm.blit(blocks, x, y, type);
            else bm.fillRect(x, y, CELL, CELL, 1);
        };
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (this.grid[r][c] >= 0) cell(c, r, this.grid[r][c]);
        if (this.piece) for (const [c, r] of this.cells(this.piece)) cell(c, r, this.piece.type);
        if (this.flash && Math.floor(this.flash.t / FLASH_PHASE) % 2 === 0)
            for (const r of this.flash.rows) bm.invertRect(this.x, this.top + r * CELL, COLS * CELL, CELL);

        // Next preview, centred in its box
        const nb = this.box('next');
        const nc = ROTATIONS[this.next][0];
        const minX = Math.min(...nc.map((p) => p[0])), maxX = Math.max(...nc.map((p) => p[0]));
        const minY = Math.min(...nc.map((p) => p[1])), maxY = Math.max(...nc.map((p) => p[1]));
        const ox = nb.x + Math.floor((nb.w - (maxX - minX + 1) * CELL) / 2);
        const oy = nb.y + Math.floor((nb.h - (maxY - minY + 1) * CELL) / 2);
        for (const [cx, cy] of nc) {
            const x = ox + (cx - minX) * CELL, y = oy + (cy - minY) * CELL;
            if (blocks) bm.blit(blocks, x, y, this.next);
            else bm.fillRect(x, y, CELL, CELL, 1);
        }

        // counters, right-aligned in Chicago 12
        const f = this.font('Chicago12');
        for (const [name, value] of [['score', this.score], ['lines', this.lines], ['level', this.level]]) {
            const b = this.box(name);
            const text = String(value);
            f.draw(bm, b.x + b.w - 6 - f.measure(text), b.y + 15, text);
        }
    }
}

export const controls = { tetris: TetrisControl };
