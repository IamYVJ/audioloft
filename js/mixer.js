// ============================================
// MIXER - AudioLoft
// ============================================
//
// Turns a multitrack session into a Web Audio graph:
//
//   clip source -> clip gain (volume + fades) -> lane gain -> lane pan -> out
//
// The same builder serves live playback (an AudioContext, starting from any
// position) and export (an OfflineAudioContext rendered from zero), so what
// you hear is what gets exported.
//
// A session is { sources: Map, lanes: [], clips: [] } as kept by studio.js.
// Clips play source range [start, end) beginning at timeline time `at`.

(function (global) {
    'use strict';

    const AL = global.AudioLoft;

    function dbToGain(db) {
        return Math.pow(10, (db || 0) / 20);
    }

    function clipLength(clip) {
        return clip.end - clip.start;
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

        session.lanes.forEach((lane) => {
            if (!include(lane)) return;
            const gain = ctx.createGain();
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
            lanes.set(lane.id, { gain, pan });
        });

        session.clips.forEach((clip) => {
            const lane = lanes.get(clip.laneId);
            if (!lane) return;
            const source = session.sources.get(clip.sourceId);
            const { fi, fo, len } = fadeLengths(clip);
            if (clip.at + len <= from) return;

            const skip = Math.max(0, from - clip.at);
            const startAt = when + Math.max(0, clip.at - from);

            const node = ctx.createBufferSource();
            node.buffer = bufferFor(source.clip);
            const gain = ctx.createGain();
            node.connect(gain);
            gain.connect(lane.gain);

            // Piecewise-linear envelope: breakpoints at the fade edges.
            const points = [...new Set([fi, len - fo, len])]
                .filter((u) => u > skip && u <= len)
                .sort((a, b) => a - b);
            gain.gain.setValueAtTime(envelope(clip, skip), startAt);
            points.forEach((u) => {
                gain.gain.linearRampToValueAtTime(envelope(clip, Math.min(u, len - 1e-6)), startAt + (u - skip));
            });

            node.start(startAt, clip.start + skip, len - skip);
            nodes.push(node);
        });

        return { lanes, nodes };
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

        // Volume, pan, mute and solo change without restarting playback.
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
            });
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
        const Offline = global.OfflineAudioContext || global.webkitOfflineAudioContext;
        const ctx = new Offline(2, length, sampleRate);
        build(ctx, ctx.destination, session, { include, respectMuteSolo });
        const rendered = await ctx.startRendering();
        return AL.Clip.fromAudioBuffer(rendered);
    }

    AL.mixer = {
        LiveMixer,
        render,
        sessionLength,
        clipLength,
        audibleLanes,
        dbToGain
    };
})(window);
