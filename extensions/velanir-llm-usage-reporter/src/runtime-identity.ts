import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const ASSERTION_TTL_SECONDS = 60;
const PRIVATE_KEY_FILE = "private-key.jwk";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{8,160}$/;
const PRIVATE_JWK_FIELDS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);

export type RuntimeSecretsEnv = {
  apiUrl: string;
  tokenIssuer: string;
  runtimeIdentityId: string;
  stateDir: string;
  keyId?: string;
};

type PrivateRuntimeJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  d: string;
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
};

type PublicRuntimeJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
};

export type RuntimeKeyState = {
  keyId: string;
  privateKey: KeyObject;
  publicKeyJwk: PublicRuntimeJwk;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function normalizeBaseUrl(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid absolute URL.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`${key} must use https outside local development.`);
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function requiredEnvString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

export function readRuntimeSecretsEnv(env: NodeJS.ProcessEnv = process.env): RuntimeSecretsEnv {
  const mode = env.OCT8_SECRETS_MODE?.trim();
  if (mode && mode !== "runtime") {
    throw new Error("Runtime participation auth only supports OCT8_SECRETS_MODE=runtime.");
  }

  const apiUrl = normalizeBaseUrl(requiredEnvString(env, "OCT8_API_URL"), "OCT8_API_URL");
  const tokenIssuer = normalizeBaseUrl(
    env.OCT8_RUNTIME_TOKEN_ISSUER?.trim() || apiUrl,
    "OCT8_RUNTIME_TOKEN_ISSUER",
  );
  const runtimeIdentityId = requiredEnvString(env, "OCT8_RUNTIME_IDENTITY_ID");
  if (!UUID_RE.test(runtimeIdentityId)) {
    throw new Error("OCT8_RUNTIME_IDENTITY_ID must be a runtime identity UUID.");
  }

  const keyId = env.OCT8_RUNTIME_KEY_ID?.trim();
  if (keyId && !KEY_ID_RE.test(keyId)) {
    throw new Error(
      "OCT8_RUNTIME_KEY_ID must be 8-160 characters using letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }

  return {
    apiUrl,
    tokenIssuer,
    runtimeIdentityId,
    stateDir: requiredEnvString(env, "OCT8_RUNTIME_STATE_DIR"),
    ...(keyId ? { keyId } : {}),
  };
}

function runtimeStatePaths(stateDir: string) {
  const root = path.join(stateDir, "oct8-secrets");
  return { root, privateKeyPath: path.join(root, PRIVATE_KEY_FILE) };
}

async function readJsonFile(pathname: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(pathname, "utf8")) as unknown;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw new Error(`Failed to read runtime state file ${path.basename(pathname)}.`, {
      cause: error,
    });
  }
}

async function createJsonFileExclusive(
  pathname: string,
  value: unknown,
): Promise<"created" | "exists"> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(pathname, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return "exists";
    }
    throw new Error(`Failed to create runtime state file ${path.basename(pathname)}.`, {
      cause: error,
    });
  }
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await fs.chmod(pathname, 0o600).catch(() => undefined);
  return "created";
}

function assertPrivateRuntimeJwk(value: unknown): PrivateRuntimeJwk {
  if (
    !isRecord(value) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    value.alg !== "ES256" ||
    value.use !== "sig" ||
    typeof value.kid !== "string" ||
    typeof value.d !== "string" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string"
  ) {
    throw new Error("Runtime private key state is not an ES256 private JWK.");
  }
  return value as unknown as PrivateRuntimeJwk;
}

function publicJwkFromPrivate(privateJwk: PrivateRuntimeJwk): PublicRuntimeJwk {
  const publicJwk = Object.fromEntries(
    Object.entries(privateJwk).filter(([key]) => !PRIVATE_JWK_FIELDS.has(key)),
  ) as PublicRuntimeJwk;
  return {
    ...publicJwk,
    kty: "EC",
    crv: "P-256",
    kid: privateJwk.kid,
    alg: "ES256",
    use: "sig",
  };
}

function generatePrivateRuntimeJwk(keyId: string): PrivateRuntimeJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    ...privateKey.export({ format: "jwk" }),
    kty: "EC",
    crv: "P-256",
    kid: keyId,
    alg: "ES256",
    use: "sig",
  } as PrivateRuntimeJwk;
}

export async function loadRuntimeKey(env: RuntimeSecretsEnv): Promise<RuntimeKeyState> {
  const paths = runtimeStatePaths(env.stateDir);
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.root, 0o700).catch(() => undefined);

  const stored = await readJsonFile(paths.privateKeyPath);
  let privateJwk = stored
    ? assertPrivateRuntimeJwk(stored)
    : generatePrivateRuntimeJwk(env.keyId ?? `oct8-runtime-${randomUUID()}`);
  if (stored === undefined) {
    const result = await createJsonFileExclusive(paths.privateKeyPath, privateJwk);
    if (result === "exists") {
      privateJwk = assertPrivateRuntimeJwk(await readJsonFile(paths.privateKeyPath));
    }
  }
  if (env.keyId && privateJwk.kid !== env.keyId) {
    throw new Error("OCT8_RUNTIME_KEY_ID does not match the stored runtime key.");
  }
  return {
    keyId: privateJwk.kid,
    privateKey: createPrivateKey({ key: privateJwk, format: "jwk" }),
    publicKeyJwk: publicJwkFromPrivate(privateJwk),
  };
}

function signJwtPayload(params: {
  key: RuntimeKeyState;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}): string {
  const header = Buffer.from(JSON.stringify(params.header), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify(params.payload), "utf8").toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
    key: params.key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function signRuntimeAssertion(params: {
  key: RuntimeKeyState;
  runtimeIdentityId: string;
  audience: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwtPayload({
    key: params.key,
    header: { alg: "ES256", kid: params.key.keyId },
    payload: {
      jti: randomUUID(),
      iss: params.runtimeIdentityId,
      sub: params.runtimeIdentityId,
      aud: params.audience,
      iat: now,
      exp: now + ASSERTION_TTL_SECONDS,
    },
  });
}

export function signDpopProof(params: {
  key: RuntimeKeyState;
  method: "GET" | "POST";
  htu: string;
  accessToken?: string;
}): string {
  const payload: Record<string, unknown> = {
    htm: params.method,
    htu: params.htu,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  };
  if (params.accessToken) {
    payload.ath = createHash("sha256").update(params.accessToken, "ascii").digest("base64url");
  }
  return signJwtPayload({
    key: params.key,
    header: {
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: params.key.publicKeyJwk,
    },
    payload,
  });
}
