// The scene: the current 512x342 screen image, the controls layered on top of
// it, the mouse/cursor state and the script variables. compose(t) produces the
// 1-bit bitmap the renderer uploads.

import { Bitmap, SCENE_W, SCENE_H } from './bitmap.js';
import { createControl } from './controls.js';

export class Scene {
    constructor(resources) {
        this.res = resources; // {images, fonts, cursors, acurs}
        this.bitmap = new Bitmap();
        this.base = null;
        this.controls = [];
        this.radioGroup = null;
        this.mouse = { x: 0, y: 0, down: false };
        this.cursorTime = 0;
        this.vars = {
            image: null,
            scene: '',
            cursor: 'None',
            ramp: 'None',
            camera: [0, 0],
            scroll: [SCENE_W / 2, SCENE_H / 2],
            mouse: [0, 0],
            scale: 0,
            // sign(to - from) of the latest scale animation (+1 in, -1 out, 0 none):
            // the Processor field next to the scale value that signs the ramp direction
            scaleDirection: 0,
            zoom: 0,
        };
        this.log = [];
    }

    setVariable(name, value) {
        this.vars[name] = value;
        if (name === 'image') this.base = this.res.images[value] || null;
        if (name === 'scene') this.log.push(value);
    }

    get rampVector() {
        // bitmap space (y down); the binary's cases are none/left/right/up/down
        switch (String(this.vars.ramp).toLowerCase()) {
            case 'right': return [1, 0];
            case 'left': return [-1, 0];
            case 'up': return [0, -1];
            case 'down': return [0, 1];
            default: return [0, 0];
        }
    }

    addControl(ins) {
        const control = createControl(ins, this);
        if (!control) return;
        if (ins.kind === 'radiobuttongroup') {
            this.radioGroup = control;
        } else if (ins.kind === 'radiobutton' && this.radioGroup) {
            this.radioGroup.add(control);
        }
        this.controls.push(control);
    }

    resetControls() {
        for (const c of this.controls) c.reset();
    }

    setMouseButton(down) {
        const was = this.mouse.down;
        this.mouse.down = down;
        const { x, y } = this.mouse;
        if (down && !was) for (const c of this.controls) c.mouseDown?.(x, y);
        if (!down && was) for (const c of this.controls) c.mouseUp?.(x, y);
    }

    typeCharacter(ch) {
        for (const c of this.controls) c.typeCharacter?.(ch);
    }

    // Action strings fired by buttons/radios ("1", "caretSlow", "time12Hour", ...)
    fireAction(action) {
        for (const c of this.controls) c.onAction?.(action);
    }

    // Which cursor shape is shown at the current mouse position.
    cursorShape() {
        const type = this.vars.cursor;
        if (type === 'None') return null;
        if (type === 'Automatic') {
            for (const c of this.controls) {
                const s = c.cursorAt?.(this.mouse.x, this.mouse.y);
                if (s) return s;
            }
            return 'Arrow';
        }
        return type;
    }

    update(t, dt) {
        this.time = t;
        const [mx, my] = this.vars.mouse;
        const moved = mx !== this.mouse.x || my !== this.mouse.y;
        this.mouse.x = mx;
        this.mouse.y = my;
        if (moved) for (const c of this.controls) c.mouseMove?.(mx, my, this.mouse.down);
        for (const c of this.controls) c.update?.(t, dt);
    }

    compose(t) {
        const bm = this.bitmap;
        if (this.base) bm.copyFrom(this.base.asBitmap());
        else bm.clear(0);
        for (const c of this.controls) c.draw(bm, t);
        const shape = this.cursorShape();
        if (shape) {
            const cursor = this.res.cursorFor(shape, t);
            if (cursor) cursor.draw(bm, Math.round(this.mouse.x), Math.round(this.mouse.y));
        }
        return bm;
    }
}

export { SCENE_W, SCENE_H };
