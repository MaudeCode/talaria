import Foundation
import SwiftUI

public struct ContextWindowIndicatorPresentation: Equatable {
    let percent: Int?

    public init(snapshot: ContextWindowSnapshot?) {
        percent = snapshot?.contextUsagePercent
    }

    public var percentage: Double? {
        percent.map { Double($0) / 100 }
    }

    public var percentageLabel: String {
        guard let percent else { return "–" }
        return "\(percent)"
    }

    public var isInteractive: Bool {
        percentage != nil
    }
}
