import XCTest
@testable import TalariaKit

/// Server dictation asks the server to load its STT engine when recording starts, so a cold local
/// model loads while the user speaks instead of during the upload's transcription (TAL-916).
@MainActor
final class ComposerVoiceSTTWarmTests: APIClientTestCase {
    func testServerDictationStartWarmsTheEngineWhenTheServerSupportsIt() async throws {
        let warmed = expectation(description: "POST /api/transcribe/warm")
        let controller = try makeController(capability: "warmable") { warmed.fulfill() }

        await controller.toggle(currentDraft: "")

        await fulfillment(of: [warmed], timeout: 2)
    }

    func testServerDictationStartSkipsTheWarmWhenTheServerDoesNotSupportIt() async throws {
        let warmed = expectation(description: "POST /api/transcribe/warm")
        warmed.isInverted = true
        let checked = expectation(description: "GET /api/transcribe/capability")
        let controller = try makeController(capability: "unwarmable", onCapability: { checked.fulfill() }) { warmed.fulfill() }

        await controller.toggle(currentDraft: "")

        await fulfillment(of: [checked], timeout: 2)
        await fulfillment(of: [warmed], timeout: 0.3)
    }

    /// A server-first controller whose server answers the capability from the shared fixture. The
    /// microphone stays denied, so no audio hardware is touched.
    private func makeController(
        capability name: String,
        onCapability: @escaping @Sendable () -> Void = {},
        onWarm: @escaping @Sendable () -> Void
    ) throws -> ComposerVoiceInputController {
        let fixtures = try JSONSerialization.jsonObject(with: sharedContractFixture("transcribe-capability")) as? [String: Any]
        let capability = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixtures?[name]))
        let client = makeClient { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/api/transcribe/capability"):
                onCapability()
                return apiTestJSONResponse(String(decoding: capability, as: UTF8.self), for: request)
            case ("POST", "/api/transcribe/warm"):
                onWarm()
                return apiTestJSONResponse(#"{"ok": true}"#, for: request)
            default:
                XCTFail("Unexpected request \(request.httpMethod ?? "") \(request.url?.path ?? "")")
                throw URLError(.badServerResponse)
            }
        }
        let controller = ComposerVoiceInputController(
            speechRecognizerFactory: { nil },
            microphonePermissionRequester: { false }
        )
        controller.apiClient = client
        controller.providerPreference = .serverFirst
        return controller
    }
}
