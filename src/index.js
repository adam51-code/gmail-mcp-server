// Gmail MCP Server — Zero dependencies
// OAuth 2.0 with auto-refresh, tokens stored in Cloudflare KV

const SERVER_INFO = { name: "gmail-api", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const KV_KEY = "gmail_oauth_tokens";
const SCOPES = "https://mail.google.com/";

// ── OAuth helpers ────────────────────────────────────────────────────

async function getTokens(env) {
  const raw = await env.GMAIL_TOKENS.get(KV_KEY);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveTokens(env, tokens) {
  await env.GMAIL_TOKENS.put(KV_KEY, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || (await getTokens(env))?.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 - 60000,
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

// ── Gmail API caller ─────────────────────────────────────────────

async function gmailFetch(env, method, path, body) {
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

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: "message_spam",
    description: "Move one or more messages to spam. Removes them from the inbox and adds the SPAM label.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to move to spam.",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "message_unspam",
    description: "Remove one or more messages from spam and move them back to the inbox.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to remove from spam.",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "message_trash",
    description: "Move one or more messages to trash.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to trash.",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "message_untrash",
    description: "Remove one or more messages from trash and move them back to the inbox.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to untrash.",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "bulk_archive",
    description: "Archive multiple messages at once by removing the INBOX label. Much faster than archiving one at a time.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to archive.",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "bulk_modify",
    description: "Add and/or remove labels from multiple messages in a single call. Use for bulk labeling, bulk archive, or any batch label operation.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Gmail message IDs to modify.",
        },
        addLabelIds: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to add (e.g. INBOX, UNREAD, STARRED, SPAM, TRASH, or custom label IDs).",
        },
        removeLabelIds: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to remove.",
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "search",
    description: "Search Gmail using native Gmail query syntax (same as the Gmail search bar). Returns message IDs and snippets. Supports operators like from:, to:, subject:, has:attachment, after:, before:, label:, is:unread, etc.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query (e.g. 'from:upwork.com is:unread')" },
        maxResults: { type: "number", description: "Max results to return (default 20, max 500)" },
        pageToken: { type: "string", description: "Pagination token from a previous search result" },
      },
      required: ["query"],
    },
  },
  {
    name: "labels_list",
    description: "List all Gmail labels (system and custom). Returns label ID, name, and message counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "label_create",
    description: "Create a new Gmail label.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the new label. Use '/' for nesting (e.g. 'Clients/Active')." },
      },
      required: ["name"],
    },
  },
  {
    name: "label_delete",
    description: "Delete a Gmail label by its ID. Does not delete the messages, just removes the label.",
    inputSchema: {
      type: "object",
      properties: {
        labelId: { type: "string", description: "Gmail label ID to delete." },
      },
      required: ["labelId"],
    },
  },
  {
    name: "label_update",
    description: "Rename a Gmail label.",
    inputSchema: {
      type: "object",
      properties: {
        labelId: { type: "string", description: "Gmail label ID to update." },
        name: { type: "string", description: "New name for the label." },
      },
      required: ["labelId", "name"],
    },
  },
  {
    name: "thread_modify",
    description: "Add or remove labels from an entire thread (all messages in the conversation).",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Gmail thread ID." },
        addLabelIds: { type: "array", items: { type: "string" }, description: "Label IDs to add." },
        removeLabelIds: { type: "array", items: { type: "string" }, description: "Label IDs to remove." },
      },
      required: ["threadId"],
    },
  },
  {
    name: "thread_trash",
    description: "Move an entire thread to trash.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Gmail thread ID to trash." },
      },
      required: ["threadId"],
    },
  },
  {
    name: "thread_untrash",
    description: "Remove an entire thread from trash.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Gmail thread ID to untrash." },
      },
      required: ["threadId"],
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────

