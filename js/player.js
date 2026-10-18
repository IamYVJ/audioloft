// ============================================
// PLAYER - AudioLoft
// ============================================
//
// Plays a Clip, or a range of it, through Web Audio. Positions are in seconds
// of the clip. A BufferSource can only be started once, so every play makes a
// new one; the AudioBuffer it reads from is built once per clip and reused.

(function (global) {
    'use strict';

    class Player {
        constructor() {
            this.clip = null;
            this.buffer = null;
            this.source = null;
            this.playing = false;
            this.position = 0;
            this.from = 0;
            this.to = 0;
            this.loop = false;
            this.startedAt = 0;
            this.isRange = false;
            this.listeners = new Set();
        }

        get duration() {
            return this.clip ? this.clip.duration : 0;
        }

        onChange(fn) {
            this.listeners.add(fn);
            return () => this.listeners.delete(fn);
        }

        emit(type) {
            this.listeners.forEach((fn) => fn(type, this));
        }

        setClip(clip) {
            this.stop();
            this.clip = clip;
            this.buffer = null;
            this.position = 0;
        }

        context() {
            const ctx = global.AudioLoft.getAudioContext();
            if (ctx.state === 'suspended') ctx.resume();
            return ctx;
        }

        audioBuffer(ctx) {
            if (!this.buffer) {
                const clip = this.clip;
                // A buffer at the clip's own rate; the context resamples on
                // the way out if the device runs at a different one.
                const buffer = ctx.createBuffer(clip.numberOfChannels, clip.length, clip.sampleRate);
                clip.channels.forEach((ch, c) => buffer.copyToChannel(ch, c));
                this.buffer = buffer;
            }
            return this.buffer;
        }

        // Plays from `from` to `to` (defaults: the current position, the end).
        // A range play returns to its start when it finishes, so it can be
        // auditioned repeatedly.
        play(from = this.position, to = this.duration, options = {}) {
            if (!this.clip) return;
            const ctx = this.context();
            this.stopSource();

            from = Math.max(0, Math.min(from, this.duration));
            to = Math.max(from, Math.min(to, this.duration));
            if (to - from < 0.005) {
                if (options.range) return;
                from = 0;
                to = this.duration;
            }

            const source = ctx.createBufferSource();
            source.buffer = this.audioBuffer(ctx);
            source.connect(ctx.destination);

            this.loop = Boolean(options.loop);
            this.isRange = Boolean(options.range);
            if (this.loop) {
                source.loop = true;
                source.loopStart = from;
                source.loopEnd = to;
                source.start(0, from);
            } else {
                source.start(0, from, to - from);
            }

            source.onended = () => {
                if (this.source !== source) return;
                this.source = null;
                this.playing = false;
                this.position = this.isRange ? this.from : this.to;
                this.emit('ended');
            };

            this.source = source;
            this.from = from;
            this.to = to;
            this.startedAt = ctx.currentTime;
            this.playing = true;
            this.emit('play');
        }

        get currentTime() {
            if (!this.playing) return this.position;
            const ctx = global.AudioLoft.getAudioContext();
            let t = ctx.currentTime - this.startedAt;
            const span = this.to - this.from;
            if (this.loop && span > 0) t %= span;
            return Math.min(this.from + t, this.to);
        }

        pause() {
            if (!this.playing) return;
            this.position = this.currentTime;
            this.stopSource();
            this.playing = false;
            this.emit('pause');
        }

        stop() {
            const was = this.playing;
            this.stopSource();
            this.playing = false;
            if (was) this.emit('pause');
        }

        seek(seconds) {
            const t = Math.max(0, Math.min(seconds, this.duration));
            if (this.playing && !this.isRange) {
                this.play(t, this.duration);
            } else {
                if (this.playing) this.stop();
                this.position = t;
                this.emit('seek');
            }
        }

        stopSource() {
            if (this.source) {
                const source = this.source;
                this.source = null;
                try {
                    source.onended = null;
                    source.stop();
                } catch (error) {
                    /* Already stopped. */
                }
                source.disconnect();
            }
        }
    }

    global.AudioLoft = Object.assign(global.AudioLoft || {}, { Player });
})(window);
