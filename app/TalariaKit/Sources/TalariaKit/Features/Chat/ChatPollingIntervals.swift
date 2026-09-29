public struct ChatPollingIntervals {
    let approvalNanoseconds: UInt64
    let clarificationNanoseconds: UInt64
    let backgroundNanoseconds: UInt64
    /// Waits one polling interval; tests inject it to hold a loop between polls.
    var sleep: @MainActor @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }

    public static let standard = ChatPollingIntervals(
        approvalNanoseconds: 1_500_000_000,
        clarificationNanoseconds: 1_500_000_000,
        backgroundNanoseconds: 3_000_000_000
    )
}
