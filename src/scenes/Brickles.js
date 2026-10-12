// Brickles: the 1985 black-and-white Macintosh Breakout clone, as a scene.
//
//   add brickles at X, Y size W, H [value 1]
//
// Bottom-left anchored on the window's content area (the base image Brickles.png
// carries the Desk-Accessory-style window, its title bar and the 1 px separator
// under the status strip). The control owns:
//   rows y-H+1 .. y-H+18   status strip: "Score" (Chicago 12) and the balls in reserve
//   row  y-H+19 .. y       the playfield: 6 x 10 patterned bricks, paddle, ball
// Paddle 32x4 near the bottom, ball 4x4 at a constant speed. The paddle follows the
// scripted mouse x (scene.vars.mouse[0], clamped to the field); with `value 1`
// ("autopilot") it tracks the ball itself with a little lag, aiming at a fixed
// sequence of paddle spots so the rebound angles vary, and lets one ball through on
// purpose every MISS_EVERY returns so a lost ball and a re-serve show up in the
// scene. Everything is deterministic: a fixed 1/120 s physics step, no randomness,
// and reset() restores the initial rack.

import { Control } from '../controls.js';

export const program = 'Brickles';
export const images = { Brickles: null };
export const fonts = ['Chicago12'];

const STEP = 1 / 120;
const STATUS_H = 19; // status strip incl. the separator row
const COLS = 10, ROWS = 6;
const BRICK_W = 15, BRICK_H = 6, PITCH_X = 16, PITCH_Y = 8;
const BRICKS_TOP = 16; // from the top of the playfield
const PADDLE_W = 32, PADDLE_H = 4, PADDLE_BOTTOM_GAP = 6; // rows of field left below the paddle
const BALL = 4;
const SPEED = 95; // px/s, constant
const MAX_ANGLE = (60 * Math.PI) / 180; // off vertical, at the paddle's very edge
const MIN_ANGLE = (12 * Math.PI) / 180;
const BALLS = 3;
const SERVE_DELAY = 1.0, LOST_DELAY = 1.2, OVER_DELAY = 3.0, RACK_DELAY = 1.0;
const ROW_POINTS = [7, 7, 4, 4, 1, 1];
// autopilot: where on the paddle (px from its centre) it tries to meet the ball, in turn
const AIMS = [-7, 5, -2, 9, -10, 3, 7, -5, 1, -9, 10, -4];
// the autopilot's deliberate miss: the 15th return of each ball (at 95 px/s the first
// ball goes at 31.1 s after the add, inside the script's paddle scene; a 15-minute
// headless run showed no other lost balls)
const MISS_EVERY = 15;
const MISS_AIM = 30;
const PADDLE_GAIN = 9; // 1/s, the autopilot's lag
const PADDLE_MAX = 170; // px/s
// serves: start x offset from the field centre and direction (sign of vx)
const SERVES = [[-24, 1], [30, -1], [-6, -1], [14, 1], [-36, 1], [40, -1]];

// 8x8-ish fills for the six brick rows (absolute coordinates, 1 = black)
const FILLS = [
    () => 1, // black
    (x, y) => ((y & 1) && !(x & 1)) || ((y & 3) === 2 && (x & 3) === 1) || ((y & 3) === 0 && (x & 3) === 3) ? 0 : 1, // dark grey (the DA border)
    (x, y) => ((x + y) & 1) === 0 ? 1 : 0, // 50 % grey
    (x, y) => ((x + y) & 3) < 2 ? 1 : 0, // diagonal stripes
    (x, y) => (y & 1) === 0 ? 1 : 0, // horizontal lines
    (x, y) => (x & 1) === 0 && (y & 1) === 0 && ((x + y) & 2) === 0 ? 1 : 0, // light grey
];

