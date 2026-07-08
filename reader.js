/**
 * reader.js — Lector de PDFs de "Lector TTS".
 *
 * Desde la v1.2 el PDF SE VE como en el visor del navegador: cada página se
 * renderiza en un lienzo (canvas) con pdf.js y encima se coloca la "capa de
 * texto" invisible que trae pdf.js, perfectamente alineada con lo impreso.
 * El resaltado de párrafo/oración/palabra se pinta sobre esa capa con la
 * CSS Custom Highlight API, así que se ilumina EL PROPIO DOCUMENTO.
 *
 * Para que los PDFs grandes no consuman memoria de golpe, los lienzos se
 * renderizan solo cuando la página se acerca a la vista (IntersectionObserver);
 * la capa de texto sí se construye entera al abrir, porque de ella sale el
 * texto que se lee y el mapa de posiciones del resaltado.
 *
 * Al ser una página de la extensión, las voces neuronales Piper se
 * sintetizan aquí mismo (sin iframe intermedio).
 */

// pdf.js v4 se distribuye como módulo ES; por eso este script es type="module".
import * as pdfjsLib from './libs/pdf.mjs';
// Motor neuronal Piper (parcheado para cargar su WASM desde libs/neural/).
import * as vits from './libs/neural/vits-web.js';

// El "worker" de pdf.js debe cargarse desde DENTRO de la extensión.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.mjs');

// ---- Referencias a la interfaz -------------------------------------------
const elTitulo = document.getElementById('titulo');
const elEstado = document.getElementById('estado');
const elZona = document.getElementById('zona');
const elVisor = document.getElementById('visor');
const elProgreso = document.getElementById('progreso');
const btnPausa = document.getElementById('btn-pausa');
const btnAnterior = document.getElementById('btn-anterior');
const btnSiguiente = document.getElementById('btn-siguiente');
const btnAbrir = document.getElementById('btn-abrir');
const inputArchivo = document.getElementById('input-archivo');
const selVoz = document.getElementById('sel-voz');
const txtVel = document.getElementById('txt-vel');
const txtTono = document.getElementById('txt-tono');

// Motor de lectura compartido (speech-engine.js ya se cargó como script clásico).
const motor = LectorTTS.crearMotorLectura();

// Enchufar la síntesis neuronal directamente (esta página ya puede con WASM).
motor.sintetizarNeural = (texto, idVoz, alProgreso) =>
  vits.predict({ text: String(texto || ' '), voiceId: idVoz }, (p) => {
    if (alProgreso) alProgreso({ cargado: p.loaded || 0, total: p.total || 0 });
  });

// Estado del documento abierto (o null):
// { texto, mapa, oraciones, cortes, textos, porNodo }
let vista = null;
let parrafoActual = null; // límites del párrafo ya resaltado (para no repintar)

// ---- Resaltado sobre el documento (Custom Highlight API) -------------------

const soportaHighlight =
  typeof Highlight === 'function' && typeof CSS !== 'undefined' && CSS.highlights;
let hlParrafo = null;
let hlOracion = null;
let hlPalabra = null;
let usandoSeleccion = false; // respaldo para navegadores sin la API

if (soportaHighlight) {
  hlParrafo = new Highlight();
  hlOracion = new Highlight();
  hlPalabra = new Highlight();
  // La palabra gana a la oración y la oración al párrafo.
  hlParrafo.priority = 1;
  hlOracion.priority = 2;
  hlPalabra.priority = 3;
  CSS.highlights.set('lector-parrafo', hlParrafo);
  CSS.highlights.set('lector-oracion', hlOracion);
  CSS.highlights.set('lector-palabra', hlPalabra);
}

function limpiarResaltado() {
  if (hlParrafo) hlParrafo.clear();
  if (hlOracion) hlOracion.clear();
  if (hlPalabra) hlPalabra.clear();
  parrafoActual = null;
  if (usandoSeleccion) {
    try { window.getSelection().removeAllRanges(); } catch (e) { /* nada */ }
    usandoSeleccion = false;
  }
}

/**
 * Convierte posiciones [a, b) del texto global en un Range del DOM sobre la
 * capa de texto. El texto global tiene "huecos virtuales" (espacios añadidos
 * entre trozos del PDF que no existen en el DOM): los extremos se ajustan al
 * primer/último tramo real.
 */
