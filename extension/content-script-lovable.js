// Content script para Lovable (antes lovable_content.js)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  console.log('[Ally Content Script] Dominio actual:', window.location.origin, window.location.href);
  console.log('[Ally Content Script] Es frame principal:', window === window.top);
  console.log('[Ally Content Script] chrome:', typeof chrome, chrome);

  if (event.data.type === 'ALLY_SESSION_UPDATE') {
    console.log('[Ally Content Script] Recibido de Lovable:', event.data.payload);

    // Mapear snake_case a camelCase
    const payload = event.data.payload || {};
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'ALLY_SUPABASE_SESSION',
        payload: {
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token,
          userId: payload.user_id,
          expiresAt: payload.expires_at
        }
      });
      console.log('[Ally Content Script] Sesión reenviada al service worker');
    } else {
      console.error('[Ally Content Script] chrome.runtime.sendMessage no está disponible', { chrome });
    }
  }

  if (event.data.type === 'ALLY_SESSION_LOGOUT') {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'ALLY_CLEAR_SESSION'
      });
      console.log('[Ally Content Script] Logout reenviado al service worker');
    } else {
      console.error('[Ally Content Script] chrome.runtime.sendMessage no está disponible para logout', { chrome });
    }
  }
});

console.log('[Ally Content Script] Escuchando sesión de Lovable...');