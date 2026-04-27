import { ZyndBase } from "./base.js";
import type { ValidationOptions } from "./base.js";
import type { ServiceConfig } from "./types.js";
import type { AgentMessage } from "./message.js";

export class ZyndService extends ZyndBase {
  protected override _entityLabel = "ZYND SERVICE";
  protected override _entityType = "service";

  private handlerFn: ((input: string) => string | Promise<string>) | null = null;

  constructor(config: ServiceConfig, validation?: ValidationOptions) {
    super(config, validation);
  }

  setHandler(fn: (input: string) => string | Promise<string>): void {
    this.handlerFn = fn;

    this.webhook.addMessageHandler(async (message: AgentMessage) => {
      try {
        const result = await fn(message.content);
        this.webhook.setResponse(message.messageId, result);
      } catch (err) {
        this.webhook.setResponse(
          message.messageId,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  async invoke(inputText: string): Promise<string> {
    if (!this.handlerFn) {
      throw new Error("No handler function set. Call setHandler() first.");
    }
    return this.handlerFn(inputText);
  }
}