function crearRango(a, b) {
  if (!vista || !vista.mapa.length || b <= a) return null;
  const mapa = vista.mapa;

  // Primer segmento que termina después de `a`.
  let lo = 0;
  let hi = mapa.length - 1;
  let iA = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (mapa[m].ini + (mapa[m].hasta - mapa[m].desde) > a) { iA = m; hi = m - 1; }
    else lo = m + 1;
  }
  // Último segmento que empieza antes de `b`.
  lo = 0; hi = mapa.length - 1;
  let iB = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (mapa[m].ini < b) { iB = m; lo = m + 1; }
    else hi = m - 1;
  }
  if (iA < 0 || iB < 0 || iA > iB) return null;

  const segA = mapa[iA];
  const segB = mapa[iB];
  const inicio = Math.max(a, segA.ini);
  const fin = Math.min(b, segB.ini + (segB.hasta - segB.desde));
  if (fin <= inicio) return null;
  if (!segA.nodo.isConnected || !segB.nodo.isConnected) return null;
  try {
    const r = document.createRange();
    r.setStart(segA.nodo, segA.desde + (inicio - segA.ini));
    r.setEnd(segB.nodo, segB.desde + (fin - segB.ini));
    return r;
  } catch (e) {
    return null;
  }
}

/** Límites del párrafo (entre cortes) que contiene la oración. */
function limitesParrafo(oracion) {
  let ini = 0;
  let fin = vista.texto.length;
  for (const c of vista.cortes) {
    if (c <= oracion.ini) ini = c;
    if (c >= oracion.fin) { fin = c; break; }
  }
  return { ini, fin };
}

// ---- Auto-encuadre (seguir la lectura) ---------------------------------------
// Por defecto está APAGADO: puedes navegar por el documento libremente
// mientras suena la voz, sin que la vista vuelva sola a la línea leída.

const btnSeguir = document.getElementById('btn-seguir');
let seguirLectura = false;

function pintarSeguir() {
  btnSeguir.textContent = seguirLectura ? '🎯 Siguiendo' : '🧭 Libre';
  btnSeguir.title = seguirLectura
    ? 'La vista sigue a la lectura. Clic para navegar libremente.'
    : 'Navegación libre. Clic para que la vista siga a la lectura.';
}
pintarSeguir();

btnSeguir.addEventListener('click', () => {
  seguirLectura = !seguirLectura;
  pintarSeguir();
  LectorTTS.guardarAjustes({ seguirPdf: seguirLectura });
  if (seguirLectura) irAOracionActual(); // al activarlo, encuadra ya
});

/** Encuadra la oración que se está leyendo (p. ej. al activar el seguimiento). */
function irAOracionActual() {
  if (!vista || !vista.oraciones.length) return;
  const o = vista.oraciones[motor.indice];
  if (!o) return;
  const rango = crearRango(o.ini, o.fin);
  if (rango) autoDesplazar(rango, true);
}

/** Desplaza el documento para que el rango quede a la vista. */
function autoDesplazar(rango, forzar) {
  if (!seguirLectura && !forzar) return; // navegación libre: no tocar el scroll
  let rect;
  try { rect = rango.getBoundingClientRect(); } catch (e) { return; }
  if (!rect || (rect.top === 0 && rect.bottom === 0)) return;
  const zona = elZona.getBoundingClientRect();
  if (forzar || rect.top < zona.top + 70 || rect.bottom > zona.bottom - 130) {
    const cont = rango.startContainer;
    const el = cont.nodeType === Node.TEXT_NODE ? cont.parentElement : cont;
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** Resalta párrafo + oración `idx` sobre el propio PDF. */
function resaltarOracion(idx) {
  if (!vista) return;
  const o = vista.oraciones[idx];
  if (!o) return;
  elProgreso.textContent = (idx + 1) + ' / ' + vista.oraciones.length;
  const rango = crearRango(o.ini, o.fin);
  if (!rango) return;

  if (soportaHighlight) {
    // Párrafo (solo se repinta al cambiar de párrafo).
    const lp = limitesParrafo(o);
    if (!parrafoActual || lp.ini !== parrafoActual.ini || lp.fin !== parrafoActual.fin) {
      hlParrafo.clear();
      const rp = crearRango(lp.ini, lp.fin);
      if (rp) hlParrafo.add(rp);
      parrafoActual = lp;
    }
    hlPalabra.clear();
    hlOracion.clear();
    hlOracion.add(rango);
  } else {
    // Respaldo sin Highlight API: usar la selección.
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rango);
      usandoSeleccion = true;
    } catch (e) { /* nada */ }
  }
  autoDesplazar(rango);
}

