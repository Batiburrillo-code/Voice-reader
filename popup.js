/**
 * popup.js — Lógica del popup de la extensión.
 *
 * El popup NO lee en voz alta (se cierra al hacer clic fuera y la voz se
 * cortaría). Solo:
 *   - guarda las preferencias (voz, velocidad, qué se lee) en chrome.storage.sync,
 *   - manda órdenes al content script de la pestaña activa,
 *   - abre reader.html cuando la pestaña es un PDF,
 *   - muestra avisos amables cuando una página no se puede leer.
 */
(() => {
  'use strict';

  // ---- Referencias a los controles -------------------------------------
  const selVoz = document.getElementById('sel-voz');
  const rangoVel = document.getElementById('rango-vel');
  const txtVel = document.getElementById('txt-vel');
  const listaLectura = document.getElementById('lista-lectura');
  const btnLeerPagina = document.getElementById('btn-leer-pagina');
  const btnLeerSeleccion = document.getElementById('btn-leer-seleccion');
  const btnPausa = document.getElementById('btn-pausa');
  const btnDetener = document.getElementById('btn-detener');
  const btnAnterior = document.getElementById('btn-anterior');
  const btnSiguiente = document.getElementById('btn-siguiente');
  const btnPdf = document.getElementById('btn-pdf');
  const btnPermisos = document.getElementById('btn-permisos');
  const btnClic = document.getElementById('btn-clic');
  const divEstado = document.getElementById('estado');

  const AJUSTES_DEFECTO = LectorTTS.AJUSTES_DEFECTO;
  let ajustes = Object.assign({}, AJUSTES_DEFECTO);

  // ---- Utilidades -------------------------------------------------------

  function mostrarAviso(texto, esError) {
    divEstado.textContent = texto || '';
    divEstado.className = esError ? 'error' : '';
  }

  /** ¿La URL apunta a un PDF? (visor nativo: no acepta content scripts) */
  function esPdf(url) {
    return /\.pdf($|[?#])/i.test(url || '');
  }

  /** Abre la página lectora de PDFs pasándole la URL del documento. */
  function abrirLectorPdf(url) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('reader.html') + (url ? '?src=' + encodeURIComponent(url) : '')
    });
    window.close();
  }

  /** Obtiene la pestaña activa y la pasa al callback. */
  function conTabActiva(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      callback(tabs && tabs[0] ? tabs[0] : null);
    });
  }

  /**
   * Manda una orden al content script de la pestaña activa.
   * Si no hay content script (página restringida o PDF), avisa con cariño.
   * `silencioso` evita el aviso (para la consulta de estado al abrir).
   */
  function mandar(accion, silencioso) {
    conTabActiva((tab) => {
      if (!tab || tab.id === undefined) return;
      chrome.tabs.sendMessage(tab.id, { accion }, (respuesta) => {
        if (chrome.runtime.lastError) {
          if (silencioso) return;
          if (esPdf(tab.url)) {
            abrirLectorPdf(tab.url); // era un PDF: al lector directamente
            return;
          }
          mostrarAviso(
            'En esta página el navegador no permite leer (páginas internas como ' +
            'chrome:// o about:, o la tienda de extensiones). Prueba en una página web normal.',
            true
          );
          return;
        }
        if (respuesta && respuesta.ok === false && respuesta.error === 'sin-texto') {
          mostrarAviso('No se encontró texto legible en esta página.', true);
          return;
        }
        if (respuesta && respuesta.estado) pintarEstado(respuesta.estado);
      });
    });
  }

  /** Refleja el estado de la lectura en el popup. */
  function pintarEstado(estado) {
    // Sin texto cargado no hay nada que pintar (y no pisamos otros avisos).
    if (!estado || !estado.total) return;
    if (estado.leyendo) {
      mostrarAviso(
        (estado.enPausa ? '⏸ En pausa — oración ' : '▶ Leyendo — oración ') +
        (estado.indice + 1) + ' de ' + estado.total
      );
    } else {
      mostrarAviso('⏹ Lectura detenida (' + estado.total + ' oraciones cargadas).');
    }
  }

  // ---- Voces (neuronales arriba, luego las de español del sistema) --------

  function poblarVoces() {
    const voces = speechSynthesis.getVoices() || [];

    selVoz.innerHTML = '';

    // Opción automática: la primera voz en español disponible.
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '✨ Automática (primera voz en español)';
    selVoz.appendChild(auto);

    // Voces neuronales Piper: mejor calidad, 100% locales tras una descarga
    // inicial. Funcionan incluso en navegadores sin voces propias (Opera GX).
    const grupoNeural = document.createElement('optgroup');
    grupoNeural.label = '🌟 Neuronales — mejor calidad (descarga única)';
    for (const voz of LectorTTS.VOCES_NEURALES) {
      const op = document.createElement('option');
      op.value = voz.id;
      op.textContent = voz.etiqueta;
      grupoNeural.appendChild(op);
    }
    selVoz.appendChild(grupoNeural);

    const esEspanola = (v) => v.lang && v.lang.toLowerCase().startsWith('es');
    const porIdiomaYNombre = (a, b) =>
      a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    const espanolas = voces.filter(esEspanola).sort(porIdiomaYNombre);
    const otras = voces.filter((v) => !esEspanola(v)).sort(porIdiomaYNombre);

    const anadirGrupo = (etiqueta, lista) => {
      if (!lista.length) return;
      const grupo = document.createElement('optgroup');
      grupo.label = etiqueta;
      for (const voz of lista) {
        const op = document.createElement('option');
        op.value = voz.name;
        op.textContent = voz.name + ' (' + voz.lang + ')' + (voz.localService ? '' : ' · online');
        grupo.appendChild(op);
      }
      selVoz.appendChild(grupo);
    };
    anadirGrupo('Sistema · Español', espanolas);
    anadirGrupo('Sistema · Otros idiomas', otras);

    // Restaurar la voz guardada si sigue disponible.
    selVoz.value = ajustes.vozNombre || '';
    if (selVoz.value !== (ajustes.vozNombre || '')) selVoz.value = '';

    avisarSegunVoz();
  }

  /** Pistas según la voz elegida y las voces disponibles. */
  function avisarSegunVoz() {
    if (LectorTTS.esVozNeural(selVoz.value)) {
      mostrarAviso('Voz neuronal: la primera vez se descarga el modelo (25–120 MB según la voz). Después funciona sin conexión.');
    } else if (!(speechSynthesis.getVoices() || []).length) {
      // Opera GX y otros Chromium sin voces del sistema.
      mostrarAviso('Tu navegador no trae voces del sistema (pasa en Opera GX): elige una voz 🌟 neuronal y listo.', true);
    }
  }

  // ---- "Qué se lee": una casilla por parte del documento --------------------

  const casillasLectura = new Map();   // clave del ajuste → <input type=checkbox>

  /** Pinta la lista de interruptores a partir de LectorTTS.OPCIONES_LECTURA. */
  function pintarOpcionesLectura() {
    listaLectura.innerHTML = '';
    for (const op of LectorTTS.OPCIONES_LECTURA) {
      const fila = document.createElement('label');
      fila.className = 'opcion-lectura';
      fila.title = op.ayuda;

      const casilla = document.createElement('input');
      casilla.type = 'checkbox';
      casilla.checked = !!ajustes[op.clave];
      casilla.addEventListener('change', () => {
        ajustes[op.clave] = casilla.checked;
        chrome.storage.sync.set({ [op.clave]: casilla.checked });
      });

      const nombre = document.createElement('span');
      nombre.className = 'nombre';
      nombre.textContent = op.etiqueta;

      const ayuda = document.createElement('span');
      ayuda.className = 'ayuda';
      ayuda.textContent = op.ayuda;

      fila.append(casilla, nombre, ayuda);
      listaLectura.appendChild(fila);
      casillasLectura.set(op.clave, casilla);
    }
  }

  // Si el ajuste cambia en otro sitio (el lector de PDF, otra ventana), que las
  // casillas de aquí no se queden mintiendo.
  chrome.storage.onChanged.addListener((cambios, area) => {
    if (area !== 'sync') return;
    for (const [clave, casilla] of casillasLectura) {
      if (clave in cambios) {
        ajustes[clave] = !!cambios[clave].newValue;
        casilla.checked = ajustes[clave];
      }
    }
  });

  // En Chromium getVoices() devuelve [] al abrir: repoblar cuando avisen.
  speechSynthesis.addEventListener('voiceschanged', poblarVoces);

  // ---- Guardado de preferencias ------------------------------------------

  let temporizadorGuardado = null;
  /** Guarda con un pequeño retraso para no saturar mientras se arrastra el slider. */
  function guardarConRetraso(parcial) {
    Object.assign(ajustes, parcial);
    clearTimeout(temporizadorGuardado);
    temporizadorGuardado = setTimeout(() => chrome.storage.sync.set(parcial), 250);
  }

  selVoz.addEventListener('change', () => {
    ajustes.vozNombre = selVoz.value;
    chrome.storage.sync.set({ vozNombre: selVoz.value });
    mostrarAviso('');
    avisarSegunVoz();
  });

  /** Pinta la parte "llena" del slider (efecto de barra de progreso). */
  function pintarRelleno(rango) {
    const min = Number(rango.min);
    const max = Number(rango.max);
    const v = Number(rango.value);
    rango.style.backgroundSize = ((v - min) * 100 / (max - min)) + '% 100%';
  }

  /** Fija la velocidad (desde el slider o los botones −/+) y la guarda. */
  function fijarVelocidad(v) {
    v = Math.round(Math.min(5, Math.max(0.5, v)) * 10) / 10;
    rangoVel.value = String(v);
    txtVel.textContent = v.toFixed(1) + '×';
    pintarRelleno(rangoVel);
    guardarConRetraso({ velocidad: v });
  }

  rangoVel.addEventListener('input', () => fijarVelocidad(parseFloat(rangoVel.value)));
  // Contadores de −/+ 0.1
  document.getElementById('btn-vel-menos').addEventListener('click', () => fijarVelocidad(parseFloat(rangoVel.value) - 0.1));
  document.getElementById('btn-vel-mas').addEventListener('click', () => fijarVelocidad(parseFloat(rangoVel.value) + 0.1));

  // ---- Botones ------------------------------------------------------------

  btnLeerPagina.addEventListener('click', () => mandar('leer-pagina'));
  btnLeerSeleccion.addEventListener('click', () => mandar('leer-seleccion'));
  btnPausa.addEventListener('click', () => mandar('pausa-reanudar'));
  btnDetener.addEventListener('click', () => mandar('detener'));
  btnAnterior.addEventListener('click', () => mandar('anterior'));
  btnSiguiente.addEventListener('click', () => mandar('siguiente'));

  // ---- "Leer al hacer clic" (interruptor) --------------------------------
  let clicParaLeer = false;
  function reflejarClic() {
    btnClic.classList.toggle('activo', clicParaLeer);
    btnClic.textContent = clicParaLeer ? '👆 Leer al hacer clic: ACTIVADO' : '👆 Leer al hacer clic';
    btnClic.title = clicParaLeer
      ? 'Activado: en la página, toca cualquier texto para leerlo desde ahí. Pulsa aquí para desactivar.'
      : 'Actívalo y luego toca un texto en la página para escucharlo (o usa Alt+clic sin activar nada).';
  }
  btnClic.addEventListener('click', () => {
    clicParaLeer = !clicParaLeer;
    chrome.storage.sync.set({ clicParaLeer });
    reflejarClic();
  });
  chrome.storage.sync.get({ clicParaLeer: false }, (r) => {
    clicParaLeer = !!r.clicParaLeer;
    reflejarClic();
  });

  // ---- Arranque -------------------------------------------------------------

  // 1. Cargar preferencias guardadas y reflejarlas en los controles.
  chrome.storage.sync.get(AJUSTES_DEFECTO, (guardados) => {
    ajustes = Object.assign({}, AJUSTES_DEFECTO, guardados || {});
    rangoVel.value = String(ajustes.velocidad);
    txtVel.textContent = Number(ajustes.velocidad).toFixed(1) + '×';
    pintarRelleno(rangoVel);
    pintarOpcionesLectura();
    poblarVoces();
  });

  // 2. Si la pestaña activa es un PDF, ofrecer el lector especial.
  conTabActiva((tab) => {
    if (tab && esPdf(tab.url)) {
      btnPdf.style.display = 'block';
      btnPdf.addEventListener('click', () => abrirLectorPdf(tab.url));
      mostrarAviso('Esta pestaña es un PDF: usa el botón rojo para leerlo.');
    }
  });

  // 3. En Firefox el permiso de acceso a los sitios se concede aparte:
  //    si falta, mostramos un botón para pedirlo con un clic.
  try {
    chrome.permissions.contains({ origins: ['<all_urls>'] }, (concedido) => {
      if (concedido) return;
      btnPermisos.style.display = 'block';
      btnPermisos.addEventListener('click', () => {
        chrome.permissions.request({ origins: ['<all_urls>'] }, (ok) => {
          if (ok) {
            btnPermisos.style.display = 'none';
            mostrarAviso('¡Permiso concedido! Recarga la página que quieras leer.');
          }
        });
      });
    });
  } catch (e) { /* permissions no disponible: seguimos sin el botón */ }

  // 4. Preguntar el estado actual de la lectura y refrescarlo mientras
  //    el popup siga abierto.
  mandar('estado', true);
  setInterval(() => mandar('estado', true), 1000);
})();
