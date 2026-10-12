// Excel: Microsoft Excel 1.0 for the Macintosh (1985), an added scene.
//
// `add spreadsheet at X, Y [size W, H]` is anchored TOP-LEFT (a grid reads
// naturally from its origin): (X, Y) is the crossing of the grid line left of
// column A and the line above row 1 (30, 77 in Excel.png). Columns are 64 px,
// rows 16 px; cell (c, r) spans the lines X + 64c .. X + 64(c + 1) and
// Y + 16r .. Y + 16(r + 1). `size W, H` is the visible grid area (default
// 461 x 244, up to the scroll bars); cells outside it are never drawn or hit.
//
// The control owns everything that changes: cell contents (Geneva 9, text
// left-aligned and spilling into empty neighbours, numbers right-aligned), the
// bold cell cursor, the inverted range selection, and the formula bar (the
// reference box "B2" and the entry, Chicago 12, with the cancel / enter boxes
// and a blinking insertion point while an entry is being typed). The formula
// bar sits at fixed screen positions in Excel.png (FORMULA below).
//
// Behaviour: mouse down on a cell commits a pending entry and makes the cell
// active; dragging extends the selection from it (the range is inverted, the
// active cell stays white). Typed characters start / extend an entry shown in
// both the formula bar and the active cell; '\n' commits it and moves down one
// row. A committed "=SUM(B2:B5)" is evaluated (sum of the numeric cells of the
// rectangle); any other formula shows #NAME?.

import { Control, inRect } from '../controls.js';

export const program = 'Excel';
export const images = { Excel: null };
export const fonts = ['Geneva9', 'Chicago12'];

const CW = 64, RH = 16;
const FORMULA = {
    refX: 6, // reference box text (box x 1..62, divider at x 63)
    baseline: 33, // Chicago 12 baseline in the bar (rows 20..37, bottom line 38)
    cancel: { x: 69, y: 21, w: 15, h: 15 },
    enter: { x: 88, y: 21, w: 15, h: 15 },
    textX: 112,
    right: 508,
};
const CANCEL = ['#.......#', '##.....##', '.##...##.', '..##.##..', '...###...', '..##.##..', '.##...##.', '##.....##', '#.......#'];
const ENTER = ['........#', '.......##', '......##.', '#....##..', '##..##...', '.####....', '..##.....', '..#......', '.........'];

const colName = (c) => String.fromCharCode(65 + c);
const refName = (p) => `${colName(p.c)}${p.r + 1}`;
const NUMBER = /^-?\d+(\.\d+)?$/;
const SUM = /^=SUM\(([A-Z])(\d+):([A-Z])(\d+)\)$/i;

function formatNumber(n) {
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 100) / 100);
}

class SpreadsheetControl extends Control {
    reset() {
        this.cols = Math.ceil((this.ins.w ?? 461) / CW);
        this.rows = Math.ceil((this.ins.h ?? 244) / RH);
        this.area = { x: this.x, y: this.y, w: this.ins.w ?? 461, h: this.ins.h ?? 244 };
        this.cells = new Map(); // "c,r" -> raw entry ("Macintosh", "512", "=SUM(B2:B5)")
        this.active = { c: 0, r: 0 };
        this.anchor = { c: 0, r: 0 };
        this.head = { c: 0, r: 0 };
        this.editing = false;
        this.entry = '';
        this.dragging = false;
        this.editStart = 0;
    }

    // --- model
    raw(c, r) {
        return this.cells.get(`${c},${r}`) ?? '';
    }
    // {text, number} as displayed; number = the numeric value or null
    display(c, r, depth = 0) {
        const raw = this.raw(c, r);
        if (raw === '') return { text: '', number: null };
        if (NUMBER.test(raw)) return { text: formatNumber(parseFloat(raw)), number: parseFloat(raw) };
        if (raw[0] !== '=') return { text: raw, number: null };
        const m = raw.match(SUM);
        if (!m || depth > 8) return { text: '#NAME?', number: null };
        const c0 = m[1].toUpperCase().charCodeAt(0) - 65, c1 = m[3].toUpperCase().charCodeAt(0) - 65;
        const r0 = parseInt(m[2], 10) - 1, r1 = parseInt(m[4], 10) - 1;
        let sum = 0;
        for (let cc = Math.min(c0, c1); cc <= Math.max(c0, c1); cc++)
            for (let rr = Math.min(r0, r1); rr <= Math.max(r0, r1); rr++) {
                if (cc === c && rr === r) continue; // a circular reference counts as 0
                const v = this.display(cc, rr, depth + 1);
                if (v.number != null) sum += v.number;
            }
        return { text: formatNumber(sum), number: sum };
    }
    commit() {
        if (!this.editing) return;
        const key = `${this.active.c},${this.active.r}`;
        if (this.entry === '') this.cells.delete(key);
        else this.cells.set(key, this.entry);
        this.editing = false;
        this.entry = '';
    }
    select(p) {
        this.active = { ...p };
        this.anchor = { ...p };
        this.head = { ...p };
    }

    // --- input
    hit(x, y, clamp = false) {
        let c = Math.floor((x - this.x) / CW), r = Math.floor((y - this.y) / RH);
        if (clamp) {
            c = Math.max(0, Math.min(this.cols - 1, c));
            r = Math.max(0, Math.min(this.rows - 1, r));
        } else if (!inRect(this.area, x, y)) return null;
        return { c, r };
    }
    mouseDown(x, y) {
        const p = this.hit(x, y);
        if (!p) return;
        this.commit();
        this.select(p);
        this.dragging = true;
    }
    mouseMove(x, y, down) {
        if (this.dragging && down) this.head = this.hit(x, y, true);
    }
    mouseUp() {
        this.dragging = false;
    }
    typeCharacter(ch) {
        if (ch === '\n') {
            this.commit();
            this.select({ c: this.active.c, r: Math.min(this.rows - 1, this.active.r + 1) });
            return;
        }
        if (!this.editing) {
            this.editing = true;
            this.entry = '';
            this.editStart = this.scene.time ?? 0;
            this.select(this.active); // typing collapses a range to the active cell
        }
        this.entry += ch;
    }

