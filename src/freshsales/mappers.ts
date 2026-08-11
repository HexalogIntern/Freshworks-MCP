function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(item => asRecord(item)) : [];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return null;
}

export function getPrimaryRecord<T extends string>(payload: Record<string, unknown>, key: T): Record<string, unknown> {
  return asRecord(payload[key]);
}

export function getCollection<T extends string>(payload: Record<string, unknown>, key: T): Record<string, unknown>[] {
  return asArray(payload[key]);
}

export function extractSearchResults(payload: unknown): Record<string, unknown>[] {
  const payloadRecord = asRecord(payload);
  const sources = [
    asArray(payload),
    asArray(payloadRecord.contacts),
    asArray(payloadRecord.results),
    asArray(payloadRecord.data)
  ];
  const firstPopulated = sources.find(source => source.length > 0) ?? [];

  return firstPopulated.map(item => {
    const entityType = stringValue(item.entity_type);
    const nestedByEntityType = entityType ? asRecord(item[entityType]) : {};
    const nestedContact = asRecord(item.contact);

    if (Object.keys(nestedByEntityType).length > 0) {
      return nestedByEntityType;
    }

    if (Object.keys(nestedContact).length > 0) {
      return nestedContact;
    }

    return item;
  });
}

export function nameFromRecord(record: Record<string, unknown>): string | null {
  return (
    stringValue(record.display_name) ??
    stringValue(record.name) ??
    ([stringValue(record.first_name), stringValue(record.last_name)].filter(Boolean).join(" ").trim() || null)
  );
}

export function emailFromRecord(record: Record<string, unknown>): string | null {
  const direct = stringValue(record.email);
  if (direct) {
    return direct;
  }

  const emails = record.emails;
  if (Array.isArray(emails) && typeof emails[0] === "string") {
    return emails[0];
  }

  return null;
}

export function ownerNameFromRecord(record: Record<string, unknown>): string | null {
  return (
    nameFromRecord(asRecord(record.owner)) ??
    nameFromRecord(asRecord(record.sales_owner)) ??
    stringValue(record.owner_name) ??
    stringValue(record.sales_owner_name) ??
    stringValue(record.owner_id)
  );
}

export function contactStatusFromRecord(record: Record<string, unknown>): string | null {
  return (
    stringValue(asRecord(record.lifecycle_stage).name) ??
    stringValue(asRecord(record.contact_status).name) ??
    stringValue(asRecord(record.status).name) ??
    stringValue(record.lifecycle_stage_name) ??
    stringValue(record.contact_status_name) ??
    stringValue(record.status_name) ??
    stringValue(record.stage_name) ??
    stringValue(record.status) ??
    stringValue(record.stage) ??
    stringValue(record.lifecycle_stage_id)
  );
}

export function tagNamesFromRecord(record: Record<string, unknown>): string[] {
  const tags = record.tags;
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .map(tag => typeof tag === "string" ? tag : nameFromRecord(asRecord(tag)))
    .filter((tag): tag is string => Boolean(tag));
}

export function accountNameFromRecord(record: Record<string, unknown>): string | null {
  return (
    stringValue(asRecord(record.sales_account).name) ??
    stringValue(asRecord(record.account).name) ??
    stringValue(asRecord(record.company).name) ??
    stringValue(record.sales_account_name) ??
    stringValue(record.account_name) ??
    stringValue(record.company_name) ??
    stringValue(record.company)
  );
}

export function stageNameFromDeal(record: Record<string, unknown>): string | null {
  return (
    stringValue(asRecord(record.deal_stage).name) ??
    stringValue(record.stage_name) ??
    stringValue(record.deal_stage_name) ??
    stringValue(record.stage)
  );
}

export function normalizedDealLifecycle(record: Record<string, unknown>): "open" | "won" | "lost" {
  const stage = (stageNameFromDeal(record) ?? "").toLowerCase();
  const won = record.is_won === true;
  const closedAt = stringValue(record.closed_date) ?? stringValue(record.closed_at);

  if (won || stage.includes("won")) {
    return "won";
  }

  if (stage.includes("lost") || (closedAt && !won)) {
    return "lost";
  }

  return "open";
}

export function amountFromDeal(record: Record<string, unknown>): number {
  const raw = record.amount;
  if (typeof raw === "number") {
    return raw;
  }

  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export function weightedValueFromDeal(record: Record<string, unknown>): number | null {
  const direct = numberValue(record.weighted_value) ?? numberValue(record.weighted_amount);
  if (direct !== null) {
    return direct;
  }

  const amount = amountFromDeal(record);
  const probability = numberValue(record.probability);
  return probability !== null ? amount * (probability / 100) : null;
}

export function linkedContactFromDeal(record: Record<string, unknown>): { id: string | null; name: string | null } | null {
  const contacts = asArray(record.contacts);
  const first = contacts[0];
  if (first) {
    return {
      id: stringValue(first.id),
      name: nameFromRecord(first)
    };
  }

  const contact = asRecord(record.contact);
  if (Object.keys(contact).length > 0) {
    return {
      id: stringValue(contact.id),
      name: nameFromRecord(contact)
    };
  }

  return null;
}

export function linkedAccountFromDeal(record: Record<string, unknown>): { id: string | null; name: string | null } | null {
  const account = asRecord(record.sales_account);
  if (Object.keys(account).length > 0) {
    return {
      id: stringValue(account.id),
      name: stringValue(account.name)
    };
  }

  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function noteSummary(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: stringValue(record.id),
    body: stringValue(record.description) ?? stringValue(record.body),
    created_at: stringValue(record.created_at),
    updated_at: stringValue(record.updated_at),
    creator: nameFromRecord(asRecord(record.creater)) ?? nameFromRecord(asRecord(record.creator))
  };
}
