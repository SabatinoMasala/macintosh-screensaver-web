// Sargon III (Hayden Software, 1984): the chess program on the 1-bit Macintosh.
// Added scene (not part of Apple's set).
//
// `add chessboard at X, Y`: X, Y is the bottom-left pixel of the 8x8 board (a1's
// bottom-left corner), like the other bottom-left anchored controls. Squares are
// 24 px; the move list of Chess.png sits at a fixed offset to the right of the board.
//
// - The human (white, but any piece works) moves by mouse: mouse down on a piece lifts
//   it, it follows the mouse with the grab offset, mouse up on a square drops it there
//   (off the board, or on its own square, it goes back). No legality checks.
// - The computer moves through `keyboard "e7e5"`: four characters from-square /
//   to-square, then the piece slides there over 0.5 s.
// - A captured piece disappears; every move is appended to the move list in algebraic
//   notation (Geneva 9), one row per move number with White / Black columns.

import { Control, inRect } from '../controls.js';

export const program = 'Chess';
export const images = { Chess: null, ChessPieces: 24 };
export const fonts = ['Geneva9'];

const SQ = 24;
const SLIDE = 0.5; // seconds for a typed move
const KINDS = 'KQRBNP';
const LIST = { dx: 212, rowBaseline: -161, pitch: 12, rows: 13, num: 18, white: 24, black: 74 };
const INITIAL = [
    'rnbqkbnr',
    'pppppppp',
    '........',
    '........',
    '........',
    '........',
    'PPPPPPPP',
    'RNBQKBNR',
]; // rank 8 first; uppercase = white

const smooth = (t) => t * t * (3 - 2 * t);

class ChessControl extends Control {
    reset() {
        // board[file][rank], file 0..7 = a..h, rank 0..7 = 1..8; '' = empty
        this.board = [];
        for (let f = 0; f < 8; f++) {
            this.board.push([]);
            for (let r = 0; r < 8; r++) {
                const c = INITIAL[7 - r][f];
                this.board[f].push(c === '.' ? '' : c);
            }
        }
        this.moves = []; // SAN strings, white first
        this.drag = null; // {piece, from:[f,r], ox, oy, x, y}
        this.slide = null; // {piece, from, to, start}
        this.typed = '';
    }

    get top() {
        return this.y - 8 * SQ + 1;
    }
    squareRect(f, r) {
        return { x: this.x + f * SQ, y: this.top + (7 - r) * SQ, w: SQ, h: SQ };
    }
    squareAt(x, y) {
        if (!inRect({ x: this.x, y: this.top, w: 8 * SQ, h: 8 * SQ }, x, y)) return null;
        return [Math.floor((x - this.x) / SQ), 7 - Math.floor((y - this.top) / SQ)];
    }
    frame(piece) {
        const white = piece === piece.toUpperCase();
        return (white ? 0 : 6) + KINDS.indexOf(piece.toUpperCase());
    }

    // --- moves
    san(piece, from, to, capture) {
        const kind = piece.toUpperCase();
        const dest = 'abcdefgh'[to[0]] + (to[1] + 1);
        if (kind === 'K' && Math.abs(to[0] - from[0]) === 2) return to[0] > from[0] ? 'O-O' : 'O-O-O';
        if (kind === 'P') return capture ? 'abcdefgh'[from[0]] + 'x' + dest : dest;
        return kind + (capture ? 'x' : '') + dest;
    }
    // Puts the piece on its square (the from square is already empty) and records the move.
    complete(piece, from, to) {
        const capture = this.board[to[0]][to[1]] !== '';
        this.board[to[0]][to[1]] = piece;
        // castling drags the rook along
        if (piece.toUpperCase() === 'K' && Math.abs(to[0] - from[0]) === 2) {
            const rf = to[0] > from[0] ? 7 : 0, nf = to[0] > from[0] ? 5 : 3;
            this.board[nf][to[1]] = this.board[rf][to[1]];
            this.board[rf][to[1]] = '';
        }
        this.moves.push(this.san(piece, from, to, capture));
    }
    finishSlide() {
        if (!this.slide) return;
        const { piece, from, to } = this.slide;
        this.slide = null;
        this.complete(piece, from, to);
    }

    // --- mouse: drag and drop
    mouseDown(x, y) {
        const sq = this.squareAt(x, y);
        if (!sq || this.slide) return;
        const piece = this.board[sq[0]][sq[1]];
        if (!piece) return;
        const r = this.squareRect(sq[0], sq[1]);
        this.board[sq[0]][sq[1]] = '';
        this.drag = { piece, from: sq, ox: x - r.x, oy: y - r.y, x, y };
    }
    mouseMove(x, y) {
        if (this.drag) {
            this.drag.x = x;
            this.drag.y = y;
        }
    }
    mouseUp(x, y) {
        if (!this.drag) return;
        const { piece, from } = this.drag;
        this.drag = null;
        const to = this.squareAt(x, y);
        if (!to || (to[0] === from[0] && to[1] === from[1])) {
            this.board[from[0]][from[1]] = piece;
            return;
        }
        this.complete(piece, from, to);
    }

    // --- keyboard: "e7e5"
    typeCharacter(ch) {
        const c = ch.toLowerCase();
        if (!/[a-h1-8]/.test(c)) return;
        this.typed += c;
        if (this.typed.length < 4) return;
        const m = this.typed.match(/^([a-h])([1-8])([a-h])([1-8])$/);
        this.typed = '';
        if (!m) return;
        const from = [m[1].charCodeAt(0) - 97, +m[2] - 1], to = [m[3].charCodeAt(0) - 97, +m[4] - 1];
        const piece = this.board[from[0]][from[1]];
        if (!piece) return;
        this.finishSlide();
        this.board[from[0]][from[1]] = '';
        this.slide = { piece, from, to, start: this.scene.time ?? 0 };
    }

    update(t) {
        if (this.slide && t - this.slide.start >= SLIDE) this.finishSlide();
    }

    // --- drawing
    draw(bm, t) {
        const s = this.sprite('ChessPieces');
        if (s) {
            for (let f = 0; f < 8; f++) for (let r = 0; r < 8; r++) {
                const p = this.board[f][r];
                if (!p) continue;
                const q = this.squareRect(f, r);
                bm.blit(s, q.x, q.y, this.frame(p));
            }
            if (this.slide) {
                const k = smooth(Math.min(1, Math.max(0, (t - this.slide.start) / SLIDE)));
                const a = this.squareRect(...this.slide.from), b = this.squareRect(...this.slide.to);
                bm.blit(s, Math.round(a.x + (b.x - a.x) * k), Math.round(a.y + (b.y - a.y) * k), this.frame(this.slide.piece));
            }
            if (this.drag) bm.blit(s, Math.round(this.drag.x - this.drag.ox), Math.round(this.drag.y - this.drag.oy), this.frame(this.drag.piece));
        }
        this.drawMoves(bm);
    }

    drawMoves(bm) {
        const font = this.font('Geneva9');
        const lx = this.x + LIST.dx;
        const rows = Math.ceil(this.moves.length / 2);
        const first = Math.max(0, rows - LIST.rows); // scroll once the list is full
        for (let i = first; i < rows; i++) {
            const y = this.y + LIST.rowBaseline + (i - first) * LIST.pitch;
            const n = `${i + 1}.`;
            font.draw(bm, lx + LIST.num - font.measure(n), y, n);
            font.draw(bm, lx + LIST.white, y, this.moves[2 * i]);
            if (this.moves[2 * i + 1]) font.draw(bm, lx + LIST.black, y, this.moves[2 * i + 1]);
        }
    }

}

export const controls = { chessboard: ChessControl };
