import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, MCP_TOKEN, PORT = 3000 } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !MCP_TOKEN) {
  console.error("Faltan variables: SUPABASE_URL, SUPABASE_SERVICE_KEY, MCP_TOKEN");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const BUCKET = "revista";
const FREE_LIMIT_BYTES = 1024 * 1024 * 1024; // 1 GB del plan gratuito

// ---------- utilidades ----------
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });
const run = async (query) => {
  const { data, error } = await query;
  return error ? fail(error.message) : ok(data);
};
const slugify = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const ISSUE_STATUS = z.enum(["borrador", "revision", "publicado"]);
const ARTICLE_STATUS = z.enum(["idea", "redaccion", "revision", "maquetado", "publicado"]);
const ASSET_KIND = z.enum(["imagen", "pdf", "audio", "video", "otro"]);

const WEB_URL = (process.env.WEB_URL || "").replace(/\/$/, "");

async function publishIssue(number, force = false) {
  const { data: issue, error } = await db.from("issues").select("*").eq("number", number).single();
  if (error) return fail(`No existe el número ${number}`);
  const { data: arts } = await db.from("articles").select("id,title,status").eq("issue_id", issue.id);
  if (!arts?.length) return fail("El número no tiene artículos todavía");
  const pending = arts.filter((a) => !["maquetado", "publicado"].includes(a.status));
  if (pending.length && !force) {
    return fail(`Faltan ${pending.length} artículos por terminar: ` +
      pending.map((a) => `"${a.title}" (${a.status})`).join(", ") + ". Termínalos o usa force=true.");
  }
  const now = new Date().toISOString();
  const up = await db.from("articles").update({ status: "publicado", publish_at: now, updated_at: now }).eq("issue_id", issue.id);
  if (up.error) return fail(up.error.message);
  const { data, error: e2 } = await db.from("issues")
    .update({ status: "publicado", issue_date: issue.issue_date ?? now.slice(0, 10), updated_at: now })
    .eq("id", issue.id).select().single();
  if (e2) return fail(e2.message);
  return ok({
    publicado: true,
    numero: data.number,
    titulo: data.title,
    articulos_publicados: arts.length,
    web: WEB_URL ? `${WEB_URL}/#n${data.number}` : "Define WEB_URL en Render para recibir el enlace",
    aviso: data.pdf_url ? undefined : "Este número no tiene PDF asociado todavía",
  });
}

const { BREVO_API_KEY, MAIL_FROM, MAIL_FROM_NAME = "Nexavoz", API_BASE_URL = "", NEWSLETTER_DAILY_LIMIT = "300" } = process.env;

