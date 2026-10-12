// Loads everything the player needs: programs, images (decoded to 1-bit sprites),
// fonts (NFNT) and cursors (CURS + acur).
//
// Two trees: the project's own files live in assets/<type>/, Apple's resources
// (extracted locally by scripts/extract-apple-assets.sh, never committed) in
// assets/apple/<type>/. The APPLE_* lists below say which names are Apple's;
// every font and cursor is. A missing asset never stops the player: every
// program whose script, images or fonts did not load is left out (res.unavailable),
// and res.apple.installed tells main.js whether Apple's tree is there at all.

import { parseProgram } from './dsl.js';
import { decodeImage, Bitmap } from './bitmap.js';
import { NFNTFont } from './nfnt.js';
import { Cursor, AnimatedCursor, parseAcur, CURSOR_IDS, ACUR_NAMES } from './curs.js';
import { loadSceneModules } from './scenes/index.js';

// Apple's 15 scene scripts (WALLPAPER_PROGRAM included) and 32 images, as found
// in WallpaperMacintoshExtension.appex. Keep in step with scripts/extract-apple-assets.sh.
export const APPLE_PROGRAMS = [
    'StartupHappyMac', 'StartupWelcome', 'Finder', 'IconGarden', 'IconGardenWallpaper', 'MacPaint', 'MacPaintHello',
    'MacWrite', 'MacWriteTextInput', 'MacWriteStyleMenu', 'System1ControlPanel', 'System6ControlPanel',
    'DeskAccessories', 'AlertSounds', 'QuitDialog',
];
export const APPLE_IMAGES = [
    'AlertSounds', 'Bomb', 'CancelButton', 'Clarus', 'CloseBox', 'DeskAccessories', 'Disks', 'FinderTrash',
    'FinderWindow', 'FolderIcon', 'HappyMac', 'IconGarden', 'MacPaint', 'MacPaintHello', 'MacWrite1984',
    'MacWriteCrazyOnes', 'MacWriteEmpty', 'MacWriteStyleMenu', 'PuzzleTiles', 'QuitDialog', 'RadioButton',
    'RadioButtonSystem1Number0', 'RadioButtonSystem1Number1', 'ResEdit', 'Slider', 'StartupDesktop',
    'StartupIcons', 'StartupWelcome', 'System1ControlPanel', 'System6ControlPanel', 'Trash', 'TrashIcon',
];

// The playlist: Apple's scenes, then the ones added by this project.
export const PROGRAMS = [
    'StartupHappyMac', 'StartupWelcome', 'Finder', 'IconGarden', 'MacPaint', 'MacPaintHello', 'MacPaintSabatino',
    'MacWrite', 'MacWriteTextInput', 'MacWriteStyleMenu', 'System1ControlPanel',
    'System6ControlPanel', 'DeskAccessories', 'AlertSounds', 'QuitDialog',
    // scenes added by this project (not in Apple's set)
    'Scrapbook', 'NotePad', 'SystemError', 'AlarmClock', 'AppleMenu',
];
export const WALLPAPER_PROGRAM = 'IconGardenWallpaper';

// Sprite sheets: frame width (all sheets are horizontal strips).
const FRAME_WIDTHS = {
    HappyMac: 32, StartupIcons: 32, ResEdit: 32, CloseBox: 32, Bomb: 32, Trash: 32, Clarus: 32, Disks: 32,
    FolderIcon: 64, TrashIcon: 64, RadioButton: 16, RadioButtonSystem1Number0: 16, RadioButtonSystem1Number1: 16,
    CancelButton: 74, PuzzleTiles: 19,
};
const IMAGES = [
    ...APPLE_IMAGES,
    // images of the scenes added by this project
    'Scrapbook', 'ScrapbookPage2', 'NotePad', 'SystemError', 'AlarmClock', 'AlarmClockOpen', 'AppleMenu',
];
// fonts and cursors: all Apple's
const FONTS = ['Chicago12', 'Geneva12', 'Geneva9', 'Monaco9'];
const CURS_IDS = [0, 1, 2, 4, 128, 129, 130, 131, 132, 133, 134, 135, 136, 2400, 2401, 2402, 2403, 2404, 2405, 2406,
    25001, 25002, 25003, 25004, 25005, 25006, 25007, 25008, -20709, -20710, -20711, -20712, -20713, -20714];
