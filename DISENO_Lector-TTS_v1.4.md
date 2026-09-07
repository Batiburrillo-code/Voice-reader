# Lector TTS (Voice-reader) — Documento maestro para diseño

> **Para quien lo lea (p. ej. Claude Design):** este archivo describe **TODO** el
> proyecto tal como está entregado en la **v1.4.0**: qué es, para quién, cómo se
> usa, cómo se ve (con los *tokens* de diseño exactos), cómo funciona por dentro y
> qué restricciones técnicas lo condicionan. Es **puramente descriptivo del estado
> actual**.
>
> - **Repositorio:** https://github.com/Batiburrillo-code/Voice-reader (rama `main`, etiqueta `v1.4.0`).
> - **Idioma del producto y de la documentación:** español. El usuario final es **hispanohablante y no técnico**.
> - **Tipo:** extensión de navegador **Manifest V3** (no es una web servida). No hay backend ni servicios de pago.

---

## Índice

1. [Qué es y objetivos](#1-qué-es-y-objetivos)
2. [Usuarios, idioma y navegadores](#2-usuarios-idioma-y-navegadores)
3. [Las tres superficies de interfaz](#3-las-tres-superficies-de-interfaz)
4. [Sistema de diseño (tokens exactos)](#4-sistema-de-diseño-tokens-exactos)
5. [Sistema de resaltado](#5-sistema-de-resaltado)
6. [Flujos de interacción](#6-flujos-de-interacción)
7. [Sistema de voces](#7-sistema-de-voces)
8. [Estado y persistencia](#8-estado-y-persistencia)
9. [Arquitectura y archivos](#9-arquitectura-y-archivos)
10. [Restricciones técnicas que condicionan el diseño](#10-restricciones-técnicas-que-condicionan-el-diseño)
11. [Modelo de rendimiento](#11-modelo-de-rendimiento)
12. [Limitaciones conocidas](#12-limitaciones-conocidas)
13. [Historial de versiones](#13-historial-de-versiones)

---

## 1. Qué es y objetivos

**Lector TTS** es un lector de texto en voz alta (*text-to-speech*), **clon gratuito
de Speechify**. Lee páginas web y PDFs en voz alta **resaltando sobre el propio
texto** (párrafo, oración y palabra) mientras avanza, como un karaoke de lectura.

**Objetivos (lo que define el producto):**
- **Resaltado sobre el contenido real**, no en un panel lateral. La oración que
  suena se ilumina en su sitio; la palabra actual se marca dentro de ella.
- **Voces neuronales de calidad, gratis y sin conexión** tras una descarga única
  (motor Piper), además de las voces del sistema.
- **100 % local y gratuito:** sin APIs de pago, sin servidores propios, sin CDNs
  (la política de seguridad de MV3 los prohíbe). Todo va empaquetado.
- **Una sola base de código** para Chrome, Brave, Chromium, Opera GX y Firefox.
- **Español primero** y pensado para gente no técnica.

**No-objetivos / lo que NO hace:**
- No traduce, no resume, no usa IA en la nube.
- No es una app web ni móvil (es una extensión de escritorio).
- No hay cuentas, login ni sincronización con servidores propios (usa el
  `storage.sync` del navegador para las preferencias).

---

## 2. Usuarios, idioma y navegadores

- **Usuario final:** hispanohablante, **no técnico**. Todo en español, sin jerga,
  listo para usar. Las decisiones de UI priorizan claridad sobre densidad.
- **Navegador principal declarado por el usuario:** **Opera GX**.
- **Navegadores soportados:** Chrome, Brave, Chromium, **Opera GX** y Firefox.

**Implicación de diseño MUY importante — Opera GX no trae voces del sistema.**
En Opera GX `speechSynthesis.getVoices()` viene vacío. Por eso:
- Para ese usuario, **las únicas voces disponibles son las neuronales (Piper)** de
  la extensión.
- La extensión **no asume que existan voces del sistema**: siempre ofrece las
  neuronales.

---

## 3. Las tres superficies de interfaz

Hay **tres** interfaces visuales. Todas comparten estética oscura con acento
morado.

### 3.1 Popup de la extensión (`popup.html` / `popup.js`)
Se abre al pulsar el icono 🔊 en la barra del navegador. **No lee en voz alta**
(al cerrarse cortaría la voz): solo **guarda preferencias** y **manda órdenes** al
contenido de la pestaña.

Estructura (de arriba abajo), ancho fijo **340 px**, tema oscuro:
1. **Título:** logo cuadrado 🔊 (26×26, degradado morado) + «Lector TTS».
2. **Voz** — `<select>` con grupos: `✨ Automática`, `🌟 Neuronales`, `Sistema · Español`, `Sistema · Otros idiomas`.
3. **Velocidad** — fila `[−] [slider 0.5–5] [+] [valor ×]` (pasos de 0.1).
4. **Qué se lee** — lista de casillas (una por parte del documento: números de página, cabeceras, pies, pies de imagen). Lo no marcado se salta al leer. Se pintan desde `LectorTTS.OPCIONES_LECTURA`, la misma fuente que usa el lector de PDF.
5. **Acciones** (grid 2 col): **▶ Leer página** (botón primario morado) y **🔊 Leer selección**.
6. **Transporte** (grid 4 col): **⏮ ⏯ ⏹ ⏭**.
7. **👆 Leer al hacer clic** — botón interruptor (ancho completo; se pone morado al activarse).
8. **📄 Leer este PDF en el lector** — botón rojo, **solo visible si la pestaña es un PDF**.
9. **🔓 Conceder acceso a los sitios web** — **solo en Firefox** si falta el permiso.
10. **Estado** — línea de aviso (gris; roja si error).
11. **Pie** — atajos: `Alt+L`, `Alt+clic`, menú contextual.

### 3.2 Barrita flotante en páginas web (`content.js`, dentro de un Shadow DOM)
Aparece **abajo y centrada** cuando empieza una lectura en una página web. Es el
control principal durante la lectura. Vive en un **Shadow DOM** (aislada del CSS de
la página). **Novedades v1.4:** es **arrastrable** y **se pliega**.

- **Asa de arrastre** (arriba, símbolo único `⠿`): arrástrala para **mover** la
  barra a donde quieras (la posición se **guarda**). Tócala sin arrastrar para
  **reabrir** cuando está contraída.
- **Fila 1:** `⏮` anterior · `⏸/▶` pausa (botón principal morado) · `⏭` siguiente ·
  grupo **Velocidad** `[− valor +]` · **progreso** (p. ej. «69 / 191») · `✕` cerrar.
- **Fila 2:** `<select>` de **voz** · `👆` leer-al-clic · `🎯/🧭` auto-encuadre.
- **Mensaje** (línea ámbar) para avisos («Descargando voz…», «Pulsa ▶…», etc.).
- **Plegado:** al **hacer clic fuera** de la barra, se **contrae** y deja **solo
  `⏮ ⏸ ⏭`** (más el asa). Ocupa lo mínimo. Se reabre tocando el asa.
- **Toast** flotante breve (arriba-centro) para pistas puntuales (p. ej. al activar
  «leer al hacer clic»).

### 3.3 Lector de PDF (`reader.html` / `reader.js`)
Página propia de la extensión (pestaña nueva) para leer PDFs, porque el visor
nativo del navegador no admite *content scripts*. **El PDF se ve como en el visor
del navegador** (páginas renderizadas con pdf.js) y el **resaltado se pinta sobre
el documento**.

- **Cabecera** (barra superior fija): **☰** panel · título 📄 · **indicador de
  página** («3 / 12», pastilla) · `⏮ ⏸ ⏭` · `🧭/🎯` auto-encuadre · grupo
  **Velocidad** · botón **Qué se lee** (abre un panelito de casillas anclado
  debajo; se cierra con clic fuera o `Esc`) · `<select>` voz ·
  **📂 Abrir PDF…** · progreso.
- **Panel lateral izquierdo** (214 px, fondo `#20202a`, borde derecho `#34344a`),
  con dos pestañas tipo *tablist* (la activa lleva el degradado morado→azul):
  - **Páginas** — miniatura de cada hoja (168 px de ancho, marco blanco con
    sombra y número debajo). La página actual lleva **borde morado + halo**
    (`box-shadow 0 0 0 3px rgba(124,92,255,.28)`) y su número en blanco; el
    panel la mantiene siempre a la vista.
  - **Índice** — árbol de marcadores del PDF, plegable (chevron `▸/▾`), con
    sangría de 12 px por nivel; el apartado en el que estás se resalta con
    fondo `rgba(124,92,255,.20)` y una barra morada a la izquierda. Si el PDF no
    trae marcadores, se muestra un texto explicativo (estado vacío).
  - Se abre/cierra con **☰** (la preferencia se guarda). En ventanas de menos de
    720 px se **superpone** al documento en vez de robarle ancho.
- **Cuerpo:** documento con *scroll*; páginas centradas sobre fondo oscuro, cada
  página con fondo blanco y sombra; renderizado **perezoso** (según te acercas).
- **Banner de estado/bienvenida** *sticky* sobre el documento.
- **Clic en una frase del PDF** = saltar a ella.

---

## 4. Sistema de diseño (tokens exactos)

Tema **oscuro** en las tres superficies, acento **morado→azul**. Tipografía del
sistema. **Actualmente NO hay tema claro.**

### 4.1 Tipografía
- Familia: `system-ui, -apple-system, 'Segoe UI', sans-serif`.
- Tamaños base: popup **13 px**; barrita ~11.5–15 px; lector 12–15 px.
- Pesos usados: 600 / 650 / 700 para énfasis y títulos.

### 4.2 Color (los valores que están en el código)

| Rol | Valor | Dónde |
|---|---|---|
| **Morado marca** | `#7c5cff` (124,92,255) | acentos, bordes de *thumb*, degradados |
| **Azul marca** | `#5a8bff` (90,139,255) | fin del degradado morado→azul |
| **Degradado primario** | `linear-gradient(135deg,#7c5cff,#5a8bff)` | botones primarios, logo, interruptores activos |
| Fondo popup | `linear-gradient(180deg,#1d1d26,#17171d 60%)` | popup |
| Fondo lector | `#1b1b23` | reader |
| Fondo barrita | `rgba(26,26,34,.94)` + `backdrop-filter: blur(10px)` | barrita web |
| Superficie/controles | `#262633` (popup), `#2a2a38` (barrita/lector) | selects, botones, grupos |
| Superficie *hover* | `#2c2c3b` / `#363648` | — |
| Borde | `#3a3a4e` (controles), `#34344a` (cabecera lector), `#2c2c36` (separadores) | — |
| Texto principal | `#e9e9ef` | — |
| Texto atenuado | `#9a9aac` (labels), `#6e6e80` (pie) | — |
| Texto asa/arrastre | `#7a7a90` | — |
| Aviso/mensaje | `#ffd9a8` (ámbar, barrita), `#9a9aac` (popup) | — |
| Error | `#ff9d8f` (popup), `#ffb9ae`/`#b3453a` (lector) | — |
| **Rojo PDF** | `linear-gradient(135deg,#e2574a,#b3453a)` | botón «Leer este PDF» y acentos del lector |
| Pista de slider (lleno) | degradado morado→azul sobre `#343442` | popup |

### 4.3 Forma y profundidad
- **Radios:** popup botones `11px`, selects `10px`, pasos `8px`; barrita **`999px`
  (pastillas)** en botones y grupos, barra `16px`; lector `10px`, banner `12px`.
- **Sombras:** popup logo `0 3px 10px rgba(124,92,255,.35)`; barrita `0 10px 34px
  rgba(0,0,0,.5)`; lector header `0 4px 18px rgba(0,0,0,.35)`, páginas `0 6px 26px
  rgba(0,0,0,.5)`.
- **Sliders (popup):** pista 6px, *thumb* 17px blanco con borde 3px morado.
- **Iconografía:** emojis (🔊 ▶ ⏸ ⏹ ⏮ ⏭ 👆 🎯 🧭 📄 📂 🔓 ✕ ✨ 🌟 ⠿). No hay set de
  iconos SVG propio; el logo/iconos PNG se generaron con PowerShell (System.Drawing).

> **Nota:** la barrita y el lector usan `#2a2a38` como superficie; el popup usa
> `#262633`. El botón primario y el logo comparten el degradado morado→azul en las
> tres superficies.

---

## 5. Sistema de resaltado

Tres niveles simultáneos con **CSS Custom Highlight API** (no envuelve el texto en
`<span>`, **no muta la página**). Prioridad: **palabra > oración > párrafo**.
Respaldo con la *selección* del navegador en Firefox < 140.

**Colores del resaltado (difieren entre web y PDF):**

| Nivel | Página web (`content.js`) | Lector PDF (`reader.html`) |
|---|---|---|
| Párrafo | `rgba(108,92,255,.10)` | `rgba(124,92,255,.10)` |
| Oración | `rgba(108,92,255,.30)` | `rgba(124,92,255,.28)` |
| Palabra | **`#6c5cff` sólido, texto `#fff`** | **`rgba(255,179,71,.55)` (ámbar translúcido)** |

- En **web** el morado base es `#6c5cff` (108,92,255) y la palabra es **morado
  sólido con texto blanco**.
- En **PDF** el morado base es `#7c5cff` (124,92,255) y la palabra es **ámbar
  translúcido** (para que el texto negro del documento se lea debajo).
- La diferencia es **intencionada**: el PDF necesita transparencias para no tapar
  el texto negro del documento.

---

## 6. Flujos de interacción

**Formas de EMPEZAR a leer:**
1. **Popup → ▶ Leer página** (lee el contenido principal del artículo).
2. **Popup/menú contextual → 🔊 Leer selección** o **`Alt+L`** (lee lo seleccionado).
3. **Leer al hacer clic 👆** (v1.4): con el interruptor activo (popup o barrita),
   **un clic normal en un párrafo** empieza a leer desde ahí.
4. **`Alt`+clic** (v1.4): **siempre** disponible aunque el modo esté apagado; lee
   desde el texto tocado (incluso sobre enlaces, porque es un gesto deliberado).
5. **PDF:** popup detecta el PDF → **📄 Leer este PDF** abre el lector; o **📂 Abrir
   PDF…** desde el lector.

> El «leer al hacer clic» además **resuelve páginas difíciles**: como lee justo lo
> que tocas, captura contenido que el modo «leer toda la página» dejaba fuera.

**Moverse por un PDF (panel lateral):**
- **☰** abre o cierra el panel. La cabecera muestra siempre la página actual.
- **Páginas:** clic en una miniatura → salta a esa página. La miniatura de la
  página que estás viendo va resaltada y el panel la sigue automáticamente.
- **Índice:** clic en un apartado → salta a él (respetando la altura exacta si
  el marcador la indica); el chevron pliega/despliega sus subapartados. El
  apartado en el que estás se resalta solo según avanzas por el documento.
- Teclado: `←` `→` cambian de pestaña; miniaturas y apartados son botones
  enfocables.

**Qué se lee y qué no (PDF).** Cuatro cosas se detectan por separado y cada una
tiene su interruptor; lo que no se lee **sigue viéndose** en el documento:

| Parte | Cómo se detecta | Por defecto |
|---|---|---|
| **Números de página** | Texto en los márgenes superior/inferior (8 %) que parece un número de página (`12`, `- 12 -`, `Página 4`, `iv`, `12 de 30`…) | se salta |
| **Cabeceras** | En el margen superior **y** repetido en varias páginas (3 repeticiones con ≥4 páginas; 2 con 2–3). Al comparar se ignoran las cifras, así «Capítulo 3 — 15» y «— 16» cuentan igual | se salta |
| **Pies de página** | Igual, en el margen inferior | se salta |
| **Pies de imagen** | La línea **empieza** por «Figura/Fig./Tabla/Cuadro/Gráfico/Imagen/Foto/Ilustración/Esquema/Mapa/Lámina/Anexo…» + su número (arábigo o romano) y detrás no viene una letra. El pie sigue por las líneas pegadas con la misma letra, hasta que la frase cierra en punto, y como mucho 4 líneas | **se lee** |

Cambiar cualquiera de los cuatro **rehace el texto al vuelo**
(`reconstruirLectura`): no se vuelve a renderizar el PDF, y la lectura retoma en
la misma frase (se busca por sus primeros 40 caracteres). Si estaba parada, sigue
parada (`motor.cargar`, que carga sin arrancar).

En **páginas web** los mismos ajustes se aplican a lo que hay: «Cabeceras» y
«Pies» gobiernan `<header>` y `<footer>` en modo página completa, y «Pies de
imagen» gobierna `<figcaption>`, `<caption>` y las clases habituales
(`caption`, `epígrafe`, `wp-caption-text`…). Los números de página no existen ahí.

**Durante la lectura:**
- **Saltar por clic:** clic en una frase (web o PDF) = saltar a ella. Con el modo
  clic o `Alt`+clic, un clic **fuera del texto en curso** re-arranca desde ahí.
- **Transporte:** `⏮` anterior · `⏸/▶` pausa/reanudar · `⏭` siguiente · `⏹` detener.
- **Velocidad:** 0.5×–5×, pasos de 0.1. Con voz **neuronal** el cambio es
  **instantáneo** (sin cortar el audio); con voz del sistema relanza la frase.
- **Auto-encuadre `🎯/🧭`:** si la vista sigue a la lectura o no. **Por defecto: en
  web SÍ sigue (`🎯`), en PDF NO (`🧭`, para poder hojear).** Se guarda.
- **Pausa instantánea:** el `⏸` corta la voz en el acto. En voces del sistema, al
  reanudar retoma **desde el principio de la frase** (limitación del navegador);
  el audio neuronal reanuda en el **punto exacto**.

**Manejo de la barrita (web, v1.4):**
- **Arrastrar** por el asa `⠿` → reposicionar (posición **guardada** y reclamada al
  volver a leer). Siempre se mantiene dentro de la pantalla.
- **Contraer:** clic **fuera** de la barra → se pliega a **solo `⏮ ⏸ ⏭`**.
- **Reabrir:** tocar el asa (sin arrastrar) → vuelve a mostrar todo.

---

## 7. Sistema de voces

Dos motores conviven; el usuario elige uno en el `<select>`:

### 7.1 Voces neuronales Piper (recomendadas, `piper:<id>`)
Mejor calidad y naturalidad, **100 % locales tras una descarga única** (25–120 MB
por voz, cacheadas en el navegador vía OPFS; luego sin conexión). **15 voces**
(orden real en la UI):

**Español de Latinoamérica (primero, por petición del usuario):**
- `Claude · Español latino (México) · alta` — `es_MX-claude-high`
- `Ald · Español latino (México) · media` — `es_MX-ald-medium`
- `Daniela · Español latino (Argentina) · alta` — `es_AR-daniela-high`

**Español de España:** Davefx (media), Sharvard (media), MLS 10246 (ligera),
MLS 9972 (ligera), Carlfm (muy ligera).

**Inglés:** Amy, HFC Female, HFC Male (media), Ryan (alta), Lessac (media) — EE. UU.;
Alan, Jenny (media) — Reino Unido.

> **Techo real de voces mexicanas:** en Piper **solo existen 2 voces mexicanas**
> (`claude` y `ald`), **ambas ya incluidas**. No hay más voces mexicanas offline de
> calidad en el ecosistema libre; no es una limitación de la app. La voz mexicana
> se llama «Claude» porque ese es el nombre real del *dataset* de Piper (coincidencia,
> nada que ver con el asistente).

### 7.2 Voces del sistema (Web Speech API)
Las que trae el navegador/SO. Se agrupan `Sistema · Español` y `Sistema · Otros
idiomas`. En **Opera GX no hay ninguna** (de ahí la insistencia en
las neuronales). En Windows se pueden instalar más desde Configuración.

### 7.3 Opción automática
`✨ Automática` = primera voz en español disponible (o `lang es-ES` para no leer
español con voz inglesa).

---

## 8. Estado y persistencia

Preferencias en **`chrome.storage.sync`** (se sincronizan entre equipos del mismo
perfil). Claves y valores por defecto:

| Clave | Defecto | Rango / notas |
|---|---|---|
| `vozNombre` | `''` | `''`=automática · nombre de voz del sistema · `piper:<id>`=neuronal |
| `velocidad` | `1.1` | 0.5–5 |
| `leerNumerosPagina` | `false` | qué se lee: números de página (v1.5) |
| `leerCabeceras` | `false` | qué se lee: cabeceras corridas · `<header>` en web (v1.5) |
| `leerPies` | `false` | qué se lee: pies corridos · `<footer>` en web (v1.5) |
| `leerPiesImagen` | `true` | qué se lee: «Figura 3. …» · `<figcaption>` en web (v1.5) |
| `seguirWeb` | `true` | auto-encuadre en web |
| `seguirPdf` | `false` | auto-encuadre en PDF (libre por defecto) |
| `clicParaLeer` | `false` | interruptor «leer al hacer clic» (v1.4) |
| `posBarra` | `null` | `{left, top}` en px de la barrita arrastrada (v1.4) |
| `panelPdf` | `null` | panel lateral del lector abierto/cerrado (`null` = aún sin decidir: se abre solo si la ventana pasa de 900 px) |
| `panelVista` | `'miniaturas'` | pestaña activa del panel: `'miniaturas'` o `'indice'` |

Los controles guardan con *debounce* (~250 ms) y el «eco» de `storage.onChanged`
aplica el cambio al motor (**un solo camino**), de modo que popup, barrita y lector
se mantienen sincronizados.

---

## 9. Arquitectura y archivos

```
manifest.json          # MV3 v1.4.0; doble background (service_worker + scripts) para Chromium+Firefox;
                       # CSP con 'wasm-unsafe-eval'; WAR: tts-frame.html; gecko id + strict_min_version 115
background.js          # menú contextual, atajo Alt+L, enrutado de mensajes (NUNCA reproduce voz aquí)
speech-engine.js       # motor compartido, objeto global `LectorTTS`: troceo en oraciones, cola,
                       # 2 backends (Web Speech / Piper), OPCIONES_LECTURA, VOCES_NEURALES
content.js             # páginas web: recolección de texto + mapa, resaltado (3 niveles), barrita
                       # flotante (Shadow DOM, arrastrable/plegable), leer-al-clic, iframe neuronal
tts-frame.html/.js     # iframe OCULTO de la extensión: sintetiza Piper (WASM) y devuelve WAV por
                       # MessageChannel (las páginas no pueden ejecutar ese WASM; la extensión sí)
voces-extra.js         # registra en el catálogo de vits-web voces que no están en el mirror por
                       # defecto (la argentina es_AR-daniela, desde el repo oficial rhasspy) SIN tocar la lib
popup.html/.js         # controles completos + detección de PDF + permiso de Firefox
reader.html/.js        # visor de PDF (pdf.js) con resaltado encima
libs/pdf.mjs, pdf.worker.mjs   # pdf.js 4.10.38 legacy (compat. Firefox 115 ESR; CVE-2024-4367 evitado)
libs/neural/           # vits-web (Piper) PARCHEADO + ONNX Runtime + fonemizador eSpeak WASM
libs/LEEME.md          # procedencia y los 5 parches de las librerías
tests/test-troceo.js   # pruebas del troceador + utilidades de voz  → node tests/test-troceo.js
tests/test-integridad.js  # IDs↔HTML, manifest, imports, parches     → node tests/test-integridad.js
tests/test-cabeceras.js   # filtro de cabeceras/pies/números de pág. → node tests/test-cabeceras.js
README.md · VOCES.md   # manual no técnico · investigación de motores de voz
```

**Motor de lectura (`LectorTTS`, en `speech-engine.js`):** `crearMotorLectura()`
devuelve un objeto con dos *backends* (Web Speech / Piper), *callbacks* de UI
(`alEmpezarOracion`, `alPalabra`, `alTerminar`, `alCambiarEstado`,
`alProgresoDescarga`, `alBloqueoAudio`, `alAviso`) y el enchufe
`sintetizarNeural(texto, idVoz, alProgreso) → Promise<Blob WAV>`. Habla **una
oración por *utterance*/audio** y encadena la siguiente al terminar (esquiva el
corte de *utterances* largas de Chrome y permite resaltar/saltar por oración).

**Pipeline neuronal (web):** `content.js` delega la síntesis a un **iframe oculto**
(`tts-frame.html`, de origen extensión, que sí puede WASM) por `MessageChannel`; el
audio WAV se reproduce en la página. En `reader.html` la síntesis es directa.

---

## 10. Restricciones técnicas que condicionan el diseño

- **Manifest V3 / CSP:** prohíbe scripts y recursos remotos (nada de CDNs, fuentes
  externas, etc.). **Todo va empaquetado**: los recursos (scripts, estilos, fuentes,
  imágenes) van incrustados en la extensión; no se cargan desde fuera.
- **Shadow DOM (barrita web):** la barrita se aísla del CSS de la página. Sus
  estilos van **inline** dentro del *shadow* (`ESTILOS_BARRA` en `content.js`).
- **Custom Highlight API:** resaltar sin tocar el DOM. Disponible en Chrome/Edge/
  Opera 105+ y Firefox 140+; en Firefox viejo hay **respaldo por selección**.
- **WASM en iframe (web):** las voces neuronales requieren un iframe de la
  extensión; las páginas normales no pueden ejecutar ese WASM.
- **OPFS:** los modelos de voz se cachean en el almacenamiento del navegador.
- **Autoplay:** el navegador puede exigir un **clic** para empezar a sonar; entonces
  la UI queda «en pausa» y pide pulsar **▶** (`alBloqueoAudio`).
- **Firefox:** el permiso de acceso a los sitios se concede aparte → botón **🔓** en
  el popup. El *background* usa doble clave (`service_worker` + `scripts`).
- **Opera GX:** sin voces del sistema (ver §2).
- **Sin `chrome.tts` ni `chrome.offscreen`** (no existen en Firefox); la voz nunca
  se reproduce desde el *background*.

---

## 11. Modelo de rendimiento

Todo pensado para que la lectura arranque rápido y no se trabe:
- **Troceo** en oraciones por posiciones (corta tras `.!?…`, une trozos < 60
  caracteres por abreviaturas, parte los > 250 por el bug de Chrome con
  *utterances* largas).
- **Prefetch:** mientras suena una oración, la siguiente se sintetiza en segundo
  plano → sin huecos entre frases.
- **Pre-calentado (v1.4):** al abrir la página o elegir voz neuronal, el motor se
  «calienta» (crea el iframe, carga el WASM y el modelo) para que la **primera**
  lectura no arranque en frío.
- **Caché de sesión ONNX (v1.4, «parche 5» de `vits-web.js`):** el modelo se carga
  **una vez** y se **reutiliza** en cada frase (antes se recreaba cada vez). Es
  seguro porque las síntesis van **en cola** (iframe y lector) → nunca dos a la vez.
- **Velocidad neuronal real 0.5×–5×** con `playbackRate` conservando el timbre
  (`preservesPitch`).
- **Caché de frases con ventana** (±3 alrededor de la actual) y **prefetch de 2**:
  pasar de frase, retroceder, pausar/reanudar o reiniciar la lectura no obliga a
  sintetizar otra vez. La caché solo se vacía si cambia el texto o la voz.
- **Miniaturas del panel**: se pintan solo al acercarse, **de una en una** (cola)
  para no competir con el documento, y las que quedan muy lejos **se liberan**
  (se repintan solas al volver), de modo que la memoria no crece sin límite.
- **Página actual por búsqueda binaria** sobre posiciones cacheadas, refrescada
  como mucho una vez por fotograma; se recalcula sola (`ResizeObserver`) cuando
  el aviso de estado aparece o desaparece y desplaza el documento.

Efecto combinado: **tocar un párrafo y empezar a leer es prácticamente inmediato**
tras el primer uso.

---

## 12. Limitaciones conocidas

- **Voces mexicanas:** solo existen 2 voces neuronales mexicanas offline y ambas
  están incluidas; no hay más disponibles en el ecosistema libre.
- **Paleta de resaltado distinta** entre web y PDF (ver §5).
- **PDF:** el resaltado exige que la capa de texto de pdf.js cuadre 1:1 con el
  documento; si no, **lee sin resaltar**. Los **PDFs escaneados** se ven pero **no
  se leen** (no hay OCR).
- **Solo tema oscuro:** no hay tema claro ni seguimiento de la preferencia del
  sistema.
- **Índice del panel:** depende de que el PDF traiga marcadores; muchos no los
  llevan y entonces esa pestaña solo muestra el texto de estado vacío.
- **Filtro de cabeceras/pies:** es una detección por posición + repetición, no
  una certeza; en maquetaciones muy atípicas puede dejar escapar un pie o
  callar una línea del borde. Desde la v1.5 **sí** se puede desactivar por tipo.
- **Pies de imagen:** se reconocen por cómo empiezan («Figura 3. …»). Un pie sin
  esa marca —solo texto en cursiva bajo la foto— no se detecta. Y si el pie
  ocupa más de 4 líneas, o no cierra en punto, se salta solo lo detectado.
- **Qué se lee en web:** «Números de página» no aplica (no existen). «Cabeceras»
  y «Pies» solo actúan en modo *página completa*, no al leer una selección.

---

## 13. Historial de versiones

- **v1.0.0** — Extensión base MV3: leer selección/artículo, troceo, español primero, popup, lector de PDF básico.
- **v1.1.0** — Resaltado **sobre el texto** (Custom Highlight API), **voces neuronales Piper**, soporte Opera GX, síntesis en iframe.
- **v1.2.0** — **Visor de PDF real** (pdf.js con capa de texto), resaltado de párrafo, barrita completa, renderizado perezoso.
- **v1.3.0** — **Navegación libre** mientras lee (`🧭/🎯`), **pausa instantánea**, ajuste fino desde el lector.
- **Sin publicar (encima de la v1.4.0)** — **Panel lateral del lector de PDF**
  (miniaturas con la página actual resaltada + índice de marcadores plegable,
  intercambiables y ocultables). **No se leen** números de página, cabeceras ni
  pies. **Menos espera** al pasar de frase, retroceder, pausar o reiniciar
  (caché con ventana + prefetch de 2). Nueva prueba `tests/test-cabeceras.js`.
- **v1.5.0** — **Qué se lee**: interruptor por tipo (números de página, cabeceras, pies y **pies de imagen**), en el popup y en el lector de PDF, aplicado **al vuelo** sin recargar. **Fuera el control de tono** (`tono`, `soportaTono`, `fijarTono` y su interfaz en las tres superficies). **Sin emojis** en las pestañas «Páginas» e «Índice» del panel. `tests/test-cabeceras.js` ampliada a pies de imagen y a cada interruptor.
- **v1.4.0** — **Voces:** Argentina (`es_AR-daniela`) + varias inglesas, orden por región. **Tono en gris** con neuronales. **Leer al hacer clic** + `Alt`+clic. **Arranque rápido** (pre-calentado + caché de sesión). **Barra movible y plegable** (colapso a solo `⏮ ⏸ ⏭`, símbolo de arrastre único). PR #1 fusionada; etiqueta `v1.4.0`.

---

*Documento descriptivo de la v1.4.0. Fuente de la verdad: el código en `main` y
`libs/LEEME.md` (procedencia y parches de las librerías).*
