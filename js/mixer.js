// ============================================
// MIXER - AudioLoft
// ============================================
//
// Turns a multitrack session into a Web Audio graph:
//
//   clip source -> clip gain (volume + fades) -> lane input
//     -> [EQ: low shelf, mid peak, high shelf] -> [compressor -> makeup]
//     -> lane gain -> lane pan -> out
//
// The same builder serves live playback (an AudioContext, starting from any
// position) and export (an OfflineAudioContext rendered from zero), so what
// you hear is what gets exported.
//
// A session is { sources: Map, lanes: [], clips: [] } as kept by studio.js.
// Clips play source range [start, end) beginning at timeline time `at`, at
// `speed` (2 = twice as fast) and moved by `pitch` semitones. A clip with
// either set plays from a processed copy of its source, made ahead of time by
// studio.js (AL.changeSpeedAndPitch) and kept in `source.variants`.

(function (global) {
    'use strict';

    const AL = global.AudioLoft;

    function dbToGain(db) {
        return Math.pow(10, (db || 0) / 20);
    }

    const rateOf = (clip) => clip.speed || 1;

    // Length on the timeline; `start` / `end` are positions in the source.
    function clipLength(clip) {
        return (clip.end - clip.start) / rateOf(clip);
    }

    // Names the processed copy a clip needs, or null when it plays the
    // source as it is.
    function variantKey(clip) {
        const speed = rateOf(clip);
        const pitch = clip.pitch || 0;
        return speed === 1 && pitch === 0 ? null : `${speed}:${pitch}`;
    }

    // The audio a clip reads from, or null while its copy isn't made yet.
    // Positions in it are source positions divided by the speed.
    function audioFor(source, clip) {
        const key = variantKey(clip);
        if (!key) return source.clip;
        return (source.variants && source.variants.get(key)) || null;
    }

    // ---------- Lane effects ----------

    const EQ_LOW_HZ = 120;
    const EQ_HIGH_HZ = 8000;
    const EQ_MID_Q = 0.9;
    const COMP_KNEE = 6;
    // A DynamicsCompressorNode looks 6 ms ahead, so its output comes 6 ms
    // late. While any lane is compressed the others are delayed to match.
    const COMP_LATENCY = 0.006;

    function defaultFx() {
        return {
            eq: { on: false, low: 0, mid: 0, midFreq: 1000, high: 0 },
            comp: { on: false, threshold: -24, ratio: 4, attack: 10, release: 250, makeup: 0 }
        };
    }

    // Fills in anything missing, e.g. lanes from sessions saved before
    // effects existed.
    function normalizeFx(fx) {
        const d = defaultFx();
        return {
            eq: Object.assign(d.eq, fx && fx.eq),
            comp: Object.assign(d.comp, fx && fx.comp)
        };
    }

    const fxOf = (lane) => lane.fx || defaultFx();

    // Sets effect parameters, gliding when the graph is already playing.
    function applyFx(ctx, nodes, fx, glide) {
        const set = (param, value) => {
            if (glide) param.setTargetAtTime(value, ctx.currentTime, 0.015);
            else param.value = value;
        };
        if (nodes.eq) {
            set(nodes.eq.low.gain, fx.eq.low);
            set(nodes.eq.mid.gain, fx.eq.mid);
            set(nodes.eq.mid.frequency, fx.eq.midFreq);
            set(nodes.eq.high.gain, fx.eq.high);
        }
        if (nodes.comp) {
            set(nodes.comp.threshold, fx.comp.threshold);
            set(nodes.comp.ratio, fx.comp.ratio);
            set(nodes.comp.attack, fx.comp.attack / 1000);
            set(nodes.comp.release, fx.comp.release / 1000);
            set(nodes.makeup.gain, dbToGain(fx.comp.makeup));
        }
    }

    // Builds a lane's effect chain after `input` and returns its last node.
    // Effects that are off aren't in the graph at all.
    function buildFx(ctx, input, fx, latency, nodes) {
        let tail = input;
        const link = (node) => {
            tail.connect(node);
            tail = node;
            return node;
        };
        if (fx.eq.on) {
            const filter = (type, frequency) => {
                const node = link(ctx.createBiquadFilter());
                node.type = type;
                node.frequency.value = frequency;
                return node;
            };
            nodes.eq = {
                low: filter('lowshelf', EQ_LOW_HZ),
                mid: filter('peaking', fx.eq.midFreq),
                high: filter('highshelf', EQ_HIGH_HZ)
            };
            nodes.eq.mid.Q.value = EQ_MID_Q;
        }
        if (fx.comp.on) {
            nodes.comp = link(ctx.createDynamicsCompressor());
            nodes.comp.knee.value = COMP_KNEE;
            nodes.makeup = link(ctx.createGain());
        } else if (latency) {
            link(ctx.createDelay(1)).delayTime.value = latency;
        }
        applyFx(ctx, nodes, fx, false);
        return tail;
    }

    function sessionLength(session) {
        return session.clips.reduce((end, clip) => Math.max(end, clip.at + clipLength(clip)), 0);
    }

    function audibleLanes(lanes) {
        const anySolo = lanes.some((lane) => lane.solo);
        return new Set(lanes.filter((lane) => (anySolo ? lane.solo : !lane.mute)).map((lane) => lane.id));
    }

    // One AudioBuffer per source, shared by every context: AudioBuffers are
    // not tied to the context that made them.
    const BUFFERS = new WeakMap();

    function bufferFor(clip) {
        let buffer = BUFFERS.get(clip);
        if (!buffer) {
            const ctx = AL.getAudioContext();
            buffer = ctx.createBuffer(clip.numberOfChannels, clip.length, clip.sampleRate);
            clip.channels.forEach((ch, c) => buffer.copyToChannel(ch, c));
            BUFFERS.set(clip, buffer);
        }
        return buffer;
    }

    // Fades longer than half the clip each would overlap; scale them down.
    function fadeLengths(clip) {
        const len = clipLength(clip);
        let fi = Math.max(0, clip.fadeIn || 0);
        let fo = Math.max(0, clip.fadeOut || 0);
        if (fi + fo > len) {
            const k = len / (fi + fo);
            fi *= k;
            fo *= k;
        }
        return { fi, fo, len };
    }

    // Gain envelope of a clip at clip-local time u (linear fades, matching
    // AL.applyFades).
    function envelope(clip, u) {
        const { fi, fo, len } = fadeLengths(clip);
        let g = dbToGain(clip.gain);
        if (fi > 0 && u < fi) g *= u / fi;
        if (fo > 0 && u > len - fo) g *= Math.max(0, (len - u) / fo);
        return g;
    }

    // Builds the graph on `ctx`. Timeline time `from` plays at context time
    // `when`. `include(lane)` picks lanes; `respectMuteSolo` applies the
    // mute/solo buttons (live playback and the mix export do; stems don't).
    function build(ctx, destination, session, { from = 0, when = 0, include = () => true, respectMuteSolo = true } = {}) {
        const audible = audibleLanes(session.lanes);
        const lanes = new Map();
        const nodes = [];
        const latency = session.lanes.some((lane) => include(lane) && fxOf(lane).comp.on) ? COMP_LATENCY : 0;

        session.lanes.forEach((lane) => {
            if (!include(lane)) return;
            const input = ctx.createGain();
            const laneNodes = { input };
            const gain = ctx.createGain();
            buildFx(ctx, input, fxOf(lane), latency, laneNodes).connect(gain);
            gain.gain.value = respectMuteSolo && !audible.has(lane.id) ? 0 : lane.volume;
            let tail = gain;
            let pan = null;
            if (ctx.createStereoPanner) {
                pan = ctx.createStereoPanner();
                pan.pan.value = lane.pan;
                gain.connect(pan);
                tail = pan;
            }
            tail.connect(destination);
            lanes.set(lane.id, Object.assign(laneNodes, { gain, pan }));
        });

        session.clips.forEach((clip) => {
            const lane = lanes.get(clip.laneId);
            if (!lane) return;
            const audio = audioFor(session.sources.get(clip.sourceId), clip);
            const { fi, fo, len } = fadeLengths(clip);
            if (!audio || clip.at + len <= from) return;

            const skip = Math.max(0, from - clip.at);
            const startAt = when + Math.max(0, clip.at - from);

            const node = ctx.createBufferSource();
            node.buffer = bufferFor(audio);
            const gain = ctx.createGain();
            node.connect(gain);
            gain.connect(lane.input);

            // Piecewise-linear envelope: breakpoints at the fade edges.
            const points = [...new Set([fi, len - fo, len])]
                .filter((u) => u > skip && u <= len)
                .sort((a, b) => a - b);
            gain.gain.setValueAtTime(envelope(clip, skip), startAt);
            points.forEach((u) => {
                gain.gain.linearRampToValueAtTime(envelope(clip, Math.min(u, len - 1e-6)), startAt + (u - skip));
            });

            node.start(startAt, clip.start / rateOf(clip) + skip, len - skip);
            nodes.push(node);
        });

        return { lanes, nodes, latency };
    }

    // ---------- Live playback ----------

    class LiveMixer {
        constructor(getSession) {
            this.getSession = getSession;
            this.playing = false;
            this.position = 0;
            this.base = 0;
            this.from = 0;
            this.graph = null;
            this.out = null;
            this.listeners = new Set();
        }

        onChange(fn) {
            this.listeners.add(fn);
        }

        emit(type) {
            this.listeners.forEach((fn) => fn(type, this));
        }

        get duration() {
            return sessionLength(this.getSession());
        }

        get currentTime() {
            if (!this.playing) return this.position;
            return this.from + (AL.getAudioContext().currentTime - this.base);
        }

        play(from = this.position) {
            const ctx = AL.getAudioContext();
            if (ctx.state === 'suspended') ctx.resume();
            this.teardown();
            const duration = this.duration;
            if (from >= duration - 0.01) from = 0;
            this.out = ctx.createGain();
            this.out.connect(ctx.destination);
            this.from = from;
            // A small lead so every source starts on time together.
            this.base = ctx.currentTime + 0.04;
            this.graph = build(ctx, this.out, this.getSession(), { from, when: this.base });
            this.playing = true;
            this.emit('play');
        }

        pause() {
            if (!this.playing) return;
            this.position = this.currentTime;
            this.teardown();
            this.playing = false;
            this.emit('pause');
        }

        stop() {
            this.pause();
        }

        seek(t) {
            this.position = Math.max(0, t);
            if (this.playing) this.play(this.position);
            else this.emit('seek');
        }

        // Called after an edit: rebuild the graph from where we are.
        refresh() {
            if (this.playing) this.play(this.currentTime);
        }

        // Volume, pan, mute, solo and effect settings change without
        // restarting playback. Turning an effect on or off changes the graph,
        // so that takes refresh().
        updateLanes() {
            if (!this.playing || !this.graph) return;
            const ctx = AL.getAudioContext();
            const session = this.getSession();
            const audible = audibleLanes(session.lanes);
            session.lanes.forEach((lane) => {
                const nodes = this.graph.lanes.get(lane.id);
                if (!nodes) return;
                const target = audible.has(lane.id) ? lane.volume : 0;
                nodes.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
                if (nodes.pan) nodes.pan.pan.setTargetAtTime(lane.pan, ctx.currentTime, 0.015);
                applyFx(ctx, nodes, fxOf(lane), true);
            });
        }

        // How far a lane's compressor is turning it down right now, in dB
        // (0 or less), or null when it has none playing.
        reduction(laneId) {
            const nodes = this.playing && this.graph && this.graph.lanes.get(laneId);
            return nodes && nodes.comp ? nodes.comp.reduction : null;
        }

        // Stops at the end of the session.
        tick() {
            if (this.playing && this.currentTime >= this.duration) {
                this.teardown();
                this.playing = false;
                this.position = this.duration;
                this.emit('ended');
            }
        }

        teardown() {
            if (this.graph) {
                this.graph.nodes.forEach((node) => {
                    try {
                        node.stop();
                    } catch (error) {
                        /* Not started yet or already stopped. */
                    }
                });
                this.graph = null;
            }
            if (this.out) {
                const out = this.out;
                this.out = null;
                out.disconnect();
            }
        }
    }

    // ---------- Offline render ----------

    async function render(session, { sampleRate, include, respectMuteSolo = true } = {}) {
        const length = Math.max(1, Math.ceil(sessionLength(session) * sampleRate));
        // Room for the compressor's delay, which is then cut off the front.
        const lead = Math.ceil(COMP_LATENCY * sampleRate);
        const Offline = global.OfflineAudioContext || global.webkitOfflineAudioContext;
        const ctx = new Offline(2, length + lead, sampleRate);
        const { latency } = build(ctx, ctx.destination, session, { include, respectMuteSolo });
        const rendered = AL.Clip.fromAudioBuffer(await ctx.startRendering());
        const skip = latency ? Math.floor(latency * sampleRate) : 0;
        return new AL.Clip(rendered.channels.map((ch) => ch.subarray(skip, skip + length)), sampleRate);
    }

    AL.mixer = {
        LiveMixer,
        render,
        sessionLength,
        clipLength,
        rateOf,
        variantKey,
        audioFor,
        defaultFx,
        normalizeFx,
        audibleLanes,
        dbToGain
    };
})(window);
