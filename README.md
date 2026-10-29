# Nexavoz MCP

Servidor MCP para gestionar la revista digital Nexavoz. Coste 0: Render (gratis) + Supabase (gratis).

## 1. Supabase
1. Crea un proyecto en supabase.com.
2. SQL Editor → pega y ejecuta `schema.sql` (crea tablas y el bucket `revista`).
3. Settings → API: copia **Project URL** y la clave **service_role** (secreta, no la compartas).

## 2. Subir el código
Sube esta carpeta a un repositorio de GitHub.

## 3. Render
1. New → Web Service → elige el repositorio. Plan **Free**.
2. Build command: `npm install` · Start command: `npm start`
3. Variables de entorno:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_KEY` = clave service_role
   - `MCP_TOKEN` = una cadena larga y aleatoria (inventa una)
4. Cuando despliegue, tu URL será: `https://TU-SERVICIO.onrender.com/mcp/TU_MCP_TOKEN`

## 4. Conectar a Claude
Ajustes → Conectores → Añadir conector personalizado → pega esa URL.

## Herramientas
- Números: `issue_create`, `issue_list`, `issue_get`, `issue_update`
- Autores y secciones: `author_create/list`, `section_create/list`
- Artículos: `article_create/get/list/update/search`
- Archivos: `asset_upload` (imagen/PDF), `asset_link` (vídeo/audio por enlace), `asset_delete`, `storage_usage`

## Consejos plan gratuito
- Sube imágenes optimizadas (WebP, ~300 KB).
- El proyecto de Supabase se pausa tras una semana sin actividad.
- Render duerme el servicio sin uso; la primera llamada tarda unos segundos.

## Publicación automática en la web
Cuando un número esté terminado, la herramienta `issue_publish` lo publica y aparece en la web al instante.

1. Supabase → SQL Editor: ejecuta `schema-publico.sql` (después de `schema.sql`). Solo se puede leer lo publicado; los emails de los autores nunca son públicos.
2. Abre `web/index.html` y pega tu **Project URL** y la clave **anon** (Settings → API, no la service_role).
3. Render → New → **Static Site** (gratis), mismo repositorio, **Publish directory:** `web`. Sin build command.
4. En el servicio del MCP añade la variable `WEB_URL` = la URL de la web (para que `issue_publish` te devuelva el enlace).

Flujo: artículos en estado `maquetado` → `issue_publish` (número N) → visible en la web.
- Si falta algún artículo por terminar, te dice cuáles y no publica (salvo `force=true`).
- `issue_unpublish` retira el número de la web.

## Suscriptores y newsletter (gratis)
1. Supabase → SQL Editor: ejecuta `schema-newsletter.sql`.
2. Crea una cuenta gratuita en brevo.com (300 correos al día, sin tarjeta). Verifica un correo remitente (Senders) y crea una clave API (SMTP & API → API keys).
3. Variables nuevas en el servicio MCP de Render:
   - `BREVO_API_KEY` = tu clave API de Brevo
   - `MAIL_FROM` = el correo remitente verificado
   - `MAIL_FROM_NAME` = Nexavoz (opcional)
   - `API_BASE_URL` = URL pública del servicio MCP, sin `/` final
   - `NEWSLETTER_DAILY_LIMIT` = 300 (opcional)
4. En `web/index.html` pega `API_URL` (la misma URL del MCP) y vuelve a desplegar la web.

Flujo: la web recoge el correo → el suscriptor confirma por email (doble confirmación, recomendable por RGPD) → queda `activo`.
Al publicar un número: `newsletter_send` con `test_email` para una prueba y, si está bien, sin él para enviar a todos.
Si hay más suscriptores que el límite diario, repite `newsletter_send` al día siguiente: solo se envía a quien aún no lo recibió.

Herramientas: `subscriber_stats`, `subscriber_list`, `subscriber_add` (requiere consentimiento), `subscriber_remove`, `newsletter_preview`, `newsletter_send`.
Cada correo incluye un enlace de baja.

## Herramientas de IA (titulares, resúmenes, SEO)
1. Supabase → SQL Editor: ejecuta `schema-ia.sql`.
2. No necesita claves ni coste extra: la IA es Claude, en tu chat. El MCP le pasa el artículo y las instrucciones, y guarda lo que Claude redacta.

Uso típico (dile a Claude): "Genera titulares y SEO del artículo X".
- `article_ai_context` (task: titulares, resumen, seo, correccion o todo) → Claude redacta → `article_set_ai` guarda.
- `issue_ai_context` / `issue_set_ai`: resumen y descripción SEO del número.
- `seo_audit`: lista los artículos con SEO incompleto antes de publicar.

Nota: la web es una página estática, así que la descripción SEO se actualiza en el navegador. Buscadores como Google la leen, pero las vistas previas al compartir en redes (WhatsApp, X) mostrarán la descripción general de Nexavoz, no la de cada número.

## Orden recomendado de despliegue
1. Supabase: `schema.sql` → `schema-publico.sql` → `schema-newsletter.sql` → `schema-ia.sql`
2. GitHub → Render (servicio MCP) con sus variables
3. Render Static Site (web) con `SUPABASE_URL`, clave anon y `API_URL` pegadas en `index.html`
4. Brevo (correo remitente + clave API)
5. Conectar el MCP a Claude y probar: crear número → artículo → `issue_publish` → `newsletter_send` con `test_email`
