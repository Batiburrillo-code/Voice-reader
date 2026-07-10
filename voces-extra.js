/**
 * voces-extra.js — Registra en el catálogo de vits-web (Piper) voces que NO
 * están en su mirror de descarga por defecto (diffusionstudio/piper-voices).
 *
 * Caso actual: la voz argentina "es_AR-daniela-high" (español latino, es-419).
 * No existe en el mirror por defecto, pero sí en el repositorio OFICIAL de Piper
 * (rhasspy/piper-voices), del que aquel es una copia.
 *
 * Truco para no tocar la librería empaquetada (libs/neural/vits-web.js):
 *   vits-web construye la URL de descarga como `${HF_BASE}/${ruta}`, donde
 *   HF_BASE apunta al mirror. Registramos la ruta de la voz con suficientes
 *   "../" para SUBIR desde el mirror hasta el origen (huggingface.co) y BAJAR
 *   al repo de rhasspy. `fetch` normaliza los "../" según el estándar de URL,
 *   así que la descarga acaba yendo a rhasspy. El número de "../" se calcula a
 *   partir de HF_BASE, por lo que sigue funcionando aunque cambie el mirror.
 *
 * Si algo fallara (repo caído, sin conexión la primera vez), el motor recae
 * automáticamente en una voz del sistema, así que no hay riesgo para el resto.
 */

// Voces extra: id de vits-web → ruta dentro del repositorio de rhasspy.
const VOCES_RHASSPY = {
  'es_AR-daniela-high': 'es/es_AR/daniela/high/es_AR-daniela-high.onnx'
};

/**
 * Inyecta las voces extra en el catálogo (PATH_MAP) del módulo vits-web dado.
 * @param {object} vits  El módulo importado (`import * as vits from '.../vits-web.js'`).
 */
export function registrarVocesExtra(vits) {
  try {
    if (!vits || !vits.PATH_MAP || !vits.HF_BASE) return;
    // Nº de carpetas que hay que subir para llegar al origen del mirror.
    const subir = new URL(vits.HF_BASE).pathname.split('/').filter(Boolean).length;
    const arriba = '../'.repeat(subir);
    for (const [id, ruta] of Object.entries(VOCES_RHASSPY)) {
      // Solo si el mirror por defecto no la trae ya.
      if (!vits.PATH_MAP[id]) {
        vits.PATH_MAP[id] = arriba + 'rhasspy/piper-voices/resolve/main/' + ruta;
      }
    }
  } catch (e) {
    // Si la librería cambia y esto deja de encajar, esas voces simplemente
    // no se podrán descargar (el motor avisará y usará una voz del sistema).
    console.warn('No se pudieron registrar las voces extra:', e);
  }
}
