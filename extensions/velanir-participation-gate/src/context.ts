import {
  createRuntimeParticipationContextAuthClient,
  type ParticipationContextAuthClient,
} from "./runtime-auth.js";
import type {
  CoworkerParticipationIdentity,
  ParticipationContext,
  ParticipationGateConfig,
  PlatformContextConfig,
} from "./types.js";

const CONTEXT_FETCH_TIMEOUT_MS = 5_000;

export type ParticipationContextProvider = {
  load: () => Promise<ParticipationContext>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names = value.map(readString).filter((entry): entry is string => Boolean(entry));
  return [...new Set(names)];
}

function parseIdentity(value: unknown): CoworkerParticipationIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id);
  const names = readNames(value.names);
  if (!id || names.length === 0) {
    return undefined;
  }
  const roleSummary = readString(value.roleSummary);
  return {
    id,
    names,
    ...(roleSummary ? { roleSummary } : {}),
  };
}

export function parseParticipationContext(payload: unknown): ParticipationContext {
  const candidate = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(candidate)) {
    throw new Error("participation context response must be an object");
  }

  const self = parseIdentity(candidate.self);
  if (!self) {
    throw new Error("participation context response is missing self identity");
  }

  const coworkers = Array.isArray(candidate.coworkers)
    ? candidate.coworkers
        .map(parseIdentity)
        .filter((entry): entry is CoworkerParticipationIdentity => Boolean(entry))
        .filter((entry) => entry.id !== self.id)
    : [];

  return { self, coworkers };
}

export function buildParticipationContextUrl(config: PlatformContextConfig): string {
  if (!config.baseUrl) {
    throw new Error("platform context baseUrl is not configured");
  }
  if (!config.coworkerId) {
    throw new Error("platform context coworkerId is not configured");
  }

  const path = config.endpointPath.replace("{coworkerId}", encodeURIComponent(config.coworkerId));
  return new URL(path, config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`).href;
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`platform context request failed with ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function createStaticParticipationContextProvider(
  context: ParticipationContext | undefined,
): ParticipationContextProvider {
  return {
    async load() {
      if (!context) {
        throw new Error("static participation context is not configured");
      }
      return context;
    },
  };
}

export function createPlatformParticipationContextProvider(
  config: ParticipationGateConfig,
  options: {
    fetchImpl?: typeof fetch;
    runtimeAuthClient?: ParticipationContextAuthClient;
  } = {},
): ParticipationContextProvider {
  let cached: { expiresAt: number; context: ParticipationContext } | undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const runtimeAuthClient =
    options.runtimeAuthClient ?? createRuntimeParticipationContextAuthClient();

  return {
    async load() {
      const now = Date.now();
      if (cached && cached.expiresAt > now) {
        return cached.context;
      }

      const url = buildParticipationContextUrl(config.platform);
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (config.platform.authMode === "static-token") {
        if (!config.platform.token) {
          throw new Error("static platform context token is not configured");
        }
        headers.Authorization = `Bearer ${config.platform.token}`;
        if (config.platform.coworkerId) {
          headers["X-Velanir-Coworker-Id"] = config.platform.coworkerId;
        }
      } else {
        Object.assign(headers, await runtimeAuthClient.authorizationHeaders(url));
      }

      const payload = await fetchJsonWithTimeout(
        fetchImpl,
        url,
        { method: "GET", headers },
        CONTEXT_FETCH_TIMEOUT_MS,
      );
      const context = parseParticipationContext(payload);
      cached = {
        context,
        expiresAt: now + config.context.refreshMs,
      };
      return context;
    },
  };
}

export function createParticipationContextProvider(
  config: ParticipationGateConfig,
): ParticipationContextProvider {
  if (config.context.source === "static") {
    return createStaticParticipationContextProvider(config.staticContext);
  }
  return createPlatformParticipationContextProvider(config);
}
