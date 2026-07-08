# Librerías empaquetadas (sin CDN)

La política de seguridad de Manifest V3 prohíbe cargar scripts desde internet,
por eso estas librerías van incluidas en la extensión. Ya están descargadas;
esta nota es solo para saber qué son y cómo actualizarlas.

| Archivo          | Qué es                                   | Versión   | Origen |
|------------------|------------------------------------------|-----------|--------|
| `Readability.js` | Extractor de artículos de Mozilla        | rama main (jul 2026) | <https://github.com/mozilla/readability> (archivo `Readability.js` de la raíz) |
| `pdf.mjs`        | pdf.js de Mozilla (build **legacy**)     | 4.10.38   | <https://github.com/mozilla/pdf.js/releases> → `pdfjs-4.10.38-legacy-dist.zip` → `build/pdf.mjs` |
| `pdf.worker.mjs` | Worker de pdf.js (build **legacy**)      | 4.10.38   | mismo zip → `build/pdf.worker.mjs` |

Notas:

- Se usa la build **legacy** de pdf.js para que funcione también en Firefox
  115 ESR y Chromium antiguos.
- El plan original pedía la 3.x (`pdf.min.js`); se empaquetó la 4.10.38 porque
  las 3.x tienen una vulnerabilidad conocida (CVE-2024-4367). Además, el lector
  la carga con `isEvalSupported: false` como defensa extra.
- Ambas librerías son de Mozilla, con licencia Apache 2.0.
