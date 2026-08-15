export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
