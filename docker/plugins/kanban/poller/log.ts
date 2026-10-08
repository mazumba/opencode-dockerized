// Structured, content-free logging. Callers pass only identifiers, action names,
// results, and durations: never keys, comment bodies, or ticket text.
export function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  console.log([new Date().toISOString(), event, ...pairs].join(" "));
}
