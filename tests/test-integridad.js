// Comprobación de integridad de la extensión: IDs del DOM, archivos del
// manifest, imports y parches del motor neuronal.
// Uso:  node tests/test-integridad.js
'use strict';
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..') + path.sep;
let fallos = 0;

function idsUsados(js) {
  const src = fs.readFileSync(raiz + js, 'utf8');
  return [...src.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
}
function comprobarIds(js, html) {
  const cuerpo = fs.readFileSync(raiz + html, 'utf8');
  for (const id of idsUsados(js)) {
    if (!cuerpo.includes(`id="${id}"`)) {
      console.log(`✗ ${js} usa #${id} pero no existe en ${html}`);
      fallos++;
    }
  }
  console.log(`✓ IDs de ${js} presentes en ${html}`);
}
comprobarIds('popup.js', 'popup.html');
comprobarIds('reader.js', 'reader.html');

// Archivos referenciados por el manifest
const manifest = JSON.parse(fs.readFileSync(raiz + 'manifest.json', 'utf8'));
const archivos = [
  manifest.background.service_worker,
  ...manifest.background.scripts,
  ...manifest.content_scripts.flatMap(cs => cs.js),
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.web_accessible_resources.flatMap(w => w.resources)
];
for (const a of new Set(archivos)) {
  if (!fs.existsSync(raiz + a)) { console.log(`✗ falta ${a}`); fallos++; }
}
console.log('✓ todos los archivos del manifest existen');

// Archivos referenciados por los HTML y los imports de los módulos
for (const [archivo, patron] of [
  ['popup.html', /<script src="([^"]+)"/g],
  ['reader.html', /<script[^>]* src="([^"]+)"/g],
  ['tts-frame.html', /<script[^>]* src="([^"]+)"/g],
  ['reader.js', /from '(\.\/[^']+)'/g],
  ['tts-frame.js', /from '(\.\/[^']+)'/g]
]) {
  const src = fs.readFileSync(raiz + archivo, 'utf8');
  for (const m of src.matchAll(patron)) {
    const ruta = m[1].replace('./', '');
    if (!fs.existsSync(raiz + ruta)) { console.log(`✗ ${archivo} referencia ${ruta} y no existe`); fallos++; }
  }
}
console.log('✓ scripts referenciados por HTML/imports existen');

// Referencias con chrome.runtime.getURL (worker de pdf.js, iframe neuronal)
for (const archivo of ['reader.js', 'content.js']) {
  const src = fs.readFileSync(raiz + archivo, 'utf8');
  for (const m of src.matchAll(/getURL\('([^']+)'\)/g)) {
    if (!fs.existsSync(raiz + m[1])) { console.log(`✗ ${archivo} usa getURL('${m[1]}') y no existe`); fallos++; }
    else console.log(`✓ getURL('${m[1]}') presente (${archivo})`);
  }
}

// El bundle neuronal parcheado no debe apuntar a ningún CDN
const vits = fs.readFileSync(raiz + 'libs/neural/vits-web.js', 'utf8');
if (/cdn\.jsdelivr|cdnjs\.cloudflare|import\("onnxruntime-web"\)/.test(vits)) {
  console.log('✗ libs/neural/vits-web.js sigue apuntando a CDNs o a especificadores de bundler');
  fallos++;
} else {
  console.log('✓ vits-web.js parcheado: sin CDNs (solo modelos de Hugging Face)');
}
// El parche 5 (caché de la sesión ONNX por voz) debe seguir presente: sin él,
// el arranque de la lectura vuelve a ser lento. Ver libs/LEEME.md.
if (/_SES\s*=\s*new Map\(\)/.test(vits) && /InferenceSession\.create/.test(vits)) {
  console.log('✓ vits-web.js con caché de sesión ONNX (arranque rápido)');
} else {
  console.log('✗ falta el parche de caché de sesión en vits-web.js (arranque lento)');
  fallos++;
}
// El CSP debe permitir WASM en las páginas de la extensión
if (!/wasm-unsafe-eval/.test(JSON.stringify(manifest.content_security_policy || {}))) {
  console.log('✗ falta wasm-unsafe-eval en el CSP del manifest'); fallos++;
} else console.log('✓ CSP con wasm-unsafe-eval para el motor neuronal');

// APIs que no existen en Firefox: no deben usarse en código (solo comentarios)
for (const archivo of ['background.js', 'speech-engine.js', 'content.js', 'popup.js', 'reader.js', 'tts-frame.js']) {
  const src = fs.readFileSync(raiz + archivo, 'utf8');
  const usos = [...src.matchAll(/^(?!\s*(\/\/|\*|\/\*)).*chrome\.(tts|offscreen)\b/gm)];
  if (usos.length) { console.log(`✗ ${archivo} usa chrome.tts/chrome.offscreen (no existen en Firefox)`); fallos++; }
}
console.log('✓ sin chrome.tts ni chrome.offscreen en el código');

console.log(fallos === 0 ? '\nINTEGRIDAD OK ✓' : `\n${fallos} PROBLEMAS ✗`);
process.exit(fallos ? 1 : 0);
