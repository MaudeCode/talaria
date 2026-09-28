public struct ChatPollingIntervals: Equatable {
    let approvalNanoseconds: UInt64
    let clarificationNanoseconds: UInt64
    let backgroundNanoseconds: UInt64

    public static let standard = ChatPollingIntervals(
        approvalNanoseconds: 1_500_000_000,
        clarificationNanoseconds: 1_500_000_000,
        backgroundNanoseconds: 3_000_000_000
    )
}
