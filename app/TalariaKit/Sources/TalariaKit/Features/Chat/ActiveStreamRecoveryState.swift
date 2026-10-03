public enum ActiveStreamRecoveryState: Equatable {
    case idle
    case checking
    case reconnecting
    /// The device has no network path, so recovery waits for one instead of retrying (TAL-449).
    case waitingForNetwork
}
