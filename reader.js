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
import { registrarVocesExtra } from './voces-extra.js';

// Añade al catálogo las voces que no están en el mirror por defecto (la
// argentina es_AR-daniela, que vive en el repo oficial de Piper).
registrarVocesExtra(vits);

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
// "Qué se lee": botón de la barra y su panelito de casillas.
const btnQueSeLee = document.getElementById('btn-que-se-lee');
const panelQueSeLee = document.getElementById('panel-que-se-lee');
// Panel lateral: miniaturas de páginas e índice del documento.
const elPanel = document.getElementById('panel');
const btnPanel = document.getElementById('btn-panel');
const tabMiniaturas = document.getElementById('tab-miniaturas');
const tabIndice = document.getElementById('tab-indice');
const elListaMini = document.getElementById('lista-miniaturas');
const elListaIndice = document.getElementById('lista-indice');
const elPagActual = document.getElementById('pag-actual');

// Motor de lectura compartido (speech-engine.js ya se cargó como script clásico).
const motor = LectorTTS.crearMotorLectura();

// Enchufar la síntesis neuronal directamente (esta página ya puede con WASM).
// Las síntesis se encadenan una tras otra: así nunca hay dos inferencias a la
// vez sobre la misma sesión ONNX (que ahora se cachea y reutiliza).
let colaNeural = Promise.resolve();
motor.sintetizarNeural = (texto, idVoz, alProgreso) => {
  const r = colaNeural.then(() => vits.predict(
    { text: String(texto || ' '), voiceId: idVoz },
    (p) => { if (alProgreso) alProgreso({ cargado: p.loaded || 0, total: p.total || 0 }); }
  ));
  colaNeural = r.catch(() => {}); // el fallo de una síntesis no debe romper la cola
  return r;
};

// Estado del documento abierto (o null):
// { texto, mapa, oraciones, cortes, textos, porNodo }
let vista = null;
let parrafoActual = null; // límites del párrafo ya resaltado (para no repintar)
// El documento ya procesado ({paginas, hayTextLayer, numPaginas}), para poder
// rehacer `vista` cuando cambien los ajustes de "qué se lee" sin renderizarlo
// todo otra vez.
let documentoAbierto = null;

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

// ---- "Qué se lee" -----------------------------------------------------------
//
// Un interruptor por parte del documento (números de página, cabeceras, pies y
// pies de imagen). Las opciones se definen una sola vez en speech-engine.js,
// así que el popup y este panel ofrecen exactamente lo mismo, y se guardan en
// chrome.storage.sync: cambiarlo aquí lo cambia también allí.

const casillasLectura = new Map();   // clave del ajuste → <input type=checkbox>

function pintarPanelQueSeLee() {
  for (const op of LectorTTS.OPCIONES_LECTURA) {
    const fila = document.createElement('label');
    fila.className = 'opcion-lectura';
    fila.title = op.ayuda;

    const casilla = document.createElement('input');
    casilla.type = 'checkbox';
    casilla.checked = !!motor.ajustes[op.clave];
    casilla.addEventListener('change', () => {
      // Se guarda y el eco de storage.onChanged rehace la lectura (camino único).
      LectorTTS.guardarAjustes({ [op.clave]: casilla.checked });
    });

    const nombre = document.createElement('span');
    nombre.className = 'nombre';
    nombre.textContent = op.etiqueta;

    const ayuda = document.createElement('span');
    ayuda.className = 'ayuda';
    ayuda.textContent = op.ayuda;

    fila.append(casilla, nombre, ayuda);
    panelQueSeLee.appendChild(fila);
    casillasLectura.set(op.clave, casilla);
  }
}

/** Refleja los ajustes actuales en las casillas del panel. */
function sincronizarCasillasLectura() {
  for (const [clave, casilla] of casillasLectura) casilla.checked = !!motor.ajustes[clave];
}

function abrirPanelQueSeLee(abrir) {
  panelQueSeLee.hidden = !abrir;
  btnQueSeLee.setAttribute('aria-expanded', abrir ? 'true' : 'false');
}

btnQueSeLee.addEventListener('click', (ev) => {
  ev.stopPropagation();
  abrirPanelQueSeLee(panelQueSeLee.hidden);
});
// Un clic fuera (o Escape) cierra el panelito.
document.addEventListener('click', (ev) => {
  if (panelQueSeLee.hidden) return;
  if (panelQueSeLee.contains(ev.target) || btnQueSeLee.contains(ev.target)) return;
  abrirPanelQueSeLee(false);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !panelQueSeLee.hidden) abrirPanelQueSeLee(false);
});

