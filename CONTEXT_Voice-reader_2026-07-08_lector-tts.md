---
proyecto: Voice-reader (extensión "Lector TTS")
fecha: 2026-07-08
tema: lector-tts
ultimo_commit: def1c12 v1.3.0 — navegación libre durante la lectura, pausa instantánea y ajuste fino desde el lector
branch: main
cambios_pendientes: ninguno
repositorio: https://github.com/Batiburrillo-code/Voice-reader
---

# CONTEXT — Lector TTS (Voice-reader) · cierre de sesión 2026-07-08

> **Para el asistente que lea esto:** este documento resume TODO el contexto de
> la conversación anterior. El usuario es hispanohablante y **no técnico**:
> responde siempre en español, entrega código terminado y comentado en español,
> y explica sin jerga. El proyecto vive en
> `C:\Users\serra\Downloads\Voice-reader` y en
> https://github.com/Batiburrillo-code/Voice-reader (rama `main`).

## Qué es el proyecto

**Lector TTS**: extensión de navegador Manifest V3, clon **100 % gratuito de
Speechify**. Lee páginas web y PDFs en voz alta resaltando párrafo, oración y
palabra SOBRE el propio contenido. Una sola base de código para **Chrome,
Brave, Chromium, Opera GX y Firefox**. Sin APIs de pago, sin servidores
propios, sin CDNs (la CSP de MV3 lo prohíbe): todo el código va empaquetado.

## Qué hicimos en esta sesión (por versiones, todas etiquetadas y en GitHub)

### v1.0.0 — Extensión base (requisitos del documento inicial)
- MV3 con **doble clave background** (`service_worker` + `scripts`) para Chromium+Firefox; `browser_specific_settings.gecko.id: lector-tts@adrian.local`, `strict_min_version: 115.0`.
- Leer selección (menú contextual + **Alt+L**) y artículo completo; troceo en oraciones (corte tras `.!?…`, une <60 chars por abreviaturas, parte >250 por el bug de Chrome que enmudece utterances largas); una oración por utterance encadenada en `onend`; `cancel()` antes de cada `speak()`; `onerror` avanza para no congelarse.
- Español primero: voz guardada → primera voz `es-*` → defecto con `lang es-ES`; velocidad por defecto **1.1**; UI en español.
- Popup con voz/velocidad/tono/transporte; preferencias en `chrome.storage.sync`; aviso amable en páginas restringidas (`chrome://`, tiendas).
- Lector de PDF (`reader.html`) porque los visores nativos no aceptan content scripts.

### v1.1.0 — Resaltado en página, voces neuronales, Opera GX
- **Resaltado sobre el texto real de la página** (petición: nada de panel lateral): se recorren los nodos de texto visibles, se construye un “texto total” con mapa posición→nodo, y se pinta con la **CSS Custom Highlight API** (no muta el DOM; respaldo con la selección para Firefox <140). Barrita flotante de controles. Clic en una frase = saltar.
- **Voces neuronales Piper** (investigación en `VOCES.md`: Piper ganó a Kokoro/Kitten/eSpeak/nube por calidad+velocidad CPU+español+MIT): librería `vits-web` 1.0.3 **parcheada** y empaquetada en `libs/neural/` con ONNX Runtime 1.18 y el fonemizador eSpeak WASM. Modelos (25–120 MB) se descargan de Hugging Face **una sola vez** (caché OPFS), luego sin conexión. 7 voces es + 1 en (ids `piper:es_ES-davefx-medium`, `piper:es_MX-claude-high`, etc. — lista en `VOCES_NEURALES` de `speech-engine.js`).
- En páginas web la síntesis neuronal corre en un **iframe oculto** (`tts-frame.html`, extension origin, permite WASM; content scripts no) vía MessageChannel; en `reader.html` es directa.
- **Velocidad 0.5×–5× real** con neuronales (`playbackRate` + `preservesPitch`); prefetch de la siguiente oración; fallback automático a voz del sistema si la neuronal falla.
- **Opera GX**: funciona (Chromium), pero no trae voces del sistema → el popup lo detecta y sugiere voces neuronales. Instrucciones en README.
- Pipeline neuronal **verificado en Chromium real** con servidor local + página de prueba.

