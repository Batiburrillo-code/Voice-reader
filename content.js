/**
 * content.js — Se ejecuta en cada página web.
 *
 * Hace tres cosas:
 *   1. Extrae el texto a leer (selección, o artículo con Readability.js).
 *   2. Muestra el panel lector lateral con las oraciones y el resaltado.
 *   3. Atiende las órdenes del popup y del background (leer, pausar, saltar…).
 *
 * La voz se genera aquí, en la página, con el motor de speech-engine.js.
 * Así la lectura sigue sonando aunque el popup se cierre.
 */
(() => {
  'use strict';

  // Evita ejecutarse dos veces si el script se inyecta de nuevo.
  if (window.__lectorTTSCargado) return;
  window.__lectorTTSCargado = true;

  const motor = LectorTTS.crearMotorLectura();
  let oracionesActuales = []; // las oraciones que se están mostrando/leyendo
  let panel = null;           // referencias al panel lateral (o null si está cerrado)

  // Cargar las preferencias guardadas (voz, velocidad, tono).
  LectorTTS.cargarAjustes((ajustes) => { motor.ajustes = ajustes; });

  // Si el usuario cambia algo en el popup (o en el propio panel), se guarda en
  // chrome.storage.sync y aquí lo aplicamos al vuelo relanzando la oración actual.
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
    if (panel) sincronizarVelocidadPanel();
    if (motor.leyendo && !motor.enPausa) {
      motor.saltarA(motor.indice); // relanza la oración actual con los nuevos ajustes
    }
  });

  // ------------------------------------------------------------------
  // Extracción del texto de la página
  // ------------------------------------------------------------------

  /**
   * Extrae el artículo principal con Readability.js. Como Readability MUTA el
   * DOM que analiza, se aplica siempre sobre una copia (document.cloneNode).
   * Si no encuentra un artículo, se usa el texto visible del body.
   */
  function extraerArticulo() {
    let titulo = document.title || 'Página';
    let texto = '';
    try {
      const copia = document.cloneNode(true); // ¡nunca sobre el documento real!
      const articulo = new Readability(copia).parse();
      if (articulo && articulo.textContent && articulo.textContent.trim().length > 200) {
        texto = articulo.textContent;
        if (articulo.title) titulo = articulo.title;
      }
    } catch (e) {
      // Readability puede fallar en páginas raras: usamos el plan B.
    }
    if (!texto.trim()) {
      texto = document.body ? document.body.innerText : '';
    }
    return { titulo, texto };
  }

  // ------------------------------------------------------------------
  // Panel lector lateral (dentro de un Shadow DOM para que el CSS de la
  // página no lo rompa, y con z-index máximo para quedar siempre encima)
  // ------------------------------------------------------------------

  const ESTILOS_PANEL = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .panel {
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      background: #17171d; color: #e9e9ef;
      font-family: Georgia, 'Times New Roman', serif;
      border-left: 1px solid #2c2c36;
      box-shadow: -10px 0 32px rgba(0, 0, 0, .45);
    }
    header {
      flex: none; padding: 10px 14px;
      background: #1f1f28; border-bottom: 1px solid #2c2c36;
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    }
    .fila { display: flex; align-items: center; gap: 8px; }
    .titulo-fila { margin-bottom: 8px; }
    .titulo {
      flex: 1; font-size: 14px; font-weight: 600; color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .btn {
      appearance: none; border: 1px solid #343442; background: #262633;
      color: #e9e9ef; border-radius: 8px; cursor: pointer;
      font-size: 14px; line-height: 1; padding: 7px 10px;
    }
    .btn:hover { background: #32323f; }
    .btn-principal { background: #6c5cff; border-color: #6c5cff; font-size: 15px; padding: 7px 14px; }
    .btn-principal:hover { background: #7d6fff; }
    .btn-cerrar { padding: 6px 9px; }
    select {
      appearance: none; border: 1px solid #343442; background: #262633;
      color: #e9e9ef; border-radius: 8px; padding: 7px 8px;
      font-size: 12px; cursor: pointer;
    }
    .progreso { margin-left: auto; font-size: 11.5px; color: #9a9aac; }
    .contenido {
      flex: 1; overflow-y: auto; padding: 22px 24px 60vh;
      font-size: 18px; line-height: 1.7; /* tipografía cómoda de lectura */
    }
    .oracion { cursor: pointer; border-radius: 4px; padding: 1px 2px; }
    .oracion:hover { background: rgba(124, 92, 255, .14); }
    .oracion.actual { background: rgba(124, 92, 255, .26); }
    .palabra.palabra-actual { background: #6c5cff; color: #fff; border-radius: 3px; }
    .aviso {
      font-family: system-ui, sans-serif; font-size: 14px; color: #c9c9d6;
      background: #262633; border: 1px solid #343442; border-radius: 8px;
      padding: 12px 14px; margin-bottom: 16px;
    }
  `;

  const VELOCIDADES = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5];

  /** Crea el panel lateral y lo rellena con las oraciones. */
  function crearPanel(titulo, oraciones) {
    quitarPanel(); // si había uno, fuera

    const host = document.createElement('div');
    host.id = '__lector-tts-panel';
    // z-index máximo posible: el panel queda por encima de cualquier página.
    host.style.cssText =
      'position:fixed;top:0;right:0;width:min(410px,100vw);height:100vh;z-index:2147483647;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${ESTILOS_PANEL}</style>
      <div class="panel">
        <header>
          <div class="fila titulo-fila">
            <span>🔊</span>
            <span class="titulo"></span>
            <button class="btn btn-cerrar" title="Cerrar y detener">✕</button>
          </div>
          <div class="fila">
            <button class="btn btn-ant" title="Oración anterior">⏮</button>
            <button class="btn btn-principal btn-pausa" title="Pausar / Reanudar">⏸</button>
            <button class="btn btn-sig" title="Oración siguiente">⏭</button>
            <select class="sel-vel" title="Velocidad de lectura"></select>
            <span class="progreso"></span>
          </div>
        </header>
        <div class="contenido"></div>
      </div>
    `;

    shadow.querySelector('.titulo').textContent = titulo;

    // Rellenar el texto: una oración = un <span> clicable.
    const zona = shadow.querySelector('.contenido');
    oraciones.forEach((oracion, i) => {
      const span = document.createElement('span');
      span.className = 'oracion';
      span.dataset.i = String(i);
      span.textContent = oracion + ' ';
      zona.appendChild(span);
    });

    // Clic en una oración = saltar a ella.
    zona.addEventListener('click', (ev) => {
      const span = ev.target && ev.target.closest ? ev.target.closest('.oracion') : null;
      if (!span) return;
      const i = Number(span.dataset.i);
      if (motor.leyendo) motor.saltarA(i);
      else motor.iniciar(oracionesActuales, i); // lectura terminada: reanudar desde aquí
    });

    // Botones del panel.
    shadow.querySelector('.btn-cerrar').addEventListener('click', () => cerrarPanel());
    shadow.querySelector('.btn-ant').addEventListener('click', () => motor.anterior());
    shadow.querySelector('.btn-sig').addEventListener('click', () => motor.siguiente());
    shadow.querySelector('.btn-pausa').addEventListener('click', () => {
      if (!motor.leyendo) motor.iniciar(oracionesActuales, 0); // volver a empezar
      else if (motor.enPausa) motor.reanudar();
      else motor.pausar();
    });

    // Selector rápido de velocidad (sincronizado con el popup vía storage).
    const selVel = shadow.querySelector('.sel-vel');
    selVel.addEventListener('change', () => {
      LectorTTS.guardarAjustes({ velocidad: parseFloat(selVel.value) });
    });

    (document.documentElement || document.body).appendChild(host);

    panel = {
      host,
      shadow,
      zona,
      selVel,
      btnPausa: shadow.querySelector('.btn-pausa'),
      progreso: shadow.querySelector('.progreso')
    };
    sincronizarVelocidadPanel();
  }

  /** Pone el selector de velocidad del panel en el valor guardado. */
  function sincronizarVelocidadPanel() {
    if (!panel) return;
    const vel = Number(motor.ajustes.velocidad) || 1.1;
    const lista = VELOCIDADES.includes(vel)
      ? VELOCIDADES
      : VELOCIDADES.concat(vel).sort((a, b) => a - b);
    panel.selVel.innerHTML = '';
    for (const v of lista) {
      const op = document.createElement('option');
      op.value = String(v);
      op.textContent = v + '×';
      panel.selVel.appendChild(op);
    }
    panel.selVel.value = String(vel);
  }

  /** Quita el panel del DOM (sin tocar el motor). */
  function quitarPanel() {
    if (panel) {
      panel.host.remove();
      panel = null;
    }
  }

  /** Cierra el panel Y detiene la lectura (botón ✕ o mensaje "detener"). */
  function cerrarPanel() {
    motor.detener();
    quitarPanel();
  }

  // ------------------------------------------------------------------
  // Resaltado de oración y de palabra
  // ------------------------------------------------------------------

  /**
   * Prepara una oración para el resaltado palabra a palabra: convierte su
   * texto en <span class="palabra"> con la posición inicial de cada palabra.
   */
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

  /** Resalta la oración i y hace auto-scroll hasta ella. */
  function resaltarOracion(i) {
    if (!panel) return;
    const previa = panel.shadow.querySelector('.oracion.actual');
    if (previa) {
      previa.classList.remove('actual');
      const palabraVieja = previa.querySelector('.palabra-actual');
      if (palabraVieja) palabraVieja.classList.remove('palabra-actual');
    }
    const span = panel.shadow.querySelector(`.oracion[data-i="${i}"]`);
    if (!span) return;
    span.classList.add('actual');
    prepararPalabras(span);
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    panel.progreso.textContent = (i + 1) + ' / ' + oracionesActuales.length;
  }

  /** Resalta la palabra que se está pronunciando (si la voz emite eventos). */
  function resaltarPalabra(i, charIndex) {
    if (!panel) return;
    const span = panel.shadow.querySelector(`.oracion[data-i="${i}"]`);
    if (!span || !span.dataset.conPalabras) return;
    let objetivo = null;
    span.querySelectorAll('.palabra').forEach((w) => {
      if (Number(w.dataset.ini) <= charIndex) objetivo = w;
    });
    const previa = span.querySelector('.palabra-actual');
    if (previa && previa !== objetivo) previa.classList.remove('palabra-actual');
    if (objetivo) objetivo.classList.add('palabra-actual');
  }

  // Conectar el motor con el panel.
  motor.alEmpezarOracion = resaltarOracion;
  motor.alPalabra = resaltarPalabra;
  motor.alCambiarEstado = (estado) => {
    if (!panel) return;
    panel.btnPausa.textContent = estado.leyendo && !estado.enPausa ? '⏸' : '▶';
  };
  motor.alTerminar = () => {
    if (!panel) return;
    const actual = panel.shadow.querySelector('.oracion.actual');
    if (actual) actual.classList.remove('actual');
    panel.progreso.textContent = 'Fin ✓';
  };

  // ------------------------------------------------------------------
  // Arranque de una lectura
  // ------------------------------------------------------------------

  /** Trocea el texto, monta el panel y empieza a leer. Devuelve false si no hay texto. */
  function empezarLectura(titulo, texto) {
    const oraciones = LectorTTS.trocearEnOraciones(texto);
    if (!oraciones.length) return false;
    oracionesActuales = oraciones;
    crearPanel(titulo, oraciones);
    motor.iniciar(oraciones, 0);
    return true;
  }

  /** Lee el artículo principal de la página (o todo el body como plan B). */
  function empezarLecturaPagina() {
    const { titulo, texto } = extraerArticulo();
    return empezarLectura(titulo, texto);
  }

  /** Lee la selección actual; si no hay, lee la página entera. */
  function empezarLecturaSeleccion(textoRespaldo) {
    const seleccion = (window.getSelection ? String(window.getSelection()) : '').trim()
      || String(textoRespaldo || '').trim();
    if (seleccion) return empezarLectura('Selección', seleccion);
    return empezarLecturaPagina();
  }

  // ------------------------------------------------------------------
  // Mensajes del popup y del background
  // ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((mensaje, remitente, responder) => {
    let ok = true;
    switch (mensaje && mensaje.accion) {
      case 'leer-pagina':
        ok = empezarLecturaPagina();
        break;
      case 'leer-seleccion':
        ok = empezarLecturaSeleccion(mensaje.textoRespaldo);
        break;
      case 'pausa-reanudar':
        if (motor.enPausa) motor.reanudar();
        else if (motor.leyendo) motor.pausar();
        else if (oracionesActuales.length) { // no sonaba nada: retomar desde el último punto
          crearPanelSiFalta();
          motor.iniciar(oracionesActuales, 0);
        }
        break;
      case 'detener':
        cerrarPanel();
        break;
      case 'siguiente':
        motor.siguiente();
        break;
      case 'anterior':
        motor.anterior();
        break;
      case 'estado':
        break; // solo se quiere el estado, que va en la respuesta
      default:
        responder({ ok: false, error: 'accion-desconocida' });
        return false;
    }
    responder({
      ok,
      error: ok ? null : 'sin-texto',
      estado: motor.estado()
    });
    return false; // respuesta síncrona
  });

  /** Si el panel se cerró pero queda texto cargado, lo vuelve a montar. */
  function crearPanelSiFalta() {
    if (!panel && oracionesActuales.length) {
      crearPanel(document.title || 'Página', oracionesActuales);
    }
  }
})();
