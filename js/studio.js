// ============================================
// STUDIO - AudioLoft
// ============================================
//
// Trim, split and join in one place. Every file added becomes a *source*;
// the arrangement is an ordered list of *clips*, each of which plays a range
// of one source. Nothing is copied until export:
//
//   trim   – change a clip's start / end
//   split  – replace one clip with two that share its source
//   join   – the clip order is the output order
//
// Because clips only point at sources, several clips can come from one
// track (split it, duplicate a chorus) and any of them can be re-trimmed
// later without losing audio.

(function () {
    'use strict';

    const AL = window.AudioLoft;
    const ui = AL.ui;
    const $ = ui.$;

    const MIN_CLIP = 0.01;

    const state = {
        sources: new Map(),
        clips: [],
        selectedId: null,
        nextId: 1,
        loop: false,
        dragId: null,
        mix: null,
        mixKey: ''
    };

    const editorPlayer = new AL.Player();
    const mixPlayer = new AL.Player();

    const els = {
        dropStage: $('#dropStage'),
        studioStage: $('#studioStage'),
        clipCount: $('#clipCount'),
        projectLength: $('#projectLength'),
        mixPlay: $('#mixPlay'),
        mixTime: $('#mixTime'),
        mixTotal: $('#mixTotal'),
        timeline: $('#timeline'),
        clipIndex: $('#clipIndex'),
        clipName: $('#clipName'),
        clipSource: $('#clipSource'),
        play: $('#playButton'),
        loop: $('#loopButton'),
        timeNow: $('#timeNow'),
        timeTotal: $('#timeTotal'),
        clipStart: $('#clipStart'),
        clipEnd: $('#clipEnd'),
        clipLength: $('#clipLength'),
        fadeIn: $('#fadeIn'),
        fadeOut: $('#fadeOut'),
        clipPosition: $('#clipPosition'),
        sourceLength: $('#sourceLength'),
        list: $('#clipList'),
        listSummary: $('#listSummary'),
        transitionField: $('#transitionField'),
        transitionSeconds: $('#transitionSeconds'),
        transitionSecondsLabel: $('#transitionSecondsLabel'),
        sampleRate: $('#sampleRate'),
        channels: $('#channels'),
        normalize: $('#normalize'),
        fileName: $('#fileName'),
        bitDepth: $('#bitDepth'),
        outLength: $('#outLength')
    };

    const wave = new AL.Waveform($('#waveform'), {
        mode: 'range',
        height: 190,
        onseek: (t) => {
            mixPlayer.stop();
            editorPlayer.seek(t);
            editorPlayback.paint();
        },
        onselect: (sel) => {
            const clip = selected();
            if (!clip || !sel || sel.end - sel.start < MIN_CLIP) return;
            if (editorPlayer.playing && editorPlayer.isRange) editorPlayer.stop();
            clip.start = sel.start;
            clip.end = sel.end;
            clipChanged();
        }
    });

    const editorPlayback = ui.bindPlayback({
        player: editorPlayer,
        waveform: wave,
        playButton: els.play,
        timeEl: els.timeNow
    });

    const mixPlayback = ui.bindPlayback({
        player: mixPlayer,
        playButton: els.mixPlay,
        timeEl: els.mixTime,
        onTick: (t) => positionPlayhead(t)
    });

    // ---------- Model helpers ----------

    function selected() {
        return state.clips.find((c) => c.id === state.selectedId) || null;
    }

    function indexOf(id) {
        return state.clips.findIndex((c) => c.id === id);
    }

    function sourceOf(clip) {
        return state.sources.get(clip.sourceId);
    }

    function lengthOf(clip) {
        return clip.end - clip.start;
    }

    function uniqueName(base) {
        const names = new Set(state.clips.map((c) => c.name));
        if (!names.has(base)) return base;
        const stem = base.replace(/ \(\d+\)$/, '');
        for (let n = 2; ; n++) {
            const candidate = `${stem} (${n})`;
            if (!names.has(candidate)) return candidate;
        }
    }

    function makeClip(source, fields = {}) {
        return Object.assign({
            id: state.nextId++,
            sourceId: source.id,
            start: 0,
            end: source.clip.duration,
            fadeIn: 0,
            fadeOut: 0,
            name: AL.baseName(source.name)
        }, fields);
    }

    // ---------- Adding tracks ----------

    function addSource(name, clip, size) {
        const source = {
            id: state.nextId++,
            name,
            size,
            clip,
            color: AL.SEGMENT_COLORS[state.sources.size % AL.SEGMENT_COLORS.length]
        };
        state.sources.set(source.id, source);
        return source;
    }

    async function addFiles(files) {
        const added = [];
        await ui.withBusy('Decoding…', async (setLabel) => {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                await setLabel(files.length > 1 ? `Decoding ${i + 1} of ${files.length}…` : `Decoding “${file.name}”…`);
                try {
                    const clip = await AL.decodeFile(file);
                    added.push(addSource(file.name, clip, file.size));
                } catch (error) {
                    ui.toast(error.message, 'error');
                }
            }
        });
        addClipsFor(added);
    }

    function addClipsFor(sources) {
        if (!sources.length) return;
        const clips = sources.map((source) => {
            const clip = makeClip(source);
            clip.name = uniqueName(clip.name);
            state.clips.push(clip);
            return clip;
        });
        if (state.clips.length === clips.length && els.fileName.value === 'studio-mix') {
            els.fileName.value = `${clips[0].name}-mix`;
        }
        renderAll();
        if (!selected()) selectClip(clips[0].id);
        ui.announce(`${clips.length} track${clips.length === 1 ? '' : 's'} added.`);
    }

    function addDemo() {
        const sources = [1, 2, 3].map((variant) =>
            addSource(`Demo track ${variant}.wav`, AL.createDemoClip(variant), 0));
        addClipsFor(sources);
    }

    // ---------- Selection ----------

    function selectClip(id, { zoom = true } = {}) {
        const clip = state.clips.find((c) => c.id === id);
        if (!clip) return;
        const source = sourceOf(clip);
        const sourceChanged = wave.clip !== source.clip;
        state.selectedId = id;

        if (editorPlayer.clip !== source.clip) {
            editorPlayer.setClip(source.clip);
        } else {
            editorPlayer.stop();
        }

        if (sourceChanged) wave.setClip(source.clip);
        wave.setSelection(clip.start, clip.end, false);
        if (zoom) {
            const span = lengthOf(clip);
            if (span < source.clip.duration * 0.9) wave.zoomToRange(clip.start, clip.end);
            else wave.zoomToFit();
        }
        editorPlayer.position = clip.start;
        wave.setPlayhead(clip.start);
        els.timeNow.textContent = AL.formatTime(clip.start);
        els.timeTotal.textContent = AL.formatTime(source.clip.duration);
        els.sourceLength.textContent = AL.formatTime(source.clip.duration);

        refreshClipPanel();
        markSelected();
    }

    function markSelected() {
        els.timeline.querySelectorAll('.timeline-seg').forEach((seg) => {
            const on = Number(seg.dataset.id) === state.selectedId;
            seg.classList.toggle('is-selected', on);
            seg.setAttribute('aria-current', on ? 'true' : 'false');
        });
        els.list.querySelectorAll('.item').forEach((row) => {
            row.classList.toggle('is-active', Number(row.dataset.id) === state.selectedId);
        });
    }

    // ---------- Clip editing ----------

    const startField = ui.timeField(els.clipStart, {
        get: () => (selected() ? selected().start : 0),
        set: (t) => {
            const clip = selected();
            if (!clip) return;
            clip.start = Math.max(0, Math.min(t, clip.end - MIN_CLIP));
            wave.setSelection(clip.start, clip.end, false);
            clipChanged();
        }
    });

    const endField = ui.timeField(els.clipEnd, {
        get: () => (selected() ? selected().end : 0),
        set: (t) => {
            const clip = selected();
            if (!clip) return;
            clip.end = Math.min(sourceOf(clip).clip.duration, Math.max(t, clip.start + MIN_CLIP));
            wave.setSelection(clip.start, clip.end, false);
            clipChanged();
        }
    });

    function refreshClipPanel() {
        const clip = selected();
        if (!clip) return;
        const source = sourceOf(clip);
        const i = indexOf(clip.id);
        els.clipIndex.textContent = String(i + 1);
        els.clipIndex.style.setProperty('--swatch', source.color);
        if (document.activeElement !== els.clipName) els.clipName.value = clip.name;
        els.clipSource.textContent = `from ${source.name}`;
        startField.refresh();
        endField.refresh();
        els.clipLength.textContent = AL.formatTime(lengthOf(clip));
        if (document.activeElement !== els.fadeIn) els.fadeIn.value = String(clip.fadeIn);
        if (document.activeElement !== els.fadeOut) els.fadeOut.value = String(clip.fadeOut);
        els.clipPosition.textContent = `${i + 1} of ${state.clips.length}`;
    }

    // Called for every edit to a clip. Panel text updates at once; the
    // timeline and list (which redraw mini waveforms) wait until a drag
    // settles.
    let structureTimer = 0;
    function clipChanged() {
        invalidateMix();
        refreshClipPanel();
        refreshProject();
        clearTimeout(structureTimer);
        structureTimer = setTimeout(() => {
            renderTimeline();
            renderList();
        }, 140);
    }

    function setEdgeAtPlayhead(edge) {
        const clip = selected();
        if (!clip) return;
        const t = editorPlayer.currentTime;
        if (edge === 'start') {
            if (t >= clip.end - MIN_CLIP) {
                ui.toast('The start has to be before the end of the clip.');
                return;
            }
            clip.start = t;
        } else {
            if (t <= clip.start + MIN_CLIP) {
                ui.toast('The end has to be after the start of the clip.');
                return;
            }
            clip.end = t;
        }
        wave.setSelection(clip.start, clip.end, false);
        clipChanged();
    }

    function splitAtPlayhead() {
        const clip = selected();
        if (!clip) return;
        const t = editorPlayer.currentTime;
        if (t <= clip.start + MIN_CLIP || t >= clip.end - MIN_CLIP) {
            ui.toast('Move the playhead inside the bright part of the clip first, then split.');
            return;
        }
        const right = makeClip(sourceOf(clip), {
            start: t,
            end: clip.end,
            fadeIn: 0,
            fadeOut: clip.fadeOut,
            name: uniqueName(clip.name)
        });
        clip.end = t;
        clip.fadeOut = 0;
        state.clips.splice(indexOf(clip.id) + 1, 0, right);
        invalidateMix();
        renderAll();
        selectClip(clip.id, { zoom: false });
        ui.toast(`Split “${clip.name}” at ${AL.formatTime(t, 2)} into two clips`, 'success');
    }

    function duplicateClip() {
        const clip = selected();
        if (!clip) return;
        const copy = Object.assign({}, clip, { id: state.nextId++, name: uniqueName(clip.name) });
        state.clips.splice(indexOf(clip.id) + 1, 0, copy);
        invalidateMix();
        renderAll();
        selectClip(copy.id);
        ui.announce(`Duplicated as ${copy.name}`);
    }

    function deleteClip(id = state.selectedId) {
        const i = indexOf(id);
        if (i < 0) return;
        const [clip] = state.clips.splice(i, 1);
        // Drop the source too once nothing uses it, so its memory can go.
        if (!state.clips.some((c) => c.sourceId === clip.sourceId)) {
            const source = state.sources.get(clip.sourceId);
            state.sources.delete(clip.sourceId);
            if (editorPlayer.clip === source.clip) editorPlayer.setClip(null);
        }
        invalidateMix();
        if (!state.clips.length) {
            state.selectedId = null;
            renderAll();
            return;
        }
        renderAll();
        if (state.selectedId === id) selectClip(state.clips[Math.min(i, state.clips.length - 1)].id);
        ui.announce(`Deleted ${clip.name}`);
    }

    function moveClip(from, to) {
        if (to < 0 || to >= state.clips.length || from === to) return;
        const [clip] = state.clips.splice(from, 1);
        state.clips.splice(to, 0, clip);
        invalidateMix();
        renderAll();
        ui.announce(`${clip.name} moved to position ${to + 1}`);
    }

    function stepSelection(delta) {
        const i = indexOf(state.selectedId);
        const next = state.clips[i + delta];
        if (next) selectClip(next.id);
    }

    // ---------- Rendering ----------

    function renderAll() {
        const empty = state.clips.length === 0;
        els.dropStage.hidden = !empty;
        els.studioStage.hidden = empty;
        if (empty) {
            editorPlayer.stop();
            mixPlayer.stop();
        }
        renderTimeline();
        renderList();
        refreshProject();
        refreshClipPanel();
    }

    function renderTimeline() {
        els.timeline.innerHTML = '';
        state.clips.forEach((clip, i) => {
            const source = sourceOf(clip);
            const seg = ui.el('button', {
                type: 'button',
                class: 'timeline-seg',
                role: 'listitem',
                draggable: 'true',
                'data-id': String(clip.id),
                title: `${clip.name} · ${AL.formatTime(lengthOf(clip), 2)}`,
                'aria-label': `Clip ${i + 1}: ${clip.name}, ${AL.formatTime(lengthOf(clip), 1)}`,
                onclick: () => selectClip(clip.id)
            }, [
                ui.el('span', { class: 'seg-label' }, [
                    ui.el('b', { text: String(i + 1) }),
                    ui.el('span', { text: clip.name })
                ]),
                ui.el('canvas', { 'aria-hidden': 'true' })
            ]);
            seg.style.setProperty('--swatch', source.color);
            seg.style.flexGrow = String(Math.max(0.001, lengthOf(clip)));
            bindDrag(seg, clip, 'x');
            els.timeline.appendChild(seg);
        });
        els.timeline.appendChild(ui.el('div', { class: 'timeline-playhead', id: 'timelinePlayhead', hidden: true }));

        requestAnimationFrame(() => {
            els.timeline.querySelectorAll('.timeline-seg canvas').forEach((canvas, i) => {
                const clip = state.clips[i];
                if (clip) AL.drawMiniWave(canvas, sourceOf(clip).clip, sourceOf(clip).color, clip.start, clip.end);
            });
            positionPlayhead(mixPlayer.currentTime);
        });
        markSelected();
    }

    function renderList() {
        els.list.innerHTML = '';
        const n = state.clips.length;
        state.clips.forEach((clip, i) => {
            const source = sourceOf(clip);
            const row = ui.el('li', {
                class: 'item item-clip',
                draggable: 'true',
                'data-id': String(clip.id)
            }, [
                ui.el('span', { class: 'item-index', text: String(i + 1) }),
                ui.el('div', { class: 'item-body' }, [
                    ui.el('span', { class: 'item-title', text: clip.name, title: clip.name }),
                    ui.el('span', {
                        class: 'item-sub',
                        text: `${AL.formatTime(clip.start, 2)} → ${AL.formatTime(clip.end, 2)} · ${AL.formatTime(lengthOf(clip), 2)}`,
                        title: source.name
                    })
                ]),
                ui.el('div', { class: 'item-actions' }, [
                    ui.el('button', {
                        type: 'button', class: 'btn btn-sm btn-icon', html: ui.ICONS.up,
                        'aria-label': `Move ${clip.name} earlier`, title: 'Move earlier', disabled: i === 0,
                        onclick: (e) => { e.stopPropagation(); moveClip(i, i - 1); }
                    }),
                    ui.el('button', {
                        type: 'button', class: 'btn btn-sm btn-icon', html: ui.ICONS.down,
                        'aria-label': `Move ${clip.name} later`, title: 'Move later', disabled: i === n - 1,
                        onclick: (e) => { e.stopPropagation(); moveClip(i, i + 1); }
                    }),
                    ui.el('button', {
                        type: 'button', class: 'btn btn-sm btn-icon btn-danger', html: ui.ICONS.remove,
                        'aria-label': `Delete ${clip.name}`, title: 'Delete',
                        onclick: (e) => { e.stopPropagation(); deleteClip(clip.id); }
                    })
                ])
            ]);
            row.style.setProperty('--swatch', source.color);
            row.addEventListener('click', () => selectClip(clip.id));
            bindDrag(row, clip, 'y');
            els.list.appendChild(row);
        });
        els.listSummary.textContent = `${n} clip${n === 1 ? '' : 's'} · ${state.sources.size} track${state.sources.size === 1 ? '' : 's'}`;
        markSelected();
    }

    // ---------- Drag to reorder (timeline and list) ----------

    function bindDrag(node, clip, axis) {
        node.addEventListener('dragstart', (e) => {
            state.dragId = clip.id;
            node.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(clip.id));
        });
        node.addEventListener('dragend', () => {
            state.dragId = null;
            node.classList.remove('is-dragging');
            clearDropMarks();
        });
        node.addEventListener('dragover', (e) => {
            if (state.dragId === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearDropMarks();
            node.classList.add(isAfter(node, e, axis) ? 'drop-after' : 'drop-before');
        });
        node.addEventListener('drop', (e) => {
            if (state.dragId === null) return;
            e.preventDefault();
            e.stopPropagation();
            const from = indexOf(state.dragId);
            let to = indexOf(clip.id);
            if (isAfter(node, e, axis)) to += 1;
            if (from < to) to -= 1;
            state.dragId = null;
            clearDropMarks();
            moveClip(from, to);
        });
    }

    function isAfter(node, e, axis) {
        const rect = node.getBoundingClientRect();
        return axis === 'x' ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2;
    }

    function clearDropMarks() {
        document.querySelectorAll('.drop-before, .drop-after').forEach((node) => {
            node.classList.remove('drop-before', 'drop-after');
        });
    }

    // ---------- Arrangement ----------

    function transition() {
        const kind = document.querySelector('input[name="transition"]:checked').value;
        const seconds = ui.readNumber(els.transitionSeconds, 1, 0, 30);
        return {
            kind,
            gap: kind === 'gap' ? seconds : 0,
            crossfade: kind === 'crossfade' ? seconds : 0
        };
    }

    // Where each clip starts in the joined output, mirroring AL.concat.
    function layout() {
        const t = transition();
        const lengths = state.clips.map(lengthOf);
        const offsets = [];
        let pos = 0;
        lengths.forEach((len, i) => {
            if (i > 0) pos += t.crossfade ? -Math.min(t.crossfade, len, lengths[i - 1]) : t.gap;
            offsets.push(pos);
            pos += len;
        });
        return { lengths, offsets, total: Math.max(0, pos) };
    }

    function refreshProject() {
        const t = transition();
        els.transitionField.hidden = t.kind === 'none';
        els.transitionSecondsLabel.textContent = t.kind === 'gap' ? 'Gap length (s)' : 'Crossfade length (s)';
        const { total } = layout();
        const n = state.clips.length;
        els.clipCount.textContent = `${n} clip${n === 1 ? '' : 's'}`;
        els.projectLength.textContent = AL.formatTime(total, 2);
        els.outLength.textContent = AL.formatTime(total);
        if (!mixPlayer.clip || state.mixKey !== mixKey()) els.mixTotal.textContent = AL.formatTime(total);
    }

    // Maps a time in the joined output to a spot on the timeline strip,
    // whose segments are sized by clip length (gaps aren't drawn).
    function positionPlayhead(t) {
        const head = $('#timelinePlayhead');
        if (!head) return;
        const segs = els.timeline.querySelectorAll('.timeline-seg');
        if (!mixPlayer.clip || (!mixPlayer.playing && t === 0) || !segs.length) {
            head.hidden = true;
            return;
        }
        const { lengths, offsets } = layout();
        let i = offsets.length - 1;
        while (i > 0 && t < offsets[i]) i--;
        const seg = segs[i];
        if (!seg) return;
        const frac = Math.max(0, Math.min(1, (t - offsets[i]) / (lengths[i] || 1)));
        head.hidden = false;
        // The playhead lives inside the scrolling strip, so it scrolls with it.
        head.style.left = `${seg.offsetLeft + frac * seg.offsetWidth}px`;
    }

    function mixKey() {
        const t = transition();
        return JSON.stringify([
            state.clips.map((c) => [c.sourceId, c.start, c.end, c.fadeIn, c.fadeOut]),
            t.gap,
            t.crossfade,
            els.sampleRate.value,
            els.channels.value,
            els.normalize.checked
        ]);
    }

    function invalidateMix() {
        if (mixPlayer.playing) mixPlayer.stop();
    }

    function renderPiece(clip) {
        const piece = AL.slice(sourceOf(clip).clip, clip.start, clip.end);
        AL.applyFades(piece, clip.fadeIn, clip.fadeOut);
        return piece;
    }

    async function buildMix(setLabel) {
        const key = mixKey();
        if (state.mix && state.mixKey === key) return state.mix;
        await setLabel('Matching sample rates…');
        const pieces = await AL.conform(state.clips.map(renderPiece), {
            sampleRate: els.sampleRate.value,
            channels: els.channels.value
        });
        await setLabel('Joining clips…');
        const t = transition();
        const mix = AL.concat(pieces, { gap: t.gap, crossfade: t.crossfade });
        if (els.normalize.checked) AL.normalize(mix, -1);
        state.mix = mix;
        state.mixKey = key;
        return mix;
    }

    async function toggleMix() {
        if (!state.clips.length) return;
        if (mixPlayer.playing) {
            mixPlayer.pause();
            return;
        }
        editorPlayer.stop();
        try {
            const fresh = !(state.mix && state.mixKey === mixKey());
            const mix = fresh ? await ui.withBusy('Preparing playback…', buildMix) : state.mix;
            if (mixPlayer.clip !== mix) mixPlayer.setClip(mix);
            els.mixTotal.textContent = AL.formatTime(mix.duration);
            const from = mixPlayer.position >= mix.duration - 0.01 ? 0 : mixPlayer.position;
            mixPlayer.play(from, mix.duration);
        } catch (error) {
            ui.toast(error.message || 'Playback failed.', 'error');
        }
    }

    // ---------- Export ----------

    async function exportJoined() {
        if (!state.clips.length) return;
        const name = AL.withExtension(els.fileName.value.trim() || 'studio-mix', 'wav');
        const depth = Number(els.bitDepth.value);
        try {
            await ui.withBusy('Joining…', async (setLabel) => {
                const mix = await buildMix(setLabel);
                await setLabel('Encoding WAV…');
                AL.downloadBlob(AL.encodeWav(mix, depth), name);
            });
            ui.toast(`Saved ${name}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    async function exportClips() {
        if (!state.clips.length) return;
        const depth = Number(els.bitDepth.value);
        const zipName = `${AL.safeFileName(els.fileName.value.trim() || 'studio')}-clips.zip`;
        try {
            await ui.withBusy('Preparing clips…', async (setLabel) => {
                const entries = [];
                const used = new Set();
                for (let i = 0; i < state.clips.length; i++) {
                    const clip = state.clips[i];
                    await setLabel(`Encoding clip ${i + 1} of ${state.clips.length}…`);
                    const base = `${String(i + 1).padStart(2, '0')} ${clip.name}`;
                    let name = AL.withExtension(base, 'wav');
                    for (let n = 2; used.has(name.toLowerCase()); n++) name = AL.withExtension(`${base} (${n})`, 'wav');
                    used.add(name.toLowerCase());
                    entries.push({ name, blob: AL.encodeWav(renderPiece(clip), depth) });
                }
                await setLabel('Packing ZIP…');
                AL.downloadBlob(await AL.makeZip(entries), zipName);
            });
            ui.toast(`Saved ${zipName}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    async function downloadClip() {
        const clip = selected();
        if (!clip) return;
        const name = AL.withExtension(clip.name, 'wav');
        try {
            await ui.withBusy('Encoding WAV…', async () => {
                AL.downloadBlob(AL.encodeWav(renderPiece(clip), Number(els.bitDepth.value)), name);
            });
            ui.toast(`Saved ${name}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    // ---------- Editor transport ----------

    function togglePlay() {
        const clip = selected();
        if (!clip) return;
        mixPlayer.pause();
        if (editorPlayer.playing) {
            editorPlayer.pause();
        } else {
            const duration = sourceOf(clip).clip.duration;
            const from = editorPlayer.position >= duration - 0.01 ? 0 : editorPlayer.position;
            editorPlayer.play(from, duration);
        }
    }

    function playClip() {
        const clip = selected();
        if (!clip) return;
        mixPlayer.pause();
        editorPlayer.play(clip.start, clip.end, { range: true, loop: state.loop });
    }

    function toggleLoop() {
        state.loop = !state.loop;
        els.loop.setAttribute('aria-pressed', String(state.loop));
        if (editorPlayer.playing && editorPlayer.isRange) playClip();
        ui.announce(state.loop ? 'Loop on' : 'Loop off');
    }

    // ---------- Wiring ----------

    const addDz = ui.dropzone($('#addZone'), { multiple: true, onFiles: addFiles });
    ui.dropzone($('#dropzone'), { multiple: true, onFiles: addFiles });
    ui.guardPageDrops(addFiles);

    $('#demoButton').addEventListener('click', addDemo);
    $('#addFilesButton').addEventListener('click', () => addDz.open());

    els.mixPlay.innerHTML = ui.ICONS.play;
    els.mixPlay.addEventListener('click', toggleMix);
    els.play.innerHTML = ui.ICONS.play;
    els.play.addEventListener('click', togglePlay);
    $('#playClip').addEventListener('click', playClip);
    els.loop.addEventListener('click', toggleLoop);
    $('#splitButton').addEventListener('click', splitAtPlayhead);
    $('#setStart').addEventListener('click', () => setEdgeAtPlayhead('start'));
    $('#setEnd').addEventListener('click', () => setEdgeAtPlayhead('end'));
    $('#resetTrim').addEventListener('click', () => {
        const clip = selected();
        if (!clip) return;
        clip.start = 0;
        clip.end = sourceOf(clip).clip.duration;
        wave.setSelection(clip.start, clip.end, false);
        wave.zoomToFit();
        clipChanged();
    });
    $('#duplicateClip').addEventListener('click', duplicateClip);
    $('#deleteClip').addEventListener('click', () => deleteClip());
    $('#downloadClip').addEventListener('click', downloadClip);

    $('#zoomIn').addEventListener('click', () => wave.zoomBy(2, editorPlayer.currentTime));
    $('#zoomOut').addEventListener('click', () => wave.zoomBy(0.5, editorPlayer.currentTime));
    $('#zoomFit').addEventListener('click', () => wave.zoomToFit());
    $('#zoomClip').addEventListener('click', () => {
        const clip = selected();
        if (clip) wave.zoomToRange(clip.start, clip.end);
    });

    els.clipName.addEventListener('input', () => {
        const clip = selected();
        if (!clip) return;
        clip.name = els.clipName.value.trim() || AL.baseName(sourceOf(clip).name);
        clearTimeout(structureTimer);
        structureTimer = setTimeout(() => {
            renderTimeline();
            renderList();
        }, 200);
    });

    [['fadeIn', els.fadeIn], ['fadeOut', els.fadeOut]].forEach(([key, input]) => {
        input.addEventListener('input', () => {
            const clip = selected();
            if (!clip) return;
            clip[key] = ui.readNumber(input, 0, 0, lengthOf(clip));
            invalidateMix();
        });
        input.addEventListener('change', () => {
            const clip = selected();
            if (clip) input.value = String(clip[key]);
        });
    });

    document.querySelectorAll('input[name="transition"]').forEach((input) => input.addEventListener('change', () => {
        invalidateMix();
        refreshProject();
    }));
    [els.transitionSeconds, els.sampleRate, els.channels, els.normalize].forEach((input) => {
        input.addEventListener('change', () => {
            invalidateMix();
            refreshProject();
        });
        input.addEventListener('input', refreshProject);
    });

    $('#exportJoined').addEventListener('click', exportJoined);
    $('#exportClips').addEventListener('click', exportClips);

    window.addEventListener('resize', () => positionPlayhead(mixPlayer.currentTime));

    ui.shortcuts({
        Space: togglePlay,
        c: playClip,
        p: toggleMix,
        l: toggleLoop,
        s: splitAtPlayhead,
        i: () => setEdgeAtPlayhead('start'),
        o: () => setEdgeAtPlayhead('end'),
        '[': () => stepSelection(-1),
        ']': () => stepSelection(1),
        Delete: () => deleteClip()
    });

    renderAll();
})();
