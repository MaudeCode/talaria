import Foundation
import SwiftUI

public enum AdaptiveReadableContentWidth {
    public static let secondaryDestination: CGFloat = 800
    public static let workspace: CGFloat = 1_000
}

public enum AdaptiveGlassStyle: Equatable {
    case regular
}

public enum AdaptiveGlassSurface: Equatable {
    case liquidGlass
    case material
    case opaque

    public static func resolve(
        liquidGlassAvailable: Bool,
        isGlassEnabled: Bool,
        reduceTransparency: Bool
    ) -> AdaptiveGlassSurface {
        if reduceTransparency {
            return .opaque
        }

        guard liquidGlassAvailable, isGlassEnabled else {
            return .material
        }

        return .liquidGlass
    }
}

public enum AdaptiveScrollEdgeTreatment: Equatable {
    case soft
    case disabled

    public static func resolve(
        softScrollEdgesAvailable: Bool,
        reduceTransparency: Bool
    ) -> AdaptiveScrollEdgeTreatment {
        guard softScrollEdgesAvailable, !reduceTransparency else {
            return .disabled
        }

        return .soft
    }
}
