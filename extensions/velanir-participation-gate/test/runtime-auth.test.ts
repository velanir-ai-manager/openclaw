import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ASSERTION_TYPE,
  createRuntimeParticipationContextAuthClient,
  PARTICIPATION_CONTEXT_SCOPE,
} from "../src/runtime-auth.js";

const runtimeIdentityId = "790a53dd-9f99-4b68-906b-0361664e1137";
const tmpDirs: string[] = [];

async function runtimeEnv(): Promise<NodeJS.ProcessEnv> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "participation-runtime-auth-test-"));
  tmpDirs.push(stateDir);
  return {
    OCT8_API_URL: "https://api.velanir.test",
    OCT8_RUNTIME_IDENTITY_ID: runtimeIdentityId,
    OCT8_RUNTIME_STATE_DIR: stateDir,
    OCT8_RUNTIME_KEY_ID: "participation-runtime-key",
  };
}

function jwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) {
    throw new Error("JWT payload was missing.");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function ath(accessToken: string): string {
  return createHash("sha256").update(accessToken, "ascii").digest("base64url");
}

function header(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers as Record<string, string> | undefined;
  const value = headers?.[name];
  if (!value) {
    throw new Error(`${name} header was missing.`);
  }
  return value;
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("Expected a string request body.");
  }
  return body;
}

describe("runtime participation context auth", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("requests a scoped runtime token and signs DPoP headers for context reads", async () => {
    const env = await runtimeEnv();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(requestBodyText(init?.body));
      expect(form.get("grant_type")).toBe("client_credentials");
      expect(form.get("client_id")).toBe(runtimeIdentityId);
      expect(form.get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE);
      expect(form.get("client_assertion")).toEqual(expect.any(String));
      expect(form.get("scope")).toBe(PARTICIPATION_CONTEXT_SCOPE);
      expect(jwtPayload(header(init, "DPoP"))).toMatchObject({
        htm: "POST",
        htu: "https://api.velanir.test/v1/runtime/token",
      });
      expect(jwtPayload(header(init, "DPoP"))).not.toHaveProperty("ath");

      return new Response(
        JSON.stringify({
          access_token: "runtime-access-token",
          token_type: "DPoP",
          expires_in: 900,
          scope: PARTICIPATION_CONTEXT_SCOPE,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = createRuntimeParticipationContextAuthClient({
      env,
      fetchImpl: fetchMock as typeof fetch,
    });

    const headers = await client.authorizationHeaders(
      "https://api.velanir.test/v1/runtime/coworkers/coworker%2Falbus/participation-context",
    );
    await expect(
      client.authorizationHeaders(
        "https://api.velanir.test/v1/runtime/coworkers/coworker%2Falbus/participation-context",
      ),
    ).resolves.toMatchObject({ Authorization: "DPoP runtime-access-token" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headers.Authorization).toBe("DPoP runtime-access-token");
    expect(jwtPayload(headers.DPoP)).toMatchObject({
      htm: "GET",
      htu: "https://api.velanir.test/v1/runtime/coworkers/coworker%2Falbus/participation-context",
      ath: ath("runtime-access-token"),
    });
  });

  it("rejects non-DPoP or wrongly scoped token responses", async () => {
    for (const payload of [
      {
        access_token: "runtime-access-token",
        token_type: "Bearer",
        expires_in: 900,
        scope: PARTICIPATION_CONTEXT_SCOPE,
      },
      {
        access_token: "runtime-access-token",
        token_type: "DPoP",
        expires_in: 900,
        scope: "runtime:heartbeat",
      },
    ]) {
      const env = await runtimeEnv();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const client = createRuntimeParticipationContextAuthClient({
        env,
        fetchImpl: fetchMock as typeof fetch,
      });

      await expect(
        client.authorizationHeaders(
          "https://api.velanir.test/v1/runtime/coworkers/coworker%2Falbus/participation-context",
        ),
      ).rejects.toThrow("Runtime token response was invalid");
    }
  });
});
