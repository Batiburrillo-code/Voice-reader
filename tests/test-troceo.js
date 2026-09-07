// Pruebas del troceador de oraciones de speech-engine.js (se ejecutan con Node,
// fuera del navegador). Uso:  node tests/test-troceo.js
'use strict';
const fs = require('fs');
const path = require('path');
const rutaMotor = path.join(__dirname, '..', 'speech-engine.js');
eval(fs.readFileSync(rutaMotor, 'utf8')); // define globalThis.LectorTTS (sin window ni chrome)

const { trocearEnOraciones, trocearRangos, esVozNeural, idPiper, OPCIONES_LECTURA,
  AJUSTES_DEFECTO, VOCES_NEURALES, normalizarTema, aplicarTema } = globalThis.LectorTTS;
let fallos = 0;

function caso(nombre, texto, comprobaciones) {
  const res = trocearEnOraciones(texto);
  const todasOk = comprobaciones.every(([desc, fn]) => {
    const ok = fn(res);
    if (!ok) { console.log(`  ✗ ${desc}`); fallos++; }
    return ok;
  });
  console.log(`${todasOk ? '✓' : '✗'} ${nombre} → ${res.length} oraciones`);
  if (!todasOk) console.log('   resultado:', JSON.stringify(res, null, 1));
}

// 1. Texto normal en español
caso('Texto normal',
  'El sol salió temprano aquella mañana de primavera en el pequeño pueblo. Los pájaros cantaban en los árboles del parque central mientras la gente paseaba. ¿Quién podría imaginar lo que estaba a punto de suceder en aquel lugar tan tranquilo? Nadie lo sabía.',
  [
    ['al menos 2 oraciones', r => r.length >= 2],
    ['ninguna supera 250 chars', r => r.every(o => o.length <= 251)],
    ['no se pierde texto significativo', r => r.join(' ').length > 200]
  ]);

// 2. Abreviaturas: no debe cortar en "Sr." dejando migas sueltas
caso('Abreviaturas (Sr., EE. UU.)',
  'El Sr. Pérez viajó a los EE. UU. la semana pasada para visitar a su familia que vive allí desde hace muchos años y no pudo regresar.',
  [
    ['fragmentos cortos unidos (ninguno < 30 chars)', r => r.every(o => o.length >= 30 || r.length === 1)]
  ]);

// 3. Oración larguísima (> 250): debe partirse
const larga = 'Esta es una oración extremadamente larga que sigue y sigue sin parar, ' +
  'añadiendo cláusulas y más cláusulas, con comas por todas partes, hablando de cosas variadas como el clima, ' +
  'la economía, los viajes, la gastronomía regional, las costumbres locales, la historia antigua y moderna, ' +
  'los avances tecnológicos recientes y muchas otras cuestiones de interés general para el lector curioso.';
caso('Oración > 250 caracteres', larga, [
  ['se parte en varias', r => r.length >= 2],
  ['ningún trozo > 251 chars', r => r.every(o => o.length <= 251)],
  ['no se pierde texto', r => Math.abs(r.join(' ').replace(/\s+/g, ' ').length - larga.length) < 10]
]);

// 4. Texto sin espacios ni puntuación (URL kilométrica): corte duro, sin bucle infinito
caso('Sin espacios (corte duro)', 'x'.repeat(900), [
  ['se parte', r => r.length >= 3],
  ['ningún trozo > 251', r => r.every(o => o.length <= 251)]
]);

// 5. Vacíos y espacios
caso('Cadena vacía', '', [['devuelve []', r => r.length === 0]]);
caso('Solo espacios', '   \n\t  ', [['devuelve []', r => r.length === 0]]);

// 6. Puntos suspensivos y exclamaciones
caso('Puntuación variada',
  '¡Qué sorpresa tan grande nos llevamos todos aquel día inolvidable! ¿En serio no lo sabías todavía, después de tanto tiempo? Pues así fue… Nadie dijo nada más durante el resto de la tarde.',
  [
    ['varias oraciones', r => r.length >= 2],
    ['conserva el texto', r => r.join(' ').includes('sorpresa')]
  ]);

// 7. Saltos de línea y espacios repetidos (texto típico de PDF)
caso('Texto de PDF con saltos',
  'Primera   línea\ndel documento con   espacios raros.\n\nSegunda parte del texto que continúa aquí con más contenido para superar el mínimo.\n',
  [
    ['espacios normalizados', r => r.every(o => !/\s{2,}/.test(o) && !o.includes('\n'))]
  ]);

// ---- Pruebas de trocearRangos (posiciones + cortes de bloque) ----

function casoRangos(nombre, texto, cortes, comprobaciones) {
  const res = trocearRangos(texto, cortes);
  const todasOk = comprobaciones.every(([desc, fn]) => {
    const ok = fn(res);
    if (!ok) { console.log(`  ✗ ${desc}`); fallos++; }
    return ok;
  });
  console.log(`${todasOk ? '✓' : '✗'} [rangos] ${nombre} → ${res.length} rangos`);
  if (!todasOk) console.log('   resultado:', JSON.stringify(res));
}

