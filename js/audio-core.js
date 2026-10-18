// ============================================
// AUDIO CORE - AudioLoft
// ============================================
//
// Decoding, editing and encoding, all in the page. Nothing here touches the
// network: files are read with the File API, decoded by the browser's own
// Web Audio decoder, edited as plain Float32Arrays and written back out as
// WAV by hand. There are no third-party libraries.
//
// Audio is held as a Clip: one Float32Array per channel plus a sample rate.
// Every edit returns a new Clip, so the original stays untouched and can be
// re-exported with different settings.

(function (global) {
    'use strict';

    // Decoded audio is 32-bit float per sample per channel, so it is far
    // bigger than the compressed file: a 100 MB MP3 can decode to well over
    // 2 GB. The cap on the input file keeps us clear of a tab crash; the
    // decoded-size check below catches the rest.
    const MAX_FILE_BYTES = 500 * 1024 * 1024;
    const MAX_DECODED_BYTES = 1.6 * 1024 * 1024 * 1024;

    const ACCEPT = 'audio/*,.mp3,.wav,.ogg,.oga,.opus,.flac,.m4a,.aac,.webm,.weba,.aif,.aiff,.caf';

    class Clip {
        constructor(channels, sampleRate) {
            this.channels = channels;
            this.sampleRate = sampleRate;
        }

        get length() {
            return this.channels[0].length;
        }

        get duration() {
            return this.length / this.sampleRate;
        }

        get numberOfChannels() {
            return this.channels.length;
        }

        static fromAudioBuffer(audioBuffer) {
            const channels = [];
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
                // getChannelData hands back the buffer's own storage. The
                // AudioBuffer is thrown away after decoding, so taking it
                // without a copy halves peak memory.
                channels.push(audioBuffer.getChannelData(c));
            }
            return new Clip(channels, audioBuffer.sampleRate);
        }

        static silent(numberOfChannels, length, sampleRate) {
            const channels = [];
            for (let c = 0; c < numberOfChannels; c++) {
                channels.push(new Float32Array(length));
            }
            return new Clip(channels, sampleRate);
        }
    }

    // ---------- Decoding ----------

    // decodeAudioData resamples to its context's rate. Decoding in an
    // OfflineAudioContext created at the file's own rate keeps the audio
    // bit-identical where the format allows it, so we read the rate from the
    // header first. Unknown formats fall back to the device rate.
    function sniffSampleRate(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const tag = (o) => (o + 4 <= bytes.length
            ? String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
            : '');

        // WAV / RF64: walk the chunks until 'fmt '.
        if ((tag(0) === 'RIFF' || tag(0) === 'RF64') && tag(8) === 'WAVE') {
            let o = 12;
            while (o + 8 <= bytes.length) {
                const id = tag(o);
                const size = view.getUint32(o + 4, true);
                if (id === 'fmt ' && o + 16 <= bytes.length) {
                    return view.getUint32(o + 12, true);
                }
                o += 8 + size + (size & 1);
            }
            return null;
        }

        // AIFF: COMM chunk holds an 80-bit extended float.
        if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
            let o = 12;
            while (o + 8 <= bytes.length) {
                const id = tag(o);
                const size = view.getUint32(o + 4, false);
                if (id === 'COMM' && o + 26 <= bytes.length) {
                    const exp = view.getUint16(o + 16, false) & 0x7fff;
                    const mant = view.getUint32(o + 18, false);
                    return Math.round(mant * Math.pow(2, exp - 16383 - 31));
                }
                o += 8 + size + (size & 1);
            }
            return null;
        }

        // FLAC: STREAMINFO is always the first metadata block.
        if (tag(0) === 'fLaC' && bytes.length > 21) {
            return (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
        }

        // Ogg: Opus always decodes at 48 kHz; Vorbis states its rate.
        if (tag(0) === 'OggS') {
            const head = Math.min(bytes.length, 512);
            for (let o = 0; o < head - 16; o++) {
                if (bytes[o] === 0x4f && tag(o) === 'Opus' && tag(o + 4) === 'Head') {
                    return 48000;
                }
                if (bytes[o] === 0x01 && tag(o + 1) === 'vorb') {
                    return view.getUint32(o + 12, true);
                }
            }
            return null;
        }

        // MP3 / ADTS AAC: skip any ID3v2 tag, then find a frame header.
        let o = 0;
        if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length > 10) {
            const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
                ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
            o = 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
        }
        const limit = Math.min(bytes.length - 4, o + 16384);
        for (; o < limit; o++) {
            if (bytes[o] !== 0xff || (bytes[o + 1] & 0xe0) !== 0xe0) continue;
            const b1 = bytes[o + 1];
            const b2 = bytes[o + 2];
            const layer = (b1 >> 1) & 3;

            if ((b1 & 0xf6) === 0xf0) {
                // ADTS: layer bits are always 00.
                const idx = (b2 >> 2) & 0x0f;
                const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
                if (idx < rates.length) return rates[idx];
                continue;
            }

            const version = (b1 >> 3) & 3;
            const rateIdx = (b2 >> 2) & 3;
            const bitrateIdx = b2 >> 4;
            if (version === 1 || layer === 0 || rateIdx === 3 || bitrateIdx === 0 || bitrateIdx === 15) continue;
            const base = [44100, 48000, 32000][rateIdx];
            return version === 3 ? base : version === 2 ? base / 2 : base / 4;
        }
        return null;
    }

    let sharedContext = null;

    function getAudioContext() {
        if (!sharedContext) {
            const Ctor = global.AudioContext || global.webkitAudioContext;
            if (!Ctor) throw new Error('This browser does not support the Web Audio API.');
            sharedContext = new Ctor();
        }
        return sharedContext;
    }

    function deviceSampleRate() {
        try {
            return getAudioContext().sampleRate;
        } catch (error) {
            return 48000;
        }
    }

    async function decodeFile(file) {
        if (file.size > MAX_FILE_BYTES) {
            throw new Error(`“${file.name}” is ${formatBytes(file.size)}. AudioLoft handles files up to ${formatBytes(MAX_FILE_BYTES)}.`);
        }
        if (file.size === 0) {
            throw new Error(`“${file.name}” is empty.`);
        }

        const data = await file.arrayBuffer();
        const sniffed = sniffSampleRate(new Uint8Array(data, 0, Math.min(data.byteLength, 1 << 20)));
        const rate = sniffed && sniffed >= 8000 && sniffed <= 192000 ? sniffed : deviceSampleRate();

        let audioBuffer;
        try {
            audioBuffer = await decodeAt(data, rate);
        } catch (error) {
            throw new Error(`Couldn't decode “${file.name}”. The file may be damaged, or this browser can't read that format.`);
        }

        const decodedBytes = audioBuffer.length * audioBuffer.numberOfChannels * 4;
        if (decodedBytes > MAX_DECODED_BYTES) {
            throw new Error(`“${file.name}” is too long to edit in the browser (${formatTime(audioBuffer.duration)} of ${audioBuffer.numberOfChannels}-channel audio).`);
        }
        return Clip.fromAudioBuffer(audioBuffer);
    }

    function decodeAt(data, rate) {
        const Offline = global.OfflineAudioContext || global.webkitOfflineAudioContext;
        let ctx;
        try {
            ctx = new Offline(1, 1, rate);
        } catch (error) {
            ctx = getAudioContext();
        }
        // Old Safari only has the callback form.
        return new Promise((resolve, reject) => {
            const result = ctx.decodeAudioData(data, resolve, reject);
            if (result && typeof result.then === 'function') {
                result.then(resolve, reject);
            }
        });
    }

    // ---------- Editing ----------

    function toSample(clip, seconds) {
        return Math.max(0, Math.min(clip.length, Math.round(seconds * clip.sampleRate)));
    }

    function slice(clip, start, end) {
        const a = toSample(clip, start);
        const b = Math.max(a, toSample(clip, end));
        return new Clip(clip.channels.map((ch) => ch.slice(a, b)), clip.sampleRate);
    }

    function copy(clip) {
        return new Clip(clip.channels.map((ch) => ch.slice()), clip.sampleRate);
    }

    // Cutting a hole straight through a waveform leaves a step, which plays as
    // a click. A few milliseconds of crossfade at the seam hides it.
    const SEAM_SECONDS = 0.004;

    function removeRange(clip, start, end) {
        const before = slice(clip, 0, start);
        const after = slice(clip, end, clip.duration);
        if (before.length === 0) return after;
        if (after.length === 0) return before;
        return concat([before, after], { crossfade: SEAM_SECONDS });
    }

    // Clips must already share a sample rate and channel count (see conform).
    // A crossfade overlaps neighbours with an equal-power curve; otherwise
    // `gap` seconds of silence go between them.
    function concat(clips, options = {}) {
        if (clips.length === 0) throw new Error('Nothing to join.');
        const sampleRate = clips[0].sampleRate;
        const numberOfChannels = clips[0].numberOfChannels;
        const gap = Math.max(0, Math.round((options.gap || 0) * sampleRate));
        const fade = Math.max(0, Math.round((options.crossfade || 0) * sampleRate));

        // overlaps[i] is how far clip i slides back over clip i - 1.
        const overlaps = clips.map((clip, i) =>
            i === 0 || fade === 0 ? 0 : Math.min(fade, clip.length, clips[i - 1].length));

        let total = 0;
        clips.forEach((clip, i) => {
            total += clip.length - overlaps[i] + (i > 0 && fade === 0 ? gap : 0);
        });

        const out = Clip.silent(numberOfChannels, total, sampleRate);
        let pos = 0;
        clips.forEach((clip, i) => {
            if (i > 0) pos += fade === 0 ? gap : -overlaps[i];
            const fadeIn = overlaps[i];
            const fadeOut = i + 1 < clips.length ? overlaps[i + 1] : 0;
            const len = clip.length;
            for (let c = 0; c < numberOfChannels; c++) {
                const src = clip.channels[c];
                const dst = out.channels[c];
                for (let j = 0; j < len; j++) {
                    let g = 1;
                    if (j < fadeIn) g *= Math.sin((j / fadeIn) * Math.PI / 2);
                    const k = len - j;
                    // Mirrors the next clip's fade-in sample for sample, so
                    // the two gains always sum to constant power.
                    if (k <= fadeOut) g *= Math.sin((k / fadeOut) * Math.PI / 2);
                    dst[pos + j] += src[j] * g;
                }
            }
            pos += len;
        });
        return out;
    }

    function applyFades(clip, fadeIn, fadeOut) {
        const inLen = Math.min(clip.length, Math.round(Math.max(0, fadeIn) * clip.sampleRate));
        const outLen = Math.min(clip.length, Math.round(Math.max(0, fadeOut) * clip.sampleRate));
        if (!inLen && !outLen) return clip;
        const len = clip.length;
        for (const ch of clip.channels) {
            for (let j = 0; j < inLen; j++) ch[j] *= j / inLen;
            for (let j = 0; j < outLen; j++) ch[len - 1 - j] *= j / outLen;
        }
        return clip;
    }

    function peakOf(clip) {
        let peak = 0;
        for (const ch of clip.channels) {
            for (let j = 0; j < ch.length; j++) {
                const v = ch[j] < 0 ? -ch[j] : ch[j];
                if (v > peak) peak = v;
            }
        }
        return peak;
    }

    function normalize(clip, targetDb = -1) {
        const peak = peakOf(clip);
        if (peak === 0) return clip;
        const gain = Math.pow(10, targetDb / 20) / peak;
        for (const ch of clip.channels) {
            for (let j = 0; j < ch.length; j++) ch[j] *= gain;
        }
        return clip;
    }

    function applyGain(clip, db) {
        if (!db) return clip;
        const gain = Math.pow(10, db / 20);
        for (const ch of clip.channels) {
            for (let j = 0; j < ch.length; j++) ch[j] *= gain;
        }
        return clip;
    }

    function remix(clip, numberOfChannels) {
        if (clip.numberOfChannels === numberOfChannels) return clip;
        if (numberOfChannels === 1) {
            const mono = new Float32Array(clip.length);
            const scale = 1 / clip.numberOfChannels;
            for (const ch of clip.channels) {
                for (let j = 0; j < ch.length; j++) mono[j] += ch[j] * scale;
            }
            return new Clip([mono], clip.sampleRate);
        }
        if (clip.numberOfChannels === 1) {
            const channels = [];
            for (let c = 0; c < numberOfChannels; c++) channels.push(clip.channels[0].slice());
            return new Clip(channels, clip.sampleRate);
        }
        return new Clip(clip.channels.slice(0, numberOfChannels), clip.sampleRate);
    }

    async function resample(clip, sampleRate) {
        if (clip.sampleRate === sampleRate) return clip;
        const Offline = global.OfflineAudioContext || global.webkitOfflineAudioContext;
        const length = Math.max(1, Math.round(clip.length * sampleRate / clip.sampleRate));
        const ctx = new Offline(clip.numberOfChannels, length, sampleRate);
        const buffer = ctx.createBuffer(clip.numberOfChannels, clip.length, clip.sampleRate);
        clip.channels.forEach((ch, c) => buffer.copyToChannel(ch, c));
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start();
        const rendered = await ctx.startRendering();
        return Clip.fromAudioBuffer(rendered);
    }

    // Brings a set of clips to one rate and channel layout so they can be
    // joined. 'auto' takes the highest rate and widest layout (up to stereo).
    async function conform(clips, options = {}) {
        const rate = options.sampleRate && options.sampleRate !== 'auto'
            ? Number(options.sampleRate)
            : Math.max(...clips.map((c) => c.sampleRate));
        const channels = options.channels && options.channels !== 'auto'
            ? Number(options.channels)
            : Math.min(2, Math.max(...clips.map((c) => c.numberOfChannels)));
        const out = [];
        for (const clip of clips) {
            out.push(await resample(remix(clip, channels), rate));
        }
        return out;
    }

    // ---------- Analysis ----------

    // Finds stretches quieter than `thresholdDb` lasting at least
    // `minSilence` seconds. Returns [{ start, end }] in seconds.
    function findSilences(clip, thresholdDb = -40, minSilence = 0.5) {
        const win = Math.max(1, Math.round(clip.sampleRate * 0.01));
        const threshold = Math.pow(10, thresholdDb / 20);
        const windows = Math.ceil(clip.length / win);
        const silences = [];
        let runStart = -1;

        for (let w = 0; w <= windows; w++) {
            let quiet = false;
            if (w < windows) {
                let sum = 0;
                let count = 0;
                const a = w * win;
                const b = Math.min(clip.length, a + win);
                for (const ch of clip.channels) {
                    for (let j = a; j < b; j++) sum += ch[j] * ch[j];
                    count += b - a;
                }
                quiet = Math.sqrt(sum / Math.max(1, count)) < threshold;
            }
            if (quiet && runStart < 0) runStart = w;
            if (!quiet && runStart >= 0) {
                const start = (runStart * win) / clip.sampleRate;
                const end = Math.min(clip.length, w * win) / clip.sampleRate;
                if (end - start >= minSilence) silences.push({ start, end });
                runStart = -1;
            }
        }
        return silences;
    }

    // Leading and trailing silence, for trimming segments.
    function audibleBounds(clip, thresholdDb = -40) {
        const threshold = Math.pow(10, thresholdDb / 20);
        let first = clip.length;
        let last = -1;
        for (const ch of clip.channels) {
            for (let j = 0; j < first; j++) {
                if (Math.abs(ch[j]) >= threshold) { first = j; break; }
            }
            for (let j = ch.length - 1; j > last; j--) {
                if (Math.abs(ch[j]) >= threshold) { last = j; break; }
            }
        }
        if (last < first) return null;
        return { start: first / clip.sampleRate, end: (last + 1) / clip.sampleRate };
    }

    // ---------- Encoding ----------

    function encodeWav(clip, bitDepth = 16) {
        const numberOfChannels = clip.numberOfChannels;
        const length = clip.length;
        const bytesPerSample = bitDepth / 8;
        const blockAlign = numberOfChannels * bytesPerSample;
        const dataSize = length * blockAlign;
        const isFloat = bitDepth === 32;

        if (44 + dataSize > 0xffffffff) {
            throw new Error('That export is over the 4 GB WAV limit. Try a shorter range or a lower bit depth.');
        }

        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const writeTag = (o, s) => { for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i)); };

        writeTag(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeTag(8, 'WAVE');
        writeTag(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, isFloat ? 3 : 1, true);
        view.setUint16(22, numberOfChannels, true);
        view.setUint32(24, clip.sampleRate, true);
        view.setUint32(28, clip.sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        writeTag(36, 'data');
        view.setUint32(40, dataSize, true);

        const chans = clip.channels;
        if (bitDepth === 16) {
            // Byte 44 is 2-aligned, so a typed array view is safe and far
            // quicker than DataView calls per sample. WAV is little-endian,
            // as is every platform a browser runs on.
            const out = new Int16Array(buffer, 44, length * numberOfChannels);
            let k = 0;
            for (let i = 0; i < length; i++) {
                for (let c = 0; c < numberOfChannels; c++) {
                    let s = chans[c][i];
                    s = s > 1 ? 1 : s < -1 ? -1 : s;
                    out[k++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
                }
            }
        } else if (isFloat) {
            const out = new Float32Array(buffer, 44, length * numberOfChannels);
            let k = 0;
            for (let i = 0; i < length; i++) {
                for (let c = 0; c < numberOfChannels; c++) out[k++] = chans[c][i];
            }
        } else {
            const out = new Uint8Array(buffer, 44);
            let k = 0;
            for (let i = 0; i < length; i++) {
                for (let c = 0; c < numberOfChannels; c++) {
                    let s = chans[c][i];
                    s = s > 1 ? 1 : s < -1 ? -1 : s;
                    const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
                    out[k++] = v & 0xff;
                    out[k++] = (v >> 8) & 0xff;
                    out[k++] = (v >> 16) & 0xff;
                }
            }
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }

    function estimateWavBytes(clip, bitDepth = 16) {
        return 44 + clip.length * clip.numberOfChannels * (bitDepth / 8);
    }

    // ---------- ZIP (store only) ----------
    // WAV barely compresses, so storing is the right call and keeps this tiny.

    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }

    async function makeZip(entries) {
        const encoder = new TextEncoder();
        const now = new Date();
        const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        const parts = [];
        const central = [];
        let offset = 0;

        for (const entry of entries) {
            const data = new Uint8Array(await entry.blob.arrayBuffer());
            const name = encoder.encode(entry.name);
            const crc = crc32(data);

            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true);
            local.setUint16(4, 20, true);
            local.setUint16(6, 0x0800, true); // UTF-8 names
            local.setUint16(8, 0, true);
            local.setUint16(10, dosTime, true);
            local.setUint16(12, dosDate, true);
            local.setUint32(14, crc, true);
            local.setUint32(18, data.length, true);
            local.setUint32(22, data.length, true);
            local.setUint16(26, name.length, true);
            local.setUint16(28, 0, true);
            parts.push(local.buffer, name, data);

            const cd = new DataView(new ArrayBuffer(46));
            cd.setUint32(0, 0x02014b50, true);
            cd.setUint16(4, 20, true);
            cd.setUint16(6, 20, true);
            cd.setUint16(8, 0x0800, true);
            cd.setUint16(10, 0, true);
            cd.setUint16(12, dosTime, true);
            cd.setUint16(14, dosDate, true);
            cd.setUint32(16, crc, true);
            cd.setUint32(20, data.length, true);
            cd.setUint32(24, data.length, true);
            cd.setUint16(28, name.length, true);
            cd.setUint32(42, offset, true);
            central.push(cd.buffer, name);

            offset += 30 + name.length + data.length;
        }

        const centralSize = central.reduce((n, part) => n + part.byteLength, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, offset, true);

        if (offset + centralSize > 0xffffffff) {
            throw new Error('The ZIP would be over 4 GB. Download the segments one at a time instead.');
        }
        return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    }

    // ---------- Demo audio ----------
    // A short synthesized piece so the tools can be tried without a file.
    // Phrases are separated by silence, which gives Split's silence detection
    // something to find.

    function createDemoClip(variant = 0) {
        const sampleRate = 44100;
        const keys = [
            [261.63, 329.63, 392.0, 523.25, 392.0, 329.63],
            [220.0, 277.18, 329.63, 440.0, 329.63, 277.18],
            [293.66, 369.99, 440.0, 587.33, 440.0, 369.99],
            [196.0, 246.94, 293.66, 392.0, 293.66, 246.94]
        ];
        const scale = keys[variant % keys.length];
        const phrases = variant === 0 ? 3 : 2;
        const noteLen = 0.28;
        const phraseLen = scale.length * noteLen + 0.6;
        const rest = 1.1;
        const total = Math.round((phrases * phraseLen + (phrases - 1) * rest + 0.4) * sampleRate);
        const clip = Clip.silent(2, total, sampleRate);
        const [left, right] = clip.channels;

        for (let p = 0; p < phrases; p++) {
            const phraseStart = 0.2 + p * (phraseLen + rest);
            scale.forEach((base, n) => {
                const freq = base * (p === 1 ? 1.122 : p === 2 ? 0.891 : 1);
                const start = Math.round((phraseStart + n * noteLen) * sampleRate);
                const len = Math.round((noteLen + 0.55) * sampleRate);
                const pan = 0.5 + 0.35 * Math.sin(n + p);
                for (let j = 0; j < len && start + j < total; j++) {
                    const t = j / sampleRate;
                    const env = Math.min(1, t / 0.01) * Math.exp(-t * 4.2);
                    const tone = Math.sin(2 * Math.PI * freq * t) +
                        0.32 * Math.sin(4 * Math.PI * freq * t) +
                        0.12 * Math.sin(6 * Math.PI * freq * t);
                    const v = tone * env * 0.42;
                    left[start + j] += v * (1 - pan);
                    right[start + j] += v * pan;
                }
            });
        }
        return clip;
    }

    // ---------- Formatting ----------

    function formatTime(seconds, precision = 3) {
        if (!isFinite(seconds)) seconds = 0;
        const negative = seconds < 0;
        seconds = Math.abs(seconds);
        const factor = Math.pow(10, precision);
        const rounded = Math.round(seconds * factor) / factor;
        const h = Math.floor(rounded / 3600);
        const m = Math.floor((rounded % 3600) / 60);
        const s = rounded % 60;
        const sec = precision > 0
            ? s.toFixed(precision).padStart(precision + 3, '0')
            : String(Math.floor(s)).padStart(2, '0');
        const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
        return (negative ? '-' : '') + body;
    }

    // Accepts "83.5", "1:23.5" or "1:01:23.5". Returns NaN when unparseable.
    function parseTime(text) {
        const parts = String(text).trim().split(':');
        if (parts.length > 3 || parts.some((p) => p.trim() === '' || !/^\d*\.?\d*$/.test(p.trim()))) return NaN;
        return parts.reduce((total, part) => total * 60 + parseFloat(part), 0);
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        const units = ['KB', 'MB', 'GB'];
        let value = bytes / 1024;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
    }

    function baseName(filename) {
        return filename.replace(/\.[^./\\]+$/, '') || 'audio';
    }

    // Strips characters that are invalid in filenames on any common OS.
    function safeFileName(name, fallback = 'audio') {
        const cleaned = String(name)
            .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
            .replace(/^[\s.]+|[\s.]+$/g, '')
            .slice(0, 150);
        return cleaned || fallback;
    }

    function withExtension(name, ext) {
        const base = safeFileName(name).replace(/\.wav$/i, '');
        return `${base}.${ext}`;
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Some browsers start the download asynchronously; give them time
        // before the object URL goes away.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    global.AudioLoft = Object.assign(global.AudioLoft || {}, {
        ACCEPT,
        MAX_FILE_BYTES,
        Clip,
        getAudioContext,
        decodeFile,
        sniffSampleRate,
        slice,
        copy,
        removeRange,
        concat,
        applyFades,
        normalize,
        applyGain,
        peakOf,
        remix,
        resample,
        conform,
        findSilences,
        audibleBounds,
        encodeWav,
        estimateWavBytes,
        makeZip,
        crc32,
        createDemoClip,
        formatTime,
        parseTime,
        formatBytes,
        baseName,
        safeFileName,
        withExtension,
        downloadBlob
    });
})(window);
