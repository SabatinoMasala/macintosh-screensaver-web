// Interpreter for a parsed program. It is driven frame by frame: step(dt)
// advances the running interpolations and executes instructions until one of
// them blocks (a timed interpolation, a wait, typing, ...).
//
// Targets that can be interpolated: camera (vec2, degrees), scroll (vec2,
// bitmap pixels), mouse (vec2, bitmap pixels), scale and zoom (0..1).

import { ease } from './easing.js';

const TYPING_RATE = 12; // characters per second for `keyboard "..."`
const CLICK_HOLD = 0.08; // seconds a `mouse click` keeps the button down

class Interpolation {
    constructor(target, from, to, duration, curve) {
        this.target = target;
        this.from = from;
        this.to = to;
        this.duration = duration;
        this.curve = curve;
        this.elapsed = 0;
        this.done = duration <= 0;
    }
    get remaining() {
        return Math.max(0, this.duration - this.elapsed);
    }
    valueAt(elapsed) {
        const k = this.duration > 0 ? ease(this.curve, elapsed / this.duration) : 1;
        if (Array.isArray(this.to)) return this.to.map((v, i) => this.from[i] + (v - this.from[i]) * k);
        return this.from + (this.to - this.from) * k;
    }
    advance(dt) {
        if (this.done) return this.to;
        this.elapsed += dt;
        if (this.elapsed >= this.duration) {
            this.done = true;
            return this.to;
        }
        return this.valueAt(this.elapsed);
    }
}

export class Processor {
    constructor(program, scene) {
        this.program = program;
        this.scene = scene;
        this.ip = 0;
        this.stack = [];
        this.asyncs = new Map(); // id -> Interpolation
        this.running = []; // all live interpolations (async + blocking)
        this.blocking = null; // {type, ...}
        this.simultaneous = null; // array of interpolations started inside a block
        this.finished = false;
        this.time = 0;
    }

    get vars() {
        return this.scene.vars;
    }

    step(dt) {
        if (this.finished) return;
        this.time += dt;
        // advance interpolations
        for (const it of this.running) {
            const v = it.advance(dt);
            this.vars[it.target] = v;
        }
        this.running = this.running.filter((it) => !it.done);
        for (const [id, it] of this.asyncs) if (it.done) this.asyncs.delete(id);

        // resolve blocking conditions
        if (this.blocking) {
            const b = this.blocking;
            switch (b.type) {
                case 'interp':
                    if (b.interp.done) this.blocking = null;
                    break;
                case 'wait':
                    b.remaining -= dt;
                    if (b.remaining <= 0) this.blocking = null;
                    break;
                case 'waitid': {
                    const it = this.asyncs.get(b.id);
                    if (!it || it.done || it.remaining <= b.before) this.blocking = null;
                    break;
                }
                case 'sim':
                    if (b.interps.every((it) => it.done)) this.blocking = null;
                    break;
                case 'typing':
                    b.accum += dt * TYPING_RATE;
                    while (b.accum >= 1 && b.index < b.text.length) {
                        this.scene.typeCharacter(b.text[b.index++]);
                        b.accum -= 1;
                    }
                    if (b.index >= b.text.length) this.blocking = null;
                    break;
                case 'click':
                    b.remaining -= dt;
                    if (b.remaining <= 0) {
                        this.scene.setMouseButton(false);
                        this.blocking = null;
                    }
                    break;
            }
            if (this.blocking) return;
        }

        // execute instructions until something blocks
        let guard = 0;
        while (!this.blocking && !this.finished && guard++ < 10000) {
            if (this.ip >= this.program.instructions.length) {
                this.finished = true;
                break;
            }
            const ins = this.program.instructions[this.ip++];
            this.execute(ins);
        }
    }

    startInterp(ins) {
        const from = this.vars[ins.target];
        const it = new Interpolation(ins.target, Array.isArray(from) ? from.slice() : from, ins.value, ins.duration, ins.curve);
        // the original stores copysign(1, to - from) (0 when equal) next to the scale value;
        // the renderer multiplies the ramp direction by it
        if (ins.target === 'scale') this.vars.scaleDirection = Math.sign(ins.value - from);
        if (it.done) {
            this.vars[ins.target] = ins.value;
            return it;
        }
        this.running.push(it);
        if (ins.async) {
            const old = this.asyncs.get(ins.async);
            if (old) old.done = true;
            this.asyncs.set(ins.async, it);
        }
        return it;
    }

    execute(ins) {
        switch (ins.op) {
            case 'label':
                break;
            case 'let':
                this.scene.setVariable(ins.name, ins.value);
                break;
            case 'add':
                this.scene.addControl(ins);
                break;
            case 'reset':
                this.scene.resetControls();
                break;
            case 'interp': {
                const it = this.startInterp(ins);
                if (this.simultaneous) this.simultaneous.push(it);
                else if (!ins.async && !it.done) this.blocking = { type: 'interp', interp: it };
                break;
            }
            case 'mouse':
                if (ins.action === 'down') this.scene.setMouseButton(true);
                else if (ins.action === 'up') this.scene.setMouseButton(false);
                else {
                    this.scene.setMouseButton(true);
                    this.blocking = { type: 'click', remaining: CLICK_HOLD };
                }
                break;
            case 'keyboard':
                this.blocking = { type: 'typing', text: ins.text, index: 0, accum: 1 };
                break;
            case 'wait':
                this.blocking = { type: 'wait', remaining: ins.duration };
                break;
            case 'waitid':
                this.blocking = { type: 'waitid', id: ins.id, before: ins.before };
                break;
            case 'cancel': {
                const it = this.asyncs.get(ins.id);
                if (it) {
                    it.done = true;
                    this.asyncs.delete(ins.id);
                }
                break;
            }
            case 'simstart':
                this.simultaneous = [];
                break;
            case 'simend': {
                const pending = (this.simultaneous || []).filter((it) => !it.done);
                this.simultaneous = null;
                if (pending.length) this.blocking = { type: 'sim', interps: pending };
                break;
            }
            case 'goto':
                this.ip = this.program.labels.get(ins.name);
                break;
            case 'gosub':
                this.stack.push(this.ip);
                this.ip = this.program.labels.get(ins.name);
                break;
            case 'return':
                if (this.stack.length) this.ip = this.stack.pop();
                else this.finished = true;
                break;
            case 'exit':
                this.finished = true;
                break;
            default:
                throw new Error(`Unknown instruction ${ins.op}`);
        }
    }
}

// Picks programs in a random order without repeating the previous one.
export class Randomizer {
    constructor(items) {
        this.items = items;
        this.last = null;
    }
    next() {
        if (this.items.length === 1) return this.items[0];
        let pick;
        do pick = this.items[Math.floor(Math.random() * this.items.length)];
        while (pick === this.last);
        this.last = pick;
        return pick;
    }
}
