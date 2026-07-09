# 🎙️ Investigación: voces gratuitas de mayor calidad para Lector TTS

Objetivo: encontrar voces **más claras y humanas** que las del sistema, que
fueran **gratis, rápidas, a poder ser open source** y utilizables dentro de
una extensión Manifest V3 (que prohíbe cargar código desde internet).
Criterio de decisión: primero la calidad, después la facilidad de
implementación, manteniéndola en un rango razonable.

## Opciones analizadas

| Opción | Calidad* | Español | Velocidad en CPU | Tamaño | Licencia | Veredicto |
|---|---|---|---|---|---|---|
| **Piper (elegida)** | ★★★★ (MOS ≈ 3.8–4.0) | ✅ 8 voces (España, México, Argentina) | ✅ 3–5× tiempo real, sin GPU | 25–120 MB por voz | MIT | **Integrada en v1.1** |
| Kokoro 82M | ★★★★★ (MOS ≈ 4.3–4.5) | ⚠️ pocas voces, menos pulido que en inglés | ⚠️ 0.8–1× en CPU (necesita WebGPU para ir fluida) | ~86–330 MB | Apache 2.0 | Candidata para una v2 |
| Kitten TTS | ★★★ (MOS ≈ 3.2–3.5) | ❌ solo inglés | ✅ rápida | 24 MB | Apache 2.0 | Descartada (sin español) |
| eSpeak-NG | ★ (robótica) | ✅ | ✅✅ | 3 MB | GPL | Descartada (peor que las voces del sistema) |
| Voces "neural" de Edge (nube) | ★★★★★ | ✅ | — (es un servicio web) | 0 | API no oficial | Descartada: requiere internet siempre, envía el texto a Microsoft y puede dejar de funcionar en cualquier momento |
| Más voces del sistema (Windows) | ★★–★★★ | ✅ | ✅✅ | 0 | — | Ya soportado; se explica en el README cómo instalarlas |

\* MOS = puntuación media de naturalidad (1–5) según la comparativa de OfflineTTS (2026).

## Por qué Piper

1. **Calidad**: voces neuronales VITS claramente más naturales que las voces
   SAPI clásicas de Windows. No llega al nivel de Kokoro, pero…
2. **…es la única de alta calidad que va sobrada de velocidad en cualquier
   PC**: 3–5× tiempo real solo con CPU (WASM). Kokoro sin tarjeta gráfica
   compatible con WebGPU baja a menos de tiempo real, lo que causaría cortes.
3. **Español de verdad**: 8 voces —español latino (2 de México y 1 de
   Argentina) y 5 de España—, incluidas dos de calidad "high"
   (es_MX-claude-high y es_AR-daniela-high). Además, 7 voces en inglés
   (EE. UU. y Reino Unido). La argentina se descarga del repositorio oficial
   de Piper (rhasspy); el resto, del mirror de vits-web (ver `libs/LEEME.md`).
4. **Licencia MIT** y modelos abiertos publicados por el proyecto Rhasspy.
5. **Implementación razonable**: existe un puerto a navegador mantenido
   ([vits-web](https://github.com/diffusionstudio/vits-web), MIT) que usa
   ONNX Runtime Web. Se empaquetó dentro de la extensión parcheado para
   que **todo el código** (JS + WASM + datos del fonemizador eSpeak) se
   cargue desde `libs/neural/`, cumpliendo la CSP de Manifest V3.

## Cómo quedó integrado

- Los **modelos de voz** (25–120 MB según la voz) se descargan de Hugging Face
  **solo la primera vez** que se usa esa voz y quedan guardados en el
  almacenamiento del navegador (OPFS). A partir de ahí, todo funciona
  **sin conexión**. Es el mismo esquema que "descargar una voz" en Windows.
- En las páginas web la síntesis corre en un **iframe oculto de la extensión**
  (los content scripts no pueden ejecutar WASM); en el lector de PDF corre
  directamente en la página.
- El audio se reproduce con `playbackRate` conservando el tono: la velocidad
  **hasta 5× funciona de verdad** con cualquier voz neuronal (las voces
  "online" del sistema la limitaban a ~2×).
- Mientras suena una oración, la siguiente ya se está sintetizando en segundo
  plano para que no haya huecos.
- Si la voz neuronal falla (p. ej. sin internet en la primera descarga), el
  motor **avisa y sigue leyendo con una voz del sistema**: la lectura nunca se
  queda muda.

## Fuentes

- [Browser TTS Showdown: Kokoro vs Piper vs Kitten — 2026 Benchmark (OfflineTTS)](https://offlinetts.com/blog/browser-tts-showdown-kokoro-piper-kitten/)
- [Kokoro TTS: Lightweight 82M Browser Text-to-Speech Guide](https://kokoroweb.app/en/blog/kokoro-tts-lightweight-browser-text-to-speech)
- [kokoro-js en npm](https://www.npmjs.com/package/kokoro-js)
- [Local, CPU-Friendly, High-Quality TTS with Kokoro (ariya.io)](https://ariya.io/2026/03/local-cpu-friendly-high-quality-tts-text-to-speech-with-kokoro/)
- [Rhasspy Piper (modelos de voz, MIT)](https://github.com/rhasspy/piper)
- [vits-web: Piper en el navegador (MIT)](https://github.com/diffusionstudio/vits-web)
