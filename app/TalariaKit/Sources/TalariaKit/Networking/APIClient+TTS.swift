import Foundation

/// JSON body for `POST /api/tts`. Only `text` and `voice` are sent: the server
/// defaults `engine` to the profile's configured `tts.provider` (503
/// `tts_unconfigured` when none is set) and `rate`/`pitch` to neutral, and a
/// voice/engine picker is a non-goal of #15. The configured engine picks its
/// own voice from the server config.
struct TTSSynthesisRequest: Encodable {
    let text: String
    let voice: String
}

extension APIClient {
    /// Synthesizes `text` into speech via the server's configured TTS engine
    /// (`POST /api/tts`) and returns the raw `audio/mpeg` bytes.
    ///
    /// The server fully buffers the response (`Content-Length` is set, not
    /// chunked), so a single-shot `Data` download is correct — no streaming
    /// logic. Reuses `sendData`, which maps 401 → `.unauthorized` and every
    /// other non-2xx to `.http` carrying the server's `{"error": ...}` body
    /// text (400 invalid input, 429 rate limit, 503 no configured engine or key).
    /// Callers treat any thrown error as "fall back to the on-device
    /// synthesizer" (#15).
    public func synthesizeSpeech(text: String, voice: String) async throws -> Data {
        try await sendData(
            endpoint: .tts,
            method: "POST",
            body: TTSSynthesisRequest(text: text, voice: voice)
        )
    }
}
