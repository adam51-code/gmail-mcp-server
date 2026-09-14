// Gmail MCP Server — Zero dependencies
// OAuth 2.0 with auto-refresh, tokens stored in Cloudflare KV
// Scope: gmail.modify (archive, star, label, mark read/unread, trash)

const SERVER_INFO = { name: "gmail-api", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const KV_KEY = "gmail_oauth_tokens";
const SCOPES = "https://www.googleapis.com/auth/gmail.modify";

// ── OAuth helpers ────────────────────────────────────────────────────────────────

async function getTokens(env) {
  const raw = await env.GMAIL_TOKENS.get(KV_KEY);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveTokens(env, tokens) {
  const prev = await getTokens(env);
  await env.GMAIL_TOKENS.put(KV_KEY, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || prev?.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 - 60000,
    email: tokens.email || prev?.email,
  }));
}

async function refreshAccessToken(env) {
  const tokens = await getTokens(env);
  if (!tokens?.refresh_token) throw new Error("No refresh token. Visit /auth to authorize.");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  await saveTokens(env, data);
  return data.access_token;
}

async function getAccessToken(env) {
  const tokens = await getTokens(env);
  if (!tokens) throw new Error("Not authorized. Visit /auth to connect Gmail.");
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  return await refreshAccessToken(env);
}

// ── Gmail API caller ─────────────────────────────────────────────────────────────

async function callGmail(env, method, path, body) {
  const token = await getAccessToken(env);
  const url = `${GMAIL_BASE}${path}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) return { _error: true, status: res.status, body: text };
  if (!text) return { success: true };
  try { return JSON.parse(text); } catch { return text; }
}

function toolResult(data) {
  return {
    content: [{
      type: "text",
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    }],
  };
}

// ── Label resolution helper ──────────────────────────────────────────────────────

async function resolveLabelId(env, labelName) {
  const result = await callGmail(env, "GET", "/labels");
  if (result._error) throw new Error(`Failed to list labels: ${result.body}`);
  const label = result.labels.find(
    l => l.name.toLowerCase() === labelName.toLowerCase() || l.id.toLowerCase() === labelName.toLowerCase()
  );
  if (!label) throw new Error(`Label not found: "${labelName}". Use list_labels to see available labels.`);
  return label.id;
}

// ── Tool definitions ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "archive",
    description: "Archive one or more messages by removing the INBOX label. Messages remain in All Mail.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to archive (max 100)",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "unarchive",
    description: "Move messages back to the inbox by adding the INBOX label.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to move back to inbox (max 100)",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "star",
    description: "Star one or more messages.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to star (max 100)",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "unstar",
    description: "Remove star from one or more messages.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to unstar (max 100)",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "mark_read",
    description: "Mark one or more messages as read.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to mark as read (max 100)",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "mark_unread",
    description: "Mark one or more messages as unread.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to mark as unread (max 100)",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "add_label",
    description: "Add a label to one or more messages. Use list_labels to see available labels.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs (max 100)",
        },
        label: {
          type: "string",
          description: "Label name or ID to add",
        },
      },
      required: ["messageIds", "label"],
    },
  },
  {
    name: "remove_label",
    description: "Remove a label from one or more messages. Use list_labels to see available labels.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs (max 100)",
        },
        label: {
          type: "string",
          description: "Label name or ID to remove",
        },
      },
      required: ["messageIds", "label"],
    },
  },
  {
    name: "trash",
    description: "Move one or more messages to trash.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to trash",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "untrash",
    description: "Remove one or more messages from trash.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to untrash",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "list_labels",
    description: "List all Gmail labels (system and custom) with their IDs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mark_important",
    description: "Mark one or more messages as important.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to mark important (max 100)",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "mark_not_important",
    description: "Remove the important marker from one or more messages.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs (max 100)",
        },
      },
      required: ["messageIds"],
    },
  },
];

// ── Batch modify helper ──────────────────────────────────────────────────────────

async function batchModify(env, messageIds, addLabelIds, removeLabelIds) {
  if (messageIds.length === 1) {
    const body = {};
    if (addLabelIds?.length) body.addLabelIds = addLabelIds;
    if (removeLabelIds?.length) body.removeLabelIds = removeLabelIds;
    return await callGmail(env, "POST", `/messages/${messageIds[0]}/modify`, body);
  }
  const body = { ids: messageIds };
  if (addLabelIds?.length) body.addLabelIds = addLabelIds;
  if (removeLabelIds?.length) body.removeLabelIds = removeLabelIds;
  return await callGmail(env, "POST", "/messages/batchModify", body);
}

// ── Tool handlers ────────────────────────────────────────────────────────────────

async function handleTool(env, name, args) {
  const a = args || {};

  switch (name) {
    case "archive":
      return toolResult(await batchModify(env, a.messageIds, null, ["INBOX"]));

    case "unarchive":
      return toolResult(await batchModify(env, a.messageIds, ["INBOX"], null));

    case "star":
      return toolResult(await batchModify(env, a.messageIds, ["STARRED"], null));

    case "unstar":
      return toolResult(await batchModify(env, a.messageIds, null, ["STARRED"]));

    case "mark_read":
      return toolResult(await batchModify(env, a.messageIds, null, ["UNREAD"]));

    case "mark_unread":
      return toolResult(await batchModify(env, a.messageIds, ["UNREAD"], null));

    case "mark_important":
      return toolResult(await batchModify(env, a.messageIds, ["IMPORTANT"], null));

    case "mark_not_important":
      return toolResult(await batchModify(env, a.messageIds, null, ["IMPORTANT"]));

    case "add_label": {
      const labelId = await resolveLabelId(env, a.label);
      return toolResult(await batchModify(env, a.messageIds, [labelId], null));
    }

    case "remove_label": {
      const labelId = await resolveLabelId(env, a.label);
      return toolResult(await batchModify(env, a.messageIds, null, [labelId]));
    }

    case "trash": {
      const results = [];
      for (const id of a.messageIds) {
        results.push(await callGmail(env, "POST", `/messages/${id}/trash`));
      }
      return toolResult(results.length === 1 ? results[0] : { trashed: results.length, results });
    }

    case "untrash": {
      const results = [];
      for (const id of a.messageIds) {
        results.push(await callGmail(env, "POST", `/messages/${id}/untrash`));
      }
      return toolResult(results.length === 1 ? results[0] : { untrashed: results.length, results });
    }

    case "list_labels": {
      const result = await callGmail(env, "GET", "/labels");
      if (result._error) return toolResult(result);
      const labels = result.labels.map(l => ({
        id: l.id,
        name: l.name,
        type: l.type,
        messagesTotal: l.messagesTotal,
        messagesUnread: l.messagesUnread,
      }));
      labels.sort((a, b) => a.name.localeCompare(b.name));
      return toolResult(labels);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Protocol ─────────────────────────────────────────────────────────────────

function jsonrpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(env, req) {
  const { method, params, id } = req;

  switch (method) {
    case "initialize":
      return jsonrpc(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return jsonrpc(id, {});

    case "tools/list":
      return jsonrpc(id, { tools: TOOLS });

    case "tools/call": {
      const { name, arguments: toolArgs } = params || {};
      try {
        const result = await handleTool(env, name, toolArgs);
        return jsonrpc(id, result);
      } catch (err) {
        return jsonrpc(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── OAuth flow endpoints ───────────────────────────────────────────────────────

function handleAuth(env, url) {
  const redirectUri = `${url.origin}/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  return Response.redirect(`${AUTH_URL}?${params}`, 302);
}

