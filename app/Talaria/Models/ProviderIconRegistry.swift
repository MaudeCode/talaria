import SwiftUI
import TalariaKit

struct ProviderIconDescriptor: Equatable, Sendable {
    let assetName: String?
    let silhouetteAssetName: String?
    let hasOriginalColor: Bool
    let alwaysUsesOriginalRendering: Bool
    let fallbackInitials: String
}

enum ProviderIconRegistry {
    private static let assets: [String: String] = [
        "actual": "ProviderIconActual",
        "actual-computer": "ProviderIconActual",
        "actualcomputer": "ProviderIconActual",
        "aci": "ProviderIconActual",
        "ai-gateway": "ProviderIconVercel",
        "vercel": "ProviderIconVercel",
        "vercel-ai-gateway": "ProviderIconVercel",
        "ai_gateway": "ProviderIconVercel",
        "aigateway": "ProviderIconVercel",
        "alibaba": "ProviderIconAlibaba",
        "alibaba-coding-plan": "ProviderIconAlibaba",
        "dashscope": "ProviderIconAlibaba",
        "alibaba-cloud": "ProviderIconAlibaba",
        "qwen-dashscope": "ProviderIconAlibaba",
        "anthropic": "ProviderIconAnthropic",
        "claude": "ProviderIconAnthropic",
        "arcee": "ProviderIconArcee",
        "arcee-ai": "ProviderIconArcee",
        "arceeai": "ProviderIconArcee",
        "azure-foundry": "ProviderIconAzureAI",
        "azure": "ProviderIconAzureAI",
        "azure-ai-foundry": "ProviderIconAzureAI",
        "azure-ai": "ProviderIconAzureAI",
        "bedrock": "ProviderIconAWS",
        "aws-bedrock": "ProviderIconAWS",
        "copilot": "ProviderIconCopilot",
        "github-copilot": "ProviderIconCopilot",
        "copilot-acp": "ProviderIconCopilot",
        "commandcode": "ProviderIconCommandCode",
        "commandcode-chat": "ProviderIconCommandCode",
        "commandcode-anthropic": "ProviderIconCommandCode",
        "commandcode-claude": "ProviderIconCommandCode",
        "cursor-acp": "ProviderIconCursor",
        "deepinfra": "ProviderIconDeepInfra",
        "deep-infra": "ProviderIconDeepInfra",
        "deepinfra-ai": "ProviderIconDeepInfra",
        "deepseek": "ProviderIconDeepSeek",
        "fireworks": "ProviderIconFireworks",
        "fireworks-ai": "ProviderIconFireworks",
        "fw": "ProviderIconFireworks",
        "gmi": "ProviderIconGMI",
        "gmi-cloud": "ProviderIconGMI",
        "gmicloud": "ProviderIconGMI",
        "google": "ProviderIconGoogle",
        "gemini": "ProviderIconGemini",
        "google-gemini": "ProviderIconGemini",
        "vertex": "ProviderIconGoogleCloud",
        "google-vertex": "ProviderIconGoogleCloud",
        "vertex-ai": "ProviderIconGoogleCloud",
        "gcp-vertex": "ProviderIconGoogleCloud",
        "huggingface": "ProviderIconHuggingFace",
        "hugging-face": "ProviderIconHuggingFace",
        "kilocode": "ProviderIconKiloCode",
        "kilo-code": "ProviderIconKiloCode",
        "kilo": "ProviderIconKiloCode",
        "kilo-gateway": "ProviderIconKiloCode",
        "kimi": "ProviderIconKimi",
        "kimi-coding": "ProviderIconKimi",
        "kimi-coding-cn": "ProviderIconKimi",
        "lmstudio": "ProviderIconLMStudio",
        "lm-studio": "ProviderIconLMStudio",
        "meta": "ProviderIconMeta",
        "meta-llama": "ProviderIconMeta",
        "meta-ai": "ProviderIconMeta",
        "minimax": "ProviderIconMiniMax",
        "minimax-cn": "ProviderIconMiniMax",
        "minimax-oauth": "ProviderIconMiniMax",
        "mistral": "ProviderIconMistral",
        "mistralai": "ProviderIconMistral",
        "moa": "ProviderIconTogetherAI",
        "nous": "ProviderIconNous",
        "nvidia": "ProviderIconNVIDIA",
        "novita": "ProviderIconNovita",
        "novita-ai": "ProviderIconNovita",
        "novitaai": "ProviderIconNovita",
        "ollama": "ProviderIconOllama",
        "ollama-cloud": "ProviderIconOllama",
        "openai": "ProviderIconOpenAI",
        "openai-api": "ProviderIconOpenAI",
        "openai-codex": "ProviderIconCodex",
        "chatgpt": "ProviderIconOpenAI",
        "opencode": "ProviderIconOpenCode",
        "opencode-free": "ProviderIconOpenCode",
        "opencode-go": "ProviderIconOpenCode",
        "opencode-zen": "ProviderIconOpenCode",
        "openrouter": "ProviderIconOpenRouter",
        "open-router": "ProviderIconOpenRouter",
        "qwen": "ProviderIconQwen",
        "qwen-oauth": "ProviderIconQwen",
        "stepfun": "ProviderIconStepFun",
        "step": "ProviderIconStepFun",
        "stepfun-coding-plan": "ProviderIconStepFun",
        "tencent-tokenhub": "ProviderIconTencentCloud",
        "upstage": "ProviderIconUpstage",
        "solar": "ProviderIconUpstage",
        "x-ai": "ProviderIconGrok",
        "xai": "ProviderIconGrok",
        "xai-oauth": "ProviderIconGrok",
        "grok": "ProviderIconGrok",
        "xiaomi": "ProviderIconXiaomi",
        "zai": "ProviderIconZAI",
        "z-ai": "ProviderIconZAI",
        "glm": "ProviderIconZAI",
    ]

