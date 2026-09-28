import XCTest
@testable import Talaria
@testable import TalariaKit

/// Seeded property checks over the narrow boundaries where untrusted server
/// bytes first become Talaria values: SSE frames, session/message JSON,
/// `APIError` bodies, multipart part headers, workspace paths, and media
/// references (TAL-85).
///
/// Every input is derived from `baseSeed &+ iteration`, so a failure names the
/// exact seed that produced it and the soak subclass covers a superset of the
/// PR-CI iterations. When a run fails, add the reproduction to
/// `// MARK: - Minimized regressions` below as an ordinary fixture-based test
/// and fix the boundary; the fuzz loop is the finder, not the regression test.
///
/// PR CI runs this class at the small budget. `UntrustedInputFuzzSoakTests`
/// runs the same properties far longer and is skipped in PR CI, so it is
/// scheduled separately by `.github/workflows/fuzz-soak.yml`.
class UntrustedInputFuzzTests: XCTestCase {
    /// Inputs generated per property. The soak subclass raises it.
    class var iterations: Int { 2_000 }

    /// Fixed so PR CI explores the same inputs on every run.
    class var baseSeed: UInt64 { 0x7A1A_21A0_0000_0055 }

    /// Deliberately guessable and reproducible by the fragment table, so
    /// generated names and filenames really do carry the active boundary.
    fileprivate static let fuzzBoundary = "FuzzBoundary"

    /// Concurrent so a thread abandoned at the budget cannot stall the seeds
    /// that follow it.
    private static let watchdogQueue = DispatchQueue(label: "talaria.fuzz.watchdog", attributes: .concurrent)

    /// Set once an input outlives its budget; `forEachSeed` stops on it.
    private var hasAbandonedInput = false

    override func setUp() {
        super.setUp()
        hasAbandonedInput = false
    }

    /// Per-input wall-clock ceiling. A bounded input that takes longer than
    /// this at a parser boundary is the hang this suite exists to catch, not a
    /// slow machine.
    private static let perInputTimeBudget: TimeInterval = 2

    // MARK: - SSE frames

    /// Known and unknown event types with arbitrary payload bytes must always
    /// yield a bounded event rather than trapping, and an unknown type must
    /// stay `.ignored` instead of being coerced into a stream-affecting event.
    func testSSEEventDecodingStaysTolerantForArbitraryFrames() {
        let knownTypes = [
            "token", "interim_assistant", "reasoning", "tool", "tool_complete",
            "title", "metering", "done", "initial", "approval", "clarify",
            "steer_consumed", "pending_steer_leftover", "stream_end", "cancel",
            "error", "apperror"
        ]

        forEachSeed { generator, seed in
            let isKnown = generator.bool()
            let eventType = isKnown ? generator.element(knownTypes) : generator.string()
            let payload = generator.payloadString()

            guard let event = withinTimeBudget(seed: seed, input: "\(eventType) \(payload)", {
                SSEEventDecoder.decode(eventType: eventType, data: payload)
            }) else { return }

            if !isKnown, !knownTypes.contains(eventType) {
                XCTAssertEqual(
                    event,
                    .ignored,
                    "Unknown SSE event type was not ignored (seed \(seed), type \(eventType.debugDescription))."
                )
            }

            // Generic bound first: it covers every payload-bearing variant,
            // including the ones with no specific check below.
            assertBounded(
                Self.decodedTextSize(of: event),
                by: payload.count,
                label: "decoded SSE event",
                seed: seed
            )

            if case let .token(text) = event {
                assertBounded(text.count, by: payload.count, label: "token text", seed: seed)
            }
            if case let .reasoning(reasoning) = event {
                assertBounded(reasoning.text.count, by: payload.count, label: "reasoning text", seed: seed)
                XCTAssertLessThanOrEqual(
                    reasoning.titles.count,
                    8,
                    "Reasoning titles exceeded the normalized cap (seed \(seed))."
                )
            }
        }
    }

    // MARK: - Session, message and activity-scene JSON

