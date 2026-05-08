/**
 * Minimal MCP client for the WordPress MCP Adapter over Streamable HTTP.
 *
 * Implements the spec'd 3-step handshake before tool calls are accepted:
 *   1. POST `initialize` (no session header). Server returns `Mcp-Session-Id`
 *      response header that all subsequent requests must echo.
 *   2. POST `notifications/initialized` (a JSON-RPC notification — no id,
 *      no response body expected) with the session header.
 *   3. Tool calls (`tools/list`, `tools/call`, …) carrying the session header.
 *
 * Auth is WordPress Basic over Application Passwords. Both JSON and SSE
 * response bodies are handled, since the spec permits either.
 */

import { Buffer } from "node:buffer";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "wpheadless-cli";
const CLIENT_VERSION = "0.1.0";

export interface McpClientOptions {
  /** Full WP site URL, e.g. "https://two-roads-brewing.local". No trailing slash required. */
  wpUrl: string;
  /** WordPress username. */
  user: string;
  /** WordPress Application Password. */
  password: string;
  /** Server namespace registered by the MCP Adapter. Defaults to "mcp". */
  namespace?: string;
  /** Server route slug. Defaults to the bundled "mcp-adapter-default-server". */
  serverRoute?: string;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolListResult {
  tools: McpToolDefinition[];
}

export interface McpToolCallResult<T = unknown> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: T;
  isError: boolean;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface InitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo?: { name: string; version: string };
}

export class McpClientError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

export class McpClient {
  private readonly endpoint: string;
  private readonly authHeader: string;
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(opts: McpClientOptions) {
    const namespace = opts.namespace ?? "mcp";
    const serverRoute = opts.serverRoute ?? "mcp-adapter-default-server";
    const baseUrl = opts.wpUrl.replace(/\/+$/, "");
    this.endpoint = `${baseUrl}/wp-json/${namespace}/${serverRoute}`;
    this.authHeader = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
  }

  /** List tools exposed by the MCP server. */
  async listTools(): Promise<McpToolListResult> {
    await this.ensureInitialized();
    return this.rpc<McpToolListResult>("tools/list");
  }

  /** Call a tool by name. */
  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolCallResult<T>> {
    await this.ensureInitialized();
    return this.rpc<McpToolCallResult<T>>("tools/call", {
      name,
      arguments: args,
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.sendInitialize();
    await this.sendInitializedNotification();
    this.initialized = true;
  }

  private async sendInitialize(): Promise<void> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    });

    const response = await this.post(body, /* includeSession */ false);

    // Check response status FIRST — a 401/403 (typically wrong WP App
    // Password, often caused by an unquoted password with embedded
    // spaces on the CLI) has no session header by definition, and we
    // want to report the auth failure rather than mislead the user with
    // a "missing session header" diagnostic.
    if (!response.ok) {
      const text = await safeReadText(response);
      const hint =
        response.status === 401 || response.status === 403
          ? " — check your --user / --password (Application Passwords contain spaces; quote the whole value if passing on the CLI)"
          : "";
      throw new McpClientError(
        `initialize failed: HTTP ${response.status}${hint}${text ? `: ${text}` : ""}`,
        undefined,
        response.status,
      );
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new McpClientError(
        "Server response to `initialize` did not include the required Mcp-Session-Id header. The endpoint responded but isn't behaving like an MCP server — verify the wp-headless-kit plugin is active and `wordpress/mcp-adapter` is loaded.",
      );
    }
    this.sessionId = sessionId;

    // Drain the body for completeness — even on success we want to surface a
    // protocol error if the server reported one in the JSON-RPC payload.
    const payload = await parseRpcBody<InitializeResult>(response);
    if (payload.error) {
      throw new McpClientError(
        `initialize JSON-RPC error ${payload.error.code}: ${payload.error.message}`,
        payload.error.data,
        payload.error.code,
      );
    }
  }

  private async sendInitializedNotification(): Promise<void> {
    // Notifications have no `id` and the server returns no JSON-RPC body.
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const response = await this.post(body, /* includeSession */ true);
    if (!response.ok && response.status !== 202) {
      const text = await safeReadText(response);
      throw new McpClientError(
        `notifications/initialized failed: HTTP ${response.status}${text ? `: ${text}` : ""}`,
        undefined,
        response.status,
      );
    }
    // Drain so the connection can be released even though we don't use the body.
    await response.text().catch(() => undefined);
  }

  private async rpc<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const response = await this.post(body, /* includeSession */ true);

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new McpClientError(
        `HTTP ${response.status} from ${this.endpoint}${text ? `: ${text}` : ""}`,
        undefined,
        response.status,
      );
    }

    const payload = await parseRpcBody<T>(response);
    if (payload.error) {
      throw new McpClientError(
        `JSON-RPC error ${payload.error.code}: ${payload.error.message}`,
        payload.error.data,
        payload.error.code,
      );
    }
    if (payload.result === undefined) {
      throw new McpClientError(
        "JSON-RPC response missing both `result` and `error` fields",
      );
    }
    return payload.result;
  }

  private async post(body: string, includeSession: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Accept both — the spec permits the server to choose JSON or SSE per response.
      Accept: "application/json, text/event-stream",
      Authorization: this.authHeader,
    };
    if (includeSession && this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    try {
      return await fetch(this.endpoint, { method: "POST", headers, body });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      if (
        cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        cause?.code === "SELF_SIGNED_CERT_IN_CHAIN"
      ) {
        throw new McpClientError(
          `TLS error connecting to ${this.endpoint}. Local dev with a self-signed cert? Set NODE_TLS_REJECT_UNAUTHORIZED=0 (dev only — never in CI/prod).`,
          err,
        );
      }
      throw new McpClientError(
        `Network error calling ${this.endpoint}: ${(err as Error).message}`,
        err,
      );
    }
  }
}

/**
 * Parse a JSON-RPC response body, accepting both `application/json` and
 * `text/event-stream` Content-Types per the MCP HTTP spec.
 */
async function parseRpcBody<T>(response: Response): Promise<JsonRpcResponse<T>> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await response.text();
  const json = contentType.includes("text/event-stream")
    ? extractFirstSseDataLine(text)
    : text;

  if (!json) {
    throw new McpClientError(
      `Empty or unparseable response body (Content-Type: ${contentType || "unknown"})`,
    );
  }

  try {
    return JSON.parse(json) as JsonRpcResponse<T>;
  } catch (err) {
    throw new McpClientError(
      `Non-JSON response body (Content-Type: ${contentType || "unknown"})`,
      err,
    );
  }
}

/**
 * SSE wire format:
 *   event: message
 *   data: {"jsonrpc":"2.0", ...}
 *
 * We only read the first `data:` line, which carries the full JSON-RPC payload
 * for our (non-streaming) tool calls.
 */
function extractFirstSseDataLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      return line.slice(5).trim();
    }
  }
  return null;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "";
  }
}
