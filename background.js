/**
 * background.js — Guion de fondo de "Lector TTS".
 *
 * Se encarga SOLO de tres cosas:
 *   1. Crear el menú contextual (clic derecho → "🔊 Leer selección" / "🔊 Leer página completa").
 *   2. Escuchar el atajo de teclado Alt+L.
 *   3. Reenviar esas órdenes al content script de la pestaña activa.
 *
 * IMPORTANTE: aquí NUNCA se usa speechSynthesis. En Chromium este archivo corre
 * como service worker (sin acceso a la síntesis de voz) y en Firefox como página
 * de eventos. Toda la voz vive en content.js y en las páginas de la extensión.
 * Tampoco se usan chrome.tts ni chrome.offscreen: no existen en Firefox.
 */

'use strict';

/** Crea (o recrea) las entradas del menú contextual. */
function crearMenus() {
  // removeAll evita el error "duplicate id" cuando el service worker se reinicia.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'leer-seleccion',
      title: '🔊 Leer selección',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'leer-pagina',
      title: '🔊 Leer página completa',
      contexts: ['page']
    });
  });
}

// En Chromium el menú se registra al instalar; en Firefox (página de eventos)
// conviene recrearlo también al arrancar el navegador. Cubrimos ambos casos.
chrome.runtime.onInstalled.addListener(crearMenus);
chrome.runtime.onStartup.addListener(crearMenus);

/**
 * Envía un mensaje al content script de una pestaña, sin romper nada si la
 * pestaña es una página restringida (chrome://, about:, tienda de extensiones…)
 * donde los content scripts no pueden ejecutarse.
 */
function enviarATab(tabId, mensaje) {
  chrome.tabs.sendMessage(tabId, mensaje, () => {
    if (chrome.runtime.lastError) {
      // No hay content script en esa página. Leemos chrome.runtime.lastError
      // para que el navegador no registre un error sin capturar. El aviso
      // amable al usuario se muestra desde el popup, que sí tiene interfaz.
    }
  });
}

// Clic en el menú contextual.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id === undefined) return;

  if (info.menuItemId === 'leer-seleccion') {
    // Pasamos también el texto que vio el navegador como respaldo, por si la
    // selección se pierde antes de que el content script la consulte.
    enviarATab(tab.id, { accion: 'leer-seleccion', textoRespaldo: info.selectionText || '' });
  } else if (info.menuItemId === 'leer-pagina') {
    enviarATab(tab.id, { accion: 'leer-pagina' });
  }
});

// Atajo de teclado (Alt+L por defecto, configurable por el usuario).
chrome.commands.onCommand.addListener((comando) => {
  if (comando !== 'leer-seleccion') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      // Si no hay nada seleccionado, el content script leerá la página entera.
      enviarATab(tabs[0].id, { accion: 'leer-seleccion' });
    }
  });
});
