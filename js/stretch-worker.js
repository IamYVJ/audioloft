// ============================================
// STRETCH WORKER - AudioLoft
// ============================================
//
// Runs the WSOLA time stretch from js/stretch.js off the main thread.
//
// In:  { channels: Float32Array[], sampleRate, tempo }
// Out: { type: 'progress', value: 0..1 } ... then { type: 'done', channels }
//      or { type: 'error', message }

importScripts('stretch.js');

self.onmessage = (event) => {
    try {
        const { channels, sampleRate, tempo } = event.data;
        const out = self.AudioLoftStretch.wsola(channels, sampleRate, tempo, (value) => {
            self.postMessage({ type: 'progress', value });
        });
        self.postMessage({ type: 'done', channels: out }, out.map((ch) => ch.buffer));
    } catch (error) {
        self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
    }
};
