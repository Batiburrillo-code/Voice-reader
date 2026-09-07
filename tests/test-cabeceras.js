// Pruebas del filtro de "qué se lee" del lector de PDF (reader.js): cabeceras,
// pies, números de página y pies de imagen. Comprueba que se callan esos trozos
// SIN comerse contenido real, y que cada ajuste manda sobre lo suyo.
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

/** Extrae una constante de reader.js (una asignación de varias líneas). */
function extraerConst(nombre) {
  // Hasta el primer ';' que cierre línea (el fichero puede venir con CRLF).
  const re = new RegExp('const ' + nombre + ' =[\\s\\S]*?;\\r?\\n');
  const m = fuente.match(re);
  if (!m) throw new Error('No se encontró la constante ' + nombre + ' en reader.js');
  return m[0];
}

const margen = fuente.match(/const MARGEN_BORDE = ([\d.]+)/);
if (!margen) throw new Error('No se encontró MARGEN_BORDE en reader.js');

// Cargamos las funciones reales del lector (misma fuente, sin duplicar lógica).
const sandbox = {};
new Function('caja',
  'const MARGEN_BORDE = ' + margen[1] + ';\n' +
  extraerConst('MARCA_PIE_IMAGEN') + '\n' +
  extraerFuncion('esNumeroDePagina') + '\n' +
  extraerFuncion('esPieDeImagen') + '\n' +
  extraerFuncion('agruparEnLineas') + '\n' +
  extraerFuncion('marcarPiesDeImagen') + '\n' +
  extraerFuncion('marcarQueNoSeLee') + '\n' +
  'caja.esNumeroDePagina = esNumeroDePagina;' +
  'caja.esPieDeImagen = esPieDeImagen;' +
  'caja.marcarQueNoSeLee = marcarQueNoSeLee;'
)(sandbox);
const { esNumeroDePagina, esPieDeImagen, marcarQueNoSeLee } = sandbox;

// Ajustes por defecto de la extensión: se callan cabeceras, pies y números;
// los pies de imagen SÍ se leen.
const POR_DEFECTO = {
  leerNumerosPagina: false,
  leerCabeceras: false,
  leerPies: false,
  leerPiesImagen: true
};
const TODO = {
  leerNumerosPagina: true,
  leerCabeceras: true,
  leerPies: true,
  leerPiesImagen: true
};

let fallos = 0;
function comprobar(descripcion, condicion) {
  if (condicion) console.log('✓ ' + descripcion);
  else { console.log('✗ ' + descripcion); fallos++; }
}

