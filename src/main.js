import { loadResources, PROGRAMS, WALLPAPER_PROGRAM } from './resources.js';
import { Scene } from './scene.js';
import { Processor, Randomizer } from './processor.js';
import { Renderer } from './renderer.js';
import { ColorState, COLOR_OPTIONS, APPEARANCE_OPTIONS } from './colors.js';

const FRAME_DT = 1 / 30; // the original drives its display link at 30 fps

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// URL parameter, then the persisted value, then the default
const setting = (key, def) => params.get(key) ?? localStorage.getItem(`mac.${key}`) ?? def;
const settings = {
    color: params.get('color') || localStorage.getItem('mac.color') || 'random',
    appearance: params.get('appearance') || localStorage.getItem('mac.appearance') || 'automatic',
    contrast: parseFloat(params.get('contrast') || localStorage.getItem('mac.contrast') || '0.2'),
    program: params.get('program') || 'random',
    speed: parseFloat(params.get('speed') || '1'),
    // look; the defaults are the values in Apple's shaders (NOTES.md, "Rendering decisions")
    shadow: parseFloat(setting('shadow', '0.375')),
    shadowSize: parseFloat(setting('shadowSize', '1')),
    shadowSoftness: parseFloat(setting('shadowSoftness', '1')),
    pixelRatio: setting('pixelRatio', 'auto'),
    paused: false,
};

const canvas = $('view');
const status = $('status');
const toast = $('toast');
let renderer;
try {
    renderer = new Renderer(canvas);
} catch (e) {
    status.textContent = e.message;
    throw e;
}

function fillSelect(sel, options, current) {
    sel.innerHTML = '';
    for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        if (o === current) opt.selected = true;
        sel.appendChild(opt);
    }
}

const resources = await loadResources('assets', (p) => (status.textContent = `loading ${Math.round(p * 100)}%`));
const colors = new ColorState({ color: settings.color, appearance: settings.appearance, contrast: settings.contrast });
// only the programs whose script, images and fonts actually loaded take part
const AVAILABLE = PROGRAMS.filter((n) => resources.programs[n]);
const HAS_WALLPAPER = !!resources.programs[WALLPAPER_PROGRAM];
const randomizer = new Randomizer(AVAILABLE);

// Apple's resources are not part of the repository: say so on screen when none were found
function showNotice(html) {
    const notice = $('notice');
    notice.innerHTML = html;
    notice.hidden = false;
    document.body.classList.add('has-notice');
}
if (!resources.apple.installed) {
    showNotice("Apple's resources are not installed. Run <code>scripts/extract-apple-assets.sh</code> on a Mac with macOS 26 (see README)." +
        (AVAILABLE.length ? ` Playing only the ${AVAILABLE.length} scenes that need none of them.` : ''));
}
if (settings.program !== 'random' && !AVAILABLE.includes(settings.program) && !(settings.program === WALLPAPER_PROGRAM && HAS_WALLPAPER)) {
    const why = resources.unavailable[settings.program];
    console.warn(`Program ${settings.program} is not available${why ? ` (missing ${why.join(', ')})` : ''}: playing random scenes`);
    settings.program = 'random';
}

let scene, processor, programName;
let time = 0;
window.mac = {};

// ---- rendering on demand: the loop renders when the simulation stepped or something marked
// the frame dirty (look settings, colours, appearance, size, program switch, first frame).
// While paused the requestAnimationFrame loop stops altogether until one of those happens.
let dirty = true;
let rafId = 0;
let restarted = true; // the next frame is the first after a (re)start: it advances no time
function requestFrame() {
    if (!rafId && AVAILABLE.length) rafId = requestAnimationFrame(frame);
}
function invalidate() {
    dirty = true;
    requestFrame();
}
renderer.onResize = invalidate;
colors.onChange = invalidate; // the system appearance flipped (prefers-color-scheme)
// a change of devicePixelRatio (window moved to another display) without a CSS size change
(function watchPixelRatio() {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
        mq.removeEventListener?.('change', onChange);
        invalidate();
        watchPixelRatio();
    };
    mq.addEventListener?.('change', onChange);
})();

