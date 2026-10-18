// ============================================
// ENCODERS - AudioLoft
// ============================================
//
// Every export goes through AL.encode(clip, format). Formats are strings
// like 'wav:16', 'mp3:320' or 'aac:192':
//
//   WAV – written by hand in audio-core.js (lossless)
//   MP3 – lamejs in a Web Worker (js/mp3-worker.js), works everywhere
//   AAC – the browser's own WebCodecs AudioEncoder, packed into an .m4a by
//         the small MP4 writer below. Only offered where the browser can
//         actually encode AAC (Chrome / Edge; others vary).
//
// Nothing here touches the network.

(function (global) {
    'use strict';

    const AL = global.AudioLoft;

    const FORMATS = [
        { value: 'wav:16', label: 'WAV · 16-bit (lossless)', ext: 'wav' },
        { value: 'wav:24', label: 'WAV · 24-bit (lossless)', ext: 'wav' },
        { value: 'wav:32', label: 'WAV · 32-bit float', ext: 'wav' },
        { value: 'mp3:320', label: 'MP3 · 320 kbps', ext: 'mp3' },
        { value: 'mp3:256', label: 'MP3 · 256 kbps', ext: 'mp3' },
        { value: 'mp3:192', label: 'MP3 · 192 kbps', ext: 'mp3' },
        { value: 'mp3:128', label: 'MP3 · 128 kbps', ext: 'mp3' },
        { value: 'aac:256', label: 'AAC (.m4a) · 256 kbps', ext: 'm4a', aac: true },
        { value: 'aac:192', label: 'AAC (.m4a) · 192 kbps', ext: 'm4a', aac: true },
        { value: 'aac:128', label: 'AAC (.m4a) · 128 kbps', ext: 'm4a', aac: true },
        { value: 'aac:96', label: 'AAC (.m4a) · 96 kbps', ext: 'm4a', aac: true }
    ];

    const STORAGE_KEY = 'audioloft.format';

    function parse(format) {
        const [kind, arg] = String(format || 'wav:16').split(':');
        return { kind, value: Number(arg) };
    }

    function extensionFor(format) {
        const found = FORMATS.find((f) => f.value === format);
        return found ? found.ext : 'wav';
    }

    // Rough output size, for the "Estimated size" readouts.
    function estimateBytes(format, duration, numberOfChannels, sampleRate) {
        const { kind, value } = parse(format);
        if (kind === 'wav') return 44 + Math.round(duration * sampleRate) * numberOfChannels * (value / 8);
        return Math.round(duration * value * 1000 / 8) + 1024;
    }

    // ---------- Shared prep ----------

    // Lossy codecs take at most two channels and a limited set of rates.
    async function prepare(clip, rates) {
        let out = clip.numberOfChannels > 2 ? AL.remix(clip, 2) : clip;
        if (!rates.includes(out.sampleRate)) {
            const target = out.sampleRate > 44100 ? 48000 : 44100;
            out = await AL.resample(out, rates.includes(target) ? target : rates[rates.length - 1]);
        }
        return out;
    }

    // ---------- MP3 ----------

    const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

    async function encodeMp3(clip, kbps, onProgress) {
        const input = await prepare(clip, MP3_RATES);
        return new Promise((resolve, reject) => {
            const worker = new Worker('js/mp3-worker.js');
            worker.onmessage = (event) => {
                const msg = event.data;
                if (msg.type === 'progress') {
                    if (onProgress) onProgress(msg.value);
                } else if (msg.type === 'done') {
                    worker.terminate();
                    resolve(msg.blob);
                } else {
                    worker.terminate();
                    reject(new Error(`MP3 encoding failed: ${msg.message}`));
                }
            };
            worker.onerror = (event) => {
                worker.terminate();
                reject(new Error(`MP3 encoder couldn't start${event.message ? `: ${event.message}` : '.'}`));
            };
            worker.postMessage({ channels: input.channels, sampleRate: input.sampleRate, kbps });
        });
    }

    // ---------- AAC ----------

    const AAC_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

    function aacConfig(sampleRate, numberOfChannels, kbps) {
        return { codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: kbps * 1000 };
    }

    let aacSupport = null;

    // Resolves true when this browser can encode AAC at all.
    function supportsAac() {
        if (!aacSupport) {
            aacSupport = (async () => {
                if (typeof global.AudioEncoder === 'undefined' || typeof global.AudioData === 'undefined') return false;
                try {
                    const result = await global.AudioEncoder.isConfigSupported(aacConfig(48000, 2, 128));
                    return Boolean(result && result.supported);
                } catch (error) {
                    return false;
                }
            })();
        }
        return aacSupport;
    }

    async function encodeAac(clip, kbps, onProgress) {
        if (!(await supportsAac())) throw new Error('This browser can’t encode AAC. Choose MP3 or WAV instead.');
        let input = await prepare(clip, AAC_RATES);
        let config = aacConfig(input.sampleRate, input.numberOfChannels, kbps);
        const check = await global.AudioEncoder.isConfigSupported(config);
        if (!check.supported) {
            input = await AL.resample(input, 48000);
            config = aacConfig(48000, input.numberOfChannels, kbps);
        }

        const { sampleRate, numberOfChannels } = config;
        const packets = [];
        let asc = null;
        let failure = null;

        const encoder = new global.AudioEncoder({
            output: (chunk, meta) => {
                const bytes = new Uint8Array(chunk.byteLength);
                chunk.copyTo(bytes);
                packets.push(bytes);
                const description = meta && meta.decoderConfig && meta.decoderConfig.description;
                if (description && !asc) {
                    asc = description instanceof ArrayBuffer
                        ? new Uint8Array(description.slice(0))
                        : new Uint8Array(description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength));
                }
            },
            error: (error) => { failure = error; }
        });
        encoder.configure(config);

        const block = 1024 * 32;
        const length = input.length;
        for (let i = 0; i < length; i += block) {
            if (failure) break;
            const n = Math.min(block, length - i);
            const data = new Float32Array(n * numberOfChannels);
            for (let c = 0; c < numberOfChannels; c++) data.set(input.channels[c].subarray(i, i + n), c * n);
            const frame = new global.AudioData({
                format: 'f32-planar',
                sampleRate,
                numberOfFrames: n,
                numberOfChannels,
                timestamp: Math.round((i / sampleRate) * 1e6),
                data
            });
            encoder.encode(frame);
            frame.close();
            // Let the encoder drain so memory doesn't pile up, and report.
            while (encoder.encodeQueueSize > 4 && !failure) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            if (onProgress) onProgress((i + n) / length);
        }
        if (!failure) await encoder.flush();
        if (encoder.state !== 'closed') encoder.close();
        if (failure) throw new Error(`AAC encoding failed: ${failure.message || failure}`);
        if (!packets.length) throw new Error('AAC encoding produced no audio.');

        return muxM4a(packets, asc || audioSpecificConfig(sampleRate, numberOfChannels), {
            sampleRate,
            numberOfChannels,
            bitrate: kbps * 1000
        });
    }

    // AAC-LC AudioSpecificConfig, for encoders that don't hand one over.
    function audioSpecificConfig(sampleRate, numberOfChannels) {
        const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        const index = Math.max(0, rates.indexOf(sampleRate));
        const bits = (2 << 11) | (index << 7) | (numberOfChannels << 3);
        return new Uint8Array([bits >> 8, bits & 0xff]);
    }

    // ---------- Minimal MP4 (.m4a) writer ----------
    // One audio track, all packets in a single chunk, moov before mdat so the
    // file can start playing before it has fully loaded.

    function u32(n) {
        return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    }

    function u16(n) {
        return [(n >>> 8) & 255, n & 255];
    }

    function chars(s) {
        return Array.from(s, (ch) => ch.charCodeAt(0));
    }

    function concatBytes(parts) {
        const total = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        parts.forEach((p) => {
            out.set(p, offset);
            offset += p.length;
        });
        return out;
    }

    function box(type, ...payload) {
        const body = concatBytes(payload.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
        return concatBytes([new Uint8Array([...u32(body.length + 8), ...chars(type)]), body]);
    }

    function fullBox(type, version, flags, ...payload) {
        return box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...payload);
    }

    // MPEG-4 descriptor with a fixed four-byte length field.
    function descriptor(tag, ...payload) {
        const body = concatBytes(payload.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
        const n = body.length;
        return concatBytes([new Uint8Array([tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f]), body]);
    }

    const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

    function muxM4a(packets, asc, { sampleRate, numberOfChannels, bitrate }) {
        const samples = packets.length * 1024;
        const sizes = packets.map((p) => p.length);
        const maxSize = Math.max(...sizes);

        const esds = fullBox('esds', 0, 0,
            descriptor(0x03,
                [...u16(1), 0],
                descriptor(0x04,
                    [0x40, 0x15, (maxSize >> 16) & 255, (maxSize >> 8) & 255, maxSize & 255, ...u32(bitrate), ...u32(bitrate)],
                    descriptor(0x05, asc)),
                descriptor(0x06, [0x02])));

        const mp4a = box('mp4a',
            [0, 0, 0, 0, 0, 0, ...u16(1)],
            [...u32(0), ...u32(0)],
            [...u16(numberOfChannels), ...u16(16), ...u16(0), ...u16(0)],
            u32(sampleRate * 65536 >>> 0),
            esds);

        const stbl = (chunkOffset) => box('stbl',
            fullBox('stsd', 0, 0, u32(1), mp4a),
            fullBox('stts', 0, 0, u32(1), u32(packets.length), u32(1024)),
            fullBox('stsc', 0, 0, u32(1), u32(1), u32(packets.length), u32(1)),
            fullBox('stsz', 0, 0, u32(0), u32(packets.length), new Uint8Array(sizes.flatMap(u32))),
            fullBox('stco', 0, 0, u32(1), u32(chunkOffset)));

        const moov = (chunkOffset) => box('moov',
            fullBox('mvhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(samples),
                u32(0x00010000), u16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2)),
            box('trak',
                fullBox('tkhd', 0, 7, u32(0), u32(0), u32(1), u32(0), u32(samples),
                    new Uint8Array(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
                box('mdia',
                    fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(samples), u16(0x55c4), u16(0)),
                    fullBox('hdlr', 0, 0, u32(0), chars('soun'), new Uint8Array(12), chars('SoundHandler\0')),
                    box('minf',
                        fullBox('smhd', 0, 0, u16(0), u16(0)),
                        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
                        stbl(chunkOffset)))));

        const ftyp = box('ftyp', chars('M4A '), u32(512), chars('M4A '), chars('isom'), chars('iso2'), chars('mp41'));
        // The moov's size doesn't depend on the offset it records, so measure
        // once with a placeholder, then build it for real.
        const moovSize = moov(0).length;
        const dataOffset = ftyp.length + moovSize + 8;
        const mdatSize = 8 + sizes.reduce((a, b) => a + b, 0);
        if (dataOffset + mdatSize > 0xffffffff) throw new Error('That export is too long for a single .m4a file.');

        return new Blob([ftyp, moov(dataOffset), new Uint8Array([...u32(mdatSize), ...chars('mdat')]), ...packets], { type: 'audio/mp4' });
    }

    // ---------- Public API ----------

    function formatName(format) {
        return { wav: 'WAV', mp3: 'MP3', aac: 'AAC' }[parse(format).kind] || 'WAV';
    }

    // Encodes behind the busy overlay's label: "Encoding MP3… 42%".
    function encodeWithLabel(clip, format, setLabel, prefix = 'Encoding') {
        const text = `${prefix} ${formatName(format)}…`;
        if (setLabel) setLabel(text);
        return encode(clip, format, setLabel ? (p) => setLabel(`${text} ${Math.round(p * 100)}%`) : null);
    }

    async function encode(clip, format, onProgress) {
        const { kind, value } = parse(format);
        if (kind === 'mp3') return encodeMp3(clip, value, onProgress);
        if (kind === 'aac') return encodeAac(clip, value, onProgress);
        return AL.encodeWav(clip, value || 16);
    }

    // Fills a <select> with the formats this browser can produce, and keeps
    // the visitor's last choice (per browser) across pages and visits.
    function formatPicker(select, onChange) {
        let saved = null;
        try {
            saved = global.localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            /* Storage blocked: fall back to the default. */
        }

        const fill = (withAac) => {
            const current = select.value || saved;
            select.innerHTML = '';
            const groups = [['WAV', 'wav'], ['MP3', 'mp3'], ['AAC', 'aac']];
            groups.forEach(([label, kind]) => {
                if (kind === 'aac' && !withAac) return;
                const group = document.createElement('optgroup');
                group.label = label;
                FORMATS.filter((f) => f.value.startsWith(`${kind}:`)).forEach((f) => {
                    const option = document.createElement('option');
                    option.value = f.value;
                    option.textContent = f.label;
                    group.appendChild(option);
                });
                select.appendChild(group);
            });
            select.value = FORMATS.some((f) => f.value === current && (withAac || !f.aac)) ? current : 'wav:16';
        };

        fill(false);
        supportsAac().then((ok) => {
            if (!ok) return;
            fill(true);
            if (onChange) onChange();
        });

        select.addEventListener('change', () => {
            try {
                global.localStorage.setItem(STORAGE_KEY, select.value);
            } catch (error) {
                /* Not remembered; nothing else depends on it. */
            }
            if (onChange) onChange();
        });
    }

    Object.assign(AL, {
        FORMATS,
        encode,
        encodeWithLabel,
        formatName,
        extensionFor,
        estimateBytes,
        formatPicker,
        supportsAac,
        muxM4a
    });
})(window);
