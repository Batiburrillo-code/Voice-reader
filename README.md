# 🔊 Lector TTS — lee páginas web y PDFs en voz alta

Extensión de navegador tipo **Speechify, pero 100 % gratuita**: lee en voz alta
cualquier página web o PDF con resaltado del texto, sin cuentas, sin APIs de
pago y sin enviar nada a internet (usa las voces que ya tiene tu ordenador).

Funciona con **una sola base de código** en Chrome, Brave, Chromium y Firefox.

## ✨ Qué sabe hacer

- **Leer el artículo completo** de una página (detecta el contenido principal
  con Readability.js, la misma tecnología del "modo lectura" de Firefox).
- **Leer solo lo que selecciones**: clic derecho → «🔊 Leer selección», o el
  atajo de teclado **Alt+L**.
- **Panel lector lateral** con el texto troceado en oraciones: la que suena se
  resalta y la vista se desplaza sola. Haz clic en cualquier oración para
  saltar a ella. Si tu voz lo soporta, también se resalta **palabra a palabra**.
- **Controles completos**: voz, velocidad de **0.5× a 5×**, tono, pausa y
  reanudar, oración anterior/siguiente. Tus preferencias se guardan solas.
- **PDFs**: los abre en un lector propio a pantalla completa con los mismos
  controles y resaltado (extrae el texto con pdf.js de Mozilla).
- **Español primero**: interfaz en español y selección automática de una voz
  en español si no has elegido ninguna.

## 📦 Instalación

### Chrome / Brave / Chromium

1. Descarga este proyecto (botón verde **Code → Download ZIP** en GitHub) y
   descomprímelo en una carpeta que no vayas a borrar.
2. Abre `chrome://extensions` (en Brave: `brave://extensions`).
3. Activa el **Modo de desarrollador** (interruptor arriba a la derecha).
4. Pulsa **«Cargar descomprimida»** y elige la carpeta del proyecto.
5. ¡Listo! Verás el icono 🔊 morado en la barra de herramientas.

> **Para PDFs locales (archivos de tu disco):** en `chrome://extensions`,
> entra en «Detalles» de la extensión y activa **«Permitir el acceso a las
> URL de archivo»**. Si no, siempre puedes usar el botón «📂 Abrir PDF…» del
> lector.

### Firefox — prueba rápida (temporal)

1. Abre `about:debugging#/runtime/this-firefox`.
2. Pulsa **«Cargar complemento temporal…»** y elige el archivo
   `manifest.json` de la carpeta del proyecto.
3. La extensión funciona hasta que cierres Firefox (así funcionan las pruebas
   temporales; para algo permanente, sigue leyendo).

> **Importante en Firefox:** la primera vez, abre el popup de la extensión y
> pulsa el botón **«🔓 Conceder acceso a los sitios web»** (Firefox pide ese
> permiso aparte). Después recarga la página que quieras leer.

### Firefox — instalación permanente

Firefox solo instala de forma permanente extensiones **firmadas**. Firmarla es
gratis:

1. Crea una cuenta en [addons.mozilla.org](https://addons.mozilla.org).
2. Ve a [Enviar un complemento nuevo](https://addons.mozilla.org/es/developers/addon/submit/distribution)
   y elige **«On your own»** (autodistribución): Mozilla firma el archivo pero
   NO lo publica en la tienda.
3. Sube un ZIP con el contenido de esta carpeta, espera la firma automática
   (minutos) y descarga el `.xpi` firmado.
4. Arrastra el `.xpi` a una ventana de Firefox para instalarlo.

(Si te manejas con la terminal, `npx web-ext sign` hace lo mismo en un paso.)

## 🗣️ Cómo se usa

| Quiero…                        | Hago…                                                      |
|--------------------------------|------------------------------------------------------------|
| Leer un artículo entero        | Icono 🔊 → **▶ Leer página**                               |
| Leer solo un trozo             | Selecciono el texto → clic derecho → **🔊 Leer selección** (o **Alt+L**) |
| Pausar / seguir                | Botón **⏯** del popup o del panel lateral                  |
| Saltar de oración              | Botones **⏮ / ⏭**, o clic en la oración del panel          |
| Cambiar voz / velocidad / tono | Selectores del popup (se guardan solos)                    |
| Leer un PDF                    | Abro el PDF en una pestaña → icono 🔊 → **📄 Leer este PDF** |
| Leer un PDF de mi disco        | Lector de PDF → **📂 Abrir PDF…**                          |

La velocidad llega hasta **5×**. Ojo: algunas voces "online" del navegador
limitan la velocidad real a ~2×; las voces **locales** de Windows respetan
velocidades altas mucho mejor (ver siguiente sección).

## 🎙️ Instalar más voces en español (Windows)

Las voces que usa la extensión son las del sistema. Para añadir más:

1. **Configuración** de Windows → **Hora e idioma** → **Voz**.
2. En «Administrar voces», pulsa **«Agregar voces»**.
3. Busca e instala «Español (España)», «Español (México)», etc.
4. Reinicia el navegador para que las detecte.

En Windows 11 también existen las **voces naturales** (mucho más humanas):
Configuración → Accesibilidad → Narrador → «Agregar voces naturales».

## 🧰 Solución de problemas

- **No suena nada** → pulsa ⏹ Detener y vuelve a intentarlo (a veces la cola
  de voz del navegador se atasca). Comprueba también el volumen del sistema.
- **No aparecen voces** → cierra y reabre el popup; instala voces (sección
  anterior); reinicia el navegador.
- **«En esta página no se puede leer»** → las páginas internas del navegador
  (`chrome://…`, `about:…`) y la tienda de extensiones están vetadas para
  todas las extensiones. Es normal.
- **Un PDF no se lee** → si es un documento escaneado (fotos de páginas), no
  tiene texto que leer; haría falta OCR, que no está incluido en esta versión.
- **En Firefox no lee ninguna web** → falta el permiso de acceso a los sitios:
  popup → «🔓 Conceder acceso a los sitios web».

## 📁 Estructura del proyecto

```
Voice-reader/
├── manifest.json        # configuración de la extensión (Manifest V3, Chrome+Firefox)
├── background.js        # menú contextual, atajo Alt+L y enrutado de mensajes
├── speech-engine.js     # motor de voz compartido: troceo, cola, voces, ajustes
├── content.js           # extracción del artículo y panel lector con resaltado
├── popup.html/.js       # controles (voz, velocidad, tono, transporte)
├── reader.html/.js      # lector de PDFs
├── icons/               # iconos de la extensión
└── libs/                # librerías de Mozilla empaquetadas (sin CDN)
    ├── Readability.js   # extracción del artículo principal
    ├── pdf.mjs          # pdf.js (extracción de texto de PDFs)
    └── pdf.worker.mjs   # worker de pdf.js
```

## 🔒 Privacidad

Todo ocurre en tu ordenador: la extensión no tiene servidores, no usa APIs de
pago, no carga nada de internet y no recopila ningún dato.

## 🚫 Fuera de alcance (posible v2)

Voces en la nube, OCR de PDFs escaneados, cambio automático de idioma a mitad
de texto y publicación en las tiendas de extensiones.

## 📄 Licencias de terceros

- [Readability.js](https://github.com/mozilla/readability) — Mozilla, licencia Apache 2.0.
- [pdf.js](https://github.com/mozilla/pdf.js) — Mozilla, licencia Apache 2.0.
