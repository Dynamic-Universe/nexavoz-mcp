//Nexavoz MCP server (ES module) - Streamable HTTP (JSON-RPC), sin dependencias externas.
// Requiere Node >= 18. Variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY, MCP_TOKEN
// Opcional: ALLOWED_TABLES="tabla1,tabla2" para limitar el acceso a tablas.

import http from "node:http";

const PORT = process.env.PORT || 10000;
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, MCP_TOKEN } = process.env;
const ALLOWED_TABLES = (process.env.ALLOWED_TABLES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "MCP_TOKEN"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Faltan variables: " + missing.join(", "));
  process.exit(1);
}

const SERVER_INFO = { name: "nexavoz-mcp", version: "1.0.0" };

// ---------- Supabase (PostgREST) ----------
function checkTable(table) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table || "")) throw new Error("Nombre de tabla inválido");
  if (ALLOWED_TABLES.length && !ALLOWED_TABLES.includes(table)) throw new Error("Tabla no permitida");
}

async function supabase(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

// ---------- Herramientas ----------
const TOOLS = [
  {
    name: "select_rows",
    description: "Consulta filas de una tabla de Supabase. Los filtros son igualdades (columna = valor).",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Nombre de la tabla" },
        columns: { type: "string", description: "Columnas separadas por coma. Por defecto *" },
        filters: { type: "object", description: "Ejemplo: {\"estado\": \"activo\"}" },
        limit: { type: "integer", description: "Máximo de filas (por defecto 20, máx. 200)" },
      },
      required: ["table"],
    },
  },
  {
    name: "insert_row",
    description: "Inserta una fila en una tabla de Supabase.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Nombre de la tabla" },
        row: { type: "object", description: "Datos de la fila a insertar" },
      },
      required: ["table", "row"],
    },
  },
];

async function callTool(name, args = {}) {
  if (name === "select_rows") {
    checkTable(args.table);
    const params = new URLSearchParams();
    params.set("select", args.columns || "*");
    params.set("limit", String(Math.min(Number(args.limit) || 20, 200)));
    for (const [k, v] of Object.entries(args.filters || {})) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) throw new Error("Columna inválida: " + k);
      params.set(k, `eq.${v}`);
    }
    return await supabase(`${args.table}?${params}`);
  }
  if (name === "insert_row") {
    checkTable(args.table);
    if (!args.row || typeof args.row !== "object") throw new Error("Falta 'row'");
    return await supabase(args.table, { method: "POST", body: JSON.stringify(args.row) });
  }
  throw new Error("Herramienta desconocida: " + name);
}

// ---------- JSON-RPC / MCP ----------
async function handleRpc(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: (params && params.protocolVersion) || "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        try {
          const data = await callTool(params.name, params.arguments);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] } };
        } catch (err) {
          return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(err.message || err) }] } };
        }
      }
      default:
        if (isNotification) return null; // p. ej. notifications/initialized
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Método no encontrado: " + method } };
    }
  } catch (err) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: String(err.message || err) } };
  }
}

// ---------- HTTP ----------
function send(res, status, body, extra = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    ...extra,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) { reject(new Error("Body demasiado grande")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function authorized(req, url) {
  const header = req.headers["authorization"] || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const queryToken = url.searchParams.get("token") || "";
  return bearer === MCP_TOKEN || queryToken === MCP_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  console.log(`${req.method} ${url.pathname}`);

  if (req.method === "OPTIONS") return send(res, 204);

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    return send(res, 200, { status: "ok", server: SERVER_INFO.name });
  }

  if (url.pathname !== "/mcp") return send(res, 404, { error: "No encontrado" });

  if (!authorized(req, url)) return send(res, 401, { error: "No autorizado" });

  if (req.method === "GET") return send(res, 405, { error: "Usa POST" }, { Allow: "POST" });
  if (req.method === "DELETE") return send(res, 200, {});
  if (req.method !== "POST") return send(res, 405, { error: "Método no permitido" });

  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } });
  }

  if (Array.isArray(parsed)) {
    const results = (await Promise.all(parsed.map(handleRpc))).filter(Boolean);
    return results.length ? send(res, 200, results) : send(res, 202);
  }

  const result = await handleRpc(parsed);
  return result ? send(res, 200, result) : send(res, 202);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Nexavoz MCP escuchando en :${PORT}`);
});
