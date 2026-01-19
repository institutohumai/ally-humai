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
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      try {
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
      } catch (error) {
        console.warn('[Ally Content Script] Extension context invalidated, recarga la página', error.message);
      }
    } else {
      console.warn('[Ally Content Script] Extension context no disponible, recarga la página');
    }
  }

  if (event.data.type === 'ALLY_SESSION_LOGOUT') {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      try {
        chrome.runtime.sendMessage({
          type: 'ALLY_CLEAR_SESSION'
        });
        console.log('[Ally Content Script] Logout reenviado al service worker');
      } catch (error) {
        console.warn('[Ally Content Script] Extension context invalidated para logout', error.message);
      }
    } else {
      console.warn('[Ally Content Script] Extension context no disponible para logout');
    }
  }
});

console.log('[Ally Content Script] Escuchando sesión de Lovable...');