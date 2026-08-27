/**
 * LinkedIn connector — browser-based auth captures li_at cookie (works with
 * Google OAuth, email/password, SSO). Subsequent syncs use open-linkedin-api
 * with the stored li_at — no password ever stored.
 *
 * Auth: opens system Chrome → user logs in any way → li_at extracted.
 * Sync: open-linkedin-api with li_at fetches profile + 1st-degree connections.
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConnectorConfig, ConnectorHealth, DistillResult, IMemoryConnector } from "../types.js";
import { acquireRateSlot, engageCooldown } from "../linkedin-governor.js";
import { sanitizeString } from "../redactor.js";

// Inline Python scripts — written to per-invocation temp dirs at runtime

// Opens system default browser (Arc, Safari, Firefox, whatever is set).
// Reads li_at by polling the browser's cookie store directly:
//   - Chromium-based (Arc, Chrome, Brave, Edge): SQLite + AES-128-CBC via macOS Keychain
//   - Firefox: plain SQLite (no encryption)
// No browser forced. No binary downloaded. Uses only stdlib + cryptography package.
const AUTH_SCRIPT = `
import json, os, shutil, sqlite3, subprocess, sys, tempfile, time, webbrowser
from hashlib import pbkdf2_hmac
from pathlib import Path

LINKEDIN_URL = "https://www.linkedin.com/login"
TIMEOUT = 180

import platform as _platform
_OS = _platform.system()  # "Darwin" | "Linux" | "Windows"
_HOME = Path.home()

# (base_dir, glob_pattern_for_Cookies_file, keychain_service_name)
# Arc first — that's the user's default. Covers macOS/Linux/Windows.
CHROMIUM_SOURCES = {
    "Darwin": [
        (_HOME / "Library/Application Support/Arc/User Data",                    "*/Cookies",         "Arc Safe Storage"),
        (_HOME / "Library/Application Support/Google/Chrome",                    "*/Cookies",         "Chrome Safe Storage"),
        (_HOME / "Library/Application Support/Google/Chrome",                    "*/Network/Cookies", "Chrome Safe Storage"),
        (_HOME / "Library/Application Support/Google/Chrome Beta",               "*/Cookies",         "Chrome Safe Storage"),
        (_HOME / "Library/Application Support/Google/Chrome Canary",             "*/Cookies",         "Chrome Safe Storage"),
        (_HOME / "Library/Application Support/Chromium",                         "*/Cookies",         "Chromium Safe Storage"),
        (_HOME / "Library/Application Support/BraveSoftware/Brave-Browser",      "*/Cookies",         "Brave Safe Storage"),
        (_HOME / "Library/Application Support/BraveSoftware/Brave-Browser-Beta", "*/Cookies",         "Brave Safe Storage"),
        (_HOME / "Library/Application Support/Microsoft Edge",                   "*/Cookies",         "Microsoft Edge Safe Storage"),
        (_HOME / "Library/Application Support/Opera Software/Opera Stable",      "Cookies",           "Opera Safe Storage"),
        (_HOME / "Library/Application Support/Vivaldi",                          "*/Cookies",         "Vivaldi Safe Storage"),
        (_HOME / "Library/Application Support/com.operasoftware.Opera",          "Cookies",           "Opera Safe Storage"),
    ],
    "Linux": [
        (_HOME / ".config/google-chrome",                   "*/Cookies",         ""),
        (_HOME / ".config/google-chrome-beta",              "*/Cookies",         ""),
        (_HOME / ".config/chromium",                        "*/Cookies",         ""),
        (_HOME / ".config/BraveSoftware/Brave-Browser",     "*/Cookies",         ""),
        (_HOME / ".config/microsoft-edge",                  "*/Cookies",         ""),
        (_HOME / "snap/chromium/current/.config/chromium",  "*/Cookies",         ""),
    ],
    "Windows": [
        (_HOME / "AppData/Local/Google/Chrome/User Data",         "*/Cookies",  ""),
        (_HOME / "AppData/Local/Google/Chrome/User Data",         "*/Network/Cookies", ""),
        (_HOME / "AppData/Local/BraveSoftware/Brave-Browser/User Data", "*/Cookies", ""),
        (_HOME / "AppData/Local/Microsoft/Edge/User Data",        "*/Cookies",  ""),
    ],
}.get(_OS, [])

