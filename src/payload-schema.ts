import { z } from "zod";

/**
 * Minimal Zod -> JSON Schema converter for the shapes users put in
 * RequestPayload / ResponsePayload — the advertised contract at
 * /.well-known/agent.json.
 *
 * Covers z.object, z.array, z.string, z.number, z.boolean, z.literal,
 * z.enum, z.nativeEnum, z.optional, z.nullable, z.union, z.record, z.any,
 * z.unknown, z.null, z.date, and objects with .passthrough(). Unknown /
 * custom Zod types fall back to `{}` (accept anything) rather than
 * throwing — advertising an overly permissive schema is strictly better
 * than crashing the boot.
 *
 * This is deliberately small. Users who need faithful conversion of
 * discriminated unions, refinements, brand types, or z.effects should add
 * `zod-to-json-schema` and call its exports into the card manually.
 */
export function zodToAdvertisedJsonSchema(
  schema: z.ZodTypeAny | undefined,
): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  try {
    return convert(schema);
  } catch {
    return undefined;
  }
}

function convert(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName?: string } })._def;
  const typeName = def?.typeName;

  switch (typeName) {
    case "ZodString": {
      const out: Record<string, unknown> = { type: "string" };
      const checks = (def as unknown as { checks?: Array<Record<string, unknown>> }).checks ?? [];
      for (const c of checks) {
        if (c["kind"] === "min") out["minLength"] = c["value"];
        if (c["kind"] === "max") out["maxLength"] = c["value"];
        if (c["kind"] === "email") out["format"] = "email";
        if (c["kind"] === "url") out["format"] = "uri";
        if (c["kind"] === "uuid") out["format"] = "uuid";
        if (c["kind"] === "regex" && c["regex"] instanceof RegExp) {
          out["pattern"] = (c["regex"] as RegExp).source;
        }
      }
      attachDescription(out, schema);
      return out;
    }

    case "ZodNumber": {
      const out: Record<string, unknown> = { type: "number" };
      const checks = (def as unknown as { checks?: Array<Record<string, unknown>> }).checks ?? [];
      for (const c of checks) {
        if (c["kind"] === "int") out["type"] = "integer";
        if (c["kind"] === "min") out[c["inclusive"] ? "minimum" : "exclusiveMinimum"] = c["value"];
        if (c["kind"] === "max") out[c["inclusive"] ? "maximum" : "exclusiveMaximum"] = c["value"];
      }
      attachDescription(out, schema);
      return out;
    }

    case "ZodBoolean":
      return withDesc({ type: "boolean" }, schema);

    case "ZodNull":
      return withDesc({ type: "null" }, schema);

    case "ZodAny":
    case "ZodUnknown":
      return withDesc({}, schema);

    case "ZodDate":
      return withDesc({ type: "string", format: "date-time" }, schema);

    case "ZodLiteral": {
      const value = (def as unknown as { value: unknown }).value;
      return withDesc({ const: value }, schema);
    }

    case "ZodEnum": {
      const values = (def as unknown as { values: string[] }).values;
      return withDesc({ type: "string", enum: [...values] }, schema);
    }

    case "ZodNativeEnum": {
      const values = (def as unknown as { values: Record<string, string | number> }).values;
      return withDesc({ enum: Object.values(values) }, schema);
    }

    case "ZodArray": {
      const items = (def as unknown as { type: z.ZodTypeAny }).type;
      return withDesc({ type: "array", items: convert(items) }, schema);
    }

    case "ZodRecord": {
      const valueType = (def as unknown as { valueType: z.ZodTypeAny }).valueType;
      return withDesc(
        { type: "object", additionalProperties: convert(valueType) },
        schema,
      );
    }

    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options =
        (def as unknown as { options: z.ZodTypeAny[] }).options ??
        Array.from(
          ((def as unknown as { optionsMap?: Map<string, z.ZodTypeAny> }).optionsMap?.values?.() ?? []),
        );
      return withDesc({ anyOf: options.map((o) => convert(o)) }, schema);
    }

    case "ZodOptional": {
      const inner = (def as unknown as { innerType: z.ZodTypeAny }).innerType;
      return convert(inner);
    }

    case "ZodNullable": {
      const inner = (def as unknown as { innerType: z.ZodTypeAny }).innerType;
      const base = convert(inner);
      const baseType = base["type"];
      if (typeof baseType === "string") {
        return { ...base, type: [baseType, "null"] };
      }
      return { anyOf: [base, { type: "null" }] };
    }

    case "ZodDefault":
    case "ZodEffects":
    case "ZodBranded":
    case "ZodReadonly":
    case "ZodCatch":
    case "ZodPipeline": {
      const inner =
        (def as unknown as { schema?: z.ZodTypeAny; innerType?: z.ZodTypeAny; in?: z.ZodTypeAny })
          .innerType ??
        (def as unknown as { schema?: z.ZodTypeAny }).schema ??
        (def as unknown as { in?: z.ZodTypeAny }).in;
      return inner ? convert(inner) : {};
    }

    case "ZodObject":
      return convertObject(schema as unknown as z.ZodObject<z.ZodRawShape>);

    default:
      // Unknown / custom Zod type — advertise an open object.
      return withDesc({}, schema);
  }
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const fieldSchema = field as z.ZodTypeAny;
    properties[key] = convert(fieldSchema);
    if (!isOptional(fieldSchema)) required.push(key);
  }

  const out: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) out["required"] = required;

  const unknownKeys = (schema as unknown as { _def: { unknownKeys?: string } })._def.unknownKeys;
  if (unknownKeys === "passthrough") {
    out["additionalProperties"] = true;
  } else if (unknownKeys === "strict") {
    out["additionalProperties"] = false;
  }

  attachDescription(out, schema);
  return out;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = (schema as unknown as { _def: { typeName?: string } })._def;
  if (!def) return false;
  return (
    def.typeName === "ZodOptional" ||
    def.typeName === "ZodDefault" ||
    def.typeName === "ZodNullable"
  );
}

