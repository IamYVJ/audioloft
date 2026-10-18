// ============================================
// TRIM - AudioLoft
// ============================================
//
// One file in, one WAV out. The selection either becomes the output (Keep)
// or is cut out of it (Remove), then fades and normalization are applied to
// the result. The source clip is never modified, so every export starts
// from the original audio.

(function () {
    'use strict';

    const AL = window.AudioLoft;
    const ui = AL.ui;
    const $ = ui.$;

    const state = {
        clip: null,
        base: 'audio',
        loop: false
    };

    const player = new AL.Player();
    const preview = new AL.Player();

    const stages = {
        drop: $('#dropStage'),
        loading: $('#loadingStage'),
        edit: $('#editStage')
    };

    const els = {
        title: $('#fileTitle'),
        meta: $('#fileMeta'),
        play: $('#playButton'),
        playSelection: $('#playSelection'),
        loop: $('#loopButton'),
        timeNow: $('#timeNow'),
        timeTotal: $('#timeTotal'),
        selStart: $('#selStart'),
        selEnd: $('#selEnd'),
        selLength: $('#selLength'),
        fadeIn: $('#fadeIn'),
        fadeOut: $('#fadeOut'),
        normalize: $('#normalize'),
        fileName: $('#fileName'),
        bitDepth: $('#bitDepth'),
        outLength: $('#outLength'),
        outSize: $('#outSize'),
        previewButton: $('#previewButton'),
        exportButton: $('#exportButton')
    };

    const wave = new AL.Waveform($('#waveform'), {
        mode: 'range',
        height: 210,
        onseek: (t) => {
            stopPreview();
            player.seek(t);
            playback.paint();
        },
        onselect: () => {
            // Dragging the selection while a range is playing would leave
            // playback looping over stale bounds.
            if (player.playing && player.isRange) player.stop();
            refreshSelection();
        }
    });

    const playback = ui.bindPlayback({
        player,
        waveform: wave,
        playButton: els.play,
        timeEl: els.timeNow
    });

    // ---------- Loading ----------

    function show(stage) {
        Object.entries(stages).forEach(([name, node]) => { node.hidden = name !== stage; });
    }

    async function loadFile(file) {
        player.stop();
        stopPreview();
        show('loading');
        $('#loadingText').textContent = `Decoding “${file.name}”…`;
        try {
            const clip = await AL.decodeFile(file);
            setClip(clip, file.name, file);
        } catch (error) {
            show(state.clip ? 'edit' : 'drop');
            ui.toast(error.message, 'error');
        }
    }

    function setClip(clip, name, file) {
        state.clip = clip;
        state.base = AL.baseName(name);
        player.setClip(clip);
        show('edit');
        wave.setClip(clip);
        wave.setSelection(0, clip.duration, false);

        els.title.textContent = name;
        els.title.title = name;
        ui.fillMeta(els.meta, clip, file);
        els.timeTotal.textContent = AL.formatTime(clip.duration);
        els.fileName.value = `${state.base}-trimmed`;
        refreshSelection();
        playback.paint();
        els.title.focus({ preventScroll: true });
        ui.announce(`Loaded ${name}, ${AL.formatTime(clip.duration, 1)} long.`);
    }

    // ---------- Selection ----------

    function selection() {
        const sel = wave.selection;
        if (!sel || sel.end - sel.start <= 0) return { start: 0, end: state.clip ? state.clip.duration : 0, empty: true };
        return { start: sel.start, end: sel.end, empty: false };
    }

    const startField = ui.timeField(els.selStart, {
        get: () => selection().start,
        set: (t) => {
            const sel = selection();
            wave.setSelection(Math.min(t, sel.end), sel.end);
        }
    });

    const endField = ui.timeField(els.selEnd, {
        get: () => selection().end,
        set: (t) => {
            const sel = selection();
            wave.setSelection(sel.start, Math.max(t, sel.start));
        }
    });

    function mode() {
        return document.querySelector('input[name="mode"]:checked').value;
    }

    function outputDuration() {
        if (!state.clip) return 0;
        const sel = selection();
        const span = sel.end - sel.start;
        if (mode() === 'keep') return span;
        if (sel.empty) return state.clip.duration;
        return state.clip.duration - span;
    }

    function refreshSelection() {
        if (!state.clip) return;
        const sel = selection();
        startField.refresh();
        endField.refresh();
        els.selLength.textContent = AL.formatTime(sel.end - sel.start);
        refreshOutput();
    }

    function refreshOutput() {
        if (!state.clip) return;
        const duration = outputDuration();
        const depth = Number(els.bitDepth.value);
        const samples = Math.round(duration * state.clip.sampleRate);
        els.outLength.textContent = AL.formatTime(duration);
        els.outSize.textContent = AL.formatBytes(44 + samples * state.clip.numberOfChannels * depth / 8);
        const nothing = duration < 0.001;
        els.exportButton.disabled = nothing;
        els.previewButton.disabled = nothing;
    }

    function setEdgeAtPlayhead(edge) {
        if (!state.clip) return;
        const t = player.currentTime;
        const sel = selection();
        if (edge === 'start') {
            wave.setSelection(t, t < sel.end ? sel.end : state.clip.duration);
        } else {
            wave.setSelection(t > sel.start ? sel.start : 0, t);
        }
    }

    // ---------- Output ----------

    function buildOutput() {
        const sel = selection();
        const clip = state.clip;
        let out;
        if (mode() === 'keep') {
            out = AL.slice(clip, sel.start, sel.end);
        } else {
            out = sel.empty ? AL.copy(clip) : AL.removeRange(clip, sel.start, sel.end);
        }
        AL.applyFades(out, ui.readNumber(els.fadeIn, 0, 0), ui.readNumber(els.fadeOut, 0, 0));
        if (els.normalize.checked) AL.normalize(out, -1);
        return out;
    }

    function stopPreview() {
        if (preview.playing) preview.stop();
    }

    preview.onChange(() => {
        els.previewButton.textContent = preview.playing ? 'Stop preview' : 'Preview result';
    });

    function togglePreview() {
        if (!state.clip) return;
        if (preview.playing) {
            preview.stop();
            return;
        }
        player.stop();
        const out = buildOutput();
        if (out.length === 0) return;
        preview.setClip(out);
        preview.play(0, out.duration);
    }

    async function exportWav() {
        if (!state.clip) return;
        const depth = Number(els.bitDepth.value);
        const name = AL.withExtension(els.fileName.value.trim() || `${state.base}-trimmed`, 'wav');
        try {
            await ui.withBusy('Encoding WAV…', async () => {
                const out = buildOutput();
                if (out.length === 0) throw new Error('The result would be empty. Adjust the selection first.');
                AL.downloadBlob(AL.encodeWav(out, depth), name);
            });
            ui.toast(`Saved ${name}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    // ---------- Transport ----------

    function togglePlay() {
        if (!state.clip) return;
        stopPreview();
        if (player.playing) {
            player.pause();
        } else {
            const from = player.position >= state.clip.duration - 0.01 ? 0 : player.position;
            player.play(from, state.clip.duration);
        }
    }

    function playSelection() {
        if (!state.clip) return;
        stopPreview();
        const sel = selection();
        player.play(sel.start, sel.end, { range: true, loop: state.loop });
    }

    function toggleLoop() {
        state.loop = !state.loop;
        els.loop.setAttribute('aria-pressed', String(state.loop));
        if (player.playing && player.isRange) playSelection();
        ui.announce(state.loop ? 'Loop on' : 'Loop off');
    }

    // ---------- Wiring ----------

    const dz = ui.dropzone($('#dropzone'), { onFiles: (files) => loadFile(files[0]) });
    ui.guardPageDrops((files) => loadFile(files[0]));

    $('#demoButton').addEventListener('click', () => setClip(AL.createDemoClip(0), 'AudioLoft demo.wav', null));
    $('#replaceButton').addEventListener('click', () => dz.open());

    els.play.innerHTML = ui.ICONS.play;
    els.play.addEventListener('click', togglePlay);
    els.playSelection.addEventListener('click', playSelection);
    els.loop.addEventListener('click', toggleLoop);
    $('#setStart').addEventListener('click', () => setEdgeAtPlayhead('start'));
    $('#setEnd').addEventListener('click', () => setEdgeAtPlayhead('end'));
    $('#selectAll').addEventListener('click', () => state.clip && wave.setSelection(0, state.clip.duration));

    $('#zoomIn').addEventListener('click', () => wave.zoomBy(2, player.currentTime));
    $('#zoomOut').addEventListener('click', () => wave.zoomBy(0.5, player.currentTime));
    $('#zoomFit').addEventListener('click', () => wave.zoomToFit());
    $('#zoomSelection').addEventListener('click', () => {
        const sel = selection();
        if (!sel.empty) wave.zoomToRange(sel.start, sel.end);
    });

    document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', refreshOutput));
    els.bitDepth.addEventListener('change', refreshOutput);
    [els.fadeIn, els.fadeOut, els.normalize].forEach((input) => input.addEventListener('change', stopPreview));
    els.previewButton.addEventListener('click', togglePreview);
    els.exportButton.addEventListener('click', exportWav);

    ui.shortcuts({
        Space: togglePlay,
        p: playSelection,
        l: toggleLoop,
        i: () => setEdgeAtPlayhead('start'),
        o: () => setEdgeAtPlayhead('end')
    });
})();