async function handleCallback(env, url) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  const redirectUri = `${url.origin}/callback`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return new Response(`Token exchange failed: ${err}`, { status: 500 });
  }

  const tokens = await res.json();
  await saveTokens(env, tokens);

  // Fetch the user's email for display
  let email = "unknown";
  try {
    const profile = await fetch(`${GMAIL_BASE}/profile`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (profile.ok) {
      const p = await profile.json();
      email = p.emailAddress;
      const current = await getTokens(env);
      current.email = email;
      await env.GMAIL_TOKENS.put(KV_KEY, JSON.stringify(current));
    }
  } catch {}

  return new Response(
    `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h1>Connected to Gmail!</h1>
      <p>Account: ${email}</p>
      <p>Scope: gmail.modify (archive, star, label, read/unread, trash)</p>
      <p>You can close this window. Brain now has Gmail modify access.</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

// ── Worker entry ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const tokens = await getTokens(env);
      return Response.json({
        status: "ok",
        tools: TOOLS.length,
        gmail_connected: !!tokens?.refresh_token,
        email: tokens?.email || null,
      });
    }

    if (url.pathname === "/auth") {
      return handleAuth(env, url);
    }

    if (url.pathname === "/callback") {
      return await handleCallback(env, url);
    }

    if (url.pathname === "/status") {
      if (env.MCP_AUTH_TOKEN) {
        const auth = request.headers.get("Authorization");
        if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      const tokens = await getTokens(env);
      return Response.json({
        connected: !!tokens?.refresh_token,
        email: tokens?.email,
        token_expires_at: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : null,
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
        },
      });
    }

    if (env.MCP_AUTH_TOKEN) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    if (!url.pathname.startsWith("/mcp")) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      return new Response("Use POST for MCP requests", { status: 405 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json(jsonrpcError(null, -32700, "Parse error"), { status: 400 });
    }

    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    if (Array.isArray(body)) {
      const results = [];
      for (const req of body) {
        const res = await handleRpc(env, req);
        if (res !== null) results.push(res);
      }
      if (results.length === 0) return new Response(null, { status: 202, headers });
      return Response.json(results, { headers });
    }

    const result = await handleRpc(env, body);
    if (result === null) return new Response(null, { status: 202, headers });
    return Response.json(result, { headers });
  },
};
