// ============================================
// UI HELPERS - AudioLoft
// ============================================
//
// Pieces every tool page shares: the drop zone, toasts, the busy overlay,
// time inputs, the playhead ticker and keyboard shortcuts.

(function (global) {
    'use strict';

    const AL = global.AudioLoft;

    const ICONS = {
        play: '<svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg>',
        pause: '<svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
        playSmall: '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg>',
        stopSmall: '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
        download: '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
        up: '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
        down: '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
        remove: '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        merge: '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v4a6 6 0 006 6 6 6 0 006-6V3M12 13v8"/></svg>',
        grip: '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>'
    };

    function $(selector, root = document) {
        return root.querySelector(selector);
    }

    // ---------- Toasts and live announcements ----------

    let toastStack = null;
    let liveRegion = null;

    function announce(message) {
        if (!liveRegion) {
            liveRegion = document.createElement('div');
            liveRegion.className = 'sr-only';
            liveRegion.setAttribute('aria-live', 'polite');
            document.body.appendChild(liveRegion);
        }
        liveRegion.textContent = '';
        setTimeout(() => { liveRegion.textContent = message; }, 30);
    }

    function toast(message, kind = 'info', timeout = 4200) {
        if (!toastStack) {
            toastStack = document.createElement('div');
            toastStack.className = 'toast-stack';
            toastStack.setAttribute('role', 'status');
            toastStack.setAttribute('aria-live', 'polite');
            document.body.appendChild(toastStack);
        }
        const el = document.createElement('div');
        el.className = `toast${kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''}`;
        el.textContent = message;
        toastStack.appendChild(el);
        setTimeout(() => {
            el.classList.add('is-leaving');
            setTimeout(() => el.remove(), 300);
        }, kind === 'error' ? timeout * 1.6 : timeout);
    }

    // ---------- Busy overlay ----------

    let overlay = null;

    // Resolves once the browser has had a chance to paint. Background tabs
    // don't run animation frames, so a timeout stands in for them there.
    function nextPaint() {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, 60);
            requestAnimationFrame(() => requestAnimationFrame(() => {
                clearTimeout(timer);
                resolve();
            }));
        });
    }

    // Runs `work` behind a blocking overlay. The double rAF lets the overlay
    // paint before heavy synchronous work (encoding) ties up the main thread.
    // `work` receives an async setLabel for progress across several steps.
    async function withBusy(label, work) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'busy-overlay';
            overlay.innerHTML = '<div class="busy-card" role="alertdialog" aria-live="assertive"><div class="spinner" aria-hidden="true"></div><span></span></div>';
            document.body.appendChild(overlay);
        }
        const text = overlay.querySelector('span');
        const setLabel = async (next) => {
            text.textContent = next;
            await nextPaint();
        };
        overlay.hidden = false;
        announce(label);
        await setLabel(label);
        try {
            return await work(setLabel);
        } finally {
            overlay.hidden = true;
        }
    }

    // ---------- Drop zone ----------

    function isAudioFile(file) {
        if (file.type && file.type.startsWith('audio/')) return true;
        if (file.type === 'video/webm' || file.type === 'video/mp4' || file.type === 'video/ogg') return true;
        return /\.(mp3|wav|wave|ogg|oga|opus|flac|m4a|aac|webm|weba|aif|aiff|aifc|caf|mp4)$/i.test(file.name);
    }

    function dropzone(zone, { multiple = false, onFiles }) {
        const input = zone.querySelector('input[type="file"]');
        input.accept = AL.ACCEPT;
        input.multiple = multiple;

        const deliver = (fileList) => {
            const files = Array.from(fileList || []);
            if (!files.length) return;
            const audio = files.filter(isAudioFile);
            const skipped = files.length - audio.length;
            if (skipped) {
                toast(`${skipped} file${skipped > 1 ? 's were' : ' was'} skipped — not an audio file.`, 'error');
            }
            if (audio.length) onFiles(multiple ? audio : [audio[0]]);
        };

        zone.addEventListener('click', (e) => {
            if (e.target.closest('button, a') || e.target === input) return;
            input.click();
        });
        zone.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === zone) {
                e.preventDefault();
                input.click();
            }
        });
        input.addEventListener('change', () => {
            deliver(input.files);
            input.value = '';
        });

        let depth = 0;
        zone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            depth++;
            zone.classList.add('is-dragover');
        });
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        zone.addEventListener('dragleave', () => {
            depth = Math.max(0, depth - 1);
            if (!depth) zone.classList.remove('is-dragover');
        });
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            depth = 0;
            zone.classList.remove('is-dragover');
            deliver(e.dataTransfer.files);
        });

        return { open: () => input.click() };
    }

    // Dropping a file anywhere on the page that isn't a drop zone would make
    // the browser navigate away to play it, losing the user's work.
    function guardPageDrops(onFiles) {
        global.addEventListener('dragover', (e) => {
            if (!e.target.closest || !e.target.closest('.dropzone')) e.preventDefault();
        });
        global.addEventListener('drop', (e) => {
            if (e.target.closest && e.target.closest('.dropzone')) return;
            e.preventDefault();
            if (onFiles && e.dataTransfer && e.dataTransfer.files.length) {
                const audio = Array.from(e.dataTransfer.files).filter(isAudioFile);
                if (audio.length) onFiles(audio);
            }
        });
    }

    // ---------- Time inputs ----------

    // Binds a text input to a time value in seconds. `get` reads the current
    // value for display; `set` receives a parsed, valid number.
    function timeField(input, { get, set }) {
        const refresh = () => {
            if (document.activeElement !== input) input.value = AL.formatTime(get());
            input.classList.remove('is-invalid');
        };
        const commit = () => {
            const value = AL.parseTime(input.value);
            if (isNaN(value)) {
                input.classList.add('is-invalid');
                return;
            }
            input.classList.remove('is-invalid');
            set(value);
            input.value = AL.formatTime(get());
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
                input.select();
            } else if (e.key === 'Escape') {
                input.value = AL.formatTime(get());
                input.classList.remove('is-invalid');
                input.blur();
            }
        });
        input.addEventListener('blur', refresh);
        return { refresh };
    }

    // ---------- Playback wiring ----------

    // Keeps the waveform playhead, the time readout and the play button in
    // step with the player.
    function bindPlayback({ player, waveform, playButton, timeEl, onTick }) {
        let frame = 0;

        const paint = () => {
            const t = player.currentTime;
            if (waveform) {
                waveform.setPlayhead(t);
                if (player.playing) waveform.follow(t);
            }
            if (timeEl) timeEl.textContent = AL.formatTime(t);
            if (onTick) onTick(t);
        };

        const loop = () => {
            paint();
            frame = player.playing ? requestAnimationFrame(loop) : 0;
        };

        player.onChange((type) => {
            if (playButton) {
                playButton.innerHTML = player.playing ? ICONS.pause : ICONS.play;
                playButton.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
            }
            if (player.playing && !frame) frame = requestAnimationFrame(loop);
            if (!player.playing) paint();
            if (type === 'ended') announce('Playback finished');
        });

        return { paint };
    }

    // ---------- Keyboard shortcuts ----------

    function isTyping(target) {
        if (!target) return false;
        const tag = target.tagName;
        if (target.isContentEditable) return true;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') return !['checkbox', 'radio', 'range', 'button', 'file'].includes(target.type);
        return false;
    }

    function shortcuts(map) {
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
            const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
            const handler = map[key];
            if (!handler) return;
            // Space on a focused button should press it, not toggle playback twice.
            if (key === 'Space' && e.target.closest && e.target.closest('button, a, [role="tab"]')) return;
            e.preventDefault();
            handler(e);
        });
    }

    // ---------- Misc ----------

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'class') node.className = value;
            else if (key === 'html') node.innerHTML = value;
            else if (key === 'text') node.textContent = value;
            else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? '' : value);
        }
        for (const child of [].concat(children)) {
            if (child) node.append(child);
        }
        return node;
    }

    function describeClip(clip) {
        const channels = clip.numberOfChannels === 1 ? 'Mono' : clip.numberOfChannels === 2 ? 'Stereo' : `${clip.numberOfChannels} ch`;
        return {
            duration: AL.formatTime(clip.duration, 2),
            rate: `${(clip.sampleRate / 1000).toFixed(clip.sampleRate % 1000 ? 1 : 0)} kHz`,
            channels
        };
    }

    function fillMeta(container, clip, file) {
        const info = describeClip(clip);
        container.innerHTML = '';
        [info.duration, info.rate, info.channels, file && file.size ? AL.formatBytes(file.size) : null]
            .filter(Boolean)
            .forEach((text) => container.appendChild(el('span', { class: 'chip', text })));
    }

    function readNumber(input, fallback = 0, min = -Infinity, max = Infinity) {
        const value = parseFloat(input.value);
        if (!isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
    }

    AL.ui = {
        ICONS,
        $,
        toast,
        announce,
        withBusy,
        dropzone,
        guardPageDrops,
        timeField,
        bindPlayback,
        shortcuts,
        el,
        describeClip,
        fillMeta,
        readNumber,
        isAudioFile
    };
})(window);
