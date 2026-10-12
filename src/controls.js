// The controls a script can `add` to a scene. Each one draws itself into the
// 1-bit bitmap every frame and reacts to the scripted mouse / keyboard.
//
// Anchor conventions (pixel-verified against the scene images, see NOTES.md):
//   bottom-left: button, imagebutton, radiobutton, slider, caret, puzzle,
//                cursorrect, icon, findericon, canvas
//   top-left:    text, time, date, menu, startupicon
//   hotspot:     cursor

const TICK = 1 / 60;

export const inRect = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

export class Control {
    constructor(ins, scene) {
        this.ins = ins;
        this.scene = scene;
        this.name = ins.name;
        this.action = ins.action;
        this.value = ins.value;
        this.x = ins.x ?? 0;
        this.y = ins.y ?? 0;
        this.reset();
    }
    reset() {}
    draw() {}
    get res() {
        return this.scene.res;
    }
    sprite(name) {
        return this.res.images[name];
    }
    font(name, fallback = 'Geneva12') {
        return this.res.fonts[name] || this.res.fonts[fallback];
    }
}

// --- Button: an invisible hot rectangle that inverts while pressed and fires its action on release.
class Button extends Control {
    reset() {
        this.rect = { x: this.x, y: this.y - (this.ins.h ?? 16) + 1, w: this.ins.w ?? 16, h: this.ins.h ?? 16 };
        this.pressed = false;
    }
    mouseDown(x, y) {
        this.pressed = inRect(this.rect, x, y);
    }
    mouseUp(x, y) {
        if (this.pressed && inRect(this.rect, x, y) && this.action) this.scene.fireAction(this.action);
        this.pressed = false;
    }
    draw(bm) {
        if (this.pressed) bm.invertRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    }
}

// --- ImageButton: a two-frame sprite (normal, pressed), e.g. the Cancel button.
class ImageButton extends Button {
    draw(bm) {
        const s = this.sprite(this.name);
        if (!s) return super.draw(bm);
        if (this.pressed) bm.blit(s, this.rect.x, this.rect.y, Math.min(1, s.frames - 1));
    }
}

// --- RadioButtonGroup / RadioButton
class RadioButtonGroup extends Control {
    reset() {
        this.members = this.members || [];
    }
    add(rb) {
        this.members.push(rb);
        rb.group = this;
    }
    select(rb) {
        for (const m of this.members) m.selected = m === rb;
    }
}

class RadioButton extends Control {
    reset() {
        const w = this.ins.w ?? 16, h = this.ins.h ?? 16;
        this.rect = { x: this.x, y: this.y - h + 1, w, h };
        this.initial = this.value === 1;
        this.selected = this.initial;
        this.pressed = false;
        this.sheet = this.name && this.name !== 'None' ? this.name : this.ins.w == null ? 'RadioButton' : null;
    }
    mouseDown(x, y) {
        if (!inRect(this.rect, x, y)) return;
        this.pressed = true;
        if (this.group) this.group.select(this);
        else this.selected = true;
        if (this.action) this.scene.fireAction(this.action);
    }
    mouseUp() {
        this.pressed = false;
    }
    draw(bm) {
        const s = this.sheet && this.sprite(this.sheet);
        if (s) {
            // frames: off, off pressed, on, on pressed
            const frame = Math.min(s.frames - 1, (this.selected ? 2 : 0) + (this.pressed ? 1 : 0));
            bm.blit(s, this.rect.x, this.rect.y, frame);
        } else if (this.selected) {
            // list rows / tool cells: the base image never carries the highlight
            bm.invertRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
        }
    }
}

// --- Slider: a 23x11 knob on a vertical track; offset grows upward, snaps to 12 px steps.
class Slider extends Control {
    reset() {
        this.offset = this.value ?? 24;
        this.grab = null;
    }
    knobRect() {
        return { x: this.x, y: this.y - 10 - Math.round(this.offset), w: 23, h: 11 };
    }
    mouseDown(x, y) {
        if (inRect(this.knobRect(), x, y)) this.grab = { y, offset: this.offset };
    }
    mouseMove(x, y, down) {
        if (this.grab && down) this.offset = Math.min(85, Math.max(-1, this.grab.offset + (this.grab.y - y)));
    }
    mouseUp() {
        if (!this.grab) return;
        this.grab = null;
        this.offset = Math.floor((this.offset + 5) / 12) * 12;
        if (this.action) this.scene.fireAction(this.action);
    }
    draw(bm) {
        const s = this.sprite('Slider');
        const r = this.knobRect();
        if (s) bm.blit(s, r.x, r.y);
        else bm.fillRect(r.x, r.y, r.w, r.h, 1);
    }
}

