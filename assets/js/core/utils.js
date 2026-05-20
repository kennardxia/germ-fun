/**
 * germ.fun — Shared Utilities
 */

// --- Math helpers --------------------------------------------------

export const lerp  = (a, b, t) => a + (b - a) * t;
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const randomRange  = (min, max) => min + Math.random() * (max - min);
export const randomInt    = (min, max) => Math.floor(randomRange(min, max + 1));
export const degToRad     = deg => deg * (Math.PI / 180);
export const radToDeg     = rad => rad * (180 / Math.PI);
export const wrap         = (v, min, max) => v < min ? max : v > max ? min : v;
export const distance2D   = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const angleBetween = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);

/**
 * Smooth-damp: spring-like interpolation, good for camera follow.
 * @returns {[value, velocity]}
 */
export function smoothDamp(current, target, velocity, smoothTime, dt) {
  const omega = 2 / Math.max(smoothTime, 0.0001);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const delta = current - target;
  const temp = (velocity + omega * delta) * dt;
  const newVel = (velocity - omega * temp) * exp;
  const newVal = target + (delta + temp) * exp;
  return [newVal, newVel];
}

// --- Delta-time tracker -------------------------------------------

export class DeltaTime {
  constructor() {
    this.last    = performance.now();
    this.dt      = 0;
    this.elapsed = 0;
    this.frame   = 0;
    this.fps     = 60;
    this._fpsSmooth = 60;
  }
  update() {
    const now = performance.now();
    this.dt = Math.min((now - this.last) / 1000, 0.1); // cap at 100ms
    this.elapsed += this.dt;
    this.last = now;
    this.frame++;
    this._fpsSmooth = lerp(this._fpsSmooth, 1 / (this.dt || 0.016), 0.1);
    this.fps = Math.round(this._fpsSmooth);
  }
}

// --- Object pool --------------------------------------------------

export class ObjectPool {
  /**
   * @param {() => T} factory    — Creates a new instance
   * @param {(obj: T) => void} reset — Resets to default state
   * @param {number} initialSize
   */
  constructor(factory, reset, initialSize = 32) {
    this.factory  = factory;
    this.reset    = reset;
    this._pool    = [];
    this.active   = [];

    for (let i = 0; i < initialSize; i++) {
      this._pool.push(factory());
    }
  }

  /** Get an object from the pool, or create one if empty */
  get() {
    const obj = this._pool.length > 0 ? this._pool.pop() : this.factory();
    this.reset(obj);
    this.active.push(obj);
    return obj;
  }

  /** Return an object to the pool */
  release(obj) {
    const i = this.active.indexOf(obj);
    if (i !== -1) {
      this.active.splice(i, 1);
      this._pool.push(obj);
    }
  }

  /** Release all active objects at once */
  releaseAll() {
    while (this.active.length > 0) {
      this._pool.push(this.active.pop());
    }
  }
}

// --- Canvas utilities ---------------------------------------------

export function resizeCanvas(canvas, quality = 1) {
  const w = Math.floor(canvas.clientWidth  * quality);
  const h = Math.floor(canvas.clientHeight * quality);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
    return true;
  }
  return false;
}

/**
 * Draw a rounded rectangle on a canvas 2D context.
 */
export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// --- Input manager ------------------------------------------------

export class InputManager {
  constructor() {
    this.keys     = new Set();
    this.pressed  = new Set(); // just-pressed this frame
    this.released = new Set(); // just-released this frame
    this._down    = new Set(); // helper

    window.addEventListener('keydown', e => {
      if (!this._down.has(e.code)) {
        this.pressed.add(e.code);
        this._down.add(e.code);
        // Prevent default for game keys to stop page scroll
        if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
          e.preventDefault();
        }
      }
      this.keys.add(e.code);
    });

    window.addEventListener('keyup', e => {
      this.keys.delete(e.code);
      this._down.delete(e.code);
      this.released.add(e.code);
    });
  }

  isDown(code)     { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  /** Call at end of each frame to clear just-pressed/released sets */
  flush() {
    this.pressed.clear();
    this.released.clear();
  }
}

// --- HUD helpers --------------------------------------------------

export function formatScore(n) {
  return n.toString().padStart(6, '0');
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
