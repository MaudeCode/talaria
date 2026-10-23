import CoreGraphics

/// Geometry in logical leading-to-trailing coordinates, shared by fold-aware overlays.
public enum DivisionRegionLayout {
    public static func trailingFrame(in bounds: CGRect, divisions: [CGRect]) -> CGRect {
        let leadingEdge = divisions.filter { region in
            region.width > 0 && region.height > region.width
                && region.minY <= bounds.minY && region.maxY >= bounds.maxY
                && region.maxX > bounds.minX && region.maxX < bounds.maxX
        }.map(\.maxX).max() ?? bounds.minX
        return CGRect(x: leadingEdge, y: bounds.minY, width: bounds.maxX - leadingEdge, height: bounds.height)
    }
}