// Pre-calentado del motor neuronal: la primera lectura con una voz Piper
// arranca "en frío" (carga del WASM + lectura del modelo). Sintetizamos un
// texto mínimo al abrir (y al cambiar de voz) para que al pulsar ▶ suene ya.
let vozCalentada = null;
function calentarNeural() {
  const v = motor.ajustes.vozNombre;
  if (!LectorTTS.esVozNeural(v) || vozCalentada === v) return;
  vozCalentada = v;
  vits.predict({ text: 'a', voiceId: LectorTTS.idPiper(v) }, () => {})
    .catch(() => { vozCalentada = null; }); // si falla, se reintenta al leer
}

LectorTTS.cargarAjustes((ajustes) => {
  motor.ajustes = ajustes;
  pintarVel(ajustes.velocidad);
  pintarPanelQueSeLee();
  poblarVoces();
  calentarNeural();
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
  // "Qué se lee": cambia lo que hay que leer, así que hay que rehacer el texto
  // del documento (retomando en la misma frase). Puede venir de este panel o
  // del popup de la extensión: el camino es el mismo.
  let cambioLectura = false;
  for (const op of LectorTTS.OPCIONES_LECTURA) {
    if (op.clave in cambios) {
      motor.ajustes[op.clave] = !!cambios[op.clave].newValue;
      cambioLectura = true;
    }
  }
  if (cambioLectura) {
    sincronizarCasillasLectura();
    reconstruirLectura();
  }

  if ('vozNombre' in cambios) {
    motor.fijarVoz(cambios.vozNombre.newValue);
    selVoz.value = cambios.vozNombre.newValue || '';
    vozCalentada = null;   // voz nueva: precalentarla otra vez
    calentarNeural();
  }
  if ('seguirPdf' in cambios) {
    seguirLectura = !!cambios.seguirPdf.newValue;
    pintarSeguir();
  }
});

// Contadores de −/+ 0.1 (velocidad).
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

// ---- Panel lateral: miniaturas de páginas e índice del documento -------------
//
// Dos vistas intercambiables, como en cualquier lector de PDF:
//   Páginas → una miniatura por hoja, con la que estás viendo resaltada.
//   Índice  → los marcadores del PDF (capítulos y apartados), si los trae.
// Las dos navegan al pulsar, y el panel se puede ocultar (queda guardado).

const ANCHO_MINI = 168;      // ancho en píxeles de cada miniatura
let pdfDoc = null;           // documento pdf.js abierto ahora mismo
const paginasDom = [];       // div de cada página del visor, en orden
const paginasInfo = [];      // {page, viewport} de cada página
const miniaturas = [];       // botón de miniatura de cada página
let topsPaginas = [];        // posición vertical de cada página (para saber cuál se ve)
let paginaActual = -1;       // índice 0-based de la página visible
let indicePlano = [];        // entradas del índice en orden: {fila, dest, pagina}

/** 'auto' si el usuario pide menos animación; si no, desplazamiento suave. */
function comportamientoScroll() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  } catch (e) {
    return 'smooth';
  }
}

// --- Mostrar u ocultar el panel ---

function pintarPanel(abierto) {
  elPanel.classList.toggle('oculto', !abierto);
  btnPanel.setAttribute('aria-expanded', abierto ? 'true' : 'false');
  btnPanel.title = abierto
    ? 'Ocultar el panel de páginas'
    : 'Mostrar el panel de páginas (miniaturas e índice)';
}

btnPanel.addEventListener('click', () => {
  const abrir = elPanel.classList.contains('oculto');
  pintarPanel(abrir);
  LectorTTS.guardarAjustes({ panelPdf: abrir });
  if (abrir) irAMiniaturaActual(true);
});

// Preferencias del panel. La primera vez se abre solo si hay sitio de sobra.
try {
  chrome.storage.sync.get({ panelPdf: null, panelVista: 'miniaturas' }, (r) => {
    // Si aún no hay preferencia, se abre solo cuando hay sitio de sobra.
    const ancho = window.innerWidth || document.documentElement.clientWidth || 1200;
    const abierto = (r && r.panelPdf !== null && r.panelPdf !== undefined)
      ? !!r.panelPdf
      : ancho > 900;
    pintarPanel(abierto);
    cambiarVista(r && r.panelVista === 'indice' ? 'indice' : 'miniaturas', false);
  });
} catch (e) {
  pintarPanel(true);
}

