// Mines: a classic 1-bit Macintosh Minesweeper in a desk-accessory window.
//
//   add minefield at 163, 253
//
// Bottom-left anchor like the other controls: (x, y) is the bottom-left pixel of
// the 9x9 grid's outer line, so the grid spans x .. x+144, y-144 .. y (lines on a
// 16 px pitch, drawn in Mines.png). Cell (c, r) is the 16x16 MinesTiles frame at
// (x + 1 + 16c, top + 1 + 16r); each frame carries its own right/bottom grid line.
// The header row above the grid (top - 28 .. top - 7) holds the timer (left),
// the face button (centre) and the mines-left counter (right, next to where the
// script plants its flag), drawn here as white 7-segment digits into the black
// boxes of the base image.
//
// Behaviour: a fixed layout of 10 mines. A mouse down on a covered cell reveals
// it (zero cells flood-fill); typing "f" arms flag mode, in which the next click
// plants (or lifts) a flag and disarms it; the face button shows a flag while
// armed. Clicking a mine reveals every mine, the fatal one inverted, wrong flags
// crossed out; the timer stops and the face dies. A click on the face restarts.

import { Control, inRect } from '../controls.js';

export const program = 'Mines';
export const images = { Mines: null, MinesTiles: 16 };

const N = 9;
const P = 16;
const MINES = [[0, 6], [1, 8], [2, 7], [3, 5], [4, 7], [6, 4], [6, 8], [7, 0], [8, 5], [8, 7]]; // [row, col]

// MinesTiles frames
const COVERED = 0, FLAG = 1, EMPTY = 2, MINE = 11, EXPLODED = 12, WRONG_FLAG = 13;
const FACE_SMILE = 14, FACE_OH = 15, FACE_DEAD = 16, FLAG_ICON = 17;

// 7-segment digits, 9x16, 2 px strokes: segments a b c d e f g as [x, y, w, h]
const SEG = {
    a: [2, 0, 5, 2], b: [7, 2, 2, 5], c: [7, 9, 2, 5], d: [2, 14, 5, 2],
    e: [0, 9, 2, 5], f: [0, 2, 2, 5], g: [2, 7, 5, 2],
};
const DIGITS = {
    0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg',
    6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '',
};

class Minefield extends Control {
    reset() {
        this.w = this.ins.w ?? N * P + 1;
        this.h = this.ins.h ?? N * P + 1;
        this.top = this.y - this.h + 1;
        this.mine = new Uint8Array(N * N);
        for (const [r, c] of MINES) this.mine[r * N + c] = 1;
        this.state = new Uint8Array(N * N); // 0 covered, 1 revealed, 2 flagged
        this.flagMode = false;
        this.over = false;
        this.won = false;
        this.exploded = -1;
        this.startTime = null;
        this.stopTime = null;
        this.pressing = false;
        this.facePressed = false;
    }
    get headerTop() {
        return this.top - 28;
    }
    get faceRect() {
        return { x: this.x + Math.floor((this.w - 22) / 2), y: this.headerTop, w: 22, h: 22 };
    }
    neighbours(i) {
        const r = Math.floor(i / N), c = i % N, out = [];
        for (let dr = -1; dr <= 1; dr++)
            for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr, cc = c + dc;
                if ((dr || dc) && rr >= 0 && cc >= 0 && rr < N && cc < N) out.push(rr * N + cc);
            }
        return out;
    }
    count(i) {
        return this.neighbours(i).reduce((n, j) => n + this.mine[j], 0);
    }
    cellAt(x, y) {
        const c = Math.floor((x - this.x - 1) / P), r = Math.floor((y - this.top - 1) / P);
        return c >= 0 && r >= 0 && c < N && r < N ? r * N + c : -1;
    }
    typeCharacter(ch) {
        if (ch.toLowerCase() === 'f' && !this.over) this.flagMode = !this.flagMode;
    }
    mouseDown(x, y) {
        if (inRect(this.faceRect, x, y)) {
            this.facePressed = true;
            return;
        }
        const i = this.cellAt(x, y);
        if (i < 0 || this.over) return;
        this.pressing = true;
        if (this.flagMode) {
            if (this.state[i] !== 1) this.state[i] = this.state[i] === 2 ? 0 : 2;
            this.flagMode = false;
            return;
        }
        if (this.state[i] !== 0) return;
        if (this.startTime == null) this.startTime = this.scene.time ?? 0;
        if (this.mine[i]) {
            this.exploded = i;
            this.over = true;
            this.stopTime = this.scene.time ?? 0;
            return;
        }
        this.flood(i);
        if (this.state.every((s, j) => this.mine[j] || s === 1)) {
            this.over = this.won = true;
            this.stopTime = this.scene.time ?? 0;
            for (let j = 0; j < N * N; j++) if (this.mine[j]) this.state[j] = 2;
        }
    }
    mouseUp(x, y) {
        if (this.facePressed && inRect(this.faceRect, x, y)) this.reset();
        this.facePressed = false;
        this.pressing = false;
    }
    flood(start) {
        const stack = [start];
        while (stack.length) {
            const i = stack.pop();
            if (this.state[i] !== 0 || this.mine[i]) continue;
            this.state[i] = 1;
            if (this.count(i) === 0) stack.push(...this.neighbours(i));
        }
    }
    frameFor(i) {
        const s = this.state[i];
        if (this.over && !this.won) {
            if (i === this.exploded) return EXPLODED;
            if (s === 2) return this.mine[i] ? FLAG : WRONG_FLAG;
            if (this.mine[i]) return MINE;
        }
        if (s === 2) return FLAG;
        if (s === 0) return COVERED;
        const n = this.count(i);
        return n ? EMPTY + n : EMPTY;
    }
    drawDigits(bm, boxX, text) {
        const y0 = this.headerTop + 3;
        for (let k = 0; k < 3; k++) {
            const segs = DIGITS[text[k]] ?? '';
            const dx = boxX + 3 + k * 11;
            for (const s of segs) {
                const [sx, sy, w, h] = SEG[s];
                bm.fillRect(dx + sx, y0 + sy, w, h, 0);
            }
        }
    }
    draw(bm, t) {
        const tiles = this.sprite('MinesTiles');
        if (!tiles) return;
        for (let i = 0; i < N * N; i++) {
            const r = Math.floor(i / N), c = i % N;
            bm.blit(tiles, this.x + 1 + c * P, this.top + 1 + r * P, this.frameFor(i));
        }
        // header: seconds, face, mines left
        const flags = this.state.reduce((n, s) => n + (s === 2), 0);
        const left = MINES.length - flags;
        const counter = left < 0 ? '-' + String(Math.min(99, -left)).padStart(2, '0') : String(Math.min(999, left)).padStart(3, '0');
        this.drawDigits(bm, this.x + this.w - 36, counter);
        let secs = 0;
        if (this.startTime != null) secs = Math.min(999, Math.floor((this.stopTime ?? t) - this.startTime) + 1);
        this.drawDigits(bm, this.x, String(secs).padStart(3, '0'));
        const fr = this.faceRect;
        let face = FACE_SMILE;
        if (this.over && !this.won) face = FACE_DEAD;
        else if (this.flagMode) face = FLAG_ICON;
        else if (this.pressing) face = FACE_OH;
        bm.fillRect(fr.x + 1, fr.y + 1, fr.w - 3, fr.h - 3, 0);
        bm.blit(tiles, fr.x + 3, fr.y + 3, face);
        if (this.facePressed) bm.invertRect(fr.x + 1, fr.y + 1, fr.w - 2, fr.h - 2);
    }
}

export const controls = { minefield: Minefield };
