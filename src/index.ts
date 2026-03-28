import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ConnectionContext } from "partyserver";

// ---------------------------------------------------------------------------
// Env type — matches wrangler.jsonc bindings
// Run `npx wrangler types` to regenerate after binding changes.
// ---------------------------------------------------------------------------

export interface Env {
  MCP_AGENT: DurableObjectNamespace;
  DB: D1Database;
  API: Fetcher;
  AGENTS: Fetcher;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash an API key with SHA-256 to look up in D1. */
async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract and validate Bearer token from the request. Returns org_id or null. */
async function authenticateRequest(
  request: Request,
  db: D1Database,
): Promise<string | null> {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;

  const apiKey = header.slice(7);
  if (!apiKey) return null;

  const keyHash = await hashApiKey(apiKey);
  const row = await db
    .prepare(
      "SELECT org_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
    )
    .bind(keyHash)
    .first<{ org_id: string }>();

  return row?.org_id ?? null;
}

/** Forward a JSON request to the API service binding and return parsed JSON. */
async function apiRequest(
  api: Fetcher,
  method: string,
  path: string,
  body: unknown,
  authHeader: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const resp = await api.fetch(`https://api.internal${path}`, init);
  // Service binding responses are bounded JSON — safe to buffer
  const data: unknown = await resp.json();
  return { ok: resp.ok, status: resp.status, data };
}

/** Parse a duration string like "4h", "24h", "7d" into an ISO timestamp. */
function expiresAt(duration?: string): string | undefined {
  if (!duration) return undefined;
  const match = /^(\d+)(m|h|d)$/.exec(duration.trim());
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  const ms =
    match[2] === "m"
      ? value * 60_000
      : match[2] === "h"
        ? value * 3_600_000
        : value * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}

// ---------------------------------------------------------------------------
// MCP Server (Durable Object via agents SDK)
// ---------------------------------------------------------------------------

export class FormForMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "formfor",
    version: "1.0.0",
  });

  // Store the Authorization header from the initial connection request
  // so tool handlers can forward it to the API service binding.
  private _authHeader: string | null = null;

  /** Capture auth header when a new SSE/WebSocket connection is established. */
  override async onConnect(
    connection: Connection,
    ctx: ConnectionContext,
  ): Promise<void> {
    this._authHeader =
      ctx.request.headers.get("Authorization") ?? null;
    await super.onConnect(connection, ctx);
  }

  /** Retrieve the stored auth header for forwarding to the API. */
  private getAuthHeader(): string | null {
    return this._authHeader;
  }

  async init() {
    // ------------------------------------------------------------------
    // formfor_ask — Ask a human a yes/no question
    // ------------------------------------------------------------------
    this.server.tool(
      "formfor_ask",
      "Ask a human a yes/no question and get their response. Use when you need approval, confirmation, or a binary decision from a person. The person receives the question via email and responds with one click. Returns { approved: true/false }.",
      {
        question: z.string().describe("The yes/no question to ask"),
        to: z.string().describe("Email address of the person to ask"),
        context: z
          .string()
          .optional()
          .describe("Background info to help them decide"),
        expires: z
          .string()
          .optional()
          .describe('Expiry duration e.g. "4h", "24h", "7d"'),
      },
      async ({ question, to, context, expires }) => {
        const authHeader = this.getAuthHeader();
        if (!authHeader) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Not authenticated. Provide a valid API key in the Authorization header.",
              },
            ],
            isError: true,
          };
        }

        const body = {
          question,
          to,
          context,
          expires: expiresAt(expires),
        };

        const result = await apiRequest(
          this.env.API,
          "POST",
          "/v1/ask",
          body,
          authHeader,
        );

        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error creating ask form: ${JSON.stringify(result.data)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
        };
      },
    );

    // ------------------------------------------------------------------
    // formfor_collect — Collect structured data via a form
    // ------------------------------------------------------------------
    this.server.tool(
      "formfor_collect",
      "Collect structured data from a human via a form. Use when you need specific data points (text, numbers, selections, files, etc.) from a person. Supports 14 field types with validation. The person receives a beautiful form link.",
      {
        title: z
          .string()
          .optional()
          .describe("Form title shown to the person"),
        fields: z
          .array(
            z.object({
              id: z.string(),
              type: z.enum([
                "text",
                "textarea",
                "number",
                "email",
                "url",
                "phone",
                "select",
                "multi_select",
                "confirm",
                "date",
                "datetime",
                "file",
                "rating",
              ]),
              label: z.string(),
              required: z.boolean().optional(),
              options: z.array(z.string()).optional(),
              placeholder: z.string().optional(),
              help: z.string().optional(),
            }),
          )
          .describe("Form fields to collect"),
        to: z.string().describe("Email address of the person"),
        context: z
          .string()
          .optional()
          .describe("Context shown on the form"),
        expires: z
          .string()
          .optional()
          .describe("Expiry duration"),
      },
      async ({ title, fields, to, context, expires }) => {
        const authHeader = this.getAuthHeader();
        if (!authHeader) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Not authenticated. Provide a valid API key in the Authorization header.",
              },
            ],
            isError: true,
          };
        }

        const body = {
          title: title ?? "Please fill out this form",
          fields,
          to,
          context,
          expires: expiresAt(expires),
        };

        const result = await apiRequest(
          this.env.API,
          "POST",
          "/v1/forms",
          body,
          authHeader,
        );

        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error creating form: ${JSON.stringify(result.data)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
        };
      },
    );

    // ------------------------------------------------------------------
    // formfor_check — Check form status / get response
    // ------------------------------------------------------------------
    this.server.tool(
      "formfor_check",
      "Check if a form has been completed and get the response data. Use to poll for a response after creating a form.",
      {
        form_id: z.string().describe("The form ID (form_xxx)"),
      },
      async ({ form_id }) => {
        const authHeader = this.getAuthHeader();
        if (!authHeader) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Not authenticated. Provide a valid API key in the Authorization header.",
              },
            ],
            isError: true,
          };
        }

        const result = await apiRequest(
          this.env.API,
          "GET",
          `/v1/forms/${encodeURIComponent(form_id)}`,
          undefined,
          authHeader,
        );

        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error checking form: ${JSON.stringify(result.data)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
        };
      },
    );

    // ------------------------------------------------------------------
    // formfor_list — List recent forms
    // ------------------------------------------------------------------
    this.server.tool(
      "formfor_list",
      "List your recent forms and their statuses.",
      {
        status: z
          .enum(["pending", "completed", "expired", "all"])
          .optional()
          .describe("Filter by status"),
        limit: z
          .number()
          .optional()
          .describe("Max results (default 10)"),
      },
      async ({ status, limit }) => {
        const authHeader = this.getAuthHeader();
        if (!authHeader) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Not authenticated. Provide a valid API key in the Authorization header.",
              },
            ],
            isError: true,
          };
        }

        const params = new URLSearchParams();
        if (status && status !== "all") params.set("status", status);
        if (limit !== undefined) params.set("limit", String(limit));

        const qs = params.toString();
        const path = `/v1/forms${qs ? `?${qs}` : ""}`;

        const result = await apiRequest(
          this.env.API,
          "GET",
          path,
          undefined,
          authHeader,
        );

        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error listing forms: ${JSON.stringify(result.data)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
        };
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint — route /sse to the MCP agent, with auth gate
// ---------------------------------------------------------------------------

const mcpHandler = FormForMCP.serveSSE("/sse", {
  binding: "MCP_AGENT",
  corsOptions: {
    origin: "*",
    methods: "GET, POST, OPTIONS, DELETE",
    headers: "Content-Type, Authorization, mcp-session-id",
  },
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight — let through without auth
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, mcp-session-id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        name: "formfor-mcp",
        version: "1.0.0",
        status: "ok",
      });
    }

    // MCP endpoints: /sse and /mcp
    if (
      url.pathname === "/sse" ||
      url.pathname.startsWith("/sse/")
    ) {
      // Authenticate before routing to the Durable Object
      const orgId = await authenticateRequest(request, env.DB);
      if (!orgId) {
        return Response.json(
          {
            error: {
              code: "unauthorized",
              message:
                "Missing or invalid Authorization header. Use: Authorization: Bearer ff_live_...",
              status: 401,
            },
          },
          { status: 401 },
        );
      }

      // Route to MCP Durable Object. The auth header is forwarded
      // and captured by FormForMCP.onConnect for tool calls.
      return mcpHandler.fetch(request, env, ctx);
    }

    return Response.json(
      {
        error: {
          code: "not_found",
          message: "Not found. MCP endpoint is at /sse",
          status: 404,
        },
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
