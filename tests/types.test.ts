import { describe, it, expect } from "vitest";
import {
  ZyndBaseConfigSchema,
  AgentConfigSchema,
  ServiceConfigSchema,
  AgentFramework,
} from "../src/types";

describe("ZyndBaseConfigSchema", () => {
  it("applies defaults for minimal input", () => {
    const config = ZyndBaseConfigSchema.parse({});
    expect(config.name).toBe("");
    expect(config.webhookHost).toBe("0.0.0.0");
    expect(config.webhookPort).toBe(5000);
    expect(config.registryUrl).toBe("https://dns01.zynd.ai");
    expect(config.category).toBe("general");
    expect(config.autoReconnect).toBe(true);
    expect(config.messageHistoryLimit).toBe(100);
  });

  it("parses full config", () => {
    const config = ZyndBaseConfigSchema.parse({
      name: "test-agent",
      description: "A test agent",
      webhookPort: 8080,
      entityUrl: "https://example.com",
      price: "$0.01",
      tags: ["test", "demo"],
    });
    expect(config.name).toBe("test-agent");
    expect(config.webhookPort).toBe(8080);
    expect(config.entityUrl).toBe("https://example.com");
    expect(config.tags).toEqual(["test", "demo"]);
  });

  it("rejects invalid port", () => {
    expect(() =>
      ZyndBaseConfigSchema.parse({ webhookPort: "not-a-number" })
    ).toThrow();
  });
});

describe("AgentConfigSchema", () => {
  it("extends base with developer fields", () => {
    const config = AgentConfigSchema.parse({
      name: "derived-agent",
      developerKeypairPath: "~/.zynd/developer.json",
      entityIndex: 0,
    });
    expect(config.developerKeypairPath).toBe("~/.zynd/developer.json");
    expect(config.entityIndex).toBe(0);
  });
});

describe("ServiceConfigSchema", () => {
  it("extends base with service fields", () => {
    const config = ServiceConfigSchema.parse({
      name: "my-service",
      serviceEndpoint: "https://api.example.com",
      openapiUrl: "https://api.example.com/openapi.json",
    });
    expect(config.serviceEndpoint).toBe("https://api.example.com");
  });
});

describe("AgentFramework", () => {
  it("has expected values", () => {
    expect(AgentFramework.LANGCHAIN).toBe("langchain");
    expect(AgentFramework.LANGGRAPH).toBe("langgraph");
    expect(AgentFramework.CUSTOM).toBe("custom");
    expect(AgentFramework.VERCEL_AI).toBe("vercel_ai");
  });
});
