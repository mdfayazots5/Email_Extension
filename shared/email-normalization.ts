export function normalizeForComparison(value: string): string {
  return value.trim().replace(/^["']+|["']+$/g, "").trim().toLowerCase();
}
