// How much of the per-frame work is redundant? Simulates SIM_SECONDS (default 600) of
// ?program=random step by step (frozen, mac.advance(1/30)) and counts, per simulation step:
//   - bitmap unchanged: scene.compose() produced the same bytes as the previous step
//     (the texture upload could be skipped)
//   - frame unchanged:  bitmap AND every render input (camera, scroll, scale, zoom, ramp,
//     colour uniforms rounded to 8 bits) unchanged (the whole render could be skipped)
// On top of that main.js renders on every requestAnimationFrame, not once per step:
// at 60 Hz half the renders repeat the previous step, at 120 Hz three quarters.
//
//   node tools/perf/redundancy.mjs [baseUrl]   (GL=metal|swiftshader, SIM_SECONDS)

import { chromium } from '/Users/sabatino/www/unipage/node_modules/playwright/index.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8767/';
const GL = process.env.GL || 'metal';
const SIM = +(process.env.SIM_SECONDS || 600);
const args = GL === 'swiftshader' ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.goto(`${BASE}?program=random&color=${process.env.COLOR || 'random'}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.mac && window.mac.scene && window.mac.advance);
await page.evaluate(() => window.mac.freeze());

const res = await page.evaluate((steps) => {
    const mac = window.mac;
    let prevBm = null, prevState = '', bmSame = 0, frameSame = 0, n = 0;
    const per = {};
    // compose() is called by advance(); capture its output
    const proto = Object.getPrototypeOf(mac.scene);
    const orig = proto.compose;
    let last = null;
    proto.compose = function (t) { last = orig.call(this, t); return last; };
    for (let i = 0; i < steps; i++) {
        const r = mac.advance(1 / 30);
        const data = last.data;
        const same = prevBm && prevBm.length === data.length && prevBm.every((v, k) => v === data[k]);
        const v = mac.scene.vars, u = mac.colors.uniforms();
        const q = (a) => a.map((x) => Math.round(x * 255)).join(',');
        const fields = { program: r.program, camera: v.camera.join(','), scroll: v.scroll.map((x) => x.toFixed(3)).join(','), scale: v.scale.toFixed(4), zoom: v.zoom.toFixed(4), scaleDirection: v.scaleDirection, ramp: String(v.ramp), colour: q(u.top) + q(u.bottom) + q(u.pixel) };
        const state = Object.values(fields).join('|');
        window.__prevFields ||= {};
        window.__changed ||= {};
        for (const [k, val] of Object.entries(fields)) { if (window.__prevFields[k] !== val) window.__changed[k] = (window.__changed[k] || 0) + 1; window.__prevFields[k] = val; }
        const p = (per[r.program] ||= { steps: 0, bmSame: 0, frameSame: 0 });
        p.steps++; n++;
        if (same) { bmSame++; p.bmSame++; }
        if (same && state === prevState) { frameSame++; p.frameSame++; }
        if (!prevBm || prevBm.length !== data.length) prevBm = new Uint8Array(data.length);
        prevBm.set(data);
        prevState = state;
    }
    proto.compose = orig;
    return { n, bmSame, frameSame, per, changed: window.__changed };
}, Math.round(SIM * 30));
await browser.close();

const pct = (a, b) => ((100 * a) / b).toFixed(1) + ' %';
console.log(`${res.n} steps (${SIM} s simulated, color=${process.env.COLOR || 'random'})`);
console.log(`bitmap unchanged vs previous step: ${res.bmSame} (${pct(res.bmSame, res.n)})`);
console.log(`whole frame unchanged (bitmap + render inputs): ${res.frameSame} (${pct(res.frameSame, res.n)})`);
console.log('steps on which each render input changed: ' + Object.entries(res.changed).map(([k, c]) => `${k} ${pct(c, res.n)}`).join(', '));
console.log('per program: steps, bitmap unchanged, frame unchanged');
for (const [k, p] of Object.entries(res.per)) console.log(`  ${k.padEnd(20)} ${String(p.steps).padStart(6)}  ${pct(p.bmSame, p.steps).padStart(8)}  ${pct(p.frameSame, p.steps).padStart(8)}`);
const stepsPerSec = 30;
for (const hz of [60, 120]) {
    const renders = hz, needed = stepsPerSec * (1 - res.frameSame / res.n);
    console.log(`at ${hz} Hz: ${renders} renders/s today, ${needed.toFixed(1)} renders/s carry new content -> ${(100 * (1 - needed / renders)).toFixed(0)} % of renders are redundant`);
}