// --- Pestañas: Páginas / Índice ---

function cambiarVista(vista, guardar) {
  const esIndice = vista === 'indice';
  tabMiniaturas.setAttribute('aria-selected', esIndice ? 'false' : 'true');
  tabIndice.setAttribute('aria-selected', esIndice ? 'true' : 'false');
  elListaMini.classList.toggle('oculto', esIndice);
  elListaIndice.classList.toggle('oculto', !esIndice);
  if (guardar !== false) LectorTTS.guardarAjustes({ panelVista: vista });
  if (!esIndice) irAMiniaturaActual(true);
}

tabMiniaturas.addEventListener('click', () => cambiarVista('miniaturas'));
tabIndice.addEventListener('click', () => cambiarVista('indice'));

// Flechas ← → para cambiar de pestaña con el teclado.
for (const tab of [tabMiniaturas, tabIndice]) {
  tab.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const otra = tab === tabMiniaturas ? tabIndice : tabMiniaturas;
    cambiarVista(otra === tabIndice ? 'indice' : 'miniaturas');
    otra.focus();
  });
}

// --- Miniaturas (se pintan solo cuando se acercan, de una en una) ---

const infoMini = new Map();        // botón → {page, viewport}
let colaMini = Promise.resolve();  // cola: una miniatura cada vez, sin atascar el PDF

const observadorMini = new IntersectionObserver((entradas) => {
  for (const entrada of entradas) {
    if (!entrada.isIntersecting) continue;
    observadorMini.unobserve(entrada.target);
    const boton = entrada.target;
    colaMini = colaMini.then(() => pintarMiniatura(boton)).catch(() => { /* ya se reintenta */ });
  }
}, { root: elListaMini, rootMargin: '400px' });

/** Crea la miniatura (vacía) de una página; se pinta al acercarse. */
function crearMiniatura(page, vp1, numero) {
  const viewport = page.getViewport({ scale: ANCHO_MINI / vp1.width });
  const boton = document.createElement('button');
  boton.className = 'mini';
  boton.title = 'Ir a la página ' + numero;
  boton.setAttribute('aria-label', 'Ir a la página ' + numero);

  const marco = document.createElement('span');
  marco.className = 'marco';
  marco.style.width = Math.round(viewport.width) + 'px';
  marco.style.height = Math.round(viewport.height) + 'px';

  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(numero);

  boton.appendChild(marco);
  boton.appendChild(num);
  boton.addEventListener('click', () => irAPagina(numero - 1));
  elListaMini.appendChild(boton);

  miniaturas.push(boton);
  infoMini.set(boton, { page, viewport });
  observadorMini.observe(boton);
}

async function pintarMiniatura(boton) {
  const info = infoMini.get(boton);
  if (!info || boton.dataset.pintada) return;
  boton.dataset.pintada = '1';
  const canvas = document.createElement('canvas');
  // 1.5× basta para que se vea nítida sin gastar el doble de memoria que 2×.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.floor(info.viewport.width * dpr);
  canvas.height = Math.floor(info.viewport.height * dpr);
  try {
    await info.page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: info.viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    }).promise;
    const marco = boton.querySelector('.marco');
    if (marco) marco.appendChild(canvas);
    observadorSoltar.observe(boton);   // vigilar para liberarla si se aleja
  } catch (e) {
    delete boton.dataset.pintada;      // si vuelve a acercarse, se reintenta
    observadorMini.observe(boton);
  }
}

// Con PDFs de cientos de páginas, guardar TODAS las miniaturas pintadas se
// comería la memoria: las que quedan muy lejos de la vista se sueltan y se
// vuelven a pintar solas si el usuario regresa.
const observadorSoltar = new IntersectionObserver((entradas) => {
  for (const entrada of entradas) {
    if (!entrada.isIntersecting) soltarMiniatura(entrada.target);
  }
}, { root: elListaMini, rootMargin: '1200px' });

function soltarMiniatura(boton) {
  if (!boton.dataset.pintada) return;
  const canvas = boton.querySelector('canvas');
  if (canvas) {
    canvas.width = 0;          // libera el búfer de píxeles de inmediato
    canvas.height = 0;
    canvas.remove();
  }
  delete boton.dataset.pintada;
  observadorSoltar.unobserve(boton);
  observadorMini.observe(boton);
}

