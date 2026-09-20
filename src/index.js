const SERVER_INFO = { name: "gmail-api", version: "1.4.3" };
const PROTOCOL_VERSION = "2024-11-05";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const KV_KEY = "gmail_oauth_tokens";
const SCOPES = "https://mail.google.com/ https://www.googleapis.com/auth/gmail.settings.basic";

async function getTokens(env) {
  const raw = await env.GMAIL_TOKENS.get(KV_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function saveTokens(env, tokens) {
  const previous = await getTokens(env);
  await env.GMAIL_TOKENS.put(KV_KEY, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || previous?.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 - 60000,
  }));
}

async function getAccessToken(env) {
  const tokens = await getTokens(env);
  if (!tokens) throw new Error("Not authorized. Visit /auth to connect Gmail.");
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error("No refresh token. Visit /auth to authorize.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!response.ok) throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  const fresh = await response.json();
  await saveTokens(env, fresh);
  return fresh.access_token;
}

async function gmail(env, method, path, body) {
  const token = await getAccessToken(env);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${GMAIL_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) return { _error: true, status: response.status, body: text };
  try { return JSON.parse(text); } catch { return text; }
}

function result(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function schema(properties, required = []) {
  return { type: "object", properties, required };
}

const ids = { type: "array", items: { type: "string" } };
const TOOLS = [
  { name: "nuke_filters", description: "Delete up to 200 Gmail filters per call. Call repeatedly until remaining is 0. Does not delete email or labels. Use only after explicit user confirmation.", inputSchema: schema({}) },
  { name: "message_spam", description: "Move messages to spam.", inputSchema: schema({ messageIds: ids }, ["messageIds"]) },
  { name: "message_unspam", description: "Remove messages from spam.", inputSchema: schema({ messageIds: ids }, ["messageIds"]) },
  { name: "message_trash", description: "Move messages to trash.", inputSchema: schema({ messageIds: ids }, ["messageIds"]) },
  { name: "message_untrash", description: "Remove messages from trash.", inputSchema: schema({ messageIds: ids }, ["messageIds"]) },
  { name: "bulk_archive", description: "Archive messages.", inputSchema: schema({ messageIds: ids }, ["messageIds"]) },
  { name: "bulk_modify", description: "Modify labels on messages.", inputSchema: schema({ messageIds: ids, addLabelIds: ids, removeLabelIds: ids }, ["messageIds"]) },
  { name: "search", description: "Search Gmail with Gmail query syntax.", inputSchema: schema({ query: { type: "string" }, maxResults: { type: "number" }, pageToken: { type: "string" } }, ["query"]) },
  { name: "labels_list", description: "List Gmail labels.", inputSchema: schema({}) },
  { name: "label_create", description: "Create a Gmail label.", inputSchema: schema({ name: { type: "string" } }, ["name"]) },
  { name: "label_delete", description: "Delete a Gmail label.", inputSchema: schema({ labelId: { type: "string" } }, ["labelId"]) },
  { name: "label_update", description: "Rename a Gmail label.", inputSchema: schema({ labelId: { type: "string" }, name: { type: "string" } }, ["labelId", "name"]) },
  { name: "filter_list", description: "List Gmail filters.", inputSchema: schema({}) },
  { name: "filter_create", description: "Create a Gmail filter.", inputSchema: schema({ from: { type: "string" }, to: { type: "string" }, subject: { type: "string" }, query: { type: "string" }, negatedQuery: { type: "string" }, hasAttachment: { type: "boolean" }, addLabelIds: ids, removeLabelIds: ids, forward: { type: "string" } }) },
  { name: "filter_delete", description: "Delete a Gmail filter.", inputSchema: schema({ filterId: { type: "string" } }, ["filterId"]) },
  { name: "thread_modify", description: "Modify labels on a thread.", inputSchema: schema({ threadId: { type: "string" }, addLabelIds: ids, removeLabelIds: ids }, ["threadId"]) },
  { name: "thread_trash", description: "Trash a thread.", inputSchema: schema({ threadId: { type: "string" } }, ["threadId"]) },
  { name: "thread_untrash", description: "Untrash a thread.", inputSchema: schema({ threadId: { type: "string" } }, ["threadId"]) },
];

const NUKE_BATCH = 200;

async function nukeFilters(env) {
  const token = await getAccessToken(env);
  const base = `${GMAIL_BASE}/settings/filters`;
  const listed = await fetch(base, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!listed.ok) return { error: `Failed to list filters: ${await listed.text()}` };
  const allFilters = (await listed.json()).filter || [];
  const total = allFilters.length;
  if (total === 0) return { deleted: 0, errors: 0, total: 0, remaining: 0, message: "No filters to delete." };
  const batch = allFilters.slice(0, NUKE_BATCH);
  let deleted = 0;
  let errors = 0;
  for (let i = 0; i < batch.length; i += 20) {
    const chunk = batch.slice(i, i + 20);
    const responses = await Promise.allSettled(chunk.map((filter) => fetch(`${base}/${filter.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })));
    for (const response of responses) {
      if (response.status === "fulfilled" && response.value.ok) deleted++;
      else errors++;
    }
  }
  const remaining = total - deleted;
  return { deleted, errors, total, remaining, message: `Deleted ${deleted} of ${total}. ${remaining} remaining.` };
}

async function handleTool(env, name, args = {}) {
  switch (name) {
    case "nuke_filters": return result(await nukeFilters(env));
    case "message_spam": return result(await gmail(env, "POST", "/messages/batchModify", { ids: args.messageIds, addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] }));
    case "message_unspam": return result(await gmail(env, "POST", "/messages/batchModify", { ids: args.messageIds, addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }));
    case "message_trash": return result(await batchMessages(env, args.messageIds, "trash"));
    case "message_untrash": return result(await batchMessages(env, args.messageIds, "untrash"));
    case "bulk_archive": return result(await gmail(env, "POST", "/messages/batchModify", { ids: args.messageIds, removeLabelIds: ["INBOX"] }));
    case "bulk_modify": return result(await gmail(env, "POST", "/messages/batchModify", { ids: args.messageIds, addLabelIds: args.addLabelIds || [], removeLabelIds: args.removeLabelIds || [] }));
    case "search": {
      const max = Math.min(args.maxResults || 20, 500);
      let path = `/messages?q=${encodeURIComponent(args.query)}&maxResults=${max}`;
      if (args.pageToken) path += `&pageToken=${encodeURIComponent(args.pageToken)}`;
      return result(await gmail(env, "GET", path));
    }
    case "labels_list": return result(await gmail(env, "GET", "/labels"));
    case "label_create": return result(await gmail(env, "POST", "/labels", { name: args.name, labelListVisibility: "labelShow", messageListVisibility: "show" }));
    case "label_delete": return result(await gmail(env, "DELETE", `/labels/${args.labelId}`));
    case "label_update": return result(await gmail(env, "PATCH", `/labels/${args.labelId}`, { name: args.name }));
    case "filter_list": {
      const data = await gmail(env, "GET", "/settings/filters");
      if (data._error) return result(data);
      return result({ count: (data.filter || []).length, filters: (data.filter || []).map((f) => ({ id: f.id, criteria: f.criteria, actions: f.action })) });
    }
    case "filter_create": {
      const criteria = {};
      for (const key of ["from", "to", "subject", "query", "negatedQuery", "hasAttachment"]) if (args[key] !== undefined) criteria[key] = args[key];
      const action = {};
      for (const key of ["addLabelIds", "removeLabelIds", "forward"]) if (args[key] !== undefined) action[key] = args[key];
      return result(await gmail(env, "POST", "/settings/filters", { criteria, action }));
    }
    case "filter_delete": return result(await gmail(env, "DELETE", `/settings/filters/${args.filterId}`));
    case "thread_modify": return result(await gmail(env, "POST", `/threads/${args.threadId}/modify`, { addLabelIds: args.addLabelIds || [], removeLabelIds: args.removeLabelIds || [] }));
    case "thread_trash": return result(await gmail(env, "POST", `/threads/${args.threadId}/trash`));
    case "thread_untrash": return result(await gmail(env, "POST", `/threads/${args.threadId}/untrash`));
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function batchMessages(env, messageIds, action) {
  const results = [];
  for (const id of messageIds || []) results.push(await gmail(env, "POST", `/messages/${id}/${action}`));
  return { action, count: (messageIds || []).length, results };
}

function rpcResponse(id, resultValue) { return { jsonrpc: "2.0", id, result: resultValue }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleRpc(env, request) {
  const { id, method, params } = request;
  switch (method) {
    case "initialize": return rpcResponse(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    case "notifications/initialized":
    case "notifications/cancelled": return null;
    case "ping": return rpcResponse(id, {});
    case "tools/list": return rpcResponse(id, { tools: TOOLS });
    case "tools/call":
      try { return rpcResponse(id, await handleTool(env, params?.name, params?.arguments)); }
      catch (error) { return rpcResponse(id, { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }); }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function authResponse(env, url) {
  const redirectUri = `${url.origin}/callback`;
  const target = `${AUTH_URL}?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&access_type=offline&prompt=consent`;
  return Response.redirect(target, 302);
}

async function callbackResponse(env, url) {
  const code = url.searchParams.get("code");
  if (!code) return new Response("Missing authorization code", { status: 400 });
  const redirectUri = `${url.origin}/callback`;
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }) });
  if (!response.ok) return new Response(`Token exchange failed: ${await response.text()}`, { status: 500 });
  await saveTokens(env, await response.json());
  return new Response("<h1>Connected to Gmail</h1><p>You can close this window.</p>", { headers: { "Content-Type": "text/html" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const tokens = await getTokens(env);
      return Response.json({ status: "ok", tools: TOOLS.length, gmail_connected: !!tokens?.refresh_token });
    }
    if (url.pathname === "/auth") return authResponse(env, url);
    if (url.pathname === "/callback") return callbackResponse(env, url);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id" } });
    if (env.MCP_AUTH_TOKEN && request.headers.get("Authorization") !== `Bearer ${env.MCP_AUTH_TOKEN}`) return new Response("Unauthorized", { status: 401 });
    if (!url.pathname.startsWith("/mcp")) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body;
    try { body = await request.json(); } catch { return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 }); }
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
    if (Array.isArray(body)) {
      const responses = [];
      for (const item of body) { const response = await handleRpc(env, item); if (response !== null) responses.push(response); }
      return responses.length ? Response.json(responses, { headers }) : new Response(null, { status: 202, headers });
    }
    const response = await handleRpc(env, body);
    return response === null ? new Response(null, { status: 202, headers }) : Response.json(response, { headers });
  },
};