def _expand_profiles():
    result = []
    for base, pattern, service in CHROMIUM_SOURCES:
        try:
            for match in sorted(base.glob(pattern)):
                result.append((match, service))
        except Exception:
            pass
    return result

def _keychain_key(service):
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-s", service, "-w"],
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return None

def _decrypt_chromium(enc, raw_password):
    """AES-128-CBC, macOS Chromium v10/v11 cookie format."""
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend
        if not enc:
            return None
        if enc[:3] not in (b"v10", b"v11"):
            # Unencrypted plaintext value
            return enc.decode("utf-8", errors="ignore") if isinstance(enc, bytes) else str(enc)
        key = pbkdf2_hmac("sha1", raw_password, b"saltysalt", 1003, dklen=16)
        dec = Cipher(algorithms.AES(key), modes.CBC(b" " * 16), backend=default_backend()).decryptor()
        raw = dec.update(enc[3:]) + dec.finalize()
        # PKCS7 padding: last byte is padding length
        padding = raw[-1]
        if padding < 1 or padding > 16:
            return None
        return raw[:-padding].decode("utf-8", errors="ignore") or None
    except Exception:
        return None

def read_chromium(cookie_file, service):
    p = Path(cookie_file)
    if not p.exists():
        return {}
    password = _keychain_key(service)
    if not password:
        return {}
    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as f:
        tmp = f.name
    try:
        shutil.copy2(str(p), tmp)
        con = sqlite3.connect(tmp)
        rows = con.execute(
            "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%linkedin.com%'"
        ).fetchall()
        con.close()
        result = {}
        for name, enc in rows:
            val = _decrypt_chromium(enc, password)
            if val:
                result[name] = val
        return result
    except Exception:
        return {}
    finally:
        try: os.unlink(tmp)
        except: pass

def read_firefox():
    ff_roots = [
        _HOME / "Library/Application Support/Firefox/Profiles",   # macOS
        _HOME / ".mozilla/firefox",                                 # Linux
        _HOME / "AppData/Roaming/Mozilla/Firefox/Profiles",        # Windows
        _HOME / "snap/firefox/common/.mozilla/firefox",            # snap
    ]
    for root in ff_roots:
        if not root.exists():
            continue
        for profile in root.iterdir():
            db = profile / "cookies.sqlite"
            if not db.exists():
                continue
            with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as f:
                tmp = f.name
            try:
                shutil.copy2(str(db), tmp)
                con = sqlite3.connect(tmp)
                rows = con.execute(
                    "SELECT name, value FROM moz_cookies WHERE host LIKE '%linkedin.com%'"
                ).fetchall()
                con.close()
                cookies = dict(rows)
                if cookies.get("li_at"):
                    return cookies
            except Exception:
                pass
            finally:
                try: os.unlink(tmp)
                except: pass
    return {}

def _clean_cookies(cookies: dict) -> dict:
    """Strip Arc AES-CBC first-block garbage from decrypted cookie values.

    Arc's Chromium decryption sometimes produces garbage prefix bytes (one AES
    block = 16 bytes) before the real value when the IV handling differs.
    li_at tokens always start with AQED; JSESSIONID always starts with ajax:.
    """
    import re
    if "li_at" in cookies:
        m = re.search(r'AQED[A-Za-z0-9_-]+', cookies["li_at"])
        if m:
            cookies["li_at"] = m.group(0)
    if "JSESSIONID" in cookies:
        m = re.search(r'ajax:\\d+', cookies["JSESSIONID"])
        if m:
            cookies["JSESSIONID"] = m.group(0)
    return cookies

def get_linkedin_cookies():
    for cookie_file, service in _expand_profiles():
        cookies = read_chromium(cookie_file, service)
        if cookies.get("li_at"):
            return _clean_cookies(cookies)
    cookies = read_firefox()
    if cookies.get("li_at"):
        return _clean_cookies(cookies)
    return {}

