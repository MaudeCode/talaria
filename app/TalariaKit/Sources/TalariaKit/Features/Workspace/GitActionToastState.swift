import Foundation
import Observation
import SwiftUI

public struct GitActionProgress: Equatable, Sendable {
    public let title: String
    public var subtitle: String?
    public var detailLines: [String] = []

    public init(title: String, subtitle: String? = nil, detailLines: [String] = []) {
        self.title = title
        self.subtitle = subtitle
        self.detailLines = detailLines
    }
}

public struct GitActionSuccess: Equatable, Identifiable, Sendable {
    public struct Action: Sendable {
        public let title: String
        public let perform: @MainActor @Sendable () -> Void

        public init(title: String, perform: @escaping @MainActor @Sendable () -> Void) {
            self.title = title
            self.perform = perform
        }
    }

    public let id = UUID()
    public let title: String
    public var subtitle: String?
    public var detailLines: [String] = []
    public let action: Action?

    public init(title: String, subtitle: String? = nil, detailLines: [String] = [], action: Action? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.detailLines = detailLines
        self.action = action
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        // The ID also identifies the immutable action and title.
        lhs.id == rhs.id && lhs.subtitle == rhs.subtitle && lhs.detailLines == rhs.detailLines
    }
}

@MainActor
@Observable
public final class GitActionToastState {
    public private(set) var progress: GitActionProgress?
    public private(set) var success: GitActionSuccess?
    private var dismissTask: Task<Void, Never>?
    private let clock: any Clock<Duration>

    public init(clock: any Clock<Duration> = ContinuousClock()) {
        self.clock = clock
    }

    public func showProgress(_ value: GitActionProgress) {
        dismissTask?.cancel()
        withAnimation(.easeInOut(duration: 0.18)) {
            success = nil
            progress = value
        }
    }

    /// Shows `value` until `dismissSuccess()` or six seconds after the latest success.
    public func showSuccess(_ value: GitActionSuccess) {
        dismissTask?.cancel()
        withAnimation(.easeInOut(duration: 0.18)) {
            progress = nil
            success = value
        }
        dismissTask = Task { [weak self, clock] in
            try? await clock.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            self?.dismissSuccess()
        }
    }

    public func dismissSuccess() {
        dismissTask?.cancel()
        dismissTask = nil
        withAnimation(.easeInOut(duration: 0.18)) {
            success = nil
        }
    }

    public func dismissProgress() {
        withAnimation(.easeInOut(duration: 0.18)) {
            progress = nil
        }
    }
}
