# Vendored libraries

| File | Project | Version | License | Source |
| --- | --- | --- | --- | --- |
| `lame.min.js` | [lamejs](https://github.com/zhuker/lamejs), a JavaScript port of [LAME](https://lame.sourceforge.io/) | 1.2.1 | LGPL-3.0 | `https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js` |

Shipped unmodified. SHA-256:
`15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`

It is loaded only by `js/mp3-worker.js`, from this site, never from a CDN.
You can replace it with any other build of lamejs that defines a global
`lamejs.Mp3Encoder`. After changing it, bump `CACHE_VERSION` in `sw.js`.
