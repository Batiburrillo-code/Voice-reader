// Pruebas del filtro de cabeceras, pies y números de página del lector de PDF
// (reader.js). Comprueba que se callan esos trozos SIN comerse contenido real.
// Uso:  node tests/test-cabeceras.js
'use strict';
const fs = require('fs');
const path = require('path');

const fuente = fs.readFileSync(path.join(__dirname, '..', 'reader.js'), 'utf8');

/** Extrae el código de una función de reader.js (equilibrando llaves). */
function extraerFuncion(nombre) {
  const inicio = fuente.indexOf('function ' + nombre + '(');
  if (inicio < 0) throw new Error('No se encontró la función ' + nombre + ' en reader.js');
  let i = fuente.indexOf('{', inicio);
  let nivel = 0;
  for (let j = i; j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    else if (fuente[j] === '}') { nivel--; if (nivel === 0) return fuente.slice(inicio, j + 1); }
  }
  throw new Error('Función ' + nombre + ' mal cerrada');
}

const margen = fuente.match(/const MARGEN_BORDE = ([\d.]+)/);
if (!margen) throw new Error('No se encontró MARGEN_BORDE en reader.js');

// Cargamos las funciones reales del lector (misma fuente, sin duplicar lógica).
const sandbox = {};
new Function('caja',
  'const MARGEN_BORDE = ' + margen[1] + ';\n' +
  extraerFuncion('esNumeroDePagina') + '\n' +
  extraerFuncion('marcarCabecerasYPies') + '\n' +
  'caja.esNumeroDePagina = esNumeroDePagina;' +
  'caja.marcarCabecerasYPies = marcarCabecerasYPies;'
)(sandbox);
const { esNumeroDePagina, marcarCabecerasYPies } = sandbox;

let fallos = 0;
function comprobar(descripcion, condicion) {
  if (condicion) console.log('✓ ' + descripcion);
  else { console.log('✗ ' + descripcion); fallos++; }
}

// ---- 1. Reconocer números de página -----------------------------------------
for (const t of ['12', '  7 ', '- 12 -', '[12]', '(3)', 'Página 4', 'Pagina 4', 'pág. 9',
                 '12 de 30', '12/30', 'iv', 'XII', '| 5 |']) {
  comprobar('«' + t + '» se reconoce como número de página', esNumeroDePagina(t) === true);
}

// ---- 2. NO confundir texto normal con un número de página --------------------
for (const t of ['Introducción', 'Capítulo 3: el método', 'El resultado fue de 12 unidades',
                 'Se vendieron 4 de 30 casas ese año', '']) {
  comprobar('«' + t + '» NO se toma por número de página', esNumeroDePagina(t) === false);
}

// ---- 3. Documento típico: cabecera repetida + número de pie ------------------
const ALTO = 842;   // A4 en puntos
function item(str, y) { return { str, transform: [1, 0, 0, 1, 60, y], height: 12 }; }

const paginas = [];
for (let p = 1; p <= 5; p++) {
  paginas.push({
    alto: ALTO,
    items: [
      item('Manual del usuario', 800),                    // cabecera (repetida)
      item('Texto del cuerpo de la página ' + p + '.', 500), // contenido
      item('Otra frase distinta en la página ' + p + '.', 300),
      item('Conclusión particular de la hoja ' + p, 80),   // cerca del pie, ÚNICO
      item(String(p), 40)                                  // número de página
    ]
  });
}
marcarCabecerasYPies(paginas);

const omitidos = paginas.map((pg) => [...pg.omitir].map((i) => i.str));
comprobar('se calla la cabecera repetida en todas las páginas',
  omitidos.every((o) => o.includes('Manual del usuario')));
comprobar('se calla el número de página en todas las páginas',
  omitidos.every((o, i) => o.includes(String(i + 1))));
comprobar('NO se calla el cuerpo del texto',
  omitidos.every((o, i) => !o.includes('Texto del cuerpo de la página ' + (i + 1) + '.')));
comprobar('NO se calla un texto único aunque esté junto al pie',
  omitidos.every((o, i) => !o.includes('Conclusión particular de la hoja ' + (i + 1))));

// ---- 4. Una sola página: solo se quita lo que es un número -------------------
const unaSola = [{
  alto: ALTO,
  items: [
    item('Título del documento', 800),   // en el margen, pero no se repite
    item('Cuerpo del documento.', 400),
    item('9', 40)                        // número de página
  ]
}];
marcarCabecerasYPies(unaSola);
const soloUna = [...unaSola[0].omitir].map((i) => i.str);
comprobar('con una sola página, el título del margen NO se calla',
  !soloUna.includes('Título del documento'));
comprobar('con una sola página, el número suelto sí se calla', soloUna.includes('9'));

// ---- 5. Cabecera con número variable ("Capítulo 3 — 15") --------------------
const conNumero = [];
for (let p = 1; p <= 6; p++) {
  conNumero.push({
    alto: ALTO,
    items: [
      item('Capítulo 3 — ' + (10 + p), 805),  // misma cabecera, número distinto
      item('Contenido real de la página ' + p, 400)
    ]
  });
}
marcarCabecerasYPies(conNumero);
comprobar('la cabecera corrida se detecta aunque cambie el número',
  conNumero.every((pg, p) => [...pg.omitir].map((i) => i.str).includes('Capítulo 3 — ' + (11 + p))));
comprobar('el contenido de esas páginas se conserva',
  conNumero.every((pg, p) => ![...pg.omitir].map((i) => i.str).includes('Contenido real de la página ' + (p + 1))));

console.log(fallos === 0 ? '\nTODAS LAS PRUEBAS PASAN ✓' : '\n' + fallos + ' COMPROBACIONES FALLAN ✗');
process.exit(fallos ? 1 : 0);
