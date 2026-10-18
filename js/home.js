// Builds the decorative waveform in the landing-page hero. Bar heights come
// from a couple of layered sines so the shape looks like music rather than
// noise, and each bar's animation is offset to make the wave ripple.
(function () {
    'use strict';

    const wave = document.getElementById('heroWave');
    if (!wave) return;

    const bars = window.innerWidth < 720 ? 48 : 84;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < bars; i++) {
        const x = i / bars;
        const envelope = Math.sin(Math.PI * x);
        const shape = 0.55 + 0.3 * Math.sin(x * 19) * Math.cos(x * 7) + 0.15 * Math.sin(x * 47);
        const bar = document.createElement('span');
        bar.style.setProperty('--h', `${Math.round(Math.max(8, 100 * envelope * shape))}%`);
        bar.style.setProperty('--d', `${(-(i % 17) * 0.11).toFixed(2)}s`);
        fragment.appendChild(bar);
    }
    wave.appendChild(fragment);
})();
