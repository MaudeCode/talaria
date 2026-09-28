import SwiftUI

public enum AppFont {
    public static func body(weight: Font.Weight? = nil) -> Font {
        system(.body, weight: weight)
    }

    public static func callout(weight: Font.Weight? = nil) -> Font {
        system(.callout, weight: weight)
    }

    public static func subheadline(weight: Font.Weight? = nil) -> Font {
        system(.subheadline, weight: weight)
    }

    public static func footnote(weight: Font.Weight? = nil) -> Font {
        system(.footnote, weight: weight)
    }

    public static func caption(weight: Font.Weight? = nil) -> Font {
        system(.caption, weight: weight)
    }

    public static func caption2(weight: Font.Weight? = nil) -> Font {
        system(.caption2, weight: weight)
    }

    public static func headline(weight: Font.Weight? = nil) -> Font {
        system(.headline, weight: weight)
    }

    public static func title(weight: Font.Weight? = nil) -> Font {
        system(.title, weight: weight)
    }

    public static func title2(weight: Font.Weight? = nil) -> Font {
        system(.title2, weight: weight)
    }

    public static func title3(weight: Font.Weight? = nil) -> Font {
        system(.title3, weight: weight)
    }

    public static func mono(style: Font.TextStyle = .body, weight: Font.Weight? = nil) -> Font {
        system(style, design: .monospaced, weight: weight)
    }

    private static func system(
        _ style: Font.TextStyle,
        design: Font.Design = .default,
        weight: Font.Weight? = nil
    ) -> Font {
        .system(style, design: design, weight: weight)
    }
}