function startProgram(name) {
    programName = name;
    scene = new Scene(resources);
    processor = new Processor(resources.programs[name], scene);
    if (settings.color === 'random') colors.pickRandom();
    Object.assign(window.mac, { scene, processor, renderer, colors, settings }); // for poking around in devtools
    invalidate();
}

function nextProgram() {
    if (settings.program === 'random') startProgram(randomizer.next());
    else startProgram(settings.program);
}

// settings panel
fillSelect($('color'), COLOR_OPTIONS, settings.color);
fillSelect($('appearance'), APPEARANCE_OPTIONS, settings.appearance);
fillSelect($('program'), ['random', ...AVAILABLE, ...(HAS_WALLPAPER ? [WALLPAPER_PROGRAM] : [])], settings.program);
$('contrast').value = String(settings.contrast);
$('speed').value = String(settings.speed);
for (const key of ['shadow', 'shadowSize', 'shadowSoftness']) {
    const input = $(key), out = $(`${key}Val`);
    const show = () => (out.textContent = String(+settings[key].toFixed(3)));
    input.value = String(settings[key]);
    show();
    input.oninput = (e) => {
        settings[key] = parseFloat(e.target.value);
        localStorage.setItem(`mac.${key}`, e.target.value);
        show();
        invalidate();
    };
}
$('pixelRatio').value = String(settings.pixelRatio);
if ($('pixelRatio').value !== String(settings.pixelRatio)) $('pixelRatio').value = settings.pixelRatio = 'auto';
$('color').onchange = (e) => { settings.color = colors.color = e.target.value; localStorage.setItem('mac.color', e.target.value); colors.pickRandom(); invalidate(); };
$('appearance').onchange = (e) => { settings.appearance = colors.appearance = e.target.value; localStorage.setItem('mac.appearance', e.target.value); invalidate(); };
$('contrast').onchange = (e) => { settings.contrast = colors.contrast = parseFloat(e.target.value); localStorage.setItem('mac.contrast', e.target.value); invalidate(); };
$('program').onchange = (e) => { settings.program = e.target.value; nextProgram(); };
$('speed').oninput = (e) => (settings.speed = parseFloat(e.target.value));
$('pixelRatio').onchange = (e) => { settings.pixelRatio = e.target.value; localStorage.setItem('mac.pixelRatio', e.target.value); invalidate(); };
// ---- actions: one function each, shared by the keyboard, the control bar and the panel buttons
const panel = $('panel');
const isPanelOpen = () => panel.classList.contains('open');

function setPanel(open) {
    panel.classList.toggle('open', open);
    $('btnSettings').setAttribute('aria-pressed', String(open));
    wake(); // the bar stays up while the panel is open, and for UI_TIMEOUT after it closes
}
const togglePanel = () => setPanel(!isPanelOpen());

function setPaused(paused) {
    settings.paused = paused;
    $('pause').textContent = paused ? 'Resume' : 'Pause';
    const btn = $('btnPause');
    btn.classList.toggle('paused', paused);
    btn.title = paused ? 'Resume (Space)' : 'Pause (Space)';
    btn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    if (!paused) requestFrame(); // the loop stops while paused
}
const togglePause = () => setPaused(!settings.paused);

const randomColour = () => { colors.pickRandom(); invalidate(); };

