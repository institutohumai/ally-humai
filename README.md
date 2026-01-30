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

## 3) Flujo de datos
1. El usuario inicia sesión en Lovable → el content script `content-script-lovable.js` envía la sesión al service worker.
2. En LinkedIn, `content-script-linkedin.js` extrae el perfil y manda un mensaje al service worker.
3. El service worker llama al bridge (`/config` para agency_id/created_by y `/candidates` para enviar el payload). Si falla, guarda en cola y reintenta.

### Guía paso a paso: Cómo actualizar bridge_server en producción
🎯 Cuando quieras hacer cambios en tu código:
Paso 1: Hacer tus cambios
# Edita tu archivo bridge_server.py con los cambios que necesites
nano bridge_server.py
# o usa tu editor favorito

Run in CloudShell
Paso 2: Reconstruir la imagen Docker
# Reconstruir la imagen con tus cambios
docker build -t ally-fastapi-lambda .

Run in CloudShell
Paso 3: Etiquetar para ECR
# Etiquetar la imagen para tu repositorio ECR
docker tag ally-fastapi-lambda:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/ally-fastapi-lambda-app:latest

Run in CloudShell
Paso 4: Autenticarse con ECR (si no lo hiciste recientemente)
# Solo necesario si no te autenticaste en las últimas horas
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

Run in CloudShell
Paso 5: Subir la nueva imagen
# Subir la imagen actualizada a ECR
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/ally-fastapi-lambda-app:latest

Run in CloudShell
Paso 6: Actualizar Lambda
# Actualizar la función Lambda para usar la nueva imagen
aws lambda update-function-code \
  --function-name ally-fastapi-lambda-function \
  --image-uri $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/ally-fastapi-lambda-app:latest \
  --region $AWS_REGION

Run in CloudShell
Paso 7: Probar que funciona
# Probar tu API
curl https://vlux2ct9zi.execute-api.us-east-2.amazonaws.com/health

# Ver logs en tiempo real (opcional)
aws logs tail "/aws/lambda/ally-fastapi