import { canonicalJson } from "./a2a/canonical.js";
import { Ed25519Keypair, sign } from "./identity.js";
import type { SearchRequest, SearchResult } from "./types.js";

export interface RegisterEntityOpts {
  registryUrl: string;
  keypair: Ed25519Keypair;
  name: string;
  entityUrl: string;
  category?: string;
  tags?: string[];
  summary?: string;
  capabilitySummary?: Record<string, unknown>;
  developerId?: string;
  developerProof?: Record<string, unknown>;
  entityName?: string;
  version?: string;
  entityType?: string;
  serviceEndpoint?: string;
  openapiUrl?: string;
  entityPricing?: Record<string, unknown>;
}

export interface UpdateEntityOpts {
  registryUrl: string;
  entityId: string;
  keypair: Ed25519Keypair;
  fields: {
    name?: string;
    entity_url?: string;
    category?: string;
    tags?: string[];
    summary?: string;
    [key: string]: unknown;
  };
}

export interface DeleteEntityOpts {
  registryUrl: string;
  entityId: string;
  keypair: Ed25519Keypair;
}

export interface SearchEntitiesOpts {
  registryUrl: string;
  query: SearchRequest;
}

// Builds canonical JSON bytes for the registration signable payload.
// Go's json.Marshal on map[string]interface{} sorts keys lexicographically,
// produces compact JSON with raw UTF-8 — canonicalJson matches this exactly.
function buildRegistrationSignable(
  name: string,
  entityUrl: string,
  category: string,
  summary: string,
  tags: string[],
  publicKey: string,
  entityType?: string
): Uint8Array {
  const signable: Record<string, unknown> = {
    category,
    entity_url: entityUrl,
    name,
    public_key: publicKey,
    summary,
    tags,
  };
  // entity_type is only added when explicitly provided — matches Go's conditional include
  if (entityType !== undefined && entityType !== "") {
    signable["entity_type"] = entityType;
  }
  return new TextEncoder().encode(canonicalJson(signable));
}

// POST /v1/entities — registers a new entity.
// The server verifies Ed25519 signature over canonical JSON of the payload.
// Returns the entity_id assigned by the registry, falling back to keypair-derived ID.
export async function registerEntity(opts: RegisterEntityOpts): Promise<string> {
  const {
    registryUrl,
    keypair,
    name,
    entityUrl,
    category = "general",
    tags = [],
    summary = "",
    capabilitySummary,
    developerId,
    developerProof,
    entityName,
    version,
    entityType,
    serviceEndpoint,
    openapiUrl,
    entityPricing,
  } = opts;

  const signableBytes = buildRegistrationSignable(
    name, entityUrl, category, summary, tags, keypair.publicKeyString, entityType
  );
  const signature = sign(keypair.privateKeyBytes, signableBytes);

  const body: Record<string, unknown> = {
    category,
    entity_url: entityUrl,
    name,
    public_key: keypair.publicKeyString,
    signature,
    summary,
    tags,
  };

  if (entityType) body["entity_type"] = entityType;
  if (serviceEndpoint) body["service_endpoint"] = serviceEndpoint;
  if (openapiUrl) body["openapi_url"] = openapiUrl;
  if (entityPricing) body["entity_pricing"] = entityPricing;
  if (capabilitySummary) body["capability_summary"] = capabilitySummary;
  if (developerId) body["developer_id"] = developerId;
  if (developerProof) body["developer_proof"] = developerProof;
  if (entityName) body["entity_name"] = entityName;
  if (version) body["version"] = version;

  let resp: Response;
  try {
    resp = await fetch(`${registryUrl}/v1/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`registerEntity: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`registerEntity: HTTP ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as { entity_id?: string };
  return data.entity_id ?? keypair.entityId;
}

// GET /v1/entities/{id} — returns the entity record or null on 404.
export async function getEntity(
  registryUrl: string,
  entityId: string
): Promise<Record<string, unknown> | null> {
  const url = `${registryUrl}/v1/entities/${encodeURIComponent(entityId)}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`getEntity: network error: ${String(err)}`, { cause: err });
  }

  if (resp.status === 404) return null;

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`getEntity: HTTP ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<Record<string, unknown>>;
}

/**
 * GET /v1/developers/{id} — fetches the developer record by developer_id
 * (`zns:dev:<hash>`). Returns null if the registry has no record yet (e.g.
 * developer keypair was created but the handle was never claimed via
 * `zynd auth login`). Used by buildRuntimeCard to auto-populate the agent card's
 * provider block.
 */
export async function getDeveloper(
  registryUrl: string,
  developerId: string,
): Promise<Record<string, unknown> | null> {
  const url = `${registryUrl}/v1/developers/${encodeURIComponent(developerId)}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`getDeveloper: network error: ${String(err)}`, { cause: err });
  }
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`getDeveloper: HTTP ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<Record<string, unknown>>;
}

// Canonical JSON as raw UTF-8 bytes — convenience wrapper for signing payloads.
function canonicalJsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(obj));
}

// PUT /v1/entities/{id} — updates an entity.
// Two-step signing to match the Python SDK:
//   1. Sign the updates dict, embed body-level `signature` field.
//   2. Serialize full body (with signature), sign again for Authorization header.
export async function updateEntity(opts: UpdateEntityOpts): Promise<Record<string, unknown>> {
  const url = `${opts.registryUrl}/v1/entities/${encodeURIComponent(opts.entityId)}`;

  const bodySig = sign(opts.keypair.privateKeyBytes, canonicalJsonBytes(opts.fields));
  const bodyWithSig = { ...opts.fields, signature: bodySig };

  const fullBodyBytes = canonicalJsonBytes(bodyWithSig);
  const authSignature = sign(opts.keypair.privateKeyBytes, fullBodyBytes);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authSignature}`,
      },
      body: fullBodyBytes,
    });
  } catch (err) {
    throw new Error(`updateEntity: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`updateEntity: HTTP ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<Record<string, unknown>>;
}

// DELETE /v1/entities/{id} — deregisters an entity.
// Authorization signature is over the entity_id as raw UTF-8 bytes.
// This matches Go's: verifyDualKeyOwnership(store, agent, []byte(agentID), header)
export async function deleteEntity(opts: DeleteEntityOpts): Promise<void> {
  const url = `${opts.registryUrl}/v1/entities/${encodeURIComponent(opts.entityId)}`;
  const idBytes = new TextEncoder().encode(opts.entityId);
  const authSignature = sign(opts.keypair.privateKeyBytes, idBytes);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authSignature}` },
    });
  } catch (err) {
    throw new Error(`deleteEntity: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`deleteEntity: HTTP ${resp.status}: ${text}`);
  }
}