/** Resalta la palabra que suena dentro de la oración. */
function resaltarPalabra(idx, charIndex) {
  if (!soportaHighlight || !vista) return;
  const o = vista.oraciones[idx];
  if (!o) return;
  const t = vista.texto;
  let p = o.ini + Math.max(0, Math.min(charIndex, o.fin - o.ini - 1));
  while (p < o.fin && /\s/.test(t[p])) p++;
  if (p >= o.fin) return;
  let a = p;
  while (a > o.ini && !/\s/.test(t[a - 1])) a--;
  let b = p;
  while (b < o.fin && !/\s/.test(t[b])) b++;
  const rango = crearRango(a, b);
  if (!rango) return;
  hlPalabra.clear();
  hlPalabra.add(rango);
}

// ---- Mensajes de estado ----------------------------------------------------

function estado(texto, esError) {
  elEstado.textContent = texto;
  elEstado.className = esError ? 'error' : '';
}
function estadoHtml(html, esError) {
  elEstado.innerHTML = html;
  elEstado.className = esError ? 'error' : '';
}
function ocultarEstado() {
  elEstado.className = 'oculto';
}

// ---- Preferencias (compartidas con el popup vía chrome.storage.sync) -------

function pintarVel(v) { txtVel.textContent = Number(v).toFixed(1) + '×'; }
function pintarTono(v) { txtTono.textContent = Number(v).toFixed(1); }

LectorTTS.cargarAjustes((ajustes) => {
  motor.ajustes = ajustes;
  pintarVel(ajustes.velocidad);
  pintarTono(ajustes.tono);
  poblarVoces();
});
// La preferencia de auto-encuadre se guarda aparte (por defecto: libre).
try {
  chrome.storage.sync.get({ seguirPdf: false }, (r) => {
    seguirLectura = !!r.seguirPdf;
    pintarSeguir();
  });
} catch (e) { /* nada */ }

chrome.storage.onChanged.addListener((cambios, area) => {
  if (area !== 'sync') return;
  if ('velocidad' in cambios) {
    motor.fijarVelocidad(cambios.velocidad.newValue);
    pintarVel(cambios.velocidad.newValue);
  }
  if ('tono' in cambios) {
    motor.fijarTono(cambios.tono.newValue);
    pintarTono(cambios.tono.newValue);
  }
  if ('vozNombre' in cambios) {
    motor.fijarVoz(cambios.vozNombre.newValue);
    selVoz.value = cambios.vozNombre.newValue || '';
  }
  if ('seguirPdf' in cambios) {
    seguirLectura = !!cambios.seguirPdf.newValue;
    pintarSeguir();
  }
});

// Contadores de −/+ 0.1 (velocidad y tono).
const timersPaso = {};
function paso(clave, delta, min, max, pintar) {
  const actual = Number(motor.ajustes[clave]) || 1;
  const nuevo = Math.round(Math.min(max, Math.max(min, actual + delta)) * 10) / 10;
  motor.ajustes[clave] = nuevo; // respuesta inmediata en pasos seguidos
  pintar(nuevo);
  // Con audio neuronal sonando, la velocidad cambia AL INSTANTE (sin esperar
  // el guardado): se nota en el mismo clic.
  if (clave === 'velocidad' && motor._audio) {
    motor._audio.playbackRate = Math.min(16, Math.max(0.25, nuevo));
  }
  clearTimeout(timersPaso[clave]);
  timersPaso[clave] = setTimeout(() => {
    LectorTTS.guardarAjustes({ [clave]: nuevo }); // el eco de storage lo aplica al motor
  }, 250);
}
document.getElementById('btn-vel-menos').addEventListener('click', () => paso('velocidad', -0.1, 0.5, 5, pintarVel));
document.getElementById('btn-vel-mas').addEventListener('click', () => paso('velocidad', 0.1, 0.5, 5, pintarVel));
document.getElementById('btn-tono-menos').addEventListener('click', () => paso('tono', -0.1, 0.5, 2, pintarTono));
document.getElementById('btn-tono-mas').addEventListener('click', () => paso('tono', 0.1, 0.5, 2, pintarTono));

