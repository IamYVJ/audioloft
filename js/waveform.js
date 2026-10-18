// ============================================
// WAVEFORM - AudioLoft
// ============================================
//
// Canvas waveform with a time ruler, zoom, a playhead and one of three
// interaction modes:
//
//   'range'   – drag to select a region; drag its edges to adjust (Trim)
//   'markers' – double-click to add split points; drag them to move (Split)
//   'view'    – playhead only (Join result preview)
//
// A click without dragging always moves the playhead. Ctrl/⌘ + wheel zooms
// at the pointer; horizontal or Shift + wheel scrolls when zoomed in.
//
// Peaks are summarised once per clip into 256-sample blocks, so drawing an
// hour of audio stays cheap. Zoomed in past that, columns read raw samples.

(function (global) {
    'use strict';

    const BLOCK = 256;
    const PEAK_CACHE = new WeakMap();
    const RULER = 24;

    const SEGMENT_COLORS = ['#ffb547', '#ff7a59', '#7cc7ff', '#b69cff', '#6fdc9b', '#ff8fc1'];

    const TICK_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
        60, 120, 300, 600, 900, 1800, 3600];

    class Waveform {
        constructor(container, options = {}) {
            this.container = container;
            this.mode = options.mode || 'range';
            this.height = options.height || 180;
            this.onseek = options.onseek || (() => {});
            this.onselect = options.onselect || (() => {});
            this.onmarkers = options.onmarkers || (() => {});

            this.clip = null;
            this.view = { start: 0, end: 0 };
            this.selection = null;
            this.markers = [];
            this.playhead = 0;
            this.hover = null;
            this.activeSegment = -1;
            this.drag = null;
            this.frame = 0;

            container.classList.add('waveform');
            container.tabIndex = 0;
            container.setAttribute('role', 'group');
            container.setAttribute('aria-roledescription', 'waveform');

            this.canvas = document.createElement('canvas');
            this.canvas.setAttribute('aria-hidden', 'true');
            this.canvas.style.height = `${this.height}px`;
            container.appendChild(this.canvas);
            this.ctx = this.canvas.getContext('2d');

            this.scroll = document.createElement('input');
            this.scroll.type = 'range';
            this.scroll.min = '0';
            this.scroll.max = '1000';
            this.scroll.step = '1';
            this.scroll.className = 'waveform-scroll';
            this.scroll.setAttribute('aria-label', 'Scroll waveform');
            this.scroll.hidden = true;
            container.appendChild(this.scroll);
            this.scroll.addEventListener('input', () => {
                const span = this.view.end - this.view.start;
                const start = (Number(this.scroll.value) / 1000) * (this.duration - span);
                this.setView(start, start + span);
            });

            this.bindEvents();

            this.resizeObserver = new ResizeObserver(() => this.resize());
            this.resizeObserver.observe(container);
            this.resize();
        }

        get duration() {
            return this.clip ? this.clip.duration : 0;
        }

        // ---------- Data ----------

        setClip(clip) {
            this.clip = clip;
            this.buildPeaks();
            this.view = { start: 0, end: clip.duration };
            this.selection = null;
            this.markers = [];
            this.playhead = 0;
            this.activeSegment = -1;
            this.updateScroll();
            this.render();
        }

        buildPeaks() {
            const clip = this.clip;
            // Studio switches between clips of the same source often; the
            // summary only depends on the audio, so keep one per clip.
            if (PEAK_CACHE.has(clip)) {
                this.peaks = PEAK_CACHE.get(clip);
                return;
            }
            const blocks = Math.ceil(clip.length / BLOCK);
            const min = new Float32Array(blocks);
            const max = new Float32Array(blocks);
            for (let b = 0; b < blocks; b++) {
                let lo = 1;
                let hi = -1;
                const a = b * BLOCK;
                const z = Math.min(clip.length, a + BLOCK);
                for (const ch of clip.channels) {
                    for (let j = a; j < z; j++) {
                        const v = ch[j];
                        if (v < lo) lo = v;
                        if (v > hi) hi = v;
                    }
                }
                min[b] = lo;
                max[b] = hi;
            }
            this.peaks = { min, max };
            PEAK_CACHE.set(clip, this.peaks);
        }

        setSelection(start, end, notify = true) {
            if (start === null || start === undefined) {
                this.selection = null;
            } else {
                let a = Math.max(0, Math.min(start, end, this.duration));
                let b = Math.min(this.duration, Math.max(start, end, 0));
                this.selection = { start: a, end: b };
            }
            this.render();
            if (notify) this.onselect(this.selection);
        }

        setMarkers(markers, notify = false) {
            this.markers = markers
                .filter((t) => t > 0 && t < this.duration)
                .sort((a, b) => a - b);
            this.render();
            if (notify) this.onmarkers(this.markers.slice());
        }

        setPlayhead(t) {
            this.playhead = t;
            this.render();
        }

        setActiveSegment(index) {
            this.activeSegment = index;
            this.render();
        }

        // ---------- View ----------

        minSpan() {
            if (!this.clip) return 0.01;
            // About four device pixels per sample at the deepest zoom.
            return Math.max(0.005, (this.cssWidth * 0.25) / this.clip.sampleRate);
        }

        setView(start, end) {
            const duration = this.duration;
            let span = Math.min(duration, Math.max(this.minSpan(), end - start));
            start = Math.max(0, Math.min(start, duration - span));
            this.view = { start, end: start + span };
            this.updateScroll();
            this.render();
        }

        zoomBy(factor, center) {
            if (!this.clip) return;
            const span = this.view.end - this.view.start;
            const anchor = center === undefined ? (this.view.start + this.view.end) / 2 : center;
            const ratio = (anchor - this.view.start) / span;
            const next = Math.min(this.duration, Math.max(this.minSpan(), span / factor));
            const start = anchor - ratio * next;
            this.setView(start, start + next);
        }

        zoomToFit() {
            this.setView(0, this.duration);
        }

        zoomToRange(start, end) {
            const pad = (end - start) * 0.08;
            this.setView(start - pad, end + pad);
        }

        isZoomed() {
            return this.clip && this.view.end - this.view.start < this.duration - 1e-6;
        }

        // Keeps a moving playhead on screen while zoomed in.
        follow(t) {
            if (!this.isZoomed()) return;
            const span = this.view.end - this.view.start;
            if (t > this.view.end || t < this.view.start) {
                this.setView(t - span * 0.1, t + span * 0.9);
            }
        }

        updateScroll() {
            const zoomed = this.isZoomed();
            this.scroll.hidden = !zoomed;
            if (!zoomed) return;
            const span = this.view.end - this.view.start;
            const free = this.duration - span;
            this.scroll.value = String(free > 0 ? Math.round((this.view.start / free) * 1000) : 0);
            const thumb = Math.max(28, (span / this.duration) * (this.cssWidth || 600));
            this.scroll.style.setProperty('--thumb', `${thumb}px`);
        }

        // ---------- Geometry ----------

        timeAt(x) {
            const span = this.view.end - this.view.start;
            return Math.max(0, Math.min(this.duration, this.view.start + (x / this.cssWidth) * span));
        }

        xAt(t) {
            const span = this.view.end - this.view.start || 1;
            return ((t - this.view.start) / span) * this.cssWidth;
        }

        resize() {
            const dpr = Math.max(1, global.devicePixelRatio || 1);
            const width = this.container.clientWidth || 600;
            this.cssWidth = width;
            this.dpr = dpr;
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(this.height * dpr);
            this.colsMin = new Float32Array(this.canvas.width);
            this.colsMax = new Float32Array(this.canvas.width);
            this.updateScroll();
            this.draw();
        }

        render() {
            if (this.frame) return;
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.draw();
            });
        }

        // ---------- Drawing ----------

        computeColumns() {
            const clip = this.clip;
            const W = this.canvas.width;
            const sr = clip.sampleRate;
            const span = this.view.end - this.view.start;
            const { min, max } = this.peaks;
            const len = clip.length;
            for (let x = 0; x < W; x++) {
                let s0 = Math.floor((this.view.start + (x / W) * span) * sr);
                let s1 = Math.floor((this.view.start + ((x + 1) / W) * span) * sr);
                if (s1 <= s0) s1 = s0 + 1;
                s0 = Math.min(s0, len);
                s1 = Math.min(s1, len);
                let lo = 0;
                let hi = 0;
                if (s1 - s0 >= BLOCK * 2) {
                    lo = 1;
                    hi = -1;
                    const b1 = Math.min(min.length, Math.ceil(s1 / BLOCK));
                    for (let b = Math.floor(s0 / BLOCK); b < b1; b++) {
                        if (min[b] < lo) lo = min[b];
                        if (max[b] > hi) hi = max[b];
                    }
                } else if (s1 > s0) {
                    lo = 1;
                    hi = -1;
                    for (const ch of clip.channels) {
                        for (let j = s0; j < s1; j++) {
                            const v = ch[j];
                            if (v < lo) lo = v;
                            if (v > hi) hi = v;
                        }
                    }
                }
                this.colsMin[x] = lo;
                this.colsMax[x] = hi;
            }
        }

        drawColumns(x0, x1, style) {
            const ctx = this.ctx;
            const top = RULER * this.dpr;
            const h = this.canvas.height - top;
            const mid = top + h / 2;
            const amp = (h / 2) * 0.9;
            x0 = Math.max(0, Math.floor(x0));
            x1 = Math.min(this.canvas.width, Math.ceil(x1));
            ctx.fillStyle = style;
            for (let x = x0; x < x1; x++) {
                const y1 = mid - this.colsMax[x] * amp;
                const y2 = mid - this.colsMin[x] * amp;
                ctx.fillRect(x, y1, 1, Math.max(this.dpr, y2 - y1));
            }
        }

        draw() {
            const ctx = this.ctx;
            const W = this.canvas.width;
            const H = this.canvas.height;
            const dpr = this.dpr;
            const top = RULER * dpr;

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#0d0c0b';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#121110';
            ctx.fillRect(0, 0, W, top);
            ctx.fillStyle = '#211e1b';
            ctx.fillRect(0, top - dpr, W, dpr);

            if (!this.clip || this.duration === 0) return;

            this.computeColumns();
            const px = (t) => this.xAt(t) * dpr;

            const gradient = ctx.createLinearGradient(0, top, 0, H);
            gradient.addColorStop(0, '#ffcf80');
            gradient.addColorStop(0.5, '#ff9f4f');
            gradient.addColorStop(1, '#ffcf80');

            // Centre line.
            ctx.fillStyle = '#26221f';
            ctx.fillRect(0, Math.round(top + (H - top) / 2), W, dpr);

            if (this.mode === 'range') {
                const sel = this.selection;
                if (sel && sel.end > sel.start) {
                    const a = px(sel.start);
                    const b = px(sel.end);
                    ctx.fillStyle = 'rgba(255, 181, 71, 0.07)';
                    ctx.fillRect(a, top, b - a, H - top);
                    this.drawColumns(0, W, '#4a433d');
                    this.drawColumns(a, b, gradient);
                } else {
                    this.drawColumns(0, W, gradient);
                }
            } else if (this.mode === 'markers') {
                const bounds = [0, ...this.markers, this.duration];
                for (let i = 0; i < bounds.length - 1; i++) {
                    const a = px(bounds[i]);
                    const b = px(bounds[i + 1]);
                    if (b < 0 || a > W) continue;
                    const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
                    if (i === this.activeSegment) {
                        ctx.fillStyle = hexAlpha(color, 0.12);
                        ctx.fillRect(a, top, b - a, H - top);
                    }
                    this.drawColumns(a, b, color);
                }
            } else {
                this.drawColumns(0, W, gradient);
            }

            this.drawRuler();

            if (this.mode === 'range' && this.selection && this.selection.end > this.selection.start) {
                this.drawEdge(px(this.selection.start), '#ffb547');
                this.drawEdge(px(this.selection.end), '#ffb547');
            }

            if (this.mode === 'markers') {
                ctx.font = `600 ${10 * dpr}px ui-monospace, Consolas, monospace`;
                this.markers.forEach((t, i) => {
                    const x = px(t);
                    if (x < -10 * dpr || x > W + 10 * dpr) return;
                    const dragging = this.drag && this.drag.type === 'marker' && this.drag.index === i;
                    ctx.fillStyle = dragging ? '#ffffff' : '#f6f0e8';
                    ctx.fillRect(Math.round(x - dpr / 2), top, dpr * (dragging ? 2 : 1.5), H - top);
                    // Flag in the ruler.
                    ctx.beginPath();
                    ctx.moveTo(x, top);
                    ctx.lineTo(x - 6 * dpr, top - 9 * dpr);
                    ctx.lineTo(x + 6 * dpr, top - 9 * dpr);
                    ctx.closePath();
                    ctx.fill();
                });
            }

            if (this.hover !== null && !this.drag) {
                ctx.fillStyle = 'rgba(246, 240, 232, 0.18)';
                ctx.fillRect(Math.round(px(this.hover)), top, dpr, H - top);
            }

            const p = px(this.playhead);
            if (p >= -dpr && p <= W + dpr) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(Math.round(p - dpr / 2), 0, dpr * 1.5, H);
                ctx.beginPath();
                ctx.arc(p, 3 * dpr, 4 * dpr, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        drawEdge(x, color) {
            const ctx = this.ctx;
            const dpr = this.dpr;
            const top = RULER * dpr;
            const H = this.canvas.height;
            ctx.fillStyle = color;
            ctx.fillRect(Math.round(x - dpr), top, 2 * dpr, H - top);
            // Grip, centred vertically.
            const gh = 30 * dpr;
            const gw = 8 * dpr;
            const gy = top + (H - top - gh) / 2;
            roundRect(ctx, x - gw / 2, gy, gw, gh, 4 * dpr);
            ctx.fill();
            ctx.fillStyle = 'rgba(29, 18, 6, 0.75)';
            ctx.fillRect(x - dpr, gy + 9 * dpr, 2 * dpr, gh - 18 * dpr);
        }

        drawRuler() {
            const ctx = this.ctx;
            const dpr = this.dpr;
            const span = this.view.end - this.view.start;
            const pps = this.cssWidth / span;
            const step = TICK_STEPS.find((s) => s * pps >= 90) || 3600;
            const minor = step / 5;
            const top = RULER * dpr;
            const precision = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;

            ctx.fillStyle = '#3a3530';
            const firstMinor = Math.ceil(this.view.start / minor) * minor;
            for (let t = firstMinor; t <= this.view.end; t += minor) {
                const x = Math.round(this.xAt(t) * dpr);
                ctx.fillRect(x, top - 5 * dpr, dpr, 5 * dpr);
            }

            ctx.font = `500 ${10.5 * dpr}px ui-monospace, Consolas, monospace`;
            ctx.textBaseline = 'middle';
            const first = Math.ceil(this.view.start / step) * step;
            for (let t = first; t <= this.view.end + 1e-9; t += step) {
                const x = Math.round(this.xAt(t) * dpr);
                ctx.fillStyle = '#5a534c';
                ctx.fillRect(x, top - 10 * dpr, dpr, 10 * dpr);
                const label = formatTick(t, precision);
                if (x + 5 * dpr + ctx.measureText(label).width <= this.canvas.width) {
                    ctx.fillStyle = '#8a8178';
                    ctx.fillText(label, x + 5 * dpr, 9 * dpr);
                }
            }
        }

        // ---------- Interaction ----------

        bindEvents() {
            const canvas = this.canvas;

            canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
            canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
            canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
            canvas.addEventListener('pointercancel', () => this.endDrag(false));
            canvas.addEventListener('pointerleave', () => {
                if (!this.drag) {
                    this.hover = null;
                    this.render();
                }
            });
            canvas.addEventListener('dblclick', (e) => this.doubleClick(e));
            canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
            this.container.addEventListener('keydown', (e) => this.keyDown(e));
        }

        localX(e) {
            const rect = this.canvas.getBoundingClientRect();
            return e.clientX - rect.left;
        }

        hitTest(x, pointerType) {
            const tol = pointerType === 'touch' ? 16 : 7;
            if (this.mode === 'range' && this.selection && this.selection.end > this.selection.start) {
                const a = this.xAt(this.selection.start);
                const b = this.xAt(this.selection.end);
                const da = Math.abs(x - a);
                const db = Math.abs(x - b);
                if (Math.min(da, db) <= tol) return { type: da <= db ? 'start' : 'end' };
            }
            if (this.mode === 'markers') {
                let best = -1;
                let bestDist = tol + 1;
                this.markers.forEach((t, i) => {
                    const d = Math.abs(x - this.xAt(t));
                    if (d < bestDist) {
                        best = i;
                        bestDist = d;
                    }
                });
                if (best >= 0) return { type: 'marker', index: best };
            }
            return null;
        }

        pointerDown(e) {
            if (!this.clip || e.button > 0) return;
            this.container.focus({ preventScroll: true });
            const x = this.localX(e);
            const hit = this.hitTest(x, e.pointerType);
            this.drag = hit || { type: 'new', anchor: this.timeAt(x), x0: x, moved: false };
            this.drag.pointerId = e.pointerId;
            try {
                this.canvas.setPointerCapture(e.pointerId);
            } catch (error) {
                /* Pointer already gone. */
            }
            if (hit) this.container.classList.add('is-grabbing');
            e.preventDefault();
        }

        pointerMove(e) {
            if (!this.clip) return;
            const x = this.localX(e);
            const t = this.timeAt(x);
            this.hover = t;

            if (!this.drag) {
                this.container.classList.toggle('is-resize', Boolean(this.hitTest(x, e.pointerType)));
                this.render();
                return;
            }

            const drag = this.drag;
            if (drag.type === 'start' || drag.type === 'end') {
                const other = drag.type === 'start' ? this.selection.end : this.selection.start;
                if ((drag.type === 'start' && t > other) || (drag.type === 'end' && t < other)) {
                    drag.type = drag.type === 'start' ? 'end' : 'start';
                }
                this.setSelection(Math.min(t, other), Math.max(t, other));
            } else if (drag.type === 'marker') {
                this.markers[drag.index] = Math.max(0.001, Math.min(this.duration - 0.001, t));
                this.render();
            } else if (drag.type === 'new') {
                if (!drag.moved && Math.abs(x - drag.x0) > 3) drag.moved = true;
                if (drag.moved && this.mode === 'range') {
                    this.setSelection(drag.anchor, t);
                }
            }
        }

        pointerUp(e) {
            if (!this.drag) return;
            const drag = this.drag;
            if (drag.type === 'new' && !drag.moved) {
                this.onseek(this.timeAt(this.localX(e)));
            }
            this.endDrag(true);
        }

        endDrag(commit) {
            const drag = this.drag;
            this.drag = null;
            this.container.classList.remove('is-grabbing');
            if (drag && drag.type === 'marker' && commit) {
                this.setMarkers(this.markers, true);
            }
            this.render();
        }

        doubleClick(e) {
            if (!this.clip) return;
            const x = this.localX(e);
            if (this.mode === 'markers') {
                const hit = this.hitTest(x, e.pointerType);
                if (hit && hit.type === 'marker') {
                    this.markers.splice(hit.index, 1);
                } else {
                    this.markers.push(this.timeAt(x));
                }
                this.setMarkers(this.markers, true);
            } else if (this.mode === 'range') {
                this.setSelection(0, this.duration);
            }
        }

        wheel(e) {
            if (!this.clip) return;
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
                this.zoomBy(factor, this.timeAt(this.localX(e)));
                return;
            }
            const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
            if (horizontal && this.isZoomed()) {
                e.preventDefault();
                const span = this.view.end - this.view.start;
                const shift = (horizontal / this.cssWidth) * span * (e.deltaMode === 1 ? 20 : 1);
                this.setView(this.view.start + shift, this.view.end + shift);
            }
        }

        keyDown(e) {
            if (!this.clip || e.target !== this.container) return;
            const step = e.shiftKey ? 0.1 : 1;
            let handled = true;
            switch (e.key) {
                case 'ArrowLeft':
                    this.onseek(Math.max(0, this.playhead - step));
                    break;
                case 'ArrowRight':
                    this.onseek(Math.min(this.duration, this.playhead + step));
                    break;
                case 'Home':
                    this.onseek(0);
                    break;
                case 'End':
                    this.onseek(this.duration);
                    break;
                case '+':
                case '=':
                    this.zoomBy(2, this.playhead);
                    break;
                case '-':
                case '_':
                    this.zoomBy(0.5, this.playhead);
                    break;
                default:
                    handled = false;
            }
            if (handled) e.preventDefault();
        }

        destroy() {
            this.resizeObserver.disconnect();
            cancelAnimationFrame(this.frame);
            this.container.innerHTML = '';
        }
    }

    function formatTick(t, precision) {
        const m = Math.floor(t / 60);
        const s = t - m * 60;
        const sec = precision ? s.toFixed(precision).padStart(precision + 3, '0') : String(Math.round(s)).padStart(2, '0');
        if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}`;
        return `${m}:${sec}`;
    }

    function hexAlpha(hex, alpha) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    // Small static waveform for list rows. `start` / `end` (seconds) draw
    // just part of the clip.
    function drawMiniWave(canvas, clip, color = '#ffb547', start = 0, end = clip.duration) {
        const dpr = Math.max(1, global.devicePixelRatio || 1);
        // Capped: a long clip zoomed in can be wider than a canvas may be.
        const width = Math.min(4096, canvas.clientWidth || 300);
        const height = canvas.clientHeight || 30;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        const ctx = canvas.getContext('2d');
        const cols = Math.max(1, Math.floor(canvas.width / (3 * dpr)));
        const first = Math.max(0, Math.floor(start * clip.sampleRate));
        const last = Math.min(clip.length, Math.ceil(end * clip.sampleRate));
        const per = Math.max(1, last - first) / cols;
        const mid = canvas.height / 2;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = color;
        for (let i = 0; i < cols; i++) {
            const a = first + Math.floor(i * per);
            const b = Math.min(last, first + Math.floor((i + 1) * per));
            // Sample sparsely: this is decoration, not measurement.
            const stride = Math.max(1, Math.floor((b - a) / 400));
            let peak = 0;
            for (const ch of clip.channels) {
                for (let j = a; j < b; j += stride) {
                    const v = ch[j] < 0 ? -ch[j] : ch[j];
                    if (v > peak) peak = v;
                }
            }
            const h = Math.max(dpr, Math.min(1, peak) * canvas.height * 0.92);
            roundRect(ctx, i * 3 * dpr, mid - h / 2, 2 * dpr, h, dpr);
            ctx.fill();
        }
    }

    global.AudioLoft = Object.assign(global.AudioLoft || {}, { Waveform, drawMiniWave, SEGMENT_COLORS });
})(window);
