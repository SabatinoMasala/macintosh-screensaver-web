// A 1-bit scene bitmap (512x342, one byte per pixel: 0 = white, 1 = black)
// plus the image decoding helpers used to get the PNG resources into that form.

export const SCENE_W = 512;
export const SCENE_H = 342;

export class Bitmap {
    constructor(w = SCENE_W, h = SCENE_H) {
        this.w = w;
        this.h = h;
        this.data = new Uint8Array(w * h);
    }
    clear(v = 0) {
        this.data.fill(v);
    }
    get(x, y) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
        return this.data[y * this.w + x];
    }
    set(x, y, v) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        this.data[y * this.w + x] = v;
    }
    copyFrom(other) {
        this.data.set(other.data);
    }
    fillRect(x, y, w, h, v = 1) {
        const x0 = Math.max(0, x), y0 = Math.max(0, y);
        const x1 = Math.min(this.w, x + w), y1 = Math.min(this.h, y + h);
        for (let yy = y0; yy < y1; yy++) this.data.fill(v, yy * this.w + x0, yy * this.w + x1);
    }
    invertRect(x, y, w, h) {
        const x0 = Math.max(0, x), y0 = Math.max(0, y);
        const x1 = Math.min(this.w, x + w), y1 = Math.min(this.h, y + h);
        for (let yy = y0; yy < y1; yy++) {
            const row = yy * this.w;
            for (let xx = x0; xx < x1; xx++) this.data[row + xx] ^= 1;
        }
    }
    // Draw a sprite (a Sprite from decodeImage) with its top-left at (x, y).
    // Transparent sprite pixels (alpha 0 in the PNG) leave the destination alone.
    blit(sprite, x, y, frame = 0) {
        const fw = sprite.frameW, fh = sprite.h;
        const sx0 = frame * fw;
        for (let yy = 0; yy < fh; yy++) {
            const dy = y + yy;
            if (dy < 0 || dy >= this.h) continue;
            const srow = yy * sprite.w;
            const drow = dy * this.w;
            for (let xx = 0; xx < fw; xx++) {
                const dx = x + xx;
                if (dx < 0 || dx >= this.w) continue;
                const a = sprite.alpha[srow + sx0 + xx];
                if (!a) continue;
                this.data[drow + dx] = sprite.ink[srow + sx0 + xx];
            }
        }
    }
    // Like blit, but only paints the black pixels (transparent-white sprites such as glyph strikes).
    blitInk(sprite, x, y, frame = 0) {
        const fw = sprite.frameW, fh = sprite.h;
        const sx0 = frame * fw;
        for (let yy = 0; yy < fh; yy++) {
            const dy = y + yy;
            if (dy < 0 || dy >= this.h) continue;
            const srow = yy * sprite.w;
            const drow = dy * this.w;
            for (let xx = 0; xx < fw; xx++) {
                const dx = x + xx;
                if (dx < 0 || dx >= this.w) continue;
                if (sprite.alpha[srow + sx0 + xx] && sprite.ink[srow + sx0 + xx]) this.data[drow + dx] = 1;
            }
        }
    }
}

// A decoded PNG: ink (1 = black) and alpha (1 = opaque) per pixel, with an
// optional frame width for horizontal sprite sheets.
export class Sprite {
    constructor(w, h, ink, alpha, frameW = w) {
        this.w = w;
        this.h = h;
        this.ink = ink;
        this.alpha = alpha;
        this.frameW = frameW;
        this.frames = Math.floor(w / frameW);
    }
}

export function decodeImage(img, frameW) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const n = c.width * c.height;
    const ink = new Uint8Array(n);
    const alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
        alpha[i] = a >= 128 ? 1 : 0;
        ink[i] = (r + g + b) / 3 < 128 ? 1 : 0;
    }
    return new Sprite(c.width, c.height, ink, alpha, frameW || c.width);
}
