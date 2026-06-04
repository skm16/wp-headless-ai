export class DiscardEditError extends Error {
  constructor(
    public readonly code: "not_found" | "already_promoted",
    message: string,
  ) {
    super(message);
    this.name = "DiscardEditError";
  }
}
