import Foundation

/// An error that carries a technical line for copied error reports, kept out
/// of the shown message. Never a credential, token, or server URL.
public protocol ErrorDetailProviding: Error {
    var detail: String? { get }
}

/// A Settings error as shown, plus the detail its Copy action adds.
public struct SettingsErrorText: Equatable, Sendable {
    public var message: String
    public var detail: String?

    public init(_ message: String, detail: String? = nil) {
        self.message = message
        self.detail = detail
    }

    public init(_ error: any Error) {
        self.init(error.localizedDescription, detail: (error as? any ErrorDetailProviding)?.detail)
    }

    /// What Copy writes: the shown message, then the detail line if any.
    public var copiedText: String {
        detail.map { "\(message)\n\($0)" } ?? message
    }
}
