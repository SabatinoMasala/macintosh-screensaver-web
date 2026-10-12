// Classic Macintosh cursor resources.
//
// CURS: 16 rows x 16 bits of image, 16 rows x 16 bits of mask, hotspot (v, h).
// acur: count, then the CURS ids of the animation frames (each as 32-bit word).

export class Cursor {
    constructor(buffer, id) {
        const dv = new DataView(buffer);
        this.id = id;
        this.data = new Uint16Array(16);
        this.mask = new Uint16Array(16);
        for (let r = 0; r < 16; r++) {
            this.data[r] = dv.getUint16(r * 2);
            this.mask[r] = dv.getUint16(32 + r * 2);
        }
        this.hotY = dv.getInt16(64);
        this.hotX = dv.getInt16(66);
    }

    bit(arr, x, y) {
        return (arr[y] >> (15 - x)) & 1;
    }

    // Classic cursor compositing: dst = (dst & ~mask) | data, with the hotspot at (hx, hy).
    draw(target, hx, hy) {
        const ox = hx - this.hotX;
        const oy = hy - this.hotY;
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                const m = this.bit(this.mask, x, y);
                const d = this.bit(this.data, x, y);
                if (m) target.set(ox + x, oy + y, d);
                else if (d) target.set(ox + x, oy + y, 1); // data outside the mask XORs on the real Mac; treat as ink
            }
        }
    }
}

export function parseAcur(buffer) {
    const dv = new DataView(buffer);
    const count = dv.getUint16(0);
    const ids = [];
    for (let i = 0; i < count; i++) ids.push(dv.getInt16(4 + i * 4));
    return ids;
}

export class AnimatedCursor {
    constructor(frames, framePeriod) {
        this.frames = frames; // Cursor[]
        this.framePeriod = framePeriod; // seconds per frame
    }
    at(t) {
        const i = Math.floor(t / this.framePeriod) % this.frames.length;
        return this.frames[(i + this.frames.length) % this.frames.length];
    }
}

// Cursor ids used by the extension (resource ids in the bundle).
export const CURSOR_IDS = {
    arrow: 0,
    ibeam: 1,
    crosshair: 2,
    watch: 4,
};

// Animated cursor resources: acur id -> what the scripts call it.
export const ACUR_NAMES = {
    Watch: 2400,   // 4, 2400..2406
    Ball: 128,     // 25001..25008 (the spinning beach ball)
    Hand: 640,     // 128..136 (the pointing hand)
    Clarus: -20714 // -20714..-20709 (the dogcow)
};
