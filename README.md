# Ally Humai: Bridge (FastAPI) + Extensión Chrome

Guía breve para desplegar el backend y usar la extensión.

## 1) Backend (bridge FastAPI)
- Python 3.11+ recomendado.
- Instalar dependencias: `pip install -r requirements.txt`.
- Variables de entorno requeridas:
  - `SUPABASE_URL` (ej: https://<tu-proyecto>.supabase.co)
  - `SUPABASE_ANON_KEY` (anon/public key de Supabase)
- Arranque local (dev): `uvicorn bridge_server:app --host 0.0.0.0 --port 8000 --reload`
- Producción (ejemplo simple): `gunicorn -k uvicorn.workers.UvicornWorker bridge_server:app --bind 0.0.0.0:8000`
- Endpoints útiles:
  - `GET /health` → status del bridge
  - `GET /config` → usa el token Supabase para devolver agency_id/created_by
  - `POST /candidates` → recibe candidatos en batch

## 2) Extensión Chrome
### Qué hace
- Lee el perfil actual de LinkedIn, arma el payload de candidato y lo envía al bridge.
- Recibe la sesión de Supabase desde la app Lovable y la guarda para autenticar las llamadas.
- Maneja cola local si no hay sesión o si falla el envío.

### Configurar URLs de backend
Edita `extension/service_worker.js`:
- Cambia `API_BASE_URL` a la URL pública de tu bridge (ej: `https://bridge.midominio.com`).
- Asegúrate de que `API_ENDPOINT` y `CONFIG_ENDPOINT` queden derivados de esa base.

Edita `extension/manifest.json`:
- En `host_permissions`, añade la URL pública del bridge (ej: `https://bridge.midominio.com/*`).
- Mantén LinkedIn y la(s) URL(s) de Lovable que uses.

### Uso en modo “sin empaquetar” (recomendado para clientes internos/pilotos)
1. Asegúrate de que el bridge esté accesible (dominio público o `http://localhost:8000`).
2. En Chrome: `chrome://extensions` → activa “Modo desarrollador”.
3. Click en “Cargar descomprimida” y selecciona la carpeta `extension/` de este repo.
4. Inicia sesión en la app Lovable (dominio permitido en manifest). La app enviará la sesión a la extensión; el badge cambiará:
   - `!` rojo: sin sesión
   - número ámbar: candidatos en cola
   - verde (sin texto): listo
5. Ve a un perfil de LinkedIn. El content script extrae los datos y los envía al bridge. Si no hay sesión o el envío falla, se encola y se reintenta.

### Publicar en Chrome Web Store (opcional)
- Empaqueta la carpeta `extension/` en un ZIP tras ajustar `API_BASE_URL` y `host_permissions` a producción.
- Sube el ZIP al Developer Dashboard de Chrome Web Store y publica. Esto habilita actualizaciones automáticas para usuarios finales.

## 3) Flujo de datos
1. El usuario inicia sesión en Lovable → el content script `content-script-lovable.js` envía la sesión al service worker.
2. En LinkedIn, `content-script-linkedin.js` extrae el perfil y manda un mensaje al service worker.
3. El service worker llama al bridge (`/config` para agency_id/created_by y `/candidates` para enviar el payload). Si falla, guarda en cola y reintenta.

## 4) Checklist rápida para producción
- [ ] Bridge desplegado con HTTPS y env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) configuradas.
- [ ] `API_BASE_URL` en `extension/service_worker.js` apunta al dominio público del bridge.
- [ ] `host_permissions` en `extension/manifest.json` incluyen el dominio del bridge y los dominios de Lovable que uses.
- [ ] Probar login en Lovable, luego abrir LinkedIn y verificar que llegan candidatos a Supabase.

## 5) Troubleshooting
- Badge `!` rojo: la extensión no tiene sesión; vuelve a iniciar sesión en Lovable.
- Cola que no baja: revisa conectividad con el bridge (`/health`) y que el dominio esté en `host_permissions`.
- 403/401 en `/candidates` o `/config`: token inválido o cabeceras `X-Ally-User-Id` / `X-Ally-Agency-ID` faltantes; verifica sesión.
- Para depurar, abre las DevTools del service worker: `chrome://extensions` → “service worker” (en la tarjeta de la extensión) → “Inspect”.
