import XCTest
@testable import TalariaKit

final class CacheFallbackPolicyTests: XCTestCase {
    func testUsesCacheForConnectivityErrors() {
        let codes: [URLError.Code] = [
            .notConnectedToInternet,
            .networkConnectionLost,
            .cannotConnectToHost,
            .dnsLookupFailed,
            .cannotFindHost,
            .dataNotAllowed,
            .timedOut
        ]

        for code in codes {
            XCTAssertTrue(
                CacheFallbackPolicy.shouldUseCache(for: APIError.network(underlying: URLError(code))),
                "\(code) should use cache fallback"
            )
        }
    }

    func testUsesCacheForTransientUnavailableHTTPStatuses() {
        for statusCode in [408, 502, 503, 504] {
            XCTAssertTrue(
                CacheFallbackPolicy.shouldUseCache(for: APIError.http(statusCode: statusCode, body: nil)),
                "HTTP \(statusCode) should use cache fallback"
            )
        }
    }

    func testDoesNotUseCacheForServerApplicationErrors() {
        let cases: [(name: String, error: Error)] = [
            ("invalid server URL", APIError.invalidServerURL),
            ("unauthorized", APIError.unauthorized),
            ("bad request", APIError.http(statusCode: 400, body: nil)),
            ("forbidden", APIError.http(statusCode: 403, body: nil)),
            ("not found", APIError.http(statusCode: 404, body: nil)),
            ("rate limited", APIError.http(statusCode: 429, body: nil)),
            ("server error", APIError.http(statusCode: 500, body: nil)),
            ("decoding", APIError.decoding(underlying: URLError(.badServerResponse))),
            ("cancelled", APIError.network(underlying: URLError(.cancelled))),
            ("bad URL", APIError.network(underlying: URLError(.badURL))),
            ("certificate", APIError.network(underlying: URLError(.secureConnectionFailed))),
            ("plain cancellation", CancellationError())
        ]

        for testCase in cases {
            XCTAssertFalse(
                CacheFallbackPolicy.shouldUseCache(for: testCase.error),
                "\(testCase.name) should not use cache fallback"
            )
        }
    }

    /// TAL-1195: only a failure that shows the device has no network is offline; a dropped or timed-out request and a
    /// down server keep the saved rows under their own reason.
    func testNamesWhyEachFailureFallsBackToSavedData() {
        let cases: [(error: Error, reason: CacheFallbackReason)] = [
            (APIError.network(underlying: URLError(.notConnectedToInternet)), .offline),
            (APIError.network(underlying: URLError(.dataNotAllowed)), .offline),
            (APIError.network(underlying: URLError(.cannotConnectToHost)), .serverUnreachable),
            (APIError.network(underlying: URLError(.cannotFindHost)), .serverUnreachable),
            (APIError.network(underlying: URLError(.dnsLookupFailed)), .serverUnreachable),
            (APIError.network(underlying: URLError(.networkConnectionLost)), .connectionInterrupted),
            (APIError.network(underlying: URLError(.timedOut)), .connectionInterrupted),
            (URLError(.networkConnectionLost), .connectionInterrupted),
        ] + [408, 502, 503, 504].map { (APIError.http(statusCode: $0, body: nil), .serverUnavailable) }

        for testCase in cases {
            XCTAssertEqual(CacheFallbackPolicy.reason(for: testCase.error), testCase.reason, "\(testCase.error)")
        }
        XCTAssertNil(CacheFallbackPolicy.reason(for: APIError.http(statusCode: 500, body: nil)))
        XCTAssertNil(CacheFallbackPolicy.reason(for: APIError.network(underlying: URLError(.cancelled))))
    }

    func testRawURLErrorUsesSameConnectivityRules() {
        XCTAssertTrue(CacheFallbackPolicy.shouldUseCache(for: URLError(.timedOut)))
        XCTAssertFalse(CacheFallbackPolicy.shouldUseCache(for: URLError(.badURL)))
    }
}
