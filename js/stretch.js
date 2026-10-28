// ============================================
// STRETCH - AudioLoft
// ============================================
//
// Changes speed without changing pitch, and pitch without changing speed.
//
// Speed is WSOLA (waveform-similarity overlap-add). The output is built from
// 50 ms Hann-windowed grains of the input laid down every 25 ms. Each grain
// comes from about where the new speed says it should, nudged by up to
// ±12.5 ms to the spot whose waveform best continues what was just written,
// so overlapping grains add up in phase instead of flanging.
//
// Pitch is a stretch followed by a resample: stretch by 1/q, then play the
// result q times faster. The length comes back and the pitch moves by q.
//
// The grain work runs in js/stretch-worker.js so a long file doesn't freeze
// the page. The same function runs here if the worker can't start.

(function (global) {
    'use strict';

    const GRAIN_HOP = 0.025;
    const SEARCH = 0.0125;
    const GUIDE_RATE = 11025;

    // Returns new channels `tempo` times faster (2 = half as long).
    function wsola(channels, sampleRate, tempo, onProgress) {
        const input = channels[0].length;
        const length = Math.max(1, Math.round(input / tempo));
        const hop = Math.max(64, Math.round(sampleRate * GRAIN_HOP));
        const size = hop * 2;
        const tolerance = Math.round(sampleRate * SEARCH);

        // Hann window: at 50% overlap the windows sum to exactly 1.
        const win = new Float32Array(size);
        for (let n = 0; n < size; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size);

        // The search compares a mono mix. A coarse pass runs on a copy
        // averaged down to about 11 kHz, then a fine pass at full rate.
        const pad = size * 2 + tolerance * 2;
        const mono = new Float32Array(input + pad);
        channels.forEach((ch) => {
            for (let i = 0; i < input; i++) mono[i] += ch[i];
        });
        const step = Math.max(1, Math.round(sampleRate / GUIDE_RATE));
        const guide = new Float32Array(Math.ceil(mono.length / step));
        for (let j = 0; j < guide.length; j++) {
            let sum = 0;
            for (let i = j * step, end = Math.min(mono.length, i + step); i < end; i++) sum += mono[i];
            guide[j] = sum / step;
        }
        // Running energy, so each candidate's score can be normalised cheaply.
        const energy = new Float64Array(guide.length + 1);
        for (let j = 0; j < guide.length; j++) energy[j + 1] = energy[j] + guide[j] * guide[j];

        const span = Math.max(1, Math.floor(hop / step));
        const reach = Math.max(1, Math.floor(tolerance / step));

        // Best start near `ideal` for a grain that continues the input at
        // `natural`, judged over the half where the grains overlap.
        function bestMatch(ideal, natural) {
            const ref = Math.round(natural / step);
            if (ref + span > guide.length) return ideal;
            const centre = Math.round(ideal / step);
            const lo = Math.max(0, centre - reach);
            const hi = Math.min(centre + reach, guide.length - span);
            let best = Math.min(Math.max(centre, lo), Math.max(lo, hi));
            let bestScore = -Infinity;
            for (let c = lo; c <= hi; c++) {
                let dot = 0;
                for (let j = 0; j < span; j++) dot += guide[ref + j] * guide[c + j];
                const score = dot / Math.sqrt(energy[c + span] - energy[c] + 1e-9);
                if (score > bestScore) {
                    bestScore = score;
                    best = c;
                }
            }
            let pos = best * step;
            if (step === 1 || natural + hop > mono.length) return pos;
            let fineScore = -Infinity;
            const from = Math.max(0, pos - step);
            const to = Math.min(pos + step, mono.length - hop);
            for (let p = from; p <= to; p++) {
                let dot = 0;
                let e = 1e-9;
                for (let n = 0; n < hop; n++) {
                    const v = mono[p + n];
                    dot += mono[natural + n] * v;
                    e += v * v;
                }
                const score = dot / Math.sqrt(e);
                if (score > fineScore) {
                    fineScore = score;
                    pos = p;
                }
            }
            return pos;
        }

        const out = channels.map(() => new Float32Array(length + size + hop));
        // Window sum per output sample; the first and last half grain only
        // get one window, so dividing by this keeps the ends at full level.
        const weight = new Float32Array(length + size + hop);
        const frames = Math.ceil(length / hop) + 1;
        let prev = 0;
        for (let k = 0; k < frames; k++) {
            const ideal = Math.round(k * hop * tempo);
            const pos = k === 0 ? 0 : bestMatch(ideal, prev + hop);
            const at = k * hop;
            const n1 = Math.min(size, input - pos);
            channels.forEach((src, c) => {
                const dst = out[c];
                for (let n = 0; n < n1; n++) dst[at + n] += src[pos + n] * win[n];
            });
            for (let n = 0; n < size; n++) weight[at + n] += win[n];
            prev = pos;
            if (onProgress && k % 256 === 0) onProgress(k / frames);
        }
        for (let i = 0; i < length; i++) {
            const w = weight[i];
            if (w > 1e-4 && w < 0.999) out.forEach((ch) => { ch[i] /= w; });
        }
        return out.map((ch) => ch.slice(0, length));
    }

    global.AudioLoftStretch = { wsola };

    // Everything below is for the page; the worker only needs wsola().
    const AL = global.AudioLoft;
    if (!AL) return;

    function inWorker(channels, sampleRate, tempo, onProgress) {
        return new Promise((resolve, reject) => {
            const worker = new Worker('js/stretch-worker.js');
            worker.onmessage = (event) => {
                const msg = event.data;
                if (msg.type === 'progress') {
                    if (onProgress) onProgress(msg.value);
                    return;
                }
                worker.terminate();
                if (msg.type === 'done') resolve(msg.channels);
                else reject(new Error(msg.message));
            };
            worker.onerror = (event) => {
                event.preventDefault();
                worker.terminate();
                reject(new Error(event.message || 'The stretch worker couldn’t start.'));
            };
            worker.postMessage({ channels, sampleRate, tempo });
        });
    }

    // Returns a new Clip played at `speed` (2 = twice as fast, same pitch)
    // and moved by `semitones` (same speed). The source isn't changed.
    async function changeSpeedAndPitch(clip, { speed = 1, semitones = 0 } = {}, onProgress) {
        const q = Math.pow(2, semitones / 12);
        const tempo = speed / q;
        let channels;
        try {
            channels = await inWorker(clip.channels, clip.sampleRate, tempo, onProgress);
        } catch (error) {
            channels = wsola(clip.channels, clip.sampleRate, tempo, onProgress);
        }
        if (q === 1) return new AL.Clip(channels, clip.sampleRate);
        // Read as if recorded q times faster: the pitch moves by q and the
        // length comes back to the source length over `speed`.
        return AL.resample(new AL.Clip(channels, clip.sampleRate * q), clip.sampleRate);
    }

    AL.changeSpeedAndPitch = changeSpeedAndPitch;
})(self);