    // --- drawing
    cellLeft(c) {
        return this.x + c * CW;
    }
    cellTop(r) {
        return this.y + r * RH;
    }
    clipped(bm, x0, y0, x1, y1) {
        return { set: (x, y, v) => x >= x0 && x < x1 && y >= y0 && y < y1 && bm.set(x, y, v) };
    }
    drawCell(bm, f, c, r, text, number) {
        if (!text) return;
        const left = this.cellLeft(c), top = this.cellTop(r);
        const bottom = Math.min(top + RH, this.y + this.area.h);
        const gridRight = this.x + this.area.w;
        const baseline = top + 12;
        if (number) {
            const w = f.measure(text);
            f.draw(this.clipped(bm, left + 1, top + 1, Math.min(left + CW, gridRight), bottom), left + CW - 3 - w, baseline, text);
            return;
        }
        // text spills into empty cells on its right, like Excel
        let right = left + CW;
        const need = left + 3 + f.measure(text);
        for (let cc = c + 1; right < need && cc < this.cols && this.raw(cc, r) === '' && !(this.editing && this.active.c === cc && this.active.r === r); cc++) right += CW;
        // the spilled text covers the dotted grid lines it crosses
        if (right > left + CW) bm.fillRect(left + CW, top + 1, Math.min(right, gridRight) - left - CW, RH - 1, 0);
        f.draw(this.clipped(bm, left + 1, top + 1, Math.min(right, gridRight), bottom), left + 3, baseline, text);
    }
    drawPattern(bm, rows, x, y) {
        rows.forEach((row, j) => [...row].forEach((ch, i) => ch === '#' && bm.set(x + i, y + j, 1)));
    }
    box(bm, r) {
        bm.fillRect(r.x, r.y, r.w, 1, 1);
        bm.fillRect(r.x, r.y + r.h - 1, r.w, 1, 1);
        bm.fillRect(r.x, r.y, 1, r.h, 1);
        bm.fillRect(r.x + r.w - 1, r.y, 1, r.h, 1);
    }
    draw(bm, t) {
        const geneva = this.font('Geneva9');
        const chicago = this.font('Chicago12');

        // cell contents
        for (let r = 0; r < this.rows; r++)
            for (let c = 0; c < this.cols; c++) {
                if (this.editing && c === this.active.c && r === this.active.r) {
                    this.drawCell(bm, geneva, c, r, this.entry, false);
                    continue;
                }
                const v = this.display(c, r);
                this.drawCell(bm, geneva, c, r, v.text, v.number != null);
            }

        // range selection: inverted, except the active cell
        const c0 = Math.min(this.anchor.c, this.head.c), c1 = Math.max(this.anchor.c, this.head.c);
        const r0 = Math.min(this.anchor.r, this.head.r), r1 = Math.max(this.anchor.r, this.head.r);
        const gx1 = this.x + this.area.w, gy1 = this.y + this.area.h;
        const inv = (x0, y0, x1, y1) => bm.invertRect(x0, y0, Math.min(x1, gx1) - x0, Math.min(y1, gy1) - y0);
        if (c1 > c0 || r1 > r0) {
            inv(this.cellLeft(c0) + 1, this.cellTop(r0) + 1, this.cellLeft(c1 + 1), this.cellTop(r1 + 1));
            inv(this.cellLeft(this.active.c) + 1, this.cellTop(this.active.r) + 1, this.cellLeft(this.active.c + 1), this.cellTop(this.active.r + 1));
        }

        // the bold cell cursor: two pixels, over the grid line and just inside it
        const ax = this.cellLeft(this.active.c), ay = this.cellTop(this.active.r);
        const clip = this.clipped(bm, this.x, this.y, gx1, gy1);
        for (let k = 0; k < 2; k++) {
            for (let x = ax + k; x <= ax + CW - k; x++) {
                clip.set(x, ay + k, 1);
                clip.set(x, ay + RH - k, 1);
            }
            for (let y = ay + k; y <= ay + RH - k; y++) {
                clip.set(ax + k, y, 1);
                clip.set(ax + CW - k, y, 1);
            }
        }

        // formula bar: reference box, cancel / enter boxes while typing, the entry
        chicago.draw(bm, FORMULA.refX, FORMULA.baseline, refName(this.active));
        const text = this.editing ? this.entry : this.raw(this.active.c, this.active.r);
        const barClip = this.clipped(bm, FORMULA.textX, 20, FORMULA.right, 38);
        const end = chicago.draw(barClip, FORMULA.textX, FORMULA.baseline, text);
        if (this.editing) {
            this.box(bm, FORMULA.cancel);
            this.box(bm, FORMULA.enter);
            this.drawPattern(bm, CANCEL, FORMULA.cancel.x + 3, FORMULA.cancel.y + 3);
            this.drawPattern(bm, ENTER, FORMULA.enter.x + 3, FORMULA.enter.y + 3);
            if (Math.floor((t - this.editStart) / 0.53) % 2 === 0) bm.fillRect(Math.min(end, FORMULA.right - 1), 22, 1, 14, 1);
        }
    }
}

export const controls = { spreadsheet: SpreadsheetControl };