const ACUR_IDS = [128, 640, 2400, -20714];

const APPLE = { programs: new Set(APPLE_PROGRAMS), images: new Set(APPLE_IMAGES) };
// assets/<type>/<file> for the project's own files, assets/apple/<type>/<file> for Apple's
const assetUrl = (base, type, name, file) =>
    type === 'fonts' || type === 'cursors' || APPLE[type]?.has(name) ? `${base}/apple/${type}/${file}` : `${base}/${type}/${file}`;

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load ' + url));
        img.src = url;
    });
}
async function loadBuffer(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Failed to load ' + url);
    return r.arrayBuffer();
}
async function loadText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Failed to load ' + url);
    return r.text();
}

// Is Apple's tree there at all? Two probes, so a fresh clone costs two 404s
// instead of one per Apple file. A partial install loads file by file.
async function appleTreePresent(base) {
    for (const url of [`${base}/apple/fonts/Chicago12.bin`, `${base}/apple/programs/Finder.program`]) {
        try {
            const r = await fetch(url, { method: 'HEAD' });
            if (r.ok) return true;
        } catch {}
    }
    return false;
}

// The images and fonts a program cannot run without: its base images, the
// sprites and fonts its controls name, the defaults of the built-in control kinds
// (see controls.js) and whatever its scene module declares.
function programNeeds(program, declared = {}) {
    const images = new Set(declared.images || []);
    const fonts = new Set(declared.fonts || []);
    for (const ins of program.instructions) {
        if (ins.op === 'let' && ins.name === 'image') images.add(ins.value);
        if (ins.op !== 'add') continue;
        const name = ins.name && ins.name !== 'None' ? ins.name : null;
        const namedFont = FONTS.includes(name) ? name : null;
        switch (ins.kind) {
            case 'text': fonts.add(namedFont || 'Geneva12'); continue;
            case 'time': case 'date': fonts.add(namedFont || 'Chicago12'); continue;
            case 'menu': images.add(name || 'MacWriteStyleMenu'); continue;
            case 'startupicon': images.add(name || 'StartupIcons').add('HappyMac'); continue;
            case 'slider': images.add('Slider'); break;
            case 'puzzle': images.add('PuzzleTiles'); break;
            case 'radiobutton': if (!name && ins.w == null) images.add('RadioButton'); break;
        }
        if (name && IMAGES.includes(name)) images.add(name);
        if (namedFont) fonts.add(namedFont);
    }
    return { images: [...images], fonts: [...fonts] };
}

