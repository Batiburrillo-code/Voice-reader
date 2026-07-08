/**
 * reader.js — Lector de PDFs de "Lector TTS".
 *
 * Los visores de PDF nativos de Chrome y Firefox NO aceptan content scripts,
 * así que esta página de la extensión hace el trabajo:
 *   1. Recibe la URL del PDF por el parámetro ?src=... (la pone el popup),
 *      o deja elegir un archivo local con el botón "📂 Abrir PDF…".
 *   2. Descarga el PDF con fetch y extrae el texto con pdf.js de Mozilla
 *      (empaquetada en libs/, sin CDN: la CSP de Manifest V3 prohíbe scripts remotos).
 *   3. Lee el texto con el MISMO motor de speech-engine.js que usan las
 *      páginas web, con resaltado por oración y palabra.
 */

// pdf.js v4 se distribuye como módulo ES; por eso este script es type="module".
import * as pdfjsLib from './libs/pdf.mjs';

// El "worker" de pdf.js debe cargarse desde DENTRO de la extensión.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.mjs');

// ---- Referencias a la interfaz -------------------------------------------
const elTitulo = document.getElementById('titulo');
const elEstado = document.getElementById('estado');
const elContenido = document.getElementById('contenido');
const elProgreso = document.getElementById('progreso');
const btnPausa = document.getElementById('btn-pausa');
const btnAnterior = document.getElementById('btn-anterior');
const btnSiguiente = document.getElementById('btn-siguiente');
const btnAbrir = document.getElementById('btn-abrir');
const inputArchivo = document.getElementById('input-archivo');
const selVoz = document.getElementById('sel-voz');
const rangoVel = document.getElementById('rango-vel');
const txtVel = document.getElementById('txt-vel');

// Motor de lectura compartido (speech-engine.js ya se cargó como script clásico).
const motor = LectorTTS.crearMotorLectura();
let oracionesActuales = [];

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

LectorTTS.cargarAjustes((ajustes) => {
  motor.ajustes = ajustes;
  rangoVel.value = String(ajustes.velocidad);
  txtVel.textContent = Number(ajustes.velocidad).toFixed(1) + '×';
  poblarVoces();
});

chrome.storage.onChanged.addListener((cambios, area) => {
  if (area !== 'sync') return;
  let cambiado = false;
  for (const clave of ['vozNombre', 'velocidad', 'tono']) {
    if (clave in cambios) {
      motor.ajustes[clave] = cambios[clave].newValue;
      cambiado = true;
    }
  }
  if (!cambiado) return;
  rangoVel.value = String(motor.ajustes.velocidad);
  txtVel.textContent = Number(motor.ajustes.velocidad).toFixed(1) + '×';
  if (motor.leyendo && !motor.enPausa) motor.saltarA(motor.indice);
});

// ---- Selector de voz (español primero) --------------------------------------

