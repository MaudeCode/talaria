import Network
public import Observation

/// Whether the device has a usable network path. Conformers are `@Observable`, so a change of
/// `isSatisfied` reaches observers through Observation (TAL-449).
@MainActor
public protocol NetworkPathObserving: AnyObject, Observable {
    var isSatisfied: Bool { get }
}

/// The device's network path, shared app-wide.
@MainActor
@Observable
public final class NetworkPathObserver: NetworkPathObserving {
    public static let shared = NetworkPathObserver()

    /// Assumes a usable path until the monitor reports its first one.
    public private(set) var isSatisfied = true
    @ObservationIgnored private let monitor = NWPathMonitor()

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let isSatisfied = path.status == .satisfied
            MainActor.assumeIsolated {
                guard let self, self.isSatisfied != isSatisfied else { return }
                self.isSatisfied = isSatisfied
            }
        }
        monitor.start(queue: .main)
    }
}
