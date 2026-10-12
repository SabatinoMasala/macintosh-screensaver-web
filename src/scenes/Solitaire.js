// Klondike: the classic 1-bit Macintosh solitaire (after Michael Casteel's Klondike, 1984).
// Added scene (not part of Apple's set).
//
//   add solitaire at X, Y
//
// The anchor is the BOTTOM-LEFT corner of the stock slot (like the other bottom-left
// controls); everything else is laid out from it: waste one pitch to the right,
// four foundations at pitches 3..6, seven tableau columns 53 px lower. Card faces,
// the back and the empty-slot frame come from the SolitaireCards strip (32x44 frames:
// suit * 13 + rank - 1 with suits spades, hearts, clubs, diamonds; 52 = back,
// 53 = empty slot). The base image (Solitaire.png) carries the window and the
// outlined empty slots; this control draws every card each frame.
//
// Mouse: a press on the stock turns one card onto the waste (an empty stock takes
// the waste back); a press on a face-up card picks it up together with the cards on
// top of it in its column and drags them with the mouse; release over a foundation
// or a column where the move is legal drops them, anywhere else they snap back.
// A column's newly exposed card flips face up (a short squeeze animation).
// The deal is fixed so the scripted moves in Solitaire.program are legal: 4D then AS
// off the stock, AS up; 7H onto 8S (2S turns up and follows the ace); 6C, 5H onto 7D
// and 10S onto JH (each move turns the next card of that column); 8S-7H onto 9H.

import { Control, inRect } from '../controls.js';

export const program = 'Solitaire';
export const images = { Solitaire: null, SolitaireCards: 32 };

const CW = 32, CH = 44;
const PITCH = 38; // column pitch
const TAB_DY = 53; // top of the tableau below the top of the stock
const DOWN_DY = 4; // face-down overlap
const UP_DY = 12; // face-up overlap (shows the corner index)
const BACK = 52, EMPTY = 53;
const FLIP = 0.24; // seconds for a card to turn over

const SUITS = 'SHCD';
const card = (s) => {
    // "7H", "10S", "AS", "KD"
    const suit = SUITS.indexOf(s.slice(-1));
    const r = s.slice(0, -1);
    const rank = r === 'A' ? 1 : r === 'J' ? 11 : r === 'Q' ? 12 : r === 'K' ? 13 : +r;
    return { suit, rank, up: false, flipAt: -1 };
};
const isRed = (c) => c.suit === 1 || c.suit === 3;
const key = (c) => c.suit * 13 + c.rank - 1;

// The fixed deal. Columns list their cards bottom to top; the last one is face up.
// The stock is turned from its END: 4D first, then AS.
const FIXED_COLUMNS = [
    ['KD'],
    ['2S', '7H'],
    [null, '9C', '8S'],
    [null, null, null, '9H'],
    [null, null, null, null, '7D'],
    ['JS', 'QD', '3D', '10S', '5H', '6C'],
    [null, null, null, null, null, null, 'JH'],
];
const STOCK_TOP = ['AS', '4D']; // the last entry is turned first

function deal() {
    const used = new Set();
    for (const col of FIXED_COLUMNS) for (const c of col) if (c) used.add(c);
    for (const c of STOCK_TOP) used.add(c);
    const rest = [];
    for (const s of SUITS)
        for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) if (!used.has(r + s)) rest.push(r + s);
    // a fixed shuffle of the cards nobody sees turned over (LCG, constant seed)
    let seed = 1984;
    for (let i = rest.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const columns = FIXED_COLUMNS.map((col) => col.map((c) => card(c ?? rest.pop())));
    for (const col of columns) col[col.length - 1].up = true;
    const stock = [...rest.map(card), ...STOCK_TOP.map(card)];
    return { columns, stock };
}

class SolitaireControl extends Control {
    reset() {
        const { columns, stock } = deal();
        this.columns = columns;
        this.stock = stock;
        this.waste = [];
        this.foundations = [[], [], [], []];
        this.drag = null;
        this.left = this.x;
        this.top = this.y - CH + 1;
    }