// --- Navegación e indicador de página ---

/** Lleva la vista a una página (0-based), opcionalmente a una altura concreta. */
function irAPagina(indice, offsetY) {
  const div = paginasDom[indice];
  if (!div) return;
  const rectZona = elZona.getBoundingClientRect();
  const rect = div.getBoundingClientRect();
  const destino = elZona.scrollTop + (rect.top - rectZona.top) - 12 + (offsetY || 0);
  elZona.scrollTo({ top: Math.max(0, destino), behavior: comportamientoScroll() });
}

/** Recalcula dónde empieza cada página (al cargar o al redimensionar). */
function recalcularTops() {
  const rectZona = elZona.getBoundingClientRect();
  const s = elZona.scrollTop;
  topsPaginas = paginasDom.map((d) => d.getBoundingClientRect().top - rectZona.top + s);
}

/** Detecta qué página se está viendo (la que ocupa el tercio superior). */
function actualizarPaginaActual() {
  if (!topsPaginas.length) return;
  const referencia = elZona.scrollTop + elZona.clientHeight * 0.35;
  let lo = 0;
  let hi = topsPaginas.length - 1;
  let encontrada = 0;
  while (lo <= hi) {                       // búsqueda binaria: va fina con PDFs enormes
    const m = (lo + hi) >> 1;
    if (topsPaginas[m] <= referencia) { encontrada = m; lo = m + 1; } else hi = m - 1;
  }
  if (encontrada === paginaActual) return;
  paginaActual = encontrada;
  pintarPaginaActual();
}

/**
 * Refleja la página actual en el indicador, las miniaturas y el índice.
 * Solo toca las dos miniaturas implicadas (la que deja de estar activa y la
 * nueva): así da igual que el PDF tenga 10 páginas o 2.000.
 */
let miniMarcada = null;
function pintarPaginaActual() {
  elPagActual.textContent = paginasDom.length
    ? (paginaActual + 1) + ' / ' + paginasDom.length
    : '—';
  if (miniMarcada) {
    miniMarcada.classList.remove('actual');
    miniMarcada.removeAttribute('aria-current');
  }
  const nueva = miniaturas[paginaActual] || null;
  if (nueva) {
    nueva.classList.add('actual');
    nueva.setAttribute('aria-current', 'page');
  }
  miniMarcada = nueva;
  irAMiniaturaActual(false);
  marcarIndiceActual();
}

/** Mantiene a la vista la miniatura de la página actual dentro del panel. */
function irAMiniaturaActual(forzar) {
  if (elPanel.classList.contains('oculto') || elListaMini.classList.contains('oculto')) return;
  const boton = miniaturas[paginaActual];
  if (!boton) return;
  const rl = elListaMini.getBoundingClientRect();
  const rb = boton.getBoundingClientRect();
  if (forzar || rb.top < rl.top || rb.bottom > rl.bottom) {
    boton.scrollIntoView({ block: 'nearest', behavior: forzar ? 'auto' : comportamientoScroll() });
  }
}

// El scroll del documento manda: actualizamos como mucho una vez por fotograma.
let pendienteScroll = false;
elZona.addEventListener('scroll', () => {
  if (pendienteScroll) return;
  pendienteScroll = true;
  requestAnimationFrame(() => {
    pendienteScroll = false;
    actualizarPaginaActual();
  });
}, { passive: true });

// Medir cuesta caro: se recalcula una sola vez cuando todo se ha asentado.
let timerTops = null;
function programarRecalculo(espera) {
  clearTimeout(timerTops);
  timerTops = setTimeout(() => {
    recalcularTops();
    actualizarPaginaActual();
  }, espera || 80);
}

window.addEventListener('resize', () => programarRecalculo(150));

// El aviso de estado flota SOBRE el documento y lo empuja hacia abajo: al
// aparecer o desaparecer (p. ej. "Descargando voz…") las páginas se mueven, así
// que hay que volver a medir dónde empieza cada una.
try {
  const vigilante = new ResizeObserver(() => programarRecalculo());
  vigilante.observe(elEstado);
  vigilante.observe(elVisor);
} catch (e) { /* sin ResizeObserver nos apañamos con el resize de la ventana */ }

// --- Índice (marcadores del PDF) ---