// ---- Selector de voz (neuronales y español primero) --------------------------

function poblarVoces() {
  const voces = LectorTTS.refrescarVoces();
  selVoz.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '✨ Automática (español)';
  selVoz.appendChild(auto);

  const grupoNeural = document.createElement('optgroup');
  grupoNeural.label = '🌟 Neuronales (descarga única)';
  for (const voz of LectorTTS.VOCES_NEURALES) {
    const op = document.createElement('option');
    op.value = voz.id;
    op.textContent = voz.etiqueta;
    grupoNeural.appendChild(op);
  }
  selVoz.appendChild(grupoNeural);

  const esEspanola = (v) => v.lang && v.lang.toLowerCase().startsWith('es');
  const orden = (a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
  const grupoSistema = document.createElement('optgroup');
  grupoSistema.label = 'Voces del sistema';
  for (const voz of voces.filter(esEspanola).sort(orden).concat(voces.filter((v) => !esEspanola(v)).sort(orden))) {
    const op = document.createElement('option');
    op.value = voz.name;
    op.textContent = voz.name + ' (' + voz.lang + ')';
    grupoSistema.appendChild(op);
  }
  if (grupoSistema.children.length) selVoz.appendChild(grupoSistema);

  selVoz.value = motor.ajustes.vozNombre || '';
  if (selVoz.value !== (motor.ajustes.vozNombre || '')) selVoz.value = '';
}
speechSynthesis.addEventListener('voiceschanged', poblarVoces);

selVoz.addEventListener('change', () => {
  LectorTTS.guardarAjustes({ vozNombre: selVoz.value });
});

// ---- Botones de transporte ---------------------------------------------------

btnPausa.addEventListener('click', () => {
  // Un clic real: también desbloquea el audio si el navegador lo exigía.
  if (!motor.leyendo && vista) motor.iniciar(vista.textos, 0);
  else if (motor.enPausa) motor.reanudar();
  else motor.pausar();
});
btnAnterior.addEventListener('click', () => motor.anterior());
btnSiguiente.addEventListener('click', () => motor.siguiente());

btnAbrir.addEventListener('click', () => inputArchivo.click());
inputArchivo.addEventListener('change', async () => {
  const archivo = inputArchivo.files && inputArchivo.files[0];
  if (!archivo) return;
  try {
    const datos = await archivo.arrayBuffer();
    await procesarPdf(datos, archivo.name);
  } catch (e) {
    estado('No se pudo leer el archivo: ' + e.message, true);
  }
});

// ---- Conexión del motor con la interfaz -----------------------------------

motor.alEmpezarOracion = resaltarOracion;
motor.alPalabra = resaltarPalabra;
motor.alCambiarEstado = (est) => {
  btnPausa.textContent = est.leyendo && !est.enPausa ? '⏸' : '▶';
};
motor.alTerminar = () => {
  limpiarResaltado();
  elProgreso.textContent = 'Fin ✓';
};
motor.alProgresoDescarga = (pct) => {
  if (pct === null) ocultarEstado();
  else estado('Descargando la voz neuronal… ' + pct + '% (solo la primera vez; luego funciona sin conexión)');
};
motor.alBloqueoAudio = () => {
  estado('El navegador pide un clic para reproducir sonido: pulsa ▶ arriba.');
};
motor.alAviso = (texto) => estado(texto, true);

// ---- Renderizado perezoso de los lienzos -------------------------------------

const infoPaginas = new Map(); // divPagina → {page, viewport}
const observador = new IntersectionObserver((entradas) => {
  for (const entrada of entradas) {
    if (!entrada.isIntersecting) continue;
    observador.unobserve(entrada.target);
    pintarCanvas(entrada.target);
  }
}, { root: elZona, rootMargin: '700px' });

async function pintarCanvas(divPag) {
  const info = infoPaginas.get(divPag);
  if (!info || divPag.dataset.pintada) return;
  divPag.dataset.pintada = '1';
  const canvas = divPag.querySelector('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(info.viewport.width * dpr);
  canvas.height = Math.floor(info.viewport.height * dpr);
  try {
    await info.page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: info.viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    }).promise;
  } catch (e) {
    delete divPag.dataset.pintada; // reintento si vuelve a acercarse
    observador.observe(divPag);
  }
}

// ---- Carga y procesado del PDF ---------------------------------------------------

