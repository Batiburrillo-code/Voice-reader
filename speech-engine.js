/**
 * speech-engine.js — Motor de lectura compartido de "Lector TTS".
 *
 * Este archivo se carga en dos sitios:
 *   - Como content script en todas las páginas web (antes que content.js).
 *   - En las páginas de la extensión (reader.html para PDFs).
 *
 * Expone el objeto global `LectorTTS` con:
 *   - trocearEnOraciones(texto): divide un texto en oraciones "hablables".
 *   - elegirVoz(nombre): elige voz (guardada → primera en español → por defecto).
 *   - obtenerVoces() / refrescarVoces(): lista de voces disponibles.
 *   - cargarAjustes(cb) / guardarAjustes(obj): preferencias en chrome.storage.sync.
 *   - crearMotorLectura(): crea el motor que encadena oración a oración.
 *
 * Toda la síntesis usa la Web Speech API (speechSynthesis), que es local y
 * gratuita. NUNCA se llama desde el background (allí no existe).
 */
(function (global) {
  'use strict';

  // En content scripts y páginas de extensión `speechSynthesis` existe.
  // En Node (pruebas) no, por eso el "|| null".
  const sintesis = global.speechSynthesis || null;

  // ------------------------------------------------------------------
  // Ajustes por defecto (español primero: velocidad 1.1 y voz automática)
  // ------------------------------------------------------------------
  const AJUSTES_DEFECTO = { vozNombre: '', velocidad: 1.1, tono: 1.0 };

  // Límites del troceo. Oraciones muy cortas (abreviaturas como "Sr.") se unen
  // a la siguiente; las muy largas se parten para esquivar el bug de Chrome
  // que enmudece las utterances largas (~15 s con voces online).
  const MIN_ORACION = 60;
  const MAX_ORACION = 250;

  // ------------------------------------------------------------------
  // Troceo del texto en oraciones
  // ------------------------------------------------------------------

  /**
   * Divide un texto en oraciones listas para hablar una a una.
   * Reglas: se corta tras . ! ? … (con comillas/paréntesis de cierre),
   * los trozos de menos de 60 caracteres se pegan al siguiente y los de
   * más de 250 se parten por comas o espacios.
   */
  function trocearEnOraciones(texto) {
    const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
    if (!limpio) return [];

    // Trozos "brutos": todo lo que acaba en puntuación final (más posibles
    // comillas o paréntesis de cierre) o el resto final sin puntuación.
    const brutas = limpio.match(/[^.!?…]+[.!?…]+["'»”’)\]]*\s*|[^.!?…]+$/g) || [limpio];

    // Unir fragmentos demasiado cortos (p. ej. "El Sr." + "Pérez llegó.").
    const unidas = [];
    let actual = '';
    for (const trozo of brutas) {
      actual += trozo;
      if (actual.trim().length >= MIN_ORACION) {
        unidas.push(actual.trim());
        actual = '';
      }
    }
    const resto = actual.trim();
    if (resto) {
      // Un final corto se pega a la última oración para no dejar "migas".
      if (unidas.length && resto.length < MIN_ORACION) {
        unidas[unidas.length - 1] += ' ' + resto;
      } else {
        unidas.push(resto);
      }
    }

    // Partir las oraciones demasiado largas.
    const finales = [];
    for (const oracion of unidas) partirLarga(oracion, finales);
    return finales;
  }

  /** Parte recursivamente una oración larga por la coma/espacio más cómodo. */
  function partirLarga(oracion, destino) {
    if (!oracion) return;
    if (oracion.length <= MAX_ORACION) {
      destino.push(oracion);
      return;
    }
    const zona = oracion.slice(0, MAX_ORACION);
    // Preferimos cortar en una pausa natural (coma, punto y coma, dos puntos).
    let corte = Math.max(
      zona.lastIndexOf(', '),
      zona.lastIndexOf('; '),
      zona.lastIndexOf(': ')
    );
    // Si no hay pausa razonable, cortamos en el último espacio.
    if (corte < 40) corte = zona.lastIndexOf(' ');
    // Texto sin espacios (URLs, etc.): corte duro.
    if (corte < 40) corte = MAX_ORACION - 1;

    destino.push(oracion.slice(0, corte + 1).trim());
    partirLarga(oracion.slice(corte + 1).trim(), destino);
  }

  // ------------------------------------------------------------------
  // Voces
  // ------------------------------------------------------------------

  let vocesCache = [];

  /** Vuelve a pedir la lista de voces al navegador. */
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

  /** Lista de voces (refresca si aún está vacía). */
  function obtenerVoces() {
    if (!vocesCache.length) refrescarVoces();
    return vocesCache;
  }

  /**
   * Elige la voz a usar:
   *   1. La voz guardada por el usuario (si sigue instalada).
   *   2. La primera voz en español (lang que empiece por "es").
   *   3. null → se usará la voz por defecto, pero con lang "es-ES" pedido,
   *      para no leer nunca español con una voz en inglés.
   */
  function elegirVoz(nombreGuardado) {
    const voces = obtenerVoces();
    if (nombreGuardado) {
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
      // Fuera de una extensión (pruebas): devolvemos los defectos.
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
   * Crea un motor de lectura. El motor habla UNA oración por utterance y
   * encadena la siguiente en onend. Así se esquiva el corte de utterances
   * largas de Chrome y se puede resaltar y saltar por oración.
   *
   * Callbacks que puede definir quien lo use:
   *   motor.alEmpezarOracion(i)          → para resaltar la oración i.
   *   motor.alPalabra(i, charIndex)      → resaltado palabra a palabra (si la voz lo soporta).
   *   motor.alTerminar()                 → se acabó el texto.
   *   motor.alCambiarEstado(estado)      → para refrescar botones.
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
      // "turno" invalida los callbacks de utterances viejas tras un cancel().
      _turno: 0,
      // Referencia viva a la utterance: si no, el recolector de basura de
      // Chrome puede matarla a mitad de frase y la lectura se corta.
      _utter: null
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

    /** Fin natural de la lectura (o parada por quedarse sin oraciones). */
    function terminar() {
      motor._turno++;
      motor.leyendo = false;
      motor.enPausa = false;
      try { sintesis.cancel(); } catch (e) { /* sin síntesis */ }
      if (motor.alTerminar) motor.alTerminar();
      notificar();
    }

    /** Habla la oración i con los ajustes ACTUALES (voz/velocidad/tono). */
    function hablar(i) {
      if (!sintesis) return;
      if (i < 0 || i >= motor.oraciones.length) { terminar(); return; }

      motor.indice = i;
      const turno = ++motor._turno;

      // cancel() SIEMPRE antes de hablar: una cola atascada deja speak() mudo.
      sintesis.cancel();
      // Si el motor quedó "pausado" tras un cancel (bug de Chromium), despegarlo.
      if (sintesis.paused) {
        try { sintesis.resume(); } catch (e) { /* nada */ }
      }

      const u = new SpeechSynthesisUtterance(motor.oraciones[i]);
      const voz = elegirVoz(motor.ajustes.vozNombre);
      if (voz) {
        u.voice = voz;
        u.lang = voz.lang;
      } else {
        // Sin voces cargadas todavía: pedimos español explícitamente para que
        // el navegador no lea el texto con la voz por defecto en inglés.
        u.lang = 'es-ES';
      }
      u.rate = Math.min(10, Math.max(0.1, Number(motor.ajustes.velocidad) || AJUSTES_DEFECTO.velocidad));
      u.pitch = Math.min(2, Math.max(0, Number(motor.ajustes.tono) || AJUSTES_DEFECTO.tono));

      // Resaltado palabra a palabra (Chrome/Edge con voces locales lo emiten;
      // si la voz no lo soporta, simplemente no pasa nada).
      u.onboundary = function (e) {
        if (turno !== motor._turno) return;
        if (motor.alPalabra && (!e.name || e.name === 'word')) {
          motor.alPalabra(i, e.charIndex || 0);
        }
      };

      // Al acabar la oración, encadenamos la siguiente.
      u.onend = function () {
        if (turno !== motor._turno) return;
        avanzar();
      };

      // Ante un error, avanzamos a la siguiente oración: la lectura nunca se
      // congela. Las cancelaciones provocadas por nosotros mismos se ignoran.
      u.onerror = function (e) {
        if (turno !== motor._turno) return;
        const err = e && e.error;
        if (err === 'canceled' || err === 'interrupted') return;
        avanzar();
      };

      motor._utter = u;
      if (motor.alEmpezarOracion) motor.alEmpezarOracion(i);

      // Pequeño respiro tras cancel(): Chromium a veces ignora un speak()
      // lanzado en el mismo instante que la cancelación.
      setTimeout(function () {
        if (turno === motor._turno) sintesis.speak(u);
      }, 40);

      notificar();
    }

    function avanzar() {
      if (!motor.leyendo) return;
      if (motor.indice + 1 < motor.oraciones.length) {
        hablar(motor.indice + 1);
      } else {
        terminar();
      }
    }

    /** Empieza a leer una lista de oraciones desde el índice dado. */
    motor.iniciar = function (oraciones, desde) {
      motor.oraciones = oraciones || [];
      motor.enPausa = false;
      motor.leyendo = motor.oraciones.length > 0;
      if (motor.leyendo) {
        hablar(desde || 0);
      } else {
        terminar();
      }
    };

    /** Detiene la lectura del todo. */
    motor.detener = function () {
      motor._turno++;
      motor.leyendo = false;
      motor.enPausa = false;
      try { sintesis.cancel(); } catch (e) { /* nada */ }
      notificar();
    };

    /** Pausa la lectura. */
    motor.pausar = function () {
      if (!motor.leyendo || motor.enPausa) return;
      motor.enPausa = true;
      try { sintesis.pause(); } catch (e) { /* nada */ }
      notificar();
    };

    /**
     * Reanuda la lectura. pause()/resume() es poco fiable en Chromium con
     * voces online: si tras 450 ms no se oye nada, relanzamos la oración
     * actual desde el índice guardado.
     */
    motor.reanudar = function () {
      if (!motor.leyendo || !motor.enPausa) return;
      motor.enPausa = false;
      try { sintesis.resume(); } catch (e) { /* nada */ }
      const turno = motor._turno;
      setTimeout(function () {
        if (turno !== motor._turno || !motor.leyendo || motor.enPausa) return;
        if (!sintesis.speaking || sintesis.paused) {
          hablar(motor.indice); // resume() falló: relanzar la oración actual
        }
      }, 450);
      notificar();
    };

    /** Salta a la oración siguiente. */
    motor.siguiente = function () {
      if (!motor.leyendo) return;
      motor.enPausa = false;
      if (motor.indice + 1 < motor.oraciones.length) hablar(motor.indice + 1);
      else terminar();
    };

    /** Vuelve a la oración anterior (o al principio de la actual si es la primera). */
    motor.anterior = function () {
      if (!motor.leyendo) return;
      motor.enPausa = false;
      hablar(Math.max(motor.indice - 1, 0));
    };

    /** Salta a una oración concreta (clic en el panel). */
    motor.saltarA = function (i) {
      if (!motor.leyendo || i < 0 || i >= motor.oraciones.length) return;
      motor.enPausa = false;
      hablar(i);
    };

    return motor;
  }

  // ------------------------------------------------------------------
  // Exportar el objeto global
  // ------------------------------------------------------------------
  global.LectorTTS = {
    AJUSTES_DEFECTO: AJUSTES_DEFECTO,
    trocearEnOraciones: trocearEnOraciones,
    refrescarVoces: refrescarVoces,
    obtenerVoces: obtenerVoces,
    elegirVoz: elegirVoz,
    cargarAjustes: cargarAjustes,
    guardarAjustes: guardarAjustes,
    crearMotorLectura: crearMotorLectura
  };
})(typeof window !== 'undefined' ? window : globalThis);