// iPhone Safari only does fullscreen for <video>: webkitFullscreenEnabled is false there, so the button is hidden
const fullscreenSupported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function toggleFullscreen() {
    if (!fullscreenSupported) return;
    if (fullscreenElement()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
        const el = document.documentElement;
        const result = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        result?.catch?.(() => {});
    }
}
function onFullscreenChange() {
    const on = !!fullscreenElement();
    const btn = $('btnFullscreen');
    btn.classList.toggle('active', on);
    btn.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
    btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
}
$('btnFullscreen').hidden = !fullscreenSupported;
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// ---- auto-hide: the control bar and the status line show for UI_TIMEOUT after any pointer
// activity, then fade out (body.ui-idle, which also hides the cursor over the canvas). They
// stay up while the panel is open and while a mouse hovers the bar.
const UI_TIMEOUT = 3000;
let hideTimer = 0;
let hoveringBar = false;
let uiVisible = true; // the status line is only written while it can be seen
function wake() {
    document.body.classList.remove('ui-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(sleepUi, UI_TIMEOUT);
    if (!uiVisible) {
        uiVisible = true;
        if (scene) updateStatus();
    }
}
function sleepUi() {
    if (isPanelOpen() || hoveringBar) return; // closing the panel / leaving the bar calls wake() again
    document.body.classList.add('ui-idle');
    uiVisible = false;
}
// Where the last press started. While the bar is hidden it has pointer-events: none, so the tap
// that reveals it lands on the canvas; the click that follows must not press the button that is
// now under the finger.
let pressTarget = null;
let lastMouse = '';
document.addEventListener('pointerdown', (e) => { pressTarget = e.target; wake(); }, true);
document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
        const at = `${e.clientX},${e.clientY}`; // browsers send synthetic moves on layout changes
        if (at === lastMouse) return;
        lastMouse = at;
    }
    wake();
}, { passive: true });
$('controls').addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hoveringBar = true; });
$('controls').addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hoveringBar = false; wake(); } });
// a tap on the canvas outside the panel closes it (taps on the panel or the bar never reach the canvas)
canvas.addEventListener('pointerdown', () => { if (isPanelOpen()) setPanel(false); });

function bindButton(id, action) {
    const btn = $(id);
    btn.addEventListener('click', (e) => {
        const byPointer = e.detail > 0; // 0 = activated from the keyboard
        if (byPointer && pressTarget && !btn.contains(pressTarget)) return;
        action();
        if (byPointer) btn.blur(); // so a later Space goes to the shortcut, not to this button
        wake();
    });
}
bindButton('btnSettings', togglePanel);
bindButton('btnNext', nextProgram);
bindButton('btnPause', togglePause);
bindButton('btnColour', randomColour);
bindButton('btnFullscreen', toggleFullscreen);
bindButton('next', nextProgram);
bindButton('pause', togglePause);
bindButton('close', () => setPanel(false));

const KEYS = { s: togglePanel, n: nextProgram, ' ': togglePause, r: randomColour, f: toggleFullscreen, escape: () => setPanel(false) };
document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave Cmd-R and friends alone
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.('button, select, input')) return; // native activation
    const action = KEYS[e.key.toLowerCase()];
    if (!action) return;
    e.preventDefault();
    action();
});

if (matchMedia('(pointer: coarse)').matches) toast.textContent = 'Tap the screen to show the controls';
toast.style.opacity = 1;
setTimeout(() => (toast.style.opacity = 0), 4000);
wake();

// main loop: fixed 30 Hz simulation, rendered only when it stepped or the frame is dirty (see invalidate)
if (!AVAILABLE.length) {
    status.textContent = 'no scene can play: every scene is missing resources';
    if (resources.apple.installed) showNotice('No scene can play: resources are missing (see the console). Run <code>scripts/extract-apple-assets.sh --check</code>.');
} else {
    nextProgram();
}
let last = 0;
let accumulator = 0;
let stepCount = 0;

// What -[PixelsRenderer draw] reads from the processor: camera, scroll, scale plus the sign
// of its running animation (which with the ramp variable gives rampDirection), zoom.
// One object, refilled for every render.
const rs = { camera: null, scroll: null, scale: 0, scaleDirection: 0, zoom: 0, ramp: null };
function renderState() {
    const v = scene.vars;
    rs.camera = v.camera;
    rs.scroll = v.scroll;
    rs.scale = v.scale;
    rs.scaleDirection = v.scaleDirection;
    rs.zoom = v.zoom;
    rs.ramp = scene.rampVector;
    return rs;
}