/** Saca un nombre legible del final de la URL. */
function nombreDesdeUrl(url) {
  try {
    const ruta = new URL(url).pathname;
    const nombre = decodeURIComponent(ruta.split('/').pop() || '');
    return nombre || 'Documento PDF';
  } catch (e) {
    return 'Documento PDF';
  }
}

/** Descarga el PDF de la URL y lo procesa. */
async function cargarDesdeUrl(url) {
  estado('Descargando el PDF…');
  let respuesta;
  try {
    respuesta = await fetch(url);
  } catch (e) {
    estadoHtml(
      'No se pudo descargar el PDF automáticamente. ' +
      (url.startsWith('file:')
        ? 'Para PDFs locales, Chrome necesita que actives «Permitir el acceso a las URL ' +
          'de archivo» en la ficha de la extensión (chrome://extensions), o simplemente ' +
          'usa el botón <b>📂 Abrir PDF…</b> de arriba y elige el archivo.'
        : 'Comprueba tu conexión o usa el botón <b>📂 Abrir PDF…</b> para elegirlo a mano.'),
      true
    );
    return;
  }
  if (!respuesta.ok) {
    estado('El servidor respondió con un error (HTTP ' + respuesta.status + ').', true);
    return;
  }
  const datos = await respuesta.arrayBuffer();
  await procesarPdf(datos, nombreDesdeUrl(url));
}

/** Renderiza el PDF, construye el mapa de texto y arranca la lectura. */
async function procesarPdf(datos, nombre) {
  motor.detener();
  limpiarResaltado();
  vista = null;
  infoPaginas.clear();
  elVisor.innerHTML = '';
  elProgreso.textContent = '';
  elTitulo.textContent = nombre;
  document.title = nombre + ' — Lector TTS';
  estado('Abriendo el PDF…');

  let documento;
  try {
    // isEvalSupported:false → pdf.js jamás ejecuta código incrustado en el PDF.
    documento = await pdfjsLib.getDocument({ data: datos, isEvalSupported: false }).promise;
  } catch (e) {
    estado(
      'No se pudo abrir el PDF' +
      (String(e && e.name) === 'PasswordException'
        ? ': está protegido con contraseña.'
        : '. ¿Seguro que el archivo es un PDF válido?'),
      true
    );
    return;
  }

  // Ancho disponible: usamos también el del viewport porque durante la carga
  // el contenedor puede medir 0 y las páginas saldrían diminutas.
  const anchoBase = Math.max(elZona.clientWidth, document.documentElement.clientWidth || 0);
  const anchoPagina = Math.max(360, Math.min(anchoBase - 44, 980));
  const paginas = []; // {items, nodos, coincide}
  const hayTextLayer = typeof pdfjsLib.TextLayer === 'function';

  for (let p = 1; p <= documento.numPages; p++) {
    estado('Preparando página ' + p + ' de ' + documento.numPages + '…');
    const page = await documento.getPage(p);
    const vp1 = page.getViewport({ scale: 1 });
    const escala = Math.max(0.4, Math.min(2.5, anchoPagina / vp1.width));
    const viewport = page.getViewport({ scale: escala });

    // La página: lienzo (se pinta al acercarse) + capa de texto encima.
    const divPag = document.createElement('div');
    divPag.className = 'pagina';
    divPag.style.width = viewport.width + 'px';
    divPag.style.height = viewport.height + 'px';
    // pdf.js necesita esta variable CSS para colocar bien la capa de texto.
    divPag.style.setProperty('--scale-factor', String(escala));
    const canvas = document.createElement('canvas');
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    divPag.appendChild(canvas);
    elVisor.appendChild(divPag);
    infoPaginas.set(divPag, { page, viewport });
    observador.observe(divPag);

    // Capa de texto + comprobación de que cada trozo tiene su nodo.
    const contenido = await page.getTextContent();
    const nodos = [];
    let coincide = false;
    if (hayTextLayer) {
      try {
        const capa = document.createElement('div');
        capa.className = 'textLayer';
        divPag.appendChild(capa);
        const tl = new pdfjsLib.TextLayer({
          textContentSource: contenido,
          container: capa,
          viewport
        });
        await tl.render();
        const walker = document.createTreeWalker(capa, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) if (n.data) nodos.push(n);
        const conTexto = contenido.items.filter((it) => it.str);
        coincide = conTexto.length === nodos.length &&
          conTexto.every((it, i) => nodos[i].data === it.str);
      } catch (e) {
        coincide = false;
      }
    }
    paginas.push({ items: contenido.items, nodos, coincide });
  }

  // Texto global + mapa de posiciones + cortes (páginas y párrafos).
  const resaltable = hayTextLayer && paginas.every((pg) => pg.coincide);
  let texto = '';
  const mapa = [];
  const cortes = [];
  const porNodo = new Map();

  for (const pg of paginas) {
    if (texto.length) cortes.push(texto.length); // límite de página
    let previo = null;
    let iNodo = 0;
    for (const item of pg.items) {
      if (!item.str) continue;
      // Un salto vertical grande entre líneas = párrafo nuevo.
      if (previo) {
        const dy = Math.abs(previo.transform[5] - item.transform[5]);
        const alto = Math.max(previo.height || 0, item.height || 0, 8);
        if (dy > alto * 1.7) cortes.push(texto.length);
      }
      // Hueco "virtual": espacio para hablar que no existe en el DOM del PDF.
      if (texto.length && !/\s$/.test(texto) && !/^\s/.test(item.str)) texto += ' ';
      if (resaltable) {
        const seg = { nodo: pg.nodos[iNodo], desde: 0, hasta: item.str.length, ini: texto.length };
        mapa.push(seg);
        porNodo.set(seg.nodo, seg);
      }
      texto += item.str;
      previo = item;
      iNodo++;
    }
  }

  // PDF escaneado: se puede VER, pero no hay texto que leer.
  if (texto.trim().length < Math.max(60, documento.numPages * 20)) {
    estado(
      'Este PDF parece escaneado: se puede ver, pero no tiene capa de texto que ' +
      'leer en voz alta. Haría falta OCR (reconocimiento óptico), que esta versión no incluye.',
      true
    );
    return;
  }

  const rangos = LectorTTS.trocearRangos(texto, cortes)
    .filter((r) => texto.slice(r.ini, r.fin).trim());
  if (!rangos.length) {
    estado('No se encontró texto legible en el PDF.', true);
    return;
  }

  vista = {
    texto,
    mapa,
    oraciones: rangos,
    cortes,
    porNodo,
    textos: rangos.map((r) => texto.slice(r.ini, r.fin))
  };

  if (!resaltable) {
    // Caso raro: la capa de texto no cuadró. Se lee igual, sin resaltado.
    estado('Este PDF se leerá en voz alta, pero su capa de texto no permite resaltar sobre el documento.');
    setTimeout(ocultarEstado, 7000);
  } else {
    ocultarEstado();
  }
  motor.iniciar(vista.textos, 0);
}

