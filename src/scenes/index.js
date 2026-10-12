// Scene modules: one file per scene added by this project, each exporting
//   program  : 'Name'                      -> assets/programs/Name.program
//   images   : { Name: frameWidth|null }   -> assets/images/Name.png (frameWidth for sprite strips)
//   fonts    : ['Chicago12', ...]          -> the (Apple) fonts the module's controls draw with
//   controls : { kind: Class }             -> new `add <kind>` control kinds (Class extends Control)
// A missing or broken module only disables its own scene; so does a missing image
// or font among those it declares (the program is left out, see resources.js).

import { registerControl } from '../controls.js';

const MODULES = ['Mines', 'Hangman', 'Tetris', 'Brickles', 'Daleks', 'Solitaire', 'Chess', 'Excel', 'Photoshop', 'HyperCard', 'SolitaireWin'];

export async function loadSceneModules() {
    const out = { programs: [], images: {}, requires: {} };
    for (const name of MODULES) {
        let m;
        try {
            m = await import(`./${name}.js`);
        } catch (e) {
            console.warn(`Scene module ${name} not loaded: ${e.message}`);
            continue;
        }
        if (m.program) {
            out.programs.push(m.program);
            out.requires[m.program] = { images: Object.keys(m.images || {}), fonts: m.fonts || [] };
        }
        Object.assign(out.images, m.images || {});
        for (const [kind, Cls] of Object.entries(m.controls || {})) registerControl(kind, Cls);
    }
    return out;
}
