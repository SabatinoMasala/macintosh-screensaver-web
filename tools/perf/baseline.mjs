// Performance baseline for the Macintosh screensaver player (diagnosis only, changes nothing).
//
//   python3 -m http.server 8767 --directory .   (in the repository root)
//   node tools/perf/baseline.mjs [baseUrl] [phases]
//
// phases: comma list of sim,matrix,live (default all). Headless Chromium + SwiftShader:
// GL work runs on the CPU, so render timings are NOT GPU timings. Use the numbers for
// JS cost, memory, call counts and relative (pixel-proportional) render cost.
//
// Output: a table on stdout, tools/perf/<REPORT>-<date>.md and $TMPDIR/macintosh-perf/<REPORT>-<date>-<gl>.json
// (merged across runs). Env: GL=metal|swiftshader, SIM_SECONDS, LIVE_SECONDS, SOAK_SECONDS, PAUSED_SECONDS,
// REPORT (default 'baseline'; e.g. 'after'), REPORT_DIR (default tools/perf).
//
// Phases since the fixes (2026-10-12): matrix and live run the DEFAULT configuration a user gets
// (pixelRatio auto, the renderer's own MSAA choice) at the real device pixel ratio. Headless
// Chromium reports devicePixelContentBoxSize in CSS pixels, so the Retina device-pixel size is
// emulated (renderer.devicePixelSize). 'paused' measures what the page costs while paused.
// The script also runs against the pre-fix code (it then forces samples the old way).

import { chromium } from 'playwright';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://127.0.0.1:8767/';
const PHASES = new Set((process.argv[3] || 'sim,matrix,live,paused,soak').split(','));
const SCRATCH = path.join(os.tmpdir(), 'macintosh-perf');
const REPORT = process.env.REPORT || 'baseline';
const REPORT_DIR = process.env.REPORT_DIR || HERE;
const PAUSED_SECONDS = +(process.env.PAUSED_SECONDS || 20);
fs.mkdirSync(SCRATCH, { recursive: true });
const DATE = new Date().toISOString().slice(0, 10);
const SIM_SECONDS = +(process.env.SIM_SECONDS || 600);
const SAMPLE_EVERY = 30; // simulated seconds
const LIVE_SECONDS = +(process.env.LIVE_SECONDS || 60);

const GL = process.env.GL || 'metal'; // metal = the real GPU through ANGLE (Apple Silicon), swiftshader = software
const GL_ARGS = GL === 'swiftshader' ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const ARGS = [...GL_ARGS, '--enable-precise-memory-info', '--js-flags=--expose-gc'];
const SOAK_SECONDS = +(process.env.SOAK_SECONDS ?? 600);

// ---- injected before any page script: counts every WebGL2 call, canvas resizes, matchMedia calls
function instrument() {
    const counts = Object.create(null);
    const bytes = { texSubImage2D: 0, texImage2D: 0 };
    window.__perf = { counts, bytes, canvasResizes: 0, matchMedia: 0 };
    const proto = WebGL2RenderingContext.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (!d || typeof d.value !== 'function' || name === 'constructor') continue;
        const orig = d.value;
        proto[name] = function (...a) {
            counts[name] = (counts[name] || 0) + 1;
            if (name === 'texSubImage2D' || name === 'texImage2D') {
                const data = a[a.length - 1];
                if (data && data.byteLength) bytes[name] += data.byteLength;
            }
            return orig.apply(this, a);
        };
    }
    for (const prop of ['width', 'height']) {
        const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
        Object.defineProperty(HTMLCanvasElement.prototype, prop, {
            get: d.get,
            set(v) { if (this.id === 'view') window.__perf.canvasResizes++; d.set.call(this, v); },
            configurable: true,
        });
    }
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => { window.__perf.matchMedia++; return mm(q); };
    // rAF callback counter (live phase)
    const raf = window.requestAnimationFrame.bind(window);
    window.__perf.raf = 0;
    window.requestAnimationFrame = (cb) => raf((t) => { window.__perf.raf++; cb(t); });
}

// ---- in-page helpers installed once the player is up
function installTimers() {
    const mac = window.mac;
    const T = (window.__t = Object.create(null));
    const wrap = (obj, name, label, sync) => {
        const orig = obj[name];
        obj[name] = function (...a) {
            const t0 = performance.now();
            const r = orig.apply(this, a);
            const t1 = performance.now();
            const e = (T[label] ||= { n: 0, ms: 0, max: 0, syncMs: 0 });
            e.n++; e.ms += t1 - t0; e.max = Math.max(e.max, t1 - t0);
            if (sync && window.__syncRender) {
                // force the (SwiftShader) GPU work to finish: 1-pixel readback
                const gl = this.gl;
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, window.__px || (window.__px = new Uint8Array(4)));
                e.syncMs += performance.now() - t0;
                (e.syncs ||= []).push(performance.now() - t0);
            }
            return r;
        };
    };
    wrap(Object.getPrototypeOf(mac.processor), 'step', 'processor.step');
    wrap(Object.getPrototypeOf(mac.scene), 'update', 'scene.update');
    wrap(Object.getPrototypeOf(mac.scene), 'compose', 'scene.compose');
    wrap(Object.getPrototypeOf(mac.colors), 'update', 'colors.update');
    wrap(Object.getPrototypeOf(mac.renderer), 'uploadBitmap', 'renderer.uploadBitmap');
    wrap(Object.getPrototypeOf(mac.renderer), 'render', 'renderer.render', true);
    // Scene / Processor lifetime: are old programs collected?
    window.__life = { scenes: 0, scenesFreed: 0, programs: [] };
    window.__reg = new FinalizationRegistry(() => window.__life.scenesFreed++);
    window.__track = (program) => {
        if (window.__lastScene?.deref() !== mac.scene) {
            window.__life.scenes++;
            window.__life.programs.push(program);
            window.__reg.register(mac.scene, program);
            window.__lastScene = new WeakRef(mac.scene);
        }
    };
    window.__track(mac.scene.vars.scene);
}

