/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class CogneeError extends Error {
	readonly status?: number;
	/** Timeout / unknown transport outcome — neither success nor breaker-eligible failure. */
	readonly transient?: boolean;
	/** Positively absent server (refused / DNS / unroutable). */
	readonly unreachable?: boolean;
	readonly aborted?: boolean;

	constructor(
		message: string,
		opts: {
			status?: number;
			transient?: boolean;
			unreachable?: boolean;
			aborted?: boolean;
		} = {},
	) {
		super(message);
		this.name = "CogneeError";
		this.status = opts.status;
		this.transient = opts.transient;
		this.unreachable = opts.unreachable;
		this.aborted = opts.aborted;
	}
}

export function describeError(err: unknown): string {
	if (err instanceof Error) {
		const cause = (err as Error & { cause?: { code?: string } }).cause;
		return cause?.code ? `${err.message} (${cause.code})` : err.message;
	}
	return String(err);
}

export function wrapAsCogneeError(err: unknown): CogneeError {
	if (err instanceof CogneeError) return err;
	return new CogneeError(describeError(err));
}

/** `error` string from an UpdateResult/ErrorResponse body, when present (lenient). */
export function errorStringFromUpdateBody(data: Record<string, unknown>): string | undefined {
  if (typeof data.error === "string" && data.error) return data.error; // ErrorResponse
  const err = data.error;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message; // UpdateResult.error
  }
  return undefined;
}