/** Construye el índice del documento en el panel. */
async function construirIndice(doc) {
  elListaIndice.innerHTML = '';
  indicePlano = [];
  let esquema = null;
  try { esquema = await doc.getOutline(); } catch (e) { esquema = null; }

  if (!esquema || !esquema.length) {
    const aviso = document.createElement('p');
    aviso.className = 'panel-vacio';
    aviso.textContent = 'Este PDF no trae índice: su autor no incluyó marcadores de ' +
      'capítulos ni apartados. Usa la vista Páginas para moverte por el documento.';
    elListaIndice.appendChild(aviso);
    return;
  }
  agregarNodosIndice(esquema, elListaIndice, 0);
  resolverPaginasIndice(doc);   // en segundo plano: saber a qué página va cada entrada
}

/** Añade (recursivamente) las entradas del índice, con plegado por niveles. */
function agregarNodosIndice(items, contenedor, nivel) {
  for (const item of items) {
    const fila = document.createElement('div');
    fila.className = 'idx-fila';
    fila.style.paddingLeft = (nivel * 12) + 'px';

    const tieneHijos = !!(item.items && item.items.length);
    const chev = document.createElement('button');
    chev.className = 'idx-chev' + (tieneHijos ? '' : ' hueco');
    chev.textContent = tieneHijos ? (nivel === 0 ? '▾' : '▸') : '•';
    if (tieneHijos) {
      chev.title = 'Desplegar o plegar este apartado';
      chev.setAttribute('aria-expanded', nivel === 0 ? 'true' : 'false');
    } else {
      chev.tabIndex = -1;
      chev.setAttribute('aria-hidden', 'true');
    }

    const titulo = document.createElement('button');
    titulo.className = 'idx-titulo';
    titulo.textContent = String(item.title || '').trim() || '(sin título)';
    titulo.title = titulo.textContent;
    titulo.addEventListener('click', () => irADestino(item.dest));

    fila.appendChild(chev);
    fila.appendChild(titulo);
    contenedor.appendChild(fila);
    indicePlano.push({ fila, dest: item.dest, pagina: null });

    if (tieneHijos) {
      const hijos = document.createElement('div');
      hijos.className = 'idx-hijos' + (nivel === 0 ? '' : ' oculto');
      contenedor.appendChild(hijos);
      agregarNodosIndice(item.items, hijos, nivel + 1);
      chev.addEventListener('click', () => {
        const plegado = hijos.classList.toggle('oculto');
        chev.textContent = plegado ? '▸' : '▾';
        chev.setAttribute('aria-expanded', plegado ? 'false' : 'true');
      });
    }
  }
}

/** Página (0-based) a la que apunta un destino del PDF, o null. */
async function paginaDeDestino(doc, dest) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await doc.getDestination(d);
    if (!Array.isArray(d) || !d.length) return null;
    const ref = d[0];
    if (typeof ref === 'number') return ref;
    return await doc.getPageIndex(ref);
  } catch (e) {
    return null;
  }
}

/** Averigua en segundo plano a qué página va cada entrada del índice. */
async function resolverPaginasIndice(doc) {
  const mias = indicePlano;   // si se abre otro PDF, esta lista deja de valer
  await Promise.all(mias.map(async (entrada) => {
    const pagina = await paginaDeDestino(doc, entrada.dest);
    if (mias === indicePlano) entrada.pagina = pagina;
  }));
  if (mias === indicePlano) marcarIndiceActual();
}

/** Resalta en el índice el apartado en el que estás (solo mueve la marca). */
let filaIndiceMarcada = null;
function marcarIndiceActual() {
  if (!indicePlano.length) return;
  let actual = null;
  for (let i = 0; i < indicePlano.length; i++) {
    const p = indicePlano[i].pagina;
    if (p !== null && p !== undefined && p <= paginaActual) actual = indicePlano[i].fila;
  }
  if (actual === filaIndiceMarcada) return;
  if (filaIndiceMarcada) filaIndiceMarcada.classList.remove('actual');
  if (actual) actual.classList.add('actual');
  filaIndiceMarcada = actual;
}