const esc = (v = "") => String(v).replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const validEmail = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function sendMail({ to, subject, html }) {
  if (!BREVO_API_KEY || !MAIL_FROM) throw new Error("Faltan las variables BREVO_API_KEY y MAIL_FROM");
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: MAIL_FROM_NAME, email: MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function buildNewsletter(number) {
  const { data: issue, error } = await db.from("issues").select("*").eq("number", number).single();
  if (error) return { error: `No existe el número ${number}` };
  const { data: arts } = await db.from("articles").select("title,subtitle").eq("issue_id", issue.id).order("created_at");
  return { issue, arts: arts ?? [], subject: `Nexavoz Nº ${issue.number}: ${issue.title}` };
}

function renderNewsletter(issue, arts, unsubUrl) {
  const link = WEB_URL ? `${WEB_URL}/#n${issue.number}` : "#";
  const items = arts.map((a) =>
    `<li style="margin:0 0 12px"><strong>${esc(a.title)}</strong>${a.subtitle ? `<br><span style="color:#6b655e">${esc(a.subtitle)}</span>` : ""}</li>`).join("");
  const cover = /^https?:\/\//.test(issue.cover_url || "")
    ? `<img src="${esc(issue.cover_url)}" alt="" style="width:100%;border-radius:8px;margin:0 0 16px">` : "";
  return `<!DOCTYPE html><html lang="es"><body style="margin:0;background:#faf8f5;font-family:Georgia,serif;color:#1d1b19">
<div style="max-width:560px;margin:0 auto;padding:24px 20px">
<h1 style="margin:0 0 4px;font-size:28px">Nexa<span style="color:#b3261e">voz</span></h1>
<p style="margin:0 0 20px;color:#6b655e">Nº ${esc(issue.number)}</p>
${cover}
<h2 style="margin:0 0 8px">${esc(issue.title)}</h2>
${issue.summary ? `<p>${esc(issue.summary)}</p>` : ""}
<ul style="padding-left:18px;margin:16px 0">${items}</ul>
<p><a href="${esc(link)}" style="display:inline-block;background:#b3261e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-family:Arial,sans-serif">Leer el número completo</a></p>
<hr style="border:none;border-top:1px solid #e6e0d8;margin:28px 0 12px">
<p style="font:12px Arial,sans-serif;color:#6b655e">Recibes este correo porque te suscribiste a Nexavoz. <a href="${esc(unsubUrl)}" style="color:#6b655e">Darme de baja</a></p>
</div></body></html>`;
}

// ---------- herramientas ----------
function buildServer() {
  const server = new McpServer({ name: "nexavoz", version: "1.0.0" });

  // === Números ===
  server.tool("issue_create", "Crea un número de la revista",
    { number: z.number().int(), title: z.string(), issue_date: z.string().optional().describe("YYYY-MM-DD"), summary: z.string().optional() },
    async (a) => run(db.from("issues").insert(clean(a)).select().single()));

  server.tool("issue_list", "Lista los números de la revista (más recientes primero)",
    { status: ISSUE_STATUS.optional() },
    async ({ status }) => {
      let q = db.from("issues").select("*").order("number", { ascending: false });
      if (status) q = q.eq("status", status);
      return run(q);
    });

  server.tool("issue_get", "Devuelve un número con sus artículos y archivos",
    { number: z.number().int() },
    async ({ number }) => {
      const { data: issue, error } = await db.from("issues").select("*").eq("number", number).single();
      if (error) return fail(error.message);
      const [arts, assets] = await Promise.all([
        db.from("articles").select("id,title,status,section_id,author_id").eq("issue_id", issue.id),
        db.from("assets").select("*").eq("issue_id", issue.id),
      ]);
      return ok({ ...issue, articles: arts.data ?? [], assets: assets.data ?? [] });
    });

  server.tool("issue_update", "Edita un número (título, fecha, resumen, portada, PDF, estado)",
    { number: z.number().int(), title: z.string().optional(), issue_date: z.string().optional(),
      summary: z.string().optional(), cover_url: z.string().optional(), pdf_url: z.string().optional(),
      status: ISSUE_STATUS.optional() },
    async ({ number, ...rest }) => {
      if (rest.status === "publicado") return fail("Para publicar usa issue_publish (comprueba que todo esté terminado)");
      return run(db.from("issues").update({ ...clean(rest), updated_at: new Date().toISOString() })
        .eq("number", number).select().single());
    });

  server.tool("issue_publish",
    "Publica un número en la web si todos sus artículos están terminados (maquetado). Con force=true publica aunque falten",
    { number: z.number().int(), force: z.boolean().optional() },
    async ({ number, force }) => publishIssue(number, force ?? false));

  server.tool("issue_unpublish", "Retira un número de la web (vuelve a borrador)",
    { number: z.number().int() },
    async ({ number }) => {
      const { data: issue, error } = await db.from("issues").select("id").eq("number", number).single();
      if (error) return fail(`No existe el número ${number}`);
      await db.from("articles").update({ status: "maquetado" }).eq("issue_id", issue.id);
      return run(db.from("issues").update({ status: "borrador", updated_at: new Date().toISOString() })
        .eq("id", issue.id).select().single());
    });

  // === Autores ===
  server.tool("author_create", "Crea un autor o colaborador",
    { name: z.string(), email: z.string().optional(), bio: z.string().optional() },
    async (a) => run(db.from("authors").insert(clean(a)).select().single()));

  server.tool("author_list", "Lista los autores", {},
    async () => run(db.from("authors").select("*").order("name")));

  // === Secciones ===
  server.tool("section_create", "Crea una sección de la revista",
    { name: z.string(), description: z.string().optional() },
    async ({ name, description }) =>
      run(db.from("sections").insert(clean({ name, slug: slugify(name), description })).select().single()));

  server.tool("section_list", "Lista las secciones", {},
    async () => run(db.from("sections").select("*").order("name")));

  // === Artículos ===
  server.tool("article_create", "Crea un artículo (por defecto en estado 'idea')",
    { title: z.string(), subtitle: z.string().optional(), body: z.string().optional(),
      issue_number: z.number().int().optional(), section_id: z.string().optional(),
      author_id: z.string().optional(), tags: z.array(z.string()).optional() },
    async ({ issue_number, ...a }) => {
      let issue_id;
      if (issue_number !== undefined) {
        const { data, error } = await db.from("issues").select("id").eq("number", issue_number).single();
        if (error) return fail(`No existe el número ${issue_number}`);
        issue_id = data.id;
      }
      const slug = `${slugify(a.title)}-${Date.now().toString(36)}`;
      return run(db.from("articles").insert(clean({ ...a, issue_id, slug })).select().single());
    });

  server.tool("article_get", "Devuelve un artículo completo con sus archivos",
    { id: z.string() },
    async ({ id }) => {
      const { data, error } = await db.from("articles").select("*").eq("id", id).single();
      if (error) return fail(error.message);
      const { data: assets } = await db.from("assets").select("*").eq("article_id", id);
      return ok({ ...data, assets: assets ?? [] });
    });

  server.tool("article_list", "Lista artículos con filtros opcionales",
    { issue_number: z.number().int().optional(), status: ARTICLE_STATUS.optional(),
      section_id: z.string().optional(), author_id: z.string().optional(), limit: z.number().int().max(100).optional() },
    async ({ issue_number, status, section_id, author_id, limit }) => {
      let q = db.from("articles").select("id,title,subtitle,status,issue_id,section_id,author_id,publish_at,updated_at")
        .order("updated_at", { ascending: false }).limit(limit ?? 50);
      if (status) q = q.eq("status", status);
      if (section_id) q = q.eq("section_id", section_id);
      if (author_id) q = q.eq("author_id", author_id);
      if (issue_number !== undefined) {
        const { data } = await db.from("issues").select("id").eq("number", issue_number).single();
        if (!data) return fail(`No existe el número ${issue_number}`);
        q = q.eq("issue_id", data.id);
      }
      return run(q);
    });

  server.tool("article_update", "Edita un artículo (texto, estado, sección, autor, número, etiquetas, fecha de publicación)",
    { id: z.string(), title: z.string().optional(), subtitle: z.string().optional(), body: z.string().optional(),
      status: ARTICLE_STATUS.optional(), section_id: z.string().optional(), author_id: z.string().optional(),
      tags: z.array(z.string()).optional(), publish_at: z.string().optional().describe("ISO 8601") },
    async ({ id, ...rest }) =>
      run(db.from("articles").update({ ...clean(rest), updated_at: new Date().toISOString() })
        .eq("id", id).select().single()));

  server.tool("article_search", "Busca artículos por texto en título, subtítulo o cuerpo",
    { query: z.string() },
    async ({ query }) => {
      const t = query.replace(/[%,()]/g, " ").trim();
      return run(db.from("articles").select("id,title,subtitle,status,issue_id")
        .or(`title.ilike.%${t}%,subtitle.ilike.%${t}%,body.ilike.%${t}%`).limit(30));
    });

  // === Archivos ===
  server.tool("asset_upload",
    "Sube una imagen o PDF (en base64, recomendado menos de 10 MB) al almacenamiento y lo asocia a un número o artículo",
    { filename: z.string(), content_base64: z.string(), mime_type: z.string().describe("p. ej. image/webp, application/pdf"),
      kind: ASSET_KIND.optional(), issue_number: z.number().int().optional(), article_id: z.string().optional(),
      caption: z.string().optional(), credit: z.string().optional() },
    async ({ filename, content_base64, mime_type, kind, issue_number, article_id, caption, credit }) => {
      const buf = Buffer.from(content_base64, "base64");
      const path = `${Date.now().toString(36)}-${slugify(filename.replace(/\.[^.]+$/, ""))}${filename.match(/\.[^.]+$/)?.[0] ?? ""}`;
      const up = await db.storage.from(BUCKET).upload(path, buf, { contentType: mime_type });
      if (up.error) return fail(up.error.message);
      const url = db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      let issue_id;
      if (issue_number !== undefined) {
        const { data } = await db.from("issues").select("id").eq("number", issue_number).single();
        issue_id = data?.id;
      }
      const k = kind ?? (mime_type.startsWith("image/") ? "imagen" : mime_type === "application/pdf" ? "pdf" : "otro");
      return run(db.from("assets").insert(clean({ kind: k, url, storage_path: path, size_bytes: buf.length,
        issue_id, article_id, caption, credit })).select().single());
    });

  server.tool("asset_link",
    "Registra un archivo externo por enlace (YouTube, Internet Archive, MEGA, etc.), útil para vídeo y audio",
    { url: z.string().url(), kind: ASSET_KIND, issue_number: z.number().int().optional(),
      article_id: z.string().optional(), caption: z.string().optional(), credit: z.string().optional() },
    async ({ issue_number, ...a }) => {
      let issue_id;
      if (issue_number !== undefined) {
        const { data } = await db.from("issues").select("id").eq("number", issue_number).single();
        issue_id = data?.id;
      }
      return run(db.from("assets").insert(clean({ ...a, issue_id })).select().single());
    });

  server.tool("asset_delete", "Borra un archivo (y lo elimina del almacenamiento si estaba subido)",
    { id: z.string() },
    async ({ id }) => {
      const { data, error } = await db.from("assets").select("storage_path").eq("id", id).single();
      if (error) return fail(error.message);
      if (data.storage_path) await db.storage.from(BUCKET).remove([data.storage_path]);
      return run(db.from("assets").delete().eq("id", id).select());
    });

  server.tool("storage_usage", "Muestra el espacio usado frente al límite gratuito de 1 GB", {},
    async () => {
      const { data, error } = await db.from("assets").select("size_bytes").not("storage_path", "is", null);
      if (error) return fail(error.message);
      const used = data.reduce((s, r) => s + (r.size_bytes ?? 0), 0);
      return ok({ usado_mb: +(used / 1048576).toFixed(1), limite_mb: FREE_LIMIT_BYTES / 1048576,
        porcentaje: +((used / FREE_LIMIT_BYTES) * 100).toFixed(1), archivos: data.length });
    });

  // === Suscriptores ===
  server.tool("subscriber_stats", "Cuenta los suscriptores por estado (activo, pendiente, baja)", {},
    async () => {
      const { data, error } = await db.from("subscribers").select("status");
      if (error) return fail(error.message);
      const c = { activo: 0, pendiente: 0, baja: 0 };
      data.forEach((r) => { c[r.status] = (c[r.status] ?? 0) + 1; });
      return ok({ ...c, total: data.length });
    });

  server.tool("subscriber_list", "Lista suscriptores",
    { status: z.enum(["activo", "pendiente", "baja"]).optional(), limit: z.number().int().max(500).optional() },
    async ({ status, limit }) => {
      let q = db.from("subscribers").select("email,name,status,source,created_at").order("created_at", { ascending: false }).limit(limit ?? 100);
      if (status) q = q.eq("status", status);
      return run(q);
    });

  server.tool("subscriber_add",
    "Añade un suscriptor a mano como activo. Solo si tienes su consentimiento expreso para recibir la revista",
    { email: z.string(), name: z.string().optional(), consentimiento: z.literal(true).describe("Debe ser true: confirma que la persona dio su consentimiento") },
    async ({ email, name }) => {
      const mail = email.trim().toLowerCase();
      if (!validEmail(mail)) return fail("Correo no válido");
      return run(db.from("subscribers").upsert(
        clean({ email: mail, name, status: "activo", source: "manual", confirmed_at: new Date().toISOString() }),
        { onConflict: "email" }).select("email,status").single());
    });

  server.tool("subscriber_remove", "Da de baja a un suscriptor por su correo",
    { email: z.string() },
    async ({ email }) => run(db.from("subscribers")
      .update({ status: "baja", unsubscribed_at: new Date().toISOString() })
      .eq("email", email.trim().toLowerCase()).select("email,status")));

  // === Newsletter ===
  server.tool("newsletter_preview", "Muestra el asunto y el HTML del boletín de un número", { number: z.number().int() },
    async ({ number }) => {
      const b = await buildNewsletter(number);
      if (b.error) return fail(b.error);
      return ok({ asunto: b.subject, html: renderNewsletter(b.issue, b.arts, "https://ejemplo.com/baja") });
    });

  server.tool("newsletter_send",
    "Envía el boletín de un número publicado a los suscriptores activos. Con test_email solo envía una prueba. Respeta el límite diario y se puede repetir al día siguiente para continuar",
    { number: z.number().int(), test_email: z.string().optional() },
    async ({ number, test_email }) => {
      const b = await buildNewsletter(number);
      if (b.error) return fail(b.error);
      const { issue, arts, subject } = b;
      if (test_email) {
        if (!validEmail(test_email)) return fail("Correo de prueba no válido");
        try { await sendMail({ to: test_email, subject: `[PRUEBA] ${subject}`, html: renderNewsletter(issue, arts, "#") }); }
        catch (e) { return fail(e.message); }
        return ok({ prueba_enviada_a: test_email });
      }
      if (issue.status !== "publicado") return fail("Publica primero el número con issue_publish");

      const { data: subs, error } = await db.from("subscribers").select("id,email,token").eq("status", "activo");
      if (error) return fail(error.message);
      const { data: done } = await db.from("newsletter_deliveries").select("subscriber_id").eq("issue_id", issue.id);
      const doneSet = new Set((done ?? []).map((d) => d.subscriber_id));
      const pending = subs.filter((x) => !doneSet.has(x.id));
      const limit = parseInt(NEWSLETTER_DAILY_LIMIT, 10) || 300;
      const batch = pending.slice(0, limit);
      const base = API_BASE_URL.replace(/\/$/, "");

      let sent = 0; const errors = [];
      for (let i = 0; i < batch.length && errors.length < 5; i += 10) {
        const results = await Promise.allSettled(batch.slice(i, i + 10).map(async (sub) => {
          await sendMail({ to: sub.email, subject, html: renderNewsletter(issue, arts, `${base}/api/unsubscribe?token=${sub.token}`) });
          await db.from("newsletter_deliveries").insert({ issue_id: issue.id, subscriber_id: sub.id });
        }));
        results.forEach((r) => { r.status === "fulfilled" ? sent++ : errors.push(r.reason?.message ?? "error"); });
      }
      return ok({
        enviados: sent,
        pendientes: pending.length - sent,
        errores: errors,
        nota: pending.length - sent > 0 ? "Quedan suscriptores por enviar: repite newsletter_send (mañana si es por el límite diario)" : "Envío completo",
      });
    });

  // === IA: el MCP prepara el contexto, Claude redacta y el MCP guarda el resultado (coste 0) ===
  const AI_TASKS = {
    titulares: "Propón 5 titulares alternativos (máx. 70 caracteres), claros, sin clickbait y en el tono de la revista. Guárdalos con article_set_ai (headline_options). Si el usuario elige uno, usa apply_headline con su posición (1 a 5).",
    resumen: "Escribe un resumen de 2-3 frases (máx. 280 caracteres), fiel al texto y sin inventar datos. Guárdalo con article_set_ai (summary).",
    seo: "Redacta seo_title (máx. 60 caracteres, con la palabra clave principal), seo_description (máx. 155 caracteres, que invite a leer) y 5-8 keywords. Guárdalos con article_set_ai.",
    correccion: "Revisa ortografía, gramática, puntuación y estilo. Lista los cambios propuestos y, solo si el usuario los aprueba, aplica el texto corregido con article_update (body). No cambies datos, cifras ni citas.",
  };

  server.tool("article_ai_context",
    "Devuelve el artículo y las instrucciones para generar titulares, resumen, SEO o corrección de estilo. Después Claude redacta y guarda con article_set_ai",
    { id: z.string(), task: z.enum(["titulares", "resumen", "seo", "correccion", "todo"]).optional() },
    async ({ id, task }) => {
      const { data: a, error } = await db.from("articles").select("*, sections(name), authors(name)").eq("id", id).single();
      if (error) return fail(error.message);
      const words = (a.body ?? "").split(/\s+/).filter(Boolean).length;
      const names = task && task !== "todo" ? [task] : Object.keys(AI_TASKS);
      return ok({
        articulo: { id: a.id, titulo: a.title, subtitulo: a.subtitle, seccion: a.sections?.name, autor: a.authors?.name,
                    texto: a.body, etiquetas: a.tags },
        guardado_actual: { headline_options: a.headline_options, summary: a.summary, seo_title: a.seo_title,
                           seo_description: a.seo_description, keywords: a.keywords },
        palabras: words,
        minutos_lectura: Math.max(1, Math.round(words / 200)),
        tareas: Object.fromEntries(names.map((n) => [n, AI_TASKS[n]])),
      });
    });

  server.tool("article_set_ai",
    "Guarda lo generado para un artículo: titulares alternativos, resumen, SEO y keywords. apply_headline (1-5) cambia el título del artículo por esa opción",
    { id: z.string(), headline_options: z.array(z.string()).max(10).optional(), summary: z.string().optional(),
      seo_title: z.string().optional(), seo_description: z.string().optional(), keywords: z.array(z.string()).max(12).optional(),
      apply_headline: z.number().int().min(1).max(10).optional() },
    async ({ id, headline_options, summary, seo_title, seo_description, keywords, apply_headline }) => {
      const patch = clean({ headline_options, summary, seo_title, seo_description, keywords });
      const avisos = [];
      if (seo_title && seo_title.length > 70) avisos.push(`seo_title tiene ${seo_title.length} caracteres (recomendado hasta 60)`);
      if (seo_description && seo_description.length > 160) avisos.push(`seo_description tiene ${seo_description.length} caracteres (recomendado hasta 155)`);
      if (summary && summary.length > 300) avisos.push(`summary tiene ${summary.length} caracteres (recomendado hasta 280)`);
      if (apply_headline !== undefined) {
        const { data: cur, error } = await db.from("articles").select("headline_options").eq("id", id).single();
        if (error) return fail(error.message);
        const chosen = (headline_options ?? cur.headline_options ?? [])[apply_headline - 1];
        if (!chosen) return fail(`No hay titular en la posición ${apply_headline}`);
        patch.title = chosen;
      }
      if (!Object.keys(patch).length) return fail("No hay nada que guardar");
      const { data, error } = await db.from("articles").update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id).select("id,title,summary,seo_title,seo_description,keywords,headline_options").single();
      if (error) return fail(/column/i.test(error.message) ? "Faltan columnas: ejecuta schema-ia.sql en Supabase" : error.message);
      return ok({ ...data, avisos });
    });

  server.tool("issue_ai_context",
    "Devuelve los artículos de un número con sus resúmenes para redactar el resumen y la descripción SEO del número",
    { number: z.number().int() },
    async ({ number }) => {
      const { data: issue, error } = await db.from("issues").select("*").eq("number", number).single();
      if (error) return fail(`No existe el número ${number}`);
      const { data: arts, error: e2 } = await db.from("articles").select("title,subtitle,summary,tags").eq("issue_id", issue.id);
      if (e2) return fail(/column/i.test(e2.message) ? "Faltan columnas: ejecuta schema-ia.sql en Supabase" : e2.message);
      return ok({
        numero: { number: issue.number, titulo: issue.title, resumen_actual: issue.summary, seo_description_actual: issue.seo_description },
        articulos: arts,
        tarea: "Escribe un resumen del número (máx. 300 caracteres) y una seo_description (máx. 155). Guárdalos con issue_set_ai.",
      });
    });

  server.tool("issue_set_ai", "Guarda el resumen y la descripción SEO de un número",
    { number: z.number().int(), summary: z.string().optional(), seo_description: z.string().optional() },
    async ({ number, ...rest }) => {
      const patch = clean(rest);
      if (!Object.keys(patch).length) return fail("No hay nada que guardar");
      const { data, error } = await db.from("issues").update({ ...patch, updated_at: new Date().toISOString() })
        .eq("number", number).select("number,title,summary,seo_description").single();
      if (error) return fail(/column/i.test(error.message) ? "Faltan columnas: ejecuta schema-ia.sql en Supabase" : error.message);
      return ok(data);
    });

  server.tool("seo_audit",
    "Revisa qué artículos tienen SEO incompleto o demasiado largo (de un número o de toda la revista). Útil antes de publicar",
    { number: z.number().int().optional() },
    async ({ number }) => {
      let q = db.from("articles").select("id,title,seo_title,seo_description,summary,keywords");
      if (number !== undefined) {
        const { data: i } = await db.from("issues").select("id").eq("number", number).single();
        if (!i) return fail(`No existe el número ${number}`);
        q = q.eq("issue_id", i.id);
      }
      const { data, error } = await q;
      if (error) return fail(/column/i.test(error.message) ? "Faltan columnas: ejecuta schema-ia.sql en Supabase" : error.message);
      const problems = [];
      for (const a of data) {
        const m = [];
        if (!a.seo_title) m.push("falta seo_title"); else if (a.seo_title.length > 70) m.push("seo_title demasiado largo");
        if (!a.seo_description) m.push("falta seo_description"); else if (a.seo_description.length > 160) m.push("seo_description demasiado larga");
        if (!a.summary) m.push("falta resumen");
        if (!(a.keywords ?? []).length) m.push("faltan keywords");
        if (m.length) problems.push({ id: a.id, titulo: a.title, problemas: m });
      }
      return ok({ revisados: data.length, con_problemas: problems.length, detalle: problems.slice(0, 50) });
    });

  return server;
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "25mb" }));

