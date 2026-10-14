public struct ChatPollingIntervals {
    let approvalNanoseconds: UInt64
    let clarificationNanoseconds: UInt64
    let backgroundNanoseconds: UInt64
    /// TAL-1006: between reads of a manual compression job, as Web polls it.
    var compressionNanoseconds: UInt64 = 1_000_000_000
    /// Waits one polling interval; tests inject it to hold a loop between polls.
    var sleep: @MainActor @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }

    public static let standard = ChatPollingIntervals(
        approvalNanoseconds: 1_500_000_000,
        clarificationNanoseconds: 1_500_000_000,
        backgroundNanoseconds: 15_000_000_000
    )
}
