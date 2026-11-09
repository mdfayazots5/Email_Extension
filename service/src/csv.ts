export function csvCell(value: string | null): string {
  const text = value ?? "";
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function tsvCell(value: string | null): string {
  return (value ?? "").replace(/[\t\r\n]+/g, " ");
}