    private static let colorAssets: Set<String> = [
        "ProviderIconAlibaba",
        "ProviderIconAnthropic",
        "ProviderIconArcee",
        "ProviderIconAWS",
        "ProviderIconAzureAI",
        "ProviderIconCodex",
        "ProviderIconDeepInfra",
        "ProviderIconDeepSeek",
        "ProviderIconFireworks",
        "ProviderIconGemini",
        "ProviderIconGoogle",
        "ProviderIconGoogleCloud",
        "ProviderIconHuggingFace",
        "ProviderIconKimi",
        "ProviderIconLMStudio",
        "ProviderIconMeta",
        "ProviderIconMiniMax",
        "ProviderIconMistral",
        "ProviderIconNVIDIA",
        "ProviderIconNous",
        "ProviderIconNovita",
        "ProviderIconQwen",
        "ProviderIconStepFun",
        "ProviderIconTencentCloud",
        "ProviderIconTogetherAI",
        "ProviderIconUpstage",
        "ProviderIconXiaomi",
        "ProviderIconZAI",
    ]

    private static let alwaysOriginalAssets: Set<String> = [
        "ProviderIconNous",
    ]

    private static let silhouetteAssets = [
        "ProviderIconHuggingFace": "ProviderIconHuggingFaceSilhouette",
    ]

    static func descriptor(providerID: String?, label: String) -> ProviderIconDescriptor {
        let normalizedID = normalized(providerID)
        let assetName = normalizedID.flatMap { assets[$0] }
        return ProviderIconDescriptor(
            assetName: assetName,
            silhouetteAssetName: assetName.flatMap { silhouetteAssets[$0] },
            hasOriginalColor: assetName.map { colorAssets.contains($0) } ?? false,
            alwaysUsesOriginalRendering: assetName.map {
                alwaysOriginalAssets.contains($0)
            } ?? false,
            fallbackInitials: initials(label)
        )
    }

    static func assetName(providerID: String?) -> String? {
        normalized(providerID).flatMap { assets[$0] }
    }

    private static func normalized(_ providerID: String?) -> String? {
        guard let providerID else { return nil }
        let value = providerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.hasPrefix("custom:") { return nil }
        return value.isEmpty ? nil : value
    }

    private static func initials(_ label: String) -> String {
        let words = label
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
        let result = words.compactMap(\.first).map(String.init).joined().uppercased()
        return result.isEmpty ? "?" : result
    }
}

struct ProviderIconView: View {
    let providerID: String?
    let label: String
    var tint: Color = .primary
    var size: CGFloat = 20
    var style: ProviderIconStyle? = nil
    @AppStorage(
        ProviderIconStyle.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var storedStyleRawValue = ProviderIconStyle.defaultValue.rawValue

    var body: some View {
        let descriptor = ProviderIconRegistry.descriptor(providerID: providerID, label: label)
        let resolvedStyle = style
            ?? ProviderIconStyle(rawValue: storedStyleRawValue)
            ?? ProviderIconStyle.defaultValue
        let renderingMode: Image.TemplateRenderingMode = resolvedStyle == .color && descriptor.hasOriginalColor
            ? .original
            : .template
        let foreground = resolvedStyle == .silhouette ? tint : Color.primary
        Group {
            if let assetName = descriptor.assetName {
                let resolvedAssetName = resolvedStyle == .silhouette
                    ? descriptor.silhouetteAssetName ?? assetName
                    : assetName
                if descriptor.alwaysUsesOriginalRendering {
                    Image(resolvedAssetName)
                        .renderingMode(.original)
                        .resizable()
                        .scaledToFit()
                } else {
                    Image(resolvedAssetName)
                        .renderingMode(renderingMode)
                        .resizable()
                        .scaledToFit()
                        .foregroundStyle(foreground)
                }
            } else {
                Text(descriptor.fallbackInitials)
                    .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
                    .foregroundStyle(foreground)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(foreground.opacity(0.14), in: Circle())
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
