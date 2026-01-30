// Content script para Lovable (antes lovable_content.js)
function ensureExtensionContext(tag) {
  const ok = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  if (!ok) {
    const detail = `Extension context no disponible (${tag})`;
    console.info('[Ally Content Script]', detail); // Cambiado a info
    // Informa a la app para que marque desconectado y muestre acción de reconectar
    window.postMessage({ type: 'ALLY_PONG', active: false, detail }, '*');
    window.postMessage({ type: 'ALLY_SESSION_CLEARED' }, '*');
  }
  return ok;
}
window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  console.log('[Ally Content Script] Dominio actual:', window.location.origin, window.location.href);
  console.log('[Ally Content Script] Es frame principal:', window === window.top);
  console.log('[Ally Content Script] chrome:', typeof chrome, chrome);

  if (event.data.type === 'ALLY_SESSION_UPDATE') {
    console.log('[Ally Content Script] Recibido de Lovable:', event.data.payload);

    // Mapear snake_case a camelCase
    const payload = event.data.payload || {};
    console.log('[Ally Content Script] Payload recibido:', payload);
    console.log('[Ally Content Script] agency_id recibido:', payload.agency_id); // Log específico para agency_id

    if (ensureExtensionContext('SESSION_UPDATE')) {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'ALLY_SUPABASE_SESSION',
            payload: {
              accessToken: payload.access_token,
              refreshToken: payload.refresh_token,
              userId: payload.user_id,
              expiresAt: payload.expires_at,
              agencyId: payload.agency_id // Asegúrate de que Lovable envíe "agency_id"
            }
          },
          (response) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              console.warn('[Ally Content Script] Error reenviando sesión al service worker', lastError.message);
              window.postMessage({ type: 'ALLY_SESSION_CONFIRMED', success: false, detail: lastError.message }, '*');
              return;
            }
            const ok = response?.ok === true || response?.unchanged === true;
            const detail = response?.detail || (!response ? 'Sin respuesta del service worker' : undefined);
            if (ok) {
              console.log('[Ally Content Script] Sesión reenviada y confirmada por el service worker');
            } else {
              console.warn('[Ally Content Script] El service worker rechazó la sesión', detail);
            }
            window.postMessage({ type: 'ALLY_SESSION_CONFIRMED', success: ok, detail }, '*');
          }
        );
      } catch (error) {
        console.warn('[Ally Content Script] Extension context invalidated, recarga la página', error.message);
        window.postMessage({ type: 'ALLY_SESSION_CONFIRMED', success: false, detail: error.message }, '*');
      }
    } else {
      window.postMessage({ type: 'ALLY_SESSION_CONFIRMED', success: false, detail: 'Extension context no disponible' }, '*');
    }
  }

  if (event.data.type === 'ALLY_SESSION_LOGOUT') {
    if (ensureExtensionContext('SESSION_LOGOUT')) {
      try {
        chrome.runtime.sendMessage({
          type: 'ALLY_CLEAR_SESSION'
        });
        console.log('[Ally Content Script] Logout reenviado al service worker');
      } catch (error) {
        console.warn('[Ally Content Script] Extension context invalidated para logout', error.message);
      }
    } else {
      // console.warn('[Ally Content Script] Extension context no disponible para logout');
    }
  }

  if (event.data.type === 'ALLY_PING') {
    if (ensureExtensionContext('PING')) {
      try {
        chrome.runtime.sendMessage({ type: 'ALLY_PING' }, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            window.postMessage({ type: 'ALLY_PONG', active: false, detail: lastError.message }, '*');
            return;
          }
          const active = response?.active === true;
          window.postMessage({ type: 'ALLY_PONG', active, userId: response?.userId || null, detail: response?.detail }, '*');
        });
      } catch (error) {
        window.postMessage({ type: 'ALLY_PONG', active: false, detail: error.message }, '*');
      }
    } else {
      window.postMessage({ type: 'ALLY_PONG', active: false, detail: 'Extension context no disponible' }, '*');
    }
  }
});

// Escucha mensajes desde el service worker y los reexpone a la página
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'ALLY_SESSION_CLEARED') {
      window.postMessage({ type: 'ALLY_SESSION_CLEARED' }, '*');
      sendResponse?.({ ok: true });
      return;
    }
    if (message?.type === 'ALLY_BRIDGE_ERROR') {
      window.postMessage({ type: 'ALLY_BRIDGE_ERROR', detail: message.detail }, '*');
      sendResponse?.({ ok: true });
      return;
    }
    if (message?.type === 'ALLY_PONG') {
      window.postMessage({ type: 'ALLY_PONG', active: message.active, userId: message.userId || null, detail: message.detail }, '*');
      sendResponse?.({ ok: true });
      return;
    }
  });
}

console.log('[Ally Content Script] Escuchando sesión de Lovable...');