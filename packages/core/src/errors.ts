/**
 * Normalized error taxonomy. Adapters MUST translate provider-native failures into
 * one of these so the router and gateway can reason about ret/failover uniformly.
 */

export type OsrErrorCode =
  | "CapacityError" // provider is out of capacity; safe to fail over
  | "RateLimited" // provider rate limit hit; safe to fail over / back off
  | "AuthError" // bad/expired provider credentials; do NOT fail over silently
  | "CapabilityUnsupported" // requested capability not supported by provider
  | "NoCompliantProvider" // no provider satisfies the required capabilities/policy
  | "AllProvidersFailed" // every candidate failed during create failover
  | "NotFound" // sandbox/binding not found
  | "Timeout" // operation exceeded its deadline
  | "ProviderDown" // provider unreachable / 5xx
  | "InvalidRequest" // malformed request
  | "Internal"; // unexpected

/** Codes that indicate it is safe to transparently try the next provider on create. */
export const FAILOVER_CODES: ReadonlySet<OsrErrorCode> = new Set<OsrErrorCode>([
  "CapacityError",
  "RateLimited",
  "Timeout",
  "ProviderDown",
]);

export class OsrError extends Error {
  readonly code: OsrErrorCode;
  readonly provider?: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: OsrErrorCode,
    message: string,
    opts: { provider?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OsrError";
    this.code = code;
    this.provider = opts.provider;
    this.details = opts.details;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    this.retryable = FAILOVER_CODES.has(code);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        provider: this.provider,
        details: this.details,
      },
    };
  }
}

const HTTP_STATUS_BY_CODE: Record<OsrErrorCode, number> = {
  CapacityError: 503,
  RateLimited: 429,
  AuthError: 401,
  CapabilityUnsupported: 422,
  NoCompliantProvider: 422,
  AllProvidersFailed: 503,
  NotFound: 404,
  Timeout: 504,
  ProviderDown: 502,
  InvalidRequest: 400,
  Internal: 500,
};

export function isOsrError(err: unknown): err is OsrError {
  return err instanceof OsrError;
}
