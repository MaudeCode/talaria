import Foundation

/// Why a failed request falls back to saved data (TAL-1195). Only `offline` says the device has no network; the others
/// keep the saved rows without claiming a lost connection.
public enum CacheFallbackReason: Equatable, Sendable {
    /// URLSession found no usable network: not connected, or cellular data not allowed.
    case offline
    /// The network works, but the server's host could not be found or connected to.
    case serverUnreachable
    /// The server answered that it is temporarily unavailable (HTTP 408, 502, 503, 504).
    case serverUnavailable
    /// The connection dropped or timed out mid-request, as a suspended App's requests do. It says nothing about the
    /// network, and the next request usually succeeds.
    case connectionInterrupted
}

public enum CacheFallbackPolicy {
    public static func shouldUseCache(for error: Error) -> Bool {
        reason(for: error) != nil
    }

    /// Why `error` falls back to saved data, or nil when it does not.
    public static func reason(for error: Error) -> CacheFallbackReason? {
        switch error {
        case APIError.network(let underlying):
            return connectivityReason(underlying)
        case APIError.http(let statusCode, _):
            return isTransientUnavailableStatus(statusCode) ? .serverUnavailable : nil
        default:
            return connectivityReason(error)
        }
    }

    private static func connectivityReason(_ error: Error) -> CacheFallbackReason? {
        guard let urlError = error as? URLError else { return nil }

        switch urlError.code {
        case .notConnectedToInternet, .dataNotAllowed:
            return .offline
        case .cannotConnectToHost, .dnsLookupFailed, .cannotFindHost:
            return .serverUnreachable
        case .networkConnectionLost, .timedOut:
            return .connectionInterrupted
        default:
            return nil
        }
    }

    private static func isTransientUnavailableStatus(_ statusCode: Int) -> Bool {
        switch statusCode {
        case 408, 502, 503, 504:
            return true
        default:
            return false
        }
    }
}
