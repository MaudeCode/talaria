import CoreGraphics
import SwiftUI

/// Selects the trailing book pane and, optionally, the top tabletop pane using physical coordinates.
public enum DivisionRegionLayout {
    public static func availableFrame(in bounds: CGRect, divisions: [CGRect],
                                      layoutDirection: LayoutDirection = .leftToRight,
                                      avoidsHorizontalDivisions: Bool = true) -> CGRect {
        divisions.reduce(bounds) { available, division in
            let fold = bounds.intersection(division)
            guard !fold.isNull, fold.width > 0, fold.height > 0 else { return available }
            if fold.height > fold.width {
                if layoutDirection == .rightToLeft {
                    return available.intersection(CGRect(x: bounds.minX, y: bounds.minY,
                        width: fold.minX - bounds.minX, height: bounds.height))
                }
                return available.intersection(CGRect(x: fold.maxX, y: bounds.minY,
                    width: bounds.maxX - fold.maxX, height: bounds.height))
            }
            guard avoidsHorizontalDivisions else { return available }
            return available.intersection(CGRect(x: bounds.minX, y: bounds.minY,
                width: bounds.width, height: fold.minY - bounds.minY))
        }
    }
}
