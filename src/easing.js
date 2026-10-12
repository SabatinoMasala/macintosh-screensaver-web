// Interpolation curves named in the script grammar:
// linear | easein | easeout | easeinout | easeoutback

export const curves = {
    linear: (t) => t,
    easein: (t) => t * t,
    easeout: (t) => 1 - (1 - t) * (1 - t),
    easeinout: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    easeoutback: (t) => {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
};

export function ease(name, t) {
    const f = curves[name] || curves.linear;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return f(t);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
