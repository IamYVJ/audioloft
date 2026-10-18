// ============================================
// MP3 WORKER - AudioLoft
// ============================================
//
// Encodes PCM to MP3 with lamejs (lib/lame.min.js, LGPL-3.0) off the main
// thread, so the page stays responsive on long exports.
//
// In:  { channels: Float32Array[] (1 or 2), sampleRate, kbps }
// Out: { type: 'progress', value: 0..1 } ... then { type: 'done', blob }
//      or { type: 'error', message }

importScripts('../lib/lame.min.js');

self.onmessage = (event) => {
    try {
        const { channels, sampleRate, kbps } = event.data;
        const encoder = new lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
        const length = channels[0].length;
        // Any multiple of the 1152-sample MP3 frame works; bigger calls are
        // faster, smaller ones report progress more often.
        const block = 1152 * 64;
        const parts = [];
        const left = new Int16Array(block);
        const right = new Int16Array(block);

        const toInt16 = (src, dst, offset, n) => {
            for (let i = 0; i < n; i++) {
                let s = src[offset + i];
                s = s > 1 ? 1 : s < -1 ? -1 : s;
                dst[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
        };

        let lastReport = 0;
        for (let i = 0; i < length; i += block) {
            const n = Math.min(block, length - i);
            toInt16(channels[0], left, i, n);
            let out;
            if (channels.length > 1) {
                toInt16(channels[1], right, i, n);
                out = encoder.encodeBuffer(left.subarray(0, n), right.subarray(0, n));
            } else {
                out = encoder.encodeBuffer(left.subarray(0, n));
            }
            if (out.length) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
            const progress = (i + n) / length;
            if (progress - lastReport > 0.02) {
                lastReport = progress;
                self.postMessage({ type: 'progress', value: progress });
            }
        }
        const tail = encoder.flush();
        if (tail.length) parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length).slice());
        self.postMessage({ type: 'done', blob: new Blob(parts, { type: 'audio/mpeg' }) });
    } catch (error) {
        self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
    }
};