function snapshotState() {
    const mac = window.mac, s = mac.scene, p = mac.processor;
    // tiles the instanced passes actually draw: ink texels inside the W x W window (when scale > 0)
    const cam = mac.renderer.lastCamera;
    let ink = 0, inWindow = 0;
    if (cam) {
        const W = cam.W, sx = Math.trunc(s.vars.scroll[0]) - W / 2, sy = Math.trunc(s.vars.scroll[1]) - W / 2;
        const bm = s.bitmap;
        for (let y = sy; y < sy + W; y++)
            for (let x = sx; x < sx + W; x++) {
                if (x < 0 || y < 0 || x >= bm.w || y >= bm.h) continue;
                inWindow++;
                if (bm.data[y * bm.w + x]) ink++;
            }
    }
    return {
        controls: s.controls.length,
        controlKinds: s.controls.map((c) => c.constructor.name).join(','),
        log: s.log.length,
        running: p.running.length,
        asyncs: p.asyncs.size,
        stack: p.stack.length,
        finished: p.finished,
        inkTiles: ink,
        scale: s.vars.scale,
        W: cam?.W,
        canvas: [document.getElementById('view').width, document.getElementById('view').height],
        target: mac.renderer.target ? [mac.renderer.target.w, mac.renderer.target.h] : null,
        samples: mac.renderer.target?.samples ?? mac.renderer.samples,
    };
}

// Headless reports devicePixelContentBoxSize in CSS px; a real Retina display reports device px.
// Give the renderer the real value and ask for a frame (pre-fix code just renders every rAF).
function emulateDevicePixels() {
    const R = window.mac.renderer, c = R.canvas.getBoundingClientRect();
    R.devicePixelSize = [Math.round(c.width * devicePixelRatio), Math.round(c.height * devicePixelRatio)];
    window.mac.invalidate?.();
}

// Force a sample count: the fixed renderer has an msaa knob, the pre-fix one a fixed samples field.
function forceSamples(R, msaa) {
    if ('msaa' in R) R.msaa = msaa;
    else {
        R.samples = msaa === 'auto' ? 4 : msaa;
        if (R.target) R.target.w = -1; // force ensureTarget() to rebuild
    }
}

const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? '-' : Number(n).toFixed(d));
const MB = (b) => (b / 1048576).toFixed(2);

async function gcHeap(page) {
    return page.evaluate(async () => {
        window.gc(); await new Promise((r) => setTimeout(r, 0)); window.gc();
        await new Promise((r) => setTimeout(r, 0));
        return { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize };
    });
}