    // --- geometry
    slot(i) {
        // top row: 0 stock, 1 waste, 3..6 foundations
        return { x: this.left + PITCH * i, y: this.top, w: CW, h: CH };
    }
    foundationRect(f) {
        return this.slot(3 + f);
    }
    cardY(col, idx) {
        let y = this.top + TAB_DY;
        for (let i = 0; i < idx; i++) y += col[i].up ? UP_DY : DOWN_DY;
        return y;
    }
    columnX(c) {
        return this.left + PITCH * c;
    }
    now() {
        return this.scene.time ?? 0;
    }

    // --- rules
    canDrop(cards, target) {
        const first = cards[0];
        if (target.type === 'foundation') {
            if (cards.length !== 1) return false;
            const pile = this.foundations[target.index];
            const top = pile[pile.length - 1];
            return top ? top.suit === first.suit && first.rank === top.rank + 1 : first.rank === 1;
        }
        const col = this.columns[target.index];
        const top = col[col.length - 1];
        if (!top) return first.rank === 13;
        return top.up && isRed(top) !== isRed(first) && first.rank === top.rank - 1;
    }
    targetAt(x, y) {
        for (let f = 0; f < 4; f++) if (inRect(this.foundationRect(f), x, y)) return { type: 'foundation', index: f };
        for (let c = 0; c < 7; c++) {
            const col = this.columns[c];
            const bottom = this.cardY(col, Math.max(0, col.length - 1)) + CH;
            const r = { x: this.columnX(c), y: this.top + TAB_DY - 8, w: CW, h: bottom - (this.top + TAB_DY - 8) + 12 };
            if (inRect(r, x, y)) return { type: 'column', index: c };
        }
        return null;
    }

    // --- mouse
    mouseDown(x, y) {
        x = Math.round(x);
        y = Math.round(y);
        if (inRect(this.slot(0), x, y)) {
            if (this.stock.length) {
                const c = this.stock.pop();
                c.up = true;
                c.flipAt = this.now();
                this.waste.push(c);
            } else {
                // turn the waste back over
                while (this.waste.length) {
                    const c = this.waste.pop();
                    c.up = false;
                    this.stock.push(c);
                }
            }
            return;
        }
        if (this.waste.length && inRect(this.slot(1), x, y)) return this.pick({ type: 'waste' }, [this.waste[this.waste.length - 1]], this.slot(1), x, y);
        for (let f = 0; f < 4; f++) {
            const pile = this.foundations[f];
            if (pile.length && inRect(this.foundationRect(f), x, y)) return this.pick({ type: 'foundation', index: f }, [pile[pile.length - 1]], this.foundationRect(f), x, y);
        }
        for (let c = 0; c < 7; c++) {
            const col = this.columns[c];
            for (let i = col.length - 1; i >= 0; i--) {
                const r = { x: this.columnX(c), y: this.cardY(col, i), w: CW, h: CH };
                if (!inRect(r, x, y)) continue;
                if (col[i].up) this.pick({ type: 'column', index: c, from: i }, col.slice(i), r, x, y);
                else if (i === col.length - 1) this.turnOver(col[i]); // a click turns an exposed back over
                return;
            }
        }
    }
    pick(source, cards, rect, x, y) {
        this.drag = { source, cards, x0: rect.x, y0: rect.y, mx: x, my: y, dx: 0, dy: 0 };
    }
    mouseMove(x, y, down) {
        if (!this.drag || !down) return;
        this.drag.dx = Math.round(x - this.drag.mx);
        this.drag.dy = Math.round(y - this.drag.my);
    }
    mouseUp(x, y) {
        const d = this.drag;
        if (!d) return;
        this.drag = null;
        const target = this.targetAt(Math.round(x), Math.round(y));
        if (!target) return; // snap back
        if (target.type === d.source.type && target.index === d.source.index) return;
        if (!this.canDrop(d.cards, target)) return;
        // take the cards off their source
        const s = d.source;
        if (s.type === 'waste') this.waste.pop();
        else if (s.type === 'foundation') this.foundations[s.index].pop();
        else {
            const col = this.columns[s.index];
            col.splice(s.from);
            const top = col[col.length - 1];
            if (top && !top.up) this.turnOver(top);
        }
        const dest = target.type === 'foundation' ? this.foundations[target.index] : this.columns[target.index];
        dest.push(...d.cards);
    }
    turnOver(c) {
        c.up = true;
        c.flipAt = this.now();
    }

