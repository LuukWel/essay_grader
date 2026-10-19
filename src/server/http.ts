/** Parses a JSON body. Malformed JSON returns undefined, so validation answers 400 instead of a 500. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
