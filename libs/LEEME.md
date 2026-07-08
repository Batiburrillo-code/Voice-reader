# Librerías empaquetadas (sin CDN)

La política de seguridad de Manifest V3 prohíbe cargar scripts desde internet,
por eso estas librerías van incluidas en la extensión. Ya están descargadas;
esta nota es solo para saber qué son y cómo actualizarlas.

## PDF (extracción de texto)

| Archivo          | Qué es                               | Versión | Origen |
|------------------|--------------------------------------|---------|--------|
| `pdf.mjs`        | pdf.js de Mozilla (build **legacy**) | 4.10.38 | <https://github.com/mozilla/pdf.js/releases> → `pdfjs-4.10.38-legacy-dist.zip` → `build/pdf.mjs` |
| `pdf.worker.mjs` | Worker de pdf.js (build **legacy**)  | 4.10.38 | mismo zip → `build/pdf.worker.mjs` |

- Se usa la build **legacy** para que funcione también en Firefox 115 ESR y
  Chromium antiguos.
- El plan original pedía la 3.x (`pdf.min.js`); se empaquetó la 4.10.38 porque
  las 3.x tienen una vulnerabilidad conocida (CVE-2024-4367). Además, el lector
  la carga con `isEvalSupported: false` como defensa extra.

## `neural/` (voces neuronales Piper)

| Archivo | Qué es | Origen |
|---|---|---|
| `vits-web.js` | Librería [vits-web](https://github.com/diffusionstudio/vits-web) 1.0.3 (MIT), **parcheada** | npm `@diffusionstudio/vits-web@1.0.3` |
| `piper-DeOu3H9E.js` | Módulo del fonemizador (glue de emscripten) | mismo paquete |
| `piper_phonemize.wasm` / `.data` | eSpeak-NG compilado a WASM + sus datos de idiomas | npm `@diffusionstudio/piper-wasm@1.0.0` → `build/` |
| `ort.min.js` | ONNX Runtime Web (build ESM) | npm `onnxruntime-web@1.18.0` → `dist/esm/ort.min.js` |
| `ort-wasm-simd.wasm` | Runtime WASM de ONNX (SIMD, un hilo) | mismo paquete → `dist/` |

**Parches aplicados a `vits-web.js`** (la versión de npm apunta a CDNs, que la
CSP de MV3 prohíbe):

1. La base de los WASM de ONNX (`cdnjs.cloudflare.com/...`) → `new URL("./", import.meta.url).href` (carpeta local).
2. La base del fonemizador (`cdn.jsdelivr.net/.../piper_phonemize`) → `new URL("./piper_phonemize", import.meta.url).href`.
3. `import("onnxruntime-web")` (especificador de bundler) → `import("./ort.min.js")`.
4. `numThreads = navigator.hardwareConcurrency` → `numThreads = 1` (el modo
   multihilo exige cabeceras COOP/COEP que las páginas de extensión no tienen).

Los **modelos de voz** (`.onnx`, 25–120 MB) NO van en el repositorio: se
descargan de Hugging Face (`diffusionstudio/piper-voices`) la primera vez que
se usa cada voz y quedan cacheados en el navegador (OPFS).

## Nota

`Readability.js` se retiró en la v1.1: el resaltado sobre la propia página
lee el DOM directamente con sus propios filtros de contenido.

Todas las librerías son open source: pdf.js (Apache 2.0), vits-web y
piper-wasm (MIT), ONNX Runtime (MIT), voces Piper de Rhasspy (MIT).
