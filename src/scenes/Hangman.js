// Hangman: a classic 1-bit Hangman desk accessory (added scene, not part of Apple's set).
//
//   add hangman at X, Y [size W, H] [value N] [name "WORD_WORD..."]
//
// Anchor: bottom-left of the window's white content area (Hangman.png: `at 159, 221`,
// content 189 x 127, so its top-left is (X, Y - 126)). Everything below is laid out
// relative to that top-left; the gallows, labels and the New Game button are in the
// base image, the control paints the word, the wrong letters, the figure and the
// result line every frame.
//
// Words: `name` is one word or several joined by underscores ("MACINTOSH_SABATINO");
// without a name the built-in list MACINTOSH, SABATINO is used. `value` is the index
// of the first word (default 0). The `newGame` action (the New Game button:
// `add button ... action "newGame"`) starts the next word. reset() goes back to the
// first word with nothing guessed.
//
// Letters come from `keyboard "..."`: A-Z only (lowercase counts as uppercase),
// repeats and anything else are ignored, and nothing is taken once the game is over.
// Six wrong letters (head, body, left arm, right arm, left leg, right leg) lose:
// "You lose!", the missing letters are revealed inverted and the head gets X eyes.

import { Control } from '../controls.js';

export const program = 'Hangman';
export const images = { Hangman: null };
export const fonts = ['Chicago12'];

const WORDS = ['MACINTOSH', 'SABATINO'];
const MAX_WRONG = 6;
// content-relative layout (must match Hangman.png)
const ROPE_X = 62;            // the figure hangs from the 2 px rope at x 62..63
const HEAD_Y = 27, HEAD_R = 7;
const WRONG_X = 92, WRONG_BASE = 38, WRONG_PITCH = 15;
const STATUS_X = 91, STATUS_BASE = 60;
const WORD_BASE = 118, SLOT_W = 12, SLOT_PITCH = 16;

function line2(bm, x0, y0, x1, y1) {
    // a 2 x 2 brush along the segment
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) {
        const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n);
        bm.fillRect(x, y, 2, 2, 1);
    }
}

class HangmanControl extends Control {
    reset() {
        this.words = this.name ? this.name.split('_').filter(Boolean).map((w) => w.toUpperCase()) : WORDS;
        this.index = (this.value ?? 0) % this.words.length;
        this.w = this.ins.w ?? 189;
        this.h = this.ins.h ?? 127;
        this.newGame();
    }
    newGame() {
        this.word = this.words[this.index];
        this.guessed = new Set();
        this.wrong = [];
    }
    onAction(action) {
        if (action !== 'newGame') return;
        this.index = (this.index + 1) % this.words.length;
        this.newGame();
    }
    get won() {
        return [...this.word].every((c) => !/[A-Z]/.test(c) || this.guessed.has(c));
    }
    get lost() {
        return this.wrong.length >= MAX_WRONG;
    }
    typeCharacter(ch) {
        const c = String(ch).toUpperCase();
        if (!/^[A-Z]$/.test(c) || this.guessed.has(c) || this.won || this.lost) return;
        this.guessed.add(c);
        if (!this.word.includes(c)) this.wrong.push(c);
    }
    draw(bm) {
        const ox = this.x, oy = this.y - this.h + 1;
        const f = this.font('Chicago12');
        const lost = this.lost;

        // the word: one underlined slot per letter, centred in the content width
        const n = this.word.length;
        const total = n * SLOT_PITCH - (SLOT_PITCH - SLOT_W);
        const x0 = ox + Math.round((this.w - total) / 2);
        for (let i = 0; i < n; i++) {
            const c = this.word[i];
            const sx = x0 + i * SLOT_PITCH;
            bm.fillRect(sx, oy + WORD_BASE + 2, SLOT_W, 1, 1);
            const shown = this.guessed.has(c) || !/[A-Z]/.test(c);
            if (!shown && !lost) continue;
            const gx = sx + Math.round((SLOT_W - f.measure(c)) / 2);
            if (shown) {
                f.draw(bm, gx, oy + WORD_BASE, c);
            } else {
                // revealed after a loss: inverted
                bm.fillRect(sx - 1, oy + WORD_BASE - 11, SLOT_W + 2, 13, 1);
                f.draw(bm, gx, oy + WORD_BASE, c, 0);
            }
        }

        // the wrong letters
        this.wrong.forEach((c, i) => {
            const cx = ox + WRONG_X + i * WRONG_PITCH;
            f.draw(bm, cx + Math.round((WRONG_PITCH - 2 - f.measure(c)) / 2), oy + WRONG_BASE, c);
        });

        // the result
        if (this.won) f.draw(bm, ox + STATUS_X, oy + STATUS_BASE, 'You win!');
        else if (lost) f.draw(bm, ox + STATUS_X, oy + STATUS_BASE, 'You lose!');

        // the figure, part by part
        const k = this.wrong.length;
        const cx = ox + ROPE_X, hy = oy + HEAD_Y;
        if (k >= 1) {
            // 2 px ring centred between the rope's two columns
            for (let y = -HEAD_R - 1; y <= HEAD_R + 1; y++)
                for (let x = -HEAD_R - 1; x <= HEAD_R + 2; x++) {
                    const d = Math.hypot(x - 0.5, y);
                    if (d <= HEAD_R + 0.3 && d >= HEAD_R - 1.6) bm.set(cx + x, hy + y, 1);
                }
            if (lost) {
                // X eyes
                for (const ex of [cx - 2, cx + 3])
                    for (let d = -1; d <= 1; d++) {
                        bm.set(ex + d, hy - 1 + d, 1);
                        bm.set(ex + d, hy - 1 - d, 1);
                    }
            }
        }
        if (k >= 2) bm.fillRect(cx, hy + HEAD_R + 1, 2, 23, 1);              // body, rows 35..57
        if (k >= 3) line2(bm, cx, oy + 40, cx - 11, oy + 51);                 // left arm
        if (k >= 4) line2(bm, cx, oy + 40, cx + 11, oy + 51);                 // right arm
        if (k >= 5) line2(bm, cx, oy + 57, cx - 10, oy + 75);                 // left leg
        if (k >= 6) line2(bm, cx, oy + 57, cx + 10, oy + 75);                 // right leg
    }
}

export const controls = { hangman: HangmanControl };
