public enum ChatToolbarSubtitleResolver {
    public static func subtitle(placeLabel: String?, executionMode: ExecutionMode? = nil) -> String? {
        guard let executionMode, executionMode.isDiagnostic else { return placeLabel }
        return [executionMode.title, placeLabel].compactMap { $0 }.joined(separator: " · ")
    }
}