def prompt_paste():
    """Fallback: show instructions and read li_at + JSESSIONID from stdin."""
    sys.stderr.write("\\n")
    sys.stderr.write("  Auto-read not available for your browser (Arc/new Chrome encrypt cookies differently).\\n")
    sys.stderr.write("  One-time manual step — takes about 60 seconds:\\n\\n")
    sys.stderr.write("  1. LinkedIn is already open in your browser — log in if not already\\n")
    sys.stderr.write("  2. Press Cmd+Option+I  (or F12 on Windows/Linux)\\n")
    sys.stderr.write("  3. Click  Application  tab → Cookies → https://www.linkedin.com\\n")
    sys.stderr.write("  4. Find row named  li_at  → right-click the Value → Copy\\n")
    sys.stderr.write("\\n")
    sys.stderr.write("  Paste li_at here: ")
    sys.stderr.flush()
    try:
        li_at = sys.stdin.readline().strip()
    except Exception:
        li_at = ""
    if not li_at:
        print(json.dumps({"error": "No li_at provided — run zynd ctx linkedin-auth to retry"}))
        sys.exit(1)
    if len(li_at) < 50:
        print(json.dumps({"error": "li_at looks too short — make sure you copied the full value"}))
        sys.exit(1)

    # JSESSIONID is used as the CSRF token for LinkedIn's Voyager API.
    # Without a real one, all API calls redirect to the login page (30-redirect loop).
    sys.stderr.write("\\n")
    sys.stderr.write("  5. Now find row named  JSESSIONID  → right-click the Value → Copy\\n")
    sys.stderr.write("     (value looks like: \\"ajax:1234567890123456789\\" — include the quotes if shown)\\n")
    sys.stderr.write("\\n")
    sys.stderr.write("  Paste JSESSIONID here: ")
    sys.stderr.flush()
    try:
        jsessionid = sys.stdin.readline().strip()
    except Exception:
        jsessionid = ""
    if not jsessionid:
        print(json.dumps({"error": "No JSESSIONID provided — both li_at and JSESSIONID are required"}))
        sys.exit(1)

    print(json.dumps({"li_at": li_at, "jsessionid": jsessionid}))
    sys.exit(0)

def _validate_li_at(li_at, jsessionid):
    """Verify a captured li_at is still a live LinkedIn session.

    Single bounded HTTP call (no redirect-following, 10s timeout) so a stale
    cookie can never hang the auth flow. Returns True only on a 200 from the
    Voyager /me endpoint.
    """
    try:
        import socket
        socket.setdefaulttimeout(10)
        import requests
        jar = requests.cookies.RequestsCookieJar()
        jar.set("li_at", li_at)
        js_val = jsessionid if jsessionid else "ajax:0"
        if not js_val.startswith('"'):
            js_val = f'"{js_val}"'
        jar.set("JSESSIONID", js_val)
        resp = requests.get(
            "https://www.linkedin.com/voyager/api/me",
            cookies=jar,
            headers={
                "csrf-token": js_val.strip('"'),
                "Accept": "application/vnd.linkedin.normalized+json+2.1",
            },
            timeout=10,
            allow_redirects=False,
        )
        return resp.status_code == 200
    except Exception:
        return False

try:
    # Use a cached browser cookie only if it's still a live session. A stale
    # li_at fails later at sync time with a confusing "session expired".
    cookies = get_linkedin_cookies()
    if cookies.get("li_at") and _validate_li_at(cookies["li_at"], cookies.get("JSESSIONID", "")):
        print(json.dumps({"li_at": cookies["li_at"], "jsessionid": cookies.get("JSESSIONID", "")}))
        sys.exit(0)

    # Open system default browser — Arc, Safari, Firefox, whatever is set
    webbrowser.open(LINKEDIN_URL)
    sys.stderr.write("Opened LinkedIn in your browser — log in, then we auto-capture.\\n")
    sys.stderr.flush()

    AUTO_TIMEOUT = 60  # auto-read window; falls back to paste after this
    deadline = time.time() + AUTO_TIMEOUT
    while time.time() < deadline:
        time.sleep(3)
        cookies = get_linkedin_cookies()
        if cookies.get("li_at") and _validate_li_at(cookies["li_at"], cookies.get("JSESSIONID", "")):
            print(json.dumps({"li_at": cookies["li_at"], "jsessionid": cookies.get("JSESSIONID", "")}))
            sys.exit(0)
        sys.stderr.write(".")
        sys.stderr.flush()

    # Auto-read failed (Arc, new Chrome, etc.) — ask user to paste
    prompt_paste()

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