/** Los textos que se callan en cada página, para comprobarlos de un vistazo. */
function omitidosDe(paginas) {
  return paginas.map((pg) => [...pg.omitir].map((i) => i.str));
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
function item(str, y, alto) { return { str, transform: [1, 0, 0, 1, 60, y], height: alto || 12 }; }

function documentoTipico() {
  const paginas = [];
  for (let p = 1; p <= 5; p++) {
    paginas.push({
      alto: ALTO,
      items: [
        item('Manual del usuario', 800),                       // cabecera (repetida)
        item('Texto del cuerpo de la página ' + p + '.', 500), // contenido
        item('Otra frase distinta en la página ' + p + '.', 300),
        item('Conclusión particular de la hoja ' + p, 80),      // cerca del pie, ÚNICO
        item(String(p), 40)                                    // número de página
      ]
    });
  }
  return paginas;
}

let paginas = documentoTipico();
marcarQueNoSeLee(paginas, POR_DEFECTO);
let omitidos = omitidosDe(paginas);
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
marcarQueNoSeLee(unaSola, POR_DEFECTO);
const soloUna = omitidosDe(unaSola)[0];
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
marcarQueNoSeLee(conNumero, POR_DEFECTO);
comprobar('la cabecera corrida se detecta aunque cambie el número',
  conNumero.every((pg, p) => [...pg.omitir].map((i) => i.str).includes('Capítulo 3 — ' + (11 + p))));
comprobar('el contenido de esas páginas se conserva',
  conNumero.every((pg, p) => ![...pg.omitir].map((i) => i.str).includes('Contenido real de la página ' + (p + 1))));

// ---- 6. Cada ajuste manda sobre LO SUYO --------------------------------------
// Un pie repetido (además de la cabecera y el número) para poder separarlos.
function documentoCompleto() {
  const paginas = [];
  for (let p = 1; p <= 5; p++) {
    paginas.push({
      alto: ALTO,
      items: [
        item('Manual del usuario', 800),      // cabecera repetida
        item('Cuerpo de la hoja ' + p + '.', 400),
        item('Editorial Batiburrillo', 55),   // pie repetido
        item(String(p), 30)                   // número de página
      ]
    });
  }
  return paginas;
}

// 6a. Con todo marcado no se calla nada.
let todo = documentoCompleto();
marcarQueNoSeLee(todo, TODO);
comprobar('si se marca todo, no se salta nada',
  omitidosDe(todo).every((o) => o.length === 0));

// 6b. Solo cabeceras.
let soloCab = documentoCompleto();
marcarQueNoSeLee(soloCab, Object.assign({}, TODO, { leerCabeceras: false }));
let o6 = omitidosDe(soloCab);
comprobar('"Cabeceras" desmarcado calla SOLO la cabecera',
  o6.every((o) => o.length === 1 && o[0] === 'Manual del usuario'));

// 6c. Solo pies.
let soloPies = documentoCompleto();
marcarQueNoSeLee(soloPies, Object.assign({}, TODO, { leerPies: false }));
o6 = omitidosDe(soloPies);
comprobar('"Pies de página" desmarcado calla SOLO el pie',
  o6.every((o) => o.length === 1 && o[0] === 'Editorial Batiburrillo'));

// 6d. Solo números de página.
let soloNums = documentoCompleto();
marcarQueNoSeLee(soloNums, Object.assign({}, TODO, { leerNumerosPagina: false }));
o6 = omitidosDe(soloNums);
comprobar('"Números de página" desmarcado calla SOLO el número',
  o6.every((o, i) => o.length === 1 && o[0] === String(i + 1)));

// 6e. Sin opciones (compatibilidad): se salta la morralla, como siempre.
let sinOpciones = documentoCompleto();
marcarQueNoSeLee(sinOpciones);
comprobar('sin opciones se salta la morralla (cabecera, pie y número)',
  omitidosDe(sinOpciones).every((o) => o.length === 3));

// ---- 7. Reconocer el arranque de un pie de imagen ---------------------------
for (const t of ['Figura 3. Evolución del PIB', 'Fig. 12 — detalle', 'FIGURA 1',
                 'Tabla 2. Resultados', 'Cuadro 4: resumen', 'Gráfico 7', 'Imagen 5',
                 'Foto 2 — el patio', 'Ilustración 9', 'Esquema 1', 'Mapa 3',
                 'Lámina IV', 'Figure 6. Overview', 'Table 1: results', 'Anexo 2']) {
  comprobar('«' + t + '» se reconoce como pie de imagen', esPieDeImagen(t) === true);
}

// ---- 8. NO confundir texto normal con un pie de imagen ----------------------
for (const t of ['Como se ve en la Figura 1, el gasto sube',
                 'Tabla de contenidos', 'La figura del padre en la novela',
                 'Mapa conceptual del capítulo', 'Cuadro clínico del paciente',
                 'Figuras retóricas', '']) {
  comprobar('«' + t + '» NO se toma por pie de imagen', esPieDeImagen(t) === false);
}

// ---- 9. Pies de imagen: se saltan solo si el ajuste está desmarcado ---------
// Un pie de dos líneas (misma letra, pegadas) seguido de un párrafo normal más
// abajo y con letra mayor: el filtro no debe pasarse de la raya.
function documentoConFigura() {
  return [{
    alto: ALTO,
    items: [
      item('Introducción al informe anual.', 700, 12),
      item('Figura 3. Evolución del gasto', 500, 9),   // pie, línea 1
      item('entre 2019 y 2024, en millones.', 489, 9), // pie, línea 2 (cierra en punto)
      item('El gasto creció de forma sostenida.', 400, 12)  // párrafo normal
    ]
  }];
}

const conFigura = documentoConFigura();
marcarQueNoSeLee(conFigura, Object.assign({}, POR_DEFECTO, { leerPiesImagen: false }));
const oFig = omitidosDe(conFigura)[0];
comprobar('"Pies de imagen" desmarcado calla la primera línea del pie',
  oFig.includes('Figura 3. Evolución del gasto'));
comprobar('…y también su segunda línea',
  oFig.includes('entre 2019 y 2024, en millones.'));
comprobar('…pero NO el párrafo que viene después',
  !oFig.includes('El gasto creció de forma sostenida.'));
comprobar('…ni el texto de antes', !oFig.includes('Introducción al informe anual.'));

const conFigura2 = documentoConFigura();
marcarQueNoSeLee(conFigura2, POR_DEFECTO);   // leerPiesImagen: true
comprobar('con "Pies de imagen" marcado, el pie SÍ se lee',
  omitidosDe(conFigura2)[0].length === 0);

// ---- 10. Un pie que no cierra en punto no se come el resto de la hoja -------
const figuraLarga = [{
  alto: ALTO,
  items: [
    item('Tabla 1. Municipios del área', 600, 9),
    item('metropolitana de Monterrey', 589, 9),
    item('con más de cien mil habitantes', 578, 9),
    item('según el censo de 2020', 567, 9),
    item('y sus tasas de crecimiento', 556, 9),   // 5.ª línea: ya fuera del tope
    item('El resto del capítulo continúa aquí.', 400, 12)
  ]
}];
marcarQueNoSeLee(figuraLarga, Object.assign({}, POR_DEFECTO, { leerPiesImagen: false }));
const oLarga = omitidosDe(figuraLarga)[0];
comprobar('un pie sin punto final se corta a las 4 líneas', oLarga.length === 4);
comprobar('…y no se lleva por delante el cuerpo del texto',
  !oLarga.includes('El resto del capítulo continúa aquí.'));

console.log(fallos === 0 ? '\nTODAS LAS PRUEBAS PASAN ✓' : '\n' + fallos + ' COMPROBACIONES FALLAN ✗');
process.exit(fallos ? 1 : 0);
