// Parser for the *.program scene scripts. The regular expressions are the ones
// found verbatim in WallpaperMacintoshExtension (see NOTES.md); each line is
// matched in this order and turned into one instruction object.

const RULES = [
    ['add', /^\s*add (\w+)(?: at (\d+), ?(\d+))?(?: size (\d+), ?(\d+))?(?: value (\d+))?(?: action "(\w+)")?(?: name "(\w+)")?\s*$/,
        (m) => ({ op: 'add', kind: m[1], x: num(m[2]), y: num(m[3]), w: num(m[4]), h: num(m[5]), value: num(m[6]), action: m[7] ?? null, name: m[8] ?? null })],
    ['reset', /^\s*reset controls\s*$/, () => ({ op: 'reset' })],
    ['scale', /^\s*(scale|zoom) (?:to )?(in|out|[\d.-]+)(?: over ([\d.]+) seconds?(?: curve (linear|easein|easeout|easeinout|easeoutback))?(?: async "(\w+)")?)?\s*$/,
        (m) => ({ op: 'interp', target: m[1], value: m[2] === 'in' ? 1 : m[2] === 'out' ? 0 : parseFloat(m[2]), duration: m[3] ? parseFloat(m[3]) : 0, curve: m[4] || 'linear', async: m[5] ?? null })],
    ['move', /^\s*(camera|scroll|mouse) to ([\d.-]+), ?([\d.-]+)(?: over ([\d.]+) seconds?(?: curve (linear|easein|easeout|easeinout))?(?: async "(\w+)")?)?\s*$/,
        (m) => ({ op: 'interp', target: m[1], value: [parseFloat(m[2]), parseFloat(m[3])], duration: m[4] ? parseFloat(m[4]) : 0, curve: m[5] || 'linear', async: m[6] ?? null })],
    ['mouse', /^\s*mouse (down|up|click)\s*$/, (m) => ({ op: 'mouse', action: m[1] })],
    ['keyboard', /^\s*keyboard "(.*)"\s*$/, (m) => ({ op: 'keyboard', text: m[1].replace(/\\n/g, '\n') })],
    ['letnum', /^\s*let (\w+) = (\d+)\s*$/, (m) => ({ op: 'let', name: m[1], value: parseInt(m[2], 10) })],
    ['letstr', /^\s*let (\w+) = "(.*)"\s*$/, (m) => ({ op: 'let', name: m[1], value: m[2] })],
    ['label', /^\s*(\w+):\s*$/, (m) => ({ op: 'label', name: m[1] })],
    ['goto', /^\s*goto (\w+)\s*$/, (m) => ({ op: 'goto', name: m[1] })],
    ['gosub', /^\s*gosub (\w+)\s*$/, (m) => ({ op: 'gosub', name: m[1] })],
    ['return', /^\s*return\s*$/, () => ({ op: 'return' })],
    ['cancel', /^\s*cancel async "(\w+)"\s*$/, (m) => ({ op: 'cancel', id: m[1] })],
    ['waitid', /^\s*wait for "(\w+)" to complete\s*$/, (m) => ({ op: 'waitid', id: m[1], before: 0 })],
    ['waituntil', /^\s*wait until ([\d.]+) seconds? before "(\w+)" completes\s*$/, (m) => ({ op: 'waitid', id: m[2], before: parseFloat(m[1]) })],
    ['wait', /^\s*wait for ([\d.]+) seconds?\s*$/, (m) => ({ op: 'wait', duration: parseFloat(m[1]) })],
    ['simul', /^\s*(start|end) simultaneous\s*$/, (m) => ({ op: m[1] === 'start' ? 'simstart' : 'simend' })],
    ['exit', /^\s*exit\s*$/, () => ({ op: 'exit' })],
];

function num(s) {
    return s === undefined ? null : parseInt(s, 10);
}

export function parseProgram(source, name = 'program') {
    const instructions = [];
    const labels = new Map();
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const c = line.indexOf('//');
        if (c >= 0) line = line.slice(0, c);
        if (!line.trim()) continue;
        let matched = false;
        for (const [, re, build] of RULES) {
            const m = line.match(re);
            if (m) {
                const ins = build(m);
                ins.line = i + 1;
                if (ins.op === 'label') labels.set(ins.name, instructions.length);
                instructions.push(ins);
                matched = true;
                break;
            }
        }
        if (!matched) throw new Error(`${name}:${i + 1}: Compile error: Unknown instruction '${line.trim()}'`);
    }
    for (const ins of instructions) {
        if ((ins.op === 'goto' || ins.op === 'gosub') && !labels.has(ins.name)) {
            throw new Error(`${name}:${ins.line}: Link error: Unknown label '${ins.name}'`);
        }
    }
    return { name, instructions, labels };
}