const authorized = (req) =>
  req.params.token === MCP_TOKEN || req.headers.authorization === `Bearer ${MCP_TOKEN}`;

app.get("/health", (_req, res) => res.json({ ok: true, service: "nexavoz-mcp" }));

// ---------- API pública: suscripción ----------
const cors = (req, res, next) => {
  res.set("Access-Control-Allow-Origin", WEB_URL || "*");
  res.set("Access-Control-Allow-Headers", "content-type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
};
const hits = new Map();
const limited = (ip) => {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 3600000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 10;
};
const apiBase = (req) => (API_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const page = (title, msg) => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Georgia,serif;max-width:480px;margin:15vh auto;padding:0 20px;text-align:center"><h1>${esc(title)}</h1><p>${esc(msg)}</p>${WEB_URL ? `<p><a href="${esc(WEB_URL)}">Ir a Nexavoz</a></p>` : ""}</body></html>`;

app.use("/api/subscribe", cors);
app.post("/api/subscribe", async (req, res) => {
  try {
    if (limited(req.ip)) return res.status(429).json({ ok: false, error: "Demasiados intentos, prueba más tarde" });
    const { email, name, website } = req.body ?? {};
    if (website) return res.json({ ok: true }); // trampa para bots
    const mail = String(email ?? "").trim().toLowerCase();
    if (!validEmail(mail)) return res.status(400).json({ ok: false, error: "Correo no válido" });
    const cleanName = name ? String(name).slice(0, 100) : undefined;

    const { data: existing } = await db.from("subscribers").select("id,status,token").eq("email", mail).maybeSingle();
    if (existing?.status === "activo") return res.json({ ok: true });
    let token = existing?.token;
    if (existing) {
      await db.from("subscribers").update(clean({ status: "pendiente", name: cleanName })).eq("id", existing.id);
    } else {
      const { data, error } = await db.from("subscribers").insert(clean({ email: mail, name: cleanName })).select("token").single();
      if (error) throw error;
      token = data.token;
    }
    const url = `${apiBase(req)}/api/confirm?token=${token}`;
    await sendMail({
      to: mail,
      subject: "Confirma tu suscripción a Nexavoz",
      html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px"><h2>Confirma tu suscripción</h2>
<p>Pulsa el botón para empezar a recibir Nexavoz en tu correo. Si no fuiste tú, ignora este mensaje.</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#b3261e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-family:Arial,sans-serif">Confirmar suscripción</a></p></div>`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "No se pudo completar la suscripción" });
  }
});

app.get("/api/confirm", async (req, res) => {
  const token = String(req.query.token ?? "");
  const { data } = await db.from("subscribers").update({ status: "activo", confirmed_at: new Date().toISOString() })
    .eq("token", token).select("id");
  res.send(data?.length ? page("¡Suscripción confirmada!", "Recibirás cada nuevo número de Nexavoz en tu correo.")
                        : page("Enlace no válido", "Este enlace no es válido o ya caducó."));
});

app.get("/api/unsubscribe", async (req, res) => {
  const token = String(req.query.token ?? "");
  const { data } = await db.from("subscribers").update({ status: "baja", unsubscribed_at: new Date().toISOString() })
    .eq("token", token).select("id");
  res.send(data?.length ? page("Te has dado de baja", "No recibirás más correos de Nexavoz.")
                        : page("Enlace no válido", "Este enlace no es válido."));
});

app.post(["/mcp", "/mcp/:token"], async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

app.all(["/mcp", "/mcp/:token"], (_req, res) => res.status(405).json({ error: "method not allowed" }));

app.listen(PORT, () => console.log(`Nexavoz MCP escuchando en :${PORT}`));
