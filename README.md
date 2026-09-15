# Gmail MCP Server

Custom Gmail MCP server for ClickUp Brain. Zero dependencies, deployed on Cloudflare Workers.

## Tools (14)

| Tool | Description |
|------|-------------|
| message_spam | Move messages to spam |
| message_unspam | Remove from spam |
| message_trash | Move messages to trash |
| message_untrash | Remove from trash |
| bulk_archive | Archive multiple messages at once |
| bulk_modify | Batch add/remove labels |
| search | Native Gmail query syntax search |
| labels_list | List all labels |
| label_create | Create a label |
| label_delete | Delete a label |
| label_update | Rename a label |
| thread_modify | Modify labels on entire thread |
| thread_trash | Trash entire thread |
| thread_untrash | Untrash entire thread |

## Setup

1. Create a Google Cloud project with Gmail API enabled
2. Create OAuth 2.0 credentials (Web application type)
3. Add redirect URI: `https://gmail-mcp-server.adam-efc.workers.dev/callback`
4. Create KV namespace: `npx wrangler kv namespace create GMAIL_TOKENS`
5. Update `wrangler.toml` with the KV namespace ID
6. Set secrets:
   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put MCP_AUTH_TOKEN
   ```
7. Deploy: `npx wrangler deploy`
8. Authorize: visit `https://gmail-mcp-server.adam-efc.workers.dev/auth`
9. Connect in ClickUp App Center as custom MCP