class BricklesControl extends Control {
    reset() {
        this.w = this.ins.w ?? 163;
        this.h = this.ins.h ?? 179;
        this.left = this.x;
        this.top = this.y - this.h + 1;
        this.right = this.x + this.w; // exclusive
        this.bottom = this.y + 1; // exclusive
        this.fieldTop = this.top + STATUS_H;
        this.bricksX = this.left + Math.floor((this.w - (COLS * PITCH_X - (PITCH_X - BRICK_W))) / 2);
        this.bricksY = this.fieldTop + BRICKS_TOP;
        this.paddleY = this.bottom - PADDLE_BOTTOM_GAP - PADDLE_H;
        this.autopilot = this.value === 1;

        this.bricks = new Uint8Array(ROWS * COLS).fill(1);
        this.score = 0;
        this.balls = BALLS; // including the one in play
        this.paddle = (this.left + this.right) / 2; // centre x
        this.ball = null; // {x, y, vx, vy} top-left
        this.state = 'wait';
        this.timer = SERVE_DELAY;
        this.serves = 0;
        this.returns = 0; // paddle hits of the current ball
        this.aim = 0;
        this.aims = 0;
        this.missing = false;
        this.acc = 0;
    }

    update(t, dt) {
        this.acc += dt;
        while (this.acc >= STEP - 1e-9) {
            this.acc -= STEP;
            this.step(STEP);
        }
    }

    step(h) {
        this.movePaddle(h);
        if (this.state !== 'play') {
            this.timer -= h;
            if (this.timer > 0) return;
            if (this.state === 'over') this.newGame();
            else if (this.state === 'rack') this.bricks.fill(1);
            this.serve();
            return;
        }
        const b = this.ball;
        // x axis: walls, then bricks
        b.x += b.vx * h;
        if (b.x < this.left) { b.x = this.left; b.vx = Math.abs(b.vx); }
        if (b.x + BALL > this.right) { b.x = this.right - BALL; b.vx = -Math.abs(b.vx); }
        if (this.hitBricks()) { b.x -= b.vx * h; b.vx = -b.vx; }
        if (!this.ball) return; // the last brick went
        // y axis: ceiling, bricks, paddle, floor
        const prevBottom = b.y + BALL;
        b.y += b.vy * h;
        if (b.y < this.fieldTop) { b.y = this.fieldTop; b.vy = Math.abs(b.vy); }
        if (this.hitBricks()) { b.y -= b.vy * h; b.vy = -b.vy; }
        if (!this.ball) return;
        const px = this.paddle - PADDLE_W / 2;
        if (b.vy > 0 && prevBottom <= this.paddleY && b.y + BALL > this.paddleY && b.x + BALL > px && b.x < px + PADDLE_W) {
            this.bounce();
        } else if (b.y >= this.bottom) {
            this.ball = null;
            this.balls--;
            this.state = this.balls > 0 ? 'lost' : 'over';
            this.timer = this.balls > 0 ? LOST_DELAY : OVER_DELAY;
        }
    }

