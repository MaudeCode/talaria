import Foundation
import SwiftUI

public struct ContextWindowIndicatorPresentation: Equatable {
    public let percentage: Double?

    public init(snapshot: ContextWindowSnapshot?) {
        percentage = snapshot?.percentage
    }

    public var percentageLabel: String {
        guard let percentage else { return "–" }
        return "\(Int(percentage * 100))"
    }

    public var isInteractive: Bool {
        percentage != nil
    }
}
