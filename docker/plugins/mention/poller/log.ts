// Identifiers and fixed diagnostic codes only; never bodies, transcripts, or tokens.
export function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
