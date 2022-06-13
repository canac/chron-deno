import { writeAll } from "https://deno.land/std@0.142.0/streams/conversion.ts";

// Write the content encoded as a UTF8 to the writer
const encoder = new TextEncoder();
export async function writeAllString(
  writer: Deno.Writer,
  content: string,
): Promise<void> {
  const encoded = encoder.encode(content);
  writeAll(writer, encoded);
}

// Write the content to stderr
export function logStderr(content: string): Promise<void> {
  return writeAllString(Deno.stderr, content);
}
