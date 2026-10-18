// ============================================
// JOIN - AudioLoft
// ============================================
//
// Tracks are decoded as they're added and kept in order. Joining conforms
// them all to one sample rate and channel layout first, then concatenates
// with an optional gap or equal-power crossfade.
//
// The joined result is cached against a key made of the track order and
// settings, so exporting right after previewing doesn't redo the work, and
// changing anything marks the preview as stale.

(function () {
    'use strict';

    const AL = window.AudioLoft;
    const ui = AL.ui;
    const $ = ui.$;

    const state = {
        tracks: [],
        nextId: 1,
        previewing: null,
        dragId: null,
        result: null,
        resultKey: ''
    };

    const trackPlayer = new AL.Player();
    const resultPlayer = new AL.Player();

    const els = {
        dropStage: $('#dropStage'),
        editStage: $('#editStage'),
        list: $('#trackList'),
        count: $('#trackCount'),
        total: $('#trackTotal'),
        transitionField: $('#transitionField'),
        transitionSeconds: $('#transitionSeconds'),
        transitionSecondsLabel: $('#transitionSecondsLabel'),
        sampleRate: $('#sampleRate'),
        channels: $('#channels'),
        normalize: $('#normalize'),
        fileName: $('#fileName'),
        format: $('#format'),
        outLength: $('#outLength'),
        buildButton: $('#buildButton'),
        exportButton: $('#exportButton'),
        resultPanel: $('#resultPanel'),
        resultMeta: $('#resultMeta'),
        resultPlay: $('#resultPlay'),
        resultTime: $('#resultTime'),
        resultTotal: $('#resultTotal'),
        resultStale: $('#resultStale')
    };

    const resultWave = new AL.Waveform($('#resultWave'), {
        mode: 'view',
        height: 150,
        onseek: (t) => {
            resultPlayer.seek(t);
            resultPlayback.paint();
        }
    });

    const resultPlayback = ui.bindPlayback({
        player: resultPlayer,
        waveform: resultWave,
        playButton: els.resultPlay,
        timeEl: els.resultTime
    });

    trackPlayer.onChange(() => {
        if (!trackPlayer.playing) state.previewing = null;
        syncPreviewButtons();
    });

    // ---------- Adding tracks ----------

    async function addFiles(files) {
        const added = [];
        await ui.withBusy('Decoding…', async (setLabel) => {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                await setLabel(files.length > 1 ? `Decoding ${i + 1} of ${files.length}…` : `Decoding “${file.name}”…`);
                try {
                    const clip = await AL.decodeFile(file);
                    added.push({ id: state.nextId++, name: file.name, size: file.size, clip });
                } catch (error) {
                    ui.toast(error.message, 'error');
                }
            }
        });
        if (added.length) addTracks(added);
    }

    function addTracks(tracks) {
        state.tracks.push(...tracks);
        if (state.tracks.length && els.fileName.value === 'joined' && state.tracks.length === tracks.length) {
            els.fileName.value = `${AL.baseName(state.tracks[0].name)}-joined`;
        }
        render();
        ui.announce(`${tracks.length} track${tracks.length === 1 ? '' : 's'} added. ${state.tracks.length} in total.`);
    }

    function addDemoTracks() {
        const tracks = [0, 1, 2].map((variant) => ({
            id: state.nextId++,
            name: `Demo track ${variant + 1}.wav`,
            size: 0,
            clip: AL.createDemoClip(variant + 1)
        }));
        addTracks(tracks);
    }

    // ---------- List ----------

    function render() {
        const empty = state.tracks.length === 0;
        els.dropStage.hidden = !empty;
        els.editStage.hidden = empty;
        if (empty) {
            trackPlayer.stop();
            resultPlayer.stop();
            state.result = null;
            state.resultKey = '';
            els.resultPanel.hidden = true;
        }

        els.list.innerHTML = '';
        state.tracks.forEach((track, i) => els.list.appendChild(renderRow(track, i)));

        // Mini waveforms need layout to know their width.
        requestAnimationFrame(() => {
            els.list.querySelectorAll('canvas.mini-wave').forEach((canvas, i) => {
                const track = state.tracks[i];
                if (track) AL.drawMiniWave(canvas, track.clip, AL.SEGMENT_COLORS[i % AL.SEGMENT_COLORS.length]);
            });
        });

        const n = state.tracks.length;
        els.count.textContent = `${n} track${n === 1 ? '' : 's'}`;
        els.total.textContent = AL.formatTime(state.tracks.reduce((sum, t) => sum + t.clip.duration, 0), 2);
        refreshOutput();
    }

    function renderRow(track, i) {
        const info = ui.describeClip(track.clip);
        const n = state.tracks.length;
        const color = AL.SEGMENT_COLORS[i % AL.SEGMENT_COLORS.length];

        const row = ui.el('li', { class: 'item item-track', draggable: 'true', 'data-id': String(track.id) }, [
            ui.el('span', { class: 'drag-handle', html: ui.ICONS.grip, title: 'Drag to reorder', 'aria-hidden': 'true' }),
            ui.el('span', { class: 'item-index', text: String(i + 1) }),
            ui.el('div', { class: 'item-body' }, [
                ui.el('span', { class: 'item-title', text: track.name, title: track.name }),
                ui.el('span', {
                    class: 'item-sub',
                    text: [info.duration, info.rate, info.channels, track.size ? AL.formatBytes(track.size) : null].filter(Boolean).join(' · ')
                }),
                ui.el('canvas', { class: 'mini-wave', 'aria-hidden': 'true' })
            ]),
            ui.el('div', { class: 'item-actions' }, [
                ui.el('button', {
                    type: 'button',
                    class: 'btn btn-sm btn-icon',
                    'data-role': 'preview',
                    'aria-label': `Play ${track.name}`,
                    html: ui.ICONS.playSmall,
                    onclick: () => togglePreview(track)
                }),
                ui.el('button', {
                    type: 'button',
                    class: 'btn btn-sm btn-icon',
                    'aria-label': `Move ${track.name} up`,
                    title: 'Move up',
                    html: ui.ICONS.up,
                    disabled: i === 0,
                    onclick: () => move(i, i - 1)
                }),
                ui.el('button', {
                    type: 'button',
                    class: 'btn btn-sm btn-icon',
                    'aria-label': `Move ${track.name} down`,
                    title: 'Move down',
                    html: ui.ICONS.down,
                    disabled: i === n - 1,
                    onclick: () => move(i, i + 1)
                }),
                ui.el('button', {
                    type: 'button',
                    class: 'btn btn-sm btn-icon btn-danger',
                    'aria-label': `Remove ${track.name}`,
                    title: 'Remove',
                    html: ui.ICONS.remove,
                    onclick: () => remove(i)
                })
            ])
        ]);
        row.style.setProperty('--swatch', color);
        bindDrag(row, track);
        return row;
    }

    function move(from, to) {
        if (to < 0 || to >= state.tracks.length || from === to) return;
        const [track] = state.tracks.splice(from, 1);
        state.tracks.splice(to, 0, track);
        render();
        // Keep focus on the same control so repeated presses keep moving it.
        const row = els.list.children[to];
        const label = to < from ? 'up' : 'down';
        const button = row && (row.querySelector(`[aria-label$=" ${label}"]:not(:disabled)`) ||
            row.querySelector('[aria-label^="Move"]:not(:disabled)'));
        if (button) button.focus();
        ui.announce(`${track.name} moved to position ${to + 1}`);
    }

    function remove(i) {
        const [track] = state.tracks.splice(i, 1);
        if (state.previewing === track.id) trackPlayer.stop();
        render();
        ui.announce(`${track.name} removed`);
    }

    // ---------- Drag to reorder ----------

    function bindDrag(row, track) {
        row.addEventListener('dragstart', (e) => {
            state.dragId = track.id;
            row.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(track.id));
        });
        row.addEventListener('dragend', () => {
            state.dragId = null;
            row.classList.remove('is-dragging');
            clearDropMarks();
        });
        row.addEventListener('dragover', (e) => {
            if (state.dragId === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const after = isAfter(row, e);
            clearDropMarks();
            row.classList.add(after ? 'drop-after' : 'drop-before');
        });
        row.addEventListener('drop', (e) => {
            if (state.dragId === null) return;
            e.preventDefault();
            e.stopPropagation();
            const from = state.tracks.findIndex((t) => t.id === state.dragId);
            let to = state.tracks.findIndex((t) => t.id === track.id);
            if (isAfter(row, e)) to += 1;
            if (from < to) to -= 1;
            clearDropMarks();
            state.dragId = null;
            move(from, to);
        });
    }

    function isAfter(row, e) {
        const rect = row.getBoundingClientRect();
        return e.clientY > rect.top + rect.height / 2;
    }

    function clearDropMarks() {
        els.list.querySelectorAll('.drop-before, .drop-after').forEach((node) => {
            node.classList.remove('drop-before', 'drop-after');
        });
    }

    // ---------- Track preview ----------

    function togglePreview(track) {
        resultPlayer.stop();
        if (state.previewing === track.id) {
            trackPlayer.stop();
            return;
        }
        trackPlayer.setClip(track.clip);
        state.previewing = track.id;
        trackPlayer.play(0, track.clip.duration);
        syncPreviewButtons();
    }

    function syncPreviewButtons() {
        els.list.querySelectorAll('[data-role="preview"]').forEach((btn, i) => {
            const track = state.tracks[i];
            const on = track && state.previewing === track.id && trackPlayer.playing;
            btn.innerHTML = on ? ui.ICONS.stopSmall : ui.ICONS.playSmall;
            btn.setAttribute('aria-label', `${on ? 'Stop' : 'Play'} ${track ? track.name : 'track'}`);
        });
    }

    // ---------- Settings ----------

    function transition() {
        const kind = document.querySelector('input[name="transition"]:checked').value;
        const seconds = ui.readNumber(els.transitionSeconds, 1, 0, 30);
        return {
            kind,
            gap: kind === 'gap' ? seconds : 0,
            crossfade: kind === 'crossfade' ? seconds : 0
        };
    }

    function settingsKey() {
        const t = transition();
        return JSON.stringify([
            state.tracks.map((track) => track.id),
            t.gap,
            t.crossfade,
            els.sampleRate.value,
            els.channels.value,
            els.normalize.checked
        ]);
    }

    function refreshOutput() {
        const t = transition();
        els.transitionField.hidden = t.kind === 'none';
        els.transitionSecondsLabel.textContent = t.kind === 'gap' ? 'Gap length (s)' : 'Crossfade length (s)';

        const durations = state.tracks.map((track) => track.clip.duration);
        let total = durations.reduce((a, b) => a + b, 0);
        if (durations.length > 1) {
            if (t.gap) total += t.gap * (durations.length - 1);
            if (t.crossfade) {
                for (let i = 1; i < durations.length; i++) {
                    total -= Math.min(t.crossfade, durations[i], durations[i - 1]);
                }
            }
        }
        els.outLength.textContent = AL.formatTime(total);

        const enough = state.tracks.length >= 1;
        els.buildButton.disabled = !enough;
        els.exportButton.disabled = !enough;
        els.resultStale.hidden = !state.result || state.resultKey === settingsKey();
    }

    // ---------- Join ----------

    async function build(setLabel) {
        const key = settingsKey();
        if (state.result && state.resultKey === key) return state.result;
        const t = transition();
        await setLabel('Matching sample rates…');
        const clips = await AL.conform(state.tracks.map((track) => track.clip), {
            sampleRate: els.sampleRate.value,
            channels: els.channels.value
        });
        await setLabel('Joining tracks…');
        const out = AL.concat(clips, { gap: t.gap, crossfade: t.crossfade });
        if (els.normalize.checked) AL.normalize(out, -1);
        state.result = out;
        state.resultKey = key;
        return out;
    }

    function showResult(clip) {
        trackPlayer.stop();
        resultPlayer.setClip(clip);
        els.resultPanel.hidden = false;
        resultWave.setClip(clip);
        resultWave.resize();
        ui.fillMeta(els.resultMeta, clip);
        els.resultTotal.textContent = AL.formatTime(clip.duration);
        resultPlayback.paint();
        refreshOutput();
    }

    async function joinAndPreview() {
        if (!state.tracks.length) return;
        try {
            const clip = await ui.withBusy('Joining…', build);
            showResult(clip);
            $('#resultTitle').focus({ preventScroll: true });
            els.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (error) {
            ui.toast(error.message || 'Joining failed.', 'error');
        }
    }

    async function exportAudio() {
        if (!state.tracks.length) return;
        const format = els.format.value;
        const name = AL.withExtension(els.fileName.value.trim() || 'joined', AL.extensionFor(format));
        try {
            await ui.withBusy('Joining…', async (setLabel) => {
                const clip = await build(setLabel);
                AL.downloadBlob(await AL.encodeWithLabel(clip, format, setLabel), name);
                if (resultPlayer.clip !== clip) showResult(clip);
            });
            ui.toast(`Saved ${name}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    function toggleResultPlay() {
        if (!resultPlayer.clip) return;
        trackPlayer.stop();
        if (resultPlayer.playing) {
            resultPlayer.pause();
        } else {
            const from = resultPlayer.position >= resultPlayer.duration - 0.01 ? 0 : resultPlayer.position;
            resultPlayer.play(from, resultPlayer.duration);
        }
    }

    // ---------- Wiring ----------

    ui.dropzone($('#dropzone'), { multiple: true, onFiles: addFiles });
    ui.dropzone($('#addZone'), { multiple: true, onFiles: addFiles });
    ui.guardPageDrops(addFiles);

    $('#demoButton').addEventListener('click', addDemoTracks);
    $('#clearAll').addEventListener('click', () => {
        state.tracks = [];
        render();
    });

    document.querySelectorAll('input[name="transition"]').forEach((input) => input.addEventListener('change', refreshOutput));
    [els.transitionSeconds, els.sampleRate, els.channels, els.normalize].forEach((input) => {
        input.addEventListener('change', refreshOutput);
        input.addEventListener('input', refreshOutput);
    });

    AL.formatPicker(els.format);
    els.buildButton.addEventListener('click', joinAndPreview);
    els.exportButton.addEventListener('click', exportAudio);
    els.resultPlay.innerHTML = ui.ICONS.play;
    els.resultPlay.addEventListener('click', toggleResultPlay);

    ui.shortcuts({ Space: toggleResultPlay });

    render();
})();
