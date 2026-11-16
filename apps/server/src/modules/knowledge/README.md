# Knowledge source runtime

The production bootstrap supplies the one platform PostgreSQL pool, Blob endpoint, Document Intelligence endpoint and budgeted LLM gateway. Knowledge stores source versions, confirmations, ACLs, references and durable parse/analysis jobs in PostgreSQL. Migration 0002 must run before traffic switches. Both web and worker use the same store; the worker owns one leased start/poll step per tick. Unknown billable outcomes stay held for reconciliation. There is no direct-provider model fallback.

Source files use the private `sources` Blob container. Text imports retain original line offsets. Local documents sent to Azure persist the operation reference and respect RetryAfter. The knowledge page submits each selected file to `POST /local-materials`, which creates or reuses the uploader's private local source and publishes that version when readable content is available. External imports continue to require version confirmation. Preview, retrieval, history-derived recommendations and live database results all enforce source access; owner/admin roles do not override it.

## Database sources

The operator sets `SOURCE_DATABASES_JSON` on web and worker with approved source endpoints and scope. Configure DBA-owned row-filtered views and a separate SELECT-only account. This is independent of the model API key. The source account must have no CREATE/write privileges and no reads of unapproved public relations. Query execution pins `pg_catalog, public, pg_temp`, uses READ ONLY, a five-second statement limit and approved column/masking rules.

Example shape (all values are placeholders):

```json
[{"id":"finance","name":"Approved finance views","host":"source.example.invalid","database":"source","user":"read-only-principal","projectIds":["finance"],"scope":{"audience":["entra-object-id"],"maxRows":50,"tables":{"approved_invoices":{"columns":["id","status","contact_email"],"sensitive":["contact_email"]}}}}]
```

The default authentication uses the deployment managed identity's PostgreSQL audience token. If the source needs a password, provision it separately in Key Vault and add `"secret":{"name":"db-source-finance","version":"specific-version"}`. Passwords, model-key references and connection strings are refused in this configuration. TLS certificate validation is always enabled. The source pool is separate from the platform write pool and closes on shutdown.

In Manage sources, configure the database by selecting an approved resource, acknowledging independent read-only access, and verifying the connection. Sync structure and approve SELECT templates separately from running them by ID. Schema/view-definition or scope changes invalidate a template and require reapproval. Returned rows carry query time and an opaque, scope/template-bound data revision. The freshness endpoint rechecks current permission, schema and source revision; missing or unstable signals expire the result. PostgreSQL snapshots conservatively expire on unrelated transactions. Rows are never added as policy knowledge. No resources are simulated when configuration is absent.

## Validation scope

Unit/service tests use labeled fixtures. CI exercises native PostgreSQL including an isolated source database, a SELECT-only role, a filtered view, hostile session search_path, masking, binding and privilege changes. Chromium tests call real HTTP handlers with explicit test storage/model. Live Azure Document Intelligence/Blob/Entra deployment validation requires configured cloud resources and is separate from these tests.

## Source lifecycle and confirmation

Source connectors are built in. The legacy `POST /plugins/:id/install` endpoint is idempotent for existing clients. Pause and resume control source access. Remote connection creation requires literal `readOnlyAcknowledged: true`; raw credential references and write effects are refused. Database requests select only `scope.resourceId`, with tables, columns, row bounds and projects derived from the operator registry.

`KNOWLEDGE_SOURCES_JSON` defines approved mail/SharePoint metadata scopes, audiences and project grants, using managed identity for Graph. `GET /connections/:id/preview` reads metadata after per-item ACL checks and exposes opaque version-bound selection IDs; denied titles/bodies remain hidden. `POST /connections/:id/import {ids}` rechecks those permissions and persists the selected external IDs. Every sync filters the same selection and checks the current actor ACL before any body read. Imported versions remain unconfirmed. Revocation/deletion clears retrievable chunks and confirmation; same-version recovery rereads content and requires confirmation again. Folder hierarchy changes force a bounded full SharePoint reconciliation so omitted descendants lose old references.

### Import from an external MCP server

For a public Streamable HTTP server, enter its HTTPS endpoint in **Manage sources → MCP** and verify it. The connection is private to the configuring user, who can then select resources to import.

For a centrally approved server, add a resource to `KNOWLEDGE_SOURCES_JSON` with `pluginId: "mcp"`, its approved audience and projects, and a scope such as:

```json
{
  "id": "policy-mcp",
  "name": "Policy library",
  "pluginId": "mcp",
  "audience": ["approved-user-id"],
  "projectIds": ["approved-project-id"],
  "scope": {
    "endpoint": "https://mcp.example.com/mcp",
    "resources": [{ "uri": "policy://onboarding", "title": "Onboarding policy" }]
  }
}
```

For a bearer-authenticated server, set `scope.secret` to the Key Vault secret reference `{ "name": "...", "version": "..." }`. The connector accesses the configured endpoint via Streamable HTTP and reads exact, approved text resource URIs. In **Manage sources**, connect the approved MCP resource and select the entries to import. A subsequent import refreshes the selected snapshots; changed content needs confirmation. Endpoint or URI scope changes suspend the old connection and require a new one.

Remote production connectors currently support mail bodies and text files. Non-text remote documents require durable parse-job integration; use the local binary upload queue for PDF/Office/image files. The synchronous parser bridge is deliberately not wired into remote production sync because it does not persist uncertain billable submissions.

`PUT /space {name}` updates only the logical namespace label. `POST /manual-roles {name,description}` creates an explicitly manual, human-locked role with no document evidence and does not unlock analysis. Inferred roles still require confirmed evidence. Human-locked metadata remains visible as stale after a permitted source version changes; old quotes are withheld and edits/adoption require valid current evidence.

The 51 original T-40 assertion IDs are real browser cases in `apps/e2e/tests/knowledge.spec.ts`. Explicit synthetic external drivers are documented in `docs/e2e/KNOWLEDGE-COVERAGE.md`; no live cloud access is claimed.

## Read confirmed knowledge over MCP

Configure a native or server-side MCP client with **Streamable HTTP** and the URL
`https://<super-agent-host>/api/v1/knowledge/mcp`. Set the request header to
`Authorization: Bearer <Entra access token>`. Obtain an access token from the deployment's
Entra tenant for the Super Agent API, using the delegated scope
`api://<ENTRA_CLIENT_ID>/access_as_user`. The client must be able to supply and refresh its
token. This endpoint uses the existing API authentication and does not provide an MCP OAuth
discovery or interactive sign-in flow. Browser cross-origin requests are refused.

- `search_knowledge` takes `query` and returns excerpts, source IDs, version IDs, and citations.
- `read_knowledge` takes `sourceId` and `version` from a search result and returns positioned
  text chunks. The `truncated` flag signals the existing 200,000-character preview limit.

Both tools require a confirmed current version and enforce the caller's tenant, project, and
source permissions. Connected sources must pass a current permission check. The server
exposes no mutation tools.
