/**
 * content.js — Se ejecuta en cada página web.
 *
 * Desde la v1.1 el resaltado se hace SOBRE EL PROPIO TEXTO DE LA PÁGINA
 * (como Speechify): la oración que suena se ilumina en su sitio, la palabra
 * actual se marca dentro de ella y la página se desplaza sola. Nada de barra
 * lateral. Los controles van en una barrita flotante abajo.
 *
 * Cómo funciona:
 *   1. Se recorren los nodos de texto visibles de la página (o de la
 *      selección) y se construye un "texto total" recordando de qué nodo
 *      salió cada trozo (el mapa).
 *   2. El texto se trocea en oraciones POR POSICIONES (LectorTTS.trocearRangos),
 *      sin cruzar límites de párrafo/título.
 *   3. Al leer, cada oración/palabra se convierte en un Range del DOM y se
 *      pinta con la CSS Custom Highlight API (no modifica la página). En
 *      navegadores viejos sin esa API se usa la selección como respaldo.
 *
 * Las voces neuronales (Piper) se sintetizan en un iframe oculto de la
 * extensión (tts-frame.html), porque ahí la política de seguridad permite
 * ejecutar WASM; el audio resultante se reproduce aquí, en la página.
 */
(() => {
  'use strict';

  // Evita ejecutarse dos veces si el script se inyecta de nuevo.
  if (window.__lectorTTSCargado) return;
  window.__lectorTTSCargado = true;

  const motor = LectorTTS.crearMotorLectura();

  // Estado de la lectura en curso (o null).
  // { texto, mapa: [{nodo, desde, hasta, ini}], oraciones: [{ini, fin}] }
  let lectura = null;
  let barra = null;          // barrita flotante de controles
  let usandoSeleccion = false; // respaldo de resaltado con la selección

  // ¿Este navegador tiene la CSS Custom Highlight API?
  // (Chrome/Edge/Opera 105+, Firefox 140+)
  const soportaHighlight =
    typeof Highlight === 'function' &&
    typeof CSS !== 'undefined' && CSS.highlights;
  let hlParrafo = null;
  let hlOracion = null;
  let hlPalabra = null;
  let parrafoActual = null; // límites del párrafo ya pintado (para no repintar)

  // ------------------------------------------------------------------
  // Ajustes: carga inicial y sincronización con el popup
  // ------------------------------------------------------------------

  LectorTTS.cargarAjustes((ajustes) => { motor.ajustes = ajustes; calentarNeural(); });

  // Auto-encuadre en páginas web: por defecto SÍ sigue la lectura (se puede
  // apagar desde la barrita; la preferencia queda guardada).
  let seguirLectura = true;
  try {
    chrome.storage.sync.get({ seguirWeb: true }, (r) => {
      seguirLectura = !!r.seguirWeb;
      pintarSeguirBarra();
    });
  } catch (e) { /* nada */ }

  // "Leer al hacer clic": si está activo, un clic normal en el texto empieza a
  // leer desde ahí (y Alt+clic funciona SIEMPRE, esté activo o no). Se guarda
  // aparte, como la preferencia de auto-encuadre.
  let clicParaLeer = false;
  try {
    chrome.storage.sync.get({ clicParaLeer: false }, (r) => {
      clicParaLeer = !!r.clicParaLeer;
      reflejarClicBarra();
    });
  } catch (e) { /* nada */ }

  // Pre-calentado del motor neuronal. La PRIMERA lectura con una voz Piper
  // arranca "en frío" (crear el iframe + cargar el WASM + leer el modelo): eso
  // son los "un par de segundos" de espera. Lo dejamos listo en cuanto el
  // usuario interactúa con la página (si tiene una voz neuronal elegida), para
  // que al pulsar ▶ empiece a sonar al instante.
  let interactuado = false;   // ¿el usuario ya tocó la página?
  let vozCalentada = null;    // voz neuronal ya precalentada
  // Con `forzar` calienta aunque no se haya tocado la página (p. ej. al elegir
  // una voz nueva en el popup, que es señal clara de que se va a usar).
  function calentarNeural(forzar) {
    const v = motor.ajustes.vozNombre;
    if ((!forzar && !interactuado) || !LectorTTS.esVozNeural(v) || vozCalentada === v) return;
    vozCalentada = v;
    try {
      motor.sintetizarNeural('a', LectorTTS.idPiper(v), null)
        .catch(() => { vozCalentada = null; }); // si falla, se reintenta al leer
    } catch (e) { vozCalentada = null; }
  }
  function alPrimeraInteraccion() {
    window.removeEventListener('pointerdown', alPrimeraInteraccion, true);
    window.removeEventListener('scroll', alPrimeraInteraccion, true);
    window.removeEventListener('keydown', alPrimeraInteraccion, true);
    interactuado = true;
    calentarNeural(); // si los ajustes aún no cargaron, se calentará al cargar
  }
  window.addEventListener('pointerdown', alPrimeraInteraccion, true);
  window.addEventListener('scroll', alPrimeraInteraccion, true);
  window.addEventListener('keydown', alPrimeraInteraccion, true);

  chrome.storage.onChanged.addListener((cambios, area) => {
    if (area !== 'sync') return;
    if ('velocidad' in cambios) motor.fijarVelocidad(cambios.velocidad.newValue);
    if ('tono' in cambios) motor.fijarTono(cambios.tono.newValue);
    if ('vozNombre' in cambios) {
      motor.fijarVoz(cambios.vozNombre.newValue);
      vozCalentada = null;   // voz nueva: hay que precalentarla de nuevo
      calentarNeural(true);  // el usuario acaba de elegirla: prepárala ya
    }
    if ('seguirWeb' in cambios) {
      seguirLectura = !!cambios.seguirWeb.newValue;
      pintarSeguirBarra();
    }
    if ('clicParaLeer' in cambios) {
      clicParaLeer = !!cambios.clicParaLeer.newValue;
      reflejarClicBarra();
      if (clicParaLeer) toast('👆 Toca el texto que quieras escuchar');
    }
    sincronizarBarra(); // reflejar el cambio en la barrita si está abierta
  });

  // ------------------------------------------------------------------
  // Recolección del texto visible de la página
  // ------------------------------------------------------------------

  // Elementos cuyo texto nunca se lee.
  const IGNORAR = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'AUDIO', 'VIDEO', 'SELECT', 'TEXTAREA', 'BUTTON',
    'SUP', 'SUB' // notas al pie tipo [1] de Wikipedia y similares
  ]);
  // En modo "página completa", además se salta la "carpintería" del sitio.
  const IGNORAR_PAGINA = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'DIALOG']);
  // Etiquetas que marcan un límite de bloque (una oración no puede cruzarlo).
  const BLOQUES = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BODY', 'LI', 'UL', 'OL',
    'TABLE', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'DT', 'DD', 'FIGURE', 'FIGCAPTION'
  ]);

  /** ¿El elemento se ve? (con caché, porque se consulta muchísimo) */
  function crearDetectorVisibilidad() {
    const cache = new Map();
    return function esVisible(el) {
      if (!el) return false;
      if (cache.has(el)) return cache.get(el);
      let visible;
      if (typeof el.checkVisibility === 'function') {
        visible = el.checkVisibility(); // cubre display:none y visibility
      } else {
        visible = !!(el.getClientRects && el.getClientRects().length);
      }
      cache.set(el, visible);
      return visible;
    };
  }

  /** Bloque contenedor más cercano de un elemento (para los cortes). */
  function bloqueDe(el) {
    for (let e = el; e; e = e.parentElement) {
      if (BLOQUES.has(e.tagName)) return e;
    }
    return document.body;
  }

  /**
   * Recorre los nodos de texto visibles bajo `raiz` (limitados a `rango` si
   * se pasa) y devuelve {texto, mapa, cortes}.
   */
  function recolectar(raiz, rango, modoPagina) {
    const esVisible = crearDetectorVisibilidad();
    const decisionCache = new Map(); // elemento → ¿aceptado?

    function aceptaElemento(el) {
      if (!el) return false;
      if (decisionCache.has(el)) return decisionCache.get(el);
      let ok = true;
      for (let e = el; e && ok; e = e.parentElement) {
        if (IGNORAR.has(e.tagName)) ok = false;
        else if (modoPagina && IGNORAR_PAGINA.has(e.tagName)) ok = false;
        else if (e.id && String(e.id).startsWith('__lector-tts')) ok = false;
      }
      if (ok) ok = esVisible(el);
      decisionCache.set(el, ok);
      return ok;
    }

    const walker = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, {
      acceptNode(nodo) {
        if (!nodo.data || !nodo.data.trim()) return NodeFilter.FILTER_REJECT;
        if (rango && !rango.intersectsNode(nodo)) return NodeFilter.FILTER_REJECT;
        return aceptaElemento(nodo.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });

    let texto = '';
    const mapa = [];
    const cortes = [];
    let bloquePrevio = null;

    let nodo;
    while ((nodo = walker.nextNode())) {
      // Si leemos una selección, recorta el primer y el último nodo.
      let desde = 0;
      let hasta = nodo.data.length;
      if (rango) {
        if (nodo === rango.startContainer) desde = rango.startOffset;
        if (nodo === rango.endContainer) hasta = rango.endOffset;
      }
      if (hasta <= desde) continue;

      // Cambio de párrafo/título → una oración no puede cruzar por aquí.
      const bloque = bloqueDe(nodo.parentElement);
      if (bloquePrevio && bloque !== bloquePrevio && texto.length) {
        cortes.push(texto.length);
      }
      bloquePrevio = bloque;

      mapa.push({ nodo, desde, hasta, ini: texto.length });
      texto += nodo.data.slice(desde, hasta);
    }
    return { texto, mapa, cortes };
  }

  /** Mejor contenedor del contenido principal de la página. */
  function elegirRaiz() {
    return document.querySelector('article')
      || document.querySelector('main, [role="main"]')
      || document.body;
  }

  // ------------------------------------------------------------------
  // Resaltado sobre el texto real (Custom Highlight API + respaldo)
  // ------------------------------------------------------------------

  function prepararResaltado() {
    if (!soportaHighlight) return;
    if (!hlOracion) {
      hlParrafo = new Highlight();
      hlOracion = new Highlight();
      hlPalabra = new Highlight();
      // La palabra gana a la oración y la oración al párrafo.
      hlParrafo.priority = 1;
      hlOracion.priority = 2;
      hlPalabra.priority = 3;
      CSS.highlights.set('lector-tts-parrafo', hlParrafo);
      CSS.highlights.set('lector-tts-oracion', hlOracion);
      CSS.highlights.set('lector-tts-palabra', hlPalabra);
    }
    if (!document.getElementById('__lector-tts-estilos')) {
      const estilos = document.createElement('style');
      estilos.id = '__lector-tts-estilos';
      estilos.textContent =
        '::highlight(lector-tts-parrafo){background-color:rgba(108,92,255,.10);}' +
        '::highlight(lector-tts-oracion){background-color:rgba(108,92,255,.30);}' +
        '::highlight(lector-tts-palabra){background-color:#6c5cff;color:#fff;}';
      (document.head || document.documentElement).appendChild(estilos);
    }
  }

  function limpiarResaltado() {
    if (hlParrafo) hlParrafo.clear();
    if (hlOracion) hlOracion.clear();
    if (hlPalabra) hlPalabra.clear();
    parrafoActual = null;
    if (usandoSeleccion) {
      try { window.getSelection().removeAllRanges(); } catch (e) { /* nada */ }
      usandoSeleccion = false;
    }
  }

  /** Límites del párrafo (entre cortes de bloque) que contiene la oración. */
  function limitesParrafo(oracion) {
    let ini = 0;
    let fin = lectura.texto.length;
    for (const c of (lectura.cortes || [])) {
      if (c <= oracion.ini) ini = c;
      if (c >= oracion.fin) { fin = c; break; }
    }
    return { ini, fin };
  }

  /** Busca el segmento del mapa que contiene la posición `pos`. */
  function buscarSegmento(pos) {
    if (!lectura) return -1;
    const mapa = lectura.mapa;
    let a = 0;
    let b = mapa.length - 1;
    while (a <= b) {
      const m = (a + b) >> 1;
      const seg = mapa[m];
      const len = seg.hasta - seg.desde;
      if (pos < seg.ini) b = m - 1;
      else if (pos >= seg.ini + len) a = m + 1;
      else return m;
    }
    return -1;
  }

  /** Convierte posiciones [a, b) del texto total en un Range del DOM. */
  function crearRango(a, b) {
    if (!lectura || b <= a) return null;
    const iA = buscarSegmento(a);
    const iB = buscarSegmento(b - 1);
    if (iA < 0 || iB < 0) return null;
    const segA = lectura.mapa[iA];
    const segB = lectura.mapa[iB];
    if (!segA.nodo.isConnected || !segB.nodo.isConnected) return null;
    try {
      const r = document.createRange();
      r.setStart(segA.nodo, segA.desde + (a - segA.ini));
      r.setEnd(segB.nodo, segB.desde + (b - 1 - segB.ini) + 1);
      return r;
    } catch (e) {
      return null; // la página cambió bajo nuestros pies: sin resaltado
    }
  }

  /** Desplaza la página para que el rango quede a la vista. */
  function autoDesplazar(rango, forzar) {
    if (!seguirLectura && !forzar) return; // navegación libre: no tocar el scroll
    let rect;
    try { rect = rango.getBoundingClientRect(); } catch (e) { return; }
    if (!rect || (rect.top === 0 && rect.bottom === 0)) return;
    if (forzar || rect.top < 80 || rect.bottom > window.innerHeight - 150) {
      const cont = rango.startContainer;
      const el = cont.nodeType === Node.TEXT_NODE ? cont.parentElement : cont;
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  /** Encuadra la oración que se está leyendo (al activar el seguimiento). */
  function irAOracionActual() {
    if (!lectura || !lectura.oraciones.length) return;
    const o = lectura.oraciones[motor.indice];
    if (!o) return;
    const rango = crearRango(o.ini, o.fin);
    if (rango) autoDesplazar(rango, true);
  }

  /** Resalta la oración `idx` en su sitio de la página. */
  function resaltarOracion(idx) {
    if (!lectura) return;
    const o = lectura.oraciones[idx];
    if (!o) return;
    const rango = crearRango(o.ini, o.fin);
    if (barra) {
      barra.progreso.textContent = (idx + 1) + ' / ' + lectura.oraciones.length;
    }
    if (!rango) return;
    if (soportaHighlight) {
      // Párrafo (solo se repinta al cambiar de párrafo).
      const lp = limitesParrafo(o);
      if (!parrafoActual || lp.ini !== parrafoActual.ini || lp.fin !== parrafoActual.fin) {
        hlParrafo.clear();
        const rangoParrafo = crearRango(lp.ini, lp.fin);
        if (rangoParrafo) hlParrafo.add(rangoParrafo);
        parrafoActual = lp;
      }
      hlPalabra.clear();
      hlOracion.clear();
      hlOracion.add(rango);
    } else {
      // Respaldo para navegadores sin Highlight API: usar la selección.
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(rango);
        usandoSeleccion = true;
      } catch (e) { /* nada */ }
    }
    autoDesplazar(rango);
  }

  /** Resalta la palabra que se está pronunciando dentro de la oración. */
  function resaltarPalabra(idx, charIndex) {
    if (!soportaHighlight || !lectura) return;
    const o = lectura.oraciones[idx];
    if (!o) return;
    const t = lectura.texto;
    let p = o.ini + Math.max(0, Math.min(charIndex, o.fin - o.ini - 1));
    while (p < o.fin && /\s/.test(t[p])) p++; // si cae en un espacio, avanza
    if (p >= o.fin) return;
    let a = p;
    while (a > o.ini && !/\s/.test(t[a - 1])) a--;
    let b = p;
    while (b < o.fin && !/\s/.test(t[b])) b++;
    const rango = crearRango(a, b);
    if (!rango) return;
    hlPalabra.clear();
    hlPalabra.add(rango);
  }

  // ------------------------------------------------------------------
  // Barrita flotante de controles
  // ------------------------------------------------------------------

  const ESTILOS_BARRA = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .barra {
      display: flex; flex-direction: column; gap: 7px;
      background: rgba(26, 26, 34, .94);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      color: #e9e9ef;
      border: 1px solid #3a3a4e; border-radius: 16px;
      padding: 10px 12px;
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      box-shadow: 0 10px 34px rgba(0, 0, 0, .5);
    }
    /* Asa para arrastrar la barra (y para reabrirla cuando está contraída). */
    .asa {
      display: flex; align-items: center; justify-content: center;
      cursor: grab; user-select: none; touch-action: none;
      color: #7a7a90; font-size: 16px; line-height: 1;
      margin: -4px 0 0; padding: 2px;
    }
    .asa:active { cursor: grabbing; }
    .asa-grip { pointer-events: none; }
    /* Contraída: solo se ven ⏮ ⏸ ⏭ (y el asa para mover / volver a abrir). */
    .barra.contraida { padding: 6px 10px; }
    .barra.contraida .fila-2,
    .barra.contraida .mensaje,
    .barra.contraida .grupo,
    .barra.contraida .progreso,
    .barra.contraida .btn-cerrar { display: none; }
    .barra.contraida .fila { justify-content: center; }
    .barra.contraida .asa { cursor: pointer; }
    .fila { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .btn {
      appearance: none; border: 1px solid #3a3a4e; background: #2a2a38;
      color: #e9e9ef; border-radius: 999px; cursor: pointer;
      font-size: 14px; line-height: 1; padding: 8px 11px;
      transition: background .15s;
    }
    .btn:hover { background: #363648; }
    .btn.activo {
      background: linear-gradient(135deg, #7c5cff, #5a8bff);
      border-color: transparent; color: #fff;
    }
    .btn.activo:hover { filter: brightness(1.12); background: linear-gradient(135deg, #7c5cff, #5a8bff); }
    .btn-principal {
      background: linear-gradient(135deg, #7c5cff, #5a8bff);
      border-color: transparent; font-size: 15px; padding: 8px 15px;
    }
    .btn-principal:hover { filter: brightness(1.12); }
    .btn-principal.atencion { animation: latido 1s infinite; }
    @keyframes latido { 50% { transform: scale(1.12); } }
    select {
      appearance: none; border: 1px solid #3a3a4e; background: #2a2a38;
      color: #e9e9ef; border-radius: 10px; padding: 7px 9px;
      font-size: 11.5px; cursor: pointer; max-width: 210px; flex: 1;
    }
    .grupo {
      display: flex; align-items: center; gap: 2px;
      background: #2a2a38; border: 1px solid #3a3a4e;
      border-radius: 999px; padding: 2px 5px;
    }
    .grupo .mini { font-size: 10px; color: #9a9aac; padding: 0 3px; }
    .grupo button {
      appearance: none; border: none; background: transparent; color: #e9e9ef;
      font-size: 14px; font-weight: 700; cursor: pointer;
      padding: 5px 7px; border-radius: 999px;
    }
    .grupo button:hover { background: #3a3a4e; }
    .grupo .valor { font-size: 12px; font-weight: 650; color: #fff; min-width: 34px; text-align: center; }
    .grupo.desactivado { opacity: .4; }
    .grupo.desactivado button { cursor: not-allowed; }
    .grupo.desactivado button:hover { background: transparent; }
    .progreso { font-size: 11.5px; color: #9a9aac; min-width: 50px; text-align: center; margin-left: auto; }
    .mensaje { font-size: 11.5px; color: #ffd9a8; max-width: 320px; }
    .mensaje:empty { display: none; }
  `;

  function crearBarra() {
    if (barra) return;
    const host = document.createElement('div');
    host.id = '__lector-tts-barra';
    host.style.cssText =
      'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);' +
      'z-index:2147483647;max-width:calc(100vw - 16px);';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${ESTILOS_BARRA}</style>
      <div class="barra">
        <div class="asa" title="Arrastra para mover la barra · se contrae al hacer clic fuera · tócala para abrir todos los controles">
          <span class="asa-grip">⠿</span>
        </div>
        <div class="contenido">
        <div class="fila">
          <button class="btn btn-ant" title="Oración anterior">⏮</button>
          <button class="btn btn-principal btn-pausa" title="Pausar / Reanudar">⏸</button>
          <button class="btn btn-sig" title="Oración siguiente">⏭</button>
          <div class="grupo" title="Velocidad de lectura (0.5× a 5×)">
            <button class="vel-menos">−</button>
            <span class="valor val-vel">1.1×</span>
            <button class="vel-mas">+</button>
          </div>
          <span class="progreso"></span>
          <button class="btn btn-cerrar" title="Cerrar y detener">✕</button>
        </div>
        <div class="fila fila-2">
          <select class="sel-voz" title="Voz"></select>
          <div class="grupo grupo-tono" title="Tono (voces del sistema)">
            <span class="mini">Tono</span>
            <button class="tono-menos">−</button>
            <span class="valor val-tono">1.0</span>
            <button class="tono-mas">+</button>
          </div>
          <button class="btn btn-clic" title="Leer al hacer clic">👆</button>
          <button class="btn btn-seguir" title="Auto-encuadre de la lectura">🎯</button>
        </div>
        <span class="mensaje"></span>
        </div>
        <!-- fin .contenido -->
      </div>
    `;
    shadow.querySelector('.btn-cerrar').addEventListener('click', cerrarLectura);
    shadow.querySelector('.btn-ant').addEventListener('click', () => motor.anterior());
    shadow.querySelector('.btn-sig').addEventListener('click', () => motor.siguiente());
    shadow.querySelector('.btn-pausa').addEventListener('click', () => {
      // Este clic es un gesto real del usuario: sirve también para
      // desbloquear el audio cuando el navegador exige interacción.
      if (!motor.leyendo && lectura) reanudarDesdeCero();
      else if (motor.enPausa) motor.reanudar();
      else motor.pausar();
    });

    // Contadores de −/+ 0.1 para velocidad y tono. El cambio se guarda en
    // chrome.storage y el "eco" lo aplica al motor (mismo camino que el popup).
    shadow.querySelector('.vel-menos').addEventListener('click', () => pasoBarra('velocidad', -0.1, 0.5, 5));
    shadow.querySelector('.vel-mas').addEventListener('click', () => pasoBarra('velocidad', 0.1, 0.5, 5));
    shadow.querySelector('.tono-menos').addEventListener('click', () => pasoBarra('tono', -0.1, 0.5, 2));
    shadow.querySelector('.tono-mas').addEventListener('click', () => pasoBarra('tono', 0.1, 0.5, 2));

    const selVoz = shadow.querySelector('.sel-voz');
    selVoz.addEventListener('change', () => {
      // El eco de storage.onChanged aplica la voz al motor y llama a
      // sincronizarBarra(), que ya refleja el estado del control de tono.
      LectorTTS.guardarAjustes({ vozNombre: selVoz.value });
    });

    // Interruptor de "leer al hacer clic". El eco de storage.onChanged
    // actualiza el estado, el botón y muestra el aviso (camino único).
    shadow.querySelector('.btn-clic').addEventListener('click', () => {
      LectorTTS.guardarAjustes({ clicParaLeer: !clicParaLeer });
    });

    // Interruptor de auto-encuadre: 🎯 la vista sigue a la lectura /
    // 🧭 navegación libre (la preferencia se guarda).
    shadow.querySelector('.btn-seguir').addEventListener('click', () => {
      seguirLectura = !seguirLectura;
      pintarSeguirBarra();
      LectorTTS.guardarAjustes({ seguirWeb: seguirLectura });
      if (seguirLectura) irAOracionActual(); // al activarlo, encuadra ya
    });

    (document.documentElement || document.body).appendChild(host);
    barra = {
      host,
      shadow,
      selVoz,
      asa: shadow.querySelector('.asa'),
      contraida: false,
      creadaEn: Date.now(),
      btnPausa: shadow.querySelector('.btn-pausa'),
      btnSeguir: shadow.querySelector('.btn-seguir'),
      btnClic: shadow.querySelector('.btn-clic'),
      progreso: shadow.querySelector('.progreso'),
      mensaje: shadow.querySelector('.mensaje'),
      valVel: shadow.querySelector('.val-vel'),
      valTono: shadow.querySelector('.val-tono'),
      grupoTono: shadow.querySelector('.grupo-tono'),
      btnTonoMenos: shadow.querySelector('.tono-menos'),
      btnTonoMas: shadow.querySelector('.tono-mas')
    };
    hacerArrastrable(host, barra.asa);
    aplicarPosicionBarra(host);
    poblarVocesBarra();
    sincronizarBarra();
    pintarSeguirBarra();
    reflejarClicBarra();
  }

  /** Refleja el estado del auto-encuadre en su botón de la barrita. */
  function pintarSeguirBarra() {
    if (!barra) return;
    barra.btnSeguir.textContent = seguirLectura ? '🎯' : '🧭';
    barra.btnSeguir.title = seguirLectura
      ? 'La vista sigue a la lectura. Clic para navegar libremente.'
      : 'Navegación libre. Clic para que la vista siga a la lectura.';
  }

  /** Refleja el estado del "leer al hacer clic" en su botón de la barrita. */
  function reflejarClicBarra() {
    if (!barra || !barra.btnClic) return;
    barra.btnClic.classList.toggle('activo', clicParaLeer);
    barra.btnClic.title = clicParaLeer
      ? 'Leer al hacer clic: ACTIVADO. Toca cualquier texto para leerlo. Clic aquí para desactivarlo.'
      : 'Leer al hacer clic: apagado. Actívalo y toca un texto para escucharlo (o usa Alt+clic sin activar nada).';
  }

  // Aviso flotante breve (p. ej. al activar "leer al hacer clic"). No usa la
  // barrita porque puede no existir todavía.
  let toastEl = null;
  let toastTimer = null;
  function toast(texto) {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = '__lector-tts-toast';
        toastEl.style.cssText =
          'position:fixed;left:50%;top:16px;transform:translateX(-50%);' +
          'z-index:2147483647;background:#23232e;color:#fff;border:1px solid #7c5cff;' +
          'border-radius:10px;padding:9px 14px;font:600 13px/1.3 system-ui,sans-serif;' +
          'box-shadow:0 6px 22px rgba(0,0,0,.45);pointer-events:none;max-width:calc(100vw - 24px);';
      }
      toastEl.textContent = texto;
      (document.documentElement || document.body).appendChild(toastEl);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { if (toastEl) toastEl.remove(); }, 4000);
    } catch (e) { /* nada */ }
  }

  // ---- Arrastrar y contraer la barrita -------------------------------------

  /** Posiciona la barra a mano (izquierda/arriba en píxeles). */
  function colocarBarra(host, left, top) {
    host.style.left = left + 'px';
    host.style.top = top + 'px';
    host.style.bottom = 'auto';
    host.style.transform = 'none';
  }

  /** La mantiene dentro de la pantalla (tras mover, contraer o expandir). */
  function ajustarDentroDePantalla(host) {
    if (!host.style.left || host.style.left === 'auto') return; // sigue centrada por defecto
    requestAnimationFrame(() => {
      const r = host.getBoundingClientRect();
      const l = Math.max(4, Math.min(r.left, window.innerWidth - r.width - 4));
      const t = Math.max(4, Math.min(r.top, window.innerHeight - r.height - 4));
      colocarBarra(host, l, t);
    });
  }

  /** Restaura la posición guardada de la barra (si la hay). */
  function aplicarPosicionBarra(host) {
    try {
      chrome.storage.sync.get({ posBarra: null }, (r) => {
        const p = r && r.posBarra;
        if (!p || !barra || barra.host !== host) return;
        const rect = host.getBoundingClientRect();
        const left = Math.max(4, Math.min(p.left, window.innerWidth - rect.width - 4));
        const top = Math.max(4, Math.min(p.top, window.innerHeight - rect.height - 4));
        colocarBarra(host, left, top);
      });
    } catch (e) { /* nada */ }
  }

  /** Hace la barra arrastrable tirando de su asa (⠿). */
  function hacerArrastrable(host, asa) {
    if (!asa) return;
    let activo = false, movido = false;
    let sx = 0, sy = 0, ox = 0, oy = 0;
    asa.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const r = host.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = ev.clientX; sy = ev.clientY;
      activo = true; movido = false;
      try { asa.setPointerCapture(ev.pointerId); } catch (e) { /* nada */ }
      ev.preventDefault();
    });
    asa.addEventListener('pointermove', (ev) => {
      if (!activo) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!movido && Math.abs(dx) + Math.abs(dy) < 4) return; // umbral: clic vs arrastre
      movido = true;
      const r = host.getBoundingClientRect();
      const l = Math.max(4, Math.min(ox + dx, window.innerWidth - r.width - 4));
      const t = Math.max(4, Math.min(oy + dy, window.innerHeight - r.height - 4));
      colocarBarra(host, l, t);
    });
    function soltar(ev) {
      if (!activo) return;
      activo = false;
      try { asa.releasePointerCapture(ev.pointerId); } catch (e) { /* nada */ }
      if (movido) {
        const r = host.getBoundingClientRect();
        LectorTTS.guardarAjustes({ posBarra: { left: Math.round(r.left), top: Math.round(r.top) } });
      } else if (barra && barra.contraida) {
        colapsarBarra(false); // un toque sin arrastrar reabre la barra contraída
      }
    }
    asa.addEventListener('pointerup', soltar);
    asa.addEventListener('pointercancel', soltar);
  }

  /** Contrae (true) o expande (false) la barra. */
  function colapsarBarra(contraer) {
    if (!barra) return;
    barra.contraida = !!contraer;
    const b = barra.shadow.querySelector('.barra');
    if (b) b.classList.toggle('contraida', barra.contraida);
    ajustarDentroDePantalla(barra.host);
  }

  // Al hacer clic FUERA de la barra, se contrae para no ocupar espacio.
  document.addEventListener('click', (ev) => {
    if (!barra || barra.contraida) return;
    if (ev.target === barra.host) return; // clic dentro (el shadow re-apunta al host)
    if (ev.target && ev.target.id && String(ev.target.id).startsWith('__lector-tts')) return;
    if (Date.now() - (barra.creadaEn || 0) < 500) return; // no con el clic que la creó
    colapsarBarra(true);
  }, true);

  const timersPasoBarra = {};
  function pasoBarra(clave, delta, minimo, maximo) {
    const actual = Number(motor.ajustes[clave]) || 1;
    const nuevo = Math.round(Math.min(maximo, Math.max(minimo, actual + delta)) * 10) / 10;
    motor.ajustes[clave] = nuevo; // respuesta visual inmediata en pasos seguidos
    sincronizarBarra();
    // Con audio neuronal sonando, la velocidad cambia AL INSTANTE.
    if (clave === 'velocidad' && motor._audio) {
      motor._audio.playbackRate = Math.min(16, Math.max(0.25, nuevo));
    }
    clearTimeout(timersPasoBarra[clave]);
    timersPasoBarra[clave] = setTimeout(() => {
      LectorTTS.guardarAjustes({ [clave]: nuevo });
    }, 250);
  }

  /** Refleja los ajustes actuales en la barrita. */
  function sincronizarBarra() {
    if (!barra) return;
    barra.valVel.textContent = (Number(motor.ajustes.velocidad) || 1.1).toFixed(1) + '×';
    barra.valTono.textContent = (Number(motor.ajustes.tono) || 1).toFixed(1);
    barra.selVoz.value = motor.ajustes.vozNombre || '';
    if (barra.selVoz.value !== (motor.ajustes.vozNombre || '')) barra.selVoz.value = '';
    reflejarTonoBarra();
  }

  /**
   * Activa o desactiva (en gris) el control de tono de la barrita: las voces
   * neuronales Piper no admiten cambio de tono, solo de velocidad.
   */
  function reflejarTonoBarra() {
    if (!barra) return;
    const permite = LectorTTS.soportaTono(motor.ajustes.vozNombre);
    barra.btnTonoMenos.disabled = !permite;
    barra.btnTonoMas.disabled = !permite;
    if (barra.grupoTono) {
      barra.grupoTono.classList.toggle('desactivado', !permite);
      barra.grupoTono.title = permite
        ? 'Tono (voces del sistema)'
        : 'Las voces neuronales no permiten cambiar el tono (solo la velocidad)';
    }
  }

  /** Rellena el selector de voz de la barrita (neuronales + sistema). */
  function poblarVocesBarra() {
    if (!barra) return;
    const sel = barra.selVoz;
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '✨ Voz automática (español)';
    sel.appendChild(auto);

    const grupoNeural = document.createElement('optgroup');
    grupoNeural.label = '🌟 Neuronales (descarga única)';
    for (const voz of LectorTTS.VOCES_NEURALES) {
      const op = document.createElement('option');
      op.value = voz.id;
      op.textContent = voz.etiqueta;
      grupoNeural.appendChild(op);
    }
    sel.appendChild(grupoNeural);

    const voces = LectorTTS.obtenerVoces();
    const esEspanola = (v) => v.lang && v.lang.toLowerCase().startsWith('es');
    const orden = (a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    const grupoSistema = document.createElement('optgroup');
    grupoSistema.label = 'Voces del sistema';
    for (const voz of voces.filter(esEspanola).sort(orden).concat(voces.filter((v) => !esEspanola(v)).sort(orden))) {
      const op = document.createElement('option');
      op.value = voz.name;
      op.textContent = voz.name + ' (' + voz.lang + ')';
      grupoSistema.appendChild(op);
    }
    if (grupoSistema.children.length) sel.appendChild(grupoSistema);
  }

  // Las voces del sistema llegan tarde en Chromium: repoblar cuando avisen.
  if (window.speechSynthesis && typeof window.speechSynthesis.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      if (barra) { poblarVocesBarra(); sincronizarBarra(); }
    });
  }

  let temporizadorMensaje = null;
  /** Muestra un texto en la barrita (fijo si `fijo`, si no 8 s). */
  function mensajeBarra(texto, fijo) {
    if (!barra) return;
    barra.mensaje.textContent = texto || '';
    clearTimeout(temporizadorMensaje);
    if (texto && !fijo) {
      temporizadorMensaje = setTimeout(() => {
        if (barra) barra.mensaje.textContent = '';
      }, 8000);
    }
  }

  function quitarBarra() {
    if (barra) {
      barra.host.remove();
      barra = null;
    }
  }

  // ------------------------------------------------------------------
  // Voces neuronales: iframe oculto de la extensión (tts-frame.html)
  // ------------------------------------------------------------------

  let promesaFrame = null;

  /** Crea (una sola vez) el iframe que aloja el motor neuronal. */
  function asegurarFrame() {
    if (promesaFrame) return promesaFrame;
    promesaFrame = new Promise((resolver, rechazar) => {
      const frame = document.createElement('iframe');
      frame.id = '__lector-tts-frame';
      frame.src = chrome.runtime.getURL('tts-frame.html');
      frame.style.cssText = 'display:none;width:0;height:0;border:0;';
      const temporizador = setTimeout(() => {
        rechazar(new Error('el motor neuronal tardó demasiado en cargar'));
      }, 20000);
      frame.addEventListener('load', () => {
        clearTimeout(temporizador);
        resolver(frame);
      });
      frame.addEventListener('error', () => {
        clearTimeout(temporizador);
        rechazar(new Error('no se pudo cargar el motor neuronal'));
      });
      (document.documentElement || document.body).appendChild(frame);
    });
    return promesaFrame;
  }

  // Enchufar la síntesis neuronal al motor: se pide al iframe por
  // MessageChannel y responde con el WAV (o el progreso de descarga).
  motor.sintetizarNeural = function (texto, idVoz, alProgreso) {
    return asegurarFrame().then((frame) => new Promise((resolver, rechazar) => {
      const canal = new MessageChannel();
      canal.port1.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.tipo === 'progreso') {
          if (alProgreso) alProgreso({ cargado: d.cargado, total: d.total });
        } else if (d.tipo === 'audio') {
          canal.port1.close();
          resolver(new Blob([d.datos], { type: 'audio/wav' }));
        } else if (d.tipo === 'error') {
          canal.port1.close();
          rechazar(new Error(d.error || 'fallo en la síntesis'));
        }
      };
      frame.contentWindow.postMessage(
        { lectorTTS: true, tipo: 'sintetizar', texto, voz: idVoz },
        '*',
        [canal.port2]
      );
    }));
  };

  // ------------------------------------------------------------------
  // Conexión del motor con la interfaz
  // ------------------------------------------------------------------

  motor.alEmpezarOracion = resaltarOracion;
  motor.alPalabra = resaltarPalabra;
  motor.alCambiarEstado = (estado) => {
    if (!barra) return;
    barra.btnPausa.textContent = estado.leyendo && !estado.enPausa ? '⏸' : '▶';
    if (!estado.enPausa) barra.btnPausa.classList.remove('atencion');
  };
  motor.alTerminar = () => {
    limpiarResaltado();
    if (barra) {
      barra.progreso.textContent = 'Fin ✓';
      barra.btnPausa.textContent = '▶';
    }
  };
  motor.alProgresoDescarga = (pct) => {
    if (pct === null) mensajeBarra('');
    else mensajeBarra('Descargando voz neuronal… ' + pct + '% (solo la primera vez)', true);
  };
  motor.alBloqueoAudio = () => {
    if (!barra) return;
    barra.btnPausa.classList.add('atencion');
    mensajeBarra('Pulsa ▶ para escuchar (el navegador pide un clic)', true);
  };
  motor.alAviso = (texto) => mensajeBarra(texto);

  // ------------------------------------------------------------------
  // Arranque y control de lecturas
  // ------------------------------------------------------------------

  /**
   * Prepara y arranca la lectura a partir de una recolección.
   * `posicionInicio` (opcional) es una posición dentro de rec.texto: la lectura
   * empieza en la oración que la contiene (se usa al leer al hacer clic).
   */
  function iniciarLectura(rec, posicionInicio) {
    const rangos = LectorTTS.trocearRangos(rec.texto, rec.cortes)
      .filter((r) => rec.texto.slice(r.ini, r.fin).trim());
    if (!rangos.length) return false;
    let desde = 0;
    if (posicionInicio != null) {
      const j = rangos.findIndex((o) => posicionInicio >= o.ini && posicionInicio < o.fin);
      if (j >= 0) desde = j;
    }
    limpiarResaltado();
    lectura = { texto: rec.texto, mapa: rec.mapa, oraciones: rangos, cortes: rec.cortes };
    prepararResaltado();
    crearBarra();
    mensajeBarra('');
    motor.iniciar(rangos.map((r) => rec.texto.slice(r.ini, r.fin)), desde);
    return true;
  }

  /** Lee el contenido principal de la página, resaltando en el sitio. */
  function leerPagina() {
    const raiz = elegirRaiz();
    const rec = recolectar(raiz, null, true);
    return iniciarLectura(rec);
  }

  /** Lee la selección actual; si no hay, lee la página entera. */
  function leerSeleccion(textoRespaldo) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const rango = sel.getRangeAt(0).cloneRange();
      const comun = rango.commonAncestorContainer;
      const raiz = comun.nodeType === Node.ELEMENT_NODE ? comun : comun.parentElement;
      if (raiz) {
        const rec = recolectar(raiz, rango, false);
        if (rec.texto.trim()) {
          // La selección desaparece al resaltar: la soltamos nosotros antes.
          try { sel.removeAllRanges(); } catch (e) { /* nada */ }
          return iniciarLectura(rec);
        }
      }
    }
    // Sin selección viva pero con texto de respaldo (menú contextual):
    // se lee sin resaltado, con la barrita como único indicador.
    const respaldo = String(textoRespaldo || '').trim();
    if (respaldo) {
      const rangos = LectorTTS.trocearRangos(respaldo, []);
      if (!rangos.length) return false;
      limpiarResaltado();
      lectura = { texto: respaldo, mapa: [], oraciones: rangos, cortes: [] };
      crearBarra();
      motor.iniciar(rangos.map((r) => respaldo.slice(r.ini, r.fin)), 0);
      return true;
    }
    return leerPagina();
  }

  /** Tras un "Fin ✓", el botón ▶ vuelve a empezar desde arriba. */
  function reanudarDesdeCero() {
    if (!lectura) return;
    prepararResaltado();
    motor.iniciar(
      lectura.oraciones.map((r) => lectura.texto.slice(r.ini, r.fin)),
      0
    );
  }

  /** Cierra la barrita, apaga el resaltado y detiene la voz. */
  function cerrarLectura() {
    motor.detener();
    limpiarResaltado();
    quitarBarra();
    lectura = null;
  }

  // ---- Leer al hacer clic / saltar por clic --------------------------------

  /** Nodo de texto y offset donde cayó un clic (o {nodo:null}). */
  function nodoOffsetDeClic(ev) {
    let nodo = null;
    let offset = 0;
    const cr = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(ev.clientX, ev.clientY)
      : null;
    if (cr) {
      nodo = cr.startContainer;
      offset = cr.startOffset;
    } else if (document.caretPositionFromPoint) {
      const cp = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (cp) { nodo = cp.offsetNode; offset = cp.offset; }
    }
    return { nodo, offset };
  }

  /** Posición dentro del texto recolectado de (nodo, offset), o null. */
  function posicionEnMapa(mapa, nodo, offset) {
    for (const seg of mapa) {
      if (seg.nodo === nodo && offset >= seg.desde && offset <= seg.hasta) {
        return seg.ini + (offset - seg.desde);
      }
    }
    return null;
  }

  /** ¿El clic cayó sobre algo "usable" (enlace, botón, campo…)? */
  function esInteractivo(nodo) {
    let el = nodo && (nodo.nodeType === Node.ELEMENT_NODE ? nodo : nodo.parentElement);
    for (; el; el = el.parentElement) {
      const t = el.tagName;
      if (t === 'A' || t === 'BUTTON' || t === 'INPUT' || t === 'SELECT' ||
          t === 'TEXTAREA' || t === 'LABEL' || t === 'SUMMARY') return true;
      if (el.isContentEditable) return true;
      const rol = el.getAttribute && el.getAttribute('role');
      if (rol === 'button' || rol === 'link' || rol === 'menuitem' || rol === 'tab') return true;
    }
    return false;
  }

  /** Recolecta la página y empieza a leer desde donde se hizo clic. */
  function leerDesdeClic(nodo, offset) {
    // Raíz que CONTENGA el nodo clicado; si el modo "página" lo dejaría fuera,
    // recolectamos todo el cuerpo (así se lee incluso en páginas "difíciles").
    let raiz = elegirRaiz();
    if (!raiz.contains(nodo)) raiz = document.body;
    let rec = recolectar(raiz, null, true);
    let posicion = posicionEnMapa(rec.mapa, nodo, offset);
    if (posicion === null) {
      rec = recolectar(document.body, null, false);
      posicion = posicionEnMapa(rec.mapa, nodo, offset);
    }
    return iniciarLectura(rec, posicion === null ? undefined : posicion);
  }

  // Precedencia de un clic sobre texto:
  //   (1) Alt+clic → leer desde ahí SIEMPRE (gesto deliberado, incluso enlaces).
  //   (2) Mientras se lee → saltar a la frase tocada (solo texto no interactivo).
  //   (3) Modo "leer al clic" → empezar a leer desde ahí (solo texto no interactivo).
  // Fuera de esos casos, el clic sigue su curso normal en la página.
  document.addEventListener('click', (ev) => {
    if (ev.target && ev.target.id && String(ev.target.id).startsWith('__lector-tts')) return;

    const alt = !!ev.altKey;
    const leyendoConMapa = lectura && motor.leyendo && lectura.mapa.length;
    if (!alt && !clicParaLeer && !leyendoConMapa) return;

    const { nodo, offset } = nodoOffsetDeClic(ev);
    if (!nodo || nodo.nodeType !== Node.TEXT_NODE || !nodo.data || !nodo.data.trim()) return;

    // (1) Alt+clic: leer desde ahí, aunque sea un enlace o un botón.
    if (alt) {
      ev.preventDefault(); ev.stopPropagation();
      leerDesdeClic(nodo, offset);
      return;
    }

    // Sin Alt, NO tocamos enlaces/botones/campos: la página sigue usable.
    if (esInteractivo(nodo)) return;

    // (2) Ya leyendo: saltar a la frase tocada si cae en el texto en curso.
    if (leyendoConMapa) {
      const pos = posicionEnMapa(lectura.mapa, nodo, offset);
      if (pos !== null) {
        const idx = lectura.oraciones.findIndex((o) => pos >= o.ini && pos < o.fin);
        if (idx >= 0) { ev.preventDefault(); ev.stopPropagation(); motor.saltarA(idx); return; }
      }
    }

    // (3) Modo "leer al clic": empezar a leer desde donde se tocó.
    if (clicParaLeer) {
      ev.preventDefault(); ev.stopPropagation();
      leerDesdeClic(nodo, offset);
    }
  }, true);

  // ------------------------------------------------------------------
  // Mensajes del popup y del background
  // ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((mensaje, remitente, responder) => {
    let ok = true;
    switch (mensaje && mensaje.accion) {
      case 'leer-pagina':
        ok = leerPagina();
        break;
      case 'leer-seleccion':
        ok = leerSeleccion(mensaje.textoRespaldo);
        break;
      case 'pausa-reanudar':
        if (motor.enPausa) motor.reanudar();
        else if (motor.leyendo) motor.pausar();
        else if (lectura) reanudarDesdeCero();
        break;
      case 'detener':
        cerrarLectura();
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
})();