// Every number a render depends on besides the bitmap, the look settings and the size
// (those mark the frame dirty). Records them and says whether they changed since the
// last call, so a step that changes nothing visible costs no GPU work.
const lastInputs = new Float64Array(18).fill(NaN);
let inputsDiffer = false;
function put(i, v) {
    if (lastInputs[i] !== v) {
        lastInputs[i] = v;
        inputsDiffer = true;
    }
}
function inputsChanged(s, c) {
    inputsDiffer = false;
    put(0, s.camera[0]); put(1, s.camera[1]); put(2, s.scroll[0]); put(3, s.scroll[1]);
    put(4, s.scale); put(5, s.scaleDirection); put(6, s.zoom); put(7, s.ramp[0]); put(8, s.ramp[1]);
    for (let k = 0; k < 3; k++) {
        put(9 + k, c.bottom[k]);
        put(12 + k, c.top[k]);
        put(15 + k, c.pixel[k]);
    }
    return inputsDiffer;
}

let statusText = '';
function updateStatus() {
    const v = scene.vars;
    const text = `${programName} · ${v.scene} · scroll ${v.scroll[0].toFixed(0)},${v.scroll[1].toFixed(0)} · cam ${v.camera[0]},${v.camera[1]} · scale ${v.scale.toFixed(2)} zoom ${v.zoom.toFixed(2)}`;
    if (text !== statusText) status.textContent = statusText = text;
}

function applyLook() {
    renderer.shadowStrength = settings.shadow;
    renderer.shadowSize = settings.shadowSize;
    renderer.shadowSoftness = settings.shadowSoftness;
    renderer.pixelRatio = settings.pixelRatio;
}

// Deterministic stepping for tests/screenshots: advance the simulation by `seconds` and render once.
function advance(seconds) {
    const n = Math.round(seconds / FRAME_DT);
    for (let i = 0; i < n; i++) {
        time += FRAME_DT;
        processor.step(FRAME_DT);
        scene.update(time, FRAME_DT);
        colors.update(time, FRAME_DT);
        if (processor.finished && programName !== WALLPAPER_PROGRAM) nextProgram();
    }
    renderer.uploadBitmap(scene.compose(time));
    applyLook();
    const v = scene.vars;
    const u = colors.uniforms();
    inputsChanged(renderState(), u); // keep the loop's change check in step with what is on screen
    renderer.render(rs, u, time);
    if (uiVisible) updateStatus();
    return { program: programName, scene: v.scene, scroll: v.scroll, scale: v.scale, zoom: v.zoom, time };
}
window.mac.advance = advance;
window.mac.freeze = () => setPaused(true);
window.mac.ui = { wake, setPanel, setPaused, togglePause, randomColour, toggleFullscreen };
window.mac.invalidate = invalidate;

function frame(now) {
    rafId = 0;
    let dt = restarted ? 0 : Math.min(0.25, Math.max(0, (now - last) / 1000));
    restarted = false;
    last = now;
    if (settings.paused) dt = 0;
    accumulator += dt * settings.speed;
    let stepped = false;
    while (accumulator >= FRAME_DT) {
        accumulator -= FRAME_DT;
        time += FRAME_DT;
        processor.step(FRAME_DT);
        scene.update(time, FRAME_DT);
        colors.update(time, FRAME_DT);
        stepped = true;
        stepCount++;
        if (processor.finished && programName !== WALLPAPER_PROGRAM) {
            nextProgram();
            break;
        }
    }
    // the texture only changes when the composed bitmap does
    const uploaded = stepped || !renderer.texW ? renderer.uploadBitmap(scene.compose(time)) : false;
    if (stepped || dirty || uploaded) {
        applyLook();
        const u = colors.uniforms();
        const changed = inputsChanged(renderState(), u);
        if (dirty || uploaded || changed) renderer.render(rs, u, time);
        dirty = false;
        if (uiVisible && (stepped ? (stepCount & 3) === 0 : true)) updateStatus();
    }
    if (settings.paused) restarted = true; // stop until a setting, a resize or unpausing asks for a frame
    else requestFrame();
}
requestFrame();
