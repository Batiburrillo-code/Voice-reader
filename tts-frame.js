/**
 * tts-frame.js — Motor neuronal Piper dentro del iframe oculto.
 *
 * Protocolo (window.postMessage con un MessageChannel):
 *   Petición : { lectorTTS: true, tipo: 'sintetizar', texto, voz } + [puerto]
 *   Respuestas por el puerto:
 *     { tipo: 'progreso', cargado, total }  → descarga del modelo (1ª vez)
 *     { tipo: 'audio', datos: ArrayBuffer } → WAV listo
 *     { tipo: 'error', error }              → algo falló
 *
 * La librería vits-web (Piper) está parcheada para cargar TODO su WASM desde
 * libs/neural/ (nada de CDNs). Los modelos de voz se descargan de Hugging
 * Face la primera vez y quedan guardados en el almacenamiento del navegador.
 */

import * as vits from './libs/neural/vits-web.js';

// Las síntesis se encadenan una tras otra: el runtime ONNX rinde mejor sin
// peticiones simultáneas y así el orden de las oraciones queda garantizado.
let cola = Promise.resolve();

window.addEventListener('message', (ev) => {
  const datos = ev.data;
  const puerto = ev.ports && ev.ports[0];
  if (!datos || datos.lectorTTS !== true || !puerto) return;
  if (datos.tipo !== 'sintetizar') return;

  cola = cola.then(() => sintetizar(datos.texto, datos.voz, puerto)).catch(() => { /* ya avisado */ });
});

async function sintetizar(texto, voz, puerto) {
  try {
    const wav = await vits.predict(
      { text: String(texto || ' '), voiceId: voz },
      (progreso) => {
        // progreso = {url, loaded, total} → lo pasamos tal cual al motor
        puerto.postMessage({
          tipo: 'progreso',
          cargado: progreso.loaded || 0,
          total: progreso.total || 0
        });
      }
    );
    const datos = await wav.arrayBuffer();
    puerto.postMessage({ tipo: 'audio', datos }, [datos]); // transferencia, sin copia
  } catch (e) {
    puerto.postMessage({ tipo: 'error', error: String((e && e.message) || e) });
  }
}
