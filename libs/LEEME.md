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
5. **Caché de la sesión ONNX y de la configuración por voz** (`_SES`/`_CFG` y
   las funciones `G`/`V` junto a `predict`): la versión original creaba una
   `InferenceSession` nueva —leer el modelo de OPFS y parsear su grafo— en
   CADA frase, lo que retrasaba el arranque de la lectura. Ahora se reutilizan,
   así empezar a leer es casi instantáneo. Es seguro porque quien sintetiza
   serializa las peticiones (la cola de `tts-frame.js` y la de `reader.js`), de
   modo que nunca hay dos `run()` a la vez sobre la misma sesión.

Los **modelos de voz** (`.onnx`, 25–120 MB) NO van en el repositorio: se
descargan de Hugging Face (`diffusionstudio/piper-voices`) la primera vez que
se usa cada voz y quedan cacheados en el navegador (OPFS).

### Voces fuera del mirror por defecto (sin tocar la librería)

El mirror `diffusionstudio/piper-voices` solo aloja un subconjunto de voces
(las 119 de su catálogo interno). Algunas voces oficiales de Piper no están
ahí; la argentina **`es_AR-daniela-high`** (español latino, `es-419`) es un
ejemplo: vive en el repositorio OFICIAL `rhasspy/piper-voices`, del que aquel
es copia.

Para añadirla **sin editar `vits-web.js`**, el archivo `voces-extra.js` (en la
raíz del proyecto) inyecta su ruta en el catálogo exportado (`PATH_MAP`) usando
una ruta con `../` que sube desde el mirror hasta el origen de Hugging Face y
baja a `rhasspy` (la librería arma la URL como `${HF_BASE}/ruta` y `fetch`
normaliza los `../`). Lo llaman `tts-frame.js` (páginas web) y `reader.js`
(lector de PDF). Si la descarga fallara, el motor recae en una voz del sistema,
así que el resto de voces no corre ningún riesgo. Para sumar más voces de
rhasspy basta con añadir su id y ruta a `VOCES_RHASSPY` en `voces-extra.js` y
su etiqueta a `VOCES_NEURALES` en `speech-engine.js`.

## Nota

`Readability.js` se retiró en la v1.1: el resaltado sobre la propia página
lee el DOM directamente con sus propios filtros de contenido.

Todas las librerías son open source: pdf.js (Apache 2.0), vits-web y
piper-wasm (MIT), ONNX Runtime (MIT), voces Piper de Rhasspy (MIT).
