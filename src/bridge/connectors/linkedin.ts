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

    Uses the same open-linkedin-api get_user_profile() call the sync path uses
    (authenticate=False), so a cookie that validates here also syncs. A stale
    cookie throws a JSONDecodeError here (not a 200), so it is rejected and the
    auth flow falls through to a fresh browser login. Socket timeout bounds it.
    """
    try:
        import socket
        socket.setdefaulttimeout(10)
        from open_linkedin_api import Linkedin
        from requests.cookies import RequestsCookieJar
        jar = RequestsCookieJar()
        jar.set("li_at", li_at)
        js_val = jsessionid if jsessionid else "ajax:0"
        if not js_val.startswith('"'):
            js_val = f'"{js_val}"'
        jar.set("JSESSIONID", js_val)
        api = Linkedin("", "", cookies=jar, authenticate=False)
        me = api.get_user_profile()
        return bool(me and (me.get("entityUrn") or me.get("miniProfile") or me.get("firstName")))
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

    # Try auto-read for up to 10s — Arc/Chrome AES decryption often fails,
    # so we fall through quickly to the paste prompt rather than blocking 60s.
    AUTO_TIMEOUT = 10
    deadline = time.time() + AUTO_TIMEOUT
    while time.time() < deadline:
        time.sleep(2)
        cookies = get_linkedin_cookies()
        if cookies.get("li_at") and _validate_li_at(cookies["li_at"], cookies.get("JSESSIONID", "")):
            print(json.dumps({"li_at": cookies["li_at"], "jsessionid": cookies.get("JSESSIONID", "")}))
            sys.exit(0)

    # Auto-read failed (Arc/new Chrome encrypt differently) — ask user to paste
    prompt_paste()

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

// Uses li_at to fetch profile + connections via open-linkedin-api
const SYNC_SCRIPT = `
import io, json, os, re as _re, sys

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

li_at      = os.environ.get("LI_AT", "")
jsessionid = os.environ.get("LI_JSESSIONID", "")

# Strip Arc AES-CBC first-block garbage — real li_at starts with AQED
if li_at:
    m = _re.search(r'AQED[A-Za-z0-9_-]+', li_at)
    if m: li_at = m.group(0)
# Normalise jsessionid — strip outer quotes if present
if jsessionid:
    m = _re.search(r'ajax:\\d+', jsessionid)
    if m: jsessionid = m.group(0)

if not li_at:
    print(json.dumps({"error": "LI_AT not set — run: zynd bridge linkedin-auth"}))
    sys.exit(1)

try:
    import urllib.request, urllib.error

    # Set Cookie header directly — avoids requests/cookiejar domain-matching
    # redirect loops that occur when cookies are set via session.cookies.set().
    js_cookie = f'"{jsessionid}"' if jsessionid else '"ajax:0"'
    csrf = jsessionid or "ajax:0"
    cookie_header = f"li_at={li_at}; JSESSIONID={js_cookie}"
    common_headers = {
        "cookie":                       cookie_header,
        "csrf-token":                   csrf,
        "user-agent":                   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "x-restli-protocol-version":    "2.0.0",
        "x-li-lang":                    "en_US",
        "accept":                       "application/vnd.linkedin.normalized+json+2.1",
    }

    def li_get(url):
        req = urllib.request.Request(url, headers=common_headers)
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8", "replace"))

    # Step 1: /voyager/api/me → own miniProfile
    me = li_get("https://www.linkedin.com/voyager/api/me")
    mini = me.get("miniProfile", me)
    first     = mini.get("firstName", "")
    last      = mini.get("lastName", "")
    headline  = mini.get("occupation", "")
    public_id = mini.get("publicIdentifier", "")

    if not first and not last:
        print(json.dumps({"error": "session_expired: profile empty — run: zynd bridge linkedin-auth"}))
        sys.exit(1)

    # Step 2: profileView → location, summary, experience, skills
    profile_data = {}
    if public_id:
        try:
            profile_data = li_get(
                f"https://www.linkedin.com/voyager/api/identity/profiles/{public_id}/profileView"
            )
        except Exception:
            pass

    def _text(obj, *keys):
        for k in keys:
            v = obj.get(k, "")
            if v and isinstance(v, str): return v
        return ""

    # Flatten nested profile structure
    profile_view = profile_data
    position_view = profile_view.get("positionView", {})
    skill_view    = profile_view.get("skillView", {})
    summary_text  = ""

    # summaryV2 is a rich text object; try plaintext summary from top-level profile too
    top_profile = profile_view.get("profile", {})
    if isinstance(top_profile, dict):
        summary_text = top_profile.get("summary", "") or ""
        if not headline: headline = top_profile.get("headline", "")
        location = top_profile.get("locationName", "")
    else:
        location = ""

    experience = []
    for pos in (position_view.get("elements") or []):
        company_name = ""
        co = pos.get("company", {})
        if isinstance(co, dict):
            company_name = co.get("name", "") or (co.get("miniCompany") or {}).get("name", "")
        experience.append({
            "title":       pos.get("title", ""),
            "company":     company_name,
            "description": (pos.get("description") or "")[:300],
        })

    skills = []
    for sk in (skill_view.get("elements") or []):
        name = (sk.get("skill") or {}).get("name", "")
        if name: skills.append(name)

    profile_lines = [x for x in [first + " " + last, headline, location, summary_text] if x.strip()]

    print(json.dumps({
        "profile_text": "\\n".join(profile_lines),
        "profile": {
            "firstName":  first,
            "lastName":   last,
            "headline":   headline,
            "summary":    summary_text,
            "location":   location,
            "experience": experience[:10],
            "skills":     skills[:30],
        },
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

// Gated: search people by keyword (PRD: search_people, coarse, rate-limited)
const SEARCH_PEOPLE_SCRIPT = `
import http.client, io, json, os, sys, urllib.parse
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
_orig_putheader = http.client.HTTPConnection.putheader
def _utf8_safe_putheader(self, header, *values):
    safe = []
    for v in values:
        if isinstance(v, str):
            try: v.encode("latin-1")
            except UnicodeEncodeError: v = urllib.parse.quote(v, safe=":/?#[]@!$&'()*+,;=% ")
        safe.append(v)
    return _orig_putheader(self, header, *safe)
http.client.HTTPConnection.putheader = _utf8_safe_putheader
import re as _re

li_at      = os.environ.get("LI_AT", "")
jsessionid = os.environ.get("LI_JSESSIONID", "")
keywords   = os.environ.get("LI_KEYWORDS", "")
limit      = min(int(os.environ.get("LI_LIMIT", "10")), 25)  # hard cap — no bulk
depth      = os.environ.get("LI_DEPTH", "F")  # F=1st, S=2nd, O=other

if li_at:
    m = _re.search(r'AQED[A-Za-z0-9_-]+', li_at)
    if m: li_at = m.group(0)
if jsessionid:
    m = _re.search(r'ajax:\\d+', jsessionid)
    if m: jsessionid = m.group(0)

if not li_at:
    print(json.dumps({"error": "LI_AT not set"}))
    sys.exit(1)
if not keywords.strip():
    print(json.dumps({"error": "LI_KEYWORDS required"}))
    sys.exit(1)

try:
    from open_linkedin_api import Linkedin
    from requests.cookies import RequestsCookieJar
    jar = RequestsCookieJar()
    jar.set("li_at", li_at)
    js_val = jsessionid if jsessionid else "ajax:0"
    if not js_val.startswith('"'): js_val = f'"{js_val}"'
    jar.set("JSESSIONID", js_val)
    api = Linkedin("", "", cookies=jar, authenticate=False)

    raw = api.search_people(keywords=keywords, network_depth=depth, limit=limit) or []
    results = []
    for p in raw:
        mp = p.get("miniProfile", p)
        first = mp.get("firstName", "")
        last  = mp.get("lastName", "")
        slug  = mp.get("publicIdentifier", "")
        results.append({
            "name":      f"{first} {last}".strip(),
            "headline":  mp.get("occupation", ""),
            "location":  mp.get("locationName", ""),
            "public_id": slug,
            "url":       f"https://www.linkedin.com/in/{slug}" if slug else "",
        })
    print(json.dumps({"results": results}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

// Gated: fetch a specific person's profile by public_id (PRD: get_person_profile)
const GET_PERSON_SCRIPT = `
import http.client, io, json, os, sys, urllib.parse
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
_orig_putheader = http.client.HTTPConnection.putheader
def _utf8_safe_putheader(self, header, *values):
    safe = []
    for v in values:
        if isinstance(v, str):
            try: v.encode("latin-1")
            except UnicodeEncodeError: v = urllib.parse.quote(v, safe=":/?#[]@!$&'()*+,;=% ")
        safe.append(v)
    return _orig_putheader(self, header, *safe)
http.client.HTTPConnection.putheader = _utf8_safe_putheader
import re as _re

li_at      = os.environ.get("LI_AT", "")
jsessionid = os.environ.get("LI_JSESSIONID", "")
public_id  = os.environ.get("LI_PUBLIC_ID", "")

if li_at:
    m = _re.search(r'AQED[A-Za-z0-9_-]+', li_at)
    if m: li_at = m.group(0)
if jsessionid:
    m = _re.search(r'ajax:\\d+', jsessionid)
    if m: jsessionid = m.group(0)

if not li_at:
    print(json.dumps({"error": "LI_AT not set"}))
    sys.exit(1)
if not public_id.strip():
    print(json.dumps({"error": "LI_PUBLIC_ID required"}))
    sys.exit(1)

try:
    from open_linkedin_api import Linkedin
    from requests.cookies import RequestsCookieJar
    jar = RequestsCookieJar()
    jar.set("li_at", li_at)
    js_val = jsessionid if jsessionid else "ajax:0"
    if not js_val.startswith('"'): js_val = f'"{js_val}"'
    jar.set("JSESSIONID", js_val)
    api = Linkedin("", "", cookies=jar, authenticate=False)

    profile = api.get_profile(public_id=public_id) or {}
    experience = []
    for exp in (profile.get("experience") or []):
        experience.append({
            "title":   exp.get("title", ""),
            "company": exp.get("companyName", "") or exp.get("company", {}).get("miniCompany", {}).get("name", ""),
        })
    skills = [s.get("name", "") if isinstance(s, dict) else str(s) for s in (profile.get("skills") or []) if s]
    print(json.dumps({
        "profile": {
            "firstName":  profile.get("firstName", ""),
            "lastName":   profile.get("lastName", ""),
            "headline":   profile.get("headline", ""),
            "summary":    (profile.get("summary") or "")[:500],
            "location":   profile.get("locationName", ""),
            "public_id":  public_id,
            "url":        f"https://www.linkedin.com/in/{public_id}",
            "experience": experience[:5],
            "skills":     skills[:20],
        }
    }))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

// Gated: fetch a company profile by public_id (PRD: get_company_profile)
const GET_COMPANY_SCRIPT = `
import http.client, io, json, os, sys, urllib.parse
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
_orig_putheader = http.client.HTTPConnection.putheader
def _utf8_safe_putheader(self, header, *values):
    safe = []
    for v in values:
        if isinstance(v, str):
            try: v.encode("latin-1")
            except UnicodeEncodeError: v = urllib.parse.quote(v, safe=":/?#[]@!$&'()*+,;=% ")
        safe.append(v)
    return _orig_putheader(self, header, *safe)
http.client.HTTPConnection.putheader = _utf8_safe_putheader
import re as _re

li_at      = os.environ.get("LI_AT", "")
jsessionid = os.environ.get("LI_JSESSIONID", "")
public_id  = os.environ.get("LI_PUBLIC_ID", "")

if li_at:
    m = _re.search(r'AQED[A-Za-z0-9_-]+', li_at)
    if m: li_at = m.group(0)
if jsessionid:
    m = _re.search(r'ajax:\\d+', jsessionid)
    if m: jsessionid = m.group(0)

if not li_at:
    print(json.dumps({"error": "LI_AT not set"}))
    sys.exit(1)
if not public_id.strip():
    print(json.dumps({"error": "LI_PUBLIC_ID required"}))
    sys.exit(1)

try:
    from open_linkedin_api import Linkedin
    from requests.cookies import RequestsCookieJar
    jar = RequestsCookieJar()
    jar.set("li_at", li_at)
    js_val = jsessionid if jsessionid else "ajax:0"
    if not js_val.startswith('"'): js_val = f'"{js_val}"'
    jar.set("JSESSIONID", js_val)
    api = Linkedin("", "", cookies=jar, authenticate=False)

    company = api.get_company(public_id) or {}
    print(json.dumps({
        "company": {
            "name":        company.get("name", ""),
            "description": (company.get("description") or "")[:500],
            "industry":    company.get("industries", [None])[0] if company.get("industries") else "",
            "website":     company.get("companyPageUrl", ""),
            "headcount":   company.get("staffCount", 0),
            "specialities": company.get("specialities", [])[:10],
            "public_id":   public_id,
            "url":         f"https://www.linkedin.com/company/{public_id}",
        }
    }))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

interface LinkedInProfile {
  firstName?: string;
  lastName?: string;
  headline?: string;
  summary?: string;
  location?: string;
  experience?: Array<{ title?: string; company?: string; description?: string }>;
  skills?: string[];
}

export interface LinkedInPersonResult {
  name: string;
  headline: string;
  location: string;
  public_id: string;
  url: string;
  experience?: Array<{ title?: string; company?: string }>;
  skills?: string[];
}

export interface LinkedInCompanyResult {
  name: string;
  description: string;
  industry: string;
  website: string;
  headcount: number;
  specialities: string[];
  public_id: string;
  url: string;
}

interface SyncResult {
  profile_text: string;
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
      // 429, CAPTCHA, checkpoint, or 302 redirect loop → rate-limited, engage cooldown
      if (
        msg.includes("429") ||
        msg.includes("CAPTCHA") ||
        msg.includes("checkpoint") ||
        msg.includes("302") ||
        msg.includes("infinite loop") ||
        msg.includes("redirect")
      ) {
        await engageCooldown().catch(() => {});
        throw new Error("LinkedIn rate-limited — cooldown engaged, retry in ~1 hour");
      }
      // Stale/expired li_at
      if (
        msg.includes("session_expired") ||
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
        ["run", "--with", "cryptography", "--with", "open-linkedin-api", "python3", scriptPath],
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

  /** PRD: search_people — keyword search, gated (max 25 results, rate-limited). */
  async searchPeople(opts: {
    keywords: string;
    depth?: "F" | "S" | "O";
    limit?: number;
  }): Promise<LinkedInPersonResult[]> {
    await acquireRateSlot();
    const scriptPath = LinkedInConnector.writeTempScript(SEARCH_PEOPLE_SCRIPT);
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LI_AT: this.liAt!,
        LI_JSESSIONID: this.jsessionid ?? "",
        LI_KEYWORDS: opts.keywords,
        LI_DEPTH: opts.depth ?? "F",
        LI_LIMIT: String(Math.min(opts.limit ?? 10, 25)),
      };
      const proc = child_process.spawn(
        "uv",
        ["run", "--with", "open-linkedin-api", "python3", scriptPath],
        { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }
      );
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", () => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        let parsed: { error?: string; results?: LinkedInPersonResult[] };
        try { parsed = JSON.parse(lastLine); }
        catch { return reject(new Error(`search script unexpected output: ${lastLine || stderr.slice(0, 200)}`)); }
        if (parsed.error) return reject(new Error(parsed.error));
        resolve(parsed.results ?? []);
      });
    });
  }

  /** PRD: get_person_profile — single profile lookup by public_id, gated (rate-limited). */
  async getPersonProfile(publicId: string): Promise<LinkedInPersonResult> {
    await acquireRateSlot();
    const scriptPath = LinkedInConnector.writeTempScript(GET_PERSON_SCRIPT);
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LI_AT: this.liAt!,
        LI_JSESSIONID: this.jsessionid ?? "",
        LI_PUBLIC_ID: publicId,
      };
      const proc = child_process.spawn(
        "uv",
        ["run", "--with", "open-linkedin-api", "python3", scriptPath],
        { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }
      );
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", () => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        let parsed: { error?: string; profile?: LinkedInPersonResult };
        try { parsed = JSON.parse(lastLine); }
        catch { return reject(new Error(`person script unexpected output: ${lastLine || stderr.slice(0, 200)}`)); }
        if (parsed.error) return reject(new Error(parsed.error));
        if (!parsed.profile) return reject(new Error(`profile not found: ${publicId}`));
        resolve(parsed.profile);
      });
    });
  }

  /** PRD: get_company_profile — company lookup for org verification, gated (rate-limited). */
  async getCompanyProfile(publicId: string): Promise<LinkedInCompanyResult> {
    await acquireRateSlot();
    const scriptPath = LinkedInConnector.writeTempScript(GET_COMPANY_SCRIPT);
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LI_AT: this.liAt!,
        LI_JSESSIONID: this.jsessionid ?? "",
        LI_PUBLIC_ID: publicId,
      };
      const proc = child_process.spawn(
        "uv",
        ["run", "--with", "open-linkedin-api", "python3", scriptPath],
        { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }
      );
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", () => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        let parsed: { error?: string; company?: LinkedInCompanyResult };
        try { parsed = JSON.parse(lastLine); }
        catch { return reject(new Error(`company script unexpected output: ${lastLine || stderr.slice(0, 200)}`)); }
        if (parsed.error) return reject(new Error(parsed.error));
        if (!parsed.company) return reject(new Error(`company not found: ${publicId}`));
        resolve(parsed.company);
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
        // SYNC_SCRIPT uses stdlib urllib only — no packages needed
        ["run", "python3", scriptPath],
        { env, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 }
      );

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("error", reject);
      proc.on("close", () => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        let parsed: { error?: string; profile_text?: string; profile?: LinkedInProfile };
        try {
          parsed = JSON.parse(lastLine);
        } catch {
          return reject(new Error(`sync script unexpected output: ${lastLine || stderr.slice(0, 300)}`));
        }
        if (parsed.error) return reject(new Error(parsed.error));
        resolve({ profile_text: parsed.profile_text ?? "", profile: parsed.profile });
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
