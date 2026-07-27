export const IDENTITY_LINKS_START = "<!-- OCT8_IDENTITY_LINKS_START -->";
export const IDENTITY_LINKS_END = "<!-- OCT8_IDENTITY_LINKS_END -->";

export type ManagedIdentityLinks = {
  selfName: string;
  recipientName: string;
  recipientRole: string;
  providerUserIds: Record<string, string[]>;
};

function managedBlock(text: string): string {
  const start = text.indexOf(IDENTITY_LINKS_START);
  const end = text.indexOf(IDENTITY_LINKS_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("managed identity links block is missing");
  }
  return text.slice(start + IDENTITY_LINKS_START.length, end);
}

function providerUserIds(row: string): Record<string, string[]> {
  const ids: Record<string, string[]> = {};
  const pattern = /([a-z0-9_-]+)\/user-id:\s*([^;\s|]+)/giu;
  for (const match of row.matchAll(pattern)) {
    const provider = match[1]?.toLowerCase();
    const id = match[2]?.trim();
    if (!provider || !id) {
      continue;
    }
    const current = ids[provider] ?? [];
    if (!current.some((value) => value.toLowerCase() === id.toLowerCase())) {
      current.push(id);
    }
    ids[provider] = current;
  }
  return ids;
}

export function parseIdentityLinks(text: string, recipientRole = "manager"): ManagedIdentityLinks {
  const block = managedBlock(text);
  const selfMatch = block.match(/^- (.+?) is you\.\s*$/mu);
  if (!selfMatch?.[1]) {
    throw new Error("self identity link is missing");
  }

  const role = recipientRole.trim().toLowerCase();
  const row = block.split(/\r?\n/u).find((line) => {
    if (!line.trim().startsWith("|")) {
      return false;
    }
    const cells = line.split("|").map((cell) => cell.trim());
    return cells[2]?.toLowerCase() === role;
  });
  if (!row) {
    throw new Error(`recipient identity link is missing for role ${recipientRole}`);
  }

  const cells = row.split("|").map((cell) => cell.trim());
  const recipientName = cells[1];
  if (!recipientName) {
    throw new Error(`recipient name is missing for role ${recipientRole}`);
  }

  return {
    selfName: selfMatch[1].trim(),
    recipientName,
    recipientRole: role,
    providerUserIds: providerUserIds(row),
  };
}

function normalize(value: string): string {
  try {
    return decodeURIComponent(value).trim().toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

export function matchesManagedRecipient(
  identity: ManagedIdentityLinks,
  channel: string,
  candidates: Array<string | undefined>,
  configuredTargets: Array<{ channel: string; target: string }> = [],
): boolean {
  const provider = channel.trim().toLowerCase();
  const allowed = [
    ...(identity.providerUserIds[provider] ?? []),
    ...configuredTargets
      .filter((entry) => entry.channel.trim().toLowerCase() === provider)
      .map((entry) => entry.target),
  ].map(normalize);
  if (allowed.length === 0) {
    return false;
  }
  return candidates.some((candidate) => {
    if (!candidate) {
      return false;
    }
    return allowed.includes(normalize(candidate));
  });
}
