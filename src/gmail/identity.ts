const addressPattern = /<?[^<>\s]+@[^<>\s]+>?/g;

export function gmailDisplayLabel(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const withoutAddress = value.replace(addressPattern, "").replace(/[<>]/g, "").trim();
  const unquoted = withoutAddress.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
  if (!unquoted || unquoted.includes("@") || unquoted.length > 100) return undefined;
  return unquoted;
}

export function gmailParticipantLabels(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.flatMap((value) => {
    const label = gmailDisplayLabel(value);
    return label ? [label] : [];
  }))].slice(0, 10);
}
