# 🔊 Lector TTS — lee páginas web y PDFs en voz alta

Extensión de navegador tipo **Speechify, pero 100 % gratuita**: lee en voz
alta cualquier página web o PDF **resaltando la frase y la palabra que van
sonando sobre el propio texto**, sin cuentas, sin APIs de pago y sin enviar
tu lectura a ningún servidor.

Funciona con **una sola base de código** en Chrome, Brave, Chromium,
**Opera GX** y Firefox.

## ✨ Qué sabe hacer

- **Leer el artículo de la página** resaltando **en el propio texto**, a tres
  niveles sincronizados: el párrafo (tinte suave), la oración que suena y la
  palabra actual, con desplazamiento automático. Haz clic sobre cualquier
  frase del texto para saltar a ella.
- **Leer solo lo que selecciones**: clic derecho → «🔊 Leer selección», o el
  atajo de teclado **Alt+L**.
- **Barrita flotante con todos los controles** mientras lees: pausa,
  anterior/siguiente, velocidad y tono con botones **−/+** de 0.1 en 0.1,
  selector de voz y cerrar. En el popup, además, deslizadores con contadores.
- **Voces neuronales gratis** 🌟 (motor Piper, open source): mucho más claras
  y humanas que las del sistema. Se descargan una sola vez (25–120 MB por
  voz) y después funcionan **sin conexión**. 7 voces en español (España y
  México) + 1 en inglés. Detalles de la investigación en [VOCES.md](VOCES.md).
- **Velocidad de 0.5× a 5×**: con las voces neuronales el 5× es real y sin
  voz de ardilla (se conserva el tono). Tono ajustable con las voces del
  sistema.
- **PDFs con su formato original**: el lector muestra el documento **como el
  visor del navegador** (páginas renderizadas con pdf.js de Mozilla, tablas y
  colores incluidos) y el resaltado de párrafo/oración/palabra se pinta
  **sobre el propio documento**. Clic en cualquier frase del PDF para saltar.
  Las páginas se renderizan según te acercas, para que los PDFs grandes no
  consuman memoria de golpe.
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

### Opera GX / Opera

1. Descarga y descomprime el proyecto igual que arriba.
2. Abre `opera://extensions`.
3. Activa el **Modo de desarrollador** (arriba a la derecha).
4. Pulsa **«Cargar sin empaquetar»** y elige la carpeta del proyecto.

> **Importante en Opera GX:** Opera no trae voces de texto-a-voz propias, así
> que las «voces del sistema» pueden aparecer vacías. No pasa nada: elige una
> **voz 🌟 neuronal** en el popup y funcionará perfectamente (la propia
> extensión pone las voces).

### Firefox — prueba rápida (temporal)

1. Abre `about:debugging#/runtime/this-firefox`.
2. Pulsa **«Cargar complemento temporal…»** y elige el archivo
   `manifest.json` de la carpeta del proyecto.
3. La extensión funciona hasta que cierres Firefox (así funcionan las pruebas
   temporales; para algo permanente, sigue leyendo).

> **Importante en Firefox:** la primera vez, abre el popup de la extensión y
> pulsa el botón **«🔓 Conceder acceso a los sitios web»** (Firefox pide ese
> permiso aparte). Después recarga la página que quieras leer.
>
> Para el resaltado de frase y palabra hace falta Firefox **140 o más nuevo**
> (los anteriores usan un resaltado de respaldo más simple).

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
| Pausar / seguir                | Botón **⏯** de la barrita flotante o del popup             |
| Saltar de frase                | Botones **⏮ / ⏭**, o clic directamente sobre la frase en el texto |
| Cambiar voz / velocidad / tono | Selectores del popup (se guardan solos)                    |
| Voz mucho más humana           | Popup → Voz → grupo **🌟 Neuronales** (espera la descarga la 1ª vez) |
| Leer un PDF                    | Abro el PDF en una pestaña → icono 🔊 → **📄 Leer este PDF** |
| Leer un PDF de mi disco        | Lector de PDF → **📂 Abrir PDF…**                          |

> **Truco:** si al usar una voz neuronal el navegador muestra «Pulsa ▶ para
> escuchar», es la protección anti-autoplay del navegador: un clic y a leer.

### Sobre la velocidad 5×

- Voces **🌟 neuronales**: velocidad real de 0.5× a 5× conservando el tono.
- Voces **locales** de Windows: suelen respetar velocidades altas.
- Voces **"online"** del sistema (las marcadas «· online»): el navegador las
  limita a ~2×, por mucho que se pida más. Es un límite de esas voces.

## 🎙️ Instalar más voces en español (Windows)

Las voces «del sistema» que usa la extensión son las de tu ordenador. Para
añadir más:

1. **Configuración** de Windows → **Hora e idioma** → **Voz**.
2. En «Administrar voces», pulsa **«Agregar voces»**.
3. Busca e instala «Español (España)», «Español (México)», etc.
4. Reinicia el navegador para que las detecte.

## 🧰 Solución de problemas

- **No suena nada** → pulsa ⏹ Detener y vuelve a intentarlo (a veces la cola
  de voz del navegador se atasca). Comprueba también el volumen del sistema.
- **«Pulsa ▶ para escuchar»** → el navegador exige un clic antes de
  reproducir audio. Pulsa el ▶ de la barrita flotante.
- **La voz neuronal tarda en empezar** → la primera vez descarga el modelo
  (25–120 MB); en la barrita se ve el porcentaje. Las siguientes veces
  arranca al momento y sin conexión.
- **No aparecen voces del sistema** → normal en Opera GX (usa las 🌟
  neuronales); en Windows instala voces (sección anterior) y reinicia el
  navegador.
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
├── manifest.json        # configuración de la extensión (Manifest V3, multiplataforma)
├── background.js        # menú contextual, atajo Alt+L y enrutado de mensajes
├── speech-engine.js     # motor de voz compartido: troceo, cola, voces sistema+Piper
├── content.js           # resaltado sobre el texto de la página + barrita flotante
├── tts-frame.html/.js   # iframe oculto que sintetiza las voces neuronales
├── popup.html/.js       # controles (voz, velocidad, tono, transporte)
├── reader.html/.js      # lector de PDFs
├── VOCES.md             # investigación de voces (Piper vs Kokoro vs otras)
├── icons/               # iconos de la extensión
└── libs/                # librerías open source empaquetadas (sin CDN)
    ├── pdf.mjs / pdf.worker.mjs   # pdf.js de Mozilla
    └── neural/                     # Piper: vits-web + ONNX Runtime + eSpeak WASM
```

## 🔒 Privacidad

La lectura ocurre en tu ordenador: la extensión no tiene servidores propios
ni recopila ningún dato. La única conexión que hace es descargar el modelo de
una voz neuronal (desde Hugging Face) la primera vez que la eliges; después,
esa voz funciona sin conexión.

## 🚫 Fuera de alcance (posible v2)

OCR de PDFs escaneados, cambio automático de idioma a mitad de texto, motor
Kokoro (calidad aún mayor, pero necesita WebGPU) y publicación en las tiendas.

## 📄 Licencias de terceros

- [pdf.js](https://github.com/mozilla/pdf.js) — Mozilla, Apache 2.0.
- [vits-web](https://github.com/diffusionstudio/vits-web) — MIT.
- [Piper / piper-wasm](https://github.com/rhasspy/piper) — MIT (modelos de voz incluidos).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) — MIT.