async function heapSnapshot(cdp, file) {
    const chunks = [];
    const onChunk = (e) => chunks.push(e.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    const text = chunks.join('');
    fs.writeFileSync(file, text);
    return summarizeSnapshot(JSON.parse(text));
}

// aggregate a .heapsnapshot by (type, name): count + self size
function summarizeSnapshot(snap) {
    const m = snap.snapshot.meta, F = m.node_fields.length;
    const iType = m.node_fields.indexOf('type'), iName = m.node_fields.indexOf('name'), iSize = m.node_fields.indexOf('self_size');
    const types = m.node_types[iType];
    const agg = new Map();
    let total = 0;
    for (let i = 0; i < snap.nodes.length; i += F) {
        const type = types[snap.nodes[i + iType]];
        let name = snap.strings[snap.nodes[i + iName]];
        if (type === 'string' || type === 'concatenated string' || type === 'sliced string') name = '(string)';
        else if (type === 'code') name = '(code)';
        else if (type === 'number') name = '(number)';
        const key = `${type}:${String(name).slice(0, 60)}`;
        const e = agg.get(key) || { count: 0, size: 0 };
        e.count++; e.size += snap.nodes[i + iSize];
        total += snap.nodes[i + iSize];
        agg.set(key, e);
    }
    return { total, agg };
}

function diffSnapshots(a, b, top = 15) {
    const rows = [];
    for (const [k, e] of b.agg) {
        const o = a.agg.get(k) || { count: 0, size: 0 };
        rows.push({ key: k, dCount: e.count - o.count, dSize: e.size - o.size, size: e.size, count: e.count });
    }
    for (const [k, o] of a.agg) if (!b.agg.has(k)) rows.push({ key: k, dCount: -o.count, dSize: -o.size, size: 0, count: 0 });
    rows.sort((x, y) => Math.abs(y.dSize) - Math.abs(x.dSize));
    return rows.slice(0, top);
}

async function openPage(browser, { width = 1280, height = 800, dpr = 1, query = 'program=random' } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    await page.addInitScript(instrument);
    await page.goto(`${BASE}?${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.mac && window.mac.scene && window.mac.advance, null, { timeout: 60000 });
    if (dpr > 1) await page.evaluate(emulateDevicePixels);
    return { ctx, page, logs };
}

// phases can be run one at a time: each run merges into the day's JSON and re-renders the whole report
const JSON_FILE = `${SCRATCH}/${REPORT}-${DATE}-${GL}.json`;
const out = { sim: null, matrix: null, live: null, paused: null, soak: null, ...(fs.existsSync(JSON_FILE) ? JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')) : {}), date: DATE, base: BASE, ua: null };
const browser = await chromium.launch({ args: ARGS });
out.ua = browser.version();

// ======================= phase 1: deterministic 10-minute simulation =======================
if (PHASES.has('sim')) {
    const { ctx, page, logs } = await openPage(browser);
    await page.evaluate(() => window.mac.freeze());
    await page.evaluate(installTimers);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    const samples = [];
    let snapA = null, snapB = null;
    const t0Wall = Date.now();
    for (let simT = 0; simT <= SIM_SECONDS; simT += SAMPLE_EVERY) {
        // timed window: 30 frames of 1/30 s, each = 1 step + compose + upload + render (render synced)
        const w = await page.evaluate(() => {
            window.__syncRender = true;
            for (const k in window.__t) delete window.__t[k];
            const c0 = { ...window.__perf.counts }, b0 = { ...window.__perf.bytes };
            const mm0 = window.__perf.matchMedia;
            const heap0 = performance.memory.usedJSHeapSize;
            let r;
            const t0 = performance.now();
            for (let i = 0; i < 30; i++) { r = window.mac.advance(1 / 30); window.__track(r.program); }
            const wall = performance.now() - t0;
            const heap1 = performance.memory.usedJSHeapSize;
            const per = {};
            for (const k in window.__perf.counts) {
                const d = window.__perf.counts[k] - (c0[k] || 0);
                if (d) per[k] = d / 30;
            }
            const t = {};
            for (const [k, e] of Object.entries(window.__t)) t[k] = { avg: e.ms / e.n, max: e.max, n: e.n, syncAvg: e.syncMs ? e.syncMs / e.n : null };
            window.__syncRender = false;
            return {
                r, wall: wall / 30, perFrameCalls: per, timings: t,
                texBytesPerFrame: (window.__perf.bytes.texSubImage2D - b0.texSubImage2D) / 30,
                matchMediaPerFrame: (window.__perf.matchMedia - mm0) / 30,
                allocPerFrame: (heap1 - heap0) / 30,
            };
        });
        const st = await page.evaluate(snapshotState);
        const heap = await gcHeap(page);
        const life = await page.evaluate(() => ({ ...window.__life, programs: window.__life.programs.slice() }));
        const totals = await page.evaluate(() => ({ ...window.__perf.counts }));
        const live = (c, d) => (totals[c] || 0) - (totals[d] || 0);
        const glLive = {
            textures: live('createTexture', 'deleteTexture'), buffers: live('createBuffer', 'deleteBuffer'),
            framebuffers: live('createFramebuffer', 'deleteFramebuffer'), renderbuffers: live('createRenderbuffer', 'deleteRenderbuffer'),
            vaos: live('createVertexArray', 'deleteVertexArray'), programs: live('createProgram', 'deleteProgram'), shaders: live('createShader', 'deleteShader'),
        };
        const glCreated = ['createTexture', 'createBuffer', 'createFramebuffer', 'createRenderbuffer', 'createVertexArray', 'createProgram', 'createShader', 'texImage2D', 'texStorage2D', 'renderbufferStorageMultisample']
            .reduce((o, k) => ((o[k] = totals[k] || 0), o), {});
        const canvasResizes = await page.evaluate(() => window.__perf.canvasResizes);
        const sample = { simT: simT + 1, ...w, state: st, heap, life: { scenes: life.scenes, scenesFreed: life.scenesFreed }, glLive, glCreated, canvasResizes, wallElapsed: (Date.now() - t0Wall) / 1000 };
        samples.push(sample);
        const tt = w.timings;
        console.log(`t=${String(simT).padStart(3)}s ${String(w.r.program).padEnd(20)} heap ${MB(heap.used)} MB  step ${fmt(tt['processor.step']?.avg, 3)} upd ${fmt(tt['scene.update']?.avg, 3)} compose ${fmt(tt['scene.compose']?.avg, 3)} upload ${fmt(tt['renderer.uploadBitmap']?.avg, 3)} render ${fmt(tt['renderer.render']?.avg, 3)}/${fmt(tt['renderer.render']?.syncAvg, 1)} ms  ctl ${st.controls} log ${st.log} run ${st.running} async ${st.asyncs}  scenes ${life.scenes}/${life.scenesFreed} freed  gl live ${JSON.stringify(glLive)}`);
        if (simT === 60) snapA = await heapSnapshot(cdp, `${SCRATCH}/heap-1min.heapsnapshot`);
        if (simT === 480) snapB = await heapSnapshot(cdp, `${SCRATCH}/heap-8min.heapsnapshot`);
        if (simT >= SIM_SECONDS) break;
        // the rest of the 30 s: 1 s chunks (each = 30 steps + 1 compose/upload/render)
        await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__track(window.mac.advance(1).program); }, SAMPLE_EVERY - 1);
    }
    const snapDiff = snapA && snapB ? diffSnapshots(snapA, snapB) : null;
    out.sim = { samples, snapTotals: snapA && snapB ? [snapA.total, snapB.total] : null, snapDiff, logs: logs.slice(0, 20) };
    await ctx.close();
}

// ---- system probes: GPU utilisation (ioreg, system wide) and CPU/RSS of this Chromium's processes
function gpuStats() {
    try {
        const o = execSync('ioreg -r -d 1 -c IOAccelerator', { encoding: 'utf8' });
        const g = (k) => +(o.match(new RegExp(`"${k}"=(\\d+)`)) || [])[1];
        return { util: g('Device Utilization %'), inUseMB: g('In use system memory') / 1048576 };
    } catch { return { util: null, inUseMB: null }; }
}
function cpuSeconds(t) { // ps TIME: [[dd-]hh:]mm:ss.ss
    const [d, rest] = t.includes('-') ? t.split('-') : [0, t];
    return rest.split(':').reduce((acc, v) => acc * 60 + parseFloat(v), 0) + d * 86400;
}
function chromiumProcs() {
    const rows = execSync('ps -axo pid=,ppid=,rss=,time=,command=', { encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n').map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        return m && { pid: +m[1], ppid: +m[2], rss: +m[3], cpu: cpuSeconds(m[4]), cmd: m[5] };
    }).filter(Boolean);
    const kids = new Map();
    for (const r of rows) (kids.get(r.ppid) || kids.set(r.ppid, []).get(r.ppid)).push(r);
    const out = { browser: null, gpu: { rss: 0, cpu: 0 }, renderer: { rss: 0, cpu: 0 }, other: { rss: 0, cpu: 0 } };
    const walk = (pid) => { for (const k of kids.get(pid) || []) { yield_(k); walk(k.pid); } };
    const yield_ = (r) => {
        if (!/chrom/i.test(r.cmd)) return;
        const kind = /--type=gpu-process/.test(r.cmd) ? 'gpu' : /--type=renderer/.test(r.cmd) ? 'renderer' : /--type=/.test(r.cmd) ? 'other' : 'browser';
        if (kind === 'browser') out.browser = { rss: r.rss, cpu: r.cpu };
        else { out[kind].rss += r.rss; out[kind].cpu += r.cpu; }
    };
    walk(process.pid);
    return out;
}

// ======================= phase 2: render cost matrix (real GPU through ANGLE/Metal unless GL=swiftshader) =======================
// One fixed MacPaintHello frame, rendered 30 times, each followed by a 1-pixel readback so the GPU has finished:
// that is the wall time of one frame of GPU work as the page sees it.
if (PHASES.has('matrix')) {
    const rows = [];
    // variants: the default (pixelRatio auto at the display's real DPR, renderer-chosen MSAA), then
    // explicit pixelRatio = DPR (exact device pixels), no MSAA, and tiles off
    const VARIANTS = [
        { name: 'default', pr: 'auto', msaa: 'auto', tiles: true },
        { name: 'default, tiles off', pr: 'auto', msaa: 'auto', tiles: false },
        { name: 'auto, 4x MSAA', pr: 'auto', msaa: 4, tiles: true },
        { name: 'auto, no MSAA', pr: 'auto', msaa: 0, tiles: true },
        { name: 'explicit pixelRatio', pr: 'dpr', msaa: 'auto', tiles: true },
    ];
    for (const [w, h, dpr, label] of [[1280, 800, 1, '1280x800 @1x'], [1512, 982, 2, 'MacBook Pro 14" @2x'], [1728, 1117, 2, 'MacBook Pro 16" @2x'], [2560, 1440, 2, '5K display @2x']]) {
      for (const pr of ['auto', 'dpr']) {
        const { ctx, page } = await openPage(browser, { width: w, height: h, dpr, query: `program=MacPaintHello&pixelRatio=${pr === 'auto' ? 'auto' : dpr}` });
        await page.evaluate(() => window.mac.freeze());
        await page.evaluate(installTimers);
        await page.evaluate(() => window.mac.advance(20)); // zoomed into the drawing: lots of ink
        for (const variant of VARIANTS.filter((v) => v.pr === pr)) {
            const { msaa, tiles } = variant;
            const r = await page.evaluate(({ msaa, tiles, forceSamples }) => {
                const R = window.mac.renderer, v = window.mac.scene.vars;
                new Function('R', 'msaa', `(${forceSamples})(R, msaa)`)(R, msaa);
                window.__syncRender = true;
                const st = { camera: v.camera, scroll: v.scroll, scale: tiles ? v.scale : 0, scaleDirection: v.scaleDirection, zoom: v.zoom, ramp: window.mac.scene.rampVector };
                for (let i = 0; i < 3; i++) R.render(st, window.mac.colors.uniforms(), 0); // warm-up
                for (const k in window.__t) delete window.__t[k];
                for (let i = 0; i < 30; i++) R.render(st, window.mac.colors.uniforms(), 0);
                window.__syncRender = false;
                const e = window.__t['renderer.render'];
                const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
                // the cost of the readback round trip itself: a readback with no new GPU work queued
                const gl = R.gl, px = new Uint8Array(4), floor = [];
                for (let i = 0; i < 30; i++) { const t0 = performance.now(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); floor.push(performance.now() - t0); }
                const t = R.target;
                return { submit: e.ms / e.n, sync: med(e.syncs), floor: med(floor), canvas: [R.canvas.width, R.canvas.height], target: t ? [t.w, t.h] : null, samples: t ? (t.samples ?? R.samples) : 0 };
            }, { msaa, tiles, forceSamples: forceSamples.toString() });
            const st = await page.evaluate(snapshotState);
            const px = r.canvas[0] * r.canvas[1];
            const tpx = r.target ? r.target[0] * r.target[1] : px;
            // offscreen renderbuffer (a 0-sample one is still allocated) + resolve texture + one canvas back buffer
            // (the compositor holds one or two more of the canvas size)
            const buffersMB = (tpx * 4 * Math.max(1, r.samples) + tpx * 4 + px * 4) / 1048576;
            rows.push({ label, variant: variant.name, samples: r.samples, tiles, ...r, inkTiles: st.inkTiles, W: st.W, buffersMB });
            console.log(`matrix ${label} [${variant.name}] samples=${r.samples} tiles=${tiles}: submit ${fmt(r.submit)} ms, render+readback ${fmt(r.sync)} ms (readback floor ${fmt(r.floor)}), canvas ${r.canvas}, target ${r.target}, ink tiles ${st.inkTiles}, buffers ~${fmt(buffersMB, 0)} MB`);
        }
        await ctx.close();
        if (dpr === 1) break; // at 1x 'auto' and the explicit ratio are the same thing
      }
    }
    out.matrix = rows;
}

// ======================= phase 3: live rAF loop (real time, not frozen) =======================
async function liveRun(label, w, h, dpr, seconds, every = 5, probe = false, paused = false) {
    const { ctx, page } = await openPage(browser, { width: w, height: h, dpr, query: 'program=random&pixelRatio=auto' });
    if (paused) {
        await page.waitForTimeout(2000);
        await page.evaluate(() => window.mac.ui.setPaused(true));
    }
    await page.waitForTimeout(1000);
    await page.evaluate(installTimers);
    const read = () => page.evaluate(() => ({
        raf: window.__perf.raf, draws: window.__perf.counts.drawArraysInstanced || 0, uploads: window.__perf.counts.texSubImage2D || 0,
        steps: window.__t['processor.step']?.n || 0, renderMs: window.__t['renderer.render']?.ms || 0, renders: window.__t['renderer.render']?.n || 0,
        heap: performance.memory.usedJSHeapSize, t: performance.now(), program: window.mac.scene.vars.scene,
        canvas: [document.getElementById('view').width, document.getElementById('view').height],
        target: window.mac.renderer.target ? [window.mac.renderer.target.w, window.mac.renderer.target.h, window.mac.renderer.target.samples ?? window.mac.renderer.samples] : null,
    }));
    let prev = await read(), prevProc = chromiumProcs(), prevWall = Date.now();
    const trace = [];
    for (let s = every; s <= seconds; s += every) {
        await page.waitForTimeout(every * 1000);
        const c = await read();
        const proc = chromiumProcs(), wall = Date.now();
        const dt = (c.t - prev.t) / 1000, dw = (wall - prevWall) / 1000;
        const row = {
            s, program: c.program, heapMB: c.heap / 1048576,
            rafPerSec: (c.raf - prev.raf) / dt, rendersPerSec: (c.draws - prev.draws) / 2 / dt, uploadsPerSec: (c.uploads - prev.uploads) / dt, stepsPerSec: (c.steps - prev.steps) / dt,
            submitMs: (c.renderMs - prev.renderMs) / Math.max(1, c.renders - prev.renders),
            gpu: gpuStats(),
            gpuProcCpu: (proc.gpu.cpu - prevProc.gpu.cpu) / dw, rendererCpu: (proc.renderer.cpu - prevProc.renderer.cpu) / dw,
            gpuProcRssMB: proc.gpu.rss / 1024, rendererRssMB: proc.renderer.rss / 1024,
        };
        if (probe) { // one synced frame: how long the GPU needs for a frame right now
            row.gpuFrameMs = await page.evaluate(() => {
                const R = window.mac.renderer, gl = R.gl, px = new Uint8Array(4);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                const v = window.mac.scene.vars, st = { camera: v.camera, scroll: v.scroll, scale: v.scale, scaleDirection: v.scaleDirection, zoom: v.zoom, ramp: window.mac.scene.rampVector };
                let best = Infinity;
                for (let i = 0; i < 3; i++) { const t0 = performance.now(); R.render(st, window.mac.colors.uniforms(), 0); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); best = Math.min(best, performance.now() - t0); }
                return best;
            });
        }
        trace.push(row);
        console.log(`  ${label} t=${String(s).padStart(3)}s ${String(c.program).padEnd(18)} rAF ${fmt(row.rafPerSec, 1)}/s renders ${fmt(row.rendersPerSec, 1)}/s steps ${fmt(row.stepsPerSec, 1)}/s uploads ${fmt(row.uploadsPerSec, 1)}/s | GPU util ${row.gpu.util}% | gpu-proc CPU ${fmt(row.gpuProcCpu * 100, 0)}% RSS ${fmt(row.gpuProcRssMB, 0)} MB | renderer CPU ${fmt(row.rendererCpu * 100, 0)}% RSS ${fmt(row.rendererRssMB, 0)} MB | heap ${fmt(row.heapMB)} MB${probe ? ` | GPU frame ${fmt(row.gpuFrameMs, 2)} ms` : ''}`);
        prev = c; prevProc = proc; prevWall = wall;
    }
    const gcd = await gcHeap(page);
    const avg = (k) => trace.reduce((a, r) => a + (r[k] ?? 0), 0) / trace.length;
    const res = {
        label, canvas: prev.canvas, target: prev.target, seconds,
        rafPerSec: avg('rafPerSec'), rendersPerSec: avg('rendersPerSec'), uploadsPerSec: avg('uploadsPerSec'), stepsPerSec: avg('stepsPerSec'), submitMs: avg('submitMs'),
        gpuUtil: trace.reduce((a, r) => a + (r.gpu.util || 0), 0) / trace.length, gpuProcCpu: avg('gpuProcCpu'), rendererCpu: avg('rendererCpu'),
        heapFirst: trace[0].heapMB, heapLast: trace[trace.length - 1].heapMB, heapMax: Math.max(...trace.map((x) => x.heapMB)), heapAfterGcMB: gcd.used / 1048576,
        gpuRssFirst: trace[0].gpuProcRssMB, gpuRssLast: trace[trace.length - 1].gpuProcRssMB, trace,
    };
    await ctx.close();
    return res;
}

if (PHASES.has('live') || PHASES.has('soak') || PHASES.has('paused')) {
    // idle GPU utilisation of this machine before we start (ioreg is system wide)
    const idle = [];
    for (let i = 0; i < 5; i++) { idle.push(gpuStats().util); await new Promise((r) => setTimeout(r, 1000)); }
    out.idleGpuUtil = idle;
    console.log(`idle GPU utilisation (system wide): ${idle.join(', ')} %`);
}
if (PHASES.has('live')) {
    out.live = [];
    for (const [label, w, h, dpr, secs] of [['1280x800 @1x', 1280, 800, 1, LIVE_SECONDS], ['MacBook Pro 14" @2x', 1512, 982, 2, LIVE_SECONDS], ['5K display @2x', 2560, 1440, 2, Math.min(30, LIVE_SECONDS)], ['320x200 @1x', 320, 200, 1, Math.min(20, LIVE_SECONDS)]]) {
        const r = await liveRun(label, w, h, dpr, secs);
        out.live.push(r);
        console.log(`live ${label} (${r.canvas.join('x')}): ${fmt(r.rafPerSec, 1)} rAF/s, ${fmt(r.rendersPerSec, 1)} renders/s, ${fmt(r.stepsPerSec, 1)} steps/s, GPU util ${fmt(r.gpuUtil, 0)}%, heap ${fmt(r.heapFirst)} -> ${fmt(r.heapLast)} MB (after GC ${fmt(r.heapAfterGcMB)})`);
    }
}
if (PHASES.has('paused')) {
    // paused, panel closed, UI asleep: what does the page still cost?
    out.paused = await liveRun('paused MacBook Pro 14" @2x', 1512, 982, 2, PAUSED_SECONDS, 5, false, true);
    const r = out.paused;
    console.log(`paused (${r.canvas.join('x')}): ${fmt(r.rafPerSec, 1)} rAF/s, ${fmt(r.rendersPerSec, 1)} renders/s, GPU util ${fmt(r.gpuUtil, 0)}%, GPU proc CPU ${fmt(r.gpuProcCpu * 100, 0)}%, renderer CPU ${fmt(r.rendererCpu * 100, 0)}%`);
}
if (PHASES.has('soak') && SOAK_SECONDS > 0) {
    console.log(`soak: ${SOAK_SECONDS} s real time at MacBook Pro 14" @2x`);
    out.soak = await liveRun('soak MacBook Pro 14" @2x', 1512, 982, 2, SOAK_SECONDS, 30, true);
}

await browser.close();
fs.writeFileSync(JSON_FILE, JSON.stringify(out, null, 1));

// ======================= markdown report =======================
const L = [];
L.push(`# Performance ${REPORT} ${DATE}`, '');
L.push(`Generated by \`REPORT=${REPORT} node tools/perf/baseline.mjs\` against ${BASE}, headless Chromium ${out.ua}, GL backend \`${GL}\` (${GL === 'swiftshader' ? 'software GL: render timings are CPU rasterisation, use them relatively' : 'ANGLE on Metal, the real Apple GPU of this machine'}). Raw data: \`${JSON_FILE}\`. Each phase can be run on its own (\`node tools/perf/baseline.mjs <url> sim|matrix|live|paused|soak\`); runs merge into that file and this report is re-rendered from it.`, '');
L.push('Matrix, live, paused and soak run the configuration a user gets by default: `pixelRatio=auto` at the display\'s device pixel ratio (the Retina device-pixel size is emulated, headless reports CSS pixels) and the renderer\'s own MSAA choice.', '');
if (out.sim) {
    const S = out.sim.samples;
    L.push(`## 1. Deterministic simulation (${SIM_SECONDS / 60} min, \`?program=random\`, 1280x800 @1x, frozen + \`mac.advance\`)`, '');
    L.push('Every 30 simulated seconds: 30 timed frames of `advance(1/30)` (one step + compose + upload + render each; render followed by a 1-pixel readback so SwiftShader finishes), then the JS heap after two forced GCs. ms = mean per call.', '');
    L.push('| t (s) | program | heap after GC (MB) | alloc/frame (KB) | step ms | scene.update ms | compose ms | upload ms | render submit ms | render+finish ms | controls | scene.log | running | asyncs | scenes created/freed | GL calls/frame | tex bytes/frame | matchMedia/frame |');
    L.push('|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|');
    for (const s of S) {
        const t = s.timings, calls = Object.values(s.perFrameCalls).reduce((a, b) => a + b, 0);
        L.push(`| ${s.simT - 1} | ${s.r.program} | ${MB(s.heap.used)} | ${fmt(s.allocPerFrame / 1024, 1)} | ${fmt(t['processor.step']?.avg, 4)} | ${fmt(t['scene.update']?.avg, 4)} | ${fmt(t['scene.compose']?.avg, 3)} | ${fmt(t['renderer.uploadBitmap']?.avg, 3)} | ${fmt(t['renderer.render']?.avg, 3)} | ${fmt(t['renderer.render']?.syncAvg, 1)} | ${s.state.controls} | ${s.state.log} | ${s.state.running} | ${s.state.asyncs} | ${s.life.scenes}/${s.life.scenesFreed} | ${fmt(calls, 0)} | ${fmt(s.texBytesPerFrame, 0)} | ${fmt(s.matchMediaPerFrame, 1)} |`);
    }
    const last = S[S.length - 1];
    L.push('', '**GL objects alive at the end** (create minus delete): `' + JSON.stringify(last.glLive) + '`; created in total: `' + JSON.stringify(last.glCreated) + `\`; canvas width/height assignments: ${last.canvasResizes}.`, '');
    L.push('**GL calls per frame** (from the last window): `' + JSON.stringify(Object.fromEntries(Object.entries(last.perFrameCalls).map(([k, v]) => [k, +v.toFixed(2)]))) + '`', '');
    if (out.sim.snapDiff) {
        L.push(`### Heap snapshots (CDP, after GC): 1 min ${MB(out.sim.snapTotals[0])} MB, 8 min ${MB(out.sim.snapTotals[1])} MB`, '');
        L.push('Largest changes by self size (type:name):', '');
        L.push('| node | count Δ | self size Δ (KB) | count at 8 min | size at 8 min (KB) |', '|---|---:|---:|---:|---:|');
        for (const r of out.sim.snapDiff) L.push(`| \`${r.key.replace(/\|/g, '\\|')}\` | ${r.dCount} | ${fmt(r.dSize / 1024, 1)} | ${r.count} | ${fmt(r.size / 1024, 1)} |`);
        L.push('');
    }
}
if (out.matrix) {
    L.push(`## 2. GPU cost of one frame vs resolution, MSAA and tiles (${GL}, MacPaintHello at 20 s, mean of 30 renders each followed by a 1-pixel readback)`, '');
    L.push('"tiles off" renders with scale 0: the background, resolve and present passes only (the instanced passes collapse every quad). "explicit pixelRatio" sets the ratio to the display\'s DPR (exact device pixels, no cap). Buffers = offscreen renderbuffer (x samples) + resolve texture + one canvas back buffer, RGBA8.', '');
    L.push('| display | variant | canvas (device px) | offscreen target | MSAA | tiles | ink tiles drawn | JS submit ms | render+readback ms (median) | readback floor ms | ≈ GPU frame ms | GPU busy at 30 renders/s | buffers MB |', '|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of out.matrix) {
        const g = Math.max(0, r.sync - r.floor);
        L.push(`| ${r.label} | ${r.variant ?? '-'} | ${r.canvas.join('x')} | ${r.target ? r.target.join('x') : '-'} | ${r.samples || 'off'} | ${r.tiles ? 'on' : 'off'} | ${r.tiles ? `${r.inkTiles} of ${r.W * r.W}` : '0'} | ${fmt(r.submit)} | ${fmt(r.sync)} | ${fmt(r.floor)} | ${fmt(g)} | ${fmt(Math.min(100, g * 3), 0)} % | ${fmt(r.buffersMB, 0)} |`);
    }
    L.push('', 'GPU busy = GPU frame ms x renders per second / 1000; after the fixes the page renders at most once per 30 Hz simulation step.', '');
}
if (out.live) {
    L.push(`## 3. Live rAF loop (not frozen, real time, ${GL})`, '');
    L.push(`Idle GPU utilisation of the machine before the runs (ioreg, system wide, other apps included): ${out.idleGpuUtil.join(', ')} %.`, '');
    L.push('| display | canvas | offscreen target (w x h x samples) | seconds | rAF/s | renders/s | bitmap uploads/s | sim steps/s | renders per step | uploads per step | GPU util % (system) | GPU process CPU % | renderer CPU % | JS heap first→last (MB) | heap after GC (MB) |', '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|');
    for (const r of out.live) L.push(`| ${r.label} | ${r.canvas.join('x')} | ${r.target ? r.target.join('x') : '-'} | ${r.seconds} | ${fmt(r.rafPerSec, 1)} | ${fmt(r.rendersPerSec, 1)} | ${fmt(r.uploadsPerSec, 1)} | ${fmt(r.stepsPerSec, 1)} | ${fmt(r.rendersPerSec / r.stepsPerSec, 2)} | ${fmt(r.uploadsPerSec / r.stepsPerSec, 2)} | ${fmt(r.gpuUtil, 0)} | ${fmt(r.gpuProcCpu * 100, 0)} | ${fmt(r.rendererCpu * 100, 0)} | ${fmt(r.heapFirst)}→${fmt(r.heapLast)} | ${fmt(r.heapAfterGcMB)} |`);
    L.push('');
}
if (out.paused) {
    const r = out.paused;
    L.push(`## 3b. Paused (${r.seconds} s at MacBook Pro 14" @2x, panel closed, UI asleep, ${GL})`, '');
    L.push('| t (s) | rAF/s | renders/s | GPU util % (system) | GPU process CPU % | renderer CPU % | JS heap MB |', '|---:|---:|---:|---:|---:|---:|---:|');
    for (const x of r.trace) L.push(`| ${x.s} | ${fmt(x.rafPerSec, 1)} | ${fmt(x.rendersPerSec, 1)} | ${x.gpu.util} | ${fmt(x.gpuProcCpu * 100, 0)} | ${fmt(x.rendererCpu * 100, 0)} | ${fmt(x.heapMB)} |`);
    L.push('', `Mean: ${fmt(r.rafPerSec, 1)} rAF/s, ${fmt(r.rendersPerSec, 1)} renders/s, GPU util ${fmt(r.gpuUtil, 0)} % (idle machine: ${(out.idleGpuUtil || []).join(', ')} %), GPU process CPU ${fmt(r.gpuProcCpu * 100, 0)} %, renderer CPU ${fmt(r.rendererCpu * 100, 0)} %.`, '');
}
if (out.soak) {
    const r = out.soak;
    L.push(`## 4. Soak: ${r.seconds / 60} minutes real time at ${r.label.replace('soak ', '')} (${r.canvas.join('x')}), every 30 s`, '');
    L.push('| t (s) | scene | rAF/s | renders/s | steps/s | GPU frame ms (best of 3 synced) | GPU util % | GPU proc CPU % | GPU proc RSS MB | renderer CPU % | renderer RSS MB | JS heap MB |', '|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const x of r.trace) L.push(`| ${x.s} | ${x.program} | ${fmt(x.rafPerSec, 1)} | ${fmt(x.rendersPerSec, 1)} | ${fmt(x.stepsPerSec, 1)} | ${fmt(x.gpuFrameMs, 2)} | ${x.gpu.util} | ${fmt(x.gpuProcCpu * 100, 0)} | ${fmt(x.gpuProcRssMB, 0)} | ${fmt(x.rendererCpu * 100, 0)} | ${fmt(x.rendererRssMB, 0)} | ${fmt(x.heapMB)} |`);
    L.push('', `JS heap after a forced GC at the end: ${fmt(r.heapAfterGcMB)} MB.`, '');
}
const REPORT_FILE = path.join(REPORT_DIR, `${REPORT}-${DATE}.md`);
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(REPORT_FILE, L.join('\n'));
console.log(`\nwrote ${REPORT_FILE}`);