export async function loadResources(base = 'assets', onProgress = () => {}) {
    // scene modules declare extra programs, images, fonts and control kinds
    const extra = await loadSceneModules();
    for (const n of extra.programs) if (!PROGRAMS.includes(n)) PROGRAMS.push(n);
    for (const [n, fw] of Object.entries(extra.images)) {
        if (!IMAGES.includes(n)) IMAGES.push(n);
        if (fw) FRAME_WIDTHS[n] = fw;
    }
    const res = { programs: {}, images: {}, fonts: {}, cursors: {}, acurs: {}, unavailable: {} };
    const appleInstalled = await appleTreePresent(base);
    const isApple = (type, name) => type === 'fonts' || type === 'cursors' || APPLE[type].has(name);
    // what to fetch: without Apple's tree only the project's own files
    const want = (type, list) => list.filter((n) => appleInstalled || !isApple(type, n));
    const programs = want('programs', [...PROGRAMS, WALLPAPER_PROGRAM]);
    const images = want('images', IMAGES);
    const fonts = want('fonts', FONTS);
    const cursIds = want('cursors', CURS_IDS);
    const acurIds = want('cursors', ACUR_IDS);

    let done = 0;
    const total = programs.length + images.length + fonts.length + cursIds.length + acurIds.length;
    const tick = () => onProgress(++done / total);
    const appleMissing = [];
    // a missing file only disables the scenes that need it
    const attempt = async (type, name, file, load) => {
        try {
            await load(assetUrl(base, type, name, file));
        } catch (e) {
            if (isApple(type, name)) appleMissing.push(`${type}/${file}`);
            else console.warn(e.message);
        }
        tick();
    };

    await Promise.all([
        ...programs.map((n) => attempt('programs', n, `${n}.program`, async (url) => {
            const text = await loadText(url);
            try {
                res.programs[n] = parseProgram(text, n);
            } catch (e) {
                console.warn(`Program ${n} skipped: ${e.message}`);
            }
        })),
        ...images.map((n) => attempt('images', n, `${n}.png`, async (url) => {
            const sprite = decodeImage(await loadImage(url), FRAME_WIDTHS[n]);
            // full-screen images are used as the base layer: cache them as bitmaps
            let cached = null;
            sprite.asBitmap = () => {
                if (!cached) {
                    cached = new Bitmap(sprite.w, sprite.h);
                    cached.data.set(sprite.ink);
                }
                return cached;
            };
            res.images[n] = sprite;
        })),
        ...fonts.map((n) => attempt('fonts', n, `${n}.bin`, async (url) => {
            res.fonts[n] = new NFNTFont(await loadBuffer(url), n);
        })),
        ...cursIds.map((id) => attempt('cursors', id, `CURS_${id}.bin`, async (url) => {
            res.cursors[id] = new Cursor(await loadBuffer(url), id);
        })),
        ...acurIds.map((id) => attempt('cursors', id, `acur_${id}.bin`, async (url) => {
            res.acurs[id] = parseAcur(await loadBuffer(url));
        })),
    ]);

    res.apple = { installed: appleInstalled, missing: appleMissing };
    if (!appleInstalled) {
        console.warn("Apple's resources are not installed (assets/apple/): run scripts/extract-apple-assets.sh. Only the project's own scenes that need none of them will play.");
    } else if (appleMissing.length) {
        console.warn(`Apple's resources are incomplete, ${appleMissing.length} missing: ${appleMissing.join(', ')}. Run scripts/extract-apple-assets.sh --check.`);
    }

    // leave out every program that cannot run with what loaded
    for (const n of [...PROGRAMS, WALLPAPER_PROGRAM]) {
        const program = res.programs[n];
        let missing;
        if (!program) missing = ['its script'];
        else {
            const need = programNeeds(program, extra.requires[n]);
            missing = [
                ...need.images.filter((i) => !res.images[i]).map((i) => `image ${i}`),
                ...need.fonts.filter((f) => !res.fonts[f]).map((f) => `font ${f}`),
            ];
        }
        if (!missing.length) continue;
        res.unavailable[n] = missing;
        delete res.programs[n];
    }
    const skipped = Object.entries(res.unavailable);
    if (skipped.length) {
        console.info(`Scenes skipped: ${skipped.map(([n, m]) => (appleInstalled ? `${n} (missing ${m.join(', ')})` : n)).join('; ')}`);
    }

    // Animated cursors by script name. Frame period: the classic Mac animates these every 8 ticks.
    const anim = {};
    for (const [name, id] of Object.entries(ACUR_NAMES)) {
        const frames = (res.acurs[id] || []).map((cid) => res.cursors[cid]).filter(Boolean);
        if (frames.length) anim[name] = new AnimatedCursor(frames, 8 / 60);
    }
    res.animatedCursors = anim;
    res.brushCursor = makeBrushCursor();

    res.cursorFor = (shape, t) => {
        switch (shape) {
            case 'Arrow': return res.cursors[CURSOR_IDS.arrow];
            case 'Text': return res.cursors[CURSOR_IDS.ibeam];
            case 'Crosshair': return res.cursors[CURSOR_IDS.crosshair];
            case 'Brush': return res.brushCursor;
            case 'Watch': case 'Ball': case 'Hand': case 'Clarus':
                return anim[shape] ? anim[shape].at(t) : res.cursors[CURSOR_IDS.watch];
            default: return res.cursors[CURSOR_IDS.arrow];
        }
    };
    return res;
}

// The MacPaint brush cursor is drawn in code by the original (a 4x4 filled ellipse):
// a solid 4x4 dot whose hotspot is its centre.
function makeBrushCursor() {
    const buf = new ArrayBuffer(68);
    const dv = new DataView(buf);
    const rows = [0b0110000000000000, 0b1111000000000000, 0b1111000000000000, 0b0110000000000000];
    for (let r = 0; r < 4; r++) {
        dv.setUint16(r * 2, rows[r]);
        dv.setUint16(32 + r * 2, rows[r]);
    }
    dv.setInt16(64, 2); // hot y
    dv.setInt16(66, 2); // hot x
    return new Cursor(buf, 'brush');
}