function poblarVoces() {
  const voces = LectorTTS.refrescarVoces();
  if (!voces.length) return; // llegarán con voiceschanged
  const esEspanola = (v) => v.lang && v.lang.toLowerCase().startsWith('es');
  const orden = (a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
  const espanolas = voces.filter(esEspanola).sort(orden);
  const otras = voces.filter((v) => !esEspanola(v)).sort(orden);

  selVoz.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '✨ Automática (español)';
  selVoz.appendChild(auto);
  for (const voz of espanolas.concat(otras)) {
    const op = document.createElement('option');
    op.value = voz.name;
    op.textContent = voz.name + ' (' + voz.lang + ')';
    selVoz.appendChild(op);
  }
  selVoz.value = motor.ajustes.vozNombre || '';
  if (selVoz.value !== (motor.ajustes.vozNombre || '')) selVoz.value = '';
}
speechSynthesis.addEventListener('voiceschanged', poblarVoces);

selVoz.addEventListener('change', () => {
  LectorTTS.guardarAjustes({ vozNombre: selVoz.value });
});

let temporizadorVel = null;
rangoVel.addEventListener('input', () => {
  txtVel.textContent = Number(rangoVel.value).toFixed(1) + '×';
  clearTimeout(temporizadorVel);
  temporizadorVel = setTimeout(() => {
    LectorTTS.guardarAjustes({ velocidad: parseFloat(rangoVel.value) });
  }, 250);
});

// ---- Botones de transporte ---------------------------------------------------

btnPausa.addEventListener('click', () => {
  if (!motor.leyendo && oracionesActuales.length) motor.iniciar(oracionesActuales, 0);
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

// ---- Resaltado (igual que en el panel de content.js) --------------------------

function prepararPalabras(span) {
  if (span.dataset.conPalabras) return;
  const texto = span.textContent;
  span.textContent = '';
  let pos = 0;
  for (const trozo of texto.split(/(\s+)/)) {
    if (!trozo) continue;
    if (/^\s+$/.test(trozo)) {
      span.appendChild(document.createTextNode(trozo));
    } else {
      const w = document.createElement('span');
      w.className = 'palabra';
      w.dataset.ini = String(pos);
      w.textContent = trozo;
      span.appendChild(w);
    }
    pos += trozo.length;
  }
  span.dataset.conPalabras = '1';
}

motor.alEmpezarOracion = (i) => {
  const previa = elContenido.querySelector('.oracion.actual');
  if (previa) {
    previa.classList.remove('actual');
    const palabraVieja = previa.querySelector('.palabra-actual');
    if (palabraVieja) palabraVieja.classList.remove('palabra-actual');
  }
  const span = elContenido.querySelector(`.oracion[data-i="${i}"]`);
  if (!span) return;
  span.classList.add('actual');
  prepararPalabras(span);
  span.scrollIntoView({ behavior: 'smooth', block: 'center' });
  elProgreso.textContent = (i + 1) + ' / ' + oracionesActuales.length;
};

motor.alPalabra = (i, charIndex) => {
  const span = elContenido.querySelector(`.oracion[data-i="${i}"]`);
  if (!span || !span.dataset.conPalabras) return;
  let objetivo = null;
  span.querySelectorAll('.palabra').forEach((w) => {
    if (Number(w.dataset.ini) <= charIndex) objetivo = w;
  });
  const previa = span.querySelector('.palabra-actual');
  if (previa && previa !== objetivo) previa.classList.remove('palabra-actual');
  if (objetivo) objetivo.classList.add('palabra-actual');
};

motor.alCambiarEstado = (est) => {
  btnPausa.textContent = est.leyendo && !est.enPausa ? '⏸' : '▶';
};

motor.alTerminar = () => {
  const actual = elContenido.querySelector('.oracion.actual');
  if (actual) actual.classList.remove('actual');
  elProgreso.textContent = 'Fin ✓';
};

// ---- Carga y lectura del PDF ---------------------------------------------------

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

/** Extrae el texto del PDF con pdf.js y arranca la lectura. */
async function procesarPdf(datos, nombre) {
  motor.detener();
  elContenido.innerHTML = '';
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

  // Extraer el texto página a página.
  let texto = '';
  for (let p = 1; p <= documento.numPages; p++) {
    estado('Extrayendo texto… página ' + p + ' de ' + documento.numPages);
    const pagina = await documento.getPage(p);
    const contenido = await pagina.getTextContent();
    // hasEOL marca los saltos de línea reales del documento.
    let textoPagina = '';
    for (const item of contenido.items) {
      textoPagina += item.str + (item.hasEOL ? '\n' : ' ');
    }
    texto += textoPagina + '\n';
  }

  // PDF escaneado: hay páginas pero casi ningún carácter de texto.
  if (texto.trim().length < Math.max(60, documento.numPages * 20)) {
    estado(
      'Este PDF parece escaneado: no tiene capa de texto que se pueda leer. ' +
      'Haría falta OCR (reconocimiento óptico), que esta versión no incluye.',
      true
    );
    return;
  }

  // Trocear, pintar y leer con el motor compartido.
  const oraciones = LectorTTS.trocearEnOraciones(texto);
  if (!oraciones.length) {
    estado('No se encontró texto legible en el PDF.', true);
    return;
  }
  oracionesActuales = oraciones;
  ocultarEstado();
  for (let i = 0; i < oraciones.length; i++) {
    const span = document.createElement('span');
    span.className = 'oracion';
    span.dataset.i = String(i);
    span.textContent = oraciones[i] + ' ';
    elContenido.appendChild(span);
  }
  motor.iniciar(oraciones, 0);
}

// Clic en cualquier oración = saltar a ella.
elContenido.addEventListener('click', (ev) => {
  const span = ev.target && ev.target.closest ? ev.target.closest('.oracion') : null;
  if (!span) return;
  const i = Number(span.dataset.i);
  if (motor.leyendo) motor.saltarA(i);
  else motor.iniciar(oracionesActuales, i);
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