    /// The tolerant model decoders either produce a value or throw a
    /// `DecodingError`. Nothing may trap, hang, or amplify the input into a
    /// disproportionately large string.
    func testModelDecodingFailsTolerantlyAndStaysBounded() {
        forEachSeed { generator, seed in
            let data = generator.payloadData()

            assertTolerantDecode(ChatMessage.self, from: data, seed: seed) { message in
                if let content = message.content {
                    assertBounded(content.count, by: data.count, label: "message content", seed: seed)
                }
                if let rows = message.activityScene?.activityRows {
                    assertBounded(rows.count, by: data.count, label: "activity rows", seed: seed)
                }
            }
            assertTolerantDecode(SessionsResponse.self, from: data, seed: seed) { response in
                assertBounded(response.sessions?.count ?? 0, by: data.count, label: "sessions", seed: seed)
            }
            assertTolerantDecode(SessionResponse.self, from: data, seed: seed) { _ in }
            assertTolerantDecode(AssistantActivityScene.self, from: data, seed: seed) { scene in
                assertBounded(scene.activityRows?.count ?? 0, by: data.count, label: "scene rows", seed: seed)
            }
        }
    }

    // MARK: - Error bodies

    /// A hostile or confused error body may carry credential-shaped fields
    /// alongside the message. Nothing user-visible or logged may echo them:
    /// `APIError` reads only `error`/`message`/`detail`/`code`/`stale`/
    /// `active_stream_id`.
    func testErrorBodiesNeverEchoUnrelatedCredentialFields() {
        let credentialKeys = [
            "password", "token", "api_key", "apiKey", "authorization",
            "cookie", "secret", "access_token", "refresh_token", "session_secret"
        ]

        forEachSeed { generator, seed in
            let credential = "TAL85-CREDENTIAL-\(seed)"
            var body = generator.jsonObject()
            for key in credentialKeys {
                body[key] = credential
            }
            body["error"] = generator.string()
            body["nested"] = ["password": credential, "inner": generator.string()]

            guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]),
                  let bodyString = String(data: data, encoding: .utf8)
            else {
                return XCTFail("Generated error body was not serializable (seed \(seed)).")
            }

            let statusCode = generator.element([-1, 200, 400, 401, 403, 404, 408, 409, 429, 500, 503, 599])
            let error = APIError.http(statusCode: statusCode, body: bodyString)

            let outputs: [String?] = [
                error.errorDescription,
                error.serverMessage,
                error.serverCode,
                error.activeStreamID,
                error.privacySafeLogCategory,
                APIError.privacySafeLogCategory(for: error)
            ]

