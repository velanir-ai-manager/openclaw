import {
  CLIENT_ASSERTION_TYPE,
  loadRuntimeKey,
  readRuntimeSecretsEnv,
  signDpopProof,
  signRuntimeAssertion,
} from "./runtime-identity.js";

export { CLIENT_ASSERTION_TYPE } from "./runtime-identity.js";

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_SKEW_MS = 30_000;

export const PARTICIPATION_CONTEXT_SCOPE = "participation-context:read";

type FetchLike = typeof fetch;
type RuntimeEnv = ReturnType<typeof readRuntimeSecretsEnv>;
type RuntimeKey = Awaited<ReturnType<typeof loadRuntimeKey>>;

type RuntimeTokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

export type ParticipationContextAuthClient = {
  authorizationHeaders: (requestUrl: string) => Promise<Record<string, string>>;
};

export type RuntimeParticipationContextAuthOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
};

function runtimeUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl.replace(/\/+$/, "")}${normalizedPath}`;
}

function participationContextHtu(tokenIssuer: string, requestUrl: string): string {
  const parsed = new URL(requestUrl);
  return runtimeUrl(tokenIssuer, parsed.pathname);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function apiErrorMessage(response: Response): string {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return `Runtime token request failed with ${response.status}${statusText}.`;
}

export class RuntimeParticipationContextAuthClient implements ParticipationContextAuthClient {
  private runtimeEnv: RuntimeEnv | undefined;
  private keyPromise: Promise<RuntimeKey> | undefined;
  private token: RuntimeTokenCache | undefined;

  constructor(private readonly options: RuntimeParticipationContextAuthOptions = {}) {}

  async authorizationHeaders(requestUrl: string): Promise<Record<string, string>> {
    const accessToken = await this.accessToken();
    const env = this.env();
    const key = await this.key();
    const dpopProof = await signDpopProof({
      key,
      method: "GET",
      htu: participationContextHtu(env.tokenIssuer, requestUrl),
      accessToken,
    });

    return {
      Authorization: `DPoP ${accessToken}`,
      DPoP: dpopProof,
    };
  }

  private env(): RuntimeEnv {
    this.runtimeEnv ??= readRuntimeSecretsEnv(this.options.env);
    return this.runtimeEnv;
  }

  private key(): Promise<RuntimeKey> {
    this.keyPromise ??= loadRuntimeKey(this.env());
    return this.keyPromise;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return this.token.accessToken;
    }

    const env = this.env();
    const key = await this.key();
    const endpoint = runtimeUrl(env.apiUrl, "/v1/runtime/token");
    const audience = runtimeUrl(env.tokenIssuer, "/v1/runtime/token");
    const clientAssertion = await signRuntimeAssertion({
      key,
      runtimeIdentityId: env.runtimeIdentityId,
      audience,
    });
    const dpopProof = await signDpopProof({
      key,
      method: "POST",
      htu: audience,
    });
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.runtimeIdentityId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: clientAssertion,
      scope: PARTICIPATION_CONTEXT_SCOPE,
    });

    const response = await fetchWithTimeout(this.options.fetchImpl ?? fetch, endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        DPoP: dpopProof,
      },
      body: form.toString(),
    });
    const payload = await parseJson(response);
    if (!response.ok) {
      throw new Error(apiErrorMessage(response));
    }
    if (
      !isRecord(payload) ||
      typeof payload.access_token !== "string" ||
      payload.token_type !== "DPoP" ||
      payload.scope !== PARTICIPATION_CONTEXT_SCOPE ||
      typeof payload.expires_in !== "number" ||
      !Number.isFinite(payload.expires_in) ||
      payload.expires_in <= 0
    ) {
      throw new Error("Runtime token response was invalid.");
    }

    this.token = {
      accessToken: payload.access_token,
      expiresAtMs: now + payload.expires_in * 1_000,
    };
    return payload.access_token;
  }
}

export function createRuntimeParticipationContextAuthClient(
  options?: RuntimeParticipationContextAuthOptions,
): RuntimeParticipationContextAuthClient {
  return new RuntimeParticipationContextAuthClient(options);
}
