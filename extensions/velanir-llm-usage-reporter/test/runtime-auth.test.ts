import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeObservabilityAuthClient } from "../src/runtime-auth.js";

const RUNTIME_IDENTITY_ID = "11111111-1111-4111-8111-111111111111";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function runtimeStateDir() {
  const dir = await mkdtemp(join(tmpdir(), "llm-usage-reporter-runtime-auth-"));
  tempDirs.push(dir);
  return dir;
}

function headerValue(headers: HeadersInit | undefined, key: string): string {
  if (headers instanceof Headers) {
    return headers.get(key) ?? "";
  }
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? "";
  }
  return headers?.[key] ?? headers?.[key.toLowerCase()] ?? "";
}

function decodeJwt(value: string): Record<string, unknown> {
  const payload = value.split(".")[1];
  if (!payload) throw new Error("JWT payload was missing.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("runtime observability auth client", () => {
  it("uses OCT8_API_URL for HTTP requests and runtime token issuer for DPoP htu claims", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "runtime-access-token",
          token_type: "DPoP",
          expires_in: 900,
          scope: "observability:write",
        }),
      ),
    );
    const client = new RuntimeObservabilityAuthClient({
      fetchImpl,
      env: {
        OCT8_API_URL: "https://api.velanir.test",
        OCT8_RUNTIME_TOKEN_ISSUER: "https://issuer.velanir.test",
        OCT8_RUNTIME_IDENTITY_ID: RUNTIME_IDENTITY_ID,
        OCT8_RUNTIME_STATE_DIR: await runtimeStateDir(),
      },
    });

    const headers = await client.authorizationHeaders(
      "https://api.velanir.test/v1/runtime/observability/llm-usage?ignored=true",
      "POST",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0] ?? [];
    expect(tokenUrl).toBe("https://api.velanir.test/v1/runtime/token");

    const tokenBody = new URLSearchParams(String(tokenInit?.body));
    const clientAssertionPayload = decodeJwt(tokenBody.get("client_assertion") ?? "");
    expect(clientAssertionPayload.aud).toBe("https://issuer.velanir.test/v1/runtime/token");

    const tokenDpopPayload = decodeJwt(headerValue(tokenInit?.headers, "DPoP"));
    expect(tokenDpopPayload.htu).toBe("https://issuer.velanir.test/v1/runtime/token");
    expect(tokenDpopPayload.ath).toBeUndefined();

    const ingestDpopPayload = decodeJwt(headers.DPoP);
    expect(headers.Authorization).toBe("DPoP runtime-access-token");
    expect(ingestDpopPayload.htu).toBe(
      "https://issuer.velanir.test/v1/runtime/observability/llm-usage",
    );
    expect(ingestDpopPayload.ath).toBeDefined();
  });
});