// --- Text: typed text (MacWrite) or a right-aligned numeric display (calculator).
class Text extends Control {
    reset() {
        this.fontName = this.name || 'Geneva12';
        this.lines = [this.action ?? ''];
        this.rightAligned = this.action != null;
        this.maxChars = this.action != null ? this.value || 6 : Infinity;
        this.showCaret = this.action == null && (this.value ?? 1) > 0;
        this.selection = null; // {anchor:{line,col}, head:{line,col}}
        this.dragging = false;
    }
    get f() {
        return this.font(this.fontName);
    }
    typeCharacter(ch) {
        if (this.rightAligned) return;
        if (ch === '\n') this.lines.push('');
        else this.lines[this.lines.length - 1] += ch;
        this.selection = null;
    }
    onAction(action) {
        if (!this.rightAligned) return;
        if (!/^\d$/.test(action)) return;
        const cur = this.lines[0];
        const next = cur === '0' ? action : cur + action;
        if (next.length <= this.maxChars) this.lines[0] = next;
    }
    lineTop(i) {
        return this.y + i * this.f.lineHeight;
    }
    // caret position for a mouse point: {line, col}
    hit(x, y) {
        const f = this.f;
        const line = Math.max(0, Math.min(this.lines.length - 1, Math.floor((y - this.y) / f.lineHeight)));
        const text = this.lines[line];
        let col = 0, px = this.x;
        while (col < text.length) {
            const g = f.glyph(text.charCodeAt(col));
            const w = g ? g.width : 0;
            if (x < px + w / 2) break;
            px += w;
            col++;
        }
        return { line, col };
    }
    mouseDown(x, y) {
        if (this.rightAligned) return;
        const inside = x >= this.x - 4 && y >= this.y && y < this.lineTop(this.lines.length) && x < 500;
        if (!inside) return;
        const p = this.hit(x, y);
        this.selection = { anchor: p, head: p };
        this.dragging = true;
    }
    mouseMove(x, y, down) {
        if (this.dragging && down) this.selection.head = this.hit(x, y);
    }
    mouseUp() {
        this.dragging = false;
        if (this.selection && this.selection.anchor.line === this.selection.head.line && this.selection.anchor.col === this.selection.head.col) this.selection = null;
    }
    draw(bm, t) {
        const f = this.f;
        let caretX = this.x, caretLine = this.lines.length - 1;
        for (let i = 0; i < this.lines.length; i++) {
            const text = this.lines[i];
            const top = this.lineTop(i);
            const baseline = top + f.ascent;
            const width = f.measure(text);
            const left = this.rightAligned ? this.x - width : this.x;
            if (this.rightAligned) bm.fillRect(left - 2, top, width + 4, f.lineHeight, 0);
            const end = f.draw(bm, left, baseline, text);
            if (i === caretLine) caretX = end;
        }
        if (this.selection) this.drawSelection(bm);
        if (this.showCaret && !this.selection && Math.floor(t / 0.53) % 2 === 0) {
            const top = this.lineTop(caretLine);
            bm.fillRect(caretX, top, 1, f.ascent + f.descent, 1);
        }
    }
    drawSelection(bm) {
        const f = this.f;
        let { anchor: a, head: b } = this.selection;
        if (a.line > b.line || (a.line === b.line && a.col > b.col)) [a, b] = [b, a];
        for (let i = a.line; i <= b.line; i++) {
            const text = this.lines[i];
            const x0 = i === a.line ? this.x + f.measure(text.slice(0, a.col)) : this.x;
            const x1 = i === b.line ? this.x + f.measure(text.slice(0, b.col)) : this.x + f.measure(text);
            if (x1 > x0) bm.invertRect(x0, this.lineTop(i), x1 - x0, f.lineHeight);
        }
    }
}

