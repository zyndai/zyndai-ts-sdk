import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import { spawnSync } from "node:child_process";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  userId: string;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT: expected 3 parts");
  const raw = Buffer.from(parts[1]!, "base64url").toString("utf-8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`malformed JWT payload: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export function extractUserIdFromToken(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  if (typeof payload["sub"] !== "string" || !payload["sub"]) {
    throw new Error("JWT missing sub claim");
  }
  return payload["sub"];
}

export function tokenExpiresAt(accessToken: string): number {
  const payload = decodeJwtPayload(accessToken);
  if (typeof payload["exp"] !== "number") return 0;
  return payload["exp"];
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawnSync("open", [url], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      spawnSync("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" });
    } else {
      spawnSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    // Browser open failed — caller prints the URL for manual opening
  }
}

async function registerDcrClient(base: string, redirectUri: string): Promise<string> {
  const resp = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "zynd-ctx-sdk",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      scopes: ["user", "ingest", "offline_access"],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OAuth client registration failed (${resp.status}): ${body}`);
  }
  const data = (await resp.json()) as { client_id: string };
  if (!data.client_id) throw new Error("OAuth registration returned no client_id");
  return data.client_id;
}

async function exchangeCodeForTokens(opts: {
  base: string;
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<{ access_token: string; refresh_token: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  const resp = await fetch(`${opts.base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OAuth token exchange failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error("OAuth token response missing access_token");
  if (!data.refresh_token) throw new Error("OAuth token response missing refresh_token");
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

function waitForCallback(opts: {
  port: number;
  expectedState: string;
  timeoutMs: number;
  onServerReady: (authorizeUrl: string) => void;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out — run `zynd ctx init` again to retry"));
    }, opts.timeoutMs);

    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);

      if (parsed.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const returnedState = parsed.searchParams.get("state");
      const code = parsed.searchParams.get("code");
      const error = parsed.searchParams.get("error");

      const sendPage = (html: string, status = 200) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Zynd</title><style>body{margin:0;min-height:100vh;display:grid;` +
          `place-items:center;font-family:system-ui;background:#0f0f13;color:#e4e4e7}` +
          `div{text-align:center}h2{font-size:1.25rem}</style></head>` +
          `<body><div>${html}</div></body></html>`
        );
      };

      clearTimeout(timer);
      server.close();

      if (returnedState !== opts.expectedState) {
        sendPage('<h2 style="color:#ef4444">Sign-in failed</h2><p>State mismatch — close this tab.</p>', 400);
        reject(new Error("OAuth state mismatch — possible CSRF"));
        return;
      }
      if (error || !code) {
        sendPage(`<h2 style="color:#ef4444">Sign-in failed</h2><p>${error ?? "No code returned."}</p>`, 400);
        reject(new Error(`OAuth error: ${error ?? "no code returned"}`));
        return;
      }

      sendPage(
        '<h2 style="color:#22c55e">✓ Signed in to Zynd</h2>' +
        "<p>You can close this tab and return to the terminal.</p>"
      );
      resolve(code);
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Callback server error: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
    });

    server.listen(opts.port, "127.0.0.1", () => {
      opts.onServerReady(`http://127.0.0.1:${opts.port}/callback`);
    });
  });
}

export async function oauthLogin(memoryUrl: string): Promise<OAuthTokens> {
  const base = memoryUrl.replace(/\/$/, "");
  const port = await findFreePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const clientId = await registerDcrClient(base, redirectUri);

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = crypto.randomBytes(16).toString("hex");

  const authorizeParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "user ingest offline_access",
  });
  const authorizeUrl = `${base}/oauth/authorize?${authorizeParams.toString()}`;

  const code = await waitForCallback({
    port,
    expectedState: state,
    timeoutMs: 5 * 60 * 1_000,
    onServerReady: () => {
      process.stderr.write(`\nOpening browser for sign-in...\n`);
      process.stderr.write(`If the browser does not open, visit:\n  ${authorizeUrl}\n\n`);
      openBrowser(authorizeUrl);
    },
  });

  const tokens = await exchangeCodeForTokens({ base, clientId, code, redirectUri, verifier });
  const userId = extractUserIdFromToken(tokens.access_token);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    clientId,
    userId,
  };
}

export async function refreshAccessToken(opts: {
  memoryUrl: string;
  clientId: string;
  refreshToken: string;
}): Promise<RefreshedTokens> {
  const base = opts.memoryUrl.replace(/\/$/, "");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
  });
  const resp = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error("Token refresh response missing access_token");
  if (!data.refresh_token) throw new Error("Token refresh response missing refresh_token");
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}
