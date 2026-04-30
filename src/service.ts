import { ZyndBase } from "./base.js";
import type { ValidationOptions, Handler, HandlerInput, TaskHandle } from "./base.js";
import type { ServiceConfig } from "./types.js";

/**
 * ZyndService — stateless service entity on the Zynd network.
 *
 * Two ways to wire up logic:
 *   - setHandler(fn)        — simple string-in / string-out
 *   - onMessage(handler)    — full A2A access (parts, attachments, tasks)
 */
export class ZyndService extends ZyndBase {
  private handlerFn: ((input: string) => string | Promise<string>) | null = null;

  constructor(config: ServiceConfig, validation?: ValidationOptions) {
    super(config, validation, "service", "ZYND SERVICE");
    this.installHandler(this.defaultHandler.bind(this));
  }

  /** Simple string-in / string-out handler. */
  setHandler(fn: (input: string) => string | Promise<string>): void {
    this.handlerFn = fn;
    this.installHandler(this.defaultHandler.bind(this));
  }

  /** Full A2A handler. */
  onMessage(handler: Handler): void {
    this.installHandler(handler);
  }

  /** Direct invoke for in-process callers (e.g. tests). */
  async invoke(inputText: string): Promise<string> {
    if (!this.handlerFn) {
      throw new Error("No handler function set. Call setHandler() first.");
    }
    return this.handlerFn(inputText);
  }

  // ---------------------------------------------------------------------------

  private async defaultHandler(input: HandlerInput, task: TaskHandle): Promise<unknown> {
    if (!this.handlerFn) {
      return task.fail("ZyndService has no handler. Call setHandler() first.");
    }
    try {
      const result = await this.handlerFn(input.message.content);
      return { text: result };
    } catch (err) {
      return task.fail(err instanceof Error ? err.message : String(err));
    }
  }
}