### v1.2.0 — Visor de PDF real, párrafo, UI
- **El PDF se ve como en el visor nativo**: páginas renderizadas con pdf.js (canvas) + **capa de texto** (`pdfjsLib.TextLayer`) alineada encima; el resaltado (3 niveles) se pinta **sobre el documento**. Renderizado **perezoso** de lienzos (IntersectionObserver, rootMargin 700px) para PDFs grandes. Requiere `--scale-factor` como variable CSS en cada página.
- Mapeo texto↔documento: 1 item de `getTextContent` = 1 nodo de la capa (verificado); **huecos “virtuales”** (espacios añadidos al texto global que no existen en el DOM) para que las palabras no se peguen al hablar — `crearRango` ajusta los extremos al primer/último tramo real; **cortes** de oración en límites de página y en saltos verticales grandes (párrafos: `dy > 1.7 × alto`).
- **Resaltado de párrafo** (tinte suave) también en webs, con `Highlight.priority` (palabra 3 > oración 2 > párrafo 1).
- Barrita flotante completa (selector de voz, tono y velocidad con **botones −/+ de 0.1**); popup con contadores −/+ junto a los sliders y lavado de cara (degradado morado #7c5cff→#5a8bff).
- Fix: el ancho de página usaba `clientWidth` que podía medir 0 en carga → ahora también `documentElement.clientWidth`.
- Verificado en navegador real con un PDF generado a mano (banco de pruebas con stub de `chrome.*`).

### v1.3.0 — Navegación libre, pausa instantánea, historial limpio
- **Interruptor de auto-encuadre 🧭/🎯**: en el PDF, por defecto la vista **NO** sigue a la lectura (petición expresa del usuario: poder hojear mientras lee) — clave `seguirPdf: false`; en webs sigue por defecto — `seguirWeb: true`. Botones en la barra del lector y en la barrita web; al activar, encuadra la frase actual.
- **Pausa instantánea** (queja: pausa lenta). Dos causas corregidas: (1) con voz del sistema, `speechSynthesis.pause()` tarda/falla con voces online → ahora se hace `cancel()` inmediato (+turno para invalidar callbacks) y reanudar relanza la oración actual; (2) con neuronales, pulsar pausa **durante la síntesis** de la siguiente frase dejaba que el audio arrancara igual → guardia de `enPausa` tras el `await` y el bump de turno en pausar. Medido: silencio en <120 ms.
- Los −/+ de velocidad aplican `playbackRate` al instante sobre el audio en curso.
- **Coautoría eliminada**: el usuario no quiere que Claude figure como coautor. Historial **reescrito** (filter-branch quitando los trailers `Co-Authored-By`) y force-push de `main` + re-etiquetado v1.0.0–v1.2.0. **REGLA: nunca añadir `Co-Authored-By` en los commits de este repositorio.**

## Decisiones técnicas tomadas (no re-discutir)

1. **pdf.js 4.10.38 legacy** (no la 3.x del plan original): CVE-2024-4367; además `isEvalSupported:false` al abrir PDFs.
2. **Piper vía vits-web parcheado** (4 parches sobre `libs/neural/vits-web.js`): base de WASM de ONNX → `new URL("./", import.meta.url)`; fonemizador → local; `import("onnxruntime-web")` → `import("./ort.min.js")`; `numThreads = 1` (el multihilo exige COOP/COEP que las páginas de extensión no tienen). Documentado en `libs/LEEME.md`.
3. **Kokoro descartado por ahora**: mejor calidad (MOS 4.3–4.5) pero <1× tiempo real sin WebGPU → cortes. Candidato para v-next opcional.
4. **Custom Highlight API** para resaltar (no envolver en spans: no muta páginas). Firefox <140 usa la selección como respaldo. Firefox exige conceder el permiso de sitios aparte (botón 🔓 en el popup).
5. **Nada de `chrome.tts` / `chrome.offscreen`** (no existen en Firefox); voz nunca desde el background.
6. **Readability.js se retiró en v1.1**: el modo página recorre el DOM en vivo (raíz: `article` → `main` → `body`, ignorando NAV/HEADER/FOOTER/ASIDE/SUP/etc.) porque el resaltado en sitio necesita nodos reales.
7. **Pausa = cancel** para voces del sistema (reanudar relanza la frase); el audio neuronal sí pausa/reanuda en el punto exacto.
8. **Ajustes**: los controles guardan en `storage.sync` con debounce de 250 ms y el “eco” de `storage.onChanged` los aplica al motor (un solo camino); la velocidad además se aplica al instante si hay audio neuronal sonando.

## Contexto y consideraciones importantes

- **Claves de `chrome.storage.sync`**: `vozNombre` ('' = automática; `piper:<id>` = neuronal), `velocidad` (0.5–5, defecto 1.1), `tono` (0.5–2), `seguirWeb` (defecto true), `seguirPdf` (defecto false).
- **Autoplay**: si el navegador bloquea el audio neuronal sin gesto, el motor queda “en pausa” y la UI pide pulsar ▶ (`alBloqueoAudio`).
- **Arquitectura del motor** (`speech-engine.js`, global `LectorTTS`): `crearMotorLectura()` con dos backends (Web Speech / Piper), callbacks `alEmpezarOracion`, `alPalabra(i, charIndex)`, `alTerminar`, `alCambiarEstado`, `alProgresoDescarga`, `alBloqueoAudio`, `alAviso`, y enchufe `sintetizarNeural(texto, idVoz, alProgreso) → Promise<Blob WAV>`. Resaltado de palabra sin eventos boundary: estimación ~16 chars/s × velocidad (sistema) o proporcional a `currentTime/duration` (neuronal).
- **Troceo**: `trocearRangos(texto, cortes)` devuelve rangos `{ini, fin}` sin cruzar `cortes`; `trocearEnOraciones` es la versión de textos normalizados.
- **Mensajería**: popup/background → content: `{accion: 'leer-pagina'|'leer-seleccion'|'pausa-reanudar'|'detener'|'siguiente'|'anterior'|'estado'}`; respuesta `{ok, error, estado:{leyendo, enPausa, indice, total}}`.
- **Pendiente de confirmar por el usuario** (no verificable sin su equipo): resaltado del content script en Firefox real, autoplay en Opera GX/Firefox, y PDFs complejos reales (el visor tiene degradación: si la capa de texto no cuadra 1:1, lee sin resaltar; escaneados se ven pero no se leen).
- **Los archivos de `libs/` no se tocan a mano** (excepto re-aplicar los 4 parches si se actualiza vits-web). Modelos de voz NO van al repo.
- **Git**: commits en español con prefijo `vX.Y.Z:` + tag anotado + push (el usuario quiere cada versión en GitHub). **Sin `Co-Authored-By`**. El historial se reescribió el 2026-07-08: clones viejos deben re-clonarse.

## Estructura del repositorio

```
manifest.json          # MV3, v1.3.0, doble background, CSP wasm-unsafe-eval, WAR tts-frame.html
background.js          # menú contextual, Alt+L, enrutado (sin voz aquí)
speech-engine.js       # motor compartido (global LectorTTS): troceo, voces, 2 backends
content.js             # resaltado en página (3 niveles), barrita flotante, iframe neuronal
tts-frame.html/.js     # iframe oculto: sintetiza Piper y devuelve WAV por MessageChannel
popup.html/.js         # controles completos + detección PDF + permisos Firefox
reader.html/.js        # visor de PDF renderizado con resaltado encima
icons/                 # generados con PowerShell (System.Drawing)
libs/pdf.mjs, pdf.worker.mjs      # pdf.js 4.10.38 legacy
libs/neural/           # vits-web parcheado + ort.min.js + ort-wasm-simd.wasm + piper_phonemize.{wasm,data}
libs/LEEME.md          # procedencia y parches de las librerías
tests/test-troceo.js   # pruebas del troceador →  node tests/test-troceo.js
tests/test-integridad.js  # IDs/manifest/imports/parches →  node tests/test-integridad.js
README.md              # instalación (Chrome/Brave/Opera GX/Firefox) y uso, no técnico
VOCES.md               # investigación de motores de voz (Piper vs Kokoro vs resto)
```

## Archivos generados esta sesión

Todo lo anterior (proyecto completo, 4 versiones). Últimos añadidos: `tests/` (validación reutilizable) y este CONTEXT.

## Próximo paso inmediato

**No hay tarea abierta.** La v1.3.0 está publicada y verificada en Chromium; falta el feedback del usuario tras probarla. Ideas ya identificadas como v-next (el usuario decide): zoom del visor PDF con re-renderizado, liberar lienzos lejanos en PDFs enormes, OCR de escaneados, motor Kokoro opcional con WebGPU, cambio automático de idioma, publicación en tiendas. Antes de tocar código: `git pull`, y tras cualquier cambio ejecutar `node tests/test-troceo.js` y `node tests/test-integridad.js`, versionar como v1.4.0 con tag y push.