async function handleTool(env, name, args) {
  const a = args || {};

  switch (name) {
    case "message_spam":
      return toolResult(await gmailFetch(env, "POST", "/messages/batchModify", {
        ids: a.messageIds,
        addLabelIds: ["SPAM"],
        removeLabelIds: ["INBOX"],
      }));

    case "message_unspam":
      return toolResult(await gmailFetch(env, "POST", "/messages/batchModify", {
        ids: a.messageIds,
        addLabelIds: ["INBOX"],
        removeLabelIds: ["SPAM"],
      }));

    case "message_trash": {
      const results = [];
      for (const id of a.messageIds) {
        results.push(await gmailFetch(env, "POST", `/messages/${id}/trash`));
      }
      return toolResult({ trashed: a.messageIds.length, results });
    }

    case "message_untrash": {
      const results = [];
      for (const id of a.messageIds) {
        results.push(await gmailFetch(env, "POST", `/messages/${id}/untrash`));
      }
      return toolResult({ untrashed: a.messageIds.length, results });
    }

    case "bulk_archive":
      return toolResult(await gmailFetch(env, "POST", "/messages/batchModify", {
        ids: a.messageIds,
        removeLabelIds: ["INBOX"],
      }));

    case "bulk_modify":
      return toolResult(await gmailFetch(env, "POST", "/messages/batchModify", {
        ids: a.messageIds,
        addLabelIds: a.addLabelIds || [],
        removeLabelIds: a.removeLabelIds || [],
      }));

    case "search": {
      const max = Math.min(a.maxResults || 20, 500);
      let path = `/messages?q=${encodeURIComponent(a.query)}&maxResults=${max}`;
      if (a.pageToken) path += `&pageToken=${encodeURIComponent(a.pageToken)}`;

      const list = await gmailFetch(env, "GET", path);
      if (list._error) return toolResult(list);

      // Fetch snippet + labels for each message
      const messages = list.messages || [];
      const detailed = [];
      for (const msg of messages.slice(0, 25)) {
        const detail = await gmailFetch(env, "GET",
          `/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
        );
        if (!detail._error) {
          const headers = {};
          for (const h of detail.payload?.headers || []) {
            headers[h.name.toLowerCase()] = h.value;
          }
          detailed.push({
            id: detail.id,
            threadId: detail.threadId,
            snippet: detail.snippet,
            from: headers.from,
            subject: headers.subject,
            date: headers.date,
            labelIds: detail.labelIds,
          });
        }
      }

      return toolResult({
        resultSizeEstimate: list.resultSizeEstimate,
        nextPageToken: list.nextPageToken || null,
        messages: detailed,
      });
    }

    case "labels_list":
      return toolResult(await gmailFetch(env, "GET", "/labels"));

    case "label_create":
      return toolResult(await gmailFetch(env, "POST", "/labels", {
        name: a.name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }));

    case "label_delete":
      return toolResult(await gmailFetch(env, "DELETE", `/labels/${a.labelId}`));

    case "label_update":
      return toolResult(await gmailFetch(env, "PATCH", `/labels/${a.labelId}`, {
        name: a.name,
      }));

    case "thread_modify":
      return toolResult(await gmailFetch(env, "POST", `/threads/${a.threadId}/modify`, {
        addLabelIds: a.addLabelIds || [],
        removeLabelIds: a.removeLabelIds || [],
      }));

    case "thread_trash":
      return toolResult(await gmailFetch(env, "POST", `/threads/${a.threadId}/trash`));

    case "thread_untrash":
      return toolResult(await gmailFetch(env, "POST", `/threads/${a.threadId}/untrash`));

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Protocol ─────────────────────────────────────────────────────

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

// ── OAuth flow endpoints ─────────────────────────────────────────────

function handleAuth(env, url) {
  const redirectUri = `${url.origin}/callback`;
  const authUrl = `${AUTH_URL}?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&access_type=offline&prompt=consent`;
  return Response.redirect(authUrl, 302);
}

async function handleCallback(env, url) {
  const code = url.searchParams.get("code");
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

  return new Response(
    `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h1>Connected to Gmail!</h1>
      <p>Brain now has full Gmail access. You can close this window.</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

// ── Worker entry ─────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const tokens = await getTokens(env);
      return Response.json({
        status: "ok",
        tools: TOOLS.length,
        gmail_connected: !!tokens?.refresh_token,
      });
    }

    if (url.pathname === "/auth") {
      return handleAuth(env, url);
    }

    if (url.pathname === "/callback") {
      return await handleCallback(env, url);
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
