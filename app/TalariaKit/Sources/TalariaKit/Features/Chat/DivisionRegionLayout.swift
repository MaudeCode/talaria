import CoreGraphics
import SwiftUI

/// Resolves panes around the fold using physical coordinates for every app section and chat overlay.
public enum DivisionRegionLayout {
    public struct ChatFrames: Equatable {
        public let transcript: CGRect
        public let composer: CGRect
        public let isTabletop: Bool
    }

    public static func chatFrames(in bounds: CGRect, divisions: [CGRect],
                                  layoutDirection: LayoutDirection = .leftToRight,
                                  keyboardIsVisible: Bool) -> ChatFrames {
        let transcript = availableFrame(in: bounds, divisions: divisions,
            avoidsHorizontalDivisions: !keyboardIsVisible, avoidsVerticalDivisions: false)
        return ChatFrames(transcript: transcript,
            composer: availableFrame(in: bounds, divisions: divisions, layoutDirection: layoutDirection,
                avoidsHorizontalDivisions: !keyboardIsVisible, horizontalPlacement: .bottom),
            isTabletop: transcript != bounds)
    }

    public static func availableFrame(in bounds: CGRect, divisions: [CGRect],
                                      layoutDirection: LayoutDirection = .leftToRight,
                                      avoidsHorizontalDivisions: Bool = true,
                                      avoidsVerticalDivisions: Bool = true,
                                      horizontalPlacement: VerticalEdge = .top) -> CGRect {
        divisions.reduce(bounds) { available, division in
            let fold = bounds.intersection(division)
            guard !fold.isNull, fold.width > 0, fold.height > 0 else { return available }
            if division.height > division.width {
                guard avoidsVerticalDivisions else { return available }
                // A fold at an edge leaves these bounds one pane, as a split arrangement lays it out (TAL-1458): it only
                // trims that edge.
                if fold.maxX >= bounds.maxX {
                    return available.intersection(CGRect(x: bounds.minX, y: bounds.minY,
                        width: fold.minX - bounds.minX, height: bounds.height))
                }
                if fold.minX <= bounds.minX {
                    return available.intersection(CGRect(x: fold.maxX, y: bounds.minY,
                        width: bounds.maxX - fold.maxX, height: bounds.height))
                }
                if layoutDirection == .rightToLeft {
                    return available.intersection(CGRect(x: bounds.minX, y: bounds.minY,
                        width: fold.minX - bounds.minX, height: bounds.height))
                }
                return available.intersection(CGRect(x: fold.maxX, y: bounds.minY,
                    width: bounds.maxX - fold.maxX, height: bounds.height))
            }
            guard avoidsHorizontalDivisions else { return available }
            if horizontalPlacement == .bottom {
                return available.intersection(CGRect(x: bounds.minX, y: fold.maxY,
                    width: bounds.width, height: bounds.maxY - fold.maxY))
            }
            return available.intersection(CGRect(x: bounds.minX, y: bounds.minY,
                width: bounds.width, height: fold.minY - bounds.minY))
        }
    }

    public static func sidebarWidth(in bounds: CGRect, divisions: [CGRect],
                                    layoutDirection: LayoutDirection = .leftToRight) -> CGFloat? {
        let leading = availableFrame(in: bounds, divisions: divisions,
            layoutDirection: layoutDirection == .leftToRight ? .rightToLeft : .leftToRight,
            avoidsHorizontalDivisions: false)
        return leading == bounds ? nil : max(0, leading.width)
    }
}