    // --- drawing
    drawCard(bm, sheet, c, x, y, t) {
        const face = key(c);
        const p = c.flipAt >= 0 ? (t - c.flipAt) / FLIP : 1;
        if (!c.up) return bm.blit(sheet, x, y, BACK);
        if (p >= 1 || p < 0) return bm.blit(sheet, x, y, face);
        // turning over: the back narrows to an edge, the face widens out of it
        const frame = p < 0.5 ? BACK : face;
        const w = Math.max(1, Math.round(CW * Math.abs(1 - 2 * p)));
        this.blitSqueezed(bm, sheet, frame, x + Math.floor((CW - w) / 2), y, w);
    }
    blitSqueezed(bm, s, frame, x, y, w) {
        const sx0 = frame * s.frameW;
        for (let yy = 0; yy < s.h; yy++) {
            const row = yy * s.w + sx0;
            for (let xx = 0; xx < w; xx++) {
                const sx = w === 1 ? 0 : Math.round((xx * (CW - 1)) / (w - 1));
                if (!s.alpha[row + sx]) continue;
                bm.set(x + xx, y + yy, w === 1 ? 1 : s.ink[row + sx]);
            }
        }
    }
    draw(bm, t) {
        const sheet = this.sprite('SolitaireCards');
        if (!sheet) return;
        const d = this.drag;
        const lifted = (c) => d && d.cards.includes(c);

        // stock: the back, a little thicker while it holds more cards
        if (this.stock.length) {
            const s = this.slot(0);
            const extra = this.stock.length > 12 ? 2 : this.stock.length > 1 ? 1 : 0;
            for (let i = extra; i >= 0; i--) bm.blit(sheet, s.x + i, s.y + i, i ? EMPTY : BACK);
        }
        // waste: the top card, and the one under it while the top turns or is carried off
        const ws = this.slot(1);
        const visibleWaste = this.waste.filter((c) => !lifted(c));
        const wTop = visibleWaste[visibleWaste.length - 1];
        if (wTop) {
            const under = visibleWaste[visibleWaste.length - 2];
            if (under && wTop.flipAt >= 0 && t - wTop.flipAt < FLIP) this.drawCard(bm, sheet, under, ws.x, ws.y, t);
            this.drawCard(bm, sheet, wTop, ws.x, ws.y, t);
        }
        // foundations
        for (let f = 0; f < 4; f++) {
            const pile = this.foundations[f].filter((c) => !lifted(c));
            const top = pile[pile.length - 1];
            if (top) {
                const r = this.foundationRect(f);
                this.drawCard(bm, sheet, top, r.x, r.y, t);
            }
        }
        // tableau
        for (let c = 0; c < 7; c++) {
            const col = this.columns[c];
            for (let i = 0; i < col.length; i++) {
                if (lifted(col[i])) break;
                this.drawCard(bm, sheet, col[i], this.columnX(c), this.cardY(col, i), t);
            }
        }
        // the cards in the hand, at the drag offset
        if (d) {
            let y = d.y0 + d.dy;
            for (const c of d.cards) {
                bm.blit(sheet, d.x0 + d.dx, y, key(c));
                y += UP_DY;
            }
        }
    }
}

export const controls = { solitaire: SolitaireControl };
