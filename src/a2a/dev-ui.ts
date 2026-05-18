import type * as z from "zod";

interface FieldDef {
  name: string;
  zodType: string;
  required: boolean;
}

function extractFields(schema: z.ZodTypeAny | undefined): FieldDef[] {
  if (!schema) return [{ name: "input", zodType: "ZodString", required: true }];

  // Unwrap outer wrappers to reach ZodObject
  let s: Record<string, unknown> = schema as unknown as Record<string, unknown>;
  while (
    s?.["_def"] &&
    ["ZodOptional", "ZodNullable", "ZodDefault"].includes(
      (s["_def"] as Record<string, unknown>)["typeName"] as string,
    )
  ) {
    const def = s["_def"] as Record<string, unknown>;
    s = (def["innerType"] ?? def["schema"]) as Record<string, unknown>;
  }

  const typeName = (s?.["_def"] as Record<string, unknown>)?.["typeName"];
  if (typeName !== "ZodObject") return [{ name: "input", zodType: "ZodString", required: true }];

  const shape = (s as unknown as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodTypeAny>;
  return Object.entries(shape).map(([name, field]) => {
    let f: Record<string, unknown> = field as unknown as Record<string, unknown>;
    let optional = false;
    while (
      f?.["_def"] &&
      ["ZodOptional", "ZodNullable", "ZodDefault"].includes(
        (f["_def"] as Record<string, unknown>)["typeName"] as string,
      )
    ) {
      optional = true;
      const def = f["_def"] as Record<string, unknown>;
      f = (def["innerType"] ?? def["schema"]) as Record<string, unknown>;
    }
    const innerType = ((f?.["_def"] as Record<string, unknown>)?.["typeName"] as string) ?? "ZodString";
    return { name, zodType: innerType, required: !optional };
  });
}

function fieldToHtml(field: FieldDef): string {
  const label = field.name + (field.required ? " *" : "");
  const id = `field-${field.name}`;
  const isMainText = ["input", "message", "query", "prompt", "text"].includes(field.name);

  let input: string;
  switch (field.zodType) {
    case "ZodBoolean":
      input = `<label class="checkbox-label"><input type="checkbox" id="${id}" name="${field.name}"> ${field.name}</label>`;
      return `<div class="field checkbox-field">${input}</div>`;
    case "ZodNumber":
    case "ZodBigInt":
      input = `<input type="number" id="${id}" name="${field.name}" ${field.required ? "required" : ""} placeholder="0">`;
      break;
    case "ZodArray":
    case "ZodObject":
    case "ZodRecord":
      input = `<textarea id="${id}" name="${field.name}" rows="4" placeholder='[]'></textarea>`;
      break;
    default:
      // ZodString and everything else
      input = isMainText
        ? `<textarea id="${id}" name="${field.name}" rows="5" ${field.required ? "required" : ""} placeholder="Enter your message…"></textarea>`
        : `<input type="text" id="${id}" name="${field.name}" ${field.required ? "required" : ""} placeholder="${field.name}">`;
  }

  return `<div class="field"><label for="${id}">${label}</label>${input}</div>`;
}

export function buildDevUiHtml(opts: {
  agentName: string;
  a2aPath: string;
  payloadSchema?: z.ZodTypeAny;
}): string {
  const { agentName, a2aPath, payloadSchema } = opts;
  const fields = extractFields(payloadSchema);
  const formFields = fields.map(fieldToHtml).join("\n");

  // Serialise field names to JSON for the client-side JS
  const fieldNames = JSON.stringify(
    fields.map((f) => ({ name: f.name, type: f.zodType, required: f.required })),
  );

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>[dev] ${agentName}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --accent: #8b5cf6; --accent2: #06b6d4;
    --text: #e2e8f0; --muted: #64748b; --error: #f87171; --ok: #34d399;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'Fira Code', 'Cascadia Code', monospace;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--font);
    min-height: 100vh; padding: 2rem 1rem; }
  .container { max-width: 720px; margin: 0 auto; }

  header { margin-bottom: 2rem; }
  h1 { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: .6rem; }
  .badge { background: var(--accent); color: #fff; font-size: .65rem;
    padding: .2rem .5rem; border-radius: 999px; font-weight: 600;
    letter-spacing: .08em; text-transform: uppercase; }
  .endpoint { color: var(--muted); font-size: .8rem; margin-top: .4rem;
    font-family: var(--mono); }

  .card { background: var(--surface); border: 1px solid var(--border);
    border-radius: .75rem; padding: 1.5rem; margin-bottom: 1.5rem; }
  .card-title { font-size: .7rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: .1em; color: var(--muted); margin-bottom: 1rem; }

  .field { display: flex; flex-direction: column; gap: .4rem; margin-bottom: 1rem; }
  .field:last-child { margin-bottom: 0; }
  label { font-size: .8rem; font-weight: 500; color: var(--muted); }
  input[type=text], input[type=number], textarea {
    background: var(--bg); border: 1px solid var(--border); border-radius: .4rem;
    color: var(--text); font-family: var(--font); font-size: .9rem;
    padding: .6rem .8rem; width: 100%; outline: none; resize: vertical; }
  input:focus, textarea:focus { border-color: var(--accent); }
  textarea { min-height: 80px; }
  .checkbox-field { flex-direction: row; align-items: center; }
  .checkbox-label { display: flex; align-items: center; gap: .5rem;
    font-size: .9rem; cursor: pointer; }
  input[type=checkbox] { width: 1rem; height: 1rem; accent-color: var(--accent); }

  button[type=submit] {
    background: var(--accent); border: none; border-radius: .5rem;
    color: #fff; cursor: pointer; font-size: .9rem; font-weight: 600;
    padding: .7rem 1.4rem; width: 100%; margin-top: .5rem; transition: opacity .15s; }
  button[type=submit]:hover { opacity: .85; }
  button[type=submit]:disabled { opacity: .4; cursor: not-allowed; }

  #resp { display: none; }
  .resp-header { display: flex; align-items: center; justify-content: space-between;
    margin-bottom: .75rem; }
  .status-ok  { color: var(--ok);  font-size: .8rem; font-weight: 600; }
  .status-err { color: var(--error); font-size: .8rem; font-weight: 600; }
  pre { background: var(--bg); border: 1px solid var(--border); border-radius: .4rem;
    color: var(--text); font-family: var(--mono); font-size: .8rem;
    overflow-x: auto; padding: 1rem; white-space: pre-wrap; word-break: break-word; }
  .spinner { display: inline-block; width: .9rem; height: .9rem;
    border: 2px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>${agentName} <span class="badge">dev</span></h1>
    <p class="endpoint">POST ${a2aPath} &nbsp;·&nbsp; auth: open</p>
  </header>

  <div class="card">
    <p class="card-title">Request</p>
    <form id="form">
${formFields}
      <button type="submit" id="btn">Send</button>
    </form>
  </div>

  <div class="card" id="resp">
    <div class="resp-header">
      <p class="card-title">Response</p>
      <span id="resp-status"></span>
    </div>
    <pre id="resp-body"></pre>
  </div>
</div>

<script>
const FIELDS = ${fieldNames};
const A2A_PATH = ${JSON.stringify(a2aPath)};

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = document.getElementById('btn');
  const respDiv = document.getElementById('resp');
  const respStatus = document.getElementById('resp-status');
  const respBody = document.getElementById('resp-body');

  // Collect values
  const values = {};
  for (const f of FIELDS) {
    const el = form.elements[f.name];
    if (!el) continue;
    if (f.type === 'ZodBoolean') values[f.name] = el.checked;
    else if (f.type === 'ZodNumber') values[f.name] = el.value === '' ? null : Number(el.value);
    else if (f.type === 'ZodArray' || f.type === 'ZodObject' || f.type === 'ZodRecord') {
      try { values[f.name] = JSON.parse(el.value || 'null'); } catch { values[f.name] = el.value; }
    } else {
      values[f.name] = el.value;
    }
  }

  // Build message text — use 'input' field if present, else JSON of all values
  const mainField = FIELDS.find(f => ['input','message','query','prompt','text'].includes(f.name));
  const text = mainField ? (values[mainField.name] ?? '') : JSON.stringify(values);
  const otherValues = Object.fromEntries(Object.entries(values).filter(([k]) => k !== mainField?.name));
  const finalText = Object.keys(otherValues).length
    ? JSON.stringify({ input: text, ...otherValues })
    : String(text);

  const body = {
    jsonrpc: '2.0',
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text: finalText }],
        messageId: 'dev-' + Date.now(),
      }
    },
    id: 'dev-' + Date.now(),
  };

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  respDiv.style.display = 'none';

  try {
    const res = await fetch(A2A_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    respDiv.style.display = 'block';
    respStatus.className = res.ok ? 'status-ok' : 'status-err';
    respStatus.textContent = res.ok ? '✓ ' + res.status : '✗ ' + res.status;
    respBody.textContent = JSON.stringify(json, null, 2);
  } catch (err) {
    respDiv.style.display = 'block';
    respStatus.className = 'status-err';
    respStatus.textContent = '✗ Network error';
    respBody.textContent = String(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
});
</script>
</body>
</html>`;
}
