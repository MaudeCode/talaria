/**
 * Sidecar RPC protocol version. Any change to a method's params, result, or
 * stream frames bumps this number; the sidecar refuses to start on a mismatch
 * (docs/architecture/sidecar-rpc.md).
 */
export const SIDECAR_RPC_VERSION = 3