// 8. Los rangos apuntan a posiciones reales y ordenadas del texto
const textoR = 'El primer párrafo del artículo cuenta una historia bastante interesante. Y sigue un poco más aquí.';
casoRangos('Posiciones válidas y ordenadas', textoR, [], [
  ['todas dentro del texto', r => r.every(o => o.ini >= 0 && o.fin <= textoR.length && o.ini < o.fin)],
  ['ordenadas y sin solaparse', r => r.every((o, i) => i === 0 || o.ini >= r[i - 1].fin)],
  ['reconstruyen el contenido', r => r.map(o => textoR.slice(o.ini, o.fin)).join('').replace(/\s+/g, ' ').trim().length >= textoR.replace(/\s+/g, ' ').trim().length - 2]
]);

// 9. Un corte de bloque (título + párrafo sin punto) no se puede cruzar
const titulo = 'Introducción a la astronomía moderna';
const parrafo = 'La astronomía estudia los cuerpos celestes del universo y sus movimientos a lo largo del tiempo.';
const textoBloques = titulo + parrafo; // pegados, como saldrían de dos bloques HTML
casoRangos('Corte de bloque título/párrafo', textoBloques, [titulo.length], [
  ['ninguna oración cruza el corte', r => r.every(o => o.fin <= titulo.length || o.ini >= titulo.length)],
  ['el título queda como oración propia', r => r.some(o => textoBloques.slice(o.ini, o.fin).trim() === titulo)]
]);

// 10. Utilidades de voces neuronales
const okNeural = esVozNeural('piper:es_ES-davefx-medium') === true
  && esVozNeural('Microsoft Helena') === false
  && esVozNeural('') === false
  && idPiper('piper:es_MX-claude-high') === 'es_MX-claude-high';
console.log((okNeural ? '✓' : '✗') + ' utilidades esVozNeural/idPiper');
if (!okNeural) fallos++;

// 11. "Qué se lee": cada opción tiene su ajuste por defecto y su etiqueta
const okOpciones = Array.isArray(OPCIONES_LECTURA)
  && OPCIONES_LECTURA.length === 4
  && OPCIONES_LECTURA.every((o) =>
    typeof o.clave === 'string' && o.clave.startsWith('leer')
    && typeof o.etiqueta === 'string' && o.etiqueta.length > 0
    && typeof o.ayuda === 'string' && o.ayuda.length > 0
    && typeof AJUSTES_DEFECTO[o.clave] === 'boolean')
  // Por defecto se sigue callando la morralla, y sí se leen los pies de imagen.
  && AJUSTES_DEFECTO.leerNumerosPagina === false
  && AJUSTES_DEFECTO.leerCabeceras === false
  && AJUSTES_DEFECTO.leerPies === false
  && AJUSTES_DEFECTO.leerPiesImagen === true
  // El tono se retiró en la v1.5: no debe quedar rastro en los ajustes.
  && !('tono' in AJUSTES_DEFECTO);
console.log((okOpciones ? '✓' : '✗') + ' OPCIONES_LECTURA y sus valores por defecto');
if (!okOpciones) fallos++;

// 12. Tema: solo hay dos, y cualquier basura cae en "oscuro" (el de fábrica)
const okTema = normalizarTema('claro') === 'claro'
  && normalizarTema('oscuro') === 'oscuro'
  && normalizarTema('') === 'oscuro'
  && normalizarTema(undefined) === 'oscuro'
  && normalizarTema('AZUL') === 'oscuro'
  && AJUSTES_DEFECTO.tema === 'oscuro'
  // Sin document ni localStorage (aquí, en Node) no debe reventar: solo devuelve.
  && aplicarTema('claro') === 'claro';
console.log((okTema ? '✓' : '✗') + ' tema claro/oscuro (normalizar y aplicar sin DOM)');
if (!okTema) fallos++;

// 12. Catálogo de voces neuronales: ids bien formados y voces latinas presentes
const ids = VOCES_NEURALES.map(v => v.id);
const okVoces = VOCES_NEURALES.every(v => v.id.startsWith('piper:') && typeof v.etiqueta === 'string' && v.etiqueta.length > 0)
  && new Set(ids).size === ids.length                       // sin duplicados
  && ids.includes('piper:es_MX-claude-high')                // México
  && ids.includes('piper:es_MX-ald-medium')                 // México
  && ids.includes('piper:es_AR-daniela-high')               // Argentina (latino, vía rhasspy)
  && ids.filter(id => id.startsWith('piper:en_')).length >= 5; // varias en inglés
console.log((okVoces ? '✓' : '✗') + ` catálogo VOCES_NEURALES (${ids.length} voces, sin duplicados)`);
if (!okVoces) fallos++;

// 13. voces-extra.js registra la voz argentina que no está en el mirror
const vocesExtra = fs.readFileSync(path.join(__dirname, '..', 'voces-extra.js'), 'utf8');
const okExtra = vocesExtra.includes("'es_AR-daniela-high'")
  && vocesExtra.includes('rhasspy/piper-voices/resolve/main')
  && vocesExtra.includes('registrarVocesExtra');
console.log((okExtra ? '✓' : '✗') + ' voces-extra.js registra es_AR-daniela desde rhasspy');
if (!okExtra) fallos++;

console.log(fallos === 0 ? '\nTODAS LAS PRUEBAS PASAN ✓' : `\n${fallos} COMPROBACIONES FALLAN ✗`);
process.exit(fallos === 0 ? 0 : 1);
