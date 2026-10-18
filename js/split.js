// ============================================
// SPLIT - AudioLoft
// ============================================
//
// The only state is a sorted list of split points (markers). Parts are the
// spans between them, so every placement method - by hand, fixed interval,
// equal parts, silence detection - just produces a new marker list, and the
// list can still be adjusted by hand afterwards.

(function () {
    'use strict';

    const AL = window.AudioLoft;
    const ui = AL.ui;
    const $ = ui.$;

    const state = {
        clip: null,
        base: 'audio',
        names: [],
        active: -1
    };

    const player = new AL.Player();

    const stages = {
        drop: $('#dropStage'),
        loading: $('#loadingStage'),
        edit: $('#editStage')
    };

    const els = {
        title: $('#fileTitle'),
        meta: $('#fileMeta'),
        play: $('#playButton'),
        timeNow: $('#timeNow'),
        timeTotal: $('#timeTotal'),
        list: $('#segmentList'),
        summary: $('#listSummary'),
        partCount: $('#partCount'),
        outSize: $('#outSize'),
        format: $('#format'),
        trimSilence: $('#trimSilence'),
        fadeEdges: $('#fadeEdges'),
        exportZip: $('#exportZip')
    };

    const wave = new AL.Waveform($('#waveform'), {
        mode: 'markers',
        height: 210,
        onseek: (t) => {
            player.seek(t);
            playback.paint();
        },
        onmarkers: () => {
            if (player.playing && player.isRange) player.stop();
            renderList();
        }
    });

    const playback = ui.bindPlayback({
        player,
        waveform: wave,
        playButton: els.play,
        timeEl: els.timeNow,
        onTick: () => syncRowButtons()
    });

    // ---------- Loading ----------

    function show(stage) {
        Object.entries(stages).forEach(([name, node]) => { node.hidden = name !== stage; });
    }

    async function loadFile(file) {
        player.stop();
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
        state.names = [];
        state.active = -1;
        player.setClip(clip);
        show('edit');
        wave.setClip(clip);

        els.title.textContent = name;
        els.title.title = name;
        ui.fillMeta(els.meta, clip, file);
        els.timeTotal.textContent = AL.formatTime(clip.duration);
        renderList();
        playback.paint();
        els.title.focus({ preventScroll: true });
        ui.announce(`Loaded ${name}, ${AL.formatTime(clip.duration, 1)} long.`);
    }

    // ---------- Parts ----------

    function segments() {
        if (!state.clip) return [];
        const bounds = [0, ...wave.markers, state.clip.duration];
        const out = [];
        for (let i = 0; i < bounds.length - 1; i++) {
            out.push({ start: bounds[i], end: bounds[i + 1] });
        }
        return out;
    }

    function defaultName(i) {
        return `${state.base}-${String(i + 1).padStart(2, '0')}`;
    }

    function nameFor(i) {
        return (state.names[i] && state.names[i].trim()) || defaultName(i);
    }

    function setMarkers(markers, { resetNames = true } = {}) {
        if (resetNames) state.names = [];
        state.active = -1;
        wave.setActiveSegment(-1);
        wave.setMarkers(markers, true);
    }

    function addSplitAtPlayhead() {
        if (!state.clip) return;
        const t = player.currentTime;
        if (t <= 0.01 || t >= state.clip.duration - 0.01) {
            ui.toast('Move the playhead into the track first, then split.');
            return;
        }
        if (wave.markers.some((m) => Math.abs(m - t) < 0.01)) return;
        setMarkers([...wave.markers, t], { resetNames: false });
        ui.announce(`Split added at ${AL.formatTime(t, 2)}`);
    }

    function removeMarker(index) {
        const markers = wave.markers.slice();
        markers.splice(index, 1);
        // Part i + 1 is folded into part i, so later custom names shift down.
        state.names.splice(index + 1, 1);
        setMarkers(markers, { resetNames: false });
    }

    function renderList() {
        const segs = segments();
        const clip = state.clip;
        els.list.innerHTML = '';

        segs.forEach((seg, i) => {
            const color = AL.SEGMENT_COLORS[i % AL.SEGMENT_COLORS.length];
            const nameInput = ui.el('input', {
                class: 'input item-name',
                value: nameFor(i),
                'aria-label': `Name for part ${i + 1}`,
                spellcheck: 'false',
                autocomplete: 'off'
            });
            nameInput.addEventListener('input', () => { state.names[i] = nameInput.value; });

            const playBtn = ui.el('button', {
                type: 'button',
                class: 'btn btn-sm btn-icon',
                'data-role': 'play',
                'aria-label': `Play part ${i + 1}`,
                html: ui.ICONS.playSmall,
                onclick: () => togglePart(i)
            });

            const actions = ui.el('div', { class: 'item-actions' }, [
                playBtn,
                ui.el('button', {
                    type: 'button',
                    class: 'btn btn-sm btn-icon',
                    'aria-label': `Download part ${i + 1}`,
                    title: 'Download this part',
                    html: ui.ICONS.download,
                    onclick: () => exportOne(i)
                }),
                i < segs.length - 1 ? ui.el('button', {
                    type: 'button',
                    class: 'btn btn-sm btn-icon',
                    'aria-label': `Merge part ${i + 1} with part ${i + 2}`,
                    title: 'Merge with the next part',
                    html: ui.ICONS.merge,
                    onclick: () => removeMarker(i)
                }) : ui.el('span', { class: 'btn-spacer', 'aria-hidden': 'true' })
            ]);

            const row = ui.el('li', { class: `item${i === state.active ? ' is-active' : ''}` }, [
                ui.el('span', { class: 'item-index', text: String(i + 1) }),
                ui.el('div', { class: 'item-body' }, [
                    nameInput,
                    ui.el('span', {
                        class: 'item-sub',
                        text: `${AL.formatTime(seg.start)} → ${AL.formatTime(seg.end)} · ${AL.formatTime(seg.end - seg.start, 2)}`
                    })
                ]),
                actions
            ]);
            row.style.setProperty('--swatch', color);
            els.list.appendChild(row);
        });

        const total = clip ? segs.reduce((sum, seg) => sum + AL.estimateBytes(els.format.value, seg.end - seg.start, clip.numberOfChannels, clip.sampleRate), 0) : 0;
        els.partCount.textContent = String(segs.length);
        els.outSize.textContent = `≈ ${AL.formatBytes(total)}`;
        els.summary.textContent = `${segs.length} part${segs.length === 1 ? '' : 's'}`;
        syncRowButtons();
    }

    function syncRowButtons() {
        const playingPart = player.playing && player.isRange ? state.active : -1;
        els.list.querySelectorAll('[data-role="play"]').forEach((btn, i) => {
            const on = i === playingPart;
            btn.innerHTML = on ? ui.ICONS.stopSmall : ui.ICONS.playSmall;
            btn.setAttribute('aria-label', `${on ? 'Stop' : 'Play'} part ${i + 1}`);
        });
    }

    function setActive(i) {
        state.active = i;
        wave.setActiveSegment(i);
        els.list.querySelectorAll('.item').forEach((row, j) => row.classList.toggle('is-active', j === i));
    }

    function togglePart(i) {
        if (player.playing && player.isRange && state.active === i) {
            player.stop();
            syncRowButtons();
            return;
        }
        const seg = segments()[i];
        setActive(i);
        player.play(seg.start, seg.end, { range: true });
        syncRowButtons();
    }

    // ---------- Placement methods ----------

    function applyInterval() {
        const input = $('#intervalInput');
        const step = AL.parseTime(input.value);
        if (!(step > 0)) {
            input.classList.add('is-invalid');
            ui.toast('Enter a length like 30, 1:30 or 0:45.5.', 'error');
            return;
        }
        input.classList.remove('is-invalid');
        const duration = state.clip.duration;
        const count = Math.floor(duration / step);
        if (count > 999) {
            ui.toast('That would make more than 1000 parts. Pick a longer length.', 'error');
            return;
        }
        const markers = [];
        for (let k = 1; k * step < duration - 0.01; k++) markers.push(k * step);
        setMarkers(markers);
        ui.toast(`${markers.length + 1} parts of ${AL.formatTime(step, 1)}${markers.length ? '' : ' (the track is shorter than that)'}`);
    }

    function applyEqual() {
        const parts = Math.round(ui.readNumber($('#partsInput'), 2, 2, 500));
        $('#partsInput').value = String(parts);
        const step = state.clip.duration / parts;
        const markers = [];
        for (let k = 1; k < parts; k++) markers.push(k * step);
        setMarkers(markers);
        ui.toast(`${parts} parts of ${AL.formatTime(step, 2)}`);
    }

    function applySilence() {
        const threshold = ui.readNumber($('#silenceThreshold'), -40, -90, -10);
        const minSilence = ui.readNumber($('#silenceMin'), 0.6, 0.05, 30);
        const duration = state.clip.duration;
        const silences = AL.findSilences(state.clip, threshold, minSilence)
            // Silence at the very start or end isn't a gap between parts.
            .filter((s) => s.start > 0.05 && s.end < duration - 0.05);
        if (!silences.length) {
            ui.toast('No silent gaps found. Try a higher dB value or a shorter minimum.', 'error');
            return;
        }
        setMarkers(silences.map((s) => (s.start + s.end) / 2));
        if (!els.trimSilence.checked) els.trimSilence.checked = true;
        ui.toast(`Found ${silences.length} gap${silences.length === 1 ? '' : 's'} → ${silences.length + 1} parts`, 'success');
    }

    // ---------- Export ----------

    function renderPart(seg) {
        let part = AL.slice(state.clip, seg.start, seg.end);
        if (els.trimSilence.checked) {
            const threshold = ui.readNumber($('#silenceThreshold'), -40, -90, -10);
            const bounds = AL.audibleBounds(part, threshold);
            if (!bounds) return null;
            // Keep a breath of room either side so the cut isn't abrupt.
            part = AL.slice(part, Math.max(0, bounds.start - 0.05), Math.min(part.duration, bounds.end + 0.05));
        }
        if (els.fadeEdges.checked) AL.applyFades(part, 0.01, 0.01);
        return part;
    }

    async function exportOne(i) {
        const seg = segments()[i];
        const format = els.format.value;
        const name = AL.withExtension(nameFor(i), AL.extensionFor(format));
        try {
            await ui.withBusy('Preparing…', async (setLabel) => {
                const part = renderPart(seg);
                if (!part || part.length === 0) throw new Error(`Part ${i + 1} is silent, so there is nothing to save.`);
                AL.downloadBlob(await AL.encodeWithLabel(part, format, setLabel), name);
            });
            ui.toast(`Saved ${name}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    async function exportZip() {
        const segs = segments();
        const format = els.format.value;
        const ext = AL.extensionFor(format);
        const zipName = `${AL.safeFileName(state.base)}-split.zip`;
        try {
            const skipped = await ui.withBusy('Preparing parts…', async (setLabel) => {
                const entries = [];
                const used = new Set();
                let silent = 0;
                for (let i = 0; i < segs.length; i++) {
                    await setLabel(`Encoding part ${i + 1} of ${segs.length}…`);
                    const prefix = `Part ${i + 1} of ${segs.length}: encoding`;
                    const part = renderPart(segs[i]);
                    if (!part || part.length === 0) {
                        silent++;
                        continue;
                    }
                    // ZIP entries must be unique, or most tools keep only one.
                    let name = AL.withExtension(nameFor(i), ext);
                    for (let n = 2; used.has(name.toLowerCase()); n++) {
                        name = AL.withExtension(`${nameFor(i)} (${n})`, ext);
                    }
                    used.add(name.toLowerCase());
                    entries.push({ name, blob: await AL.encodeWithLabel(part, format, setLabel, prefix) });
                }
                if (!entries.length) throw new Error('Every part is silent, so there is nothing to save.');
                await setLabel('Packing ZIP…');
                AL.downloadBlob(await AL.makeZip(entries), zipName);
                return silent;
            });
            ui.toast(`Saved ${zipName}${skipped ? ` (skipped ${skipped} silent part${skipped === 1 ? '' : 's'})` : ''}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    // ---------- Tabs ----------

    function setupTabs() {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        const select = (tab) => {
            tabs.forEach((t) => {
                const on = t === tab;
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
                document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
            });
        };
        tabs.forEach((tab, i) => {
            tab.addEventListener('click', () => select(tab));
            tab.addEventListener('keydown', (e) => {
                const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (!dir) return;
                e.preventDefault();
                const next = tabs[(i + dir + tabs.length) % tabs.length];
                select(next);
                next.focus();
            });
        });
    }

    // ---------- Wiring ----------

    const dz = ui.dropzone($('#dropzone'), { onFiles: (files) => loadFile(files[0]) });
    ui.guardPageDrops((files) => loadFile(files[0]));

    $('#demoButton').addEventListener('click', () => setClip(AL.createDemoClip(0), 'AudioLoft demo.wav', null));
    $('#replaceButton').addEventListener('click', () => dz.open());

    els.play.innerHTML = ui.ICONS.play;
    els.play.addEventListener('click', togglePlay);
    $('#addSplit').addEventListener('click', addSplitAtPlayhead);
    $('#addSplitManual').addEventListener('click', addSplitAtPlayhead);
    $('#clearSplits').addEventListener('click', () => setMarkers([]));
    $('#applyInterval').addEventListener('click', applyInterval);
    $('#applyEqual').addEventListener('click', applyEqual);
    $('#applySilence').addEventListener('click', applySilence);
    $('#zoomIn').addEventListener('click', () => wave.zoomBy(2, player.currentTime));
    $('#zoomOut').addEventListener('click', () => wave.zoomBy(0.5, player.currentTime));
    $('#zoomFit').addEventListener('click', () => wave.zoomToFit());
    AL.formatPicker(els.format, renderList);
    els.exportZip.addEventListener('click', exportZip);

    function togglePlay() {
        if (!state.clip) return;
        if (player.playing) {
            player.pause();
        } else {
            const from = player.position >= state.clip.duration - 0.01 ? 0 : player.position;
            player.play(from, state.clip.duration);
        }
        syncRowButtons();
    }

    setupTabs();

    ui.shortcuts({
        Space: togglePlay,
        m: addSplitAtPlayhead
    });
})();