    // Removes every brick the ball overlaps; true if there was one.
    hitBricks() {
        const b = this.ball;
        const c0 = Math.floor((b.x - this.bricksX) / PITCH_X), c1 = Math.floor((b.x + BALL - 1 - this.bricksX) / PITCH_X);
        const r0 = Math.floor((b.y - this.bricksY) / PITCH_Y), r1 = Math.floor((b.y + BALL - 1 - this.bricksY) / PITCH_Y);
        let hit = false;
        for (let r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1); r++) {
            for (let c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
                if (!this.bricks[r * COLS + c]) continue;
                const x = this.bricksX + c * PITCH_X, y = this.bricksY + r * PITCH_Y;
                if (b.x + BALL <= x || b.x >= x + BRICK_W || b.y + BALL <= y || b.y >= y + BRICK_H) continue;
                this.bricks[r * COLS + c] = 0;
                this.score += ROW_POINTS[r];
                hit = true;
            }
        }
        if (hit && !this.bricks.some((v) => v)) {
            this.ball = null;
            this.state = 'rack';
            this.timer = RACK_DELAY;
            return false;
        }
        return hit;
    }

    bounce() {
        const b = this.ball;
        b.y = this.paddleY - BALL;
        const off = (b.x + BALL / 2 - this.paddle) / (PADDLE_W / 2 + BALL / 2);
        let a = Math.max(-1, Math.min(1, off)) * MAX_ANGLE;
        if (Math.abs(a) < MIN_ANGLE) a = (a < 0 || (a === 0 && b.vx < 0) ? -1 : 1) * MIN_ANGLE;
        b.vx = SPEED * Math.sin(a);
        b.vy = -SPEED * Math.cos(a);
        this.returns++;
        this.nextAim();
    }

    nextAim() {
        this.missing = this.returns + 1 === MISS_EVERY;
        this.aim = AIMS[this.aims % AIMS.length];
        this.aims++;
    }

    // Where the ball's centre will cross the paddle row (walls only), or its x now.
    landingX() {
        const b = this.ball;
        let x = b.x + BALL / 2;
        if (b.vy <= 0) return x;
        x += b.vx * Math.max(0, (this.paddleY - b.y - BALL) / b.vy);
        const lo = this.left + BALL / 2, span = this.right - this.left - BALL;
        let u = (((x - lo) % (2 * span)) + 2 * span) % (2 * span);
        if (u > span) u = 2 * span - u;
        return lo + u;
    }

    serve() {
        const [dx, dir] = SERVES[this.serves % SERVES.length];
        this.serves++;
        const a = (32 * Math.PI) / 180;
        this.ball = {
            x: (this.left + this.right) / 2 + dx - BALL / 2,
            y: this.bricksY + ROWS * PITCH_Y + 22,
            vx: dir * SPEED * Math.sin(a),
            vy: SPEED * Math.cos(a),
        };
        this.state = 'play';
        this.returns = 0;
        this.nextAim();
    }

    newGame() {
        this.bricks.fill(1);
        this.score = 0;
        this.balls = BALLS;
    }

    movePaddle(h) {
        const lo = this.left + PADDLE_W / 2, hi = this.right - PADDLE_W / 2;
        if (!this.autopilot) {
            this.paddle = Math.max(lo, Math.min(hi, this.scene.vars.mouse[0]));
            return;
        }
        // follow the ball (or drift back to the middle while there is none), with lag
        let target = (this.left + this.right) / 2;
        if (this.ball && this.missing) {
            // the deliberate miss: wait beside the landing spot, on the side with room
            const land = this.landingX();
            target = land - MISS_AIM >= lo ? land - MISS_AIM : land + MISS_AIM;
        } else if (this.ball) {
            target = this.ball.x + BALL / 2 - this.aim;
        }
        const v = Math.max(-PADDLE_MAX, Math.min(PADDLE_MAX, (target - this.paddle) * PADDLE_GAIN));
        this.paddle = Math.max(lo, Math.min(hi, this.paddle + v * h));
    }

    draw(bm) {
        const f = this.font('Chicago12', 'Chicago12');
        // status strip
        bm.fillRect(this.left, this.top, this.w, STATUS_H - 1, 0);
        const base = this.top + 14;
        f.draw(bm, this.left + 4, base, `Score: ${this.score}`);
        const reserve = Math.max(0, this.balls - 1); // the ball in play (or about to be served) is not shown
        let x = this.right - 4 - BALL;
        for (let i = 0; i < reserve; i++, x -= BALL + 4) bm.fillRect(x, base - 7, BALL, BALL, 1);
        f.draw(bm, x - f.measure('Balls:') - 2 + BALL, base, 'Balls:');
        // field
        bm.fillRect(this.left, this.fieldTop, this.w, this.bottom - this.fieldTop, 0);
        for (let r = 0; r < ROWS; r++) {
            const fill = FILLS[r];
            for (let c = 0; c < COLS; c++) {
                if (!this.bricks[r * COLS + c]) continue;
                const bx = this.bricksX + c * PITCH_X, by = this.bricksY + r * PITCH_Y;
                for (let yy = 0; yy < BRICK_H; yy++) {
                    for (let xx = 0; xx < BRICK_W; xx++) {
                        const edge = yy === 0 || xx === 0 || yy === BRICK_H - 1 || xx === BRICK_W - 1;
                        if (edge || fill(bx + xx, by + yy)) bm.set(bx + xx, by + yy, 1);
                    }
                }
            }
        }
        bm.fillRect(Math.round(this.paddle - PADDLE_W / 2), this.paddleY, PADDLE_W, PADDLE_H, 1);
        if (this.ball) bm.fillRect(Math.round(this.ball.x), Math.round(this.ball.y), BALL, BALL, 1);
        if (this.state === 'over') {
            const text = 'Game Over';
            const tw = f.measure(text);
            const tx = Math.round((this.left + this.right - tw) / 2), ty = this.bricksY + ROWS * PITCH_Y + 40;
            bm.fillRect(tx - 6, ty - 14, tw + 12, 20, 0);
            f.draw(bm, tx, ty, text);
        }
    }
}

export const controls = { brickles: BricklesControl };
