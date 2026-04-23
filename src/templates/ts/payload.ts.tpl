/**
 * Request + response schemas for __AGENT_NAME__.
 *
 * Edit `RequestPayload` to declare what callers send, and `ResponsePayload`
 * to declare what they receive. Both JSON Schemas are auto-advertised at
 * /.well-known/agent.json (as `input_schema` and `output_schema`) so callers
 * can discover the contract without reading your code.
 *
 * RequestPayload examples (uncomment and adapt):
 *
 *   export const RequestPayload = z.object({
 *     name: z.string(),
 *     email: z.string().email(),
 *     age: z.number().int(),
 *     gender: z.enum(["m", "f", "other"]),
 *     // A required PDF upload with mime-type whitelist:
 *     resume: z.array(Attachment).min(1).describe(
 *       "accepted_mime_types=application/pdf",
 *     ),
 *   });
 *
 * ResponsePayload examples:
 *
 *   export const ResponsePayload = z.object({
 *     status: z.enum(["ok", "error"]),
 *     user_id: z.string(),
 *     message: z.string(),
 *   });
 */

import { z } from "zod";

/**
 * Attachment schema — matches the Python SDK's Attachment model.
 * Declare a `z.array(Attachment)` field on RequestPayload to advertise
 * `accepts_files: true` on the entity card.
 */
export const Attachment = z.object({
  filename: z.string(),
  mime_type: z.string(),
  // Base64-encoded bytes; total body size is capped by MAX_FILE_SIZE_BYTES.
  data: z.string(),
});

/**
 * Schema for requests to this agent.
 *
 * Starts identical to the default AgentPayload so existing callers keep
 * working. Add your own fields and they'll show up in /.well-known/agent.json
 * automatically.
 *
 * File attachments are opt-in: declare a `z.array(Attachment)` field (any
 * name you like) and the agent will advertise `accepts_files: true`. Without
 * such a field, file support is not offered.
 */
export const RequestPayload = z.object({
  content: z.string().optional(),
}).passthrough();

/**
 * Schema for responses this agent sends back.
 *
 * Starts permissive (`.passthrough()`, no required fields) so handlers that
 * return arbitrary dicts keep working. Tighten it by adding required fields
 * once your response shape is stable — the SDK will then validate every
 * response against this model before shipping it, catching handler bugs with
 * a clear error instead of surprising callers.
 */
export const ResponsePayload = z.object({}).passthrough();

export type RequestPayloadT = z.infer<typeof RequestPayload>;
export type ResponsePayloadT = z.infer<typeof ResponsePayload>;

/**
 * Cap on the total /webhook request body size. Bounds how big an inline
 * base64 attachment can come through before Express rejects with 413. Tune
 * per your agent's needs — transcription agents handling audio/video may
 * want 50+ MB; a form-filler probably wants 5 MB.
 */
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