// --- TimeText / DateText: the live clock, in the control panel's font.
class TimeText extends Control {
    reset() {
        this.fontName = this.name || 'Chicago12';
        this.hours24 = false;
        this.last = null;
    }
    onAction(action) {
        if (action === 'time12Hour') this.hours24 = false;
        if (action === 'time24Hour') this.hours24 = true;
    }
    text() {
        const d = new Date();
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        if (this.hours24) return `${String(d.getHours()).padStart(2, '0')}:${mm}:${ss}`;
        const h = d.getHours() % 12 || 12;
        const ampm = d.getHours() < 12 ? 'AM' : 'PM';
        // Chicago 12 is wide: the System 1 time field only has room without seconds.
        // `value` overrides: 1 = with seconds, 2 = without.
        const seconds = this.value ? this.value === 1 : this.fontName !== 'Chicago12';
        return seconds ? `${h}:${mm}:${ss} ${ampm}` : `${h}:${mm} ${ampm}`;
    }
    draw(bm) {
        const f = this.font(this.fontName, 'Chicago12');
        const text = this.text();
        const w = f.measure(text);
        bm.fillRect(this.x, this.y, Math.max(w, this.last || 0) + 2, f.ascent + f.descent, 0);
        f.draw(bm, this.x, this.y + f.ascent, text);
        this.last = w;
    }
}