// POST /v1/search — ranked entity search with optional filters.
export async function searchEntities(opts: SearchEntitiesOpts): Promise<SearchResult> {
  const url = `${opts.registryUrl}/v1/search`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.query),
    });
  } catch (err) {
    throw new Error(`searchEntities: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`searchEntities: HTTP ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<SearchResult>;
}

// GET /v1/entities/{id}/card — fetches the entity's signed agent card, or null on 404.
export async function getEntityCard(
  registryUrl: string,
  entityId: string
): Promise<Record<string, unknown> | null> {
  const url = `${registryUrl}/v1/entities/${encodeURIComponent(entityId)}/card`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`getEntityCard: network error: ${String(err)}`, { cause: err });
  }

  if (resp.status === 404) return null;

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`getEntityCard: HTTP ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<Record<string, unknown>>;
}

// GET /v1/handles/{handle}/available — returns handle availability with optional reason.
export async function checkHandleAvailable(
  registryUrl: string,
  handle: string
): Promise<{ handle: string; available: boolean; reason?: string }> {
  const url = `${registryUrl}/v1/handles/${encodeURIComponent(handle)}/available`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`checkHandleAvailable: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`checkHandleAvailable: HTTP ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as { handle?: string; available?: boolean; reason?: string };
  return {
    handle: data.handle ?? handle,
    available: Boolean(data.available),
    reason: data.reason,
  };
}

// POST /v1/search with fqan filter — resolves the FQAN for an entity, or null if not found.
export async function getEntityFqan(
  registryUrl: string,
  entityId: string
): Promise<string | null> {
  const url = `${registryUrl}/v1/search`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fqan: entityId, max_results: 1 }),
    });
  } catch (err) {
    throw new Error(`getEntityFqan: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`getEntityFqan: HTTP ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as SearchResult;
  const first = data.results?.[0] as (SearchResult["results"][number] & { fqan?: string }) | undefined;
  return first?.fqan ?? null;
}

// GET /v1/info — returns registry node metadata (registry_id, version, capabilities).
export async function getRegistryInfo(registryUrl: string): Promise<Record<string, unknown>> {
  const url = `${registryUrl}/v1/info`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`getRegistryInfo: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`getRegistryInfo: HTTP ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<Record<string, unknown>>;
}

// GET /v1/names/{developer}/{entity}/available — checks if an entity name is available.
export async function checkEntityNameAvailable(
  registryUrl: string,
  developerHandle: string,
  entityName: string
): Promise<{ developer: string; entity_name: string; available: boolean; reason?: string }> {
  const url = `${registryUrl}/v1/names/${encodeURIComponent(developerHandle)}/${encodeURIComponent(entityName)}/available`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`checkEntityNameAvailable: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`checkEntityNameAvailable: HTTP ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as {
    developer?: string;
    entity_name?: string;
    available?: boolean;
    reason?: string;
  };
  return {
    developer: data.developer ?? developerHandle,
    entity_name: data.entity_name ?? entityName,
    available: Boolean(data.available),
    reason: data.reason,
  };
}

// GET /v1/categories — returns known entity categories.
export async function getCategories(registryUrl: string): Promise<string[]> {
  const url = `${registryUrl}/v1/categories`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`getCategories: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`getCategories: HTTP ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<string[]>;
}

// GET /v1/tags — returns known entity tags.
export async function getTags(registryUrl: string): Promise<string[]> {
  const url = `${registryUrl}/v1/tags`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`getTags: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`getTags: HTTP ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<string[]>;
}

// GET /v1/network/status — returns network status metadata, or null on error.
export async function getNetworkStatus(registryUrl: string): Promise<Record<string, unknown> | null> {
  const url = `${registryUrl}/v1/network/status`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`getNetworkStatus: network error: ${String(err)}`, { cause: err });
  }

  if (!resp.ok) {
    return null;
  }

  return resp.json() as Promise<Record<string, unknown>>;
}
