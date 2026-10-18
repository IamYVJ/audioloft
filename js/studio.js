// ============================================
// STUDIO - AudioLoft
// ============================================
//
// A small multitrack editor. The session is:
//
//   sources – decoded files, never modified
//   lanes   – tracks that play at the same time (volume, pan, mute, solo)
//   clips   – a range [start, end) of one source, placed on a lane at
//             timeline time `at`, with fades and a volume
//
// Trimming changes a clip's range, splitting turns one clip into two that
// share a source, and putting clips one after another on a lane joins them.
// Lanes are mixed by js/mixer.js, live and for export.
//
// Every edit goes through the undo history: discrete actions call
// checkpoint() first; continuous ones (drags, sliders, typing) bracket the
// gesture with beginEdit() / endEdit().

(function () {
    'use strict';

    const AL = window.AudioLoft;
    const ui = AL.ui;
    const MX = AL.mixer;
    const $ = ui.$;

    const MIN_CLIP = 0.01;
    const SNAP_PX = 8;
    const MIN_PPS = 2;
    const MAX_PPS = 2000;
    const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

    const session = { sources: new Map(), lanes: [], clips: [] };

    const state = {
        selectedId: null,
        nextId: 1,
        colorIndex: 0,
        pps: 60,
        snap: true,
        loop: false,
        history: [],
        future: [],
        baseline: null,
        drag: null
    };

    const mixer = new MX.LiveMixer(() => session);
    const preview = new AL.Player();

    const els = {
        dropStage: $('#dropStage'),
        studioStage: $('#studioStage'),
        mixPlay: $('#mixPlay'),
        mixTime: $('#mixTime'),
        mixTotal: $('#mixTotal'),
        heads: $('#laneHeads'),
        scroll: $('#mtScroll'),
        content: $('#mtContent'),
        undo: $('#undoButton'),
        redo: $('#redoButton'),
        snap: $('#snapButton'),
        clipEmpty: $('#clipEmpty'),
        clipBody: $('#clipBody'),
        clipSwatch: $('#clipSwatch'),
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
        clipGain: $('#clipGain'),
        clipAt: $('#clipAt'),
        clipLane: $('#clipLane'),
        arrangeLane: $('#arrangeLane'),
        transitionField: $('#transitionField'),
        transitionSeconds: $('#transitionSeconds'),
        transitionSecondsLabel: $('#transitionSecondsLabel'),
        sampleRate: $('#sampleRate'),
        channels: $('#channels'),
        fileName: $('#fileName'),
        format: $('#format'),
        preventClip: $('#preventClip'),
        normalize: $('#normalize'),
        outLength: $('#outLength')
    };

    // ---------- Model helpers ----------

    const clipById = (id) => session.clips.find((c) => c.id === id) || null;
    const laneById = (id) => session.lanes.find((l) => l.id === id) || null;
    const sourceOf = (clip) => session.sources.get(clip.sourceId);
    const lengthOf = (clip) => clip.end - clip.start;
    const endOf = (clip) => clip.at + lengthOf(clip);
    const selected = () => clipById(state.selectedId);

    function uniqueName(base) {
        const names = new Set(session.clips.map((c) => c.name));
        if (!names.has(base)) return base;
        const stem = base.replace(/ \(\d+\)$/, '');
        for (let n = 2; ; n++) {
            if (!names.has(`${stem} (${n})`)) return `${stem} (${n})`;
        }
    }

    function newLane(name) {
        const lane = {
            id: state.nextId++,
            name: name || `Lane ${session.lanes.length + 1}`,
            volume: 1,
            pan: 0,
            mute: false,
            solo: false,
            color: AL.SEGMENT_COLORS[state.colorIndex++ % AL.SEGMENT_COLORS.length]
        };
        session.lanes.push(lane);
        return lane;
    }

    function addSource(name, clip, size) {
        const source = { id: state.nextId++, name, size, clip };
        session.sources.set(source.id, source);
        return source;
    }

    function newClip(source, laneId, at, fields = {}) {
        const clip = Object.assign({
            id: state.nextId++,
            sourceId: source.id,
            laneId,
            at,
            start: 0,
            end: source.clip.duration,
            fadeIn: 0,
            fadeOut: 0,
            gain: 0,
            name: uniqueName(AL.baseName(source.name))
        }, fields);
        session.clips.push(clip);
        return clip;
    }

    // Clips in reading order: by time, then by lane.
    function orderedClips() {
        const laneIndex = new Map(session.lanes.map((l, i) => [l.id, i]));
        return session.clips.slice().sort((a, b) => a.at - b.at || laneIndex.get(a.laneId) - laneIndex.get(b.laneId));
    }

    // ---------- Undo ----------

    function snapshot() {
        return JSON.stringify({ lanes: session.lanes, clips: session.clips, selectedId: state.selectedId });
    }

    function pushHistory(entry) {
        state.history.push(entry);
        if (state.history.length > 150) state.history.shift();
        state.future = [];
        updateUndoButtons();
    }

    function checkpoint() {
        pushHistory(snapshot());
    }

    function beginEdit() {
        if (state.baseline === null) state.baseline = snapshot();
    }

    function endEdit() {
        if (state.baseline === null) return;
        const before = state.baseline;
        state.baseline = null;
        if (before !== snapshot()) pushHistory(before);
    }

    function restore(json) {
        const saved = JSON.parse(json);
        session.lanes = saved.lanes;
        session.clips = saved.clips;
        state.selectedId = clipById(saved.selectedId) ? saved.selectedId : null;
        renderAll();
        mixer.refresh();
    }

    function undo() {
        endEdit();
        if (!state.history.length) return;
        state.future.push(snapshot());
        restore(state.history.pop());
        updateUndoButtons();
        ui.announce('Undone');
    }

    function redo() {
        if (!state.future.length) return;
        state.history.push(snapshot());
        restore(state.future.pop());
        updateUndoButtons();
        ui.announce('Redone');
    }

    function updateUndoButtons() {
        els.undo.disabled = state.history.length === 0;
        els.redo.disabled = state.future.length === 0;
    }

    // Every change to the arrangement goes through here.
    let refreshTimer = 0;
    function changed({ timeline = true, editor = true, soon = false } = {}) {
        const run = () => {
            if (timeline) renderTimeline();
            if (editor) renderEditor();
            refreshTotals();
            mixer.refresh();
        };
        clearTimeout(refreshTimer);
        if (soon) refreshTimer = setTimeout(run, 120);
        else run();
    }

    // ---------- Adding audio ----------

    async function decodeAll(files) {
        const sources = [];
        await ui.withBusy('Decoding…', async (setLabel) => {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                await setLabel(files.length > 1 ? `Decoding ${i + 1} of ${files.length}…` : `Decoding “${file.name}”…`);
                try {
                    sources.push(addSource(file.name, await AL.decodeFile(file), file.size));
                } catch (error) {
                    ui.toast(error.message, 'error');
                }
            }
        });
        return sources;
    }

    // Without a target, each file gets a new lane starting at 0. Dropped on a
    // lane, files go there one after another from the drop point.
    async function addFiles(files, target) {
        const sources = await decodeAll(files);
        if (!sources.length) return;
        const first = session.lanes.length === 0;
        checkpoint();
        let at = target ? target.at : 0;
        const clips = sources.map((source) => {
            const laneId = target ? target.laneId : newLane(AL.baseName(source.name)).id;
            const clip = newClip(source, laneId, at);
            if (target) at = endOf(clip);
            return clip;
        });
        if (first && els.fileName.value === 'studio-mix') els.fileName.value = `${clips[0].name}-mix`;
        state.selectedId = clips[0].id;
        renderAll();
        if (first) fitTimeline();
        mixer.refresh();
        ui.announce(`${clips.length} track${clips.length === 1 ? '' : 's'} added.`);
    }

    function addDemo() {
        checkpoint();
        const melody = addSource('Melody.wav', AL.createDemoClip(0), 0);
        const bass = addSource('Bass.wav', synthBass(melody.clip.duration), 0);
        const shaker = addSource('Shaker.wav', synthShaker(melody.clip.duration), 0);
        const l1 = newLane('Melody');
        const l2 = newLane('Bass');
        const l3 = newLane('Shaker');
        l3.volume = 0.7;
        l3.pan = 0.3;
        newClip(melody, l1.id, 0);
        newClip(bass, l2.id, 0, { fadeIn: 0.5, fadeOut: 1 });
        newClip(shaker, l3.id, 2.0, { start: 2.0, fadeIn: 0.3 });
        state.selectedId = session.clips[0].id;
        els.fileName.value = 'demo-mix';
        renderAll();
        fitTimeline();
    }

    // Demo layers in the same key as the melody (C), so they sit together.
    function synthBass(duration) {
        const sr = 44100;
        const clip = AL.Clip.silent(2, Math.round(duration * sr), sr);
        const notes = [65.41, 65.41, 87.31, 98.0];
        const beat = 0.5;
        for (let k = 0; k * beat < duration; k++) {
            const f = notes[Math.floor(k / 4) % notes.length];
            const start = Math.round(k * beat * sr);
            const len = Math.round(beat * 0.95 * sr);
            for (let j = 0; j < len && start + j < clip.length; j++) {
                const t = j / sr;
                const env = Math.min(1, t / 0.008) * Math.exp(-t * 5);
                const v = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * env * 0.45;
                clip.channels[0][start + j] += v;
                clip.channels[1][start + j] += v;
            }
        }
        return clip;
    }

    function synthShaker(duration) {
        const sr = 44100;
        const clip = AL.Clip.silent(2, Math.round(duration * sr), sr);
        let seed = 7;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
        for (let k = 0; k * 0.25 < duration; k++) {
            const start = Math.round(k * 0.25 * sr);
            const accent = k % 2 === 0 ? 1 : 0.55;
            let prev = 0;
            for (let j = 0; j < 0.06 * sr && start + j < clip.length; j++) {
                const n = rand();
                const hp = n - prev; // crude high-pass for a brighter tick
                prev = n;
                const v = hp * Math.exp(-(j / sr) * 70) * 0.22 * accent;
                clip.channels[0][start + j] += v;
                clip.channels[1][start + j] += v * 0.8;
            }
        }
        return clip;
    }

    // ---------- Timeline geometry ----------

    function contentWidth() {
        const view = els.scroll.clientWidth || 600;
        const seconds = MX.sessionLength(session) + Math.max(20, (view / state.pps) * 0.5);
        return Math.max(view, Math.ceil(seconds * state.pps));
    }

    function timeAtClientX(clientX) {
        const rect = els.content.getBoundingClientRect();
        return Math.max(0, (clientX - rect.left) / state.pps);
    }

    function laneAtClientY(clientY) {
        const rows = els.content.querySelectorAll('.lane-row');
        for (const row of rows) {
            const r = row.getBoundingClientRect();
            if (clientY >= r.top && clientY < r.bottom) return Number(row.dataset.lane);
        }
        if (!rows.length) return null;
        const first = rows[0].getBoundingClientRect();
        return Number((clientY < first.top ? rows[0] : rows[rows.length - 1]).dataset.lane);
    }

    function tickStep() {
        return TICK_STEPS.find((s) => s * state.pps >= 80) || 3600;
    }

    function setZoom(pps, anchor) {
        pps = Math.max(MIN_PPS, Math.min(MAX_PPS, pps));
        const t = anchor === undefined ? mixer.currentTime : anchor;
        const anchorX = t * state.pps - els.scroll.scrollLeft;
        state.pps = pps;
        renderTimeline();
        els.scroll.scrollLeft = Math.max(0, t * pps - anchorX);
        drawRuler();
    }

    function fitTimeline() {
        const length = Math.max(5, MX.sessionLength(session));
        state.pps = Math.max(MIN_PPS, Math.min(MAX_PPS, ((els.scroll.clientWidth || 600) - 24) / length));
        renderTimeline();
        els.scroll.scrollLeft = 0;
        drawRuler();
    }

    // ---------- Rendering ----------

    function renderAll() {
        const empty = session.lanes.length === 0;
        els.dropStage.hidden = !empty;
        els.studioStage.hidden = empty;
        if (empty) {
            mixer.stop();
            preview.stop();
        }
        renderTimeline();
        renderLaneOptions();
        renderEditor();
        refreshTotals();
        updateUndoButtons();
    }

    function renderTimeline() {
        renderHeads();
        renderLanes();
        drawRuler();
        positionPlayhead();
    }

    function renderHeads() {
        els.heads.innerHTML = '';
        els.heads.appendChild(ui.el('div', { class: 'mt-corner', text: 'Lanes' }));
        session.lanes.forEach((lane) => els.heads.appendChild(laneHead(lane)));
        els.heads.appendChild(ui.el('div', { class: 'mt-add-lane' }, [
            ui.el('button', {
                type: 'button',
                class: 'btn btn-sm btn-ghost',
                html: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> Add lane',
                onclick: () => {
                    checkpoint();
                    newLane();
                    renderAll();
                }
            })
        ]));
    }

    function laneHead(lane) {
        const volOut = ui.el('output', { text: `${Math.round(lane.volume * 100)}%` });
        const panOut = ui.el('output', { text: panLabel(lane.pan) });

        const name = ui.el('input', {
            class: 'lane-name',
            value: lane.name,
            'aria-label': 'Lane name',
            spellcheck: 'false',
            autocomplete: 'off'
        });
        name.addEventListener('focus', beginEdit);
        name.addEventListener('input', () => {
            lane.name = name.value.trim() || 'Lane';
            renderLaneOptions();
        });
        name.addEventListener('change', endEdit);
        name.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') name.blur();
        });

        const toggle = (cls, label, key, title) => ui.el('button', {
            type: 'button',
            class: `lane-toggle ${cls}`,
            text: label,
            title,
            'aria-label': `${title} ${lane.name}`,
            'aria-pressed': String(lane[key]),
            onclick: (e) => {
                checkpoint();
                lane[key] = !lane[key];
                e.currentTarget.setAttribute('aria-pressed', String(lane[key]));
                refreshLaneStates();
                mixer.updateLanes();
            }
        });

        const slider = (label, out, min, max, value, apply) => {
            const input = ui.el('input', {
                type: 'range',
                class: 'mini-range',
                min: String(min),
                max: String(max),
                step: '1',
                value: String(value),
                'aria-label': `${label} for ${lane.name}`
            });
            input.addEventListener('pointerdown', beginEdit);
            input.addEventListener('focus', beginEdit);
            input.addEventListener('input', () => {
                apply(Number(input.value));
                mixer.updateLanes();
            });
            input.addEventListener('change', endEdit);
            // Double-click returns the control to its default.
            input.addEventListener('dblclick', () => {
                beginEdit();
                input.value = label === 'Volume' ? '100' : '0';
                apply(Number(input.value));
                mixer.updateLanes();
                endEdit();
            });
            return ui.el('label', {}, [ui.el('span', {}, [`${label === 'Volume' ? 'VOL' : 'PAN'} `, out]), input]);
        };

        const head = ui.el('div', { class: 'lane-head', 'data-lane': String(lane.id) }, [
            ui.el('div', { class: 'lane-title' }, [
                name,
                toggle('mute', 'M', 'mute', 'Mute'),
                toggle('solo', 'S', 'solo', 'Solo'),
                ui.el('button', {
                    type: 'button',
                    class: 'lane-toggle del',
                    html: '&times;',
                    title: 'Delete lane',
                    'aria-label': `Delete lane ${lane.name}`,
                    onclick: () => deleteLane(lane.id)
                })
            ]),
            ui.el('div', { class: 'lane-mix' }, [
                slider('Volume', volOut, 0, 150, Math.round(lane.volume * 100), (v) => {
                    lane.volume = v / 100;
                    volOut.textContent = `${v}%`;
                }),
                slider('Pan', panOut, -100, 100, Math.round(lane.pan * 100), (v) => {
                    lane.pan = v / 100;
                    panOut.textContent = panLabel(lane.pan);
                })
            ])
        ]);
        head.style.setProperty('--swatch', lane.color);
        return head;
    }

    function panLabel(pan) {
        const v = Math.round(pan * 100);
        return v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`;
    }

    function refreshLaneStates() {
        const audible = MX.audibleLanes(session.lanes);
        els.content.querySelectorAll('.lane-row').forEach((row) => {
            row.classList.toggle('is-muted', !audible.has(Number(row.dataset.lane)));
        });
    }

    function renderLanes() {
        const content = els.content;
        content.innerHTML = '';
        content.style.width = `${contentWidth()}px`;
        content.style.setProperty('--grid', `${tickStep() * state.pps}px`);

        const ruler = ui.el('canvas', { class: 'mt-ruler', 'aria-hidden': 'true' });
        content.appendChild(ruler);

        session.lanes.forEach((lane) => {
            const row = ui.el('div', { class: 'lane-row', 'data-lane': String(lane.id) });
            row.style.setProperty('--swatch', lane.color);
            bindFileDrop(row, lane);
            session.clips
                .filter((clip) => clip.laneId === lane.id)
                .forEach((clip) => row.appendChild(clipElement(clip, lane)));
            content.appendChild(row);
        });
        content.appendChild(ui.el('div', { class: 'lane-spacer' }));
        content.appendChild(ui.el('div', { class: 'mt-playhead', id: 'mtPlayhead' }));
        refreshLaneStates();

        requestAnimationFrame(() => {
            content.querySelectorAll('.mt-clip').forEach((node) => drawClip(node));
        });
    }

    function clipElement(clip, lane) {
        const node = ui.el('div', {
            class: `mt-clip${clip.id === state.selectedId ? ' is-selected' : ''}`,
            'data-id': String(clip.id),
            tabindex: '0',
            role: 'button',
            'aria-label': `${clip.name}, ${lane.name}, starts at ${AL.formatTime(clip.at, 1)}, ${AL.formatTime(lengthOf(clip), 1)} long`
        }, [
            ui.el('span', { class: 'mt-fade in' }),
            ui.el('span', { class: 'mt-fade out' }),
            ui.el('span', { class: 'mt-clip-label', text: clip.name }),
            ui.el('canvas', { 'aria-hidden': 'true' }),
            ui.el('span', { class: 'mt-handle l', title: 'Drag to trim the start' }),
            ui.el('span', { class: 'mt-handle r', title: 'Drag to trim the end' })
        ]);
        node.style.setProperty('--swatch', lane.color);
        placeClip(node, clip);
        return node;
    }

    function placeClip(node, clip) {
        node.style.left = `${clip.at * state.pps}px`;
        node.style.width = `${Math.max(6, lengthOf(clip) * state.pps)}px`;
        const fades = node.querySelectorAll('.mt-fade');
        const scale = (s) => `${Math.min(lengthOf(clip), Math.max(0, s)) * state.pps}px`;
        fades[0].style.width = scale(clip.fadeIn);
        fades[1].style.width = scale(clip.fadeOut);
    }

    function drawClip(node) {
        const clip = clipById(Number(node.dataset.id));
        if (!clip) return;
        const lane = laneById(clip.laneId);
        AL.drawMiniWave(node.querySelector('canvas'), sourceOf(clip).clip, lane ? lane.color : '#ffb547', clip.start, clip.end);
    }

    function drawRuler() {
        const ruler = els.content.querySelector('.mt-ruler');
        if (!ruler) return;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const width = els.scroll.clientWidth || 600;
        const height = 30;
        ruler.style.width = `${width}px`;
        ruler.width = Math.round(width * dpr);
        ruler.height = Math.round(height * dpr);
        const ctx = ruler.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const scrollLeft = els.scroll.scrollLeft;
        const step = tickStep();
        const minor = step / 5;
        const t0 = scrollLeft / state.pps;
        const t1 = (scrollLeft + width) / state.pps;
        const precision = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;

        ctx.fillStyle = '#3a3530';
        for (let t = Math.ceil(t0 / minor) * minor; t <= t1; t += minor) {
            ctx.fillRect(Math.round(t * state.pps - scrollLeft), height - 5, 1, 5);
        }
        ctx.font = '500 10.5px ui-monospace, Consolas, monospace';
        ctx.textBaseline = 'middle';
        for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) {
            const x = Math.round(t * state.pps - scrollLeft);
            ctx.fillStyle = '#5a534c';
            ctx.fillRect(x, height - 11, 1, 11);
            ctx.fillStyle = '#8a8178';
            ctx.fillText(AL.formatTime(t, precision), x + 4, 11);
        }
    }

    function positionPlayhead() {
        const head = $('#mtPlayhead');
        if (head) head.style.left = `${mixer.currentTime * state.pps}px`;
    }

    function renderLaneOptions() {
        [els.clipLane, els.arrangeLane].forEach((select) => {
            const current = select.value;
            select.innerHTML = '';
            session.lanes.forEach((lane) => {
                select.appendChild(ui.el('option', { value: String(lane.id), text: lane.name }));
            });
            if (laneById(Number(current))) select.value = current;
        });
        const clip = selected();
        if (clip) els.clipLane.value = String(clip.laneId);
    }

    function refreshTotals() {
        const length = MX.sessionLength(session);
        els.mixTotal.textContent = AL.formatTime(length);
        els.outLength.textContent = AL.formatTime(length);
        const none = session.clips.length === 0;
        ['#exportMix', '#exportStems', '#exportClips', '#lineUp', '#mergeLanes'].forEach((sel) => { $(sel).disabled = none; });
        els.transitionField.hidden = transition().kind === 'none';
        els.transitionSecondsLabel.textContent = transition().kind === 'gap' ? 'Gap length (s)' : 'Crossfade length (s)';
    }

    function markSelection() {
        els.content.querySelectorAll('.mt-clip').forEach((node) => {
            node.classList.toggle('is-selected', Number(node.dataset.id) === state.selectedId);
        });
    }

    // ---------- Timeline interaction ----------

    function snapTargets(excludeId) {
        const targets = [0, mixer.currentTime];
        session.clips.forEach((clip) => {
            if (clip.id === excludeId) return;
            targets.push(clip.at, endOf(clip));
        });
        return targets;
    }

    // Returns the snapped value for whichever of `edges` lands nearest a
    // target, as an offset to add to all of them.
    function snapOffset(edges, excludeId, disabled) {
        if (!state.snap || disabled) return { offset: 0, at: null };
        const tolerance = SNAP_PX / state.pps;
        let best = null;
        for (const target of snapTargets(excludeId)) {
            for (const edge of edges) {
                const d = target - edge;
                if (Math.abs(d) <= tolerance && (!best || Math.abs(d) < Math.abs(best.offset))) {
                    best = { offset: d, at: target };
                }
            }
        }
        return best || { offset: 0, at: null };
    }

    function showSnap(at) {
        let line = els.content.querySelector('.mt-snapline');
        if (at === null) {
            if (line) line.remove();
            return;
        }
        if (!line) {
            line = ui.el('div', { class: 'mt-snapline' });
            els.content.appendChild(line);
        }
        line.style.left = `${at * state.pps}px`;
    }

    function onPointerDown(e) {
        if (e.button > 0) return;
        const clipNode = e.target.closest('.mt-clip');
        const handle = e.target.closest('.mt-handle');

        if (clipNode) {
            const clip = clipById(Number(clipNode.dataset.id));
            if (!clip) return;
            if (state.selectedId !== clip.id) selectClip(clip.id);
            beginEdit();
            state.drag = {
                mode: handle ? (handle.classList.contains('l') ? 'trim-l' : 'trim-r') : 'move',
                clip,
                node: clipNode,
                x0: e.clientX,
                y0: e.clientY,
                orig: Object.assign({}, clip),
                moved: false
            };
            clipNode.classList.add('is-dragging');
        } else if (e.target.closest('.mt-ruler, .lane-row')) {
            state.drag = { mode: 'scrub' };
            mixer.seek(timeAtClientX(e.clientX));
            paintMix();
        } else {
            return;
        }
        try {
            els.content.setPointerCapture(e.pointerId);
        } catch (error) {
            /* Pointer already gone. */
        }
        e.preventDefault();
    }

    function onPointerMove(e) {
        const drag = state.drag;
        if (!drag) return;

        if (drag.mode === 'scrub') {
            mixer.seek(timeAtClientX(e.clientX));
            paintMix();
            return;
        }

        const dxPx = e.clientX - drag.x0;
        if (!drag.moved && Math.abs(dxPx) < 3 && Math.abs(e.clientY - drag.y0) < 3) return;
        drag.moved = true;
        const dt = dxPx / state.pps;
        const { clip, orig } = drag;
        const len = orig.end - orig.start;
        const sourceLength = sourceOf(clip).clip.duration;

        if (drag.mode === 'move') {
            let at = Math.max(0, orig.at + dt);
            const snap = snapOffset([at, at + len], clip.id, e.altKey);
            at = Math.max(0, at + snap.offset);
            showSnap(snap.at);
            clip.at = at;
            const laneId = laneAtClientY(e.clientY);
            if (laneId && laneId !== clip.laneId) {
                clip.laneId = laneId;
                const row = els.content.querySelector(`.lane-row[data-lane="${laneId}"]`);
                row.appendChild(drag.node);
                drag.node.style.setProperty('--swatch', laneById(laneId).color);
            }
        } else if (drag.mode === 'trim-l') {
            let at = orig.at + dt;
            const snap = snapOffset([at], clip.id, e.altKey);
            at += snap.offset;
            showSnap(snap.at);
            let start = orig.start + (at - orig.at);
            start = Math.max(0, Math.max(orig.start - orig.at, Math.min(start, orig.end - MIN_CLIP)));
            clip.start = start;
            clip.at = orig.at + (start - orig.start);
        } else if (drag.mode === 'trim-r') {
            let end = orig.at + len + dt;
            const snap = snapOffset([end], clip.id, e.altKey);
            end += snap.offset;
            showSnap(snap.at);
            clip.end = Math.min(sourceLength, Math.max(orig.start + MIN_CLIP, orig.start + (end - orig.at)));
        }
        placeClip(drag.node, clip);
        renderEditorFields();
    }

    function onPointerUp() {
        const drag = state.drag;
        state.drag = null;
        showSnap(null);
        if (!drag || drag.mode === 'scrub') return;
        drag.node.classList.remove('is-dragging');
        endEdit();
        if (drag.moved) changed();
    }

    function onTimelineKey(e) {
        const node = e.target.closest && e.target.closest('.mt-clip');
        if (!node) return;
        const clip = clipById(Number(node.dataset.id));
        if (!clip) return;
        let handled = true;
        const step = e.shiftKey ? 1 : 0.1;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            checkpoint();
            clip.at = Math.max(0, clip.at + (e.key === 'ArrowLeft' ? -step : step));
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const i = session.lanes.findIndex((l) => l.id === clip.laneId) + (e.key === 'ArrowUp' ? -1 : 1);
            if (!session.lanes[i]) return;
            checkpoint();
            clip.laneId = session.lanes[i].id;
        } else if (e.key === 'Enter') {
            selectClip(clip.id);
            return;
        } else {
            handled = false;
        }
        if (!handled) return;
        e.preventDefault();
        e.stopPropagation();
        state.selectedId = clip.id;
        changed();
        const again = els.content.querySelector(`.mt-clip[data-id="${clip.id}"]`);
        if (again) again.focus();
    }

    function bindFileDrop(row, lane) {
        const isFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
        row.addEventListener('dragover', (e) => {
            if (!isFiles(e)) return;
            e.preventDefault();
            row.classList.add('is-target');
        });
        row.addEventListener('dragleave', () => row.classList.remove('is-target'));
        row.addEventListener('drop', (e) => {
            if (!isFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove('is-target');
            const files = Array.from(e.dataTransfer.files).filter(ui.isAudioFile);
            if (files.length) addFiles(files, { laneId: lane.id, at: timeAtClientX(e.clientX) });
        });
    }

    // ---------- Clip actions ----------

    function selectClip(id) {
        state.selectedId = id;
        markSelection();
        renderEditor();
    }

    function stepSelection(delta) {
        const list = orderedClips();
        if (!list.length) return;
        const i = list.findIndex((c) => c.id === state.selectedId);
        const next = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta))];
        selectClip(next.id);
        const node = els.content.querySelector(`.mt-clip[data-id="${next.id}"]`);
        if (node) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // `sourceTime` is a position in the clip's source file.
    function splitClip(clip, sourceTime, quiet) {
        if (sourceTime <= clip.start + MIN_CLIP || sourceTime >= clip.end - MIN_CLIP) return null;
        const right = Object.assign({}, clip, {
            id: state.nextId++,
            start: sourceTime,
            at: clip.at + (sourceTime - clip.start),
            fadeIn: 0,
            name: uniqueName(clip.name)
        });
        clip.end = sourceTime;
        clip.fadeOut = 0;
        session.clips.splice(session.clips.indexOf(clip) + 1, 0, right);
        if (!quiet) ui.toast(`Split “${clip.name}” in two`, 'success');
        return right;
    }

    // Splits the selected clip at the timeline playhead, or, if it isn't
    // under the playhead, every clip that is.
    function splitAtTimeline() {
        const t = mixer.currentTime;
        const spans = (c) => t > c.at + MIN_CLIP && t < endOf(c) - MIN_CLIP;
        const sel = selected();
        const targets = sel && spans(sel) ? [sel] : session.clips.filter(spans);
        if (!targets.length) {
            ui.toast('Move the playhead over a clip first, then split.');
            return;
        }
        checkpoint();
        targets.forEach((clip) => splitClip(clip, clip.start + (t - clip.at), true));
        ui.toast(targets.length === 1 ? `Split “${targets[0].name}” in two` : `Split ${targets.length} clips at the playhead`, 'success');
        changed();
    }

    function splitAtPreview() {
        const clip = selected();
        if (!clip) return;
        const t = preview.currentTime;
        if (t <= clip.start + MIN_CLIP || t >= clip.end - MIN_CLIP) {
            ui.toast('Move the preview playhead inside the bright part first, then split.');
            return;
        }
        checkpoint();
        splitClip(clip, t);
        changed();
    }

    function duplicateClip() {
        const clip = selected();
        if (!clip) return;
        checkpoint();
        const copy = Object.assign({}, clip, { id: state.nextId++, at: endOf(clip), name: uniqueName(clip.name) });
        session.clips.push(copy);
        state.selectedId = copy.id;
        changed();
        ui.announce(`Duplicated as ${copy.name}`);
    }

    function deleteClip() {
        const clip = selected();
        if (!clip) return;
        checkpoint();
        const sameLane = orderedClips().filter((c) => c.laneId === clip.laneId);
        const next = sameLane[sameLane.indexOf(clip) + 1] || sameLane[sameLane.indexOf(clip) - 1] || null;
        session.clips.splice(session.clips.indexOf(clip), 1);
        state.selectedId = next ? next.id : null;
        changed();
        ui.announce(`Deleted ${clip.name}. Ctrl+Z to undo.`);
    }

    function deleteLane(id) {
        const lane = laneById(id);
        if (!lane) return;
        checkpoint();
        session.lanes = session.lanes.filter((l) => l.id !== id);
        session.clips = session.clips.filter((c) => c.laneId !== id);
        if (!selected()) state.selectedId = null;
        renderAll();
        mixer.refresh();
        ui.toast(`Deleted lane “${lane.name}”. Ctrl+Z brings it back.`);
    }

    // ---------- Line up ----------

    function transition() {
        const kind = document.querySelector('input[name="transition"]:checked').value;
        const seconds = ui.readNumber(els.transitionSeconds, 1, 0, 30);
        return { kind, gap: kind === 'gap' ? seconds : 0, crossfade: kind === 'crossfade' ? seconds : 0 };
    }

    function lineUp(laneId, clips) {
        const t = transition();
        const list = clips || orderedClips().filter((c) => c.laneId === laneId);
        if (!list.length) return 0;
        let pos = list[0].at;
        list.forEach((clip, i) => {
            if (i > 0 && t.crossfade) {
                const xf = Math.min(t.crossfade, lengthOf(clip), lengthOf(list[i - 1]));
                pos -= xf;
                clip.fadeIn = xf;
                list[i - 1].fadeOut = xf;
            }
            clip.laneId = laneId;
            clip.at = Math.max(0, pos);
            pos = endOf(clip) + t.gap;
        });
        return list.length;
    }

    // ---------- Editor (source preview) ----------

    const wave = new AL.Waveform($('#waveform'), {
        mode: 'range',
        height: 170,
        onseek: (t) => {
            mixer.pause();
            preview.seek(t);
            previewPlayback.paint();
        },
        onselect: (sel) => {
            const clip = selected();
            if (!clip || !sel || sel.end - sel.start < MIN_CLIP) return;
            if (preview.playing && preview.isRange) preview.stop();
            // Keep the audio where it is on the timeline: moving the start
            // later shifts the clip later by the same amount.
            clip.at = Math.max(0, clip.at + (sel.start - clip.start));
            clip.start = sel.start;
            clip.end = sel.end;
            renderEditorFields();
            changed({ editor: false, soon: true });
        }
    });

    // The waveform reports a whole drag as many selections; record it as one
    // undo step.
    $('#waveform').addEventListener('pointerdown', beginEdit, true);
    window.addEventListener('pointerup', () => {
        if (!state.drag) endEdit();
    });

    const previewPlayback = ui.bindPlayback({
        player: preview,
        waveform: wave,
        playButton: els.play,
        timeEl: els.timeNow
    });

    function renderEditor() {
        const clip = selected();
        els.clipEmpty.hidden = Boolean(clip);
        els.clipBody.hidden = !clip;
        markSelection();
        if (!clip) return;

        const source = sourceOf(clip);
        const lane = laneById(clip.laneId);
        if (wave.clip !== source.clip) {
            preview.setClip(source.clip);
            wave.setClip(source.clip);
            els.timeTotal.textContent = AL.formatTime(source.clip.duration);
        }
        wave.setSelection(clip.start, clip.end, false);
        if (lengthOf(clip) < source.clip.duration * 0.9) wave.zoomToRange(clip.start, clip.end);
        else wave.zoomToFit();
        if (!preview.playing) {
            preview.position = clip.start;
            wave.setPlayhead(clip.start);
            els.timeNow.textContent = AL.formatTime(clip.start);
        }
        els.clipSwatch.style.setProperty('--swatch', lane ? lane.color : '#ffb547');
        els.clipSource.textContent = `from ${source.name} · on ${lane ? lane.name : '—'}`;
        renderEditorFields();
    }

    function renderEditorFields() {
        const clip = selected();
        if (!clip) return;
        if (document.activeElement !== els.clipName) els.clipName.value = clip.name;
        startField.refresh();
        endField.refresh();
        atField.refresh();
        els.clipLength.textContent = AL.formatTime(lengthOf(clip));
        if (document.activeElement !== els.fadeIn) els.fadeIn.value = String(+clip.fadeIn.toFixed(3));
        if (document.activeElement !== els.fadeOut) els.fadeOut.value = String(+clip.fadeOut.toFixed(3));
        if (document.activeElement !== els.clipGain) els.clipGain.value = String(clip.gain);
        els.clipLane.value = String(clip.laneId);
        if (wave.selection && (Math.abs(wave.selection.start - clip.start) > 1e-6 || Math.abs(wave.selection.end - clip.end) > 1e-6)) {
            wave.setSelection(clip.start, clip.end, false);
        }
    }

    const startField = ui.timeField(els.clipStart, {
        get: () => (selected() ? selected().start : 0),
        set: (t) => {
            const clip = selected();
            if (!clip) return;
            checkpoint();
            const start = Math.max(0, Math.min(t, clip.end - MIN_CLIP));
            clip.at = Math.max(0, clip.at + (start - clip.start));
            clip.start = start;
            changed();
        }
    });

    const endField = ui.timeField(els.clipEnd, {
        get: () => (selected() ? selected().end : 0),
        set: (t) => {
            const clip = selected();
            if (!clip) return;
            checkpoint();
            clip.end = Math.min(sourceOf(clip).clip.duration, Math.max(t, clip.start + MIN_CLIP));
            changed();
        }
    });

    const atField = ui.timeField(els.clipAt, {
        get: () => (selected() ? selected().at : 0),
        set: (t) => {
            const clip = selected();
            if (!clip) return;
            checkpoint();
            clip.at = Math.max(0, t);
            changed();
        }
    });

    function setEdgeAtPreview(edge) {
        const clip = selected();
        if (!clip) return;
        const t = preview.currentTime;
        if (edge === 'start' ? t >= clip.end - MIN_CLIP : t <= clip.start + MIN_CLIP) {
            ui.toast(edge === 'start' ? 'The start has to be before the end.' : 'The end has to be after the start.');
            return;
        }
        checkpoint();
        if (edge === 'start') {
            clip.at = Math.max(0, clip.at + (t - clip.start));
            clip.start = t;
        } else {
            clip.end = t;
        }
        changed();
    }

    function togglePreview() {
        const clip = selected();
        if (!clip) return;
        mixer.pause();
        if (preview.playing) {
            preview.pause();
        } else {
            const duration = sourceOf(clip).clip.duration;
            preview.play(preview.position >= duration - 0.01 ? 0 : preview.position, duration);
        }
    }

    function playClipAlone() {
        const clip = selected();
        if (!clip) return;
        mixer.pause();
        preview.play(clip.start, clip.end, { range: true, loop: state.loop });
    }

    function toggleLoop() {
        state.loop = !state.loop;
        els.loop.setAttribute('aria-pressed', String(state.loop));
        if (preview.playing && preview.isRange) playClipAlone();
    }

    // ---------- Mix transport ----------

    let mixFrame = 0;

    function paintMix() {
        const t = mixer.currentTime;
        els.mixTime.textContent = AL.formatTime(t);
        positionPlayhead();
        if (mixer.playing) {
            const x = t * state.pps;
            const view = els.scroll;
            if (x > view.scrollLeft + view.clientWidth - 40 || x < view.scrollLeft) {
                view.scrollLeft = Math.max(0, x - 40);
            }
        }
    }

    function mixLoop() {
        mixer.tick();
        paintMix();
        mixFrame = mixer.playing ? requestAnimationFrame(mixLoop) : 0;
    }

    mixer.onChange(() => {
        els.mixPlay.innerHTML = mixer.playing ? ui.ICONS.pause : ui.ICONS.play;
        els.mixPlay.setAttribute('aria-label', mixer.playing ? 'Pause' : 'Play');
        if (mixer.playing && !mixFrame) mixFrame = requestAnimationFrame(mixLoop);
        paintMix();
    });

    function toggleMix() {
        if (!session.clips.length) return;
        preview.stop();
        if (mixer.playing) mixer.pause();
        else mixer.play();
    }

    // ---------- Export ----------

    function exportRate() {
        if (els.sampleRate.value !== 'auto') return Number(els.sampleRate.value);
        const used = new Set(session.clips.map((c) => c.sourceId));
        return Math.max(44100, ...[...used].map((id) => session.sources.get(id).clip.sampleRate));
    }

    function finish(clip, { normalize }) {
        let out = Number(els.channels.value) === 1 ? AL.remix(clip, 1) : clip;
        if (normalize) {
            AL.normalize(out, -1);
        } else if (els.preventClip.checked && AL.peakOf(out) > 1) {
            AL.normalize(out, -0.1);
        }
        return out;
    }

    function renderPiece(clip) {
        const piece = AL.slice(sourceOf(clip).clip, clip.start, clip.end);
        AL.applyFades(piece, clip.fadeIn, clip.fadeOut);
        AL.applyGain(piece, clip.gain);
        return piece;
    }

    async function exportMix() {
        const audible = MX.audibleLanes(session.lanes);
        if (!session.clips.some((c) => audible.has(c.laneId))) {
            ui.toast('Every lane with clips is muted, so the mix would be silent.', 'error');
            return;
        }
        const format = els.format.value;
        const name = AL.withExtension(els.fileName.value.trim() || 'studio-mix', AL.extensionFor(format));
        try {
            await ui.withBusy('Mixing…', async (setLabel) => {
                const mix = finish(await MX.render(session, { sampleRate: exportRate() }), { normalize: els.normalize.checked });
                AL.downloadBlob(await AL.encodeWithLabel(mix, format, setLabel), name);
            });
            ui.toast(`Saved ${name}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    async function exportStems() {
        const lanes = session.lanes.filter((lane) => session.clips.some((c) => c.laneId === lane.id));
        const base = AL.safeFileName(els.fileName.value.trim() || 'studio');
        const zipName = `${base}-stems.zip`;
        const format = els.format.value;
        const ext = AL.extensionFor(format);
        try {
            await ui.withBusy('Mixing stems…', async (setLabel) => {
                const entries = [];
                const used = new Set();
                for (let i = 0; i < lanes.length; i++) {
                    const lane = lanes[i];
                    await setLabel(`Rendering lane ${i + 1} of ${lanes.length}…`);
                    // Stems all span the full session so they line up when
                    // imported elsewhere. Mute / solo are ignored here.
                    const stem = finish(await MX.render(session, {
                        sampleRate: exportRate(),
                        include: (l) => l.id === lane.id,
                        respectMuteSolo: false
                    }), { normalize: false });
                    let name = AL.withExtension(`${String(i + 1).padStart(2, '0')} ${lane.name}`, ext);
                    for (let n = 2; used.has(name.toLowerCase()); n++) name = AL.withExtension(`${i + 1} ${lane.name} (${n})`, ext);
                    used.add(name.toLowerCase());
                    entries.push({ name, blob: await AL.encodeWithLabel(stem, format, setLabel, `Lane ${i + 1} of ${lanes.length}: encoding`) });
                }
                await setLabel('Packing ZIP…');
                AL.downloadBlob(await AL.makeZip(entries), zipName);
            });
            ui.toast(`Saved ${zipName}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    async function exportClips() {
        const list = orderedClips();
        const zipName = `${AL.safeFileName(els.fileName.value.trim() || 'studio')}-clips.zip`;
        const format = els.format.value;
        const ext = AL.extensionFor(format);
        try {
            await ui.withBusy('Preparing clips…', async (setLabel) => {
                const entries = [];
                const used = new Set();
                for (let i = 0; i < list.length; i++) {
                    await setLabel(`Encoding clip ${i + 1} of ${list.length}…`);
                    const base = `${String(i + 1).padStart(2, '0')} ${list[i].name}`;
                    let name = AL.withExtension(base, ext);
                    for (let n = 2; used.has(name.toLowerCase()); n++) name = AL.withExtension(`${base} (${n})`, ext);
                    used.add(name.toLowerCase());
                    entries.push({ name, blob: await AL.encodeWithLabel(renderPiece(list[i]), format, setLabel, `Clip ${i + 1} of ${list.length}: encoding`) });
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
        const format = els.format.value;
        const name = AL.withExtension(clip.name, AL.extensionFor(format));
        try {
            await ui.withBusy('Preparing…', async (setLabel) => {
                AL.downloadBlob(await AL.encodeWithLabel(renderPiece(clip), format, setLabel), name);
            });
            ui.toast(`Saved ${name}`, 'success');
        } catch (error) {
            ui.toast(error.message || 'Export failed.', 'error');
        }
    }

    // ---------- Wiring ----------

    const addDz = ui.dropzone($('#addZone'), { multiple: true, onFiles: (files) => addFiles(files) });
    ui.dropzone($('#dropzone'), { multiple: true, onFiles: (files) => addFiles(files) });
    ui.guardPageDrops((files) => addFiles(files));

    $('#demoButton').addEventListener('click', addDemo);
    $('#addFilesButton').addEventListener('click', () => addDz.open());

    els.mixPlay.innerHTML = ui.ICONS.play;
    els.mixPlay.addEventListener('click', toggleMix);
    $('#rewind').addEventListener('click', () => {
        mixer.seek(0);
        els.scroll.scrollLeft = 0;
        paintMix();
    });
    $('#splitTimeline').addEventListener('click', splitAtTimeline);
    els.undo.addEventListener('click', undo);
    els.redo.addEventListener('click', redo);
    els.snap.addEventListener('click', () => {
        state.snap = !state.snap;
        els.snap.setAttribute('aria-pressed', String(state.snap));
    });
    $('#tlZoomIn').addEventListener('click', () => setZoom(state.pps * 1.6));
    $('#tlZoomOut').addEventListener('click', () => setZoom(state.pps / 1.6));
    $('#tlFit').addEventListener('click', fitTimeline);

    els.content.addEventListener('pointerdown', onPointerDown);
    els.content.addEventListener('pointermove', onPointerMove);
    els.content.addEventListener('pointerup', onPointerUp);
    els.content.addEventListener('pointercancel', onPointerUp);
    els.content.addEventListener('keydown', onTimelineKey);
    els.scroll.addEventListener('scroll', drawRuler);
    els.scroll.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        setZoom(state.pps * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), timeAtClientX(e.clientX));
    }, { passive: false });
    new ResizeObserver(() => {
        if (!els.studioStage.hidden) {
            els.content.style.width = `${contentWidth()}px`;
            drawRuler();
        }
    }).observe(els.scroll);

    // Editor
    els.play.innerHTML = ui.ICONS.play;
    els.play.addEventListener('click', togglePreview);
    $('#playClip').addEventListener('click', playClipAlone);
    els.loop.addEventListener('click', toggleLoop);
    $('#splitHere').addEventListener('click', splitAtPreview);
    $('#setStart').addEventListener('click', () => setEdgeAtPreview('start'));
    $('#setEnd').addEventListener('click', () => setEdgeAtPreview('end'));
    $('#resetTrim').addEventListener('click', () => {
        const clip = selected();
        if (!clip) return;
        checkpoint();
        clip.at = Math.max(0, clip.at - clip.start);
        clip.start = 0;
        clip.end = sourceOf(clip).clip.duration;
        changed();
    });
    $('#duplicateClip').addEventListener('click', duplicateClip);
    $('#deleteClip').addEventListener('click', deleteClip);
    $('#downloadClip').addEventListener('click', downloadClip);
    $('#atPlayhead').addEventListener('click', () => {
        const clip = selected();
        if (!clip) return;
        checkpoint();
        clip.at = mixer.currentTime;
        changed();
    });
    els.clipLane.addEventListener('change', () => {
        const clip = selected();
        if (!clip) return;
        checkpoint();
        clip.laneId = Number(els.clipLane.value);
        changed();
    });
    $('#zoomIn').addEventListener('click', () => wave.zoomBy(2, preview.currentTime));
    $('#zoomOut').addEventListener('click', () => wave.zoomBy(0.5, preview.currentTime));
    $('#zoomFit').addEventListener('click', () => wave.zoomToFit());
    $('#zoomClip').addEventListener('click', () => {
        const clip = selected();
        if (clip) wave.zoomToRange(clip.start, clip.end);
    });

    els.clipName.addEventListener('focus', beginEdit);
    els.clipName.addEventListener('input', () => {
        const clip = selected();
        if (!clip) return;
        clip.name = els.clipName.value.trim() || AL.baseName(sourceOf(clip).name);
        changed({ editor: false, soon: true });
    });
    els.clipName.addEventListener('change', endEdit);

    [['fadeIn', els.fadeIn, 0, Infinity], ['fadeOut', els.fadeOut, 0, Infinity], ['gain', els.clipGain, -60, 24]].forEach(([key, input, min, max]) => {
        input.addEventListener('focus', beginEdit);
        input.addEventListener('input', () => {
            const clip = selected();
            if (!clip) return;
            const limit = key === 'gain' ? max : lengthOf(clip);
            clip[key] = ui.readNumber(input, 0, min, limit);
            changed({ editor: false, soon: true });
        });
        input.addEventListener('change', () => {
            endEdit();
            renderEditorFields();
        });
    });

    // Line up / export
    document.querySelectorAll('input[name="transition"]').forEach((input) => input.addEventListener('change', refreshTotals));
    $('#lineUp').addEventListener('click', () => {
        const laneId = Number(els.arrangeLane.value);
        checkpoint();
        const count = lineUp(laneId);
        if (!count) {
            state.history.pop();
            updateUndoButtons();
            ui.toast('That lane has no clips yet.');
            return;
        }
        changed();
        ui.toast(`Lined up ${count} clip${count === 1 ? '' : 's'} on ${laneById(laneId).name}`, 'success');
    });
    $('#mergeLanes').addEventListener('click', () => {
        const laneId = Number(els.arrangeLane.value);
        checkpoint();
        // Lane order first, then time: lane 1's clips, then lane 2's, ...
        const laneIndex = new Map(session.lanes.map((l, i) => [l.id, i]));
        const list = session.clips.slice().sort((a, b) =>
            laneIndex.get(a.laneId) - laneIndex.get(b.laneId) || a.at - b.at);
        if (list.length) list[0].at = Math.min(...list.map((c) => c.at));
        lineUp(laneId, list);
        session.lanes = session.lanes.filter((l) => l.id === laneId || session.clips.some((c) => c.laneId === l.id));
        renderAll();
        mixer.refresh();
        ui.toast(`All ${list.length} clips are now on one lane, end to end`, 'success');
    });
    AL.formatPicker(els.format);
    $('#exportMix').addEventListener('click', exportMix);
    $('#exportStems').addEventListener('click', exportStems);
    $('#exportClips').addEventListener('click', exportClips);

    ui.shortcuts({
        Space: toggleMix,
        Home: () => $('#rewind').click(),
        s: splitAtTimeline,
        d: duplicateClip,
        Delete: deleteClip,
        '[': () => stepSelection(-1),
        ']': () => stepSelection(1),
        c: playClipAlone,
        l: toggleLoop,
        i: () => setEdgeAtPreview('start'),
        o: () => setEdgeAtPreview('end')
    });

    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const tag = e.target.tagName;
        if ((tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') || tag === 'TEXTAREA') return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
            e.preventDefault();
            redo();
        }
    });

    renderAll();
})();