// Uses li_at to fetch profile + connections via open-linkedin-api
const SYNC_SCRIPT = `
import http.client, io, json, os, sys, urllib.parse

# Force UTF-8 for all stdio so non-ASCII names don't break print().
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# http.client validates header values as latin-1 (HTTP/1.1 spec). LinkedIn
# sometimes redirects to profile URLs containing non-ASCII script characters
# (e.g. Thaana, Arabic, CJK). Percent-encode those values before sending so
# the latin-1 check passes.
_orig_putheader = http.client.HTTPConnection.putheader
def _utf8_safe_putheader(self, header, *values):
    safe = []
    for v in values:
        if isinstance(v, str):
            try:
                v.encode("latin-1")
            except UnicodeEncodeError:
                v = urllib.parse.quote(v, safe=":/?#[]@!$&'()*+,;=% ")
        safe.append(v)
    return _orig_putheader(self, header, *safe)
http.client.HTTPConnection.putheader = _utf8_safe_putheader

import re as _re

li_at      = os.environ.get("LI_AT", "")
jsessionid = os.environ.get("LI_JSESSIONID", "")
limit      = int(os.environ.get("LI_LIMIT", "100"))

# Arc's AES-128-CBC decryption garbles the first block (16 bytes) when the IV
# handling differs. Strip the garbage prefix — real values have known prefixes.
if li_at:
    m = _re.search(r'AQED[A-Za-z0-9_-]+', li_at)
    if m:
        li_at = m.group(0)
if jsessionid:
    m = _re.search(r'ajax:\d+', jsessionid)
    if m:
        jsessionid = m.group(0)

if not li_at:
    print(json.dumps({"error": "LI_AT not set — run: zynd ctx linkedin-auth"}))
    sys.exit(1)

try:
    import requests
    from open_linkedin_api import Linkedin
    from requests.cookies import RequestsCookieJar

    # open-linkedin-api._set_session_cookies expects a RequestsCookieJar, not a
    # plain dict. A dict causes 'dict has no attribute extract_cookies' in requests
    # internals. JSESSIONID is also required — it doubles as the CSRF token and
    # _set_session_cookies calls .strip('"') on it.
    #
    # Do NOT specify domain/path: cookies without domain_specified=True bypass
    # DefaultCookiePolicy.return_ok_domain filtering and are always sent,
    # avoiding the subtle case where domain-qualified cookies get silently dropped.
    jar = RequestsCookieJar()
    jar.set("li_at", li_at)
    js_val = jsessionid if jsessionid else "ajax:0"
    if not js_val.startswith('"'):
        js_val = f'"{js_val}"'
    jar.set("JSESSIONID", js_val)

    # authenticate=False — we're already authed via li_at cookie, not credentials.
    # authenticate=True with empty creds causes a redirect loop (30 redirects error).
    api = Linkedin("", "", cookies=jar, authenticate=False)

    me = api.get_user_profile()
    urn = me.get("entityUrn", "") if isinstance(me, dict) else ""
    urn_id = urn.split(":")[-1] if ":" in urn else urn

    profile_data = {}
    if urn_id:
        try:
            profile_data = api.get_profile(urn_id=urn_id) or {}
        except Exception:
            pass

    connections = []
    if urn_id:
        try:
            raw = api.get_profile_connections(urn_id=urn, limit=limit) or []
            for c in raw:
                mp = c.get("miniProfile", c)
                first = mp.get("firstName", "")
                last  = mp.get("lastName", "")
                name  = f"{first} {last}".strip()
                slug  = mp.get("publicIdentifier", "")
                connections.append({
                    "name":     name,
                    "headline": mp.get("occupation", ""),
                    "location": mp.get("locationName", ""),
                    "url":      f"https://www.linkedin.com/in/{slug}" if slug else "",
                })
        except Exception:
            pass

    profile_lines = []
    for key in ("firstName", "lastName", "headline", "locationName", "summary"):
        val = profile_data.get(key, "")
        if val:
            profile_lines.append(str(val))

    # Extract structured profile fields for tier classification on the TS side
    experience = []
    for exp in (profile_data.get("experience") or []):
        experience.append({
            "title":       exp.get("title", ""),
            "company":     exp.get("companyName", "") or exp.get("company", {}).get("miniCompany", {}).get("name", ""),
            "description": (exp.get("description") or "")[:300],
        })

    skills = []
    for skill in (profile_data.get("skills") or []):
        name = skill.get("name", "") if isinstance(skill, dict) else str(skill)
        if name:
            skills.append(name)

    print(json.dumps({
        "profile_text": "\\n".join(profile_lines),
        "connections": connections,
        "profile": {
            "firstName":  profile_data.get("firstName", ""),
            "lastName":   profile_data.get("lastName", ""),
            "headline":   profile_data.get("headline", ""),
            "summary":    profile_data.get("summary", ""),
            "location":   profile_data.get("locationName", ""),
            "experience": experience,
            "skills":     skills,
        },
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

interface Connection {
  name: string;
  headline: string;
  location: string;
  url: string;
}

interface LinkedInProfile {
  firstName?: string;
  lastName?: string;
  headline?: string;
  summary?: string;
  location?: string;
  experience?: Array<{ title?: string; company?: string; description?: string }>;
  skills?: string[];
}

interface SyncResult {
  profile_text: string;
  connections: Connection[];
  profile?: LinkedInProfile;
}

export interface LinkedInAuthResult {
  li_at: string;
  jsessionid: string;
}

export class LinkedInConnector implements IMemoryConnector {
  readonly name = "linkedin";

  private liAt: string | null = null;
  private jsessionid: string | null = null;
  private limit = 100;

  async connect(config: ConnectorConfig): Promise<void> {
    const liAt = config["li_at"];
    if (!liAt || typeof liAt !== "string") {
      throw new Error("linkedin connector requires li_at — run: zynd ctx linkedin-auth");
    }
    this.liAt = liAt;
    this.jsessionid = typeof config["jsessionid"] === "string" ? config["jsessionid"] : null;
    this.limit = typeof config["limit"] === "number" ? config["limit"] : 100;
  }

  async health(): Promise<ConnectorHealth> {
    if (!this.liAt) {
      return { connected: false, error: "not authenticated — run: zynd bridge linkedin-auth" };
    }
    // Include governor quota in health report
    try {
      const { getGovernorStatus } = await import("../linkedin-governor.js");
      const status = await getGovernorStatus();
      return {
        connected: !status.blocked,
        rateLimitRemaining: status.hourRemaining,
        cooldownUntil: status.cooldownUntil ?? undefined,
        error: status.blocked ? "rate limited" : undefined,
      };
    } catch {
      return { connected: true };
    }
  }

  async distill(): Promise<DistillResult> {
    const empty: DistillResult = { textBlob: "", findabilityFacts: [], cardEnrichment: { capabilities: [], tags: [] } };
    if (!this.liAt) return empty;

    // Rate-limit check — throws ERR_LINKEDIN_COOLDOWN or ERR_LINKEDIN_RATE_LIMIT if blocked
    try {
      await acquireRateSlot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`LinkedIn blocked by governor: ${msg}`, { cause: err });
    }

    let result: SyncResult;
    try {
      result = await this.runSync();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 429 or auth checkpoint → engage cooldown
      if (msg.includes("429") || msg.includes("CAPTCHA") || msg.includes("checkpoint")) {
        await engageCooldown().catch(() => {});
      }
      // Stale/expired li_at cookie: open-linkedin-api receives an empty/HTML body
      // and its internal json.loads throws "Expecting value: line 1 column 1".
      if (
        msg.includes("session_expired") ||
        msg.includes("li_at") ||
        msg.includes("Expecting value") ||
        msg.includes("JSONDecodeError") ||
        msg.includes("not logged in")
      ) {
        throw new Error("LinkedIn session expired — run: zynd bridge linkedin-auth");
      }
      throw new Error(`LinkedIn sync failed: ${msg}`, { cause: err });
    }

    const parts: string[] = [];
    if (result.profile_text) {
      parts.push(`My LinkedIn profile:\n${sanitizeString(result.profile_text)}`);
    }
    if (result.connections.length > 0) {
      const connText = result.connections
        .map((c) =>
          [
            c.name ? `Name: ${c.name}` : null,
            c.headline ? `Role: ${sanitizeString(c.headline)}` : null,
            c.location ? `Location: ${c.location}` : null,
            c.url ? `LinkedIn: ${c.url}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        )
        .join("\n\n");
      parts.push(`LinkedIn connections (${result.connections.length}):\n\n${connText}`);
    }

    // Distill structured profile into tiered assertions, persist locally, enqueue for cloud sync
    if (result.profile) {
      try {
        const { distillLinkedInProfile } = await import("../distiller.js");
        const { withStore } = await import("../store.js");
        const { enqueueAssertions } = await import("../outbox.js");

        const assertions = distillLinkedInProfile(result.profile);

        // Merge into local store (deduplicate by predicate+object)
        await withStore(async (store) => {
          const existing = new Set(store.assertions.map((a) => `${a.predicate}::${a.object}`));
          for (const a of assertions) {
            if (!existing.has(`${a.predicate}::${a.object}`)) {
              store.assertions.push(a);
            }
          }
        });

        // Enqueue non-Tier-3 assertions for cloud sync via outbox
        await enqueueAssertions(assertions);

        // Surface Tier 0/1 as findabilityFacts so sync.ts also calls declare-batch immediately
        const findabilityFacts = assertions
          .filter((a) => a.tier <= 1)
          .map((a) => ({ predicate: a.predicate, value: a.object }));

        return {
          textBlob: parts.join("\n\n---\n\n"),
          findabilityFacts,
          cardEnrichment: { capabilities: [], tags: [] },
        };
      } catch (err) {
        // Distillation/store failure is non-fatal — still return text blob
        console.error(
          `[bridge/linkedin] distill assertions failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { textBlob: parts.join("\n\n---\n\n"), findabilityFacts: [], cardEnrichment: { capabilities: [], tags: [] } };
  }

  /** Opens system Chrome for user to log in. Returns li_at + jsessionid. */
  static async openBrowserAuth(): Promise<LinkedInAuthResult> {
    const scriptPath = LinkedInConnector.writeTempScript(AUTH_SCRIPT);
    return new Promise((resolve, reject) => {
      // stdin inherited so user can paste li_at if auto-read fails (Arc/new Chrome)
      const proc = child_process.spawn(
        "uv",
        ["run", "--with", "cryptography", "--with", "requests", "python3", scriptPath],
        { stdio: ["inherit", "pipe", "inherit"], timeout: 200_000 }
      );

      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.on("error", reject);
      proc.on("close", () => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        let parsed: { li_at?: string; jsessionid?: string; error?: string };
        try {
          parsed = JSON.parse(lastLine);
        } catch {
          return reject(new Error(`auth script unexpected output: ${lastLine.slice(0, 300)}`));
        }
        if (parsed.error) return reject(new Error(parsed.error));
        if (!parsed.li_at) return reject(new Error("li_at not found in auth output"));
        resolve({ li_at: parsed.li_at, jsessionid: parsed.jsessionid ?? "" });
      });
    });
  }

  private async runSync(): Promise<SyncResult> {
    const scriptPath = LinkedInConnector.writeTempScript(SYNC_SCRIPT);
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LI_AT: this.liAt!,
        LI_JSESSIONID: this.jsessionid ?? "",
        LI_LIMIT: String(this.limit),
      };

      const proc = child_process.spawn(
        "uv",
        ["run", "--with", "open-linkedin-api", "python3", scriptPath],
        { env, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 }
      );

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("error", reject);
      proc.on("close", () => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        let parsed: { error?: string; profile_text?: string; connections?: Connection[] };
        try {
          parsed = JSON.parse(lastLine);
        } catch {
          return reject(new Error(`sync script unexpected output: ${lastLine || stderr.slice(0, 300)}`));
        }
        if (parsed.error) return reject(new Error(parsed.error));
        resolve({ profile_text: parsed.profile_text ?? "", connections: parsed.connections ?? [] });
      });
    });
  }

  private static writeTempScript(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zynd-li-"));
    const p = path.join(dir, "script.py");
    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });
    return p;
  }
}
