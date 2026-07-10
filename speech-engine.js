/**
 * speech-engine.js — Motor de lectura compartido de "Lector TTS".
 *
 * Se carga como content script en todas las páginas web y en las páginas de
 * la extensión (reader.html). Expone el objeto global `LectorTTS`.
 *
 * Desde la v1.1 el motor tiene DOS formas de generar voz:
 *   1. Voces del sistema (Web Speech API / speechSynthesis) — sin descargas.
 *   2. Voces neuronales Piper (vozNombre = "piper:<id>") — mejor calidad,
 *      100% locales tras una descarga inicial. La síntesis la hace quien usa
 *      el motor a través del "enchufe" motor.sintetizarNeural (content.js la
 *      delega a un iframe de la extensión; reader.js la hace directamente).
 *
 * El motor habla UNA oración por utterance/audio y encadena la siguiente al
 * terminar: así se esquiva el corte de utterances largas de Chrome y se puede
 * resaltar y saltar por oración. NUNCA se usa desde el background.
 */
(function (global) {
  'use strict';

  const sintesis = global.speechSynthesis || null;

  // ------------------------------------------------------------------
  // Ajustes por defecto (español primero: velocidad 1.1 y voz automática)
  // ------------------------------------------------------------------
  const AJUSTES_DEFECTO = { vozNombre: '', velocidad: 1.1, tono: 1.0 };

  // Límites del troceo (ver trocearRangos).
  const MIN_ORACION = 60;
  const MAX_ORACION = 250;

  // Velocidad de habla estimada, para mover el resaltado de palabra cuando la
  // voz no emite eventos de posición (~16 caracteres por segundo en español).
  const CARACTERES_POR_SEGUNDO = 16;

  // Voces neuronales Piper disponibles (se descargan de Hugging Face la
  // primera vez y quedan guardadas en el navegador; después van sin conexión).
  // Ordenadas por región: español latino primero (México, según lo pedido),
  // luego español de España y por último inglés.
  // NOTA: la voz argentina "es_AR-daniela-high" no está en el mirror por
  // defecto de vits-web; se registra aparte en tts-frame.js y reader.js
  // apuntando al repositorio oficial de Piper (rhasspy). Ver libs/LEEME.md.
  const VOCES_NEURALES = [
    // --- Español de Latinoamérica ---
    { id: 'piper:es_MX-claude-high',        etiqueta: 'Claude · Español latino (México) · alta' },
    { id: 'piper:es_MX-ald-medium',         etiqueta: 'Ald · Español latino (México) · media' },
    { id: 'piper:es_AR-daniela-high',       etiqueta: 'Daniela · Español latino (Argentina) · alta' },
    // --- Español de España ---
    { id: 'piper:es_ES-davefx-medium',      etiqueta: 'Davefx · Español (España) · media' },
    { id: 'piper:es_ES-sharvard-medium',    etiqueta: 'Sharvard · Español (España) · media' },
    { id: 'piper:es_ES-mls_10246-low',      etiqueta: 'MLS 10246 · Español (España) · ligera' },
    { id: 'piper:es_ES-mls_9972-low',       etiqueta: 'MLS 9972 · Español (España) · ligera' },
    { id: 'piper:es_ES-carlfm-x_low',       etiqueta: 'Carlfm · Español (España) · muy ligera' },
    // --- Inglés (EE. UU. y Reino Unido) ---
    { id: 'piper:en_US-amy-medium',         etiqueta: 'Amy · Inglés (EE. UU.) · media' },
    { id: 'piper:en_US-hfc_female-medium',  etiqueta: 'HFC Female · Inglés (EE. UU.) · media' },
    { id: 'piper:en_US-hfc_male-medium',    etiqueta: 'HFC Male · Inglés (EE. UU.) · media' },
    { id: 'piper:en_US-ryan-high',          etiqueta: 'Ryan · Inglés (EE. UU.) · alta' },
    { id: 'piper:en_US-lessac-medium',      etiqueta: 'Lessac · Inglés (EE. UU.) · media' },
    { id: 'piper:en_GB-alan-medium',        etiqueta: 'Alan · Inglés (Reino Unido) · media' },
    { id: 'piper:en_GB-jenny_dioco-medium', etiqueta: 'Jenny · Inglés (Reino Unido) · media' }
  ];

  /** ¿Es un nombre de voz neuronal ("piper:...")? */
  function esVozNeural(nombre) {
    return typeof nombre === 'string' && nombre.startsWith('piper:');
  }

  /**
   * ¿Esta voz permite ajustar el TONO?
   * Solo las voces del sistema: las neuronales Piper ignoran el tono (únicamente
   * cambian de velocidad), por eso la interfaz desactiva el control de tono
   * cuando hay una voz neuronal elegida.
   */
  function soportaTono(nombre) {
    return !esVozNeural(nombre);
  }

  /** Saca el id Piper de un nombre "piper:es_ES-davefx-medium". */
  function idPiper(nombre) {
    return String(nombre).slice('piper:'.length);
  }

  // ------------------------------------------------------------------
  // Troceo del texto en oraciones (por rangos de posiciones)
  // ------------------------------------------------------------------

  /**
   * Divide `texto` en oraciones y devuelve RANGOS [{ini, fin}] con posiciones
   * dentro del propio texto (así el resaltado sabe exactamente dónde está
   * cada oración en la página). `cortes` es una lista opcional de posiciones
   * que no se pueden cruzar (límites de párrafo/título en la página).
   *
   * Reglas: se corta tras . ! ? … ; los trozos de menos de 60 caracteres se
   * unen al siguiente (abreviaturas tipo "Sr.") y los de más de 250 se parten
   * por comas o espacios, para esquivar el bug de Chrome que enmudece las
   * utterances largas.
   */
  function trocearRangos(texto, cortes) {
    const total = String(texto || '').length;
    if (!total) return [];
    const posiciones = [0];
    for (const c of (cortes || [])) {
      if (c > 0 && c < total) posiciones.push(c);
    }
    posiciones.push(total);
    const unicas = Array.from(new Set(posiciones)).sort((a, b) => a - b);

    const rangos = [];
    for (let b = 0; b < unicas.length - 1; b++) {
      trocearBloque(texto, unicas[b], unicas[b + 1], rangos);
    }
    return rangos;
  }

  /** Trocea un bloque [ini, fin) del texto y añade los rangos a `destino`. */
  function trocearBloque(texto, ini, fin, destino) {
    const trozo = texto.slice(ini, fin);
    if (!trozo.trim()) return;

    // Trozos "brutos": todo lo que acaba en puntuación final (más posibles
    // comillas o paréntesis de cierre) o el resto final sin puntuación.
    const re = /[^.!?…]+[.!?…]+["'»”’)\]]*\s*|[^.!?…]+$/g;
    const brutos = [];
    let m;
    while ((m = re.exec(trozo)) !== null) {
      brutos.push({ ini: ini + m.index, fin: ini + m.index + m[0].length });
    }
    if (!brutos.length) brutos.push({ ini, fin });

    // Unir fragmentos demasiado cortos (p. ej. "El Sr." + "Pérez llegó.").
    const unidos = [];
    let actual = null;
    for (const r of brutos) {
      if (!actual) actual = { ini: r.ini, fin: r.fin };
      else actual.fin = r.fin;
      if (texto.slice(actual.ini, actual.fin).trim().length >= MIN_ORACION) {
        unidos.push(actual);
        actual = null;
      }
    }
    if (actual && texto.slice(actual.ini, actual.fin).trim()) {
      // Un final corto se pega a la última oración para no dejar "migas".
      if (unidos.length && texto.slice(actual.ini, actual.fin).trim().length < MIN_ORACION) {
        unidos[unidos.length - 1].fin = actual.fin;
      } else {
        unidos.push(actual);
      }
    }

    // Partir las oraciones demasiado largas.
    for (const r of unidos) partirRango(texto, r.ini, r.fin, destino);
  }

  /** Parte recursivamente un rango largo por la coma/espacio más cómodo. */
  function partirRango(texto, ini, fin, destino) {
    if (fin <= ini) return;
    if (fin - ini <= MAX_ORACION) {
      if (texto.slice(ini, fin).trim()) destino.push({ ini, fin });
      return;
    }
    const zona = texto.slice(ini, ini + MAX_ORACION);
    // Preferimos cortar en una pausa natural (coma, punto y coma, dos puntos).
    let corte = Math.max(
      zona.lastIndexOf(', '),
      zona.lastIndexOf('; '),
      zona.lastIndexOf(': ')
    );
    // Si no hay pausa razonable, cortamos en el último espacio o salto.
    if (corte < 40) corte = Math.max(zona.lastIndexOf(' '), zona.lastIndexOf('\n'));
    // Texto sin espacios (URLs, etc.): corte duro.
    if (corte < 40) corte = MAX_ORACION - 1;

    destino.push({ ini, fin: ini + corte + 1 });
    partirRango(texto, ini + corte + 1, fin, destino);
  }

  /**
   * Versión clásica: devuelve las oraciones como TEXTOS ya normalizados.
   * La usa el lector de PDF (que pinta su propio texto) y las pruebas.
   */
  function trocearEnOraciones(texto) {
    const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
    if (!limpio) return [];
    return trocearRangos(limpio, [])
      .map((r) => limpio.slice(r.ini, r.fin).trim())
      .filter(Boolean);
  }

  // ------------------------------------------------------------------
  // Voces del sistema
  // ------------------------------------------------------------------

  let vocesCache = [];

  /** Vuelve a pedir la lista de voces del sistema al navegador. */
  function refrescarVoces() {
    if (sintesis) vocesCache = sintesis.getVoices() || [];
    return vocesCache;
  }

  // En Chromium getVoices() devuelve [] al principio: hay que volver a
  // pedirlas cuando el navegador avisa con "voiceschanged".
  if (sintesis && typeof sintesis.addEventListener === 'function') {
    sintesis.addEventListener('voiceschanged', refrescarVoces);
  }
  refrescarVoces();

  /** Lista de voces del sistema (refresca si aún está vacía). */
  function obtenerVoces() {
    if (!vocesCache.length) refrescarVoces();
    return vocesCache;
  }

  /**
   * Elige la voz del sistema a usar:
   *   1. La voz guardada por el usuario (si sigue instalada y no es neuronal).
   *   2. La primera voz en español (lang que empiece por "es").
   *   3. null → se usará la voz por defecto, pero con lang "es-ES" pedido,
   *      para no leer nunca español con una voz en inglés.
   */
  function elegirVoz(nombreGuardado) {
    const voces = obtenerVoces();
    if (nombreGuardado && !esVozNeural(nombreGuardado)) {
      const guardada = voces.find((v) => v.name === nombreGuardado);
      if (guardada) return guardada;
    }
    const espanola = voces.find((v) => v.lang && v.lang.toLowerCase().startsWith('es'));
    return espanola || null;
  }

  // ------------------------------------------------------------------
  // Ajustes persistentes (chrome.storage.sync)
  // ------------------------------------------------------------------

  /** Lee los ajustes guardados y llama al callback con ellos (con defectos). */
  function cargarAjustes(callback) {
    try {
      global.chrome.storage.sync.get(AJUSTES_DEFECTO, (res) => {
        callback(Object.assign({}, AJUSTES_DEFECTO, res || {}));
      });
    } catch (e) {
      callback(Object.assign({}, AJUSTES_DEFECTO));
    }
  }

  /** Guarda un cambio parcial de ajustes ({velocidad: 1.5}, etc.). */
  function guardarAjustes(parcial) {
    try {
      global.chrome.storage.sync.set(parcial);
    } catch (e) { /* fuera de una extensión: ignorar */ }
  }

  // ------------------------------------------------------------------
  // Motor de lectura
  // ------------------------------------------------------------------

  /**
   * Crea un motor de lectura. Callbacks que puede definir quien lo use:
   *   motor.alEmpezarOracion(i)       → resaltar la oración i.
   *   motor.alPalabra(i, charIndex)   → resaltar la palabra en esa posición.
   *   motor.alTerminar()              → se acabó el texto.
   *   motor.alCambiarEstado(estado)   → refrescar botones.
   *   motor.alProgresoDescarga(pct)   → % de descarga de una voz neuronal.
   *   motor.alBloqueoAudio()          → el navegador exige un clic para sonar.
   *   motor.alAviso(texto)            → avisos (p. ej. fallo de voz neuronal).
   *   motor.sintetizarNeural(texto, idVoz, alProgreso) → Promise<Blob WAV>.
   */
  function crearMotorLectura() {
    const motor = {
      oraciones: [],
      indice: 0,
      leyendo: false,
      enPausa: false,
      ajustes: Object.assign({}, AJUSTES_DEFECTO),
      alEmpezarOracion: null,
      alPalabra: null,
      alTerminar: null,
      alCambiarEstado: null,
      alProgresoDescarga: null,
      alBloqueoAudio: null,
      alAviso: null,
      sintetizarNeural: null,
      // "turno" invalida los callbacks de utterances/audios viejos.
      _turno: 0,
      // Referencia viva a la utterance: si no, el recolector de basura de
      // Chrome puede matarla a mitad de frase y la lectura se corta.
      _utter: null,
      _audio: null,          // <audio> en curso (voz neuronal)
      _urlAudio: null,       // blob URL a liberar
      _timerPalabra: null,   // temporizador del resaltado de palabra
      _cacheAudio: new Map(),// audios ya sintetizados ("voz|indice" → Promise<Blob>)
      _neuralRota: false     // la voz neuronal falló: usar el sistema
    };

    function notificar() {
      if (motor.alCambiarEstado) motor.alCambiarEstado(motor.estado());
    }

    motor.estado = function () {
      return {
        leyendo: motor.leyendo,
        enPausa: motor.enPausa,
        indice: motor.indice,
        total: motor.oraciones.length
      };
    };

    /** ¿Toca usar la voz neuronal? */
    function usaNeural() {
      return esVozNeural(motor.ajustes.vozNombre) &&
        typeof motor.sintetizarNeural === 'function' &&
        !motor._neuralRota;
    }

    /** Detiene y libera el audio neuronal y el temporizador de palabra. */
    function limpiarAudio() {
      if (motor._timerPalabra) {
        clearInterval(motor._timerPalabra);
        motor._timerPalabra = null;
      }
      if (motor._audio) {
        try { motor._audio.pause(); } catch (e) { /* nada */ }
        motor._audio.onended = null;
        motor._audio.onerror = null;
        motor._audio = null;
      }
      if (motor._urlAudio) {
        try { URL.revokeObjectURL(motor._urlAudio); } catch (e) { /* nada */ }
        motor._urlAudio = null;
      }
    }

    /** Fin natural de la lectura. */
    function terminar() {
      motor._turno++;
      motor.leyendo = false;
      motor.enPausa = false;
      limpiarAudio();
      if (sintesis) { try { sintesis.cancel(); } catch (e) { /* nada */ } }
      if (motor.alTerminar) motor.alTerminar();
      notificar();
    }

    /** Habla la oración i con los ajustes ACTUALES. */
    function hablar(i) {
      if (i < 0 || i >= motor.oraciones.length) { terminar(); return; }
      motor.indice = i;
      const turno = ++motor._turno;

      limpiarAudio();
      if (sintesis) {
        // cancel() SIEMPRE antes de hablar: una cola atascada deja speak() mudo.
        sintesis.cancel();
        // Si el motor quedó "pausado" tras un cancel (bug de Chromium), despegarlo.
        if (sintesis.paused) { try { sintesis.resume(); } catch (e) { /* nada */ } }
      }

      if (motor.alEmpezarOracion) motor.alEmpezarOracion(i);
      if (usaNeural()) hablarNeural(i, turno);
      else hablarSistema(i, turno);
      notificar();
    }

    function avanzar() {
      if (!motor.leyendo) return;
      if (motor.indice + 1 < motor.oraciones.length) hablar(motor.indice + 1);
      else terminar();
    }

    // ---------- Camino 1: voces del sistema (Web Speech API) ----------

    function hablarSistema(i, turno) {
      if (!sintesis) { terminar(); return; }
      const texto = motor.oraciones[i];
      const u = new SpeechSynthesisUtterance(texto);
      const voz = elegirVoz(motor.ajustes.vozNombre);
      if (voz) {
        u.voice = voz;
        u.lang = voz.lang;
      } else {
        // Sin voces cargadas todavía: pedimos español explícitamente para que
        // el navegador no lea el texto con la voz por defecto en inglés.
        u.lang = 'es-ES';
      }
      const velocidad = Number(motor.ajustes.velocidad) || AJUSTES_DEFECTO.velocidad;
      u.rate = Math.min(10, Math.max(0.1, velocidad));
      u.pitch = Math.min(2, Math.max(0, Number(motor.ajustes.tono) || AJUSTES_DEFECTO.tono));

      // Resaltado palabra a palabra. Si la voz emite eventos "boundary" los
      // usamos (exactos); si no, a los 600 ms arranca una ESTIMACIÓN por
      // tiempo (~16 caracteres/segundo ajustados a la velocidad elegida).
      let huboEventos = false;
      u.onboundary = function (e) {
        if (turno !== motor._turno) return;
        huboEventos = true;
        if (motor._timerPalabra) { clearInterval(motor._timerPalabra); motor._timerPalabra = null; }
        if (motor.alPalabra && (!e.name || e.name === 'word')) {
          motor.alPalabra(i, e.charIndex || 0);
        }
      };
      setTimeout(function () {
        if (turno !== motor._turno || huboEventos || !motor.leyendo) return;
        let avanceEstimado = 0;
        motor._timerPalabra = setInterval(function () {
          if (turno !== motor._turno) { clearInterval(motor._timerPalabra); return; }
          if (motor.enPausa) return; // en pausa no se avanza
          avanceEstimado += 0.09 * CARACTERES_POR_SEGUNDO * u.rate;
          if (motor.alPalabra && avanceEstimado < texto.length) {
            motor.alPalabra(i, Math.floor(avanceEstimado));
          }
        }, 90);
      }, 600);

      // Al acabar la oración, encadenamos la siguiente.
      u.onend = function () {
        if (turno !== motor._turno) return;
        avanzar();
      };
      // Ante un error, avanzamos: la lectura nunca se congela. Las
      // cancelaciones provocadas por nosotros mismos se ignoran.
      u.onerror = function (e) {
        if (turno !== motor._turno) return;
        const err = e && e.error;
        if (err === 'canceled' || err === 'interrupted') return;
        avanzar();
      };

      motor._utter = u;
      // Pequeño respiro tras cancel(): Chromium a veces ignora un speak()
      // lanzado en el mismo instante que la cancelación.
      setTimeout(function () {
        if (turno === motor._turno) sintesis.speak(u);
      }, 40);
    }

    // ---------- Camino 2: voces neuronales Piper ----------

    /** Pide (o recupera de la caché) el audio WAV de la oración i. */
    function obtenerAudio(i, voz) {
      const clave = voz + '|' + i;
      if (!motor._cacheAudio.has(clave)) {
        const promesa = motor.sintetizarNeural(motor.oraciones[i], voz, function (p) {
          // p = {cargado, total} → % de descarga del modelo (solo la 1ª vez)
          if (motor.alProgresoDescarga && p && p.total) {
            motor.alProgresoDescarga(Math.min(100, Math.round(p.cargado * 100 / p.total)));
          }
        }).catch(function (e) {
          motor._cacheAudio.delete(clave); // no cachear fallos
          throw e;
        });
        motor._cacheAudio.set(clave, promesa);
      }
      return motor._cacheAudio.get(clave);
    }

    async function hablarNeural(i, turno) {
      const voz = idPiper(motor.ajustes.vozNombre);
      try {
        const wav = await obtenerAudio(i, voz);
        if (turno !== motor._turno) return;
        if (motor.alProgresoDescarga) motor.alProgresoDescarga(null); // descarga acabada

        const url = URL.createObjectURL(wav);
        const audio = new Audio(url);
        motor._audio = audio;
        motor._urlAudio = url;
        // playbackRate cambia la velocidad SIN agudizar la voz: permite
        // hasta 5x reales con cualquier voz neuronal.
        try { audio.preservesPitch = true; } catch (e) { /* nada */ }
        audio.playbackRate = Math.min(16, Math.max(0.25, Number(motor.ajustes.velocidad) || 1));

        audio.onended = function () { if (turno === motor._turno) avanzar(); };
        audio.onerror = function () { if (turno === motor._turno) avanzar(); };

        // Resaltado de palabra por tiempo de reproducción (proporcional).
        const texto = motor.oraciones[i];
        motor._timerPalabra = setInterval(function () {
          if (turno !== motor._turno) { clearInterval(motor._timerPalabra); return; }
          if (!audio.duration || audio.paused) return;
          const fraccion = audio.currentTime / audio.duration;
          if (motor.alPalabra) {
            motor.alPalabra(i, Math.min(texto.length - 1, Math.floor(fraccion * texto.length)));
          }
        }, 80);

        // Si el usuario pulsó pausa mientras se sintetizaba esta oración,
        // NO arrancamos el sonido: queda listo para el reanudar.
        if (motor.enPausa) {
          notificar();
        } else {
          try {
            await audio.play();
          } catch (e) {
            // El navegador bloquea el sonido hasta que el usuario haga clic
            // (política de autoplay). Quedamos "en pausa" a la espera del clic.
            if (turno !== motor._turno) return;
            motor.enPausa = true;
            notificar();
            if (motor.alBloqueoAudio) motor.alBloqueoAudio();
          }
        }

        // Mientras suena esta oración, dejamos la siguiente sintetizándose
        // en segundo plano para que no haya huecos entre frases.
        if (i + 1 < motor.oraciones.length) {
          obtenerAudio(i + 1, voz).catch(function () { /* se verá al llegar */ });
        }
        // Y liberamos audios viejos de la caché.
        for (const clave of Array.from(motor._cacheAudio.keys())) {
          const n = Number(clave.split('|')[1]);
          if (n < i - 1) motor._cacheAudio.delete(clave);
        }
      } catch (e) {
        if (turno !== motor._turno) return;
        // La voz neuronal falló (sin internet la primera vez, etc.):
        // avisamos y seguimos leyendo con una voz del sistema.
        motor._neuralRota = true;
        if (motor.alAviso) {
          motor.alAviso('No se pudo usar la voz neuronal (' + ((e && e.message) || e) + '). Sigo con una voz del sistema.');
        }
        hablarSistema(i, turno);
      }
    }

    // ---------- Controles públicos ----------

    /** Empieza a leer una lista de oraciones desde el índice dado. */
    motor.iniciar = function (oraciones, desde) {
      motor._cacheAudio.clear();
      motor.oraciones = oraciones || [];
      motor.enPausa = false;
      motor.leyendo = motor.oraciones.length > 0;
      if (motor.leyendo) hablar(desde || 0);
      else terminar();
    };

    /** Detiene la lectura del todo. */
    motor.detener = function () {
      motor._turno++;
      motor.leyendo = false;
      motor.enPausa = false;
      limpiarAudio();
      if (sintesis) { try { sintesis.cancel(); } catch (e) { /* nada */ } }
      notificar();
    };

    /**
     * Pausa la lectura AL INSTANTE.
     *  - Audio neuronal sonando → audio.pause() (se reanuda donde estaba).
     *  - Voz del sistema o síntesis en curso → cancelamos directamente:
     *    speechSynthesis.pause() puede tardar segundos o no responder con
     *    voces online, así que preferimos silencio inmediato y, al reanudar,
     *    relanzar la oración actual desde su principio.
     */
    motor.pausar = function () {
      if (!motor.leyendo || motor.enPausa) return;
      motor.enPausa = true;
      if (motor._audio) {
        try { motor._audio.pause(); } catch (e) { /* nada */ }
      } else {
        // El turno nuevo invalida la utterance en curso y cualquier síntesis
        // neuronal pendiente (su audio quedará cacheado para el reanudar).
        motor._turno++;
        if (sintesis) { try { sintesis.cancel(); } catch (e) { /* nada */ } }
        if (motor._timerPalabra) {
          clearInterval(motor._timerPalabra);
          motor._timerPalabra = null;
        }
      }
      notificar();
    };

    /** Reanuda la lectura. */
    motor.reanudar = function () {
      if (!motor.leyendo || !motor.enPausa) return;
      motor.enPausa = false;
      if (motor._audio) {
        // Audio neuronal pausado: sigue exactamente donde estaba.
        motor._audio.play().catch(function () {
          motor.enPausa = true;
          notificar();
          if (motor.alBloqueoAudio) motor.alBloqueoAudio();
        });
        notificar();
        return;
      }
      // Voz del sistema (o pausa durante una síntesis): relanzar la oración
      // actual. Si su audio neuronal ya estaba sintetizado, sale de la caché.
      hablar(motor.indice);
    };

    /** Salta a la oración siguiente. */
    motor.siguiente = function () {
      if (!motor.leyendo) return;
      motor.enPausa = false;
      if (motor.indice + 1 < motor.oraciones.length) hablar(motor.indice + 1);
      else terminar();
    };

    /** Vuelve a la oración anterior. */
    motor.anterior = function () {
      if (!motor.leyendo) return;
      motor.enPausa = false;
      hablar(Math.max(motor.indice - 1, 0));
    };

    /** Salta a una oración concreta (clic en el texto). */
    motor.saltarA = function (i) {
      if (!motor.leyendo || i < 0 || i >= motor.oraciones.length) return;
      motor.enPausa = false;
      hablar(i);
    };

    /**
     * Cambia la velocidad al vuelo. Con audio neuronal es instantáneo
     * (playbackRate); con la voz del sistema se relanza la oración actual.
     */
    motor.fijarVelocidad = function (v) {
      motor.ajustes.velocidad = v;
      if (motor._audio) {
        motor._audio.playbackRate = Math.min(16, Math.max(0.25, Number(v) || 1));
      } else if (motor.leyendo && !motor.enPausa) {
        hablar(motor.indice);
      }
    };

    /** Cambia el tono (solo afecta a las voces del sistema). */
    motor.fijarTono = function (t) {
      motor.ajustes.tono = t;
      if (!motor._audio && motor.leyendo && !motor.enPausa) hablar(motor.indice);
    };

    /** Cambia la voz al vuelo. */
    motor.fijarVoz = function (nombre) {
      motor.ajustes.vozNombre = nombre;
      motor._neuralRota = false;   // nueva oportunidad para la voz neuronal
      motor._cacheAudio.clear();   // los audios cacheados eran de otra voz
      if (motor.leyendo && !motor.enPausa) hablar(motor.indice);
    };

    return motor;
  }

  // ------------------------------------------------------------------
  // Exportar el objeto global
  // ------------------------------------------------------------------
  global.LectorTTS = {
    AJUSTES_DEFECTO: AJUSTES_DEFECTO,
    VOCES_NEURALES: VOCES_NEURALES,
    esVozNeural: esVozNeural,
    soportaTono: soportaTono,
    idPiper: idPiper,
    trocearRangos: trocearRangos,
    trocearEnOraciones: trocearEnOraciones,
    refrescarVoces: refrescarVoces,
    obtenerVoces: obtenerVoces,
    elegirVoz: elegirVoz,
    cargarAjustes: cargarAjustes,
    guardarAjustes: guardarAjustes,
    crearMotorLectura: crearMotorLectura
  };
})(typeof window !== 'undefined' ? window : globalThis);