            for output in outputs.compactMap({ $0 }) {
                XCTAssertFalse(
                    output.contains(credential),
                    "An APIError output leaked an unrelated credential field (seed \(seed)): \(output)"
                )
            }
        }
    }

    // MARK: - Multipart part headers

    /// Field names and filenames reach a `Content-Disposition` header verbatim.
    /// No generated name may add a line, open a delimiter, or unbalance the
    /// quoting of the disposition parameters.
    ///
    /// The boundary is the fixed `FuzzBoundary` token the fragment table can
    /// emit, so names and filenames really do carry the active boundary. A
    /// delimiter only counts at the start of a line, and CR/LF are escaped out
    /// of names, so one delimiter line is the invariant. A field *value* is
    /// sent verbatim and could open a part — what makes that unreachable is the
    /// fresh per-request boundary, covered by
    /// `APIClientUploadTests.testUploadBoundariesAreUnguessableAndUniquePerRequest`.
    func testMultipartNamesCannotInjectHeadersOrBoundaries() {
        var boundaryBearingInputs = 0

        forEachSeed { generator, seed in
            let boundary = Self.fuzzBoundary
            let name = generator.string()
            let filename = generator.string()
            if name.contains(boundary) || filename.contains(boundary) {
                boundaryBearingInputs += 1
            }

            var textBody = Data()
            textBody.appendMultipart(textField: name, value: "value", boundary: boundary)
            assertPartHeaders(
                in: textBody,
                boundary: boundary,
                expectedHeaderLines: 1,
                expectedQuotes: 2,
                seed: seed,
                label: "text field \(name.debugDescription)"
            )

            var fileBody = Data()
            fileBody.appendMultipart(
                fileField: name,
                filename: filename,
                data: Data("payload".utf8),
                boundary: boundary
            )
            assertPartHeaders(
                in: fileBody,
                boundary: boundary,
                expectedHeaderLines: 2,
                expectedQuotes: 4,
                seed: seed,
                label: "file field \(name.debugDescription)/\(filename.debugDescription)"
            )
        }

        XCTAssertGreaterThan(
            boundaryBearingInputs,
            0,
            "No generated name or filename carried the active boundary, so the delimiter check proved nothing."
        )
    }

    // MARK: - Workspace paths

    /// Workspace and media paths come back from the server and go straight into
    /// the next request URL. Whatever they contain, they must round-trip as one
    /// query value instead of adding or overwriting query items or changing the
    /// route.
    func testWorkspacePathsRoundTripWithoutQueryInjection() {
        let baseURL = URL(string: "https://hermes.example.test")!

        forEachSeed { generator, seed in
            let sessionID = generator.string()
            let path = generator.string()
            let endpoint = generator.bool()
                ? Endpoint.file(sessionID: sessionID, path: path)
                : Endpoint.media(sessionID: sessionID, path: path)
            guard let url = withinTimeBudget(seed: seed, input: path, {
                endpoint.url(relativeTo: baseURL)
            }) else { return }

            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                return XCTFail("Endpoint produced an unparseable URL (seed \(seed), path \(path.debugDescription)).")
            }

            XCTAssertEqual(
                components.path,
                endpoint.path,
                "A fuzzed path changed the request route (seed \(seed), path \(path.debugDescription))."
            )
            XCTAssertEqual(components.host, baseURL.host, "A fuzzed path changed the request host (seed \(seed)).")

            // Asserted on the percent-encoded query, not the decoded
            // `queryItems` getter: Foundation strips a leading U+FEFF while
            // percent-decoding, so the decoded form is lossy even though the
            // bytes on the wire are intact.
            let encodedPairs = (components.percentEncodedQuery ?? "").components(separatedBy: "&")
            XCTAssertEqual(
                encodedPairs.count,
                2,
                "A fuzzed path added or removed a query item (seed \(seed), path \(path.debugDescription))."
            )
            XCTAssertTrue(
                encodedPairs.first?.hasPrefix("session_id=") == true
                    && encodedPairs.last?.hasPrefix("path=") == true,
                "A fuzzed path escaped its query item (seed \(seed)): \(encodedPairs)"
            )

            var expected = URLComponents()
            expected.queryItems = [
                URLQueryItem(name: "session_id", value: sessionID),
                URLQueryItem(name: "path", value: path)
            ]
            XCTAssertEqual(
                components.percentEncodedQuery,
                expected.percentEncodedQuery,
                "A fuzzed path did not reach the request URL verbatim (seed \(seed))."
            )
        }
    }

    // MARK: - Media references

    /// Transcript media parsing must terminate, stay proportional to its input,
    /// and never promote a non-HTTP reference into a remote URL that the media
    /// loader would then fetch.
    func testMediaParsingIsBoundedAndNeverPromotesNonHTTPSchemes() {
        forEachSeed { generator, seed in
            let markdown = generator.markdown()

            // Reading `.source`, `.mediaKind` and `.displayName` parses the
            // reference again, so those accesses belong inside the watchdog
            // too; only the assertions run out here.
            guard let parsed = withinTimeBudget(seed: seed, input: markdown, {
                let segments = TranscriptMediaParser.segments(in: markdown)
                return (count: segments.count, media: segments.compactMap(FuzzMediaSummary.init))
            }) else { return }

            assertBounded(parsed.count, by: markdown.count, label: "media segments", seed: seed)

            for media in parsed.media {
                assertBounded(
                    media.rawReference.count,
                    by: markdown.count,
                    label: "media reference",
                    seed: seed
                )
                assertRemoteOnlyForHTTP(media, seed: seed)
                XCTAssertFalse(
                    media.displayName.isEmpty,
                    "A parsed media reference produced an empty display name (seed \(seed))."
                )
            }

            let raw = generator.string()
            guard let standalone = withinTimeBudget(seed: seed, input: raw, {
                FuzzMediaSummary(TranscriptMediaReference(rawReference: raw))
            }) else { return }

            assertRemoteOnlyForHTTP(standalone, seed: seed)
        }
    }

    // MARK: - Watchdog

    /// The hang detector has to be checked, or a regression in it would turn
    /// every "never hangs" property back into a silent pass.
    func testWatchdogAbandonsWorkThatOutlivesItsBudget() {
        // Matched, not blanket: a bare `XCTExpectFailure` would also absorb the
        // `XCTAssertNil` below, so a watchdog that returned its value after the
        // deadline would still pass. Matching the timeout issue leaves that
        // assertion enforced, and strict mode fails the test if the watchdog
        // never reports at all.
        XCTExpectFailure("The watchdog is expected to report the abandoned input.") { issue in
            issue.compactDescription.contains("did not finish inside")
        }

        let result: Int? = withinTimeBudget(seed: 0, input: "deliberate hang", budget: 0.2, {
            Thread.sleep(forTimeInterval: 0.6)
            return 1
        })

        XCTAssertNil(result, "The watchdog returned a value for work that outlived its budget.")
    }

    // MARK: - Minimized regressions

    // No fuzz-discovered failure is outstanding. Add the minimized
    // reproduction here — plain fixture, no generator — when one is found.

    // MARK: - Harness

    /// Stops at the first abandoned input: its thread cannot be cancelled, so
    /// continuing would pile up runaway threads and make every later seed pay
    /// the full budget until the workflow timeout killed the job before it
    /// could report anything.
    private func forEachSeed(_ body: (inout FuzzGenerator, UInt64) -> Void) {
        for iteration in 0..<Self.iterations {
            let seed = Self.baseSeed &+ UInt64(iteration)
            var generator = FuzzGenerator(seed: seed)
            body(&generator, seed)
            if hasAbandonedInput { return }
        }
    }

    /// Runs `work` on its own thread and gives up on it after the budget.
    /// Timing the call after it returns cannot catch the runaway loop this
    /// suite exists to find — that call never returns, so the job would burn
    /// its whole workflow timeout without naming a reproducing seed. Returns
    /// `nil` once the budget is spent; the input is abandoned, not awaited.
    @discardableResult
    private func withinTimeBudget<Output>(
        seed: UInt64,
        input: @autoclosure @escaping () -> String,
        budget: TimeInterval? = nil,
        _ work: @escaping @Sendable () -> Output,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> Output? {
        let box = FuzzResultBox<Output>()
        let finished = DispatchSemaphore(value: 0)
        Self.watchdogQueue.async {
            box.value = work()
            finished.signal()
        }

        let ceiling = budget ?? Self.perInputTimeBudget
        guard finished.wait(timeout: .now() + ceiling) == .success else {
            hasAbandonedInput = true
            XCTFail(
                """
                A bounded input did not finish inside \(ceiling)s \
                (seed \(seed), input \(input().debugDescription)). \
                Stopping the sweep here: the abandoned thread cannot be cancelled.
                """,
                file: file,
                line: line
            )
            return nil
        }
        return box.value
    }

    /// The decode runs under the watchdog; the inspection runs here, so a
    /// bounded assertion failure is reported against the calling test.
    private func assertTolerantDecode<Value: Decodable>(
        _ type: Value.Type,
        from data: Data,
        seed: UInt64,
        _ inspect: (Value) -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let outcome = withinTimeBudget(seed: seed, input: data.fuzzDescription, {
            Result { try JSONDecoder().decode(Value.self, from: data) }
        }, file: file, line: line)

        switch outcome {
        case .none:
            return
        case .success(let value)?:
            inspect(value)
        case .failure(let error)?:
            guard !(error is DecodingError) else { return }
            XCTFail(
                "\(type) threw a non-decoding error (seed \(seed)): \(error)",
                file: file,
                line: line
            )
        }
    }

    /// Total length of every string reachable in a decoded value. Measuring
    /// `String(describing:)` instead would mostly count field names, which is a
    /// constant floor unrelated to the input and says nothing about
    /// amplification.
    private static func decodedTextSize(of value: Any) -> Int {
        if let text = value as? String {
            return text.count
        }

        let mirror = Mirror(reflecting: value)
        if mirror.displayStyle == .optional {
            guard let wrapped = mirror.children.first else { return 0 }
            return decodedTextSize(of: wrapped.value)
        }
        return mirror.children.reduce(0) { $0 + decodedTextSize(of: $1.value) }
    }

    /// Amplification guard: a decoder may normalize and merge fields, so the
    /// bound is generous. It still fails on output that grows super-linearly
    /// with a bounded input.
    private func assertBounded(
        _ produced: Int,
        by inputSize: Int,
        label: String,
        seed: UInt64,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertLessThanOrEqual(
            produced,
            max(512, inputSize * 8),
            "\(label) grew disproportionately to its input (seed \(seed), input \(inputSize) bytes).",
            file: file,
            line: line
        )
    }

    private func assertRemoteOnlyForHTTP(
        _ reference: FuzzMediaSummary,
        seed: UInt64,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard reference.isRemote else { return }
        let trimmed = reference.rawReference
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        XCTAssertTrue(
            trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://"),
            "A non-HTTP reference became a remote URL (seed \(seed), \(reference.rawReference.debugDescription)).",
            file: file,
            line: line
        )
    }

    /// A single generated part must be exactly: the opening boundary line, the
    /// expected header lines, the blank separator, the body, and the trailing
    /// CRLF. Any extra line means a name or filename escaped its header.
    private func assertPartHeaders(
        in body: Data,
        boundary: String,
        expectedHeaderLines: Int,
        expectedQuotes: Int,
        seed: UInt64,
        label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let text = String(decoding: body, as: UTF8.self)
        let lines = text.components(separatedBy: "\r\n")

        XCTAssertEqual(
            lines.count,
            expectedHeaderLines + 4,
            "Multipart part gained or lost a line (seed \(seed), \(label)): \(text.debugDescription)",
            file: file,
            line: line
        )
        XCTAssertEqual(
            lines.first,
            "--\(boundary)",
            "Multipart part did not start with its boundary (seed \(seed), \(label)).",
            file: file,
            line: line
        )
        XCTAssertEqual(
            lines.filter { $0.hasPrefix("--\(boundary)") }.count,
            1,
            "A multipart name opened an extra boundary delimiter (seed \(seed), \(label)).",
            file: file,
            line: line
        )

        for index in 1...expectedHeaderLines {
            guard lines.indices.contains(index) else { return }
            let header = lines[index]
            XCTAssertFalse(
                header.isEmpty,
                "Multipart header line \(index) was empty (seed \(seed), \(label)).",
                file: file,
                line: line
            )
            if index == 1 {
                XCTAssertTrue(
                    header.hasPrefix("Content-Disposition: form-data; name=\""),
                    "Multipart disposition was malformed (seed \(seed), \(label)): \(header.debugDescription)",
                    file: file,
                    line: line
                )
                XCTAssertEqual(
                    header.filter { $0 == "\"" }.count,
                    expectedQuotes,
                    "Multipart disposition quoting was unbalanced (seed \(seed), \(label)): \(header.debugDescription)",
                    file: file,
                    line: line
                )
            }
        }
    }
}

