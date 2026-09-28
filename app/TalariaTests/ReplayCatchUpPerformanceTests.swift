import XCTest
@testable import Talaria
@testable import TalariaKit

/// Streaming catch-up budget (TAL-75).
///
/// A reconnect can receive the whole in-flight response again as many small
/// tokens. Every replayed token at or below the resume cursor must be dropped by
/// `ChatStreamCoordinator` in constant time (TAL-316), so per-event work never
/// grows with the response already received. It is measured directly rather than
/// through a UI test: the scaling curve is the signal, and a simulator UI run is
/// too noisy to read it.
///
/// `testReplayCatchUpStaysWithinLinearScaling` reports the curve and fails on a
/// superlinear regression; `testReplayCatchUpLargeBacklog` carries the absolute
/// wall-clock, CPU and memory budget.
final class ReplayCatchUpPerformanceTests: XCTestCase {
    /// Token counts for the scaling curve. The span is 4x, so a linear path
    /// costs ~4x across it where a quadratic one costs ~16x. 4000 tokens is a
    /// ~30 KB response — a realistic long agent turn, and small enough that the
    /// slowest measured size stays in the tens of milliseconds on CI.
    private static let scalingTokenCounts = [1000, 2000, 4000]

    /// Repeats per size; the curve uses the fastest run so an unrelated CI
    /// stall inflates no measurement.
    private static let repeatCount = 5

    /// Cost growth allowed across the whole 4x span of the curve. A linear path
    /// measures ~3.9x there and a quadratic one ~16x, so the gap is wide, and
    /// comparing the endpoints keeps one noisy middle sample from deciding the
    /// result the way a per-step ratio did.
    private static let maximumGrowthAcrossSpan = 8.0

    /// Ceiling on the largest size. The pre-TAL-75 quadratic path spent 212 ms
    /// there against 8.7 ms now, so this catches a regression that somehow
    /// scaled evenly enough to keep the growth ratio flat.
    private static let maximumLargestSizeSeconds = 0.08

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    // MARK: - Scaling curve

    func testReplayCatchUpStaysWithinLinearScaling() async throws {
        var samples: [ReplayCatchUpSample] = []
        for tokenCount in Self.scalingTokenCounts {
            var runs: [ReplayCatchUpSample] = []
            for _ in 0..<Self.repeatCount {
                runs.append(try await measureReplayCatchUp(tokenCount: tokenCount))
            }
            samples.append(try XCTUnwrap(runs.min(by: { $0.wallSeconds < $1.wallSeconds })))
        }

        let report = ReplayCatchUpSample.table(samples)
        let attachment = XCTAttachment(string: report)
        attachment.name = "Replay catch-up scaling curve"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("Replay catch-up scaling curve\n\(report)")

        let smallest = try XCTUnwrap(samples.first)
        let largest = try XCTUnwrap(samples.last)
        let growth = largest.wallSeconds / max(smallest.wallSeconds, 1e-6)
        XCTAssertLessThan(
            growth, Self.maximumGrowthAcrossSpan,
            """
            Replay catch-up scaling regressed: \(String(format: "%.2f", growth))x from \
            \(smallest.tokenCount) to \(largest.tokenCount) tokens.
            \(report)
            """
        )
        XCTAssertLessThan(
            largest.wallSeconds, Self.maximumLargestSizeSeconds,
            """
            Replay catch-up of \(largest.tokenCount) tokens took \
            \(String(format: "%.1f", largest.wallSeconds * 1000)) ms.
            \(report)
            """
        )
    }

    // MARK: - Absolute budget

    func testReplayCatchUpLargeBacklog() {
        measureAsync(
            metrics: [XCTClockMetric(), XCTCPUMetric(), XCTMemoryMetric()],
            options: performanceOptions(manualWindow: true)
        ) { test in
            let harness = try await ReplayCatchUpHarness(
                tokenCount: Self.scalingTokenCounts.last!,
                test: test
            )
            test.startMeasuring()
            harness.replay()
            test.stopMeasuring()
            try harness.verify()
        }
    }

    // MARK: - Helpers

    @MainActor
    private func measureReplayCatchUp(tokenCount: Int) async throws -> ReplayCatchUpSample {
        let harness = try await ReplayCatchUpHarness(tokenCount: tokenCount, test: self)

        let startCPU = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        let startResident = residentMemoryBytes()
        let start = DispatchTime.now().uptimeNanoseconds
        harness.replay()
        let elapsed = DispatchTime.now().uptimeNanoseconds - start
        let cpu = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - startCPU
        let peakResident = residentMemoryBytes()

        try harness.verify()

        return ReplayCatchUpSample(
            tokenCount: tokenCount,
            characterCount: harness.responseCharacterCount,
            wallSeconds: Double(elapsed) / 1_000_000_000,
            mainThreadCPUSeconds: Double(cpu) / 1_000_000_000,
            residentDeltaBytes: Int(peakResident) - Int(startResident)
        )
    }
}

