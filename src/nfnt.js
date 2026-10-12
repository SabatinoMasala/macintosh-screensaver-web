// Classic Macintosh bitmap font resource (FONT / NFNT) decoder.
//
// Layout (all big-endian 16-bit words, see Inside Macintosh: Text):
//   fontType, firstChar, lastChar, widMax, kernMax, nDescent, fRectWidth,
//   fRectHeight, owTLoc, ascent, descent, leading, rowWords,
//   bitImage[rowWords * 2 * fRectHeight],
//   locTable[lastChar - firstChar + 3],
//   owTable[lastChar - firstChar + 3]  (high byte: offset, low byte: width)
//
// The strike is one long bitmap containing every glyph side by side; glyph i
// occupies columns locTable[i] .. locTable[i+1]-1.

export class NFNTFont {
    constructor(buffer, name = 'font') {
        const dv = new DataView(buffer);
        const u16 = (o) => dv.getUint16(o);
        const i16 = (o) => dv.getInt16(o);
        this.name = name;
        this.fontType = u16(0);
        this.firstChar = u16(2);
        this.lastChar = u16(4);
        this.widMax = u16(6);
        this.kernMax = i16(8);
        this.nDescent = i16(10);
        this.fRectWidth = u16(12);
        this.fRectHeight = u16(14);
        this.owTLoc = u16(16);
        this.ascent = u16(18);
        this.descent = u16(20);
        this.leading = u16(22);
        this.rowWords = u16(24);
        this.lineHeight = this.ascent + this.descent + this.leading;

        const rowBytes = this.rowWords * 2;
        const strikeSize = rowBytes * this.fRectHeight;
        const strike = new Uint8Array(buffer, 26, strikeSize);
        this.strikeWidth = this.rowWords * 16;
        this.strike = strike;
        this.rowBytes = rowBytes;

        const n = this.lastChar - this.firstChar + 3;
        const locOffset = 26 + strikeSize;
        const owOffset = 16 + this.owTLoc * 2;
        this.loc = [];
        for (let i = 0; i < n && locOffset + i * 2 + 1 < buffer.byteLength; i++) {
            this.loc.push(u16(locOffset + i * 2));
        }
        this.ow = [];
        for (let i = 0; i < n && owOffset + i * 2 + 1 < buffer.byteLength; i++) {
            this.ow.push(u16(owOffset + i * 2));
        }
        this.glyphs = new Map();
    }

    // Returns {offset, width, cols: [x0, x1)} or null if the character is missing.
    glyph(code) {
        if (this.glyphs.has(code)) return this.glyphs.get(code);
        let i = code - this.firstChar;
        const missing = this.lastChar - this.firstChar + 1;
        if (code < this.firstChar || code > this.lastChar || this.ow[i] === 0xffff || this.ow[i] === undefined) {
            i = missing;
        }
        const ow = this.ow[i];
        if (ow === undefined || ow === 0xffff) {
            this.glyphs.set(code, null);
            return null;
        }
        const g = {
            offset: (ow >> 8) << 24 >> 24, // signed high byte
            width: ow & 0xff,
            x0: this.loc[i],
            x1: this.loc[i + 1] ?? this.loc[i],
        };
        this.glyphs.set(code, g);
        return g;
    }

    strikeBit(x, y) {
        return (this.strike[y * this.rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
    }

    measure(text) {
        let w = 0;
        for (const ch of text) {
            const g = this.glyph(macRomanCode(ch));
            if (g) w += g.width;
        }
        return w;
    }

    // Draws text with the pen at (x, baselineY) onto a target exposing set(x, y, v).
    // Returns the advanced pen x.
    draw(target, x, baselineY, text, value = 1) {
        let pen = x;
        for (const ch of text) {
            const g = this.glyph(macRomanCode(ch));
            if (!g) continue;
            const left = pen + this.kernMax + g.offset;
            const top = baselineY - this.ascent;
            for (let sx = g.x0; sx < g.x1; sx++) {
                for (let sy = 0; sy < this.fRectHeight; sy++) {
                    if (this.strikeBit(sx, sy)) target.set(left + (sx - g.x0), top + sy, value);
                }
            }
            pen += g.width;
        }
        return pen;
    }
}

// The scripts only type ASCII; map a few typographic characters to Mac Roman.
const macRomanExtra = { '’': 0xd5, '‘': 0xd4, '“': 0xd2, '”': 0xd3, '…': 0xc9, '•': 0xa5 };
export function macRomanCode(ch) {
    const c = ch.codePointAt(0);
    if (c < 128) return c;
    return macRomanExtra[ch] ?? 0x3f;
}