/// The scheduled longer run. Same properties, same seed sequence extended, so a
/// soak failure reproduces by pointing the PR-CI class at the reported seed.
/// Skipped in CI by `app/ci/test_shards.py` (`.github/workflows/ci.yml`).
final class UntrustedInputFuzzSoakTests: UntrustedInputFuzzTests {
    override class var iterations: Int { 500_000 }
}

/// What the media boundary produced, resolved inside the watchdog so no
/// parsing is left to run unwatched on the calling thread.
private struct FuzzMediaSummary {
    let rawReference: String
    let isRemote: Bool
    let displayName: String
    let kind: TranscriptMediaKind

    init(_ reference: TranscriptMediaReference) {
        rawReference = reference.rawReference
        if case .remoteURL = reference.source {
            isRemote = true
        } else {
            isRemote = false
        }
        displayName = reference.displayName
        kind = reference.mediaKind
    }

    init?(_ segment: TranscriptMediaSegment) {
        guard case let .media(reference) = segment else { return nil }
        self.init(reference)
    }
}

/// Carries a watchdogged result back across the queue hop.
private final class FuzzResultBox<Value>: @unchecked Sendable {
    var value: Value?
}

/// Deterministic, size-bounded generator for untrusted input. Every value it
/// produces stays under a few hundred bytes so CI runtime and allocation stay
/// predictable; the exploration comes from the seed sweep, not from size.
private struct FuzzGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed == 0 ? 0x9E37_79B9_7F4A_7C15 : seed
    }

    private mutating func next() -> UInt64 {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return state
    }

    mutating func int(_ range: ClosedRange<Int>) -> Int {
        let span = UInt64(range.upperBound - range.lowerBound + 1)
        return range.lowerBound + Int(next() % span)
    }

    mutating func bool() -> Bool {
        next() % 2 == 0
    }

    mutating func element<Value>(_ values: [Value]) -> Value {
        values[int(0...(values.count - 1))]
    }

    /// Fragments that have historically broken parsers: delimiters, control
    /// bytes, percent and path traversal syntax, combining marks, bidi
    /// overrides, and the app's own marker tokens.
    private static let fragments = [
        "", "a", "  ", "\t", "\r\n", "\n", "\r", "\"", "\\", "'", "%", "%00",
        "%22", "\u{0}", "\u{7F}", "../", "/../", "..\\", "&admin=1", "=", "?q=1",
        "#fragment", ";", "--", "MEDIA:", "file://", "file:///tmp/x.png",
        "http://a.test/x.png", "https://b.test/y", "javascript:alert(1)",
        "data:text/html,x", "```", "`", "$$", "|", "[", "](", ")", "{", "}",
        "\u{1F600}", "e\u{0301}", "\u{200B}", "\u{202E}", "\u{FFFD}",
        "session_id", "password", "FuzzBoundary", "--FuzzBoundary", "\u{FEFF}",
        String(repeating: "A", count: 32), String(repeating: "/", count: 8)
    ]

    private static let keys = [
        "role", "content", "timestamp", "_ts", "messageId", "name",
        "toolCallId", "toolCalls", "reasoning", "reasoningContent",
        "reasoningTitles", "_anchorActivityScene", "attachments",
        "_turnDuration", "_turnTps", "activityRows", "rowId", "orderIndex",
        "status", "createdAt", "payload", "tool", "thinking", "sessions",
        "session", "cliCount", "archivedCount", "serverTime", "serverTz",
        "error", "message", "detail", "code", "stale", "active_stream_id",
        "text", "titles", "tps", "tps_available", "session_id", "path",
        "version", "finalAnswer", "turnDuration"
    ]

    mutating func string(maxFragments: Int = 6) -> String {
        var result = ""
        for _ in 0..<int(0...maxFragments) {
            result += element(Self.fragments)
        }
        return result
    }

    mutating func markdown() -> String {
        var result = ""
        for _ in 0..<int(1...10) {
            result += element(Self.fragments)
            if bool() { result += "\n" }
        }
        return result
    }

    private mutating func jsonScalar() -> Any {
        switch int(0...7) {
        case 0: return string()
        case 1: return int(-1000...1000)
        case 2: return Double(int(-1000...1000)) / 7
        case 3: return bool()
        case 4: return NSNull()
        case 5: return String(int(0...9))
        case 6: return Double.greatestFiniteMagnitude
        default: return Int.max
        }
    }

    private mutating func jsonValue(depth: Int) -> Any {
        guard depth > 0, int(0...2) > 0 else { return jsonScalar() }
        if bool() {
            var values: [Any] = []
            for _ in 0..<int(0...4) {
                values.append(jsonValue(depth: depth - 1))
            }
            return values
        }
        return jsonObject(depth: depth - 1)
    }

    mutating func jsonObject(depth: Int = 3) -> [String: Any] {
        var object: [String: Any] = [:]
        for _ in 0..<int(0...5) {
            let key = bool() ? element(Self.keys) : string(maxFragments: 2)
            object[key] = jsonValue(depth: depth)
        }
        return object
    }

    /// Valid JSON, corrupted JSON, or bytes that were never JSON — the three
    /// shapes an untrusted response actually arrives in.
    mutating func payloadData() -> Data {
        // `.sortedKeys` because Swift dictionary iteration order varies between
        // processes: without it the same seed would serialize differently and
        // truncate or corrupt a different byte, so a reported seed would not
        // reproduce its input.
        guard let encoded = try? JSONSerialization.data(withJSONObject: jsonObject(), options: [.sortedKeys]) else {
            return Data(string().utf8)
        }

        switch int(0...3) {
        case 0, 1:
            return encoded
        case 2:
            return encoded.prefix(int(0...max(0, encoded.count - 1)))
        default:
            var corrupted = encoded
            guard !corrupted.isEmpty else { return Data(string().utf8) }
            let index = corrupted.startIndex.advanced(by: int(0...(corrupted.count - 1)))
            corrupted[index] = UInt8(int(0...255))
            return corrupted
        }
    }

    mutating func payloadString() -> String {
        bool() ? String(decoding: payloadData(), as: UTF8.self) : string()
    }
}

private extension Data {
    /// Raw prefix; the caller applies `debugDescription` when it reports.
    var fuzzDescription: String {
        String(decoding: prefix(120), as: UTF8.self)
    }
}
