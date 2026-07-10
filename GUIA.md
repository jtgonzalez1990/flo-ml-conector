# Guía: conectar Mercado Libre a Claude (flo.)

Integración en 4 pasos. Al final, el dashboard de objetivos podrá llenar la columna de Mercado Libre automáticamente.

---

## Paso 1 — Crear la aplicación en Mercado Libre (10 min)

1. Entra a **developers.mercadolibre.cl** e inicia sesión con la **cuenta vendedora de flo.**
2. Ve a **Mis aplicaciones → Crear nueva aplicación**.
3. Completa:
   - **Nombre**: `flo dashboard` (o similar)
   - **URI de redirect**: `https://TU-APP.up.railway.app/oauth/callback` ← la URL exacta la tendrás en el Paso 2; puedes volver a editarla después.
   - **Scopes**: marca solo **read** (lectura). No necesitas notificaciones/topics.
4. Guarda y anota el **App ID** (Client ID) y el **Secret Key**.

## Paso 2 — Desplegar el servidor en Railway (15 min)

Railway es lo más simple (también sirve Render). El plan Hobby (~US$5/mes) alcanza de sobra.

1. Sube la carpeta `ml-mcp-connector` a un repositorio **privado** de GitHub (los 3 archivos: `server.js`, `package.json`, `GUIA.md`).
2. En **railway.app**: New Project → **Deploy from GitHub repo** → elige el repo.
3. En el servicio → **Settings → Networking → Generate Domain**. Anota la URL (ej: `https://flo-ml.up.railway.app`).
4. En **Settings → Volumes → Add Volume**, monta un volumen en `/data` (ahí se guardan los tokens; sin esto, la autorización se pierde en cada redeploy).
5. En **Variables**, agrega:

   | Variable | Valor |
   |---|---|
   | `ML_CLIENT_ID` | App ID del Paso 1 |
   | `ML_CLIENT_SECRET` | Secret Key del Paso 1 |
   | `BASE_URL` | la URL de Railway, sin `/` final |
   | `MCP_SECRET` | una clave aleatoria larga (30+ caracteres; inventa una o usa un generador) |

6. Vuelve a Mercado Libre (Paso 1.3) y deja la URI de redirect exactamente como: `TU_BASE_URL/oauth/callback`.
7. Redeploy si es necesario. Abre `TU_BASE_URL/` en el navegador: debe decir "sin autorizar".

## Paso 3 — Autorizar la cuenta (2 min, una sola vez)

1. Abre `TU_BASE_URL/auth` en el navegador.
2. Inicia sesión / autoriza con la cuenta vendedora de flo.
3. Debe aparecer "✅ Cuenta de Mercado Libre autorizada".

El servidor renueva los tokens solo (los access tokens de ML duran 6 horas; el refresh es automático).

## Paso 4 — Agregar el conector en Claude (2 min)

1. En Claude: **Ajustes → Conectores → Agregar conector personalizado**.
2. URL: `TU_BASE_URL/mcp/TU_MCP_SECRET` (el mismo valor de la variable `MCP_SECRET`).
3. Sin autenticación adicional (la clave va en la URL).
4. Listo. Dile a Claude: *"prueba ml_estado"* para verificar.

---

## Tools que expone

- `ml_estado` — verifica la conexión
- `ml_ventas_mensuales` — ventas por mes (órdenes pagadas, CLP): para el dashboard
- `ml_ordenes_recientes` — últimas órdenes con productos

## Después de conectar

Pídele a Claude en Cowork: *"conecta el dashboard de objetivos a Mercado Libre"* — actualizará el artefacto para que la columna ML se llene sola, igual que Shopify.

## Notas

- El monto usa órdenes **pagadas** por fecha de creación (zona horaria -04:00). Puede diferir levemente de la facturación de ML (comisiones, envíos, devoluciones).
- Si cambias el `MCP_SECRET`, actualiza también la URL del conector en Claude.
- Mantén el repo privado: el código no contiene secretos, pero es buena práctica.