function withDesc(out: Record<string, unknown>, schema: z.ZodTypeAny): Record<string, unknown> {
  attachDescription(out, schema);
  return out;
}

function attachDescription(out: Record<string, unknown>, schema: z.ZodTypeAny): void {
  const desc = (schema as unknown as { description?: string }).description;
  if (typeof desc === "string" && desc) out["description"] = desc;
}

/**
 * Walk a Zod schema and report whether any field is `z.array(Attachment)`
 * (object with filename + mime_type + data/url). Triggers the
 * `accepts_files: true` flag on the entity card so callers know file
 * upload is supported without inspecting the schema themselves.
 */
export function detectsAttachments(schema: z.ZodTypeAny | undefined): boolean {
  if (!schema) return false;
  try {
    const ad = zodToAdvertisedJsonSchema(schema);
    return containsAttachmentArray(ad);
  } catch {
    return false;
  }
}

function containsAttachmentArray(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "array") {
    const items = obj["items"];
    if (items && typeof items === "object") {
      const itemProps = (items as Record<string, unknown>)["properties"];
      if (itemProps && typeof itemProps === "object") {
        const keys = Object.keys(itemProps as Record<string, unknown>);
        const looksLikeAttachment =
          keys.includes("filename") &&
          keys.includes("mime_type") &&
          (keys.includes("data") || keys.includes("url"));
        if (looksLikeAttachment) return true;
      }
    }
  }
  for (const v of Object.values(obj)) {
    if (containsAttachmentArray(v)) return true;
  }
  return false;
}

export interface SchemaAdvertisement {
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  accepts_files?: boolean;
}

export function zodSchemaAdvertisement(
  payloadModel: z.ZodTypeAny | undefined,
  outputModel: z.ZodTypeAny | undefined,
): SchemaAdvertisement {
  const ad: SchemaAdvertisement = {};
  const input = zodToAdvertisedJsonSchema(payloadModel);
  const output = zodToAdvertisedJsonSchema(outputModel);
  if (input) ad.input_schema = input;
  if (output) ad.output_schema = output;
  if (detectsAttachments(payloadModel)) ad.accepts_files = true;
  return ad;
}