/// One replay catch-up run: connection 1 streams the whole response, drops, and
/// connection 2 replays every token before adding one new one.
@MainActor
private struct ReplayCatchUpHarness {
    let viewModel: ChatViewModel
    let streamClient: ScriptedSSEStreamingClient
    let expectedContent: String
    var responseCharacterCount: Int { expectedContent.count }

    private static let closingToken = " Done."

    init(tokenCount: Int, test: XCTestCase) async throws {
        let tokens = Self.tokens(count: tokenCount)
        expectedContent = tokens.joined() + Self.closingToken

        let liveEvents = tokens.enumerated().map { index, token in
            ScriptedSSEStreamingClient.ScriptedEvent(
                .token(token),
                lastEventID: "stream-123:\(index + 1)"
            )
        }
        let replayEvents = liveEvents + [
            .init(.token(Self.closingToken), lastEventID: "stream-123:\(tokenCount + 1)"),
            .init(.done(DoneStreamEvent())),
            .init(.streamEnd)
        ]

        streamClient = ScriptedSSEStreamingClient(connectionScripts: [
            liveEvents + [.init(.transportError("The network connection was lost."))],
            replayEvents
        ])
        // Flushing on every event would measure transcript rebuilds instead of
        // the replay path; the real client coalesces.
        viewModel = try test.makeScriptedChatViewModel(
            streamClient: streamClient,
            flushesEachEvent: false
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id": "session-abc", "stream_id": "stream-123"}"#,
                    for: request
                )
            case "/api/chat/stream/status":
                return apiTestJSONResponse(
                    #"{"active": false, "stream_id": "stream-123", "replay_available": true}"#,
                    for: request
                )
            case "/api/session":
                return apiTestJSONResponse(
                    #"{"session": {"session_id": "session-abc", "title": "Planning"}}"#,
                    for: request
                )
            default:
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.playArmedConnectionScript()
        viewModel.flushPendingStreamingContent()

        let deadline = Date().addingTimeInterval(5)
        while streamClient.startedURLs.count < 2, Date() < deadline {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(streamClient.startedURLs.count, 2, "The replay connection never opened")
    }

    /// The measured window: every replayed token plus the one new token.
    func replay() {
        streamClient.playArmedConnectionScript()
    }

    /// A replay that silently dropped or duplicated text would make the timing
    /// meaningless, so every run checks the transcript it produced.
    func verify() throws {
        viewModel.flushPendingStreamingContent()
        let assistantContents = viewModel.messages.filter { $0.role == "assistant" }.compactMap(\.content)
        XCTAssertEqual(assistantContents, [expectedContent])
        XCTAssertEqual(streamClient.droppedEventCount, 0)
    }

    /// Deterministic small tokens with varied lengths, matching how a model
    /// emits a long turn as many short fragments.
    private static func tokens(count: Int) -> [String] {
        (0..<count).map { index in
            let word = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"][index % 6]
            return index.isMultiple(of: 12) ? "\n\n\(word) " : "\(word)\(index % 10) "
        }
    }
}

private struct ReplayCatchUpSample {
    let tokenCount: Int
    let characterCount: Int
    let wallSeconds: Double
    let mainThreadCPUSeconds: Double
    let residentDeltaBytes: Int

    static func table(_ samples: [Self]) -> String {
        let header = "tokens\tchars\twall_ms\tmain_cpu_ms\tresident_delta_mb\tgrowth"
        let rows = samples.enumerated().map { index, sample -> String in
            let growth = index == 0
                ? "-"
                : String(format: "%.2fx", sample.wallSeconds / max(samples[index - 1].wallSeconds, 1e-6))
            return String(
                format: "%d\t%d\t%.1f\t%.1f\t%.1f\t%@",
                sample.tokenCount,
                sample.characterCount,
                sample.wallSeconds * 1000,
                sample.mainThreadCPUSeconds * 1000,
                Double(sample.residentDeltaBytes) / 1_048_576,
                growth
            )
        }
        return ([header] + rows).joined(separator: "\n")
    }
}

private func residentMemoryBytes() -> UInt64 {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), rebound, &count)
        }
    }
    return result == KERN_SUCCESS ? info.resident_size : 0
}