/** Navega a un destino del índice (respetando la altura exacta si la indica). */
async function irADestino(dest) {
  if (!pdfDoc) return;
  try {
    let d = dest;
    if (typeof d === 'string') d = await pdfDoc.getDestination(d);
    if (!Array.isArray(d) || !d.length) return;
    const ref = d[0];
    const pagina = typeof ref === 'number' ? ref : await pdfDoc.getPageIndex(ref);

    // Muchos destinos indican también el punto vertical dentro de la página.
    let offsetY = 0;
    const modo = d[1] && d[1].name;
    const y = modo === 'XYZ' ? d[3] : ((modo === 'FitH' || modo === 'FitBH') ? d[2] : null);
    const info = paginasInfo[pagina];
    if (info && typeof y === 'number') {
      try {
        const punto = info.viewport.convertToViewportPoint(0, y);
        if (punto && isFinite(punto[1])) offsetY = Math.max(0, punto[1]);
      } catch (e) { /* sin ajuste fino: al principio de la página */ }
    }
    irAPagina(pagina, offsetY);
  } catch (e) { /* destino ilegible: no movemos la vista */ }
}

/** Vacía el panel al abrir otro PDF. */
function reiniciarPanel() {
  observadorMini.disconnect();
  observadorSoltar.disconnect();
  infoMini.clear();
  miniaturas.length = 0;
  paginasDom.length = 0;
  paginasInfo.length = 0;
  topsPaginas = [];
  indicePlano = [];
  paginaActual = -1;
  miniMarcada = null;
  filaIndiceMarcada = null;
  pdfDoc = null;
  elListaMini.innerHTML = '';
  elListaIndice.innerHTML = '';
  elPagActual.textContent = '—';
}

// ---- Qué se lee y qué se salta ---------------------------------------------
//
// En un PDF, la cabecera, el pie, el número de página y el pie de una figura
// son trozos de texto como cualquier otro: si no se filtran, la voz suelta un
// "17" en mitad de una frase o repite el título del libro en cada hoja.
//
// Cabeceras, pies y números se detectan por DOS señales, para no comerse nunca
// contenido de verdad:
//   1. Están en el margen de arriba o de abajo de la página (8%), y además
//   2. o bien parecen un número de página, o bien se REPITEN en varias páginas
//      (que es justo lo que hace una cabecera o un pie corrido).
// Los pies de imagen se detectan aparte, por cómo empiezan ("Figura 3. …").
//
// Cada tipo se salta o se lee según los ajustes del usuario (OPCIONES_LECTURA).

const MARGEN_BORDE = 0.08;   // 8% superior e inferior de cada página

// Cómo empieza el pie de una figura, tabla, foto o esquema: la palabra que lo
// nombra y SU NÚMERO (arábigo o romano). Va anclado al principio de la línea,
// así que "…como se ve en la Figura 1" (texto normal) no cuenta; y detrás del
// número no puede venir una letra, para que "Cuadro clínico" o "Figuras
// retóricas" no se confundan con un pie.
const MARCA_PIE_IMAGEN = new RegExp(
  '^\\s*(?:fig(?:ura|\\.)?|figure|tab(?:la|le|\\.)?|cuadro|gr[áa]fic[oa]|graph|chart|' +
  'imagen|image|foto(?:graf[íi]a)?|photo|ilustraci[óo]n|illustration|esquema|' +
  'diagrama|diagram|mapa|l[áa]mina|plate|anexo|exhibit)' +
  '\\s*\\.?\\s*' +
  '(?:\\d{1,3}(?:[.-]\\d{1,3})*' +                                    // 3, 2.1, 4-2
  '|(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))' +
  '(?![\\p{L}\\d])',
  'iu'
);

/** ¿Esta línea arranca un pie de imagen, figura o tabla? */
function esPieDeImagen(txt) {
  const t = String(txt).replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return MARCA_PIE_IMAGEN.test(t);
}

/**
 * Agrupa los trozos de una página en LÍNEAS, por su altura en la hoja. Los
 * pies de imagen hay que mirarlos línea a línea: pdf.js parte el texto en
 * trozos sueltos y "Figura" y "3." pueden venir separados.
 */
function agruparEnLineas(items) {
  const lineas = [];
  let actual = null;
  for (const item of items) {
    const y = item.transform && item.transform[5];
    if (typeof y !== 'number' || !item.str) continue;
    const alto = Math.max(item.height || 0, 6);
    if (actual && Math.abs(actual.y - y) <= alto * 0.6) {
      actual.items.push(item);
      actual.texto += item.str;
    } else {
      actual = { y, alto, items: [item], texto: String(item.str) };
      lineas.push(actual);
    }
  }
  return lineas;
}

/**
 * Marca los pies de imagen de UNA página. El pie empieza en la línea que trae
 * la marca ("Figura 3.") y sigue mientras las líneas vayan pegadas y con la
 * misma letra: un pie suele ocupar dos o tres renglones. Se corta en cuanto la
 * frase cierra con punto, para no tragarse el párrafo que viene detrás.
 */