// Clic sobre el texto del PDF = saltar a esa oración.
elVisor.addEventListener('click', (ev) => {
  if (!vista || !vista.mapa.length) return;
  let nodoClic = null;
  let offsetClic = 0;
  if (document.caretRangeFromPoint) {
    const cr = document.caretRangeFromPoint(ev.clientX, ev.clientY);
    if (cr) { nodoClic = cr.startContainer; offsetClic = cr.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const cp = document.caretPositionFromPoint(ev.clientX, ev.clientY);
    if (cp) { nodoClic = cp.offsetNode; offsetClic = cp.offset; }
  }
  if (!nodoClic || nodoClic.nodeType !== Node.TEXT_NODE) return;
  const seg = vista.porNodo.get(nodoClic);
  if (!seg) return;
  const pos = seg.ini + Math.min(offsetClic, seg.hasta - seg.desde);
  const idx = vista.oraciones.findIndex((o) => pos >= o.ini && pos < o.fin);
  if (idx < 0) return;
  if (motor.leyendo) motor.saltarA(idx);
  else motor.iniciar(vista.textos, idx);
});

// ---- Arranque ---------------------------------------------------------------------

const parametros = new URLSearchParams(location.search);
const src = parametros.get('src');
if (src) {
  cargarDesdeUrl(src);
} else {
  estadoHtml(
    '<b>Lector de PDF</b><br>' +
    'Abre un PDF en una pestaña y pulsa el botón <b>📄 Leer este PDF</b> del popup, ' +
    'o usa el botón <b>📂 Abrir PDF…</b> de arriba para elegir un archivo de tu equipo.'
  );
}

// Al cerrar la pestaña, detener la voz.
window.addEventListener('beforeunload', () => motor.detener());