class DateText extends TimeText {
    text() {
        const d = new Date();
        return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear() % 100).padStart(2, '0')}`;
    }
}

// --- Caret: a blinking insertion point (bottom-left anchored).
class Caret extends Control {
    reset() {
        this.w = this.ins.w ?? 1;
        this.h = this.ins.h ?? 15;
        this.interval = 0.5;
    }
    onAction(action) {
        if (action === 'caretSlow') this.interval = 0.75;
        if (action === 'caretNormal') this.interval = 0.5;
        if (action === 'caretFast') this.interval = 0.25;
    }
    draw(bm, t) {
        if (t % (this.interval * 2) < this.interval) bm.fillRect(this.x, this.y - this.h + 1, this.w, this.h, 1);
    }
}

// --- Puzzle: the 15-puzzle desk accessory. 4x4 cells of 19 px tiles on a 20 px pitch.
class Puzzle extends Control {
    reset() {
        // the empty cell starts top-left (the scripted clicks only make sense that way)
        this.cells = [];
        for (let i = 0; i < 16; i++) this.cells.push(i); // 0 = empty, 1..15 = tile number
    }
    cellRect(c, r) {
        return { x: this.x + 20 * c + 1, y: this.y - 80 + 1 + 20 * r + 1, w: 19, h: 19 };
    }
    mouseDown(x, y) {
        const c = Math.floor((x - this.x) / 20), r = Math.floor((y - (this.y - 80 + 1)) / 20);
        if (c < 0 || c > 3 || r < 0 || r > 3) return;
        const i = r * 4 + c;
        const e = this.cells.indexOf(0);
        const er = Math.floor(e / 4), ec = e % 4;
        if (Math.abs(er - r) + Math.abs(ec - c) === 1) {
            this.cells[e] = this.cells[i];
            this.cells[i] = 0;
        }
    }
    draw(bm) {
        const s = this.sprite('PuzzleTiles');
        if (!s) return;
        for (let i = 0; i < 16; i++) {
            const r = this.cellRect(i % 4, Math.floor(i / 4));
            bm.blit(s, r.x, r.y, this.cells[i]);
        }
    }
}

// --- Menu: a pull-down menu strip (`name`, default the MacWrite Style menu). Top-left
// anchored at any x; opens on mouse down in its title, tracks the item under the mouse,
// flashes the chosen item three times on release. `value` is the separator row's index.
class Menu extends Control {
    reset() {
        this.sheet = this.name || 'MacWriteStyleMenu';
        this.open = false;
        this.hilited = -1;
        this.flash = null; // {item, start}
        this.titleH = 20;
        this.itemH = 16;
        this.separator = this.value ?? 6;
    }
    get rect() {
        const s = this.sprite(this.sheet);
        return { x: this.x, y: this.y, w: s ? s.w : 119, h: s ? s.h : 213 };
    }
    itemAt(x, y) {
        const r = this.rect;
        if (!inRect(r, x, y) || y < this.y + this.titleH) return -1;
        const i = Math.floor((y - this.y - this.titleH) / this.itemH);
        return i === this.separator ? -1 : i;
    }
    mouseDown(x, y) {
        const r = this.rect;
        if (x >= r.x && x < r.x + r.w && y >= this.y && y < this.y + this.titleH && !this.flash) {
            this.open = true;
            this.hilited = -1;
        }
    }
    mouseMove(x, y, down) {
        if (this.open && down) this.hilited = this.itemAt(x, y);
    }
    mouseUp(x, y) {
        if (!this.open) return;
        const item = this.itemAt(x, y);
        if (item >= 0) this.flash = { item, start: this.scene.time };
        else this.open = false;
    }
    update(t) {
        if (this.flash && t - this.flash.start >= 0.6) {
            this.flash = null;
            this.open = false;
        }
    }
    draw(bm, t) {
        if (!this.open) return;
        const s = this.sprite(this.sheet);
        if (!s) return;
        bm.blit(s, this.x, this.y);
        let item = this.hilited;
        if (this.flash) item = (t - this.flash.start) % 0.2 < 0.1 ? this.flash.item : -1;
        if (item >= 0) bm.invertRect(this.x + 1, this.y + this.titleH + item * this.itemH, s.w - 2, this.itemH);
    }
}

// --- StartupIcon: the blinking "?" floppy; a click makes it the happy Mac.
class StartupIcon extends Control {
    reset() {
        this.sheet = this.name || 'StartupIcons';
        this.happy = false;
        this.happyAt = 0;
        this.rect = { x: this.x, y: this.y, w: 32, h: 32 };
    }
    mouseDown(x, y) {
        if (!this.happy && inRect(this.rect, x, y)) {
            this.happy = true;
            this.happyAt = this.scene.time ?? 0;
        }
    }
    draw(bm, t) {
        if (this.happy) {
            const anim = this.sprite('HappyMac');
            const s = this.sprite(this.sheet);
            const frame = Math.floor((t - this.happyAt) / (8 * TICK));
            if (anim && frame < anim.frames) bm.blit(anim, this.x, this.y, frame);
            else if (s) bm.blit(s, this.x, this.y, Math.min(2, s.frames - 1));
            return;
        }
        const s = this.sprite(this.sheet);
        if (!s) return;
        // the question mark blinks: 1.5 s period, 50 % duty
        bm.blit(s, this.x, this.y, t % 1.5 > 0.75 ? 0 : 1);
    }
}

// --- Cursor: a static (animated) cursor placed in the scene. Unlike the other
// controls, `at x, y` is the cursor's HOTSPOT (like `mouse to`), not its
// bottom-left corner: only that placement centres the IconGarden watch / ball
// in their holes (see NOTES.md, "Coordinate conventions").
class CursorControl extends Control {
    draw(bm, t) {
        const c = this.res.cursorFor(this.name, t);
        if (c) c.draw(bm, this.x, this.y);
    }
}

// --- CursorRect: a region in which the automatic cursor takes a given shape.
class CursorRect extends Control {
    reset() {
        this.rect = { x: this.x, y: this.y - (this.ins.h ?? 0) + 1, w: this.ins.w ?? 0, h: this.ins.h ?? 0 };
    }
    cursorAt(x, y) {
        return inRect(this.rect, x, y) ? this.name : null;
    }
}

// --- AnimatedIcon: a sprite strip advanced every `value` ticks (1/60 s).
class AnimatedIcon extends Control {
    reset() {
        this.ticks = this.value || 30;
    }
    draw(bm, t) {
        const s = this.sprite(this.name);
        if (!s) return;
        const frame = Math.floor(t / (this.ticks * TICK)) % s.frames;
        bm.blit(s, this.x, this.y - s.h + 1, frame);
    }
}

// --- FinderIcon: a 64x48 desktop icon with label. Can be selected and dragged to the trash.
class FinderIcon extends Control {
    reset() {
        this.rect = { x: this.x, y: this.y - (this.ins.h ?? 48) + 1, w: this.ins.w ?? 64, h: this.ins.h ?? 48 };
        this.selected = false;
        this.dragging = false;
        this.drag = [0, 0];
        this.hidden = false;
        this.full = false; // trash only
        this.isTrash = /Trash/i.test(this.name || '');
    }
    iconRect() {
        // the icon proper is the upper 32 px (label below), roughly centred
        return { x: this.rect.x + 16, y: this.rect.y, w: 32, h: 34 };
    }
    mouseDown(x, y) {
        if (this.hidden) return;
        if (inRect(this.rect, x, y)) {
            this.selected = true;
            if (!this.isTrash) {
                this.dragging = true;
                this.dragStart = [x, y];
                this.drag = [0, 0];
            }
        } else this.selected = false;
    }
    mouseMove(x, y, down) {
        if (this.dragging && down) this.drag = [x - this.dragStart[0], y - this.dragStart[1]];
        if (this.isTrash) {
            // highlight while another icon is dragged over us
            const dragged = this.scene.controls.find((c) => c instanceof FinderIcon && c.dragging);
            this.hover = !!dragged && inRect(this.rect, x, y);
        }
    }
    mouseUp(x, y) {
        if (this.dragging) {
            this.dragging = false;
            const trash = this.scene.controls.find((c) => c instanceof FinderIcon && c.isTrash && inRect(c.rect, x, y));
            if (trash) {
                this.hidden = true;
                trash.full = true;
                trash.hover = false;
                trash.selected = false;
            } else {
                this.drag = [0, 0];
            }
        }
    }
    draw(bm) {
        if (this.hidden) return;
        const s = this.sprite(this.name);
        if (!s) return;
        const sel = this.selected || this.hover;
        let frame = sel ? 1 : 0;
        if (this.isTrash && this.full) frame = sel ? 3 : 2;
        frame = Math.min(frame, s.frames - 1);
        bm.blit(s, this.rect.x, this.rect.y, frame);
        if (this.dragging && (this.drag[0] || this.drag[1])) {
            // the classic dotted drag outline of the icon
            const r = this.iconRect();
            const x = r.x + Math.round(this.drag[0]), y = r.y + Math.round(this.drag[1]);
            for (let i = 0; i < r.w; i += 2) {
                bm.set(x + i, y, 1);
                bm.set(x + i, y + r.h - 1, 1);
            }
            for (let j = 0; j < r.h; j += 2) {
                bm.set(x, y + j, 1);
                bm.set(x + r.w - 1, y + j, 1);
            }
        }
    }
}

// --- Canvas: a paintable area (MacPaint). Strokes are 4 px wide with round caps.
class Canvas extends Control {
    reset() {
        this.rect = { x: this.x, y: this.y - (this.ins.h ?? 50) + 1, w: this.ins.w ?? 140, h: this.ins.h ?? 50 };
        this.layer = new Uint8Array(this.rect.w * this.rect.h);
        this.painting = false;
        this.last = null;
    }
    dot(x, y) {
        // a 4x4 round brush centred on (x, y)
        for (let dy = -2; dy < 2; dy++)
            for (let dx = -2; dx < 2; dx++) {
                const cx = dx + 0.5, cy = dy + 0.5;
                if (cx * cx + cy * cy > 4.2) continue;
                const px = Math.round(x) + dx - this.rect.x, py = Math.round(y) + dy - this.rect.y;
                if (px >= 0 && py >= 0 && px < this.rect.w && py < this.rect.h) this.layer[py * this.rect.w + px] = 1;
            }
    }
    stroke(x0, y0, x1, y1) {
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
        for (let i = 0; i <= n; i++) this.dot(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
    }
    mouseDown(x, y) {
        if (!inRect(this.rect, x, y)) return;
        this.painting = true;
        this.last = [x, y];
        this.dot(x, y);
    }
    mouseMove(x, y, down) {
        if (!this.painting || !down) return;
        this.stroke(this.last[0], this.last[1], x, y);
        this.last = [x, y];
    }
    mouseUp() {
        this.painting = false;
    }
    draw(bm) {
        const { x, y, w, h } = this.rect;
        for (let j = 0; j < h; j++) {
            const row = j * w;
            for (let i = 0; i < w; i++) if (this.layer[row + i]) bm.set(x + i, y + j, 1);
        }
    }
}

const KINDS = {
    button: Button,
    imagebutton: ImageButton,
    radiobutton: RadioButton,
    radiobuttongroup: RadioButtonGroup,
    slider: Slider,
    text: Text,
    time: TimeText,
    date: DateText,
    caret: Caret,
    puzzle: Puzzle,
    menu: Menu,
    startupicon: StartupIcon,
    cursor: CursorControl,
    cursorrect: CursorRect,
    icon: AnimatedIcon,
    findericon: FinderIcon,
    canvas: Canvas,
};

// Scene modules (src/scenes/*.js) add their own control kinds here.
export function registerControl(kind, Cls) {
    KINDS[kind] = Cls;
}

export function createControl(ins, scene) {
    const Cls = KINDS[ins.kind];
    if (!Cls) {
        console.warn('Unknown control', ins.kind);
        return null;
    }
    return new Cls(ins, scene);
}