function marcarPiesDeImagen(pg) {
  const lineas = agruparEnLineas(pg.items);
  for (let i = 0; i < lineas.length; i++) {
    if (!esPieDeImagen(lineas[i].texto)) continue;
    const alto = lineas[i].alto;
    let j = i;
    while (j < lineas.length) {
      for (const it of lineas[j].items) pg.omitir.add(it);
      if (/[.!?]["»)\]]?\s*$/.test(lineas[j].texto)) break;  // el pie ya cerró
      if (j - i >= 3) break;                                 // como mucho 4 líneas
      const sig = lineas[j + 1];
      if (!sig) break;
      const salto = Math.abs(lineas[j].y - sig.y);
      const mismaLetra = Math.abs((sig.alto || 0) - alto) <= 1;
      if (salto > alto * 1.9 || !mismaLetra) break;
      j++;
    }
    i = j;
  }
}

/** ¿Este texto suelto parece un número de página? */
function esNumeroDePagina(txt) {
  const t = String(txt).replace(/\s+/g, ' ').trim();
  if (!t || t.length > 24) return false;
  // Quitamos adornos típicos: - 12 -, [12], (12), | 12 |
  const nucleo = t.replace(/^[[({\-–—|.\s]+/, '').replace(/[\])}\-–—|.\s]+$/, '').trim();
  if (!nucleo) return false;
  if (/^\d{1,4}$/.test(nucleo)) return true;                              // 12
  if (/^p[áa]g(ina)?\.?\s*\d{1,4}$/i.test(nucleo)) return true;           // Página 12
  if (/^\d{1,4}\s*(de|\/|of)\s*\d{1,4}$/i.test(nucleo)) return true;      // 12 de 30
  // Números romanos (i, iv, XII…), habituales en prólogos e índices.
  if (nucleo.length <= 7 &&
      /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(nucleo)) return true;
  return false;
}

/**
 * Marca en cada página (`pg.omitir`) los trozos que NO se deben leer, según lo
 * que el usuario haya elegido en "Qué se lee".
 *
 * `paginas`  = [{items, alto}], donde `alto` es la altura de la página.
 * `opciones` = {leerNumerosPagina, leerCabeceras, leerPies, leerPiesImagen};
 *              lo que falte se toma como `false` (se salta).
 */
function marcarQueNoSeLee(paginas, opciones) {
  const op = opciones || {};
  const conteo = new Map();   // "zona|texto sin cifras" → en cuántas páginas sale
  const candidatos = [];

  for (const pg of paginas) {
    pg.omitir = new Set();
    const vistosAqui = new Set();
    if (!pg.alto) continue;
    for (const item of pg.items) {
      const txt = String(item.str || '').trim();
      const y = item.transform && item.transform[5];
      if (!txt || typeof y !== 'number') continue;
      const zona = y >= pg.alto * (1 - MARGEN_BORDE) ? 'cabecera'
        : (y <= pg.alto * MARGEN_BORDE ? 'pie' : null);
      if (!zona) continue;
      // Al comparar entre páginas ignoramos las cifras: así "Capítulo 3 — 15"
      // y "Capítulo 3 — 16" cuentan como la misma cabecera.
      const clave = zona + '|' + txt.replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase();
      candidatos.push({ pg, item, clave, txt, zona });
      if (!vistosAqui.has(clave)) {
        vistosAqui.add(clave);
        conteo.set(clave, (conteo.get(clave) || 0) + 1);
      }
    }
  }

  // Con 4 páginas o más pedimos 3 repeticiones; con 2 o 3, dos. Con una sola
  // página no hay repetición que valga: solo cuenta si es un número.
  const repesNecesarias = paginas.length >= 4 ? 3 : 2;
  for (const c of candidatos) {
    const repetido = paginas.length >= 2 && (conteo.get(c.clave) || 0) >= repesNecesarias;
    // Un "17" suelto es un número de página esté donde esté: manda sobre la
    // clasificación por zona.
    let salta;
    if (esNumeroDePagina(c.txt)) salta = !op.leerNumerosPagina;
    else if (!repetido) salta = false;                       // texto de verdad
    else salta = c.zona === 'cabecera' ? !op.leerCabeceras : !op.leerPies;
    if (salta) c.pg.omitir.add(c.item);
  }

  if (!op.leerPiesImagen) {
    for (const pg of paginas) marcarPiesDeImagen(pg);
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
  documentoAbierto = null;
  infoPaginas.clear();
  reiniciarPanel();
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
  pdfDoc = documento;   // lo usa el índice del panel para resolver destinos

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

    // Panel lateral: apuntamos la página y creamos su miniatura.
    paginasDom.push(divPag);
    paginasInfo.push({ page, viewport });
    crearMiniatura(page, vp1, p);

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
    paginas.push({ items: contenido.items, nodos, coincide, alto: vp1.height });
  }

  // El panel ya puede navegar (aunque el PDF luego resulte no tener texto).
  recalcularTops();
  paginaActual = -1;
  actualizarPaginaActual();
  construirIndice(documento);

  // El documento queda guardado: si cambian los ajustes de "qué se lee" hay
  // que rehacer el texto sin volver a renderizar nada.
  documentoAbierto = { paginas, hayTextLayer, numPaginas: documento.numPages };

  if (!montarVista()) return;
  motor.iniciar(vista.textos, 0);
}

/**
 * Rehace `vista` (texto, mapa de posiciones y cortes) a partir del documento ya
 * cargado, aplicando los ajustes de "qué se lee". Devuelve `false` y deja un
 * aviso en pantalla si el PDF no da texto que leer.
 */
function montarVista() {
  if (!documentoAbierto) return false;
  const { paginas, hayTextLayer, numPaginas } = documentoAbierto;

  // Fuera lo que el usuario no quiera oír (cabeceras, pies, números, pies de
  // imagen). Se recalcula entero: los ajustes pueden haber cambiado.
  marcarQueNoSeLee(paginas, motor.ajustes);

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
      // OJO: el contador de nodos avanza SIEMPRE, también con los trozos que no
      // se leen; si no, la capa de texto y el resaltado se desalinearían.
      const indiceNodo = iNodo++;
      if (pg.omitir.has(item)) continue;   // algo que el usuario no quiere oír
      // Un salto vertical grande entre líneas = párrafo nuevo.
      if (previo) {
        const dy = Math.abs(previo.transform[5] - item.transform[5]);
        const alto = Math.max(previo.height || 0, item.height || 0, 8);
        if (dy > alto * 1.7) cortes.push(texto.length);
      }
      // Hueco "virtual": espacio para hablar que no existe en el DOM del PDF.
      if (texto.length && !/\s$/.test(texto) && !/^\s/.test(item.str)) texto += ' ';
      if (resaltable) {
        const seg = { nodo: pg.nodos[indiceNodo], desde: 0, hasta: item.str.length, ini: texto.length };
        mapa.push(seg);
        porNodo.set(seg.nodo, seg);
      }
      texto += item.str;
      previo = item;
    }
  }

  // PDF escaneado: se puede VER, pero no hay texto que leer.
  if (texto.trim().length < Math.max(60, numPaginas * 20)) {
    estado(
      'Este PDF parece escaneado: se puede ver, pero no tiene capa de texto que ' +
      'leer en voz alta. Haría falta OCR (reconocimiento óptico), que esta versión no incluye.',
      true
    );
    return false;
  }

  const rangos = LectorTTS.trocearRangos(texto, cortes)
    .filter((r) => texto.slice(r.ini, r.fin).trim());
  if (!rangos.length) {
    estado('No se encontró texto legible en el PDF.', true);
    return false;
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
  return true;
}

/**
 * Vuelve a montar el documento porque han cambiado los ajustes de "qué se lee",
 * y retoma en la misma frase: la busca por su texto, porque el cuerpo no cambia
 * — solo aparecen o desaparecen cabeceras, pies, números y pies de imagen.
 * Si la lectura estaba parada, sigue parada: no arranca sola.
 */
function reconstruirLectura() {
  if (!documentoAbierto) return;
  const pista = String(motor.oraciones[motor.indice] || '').trim().slice(0, 40);
  const indicePrevio = motor.indice;
  const sonando = motor.leyendo && !motor.enPausa;

  limpiarResaltado();
  if (!montarVista()) return;

  let idx = Math.min(indicePrevio, vista.textos.length - 1);
  if (pista) {
    const j = vista.textos.findIndex((t) => t.trim().startsWith(pista));
    if (j >= 0) idx = j;
  }
  if (sonando) motor.iniciar(vista.textos, idx);
  else motor.cargar(vista.textos, idx);
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
