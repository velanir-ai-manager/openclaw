import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import {
  createPlatformParticipationContextProvider,
  createStaticParticipationContextProvider,
  parseParticipationContext,
} from "../src/context.js";
import type { ParticipationContext } from "../src/types.js";

const context: ParticipationContext = {
  self: {
    id: "albus",
    names: ["Albus", "Albus Dumbledore"],
    roleSummary: "Executive assistant",
  },
  coworkers: [
    {
      id: "tanya",
      names: ["Tanya", "Tanya Dean"],
      roleSummary: "Executive assistant",
    },
  ],
};

describe("participation context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses the platform data envelope", () => {
    expect(parseParticipationContext({ data: context })).toEqual(context);
  });

  it("parses a raw context payload", () => {
    expect(parseParticipationContext(context)).toEqual(context);
  });

  it("rejects payloads without self identity", () => {
    expect(() => parseParticipationContext({ data: { coworkers: [] } })).toThrow(
      "missing self identity",
    );
  });

  it("loads static context", async () => {
    const provider = createStaticParticipationContextProvider(context);

    await expect(provider.load()).resolves.toEqual(context);
  });

  it("fetches platform context with runtime auth headers and caches it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: context }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeAuthClient = {
      authorizationHeaders: vi.fn().mockResolvedValue({
        Authorization: "DPoP runtime-token",
        DPoP: "runtime-dpop-proof",
      }),
    };

    const config = normalizeConfig(
      {
        context: { source: "platform", refreshMs: 60_000 },
        platform: {
          baseUrl: "https://api.velanir.test",
          coworkerId: "coworker/albus",
        },
      },
      {},
    );
    const provider = createPlatformParticipationContextProvider(config, { runtimeAuthClient });

    await expect(provider.load()).resolves.toEqual(context);
    await expect(provider.load()).resolves.toEqual(context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runtimeAuthClient.authorizationHeaders).toHaveBeenCalledTimes(1);
    expect(runtimeAuthClient.authorizationHeaders).toHaveBeenCalledWith(
      "https://api.velanir.test/v1/runtime/coworkers/coworker%2Falbus/participation-context",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.velanir.test/v1/runtime/coworkers/coworker%2Falbus/participation-context",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "DPoP runtime-token",
        DPoP: "runtime-dpop-proof",
      },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("X-Velanir-Coworker-Id");
  });

  it("keeps static bearer mode explicit for local prototype calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: context }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = normalizeConfig(
      {
        context: { source: "platform", refreshMs: 60_000 },
        platform: {
          authMode: "static-token",
          baseUrl: "https://api.velanir.test",
          coworkerId: "coworker/albus",
          token: "scoped-token",
        },
      },
      {},
    );
    const provider = createPlatformParticipationContextProvider(config);

    await expect(provider.load()).resolves.toEqual(context);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer scoped-token",
        "X-Velanir-Coworker-Id": "coworker/albus",
      },
    });
  });

  it("does not fall back to runtime auth when static bearer mode is missing a token", async () => {
    const runtimeAuthClient = {
      authorizationHeaders: vi.fn(),
    };
    const config = normalizeConfig(
      {
        platform: {
          authMode: "static-token",
          baseUrl: "https://api.velanir.test",
          coworkerId: "coworker/albus",
        },
      },
      {},
    );
    const provider = createPlatformParticipationContextProvider(config, { runtimeAuthClient });

    await expect(provider.load()).rejects.toThrow("static platform context token");
    expect(runtimeAuthClient.authorizationHeaders).not.toHaveBeenCalled();
  });

  it("throws when platform context request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
    );

    const config = normalizeConfig(
      {
        platform: {
          baseUrl: "https://api.velanir.test",
          coworkerId: "albus",
        },
      },
      {},
    );
    const provider = createPlatformParticipationContextProvider(config, {
      runtimeAuthClient: {
        authorizationHeaders: vi.fn().mockResolvedValue({
          Authorization: "DPoP runtime-token",
          DPoP: "runtime-dpop-proof",
        }),
      },
    });

    await expect(provider.load()).rejects.toThrow("503");
  });
});
